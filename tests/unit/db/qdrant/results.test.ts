/**
 * Answers to results (vector-family spec 6.5, 6.6, QE13, QE14): the cells and column types of each value, the row
 * shapes of every route, the score column's meaning per search, the column-name rule applied, the byte budget, the
 * text cut, and the scroll's next page as a warning with its exact offset.
 */
import { describe, expect, test } from "bun:test";
import {
  parseQdrantRequest,
  type QdrantCollectionFacts,
  type QdrantResultShape,
  qdrantPhase0,
  qdrantPhase1,
} from "@/lib/db/providers/vector/qdrant/request";
import { qdrantResult } from "@/lib/db/providers/vector/qdrant/results";
import { qdrantDeclaredColumns, readQdrantCollection } from "@/lib/db/providers/vector/qdrant/schema";
import { capturedText, dense, factsOf, seededFacts } from "../../../helpers/qdrant-facts";

const options = { executionTime: 7 };
/** The shape phase 1 gives a request over the named collection, as the runner hands it to the result. */
function shapeOf(text: string, facts: ReadonlyMap<string, QdrantCollectionFacts>): QdrantResultShape {
  return qdrantPhase1(qdrantPhase0(parseQdrantRequest(text)), facts).shape;
}
const docs = new Map([["docs", seededFacts("docs")]]);
const envelope = (result: string) => `{"result":${result},"status":"ok","time":0.001}`;

