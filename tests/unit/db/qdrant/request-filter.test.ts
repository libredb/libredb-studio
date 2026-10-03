/**
 * Filters and formulas in phase 0 (vector-family spec 6.4, 6.6, QE10, QE12, QE14): every key of the filter tree is
 * closed by the pinned OpenAPI's sets for `Filter`, each `Condition` variant and their value objects, because the
 * server closes only `Filter` and drops a misspelled key next to a valid condition; and the tree's size, its
 * conditions, its nesting and its lists are bounded. A formula is bounded by its depth and its node count.
 */
import { describe, expect, test } from "bun:test";
import { RequestRefusal } from "@/lib/db/console/dialect";
import { toJsonText } from "@/lib/db/console/tagged-json";
import { parseQdrantRequest, qdrantPhase0 } from "@/lib/db/providers/vector/qdrant/request";

const scroll = (filter: string) => `POST /collections/docs/points/scroll\n{"filter": ${filter}}`;
const plan = (text: string) => qdrantPhase0(parseQdrantRequest(text));
function refusal(text: string): RequestRefusal {
  try {
    plan(text);
  } catch (error) {
    if (error instanceof RequestRefusal) return error;
    throw error;
  }
  throw new Error(`accepted: ${text.slice(0, 200)}`);
}

describe("the closed filter tree (QE10)", () => {
  test.each([
    ['{"must_nto": []}', "must_nto", 'filter takes no key "must_nto"'],
    [
      '{"must": [{"key": "n", "match": {"value": 1}, "rnage": {"gt": 0}}]}',
      "rnage",
      'filter.must[0] takes no key "rnage"',
    ],
    ['{"must": [{"key": "n", "match": {"valeu": 1}}]}', "valeu", "filter.must[0].match takes exactly one of value"],
    [
      '{"must": [{"key": "n", "match": {"value": 1, "any": [1]}}]}',
      "value",
      "filter.must[0].match takes exactly one of",
    ],
    ['{"must": [{"key": "n", "range": {"gte": 1, "gtee": 2}}]}', "gtee", 'filter.must[0].range takes no key "gtee"'],
    [
      '{"must": [{"key": "n", "values_count": {"gt": 1, "eq": 2}}]}',
      "eq",
      'filter.must[0].values_count takes no key "eq"',
    ],
    [
      '{"must": [{"key": "g", "geo_radius": {"center": {"lat": 1, "lon": 2, "alt": 3}, "radius": 5}}]}',
      "alt",
      'filter.must[0].geo_radius.center takes no key "alt"',
    ],
    [
      '{"must": [{"key": "g", "geo_bounding_box": {"top_left": {"lat": 1, "lon": 2}, "bottom": {"lat": 0, "lon": 3}}}]}',
      "bottom",
      'filter.must[0].geo_bounding_box takes no key "bottom"',
    ],
    [
      '{"must": [{"key": "g", "geo_polygon": {"exterior": {"points": [{"lat": 1, "lon": 2}]}, "holes": []}}]}',
      "holes",
      'filter.must[0].geo_polygon takes no key "holes"',
    ],
    ['{"must": [{"is_empty": {"key": "a", "field": "b"}}]}', "field", 'filter.must[0].is_empty takes no key "field"'],
    ['{"must": [{"is_null": {"key": "a"}, "extra": 1}]}', "extra", 'filter.must[0] takes no key "extra"'],
    ['{"must": [{"has_id": [1], "ids": [2]}]}', "ids", 'filter.must[0] takes no key "ids"'],
    ['{"must": [{"has_vector": "image", "x": 1}]}', "x", 'filter.must[0] takes no key "x"'],
    [
      '{"must": [{"nested": {"key": "items", "filter": {"must": []}, "path": "x"}}]}',
      "path",
      'filter.must[0].nested takes no key "path"',
    ],
    [
      '{"must": [{"nested": {"key": "items", "filter": {"mustt": []}}}]}',
      "mustt",
      'filter.must[0].nested.filter takes no key "mustt"',
    ],
    ['{"min_should": {"conditions": [], "min_count": 1, "max": 2}}', "max", 'filter.min_should takes no key "max"'],
    ['{"should": [{"keys": "a"}]}', "keys", 'filter.should[0] takes no key "keys": a condition holds key'],
  ])("%s is refused naming %s", (filter, key, sentence) => {
    const refused = refusal(scroll(filter));
    expect({ phase: refused.phase, key: refused.key }).toEqual({ phase: 0, key });
    expect(refused.message).toContain(sentence);
  });

  test("every condition variant the document declares is read, at every clause, and a nested filter as a condition", () => {
    const filter = JSON.stringify({
      must: [
        { key: "category", match: { value: "alpha" } },
        { key: "tags", match: { any: ["a", "b"] } },
        { key: "tags", match: { except: [1, 2] } },
        { key: "body", match: { text: "vector" } },
        { key: "body", match: { text_any: "vector search" } },
        { key: "body", match: { phrase: "vector search" } },
        { key: "seq", range: { gte: 1, lt: 20.5 } },
        { key: "created_at", range: { gte: "2026-03-01T00:00:00Z" } },
        { key: "location", geo_radius: { center: { lat: 52.5, lon: 13.4 }, radius: 1000 } },
        { key: "location", geo_bounding_box: { top_left: { lat: 1, lon: 2 }, bottom_right: { lat: 0, lon: 3 } } },
        {
          key: "location",
          geo_polygon: {
            exterior: {
              points: [
                { lat: 0, lon: 0 },
                { lat: 1, lon: 0 },
                { lat: 0, lon: 0 },
              ],
            },
            interiors: [{ points: [{ lat: 0.1, lon: 0.1 }] }],
          },
        },
        { key: "tags", values_count: { gte: 2 } },
        { key: "maybe", is_empty: true },
        { is_empty: { key: "maybe" } },
        { is_null: { key: "maybe" } },
        { has_id: [0, 42, "8d8f5313-0a2e-4c3b-9f1e-2b7c1d0e5a44"] },
        { has_vector: "image" },
        { has_vector: "" },
        { nested: { key: "items", filter: { must: [{ key: "qty", range: { gt: 1 } }] } } },
        { should: [{ key: "a", match: { value: true } }], must_not: { key: "b", match: { value: 1 } } },
      ],
      min_should: { conditions: [{ key: "a", match: { value: 1 } }], min_count: 1 },
    });
    expect(plan(scroll(filter)).route.op).toBe("scroll_points");
  });

  test("a clause takes one condition as well as a list, and an empty filter matches everything", () => {
    expect(plan(scroll('{"must": {"key": "a", "match": {"value": 1}}}')).route.op).toBe("scroll_points");
    expect(plan(scroll("{}")).route.op).toBe("scroll_points");
  });

  test("a value of the wrong kind is refused naming its place", () => {
    expect(refusal(scroll('{"must": [{"key": 3}]}')).message).toBe(
      "filter.must[0].key must be a string, found a number.",
    );
    expect(refusal(scroll('{"must": [{"key": "a", "range": {"gt": true}}]}')).message).toBe(
      "filter.must[0].range.gt must be a number or a date-time string, found a boolean.",
    );
    expect(refusal(scroll('{"must": ["a"]}')).message).toBe("filter.must[0] must be an object, found a string.");
    expect(refusal(scroll('{"min_should": {"conditions": [], "min_count": 0}}')).message).toBe(
      "filter.min_should.min_count is 0; it takes an integer from 1 to 9007199254740991.",
    );
    expect(refusal(scroll('{"must": [{"has_vector": "a:b"}]}')).message).toContain('The vector name "a:b" holds ":"');
    expect(refusal(scroll('{"must": [{"has_id": ["42"]}]}')).message).toBe(
      'filter.must[0].has_id[0] is the string "42": write the id as a bare number, because Qdrant refuses a digit string.',
    );
  });
});