describe("point ids and vectors from the seeded captures", () => {
  test("a scroll's ids are exact decimal text up to 2^64 - 1, its vectors in the collection's order, declared in vectorColumns", () => {
    const result = qdrantResult(
      capturedText("scroll-docs"),
      shapeOf('POST /collections/docs/points/scroll\n{"limit": 5, "with_payload": ["seq"], "with_vector": true}', docs),
      options,
    );
    expect(result.rows.map((row) => row.id)).toEqual([
      "0",
      "42",
      "9007199254740993",
      "9223372036854775808",
      "18446744073709551615",
    ]);
    expect(result.fields).toEqual(["id", "vector.text", "vector.image", "vector.colbert", "vector.keywords", "seq"]);
    expect(result.columnTypes).toEqual({
      id: "uint64 or UUID",
      "vector.text": "Dense(384, float32, Cosine; stored normalised)",
      "vector.image": "Dense(64, float32, Euclid)",
      "vector.colbert": "Multi(16, float32, Dot, max_sim)",
      "vector.keywords": "Sparse(idf)",
      seq: "integer",
    });
    // The grid's type for a vector column is the tree's type for the same column.
    const declared = qdrantDeclaredColumns(
      readQdrantCollection("docs", (JSON.parse(capturedText("describe-docs")) as { result: unknown }).result),
    );
    for (const column of ["vector.text", "vector.image", "vector.colbert", "vector.keywords"]) {
      expect(result.columnTypes?.[column]).toBe(declared.find((entry) => entry.name === column)?.type);
    }
    expect(result.vectorColumns).toEqual({
      "vector.text": { kind: "dense", dtype: "float32", dimension: 384 },
      "vector.image": { kind: "dense", dtype: "float32", dimension: 64 },
      "vector.colbert": { kind: "multi", dtype: "float32", dimension: 16 },
      "vector.keywords": { kind: "sparse", dtype: "float32", dimension: null, sparseEncoding: "indices-values" },
    });
    expect((result.rows[0]["vector.text"] as number[]).length).toBe(384);
    expect(result.rows[0]["vector.keywords"]).toMatchObject({ indices: expect.any(Array), values: expect.any(Array) });
    expect(result.warnings).toBeUndefined();
    expect(Object.getPrototypeOf(result.rows[0])).toBeNull();
  });

  test("a search's UUID id is the server's text and an id above 2^53 its exact digits; the score column is Qdrant's own", () => {
    const result = qdrantResult(
      capturedText("search-sparse"),
      shapeOf(
        'POST /collections/docs/points/query\n{"query": {"indices": [1], "values": [1.0]}, "using": "keywords", "limit": 3}',
        docs,
      ),
      options,
    );
    expect(result.rows.map((row) => row.id)).toEqual([
      "0",
      "cab10c92-1a3f-5558-897b-bba9f2440ee0",
      "1152921504606847672",
    ]);
    expect(result.fields).toEqual(["id", "score", "seq"]);
    expect(result.columnTypes?.score).toBe("Float, Dot, higher is closer");
    expect(result.rows[0].score).toBe(123.39569);
  });

  test("Qdrant's Euclid answers 5.0 for (3, 4) against the origin, labelled not squared", () => {
    const edge = new Map([["edge_values", seededFacts("edge_values")]]);
    const result = qdrantResult(
      capturedText("search-euclid-origin"),
      shapeOf(
        'POST /collections/edge_values/points/query\n{"query": [0.0, 0.0, 0.0, 0.0], "using": "f32", "limit": 1}',
        edge,
      ),
      options,
    );
    expect(result.rows[0].score).toBe(5);
    expect(result.columnTypes?.score).toBe("Float, Euclid, lower is closer");
  });

  test("a score Qdrant prints as null is not finite, with one warning counting the rows", () => {
    const edge = new Map([["edge_values", seededFacts("edge_values")]]);
    const result = qdrantResult(
      capturedText("search-non-finite"),
      shapeOf(
        'POST /collections/edge_values/points/query\n{"query": {"indices": [7], "values": [1.0]}, "using": "sp", "limit": 1}',
        edge,
      ),
      options,
    );
    expect(result.rows[0].score).toBe("not finite");
    expect(result.warnings).toEqual([
      {
        message: "1 row has a score that is not a finite number; it is shown as a word, because JSON cannot carry it.",
      },
    ]);
  });

  test("a float16 element that overflowed stays null in its cell, with a notice; turbo4 says it is a reconstruction", () => {
    const edge = new Map([["edge_values", seededFacts("edge_values")]]);
    const overflow = qdrantResult(
      capturedText("retrieve-edge_values"),
      shapeOf(
        'POST /collections/edge_values/points\n{"ids": [1, 2, 3], "with_payload": true, "with_vector": true}',
        edge,
      ),
      options,
    );
    expect(overflow.rows[1]["vector.f16"]).toEqual([null, 1, 2, 3]);
    expect(overflow.warnings).toContainEqual({
      message:
        "1 cells of vector.f16 hold null elements: Qdrant stores a float16 element that overflowed as infinity and answers it as null.",
    });
    const small = new Map([["small_dtypes", seededFacts("small_dtypes")]]);
    const turbo = qdrantResult(
      capturedText("retrieve-small_dtypes"),
      shapeOf(
        'POST /collections/small_dtypes/points\n{"ids": [0, 1, 2, 3, 4], "with_payload": true, "with_vector": true}',
        small,
      ),
      options,
    );
    expect(turbo.warnings).toContainEqual({
      message: "vector.t4 is stored as turbo4: Qdrant answers a 4-bit reconstruction, not the vector that was written.",
    });
    expect(turbo.vectorColumns?.["vector.t4"]).toEqual({ kind: "dense", dtype: "float32", dimension: 64 });
    expect(turbo.vectorColumns?.["vector.sp_u8"]).toEqual({
      kind: "sparse",
      dtype: "uint8",
      dimension: null,
      sparseEncoding: "indices-values",
    });
  });

  test("a 65,536-dimension vector cell survives whole", () => {
    const wide = new Map([["wide", factsOf([dense("", 65_536)])]]);
    const vector = `[${Array.from({ length: 65_536 }, () => "0.5").join(",")}]`;
    const result = qdrantResult(
      envelope(`[{"id":1,"vector":${vector}}]`),
      shapeOf('POST /collections/wide/points\n{"ids": [1], "with_vector": true}', wide),
      options,
    );
    expect((result.rows[0].vector as number[]).length).toBe(65_536);
    expect(result.fields).toEqual(["id", "vector"]);
  });
});

describe("payload columns", () => {
  const shape = shapeOf('POST /collections/docs/points\n{"ids": [1, 2]}', docs);

  test("integers above 2^53 keep their digits with a warning naming the column; a digit string stays a string with none", () => {
    const result = qdrantResult(
      envelope(
        '[{"id":1,"payload":{"big_int":9007199254740993,"code":"9007199254740993","nested":{"n":18446744073709551615}}}]',
      ),
      shape,
      options,
    );
    expect(result.rows[0].big_int).toBe("9007199254740993");
    expect(result.rows[0].code).toBe("9007199254740993");
    expect(result.rows[0].nested).toEqual({ n: "18446744073709551615" });
    expect(result.warnings).toEqual([
      {
        message:
          "Integers above 2^53 in big_int, nested are shown as their exact digits, because a JavaScript number would round them.",
      },
    ]);
  });

  test("a key that reads as a column is renamed once with one warning, and constructor is an ordinary column", () => {
    const result = qdrantResult(
      envelope(
        '[{"id":1,"payload":{"id":"x","constructor":1,"toString":2}},{"id":2,"payload":{"payload.id":"y","category":"a"}}]',
      ),
      shape,
      options,
    );
    expect(result.fields).toEqual(["id", "payload.id", "constructor", "toString", "payload.payload.id", "category"]);
    expect(result.rows[0]).toEqual(
      Object.assign(Object.create(null), {
        id: "1",
        "payload.id": "x",
        constructor: 1,
        toString: 2,
        "payload.payload.id": null,
        category: null,
      }),
    );
    expect(result.columnTypes?.category).toBe("keyword");
    expect(result.columnTypes?.["payload.id"]).toBe("payload");
    expect(result.warnings?.[0].message).toBe(
      'Payload keys that read as a column Qdrant or Studio names are shown under payload.: "id" -> payload.id, "payload.id" -> payload.payload.id. A filter names the key itself.',
    );
  });

  test("a text cell over 65,536 code units is cut with its marker and one warning; a vector cell never is", () => {
    const long = "a".repeat(100_000);
    const result = qdrantResult(envelope(`[{"id":1,"payload":{"body":"${long}"}}]`), shape, options);
    expect(result.rows[0].body).toBe(`${"a".repeat(65_536)}...[cut: 65536 of 100000 characters shown]`);
    expect(result.warnings).toEqual([
      { message: "1 text cells were longer than 65536 characters and are cut, with a marker." },
    ]);
    const pair = `${"a".repeat(65_535)}\u{1F600}`;
    expect(qdrantResult(envelope(`[{"id":1,"payload":{"body":"${pair}b"}}]`), shape, options).rows[0].body).toBe(
      `${"a".repeat(65_535)}...[cut: 65535 of 65538 characters shown]`,
    );
  });
});