describe("integers in a filter (QE14)", () => {
  test("a match on an integer above 2^53 keeps its exact digits, and one outside int64 is refused", () => {
    const read = plan(scroll('{"must": [{"key": "big_int", "match": {"value": 9007199254740993}}]}'));
    expect(toJsonText(read.body as never)).toBe(
      '{"filter":{"must":[{"key":"big_int","match":{"value":9007199254740993}}]},"limit":10}',
    );
    expect(read.warnings).toEqual([]);
    expect(refusal(scroll('{"must": [{"key": "n", "match": {"value": 9223372036854775808}}]}')).message).toBe(
      "filter.must[0].match.value is 9223372036854775808, outside the signed 64-bit range a match compares.",
    );
    expect(refusal(scroll('{"must": [{"key": "n", "match": {"any": [1, 9223372036854775808]}}]}')).message).toContain(
      "filter.must[0].match.any[1] is 9223372036854775808",
    );
  });

  test("a range bound above 2^53 is accepted with one warning that Qdrant compares range bounds as doubles", () => {
    const read = plan(
      scroll('{"must": [{"key": "big_int", "range": {"gte": 9007199254740993, "lte": 9007199254740995}}]}'),
    );
    expect(read.warnings).toEqual([
      {
        message:
          "filter.must[0].range.gte is an integer above 2^53: Qdrant compares range bounds as doubles, so a bound that large is rounded. A match on the value is exact.",
      },
    ]);
    expect(plan(scroll('{"must": [{"key": "n", "range": {"gte": 9007199254740991}}]}')).warnings).toEqual([]);
  });
});