describe("row shapes per route", () => {
  test("a batch has $search first, keeps search order, and names a search that returned no points", () => {
    const shape = shapeOf(
      'POST /collections/docs/points/query/batch\n{"searches": [{"query": 42, "using": "text", "limit": 3}, {"query": 42, "using": "image", "limit": 3}, {"query": 42, "using": "text", "limit": 3}]}',
      docs,
    );
    const result = qdrantResult(
      envelope(
        '[{"points":[{"id":7,"score":0.9},{"id":8,"score":0.8}]},{"points":[{"id":9,"score":1.5}]},{"points":[]}]',
      ),
      shape,
      options,
    );
    expect(result.fields).toEqual(["$search", "id", "score"]);
    expect(result.rows.map((row) => [row.$search, row.id])).toEqual([
      [0, "7"],
      [0, "8"],
      [1, "9"],
    ]);
    expect(result.columnTypes).toEqual({
      $search: "index into searches",
      id: "uint64 or UUID",
      score: "varies by search, see the result notice",
    });
    expect(result.warnings).toEqual([
      { message: "Score in search 0, 2: Float, Cosine, higher is closer." },
      { message: "Score in search 1: Float, Euclid, lower is closer." },
      { message: "search 2 returned no points" },
    ]);
  });

  test("a batch answer of another length than its searches raises", () => {
    const shape = shapeOf(
      'POST /collections/docs/points/query/batch\n{"searches": [{"query": 42, "using": "text"}]}',
      docs,
    );
    expect(() => qdrantResult(envelope("[]"), shape, options)).toThrow(
      "Qdrant answered 0 searches to a batch of 1, so its rows cannot be told apart.",
    );
  });

  test("a grouped query has one row per hit, $group first as its JSON value, $lookup on each group's first row", () => {
    const shape = shapeOf(
      'POST /collections/docs/points/query/groups\n{"query": 42, "using": "text", "group_by": "category", "with_lookup": "authors"}',
      docs,
    );
    const result = qdrantResult(
      envelope(
        '{"groups":[{"id":"alpha","hits":[{"id":1,"score":0.9},{"id":2,"score":0.8}],"lookup":{"id":"alpha","payload":{"n":1}}},{"id":9007199254740993,"hits":[]},{"id":7,"hits":[{"id":3,"score":0.5}]},{"id":"7","hits":[{"id":4,"score":0.4}]}]}',
      ),
      shape,
      options,
    );
    expect(result.fields).toEqual(["$group", "$lookup", "id", "score"]);
    expect(result.rows.map((row) => [row.$group, row.$lookup, row.id])).toEqual([
      ["alpha", { id: "alpha", payload: { n: 1 } }, "1"],
      ["alpha", null, "2"],
      ["9007199254740993", null, null],
      [7, null, "3"],
      ["7", null, "4"],
    ]);
    expect(result.columnTypes?.$group).toBe("string or integer");
    expect(result.pagination).toBeUndefined();
    expect(result.warnings).toEqual([
      {
        message:
          "Group ids above 2^53 in $group are shown as their exact digits, because a JavaScript number would round them.",
      },
      { message: "$group holds both a string and an integer written 7: they are different groups." },
    ]);
  });

  test("a facet has its own two columns, and its counts are exact only when asked so", () => {
    const answer = envelope(
      '{"hits":[{"value":"alpha","count":10},{"value":9007199254740993,"count":2},{"value":true,"count":1}]}',
    );
    const approximate = qdrantResult(
      answer,
      shapeOf('POST /collections/docs/facet\n{"key": "category"}', new Map()),
      options,
    );
    expect(approximate.fields).toEqual(["value", "count"]);
    expect(approximate.rows.map((row) => row.value)).toEqual(["alpha", "9007199254740993", true]);
    expect(approximate.columnTypes).toEqual({ value: "string, integer or boolean", count: "Int64, estimate" });
    const exact = qdrantResult(
      answer,
      shapeOf('POST /collections/docs/facet\n{"key": "category", "exact": true}', new Map()),
      options,
    );
    expect(exact.columnTypes?.count).toBe("Int64, exact count");
  });

  test("a count is one row, labelled exact by default and an estimate when exact is false", () => {
    const exact = qdrantResult(
      envelope('{"count":2000}'),
      shapeOf("POST /collections/docs/points/count", new Map()),
      options,
    );
    expect(exact.rows).toEqual([Object.assign(Object.create(null), { count: 2000 })]);
    expect(exact.columnTypes).toEqual({ count: "Int64, exact count" });
    const estimate = qdrantResult(
      envelope('{"count":1990}'),
      shapeOf('POST /collections/docs/points/count\n{"exact": false}', new Map()),
      options,
    );
    expect(estimate.columnTypes).toEqual({ count: "Int64, estimate" });
    expect(() =>
      qdrantResult(envelope("{}"), shapeOf("POST /collections/docs/points/count", new Map()), options),
    ).toThrow("Qdrant answered a count with no number.");
  });

  test("the metadata reads are rows of their objects: GET / unenveloped, lists by their key", () => {
    const none = new Map<string, QdrantCollectionFacts>();
    const root = qdrantResult(capturedText("root"), shapeOf("GET /", none), options);
    expect(root.fields).toEqual(["title", "version", "commit"]);
    expect(root.rows[0].version).toBe("1.19.1");
    const aliases = qdrantResult(capturedText("aliases"), shapeOf("GET /aliases", none), options);
    expect(aliases.rows.map((row) => row.alias_name)).toEqual(["docs_alias", "plain_alias"]);
    const collections = qdrantResult(
      envelope('{"collections":[{"name":"docs"},{"name":"plain"}]}'),
      shapeOf("GET /collections", none),
      options,
    );
    expect(collections.rows.map((row) => row.name)).toEqual(["docs", "plain"]);
    const snapshots = qdrantResult(
      envelope('[{"name":"s.snapshot","size":10}]'),
      shapeOf("GET /collections/docs/snapshots", none),
      options,
    );
    expect(snapshots.fields).toEqual(["name", "size"]);
    const exists = qdrantResult(envelope('{"exists":true}'), shapeOf("GET /collections/docs/exists", none), options);
    expect(exists.rows[0].exists).toBe(true);
    const info = qdrantResult(capturedText("describe-docs"), shapeOf("GET /collections/docs", none), options);
    expect(info.fields).toContain("config");
    expect(() => qdrantResult(envelope("[]"), shapeOf("GET /collections/docs", none), options)).toThrow(
      "Qdrant answered with no object where one was expected.",
    );
    expect(() => qdrantResult(envelope("{}"), shapeOf("GET /collections", none), options)).toThrow(
      "Qdrant answered with no list of collections.",
    );
    expect(() => qdrantResult("not json", shapeOf("GET /collections", none), options)).toThrow(
      "Qdrant answered with a body that is not JSON.",
    );
  });

  test("a point whose id is neither an integer nor a UUID raises", () => {
    expect(() =>
      qdrantResult(envelope('[{"id":"x"}]'), shapeOf('POST /collections/docs/points\n{"ids": [1]}', docs), options),
    ).toThrow("Qdrant answered a point whose id is neither an unsigned integer nor a UUID.");
  });

  test("order_value and shard_key are columns only when present", () => {
    const result = qdrantResult(
      envelope(
        '{"points":[{"id":1,"order_value":9007199254740993,"shard_key":"a","payload":{}}],"next_page_offset":null}',
      ),
      shapeOf('POST /collections/docs/points/scroll\n{"order_by": "seq"}', docs),
      options,
    );
    expect(result.fields).toEqual(["id", "order_value", "shard_key"]);
    expect(result.rows[0].order_value).toBe("9007199254740993");
    expect(
      qdrantResult(
        envelope('{"points":[{"id":1}],"next_page_offset":null}'),
        shapeOf("POST /collections/docs/points/scroll", docs),
        options,
      ).fields,
    ).toEqual(["id"]);
  });

  test("a single point read by GET is one row", () => {
    const result = qdrantResult(
      envelope('{"id":42,"payload":{"seq":42}}'),
      shapeOf("GET /collections/docs/points/42", docs),
      options,
    );
    expect(result.rows).toEqual([Object.assign(Object.create(null), { id: "42", seq: 42 })]);
    expect(result.executionTime).toBe(7);
  });
});

describe("the next page of a scroll (R51 U20)", () => {
  const shape = shapeOf("POST /collections/docs/points/scroll", docs);
  const scroll = (offset: string) => envelope(`{"points":[{"id":1}],"next_page_offset":${offset}}`);

  test.each([
    ["18446744073709551615", "18446744073709551615"],
    ["9007199254740993", "9007199254740993"],
    ["42", "42"],
    ['"8d8f5313-0a2e-4c3b-9f1e-2b7c1d0e5a44"', '"8d8f5313-0a2e-4c3b-9f1e-2b7c1d0e5a44"'],
  ])("next_page_offset %s gives one warning with exactly that value, and no pagination", (offset, written) => {
    const result = qdrantResult(scroll(offset), shape, options);
    expect(result.warnings).toEqual([
      {
        code: "next_page_offset",
        message: `The scroll has more points. Its next_page_offset is ${written}: repeat the request with "offset": ${written} in the body to read the next page.`,
      },
    ]);
    expect(result.pagination).toBeUndefined();
  });

  test("Review Focus: the offset the warning names, pasted into the next request, reaches the wire as exactly those digits", () => {
    for (const offset of ["18446744073709551615", '"8d8f5313-0a2e-4c3b-9f1e-2b7c1d0e5a44"']) {
      const message = qdrantResult(scroll(offset), shape, options).warnings?.[0].message ?? "";
      const pasted = /"offset": (.+) in the body/.exec(message)?.[1] ?? "";
      const next = qdrantPhase1(
        qdrantPhase0(parseQdrantRequest(`POST /collections/docs/points/scroll\n{"offset": ${pasted}}`)),
        docs,
      );
      expect(next.body).toBe(`{"offset":${offset},"limit":10}`);
    }
  });
});