describe("filter bounds (6.6)", () => {
  const conditions = (count: number) =>
    `{"must": [${Array.from({ length: count }, (_, index) => `{"key": "k", "match": {"value": ${index}}}`).join(",")}]}`;

  test("256 conditions in the tree are accepted and 257 refused", () => {
    expect(plan(scroll(conditions(256))).route.op).toBe("scroll_points");
    expect(refusal(scroll(conditions(257))).message).toBe(
      "The filter holds more than 256 conditions, the console's bound.",
    );
  });

  test("nested conditions 4 deep are accepted and 5 refused", () => {
    const nested = (depth: number): string =>
      depth === 0
        ? '{"key": "a", "match": {"value": 1}}'
        : `{"nested": {"key": "n", "filter": {"must": [${nested(depth - 1)}]}}}`;
    expect(plan(scroll(`{"must": [${nested(4)}]}`)).route.op).toBe("scroll_points");
    expect(refusal(scroll(`{"must": [${nested(5)}]}`)).message).toContain("more than 4 nested conditions deep");
  });

  test("match.any, match.except and has_id hold at most 10,000 entries", () => {
    const list = (count: number) => Array.from({ length: count }, (_, index) => index).join(",");
    expect(plan(scroll(`{"must": [{"key": "a", "match": {"any": [${list(10_000)}]}}]}`)).route.op).toBe(
      "scroll_points",
    );
    expect(refusal(scroll(`{"must": [{"key": "a", "match": {"any": [${list(10_001)}]}}]}`)).message).toBe(
      "filter.must[0].match.any holds 10001 entries, above the bound of 10000.",
    );
    expect(refusal(scroll(`{"must": [{"key": "a", "match": {"except": [${list(10_001)}]}}]}`)).message).toBe(
      "filter.must[0].match.except holds 10001 entries, above the bound of 10000.",
    );
    expect(refusal(scroll(`{"must": [{"has_id": [${list(10_001)}]}]}`)).message).toBe(
      "filter.must[0].has_id holds 10001 ids, above the bound of 10000.",
    );
  });

  test("every filter of a request is 64 KiB serialised at most, together", () => {
    const long = "x".repeat(40_000);
    const one = `{"must": [{"key": "a", "match": {"value": "${long}"}}]}`;
    expect(plan(scroll(one)).route.op).toBe("scroll_points");
    const two = `POST /collections/docs/points/query\n{"prefetch": {"query": [0.1], "filter": ${one}}, "query": {"fusion": "rrf"}, "filter": ${one}}`;
    expect(refusal(two).message).toMatch(
      /^The request's filters are \d+ bytes together, above the bound of 65536 bytes\.$/,
    );
  });
});

describe("version-gated filter keys are noted for the server's gate", () => {
  test("match.prefix and slice", () => {
    expect(plan(scroll('{"must": [{"key": "a", "match": {"prefix": "al"}}]}')).gates).toEqual(["matchPrefix"]);
    expect(plan(scroll('{"must": [{"slice": {"index": 1, "total": 4}}]}')).gates).toEqual(["slice"]);
    expect(refusal(scroll('{"must": [{"slice": {"index": 4, "total": 4}}]}')).message).toBe(
      "filter.must[0].slice.index is 4; it takes an integer from 0 to 3.",
    );
  });
});

describe("formulas (6.6)", () => {
  const formula = (expression: string) =>
    `POST /collections/docs/points/query\n{"prefetch": {"query": [0.1], "limit": 50}, "query": {"formula": ${expression}}}`;

  test("every expression form the document declares is read", () => {
    const expression = JSON.stringify({
      sum: [
        "$score",
        0.5,
        { mult: [0.1, { key: "tag", match: { any: ["h1"] } }] },
        { neg: { abs: { sqrt: { exp: { log10: { ln: "x" } } } } } },
        { div: { left: 1, right: 2, by_zero_default: 0 } },
        { pow: { base: 2, exponent: 3 } },
        { geo_distance: { origin: { lat: 52.5, lon: 13.4 }, to: "geo.location" } },
        { lin_decay: { x: { datetime_key: "t" }, target: { datetime: "2026-01-01T00:00:00Z" }, scale: 10 } },
        { gauss_decay: { x: 1, midpoint: 0.5 } },
        { exp_decay: { x: 1 } },
      ],
    });
    const read = plan(formula(expression));
    expect(read.searches).toEqual([{ form: "formula", using: "" }]);
    expect(read.gates).toEqual([]);
  });

  test("acosh, max and min are noted for the version gate", () => {
    expect([...plan(formula('{"max": [1, {"min": [2, {"acosh": 3}]}]}')).gates].sort()).toEqual([
      "formulaAcosh",
      "formulaMax",
      "formulaMin",
    ]);
  });

  test("a formula 12 deep is accepted and 13 refused; 128 nodes are accepted and 129 refused", () => {
    const deep = (depth: number): string => (depth === 1 ? "1" : `{"neg": ${deep(depth - 1)}}`);
    expect(plan(formula(deep(12))).route.op).toBe("query_points");
    expect(refusal(formula(deep(13))).message).toContain("is more than 12 expressions deep");
    const wide = (count: number) => `{"sum": [${Array.from({ length: count - 1 }, () => "1").join(",")}]}`;
    expect(plan(formula(wide(128))).route.op).toBe("query_points");
    expect(refusal(formula(wide(129))).message).toBe(
      "The formula holds more than 128 expressions, the console's bound.",
    );
  });

  test("an unknown key in an expression is refused by its closed set", () => {
    expect(refusal(formula('{"div": {"left": 1, "right": 2, "default": 0}}')).message).toContain(
      'query.formula.div takes no key "default"',
    );
    expect(refusal(formula('{"sum": [1], "avg": [2]}')).message).toContain('query.formula takes no key "avg"');
  });
});