describe("the result budget (6.6, QE13)", () => {
  const shape = shapeOf('POST /collections/docs/points\n{"ids": [1]}', docs);
  const many = (count: number) =>
    envelope(
      `[${Array.from({ length: count }, (_, index) => `{"id":${index},"payload":{"s":"${"x".repeat(100)}"}}`).join(",")}]`,
    );

  test("rows past the budget are dropped whole, wasLimited is set and a warning names the bound", () => {
    const result = qdrantResult(many(10), shape, { executionTime: 1, budgetBytes: 500 });
    // Each row is 118 bytes as converted ({"id":"0","s":"xxx..."}), so four fit in 500 and the fifth does not.
    expect(result.rowCount).toBe(4);
    expect(result.pagination).toEqual({ limit: 4, offset: 0, hasMore: false, totalReturned: 4, wasLimited: true });
    expect(result.warnings?.at(-1)?.message).toBe(
      'The result reached Studio\'s 500-byte result budget after 4 rows; the remaining 6 rows are not shown. Lower "limit", or set "with_vector" to false or to the vectors you need.',
    );
  });

  test("a scroll of 1,000 points at 1,536 dimensions of 1.0 converts whole, about 6 MB, under the 8 MiB budget", () => {
    const wide = new Map([["wide", factsOf([dense("", 1_536)])]]);
    const vector = `[${Array.from({ length: 1_536 }, () => "1.0").join(",")}]`;
    const points = Array.from({ length: 1_000 }, (_, index) => `{"id":${index},"vector":${vector}}`).join(",");
    const result = qdrantResult(
      envelope(`{"points":[${points}],"next_page_offset":null}`),
      shapeOf('POST /collections/wide/points/scroll\n{"limit": 1000, "with_vector": true}', wide),
      options,
    );
    expect(result.rowCount).toBe(1_000);
    expect(result.pagination).toBeUndefined();
  });

  test("a 12 MiB answer converts rows up to the 8 MiB budget, with wasLimited and the warning", () => {
    const wide = new Map([["wide", factsOf([dense("", 1_536)])]]);
    const vector = `[${Array.from({ length: 1_536 }, () => "0.123456789").join(",")}]`;
    const points = Array.from({ length: 700 }, (_, index) => `{"id":${index},"vector":${vector}}`).join(",");
    const text = envelope(`{"points":[${points}],"next_page_offset":null}`);
    expect(text.length).toBeGreaterThan(12_000_000);
    const result = qdrantResult(
      text,
      shapeOf('POST /collections/wide/points/scroll\n{"limit": 700, "with_vector": true}', wide),
      options,
    );
    expect(result.rowCount).toBeLessThan(700);
    expect(result.pagination?.wasLimited).toBe(true);
    expect(result.warnings?.at(-1)?.message).toContain("Studio's 8 MiB result budget");
  });
});
