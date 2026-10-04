/**
 * Phase 0 of the Qdrant console's request rules (vector-family spec 6.4, QE1, QE10, QE14, QE15): the names, the
 * closed keys, the point ids, the query keys and the engine's documented defaults, each read from the text alone
 * with no call of any kind. A refusal is a `RequestRefusal` of phase 0 naming its key.
 */
import { describe, expect, test } from "bun:test";
import { RequestRefusal } from "@/lib/db/console/dialect";
import { ConsoleRefusal } from "@/lib/db/console/parser";
import { toJsonText } from "@/lib/db/console/tagged-json";
import {
  parseQdrantRequest,
  qdrantCollectionNameRefusal,
  qdrantPhase0,
  qdrantVectorNameRefusal,
} from "@/lib/db/providers/vector/qdrant/request";
import { QDRANT_RUNS } from "@/lib/db/providers/vector/qdrant/routes";

const plan = (text: string) => qdrantPhase0(parseQdrantRequest(text));
const body = (text: string) => {
  const read = plan(text).body;
  return read === null ? null : toJsonText(read);
};
function refusal(text: string): RequestRefusal {
  try {
    plan(text);
  } catch (error) {
    if (error instanceof RequestRefusal) return error;
    throw error;
  }
  throw new Error(`accepted: ${text}`);
}

describe("collection and alias names (QE1)", () => {
  test.each([
    [".", '"." is not a collection name: Qdrant serves no dot name.'],
    ["..", '".." is not a collection name: Qdrant serves no dot name.'],
    ["a%2Fb", 'The collection name "a/b" holds a character Qdrant refuses in a name: / or NUL.'],
    ["a%00b", 'The collection name "a\\u0000b" holds a character Qdrant refuses in a name: / or NUL.'],
    ["%2e%2e", '".." is not a collection name: Qdrant serves no dot name.'],
    ["x".repeat(256), "The collection name is 256 characters long; Qdrant takes at most 255."],
  ])("GET /collections/%s is refused in phase 0 naming the rule", (name, sentence) => {
    const refused = refusal(`GET /collections/${name}`);
    expect({ phase: refused.phase, key: refused.key, message: refused.message }).toEqual({
      phase: 0,
      key: "collection_name",
      message: sentence,
    });
  });

  test("a / written into the path, and an empty name, are refused by the grammar first", () => {
    expect(() => parseQdrantRequest("GET /collections/a/b")).toThrow(ConsoleRefusal);
    expect(() => parseQdrantRequest("GET /collections//exists")).toThrow(
      "The path parameter collection_name is empty.",
    );
  });

  test("a legacy name such as a:b, and a name of exactly 255 characters, open", () => {
    expect(plan("GET /collections/a:b").request.params).toEqual({ collection_name: "a:b" });
    expect(plan(`GET /collections/${"x".repeat(255)}`).route.op).toBe("get_collection");
    expect(qdrantCollectionNameRefusal("\u{1F600}".repeat(255))).toBeUndefined();
    expect(qdrantCollectionNameRefusal("")).toBe("A collection name cannot be empty.");
  });

  test("a vector name keeps the server's eleven forbidden characters, the dot names and the 200-byte bound", () => {
    for (const character of ["<", ">", ":", '"', "/", "\\", "|", "?", "*", "\u0000", "\u001f"]) {
      expect(qdrantVectorNameRefusal(`a${character}b`), JSON.stringify(character)).toContain(
        "a character Qdrant refuses in a vector name",
      );
    }
    expect(qdrantVectorNameRefusal("")).toBe("A vector name cannot be empty.");
    expect(qdrantVectorNameRefusal("..")).toBe('".." is not a vector name.');
    expect(qdrantVectorNameRefusal("é".repeat(100))).toBeUndefined();
    expect(qdrantVectorNameRefusal(`${"é".repeat(100)}x`)).toBe(
      "The vector name is 201 bytes long; Qdrant takes at most 200.",
    );
    expect(refusal('POST /collections/docs/points/query\n{"query": [0.1], "using": "a:b"}').message).toBe(
      'using: The vector name "a:b" holds ":", a character Qdrant refuses in a vector name.',
    );
  });
});

describe("routes v1 does not run", () => {
  test("a write, a method outside GET and POST, and a service route are refused naming what the console runs", () => {
    const write = refusal('PUT /collections/docs/points\n{"points": []}');
    expect(write).toBeInstanceOf(ConsoleRefusal);
    expect(write.message).toBe(
      `PUT /collections/docs/points is a point or payload write, which this console does not run. ${QDRANT_RUNS} (line 1, column 1)`,
    );
    expect(refusal("GET /telemetry").message).toContain("GET /telemetry is a service route");
    expect(refusal("GET /metrics").message).toContain("GET /metrics is a service route");
    expect(refusal('POST /collections/docs/points/search\n{"vector": [0.1]}').message).toContain(
      "a legacy search, recommend or discover route",
    );
  });

  test("a grammar refusal that names no route keeps its own sentence", () => {
    expect(refusal("GET").message).toBe("GET needs a route after it. (line 1, column 4)");
    expect(refusal("GET /collections/{collection_name}").message).toBe(
      "Replace {collection_name} with a collection name. (line 1, column 5)",
    );
  });
});

describe("closed keys (QE10)", () => {
  test.each([
    ['POST /collections/docs/points/scroll\n{"fliter": {"must": []}}', "fliter", 'The body takes no key "fliter"'],
    ['POST /collections/docs/points/count\n{"exat": true}', "exat", 'The body takes no key "exat"'],
    [
      'POST /collections/docs/points\n{"ids": [1], "with_vectors": true}',
      "with_vectors",
      'The body takes no key "with_vectors"',
    ],
    ['POST /collections/docs/facet\n{"key": "city", "wait": true}', "wait", 'The body takes no key "wait"'],
    [
      'POST /collections/docs/points/query\n{"query": [0.1], "params": {"hnsw_ef": 64, "ef": 64}}',
      "ef",
      'params takes no key "ef"',
    ],
    [
      'POST /collections/docs/points/query\n{"query": [0.1], "params": {"quantization": {"rescore": true, "rescoring": true}}}',
      "rescoring",
      'params.quantization takes no key "rescoring"',
    ],
    [
      'POST /collections/docs/points/query\n{"prefetch": {"query": [0.1], "limitt": 5}, "query": {"fusion": "rrf"}}',
      "limitt",
      'prefetch takes no key "limitt"',
    ],
    [
      'POST /collections/docs/points/query\n{"query": {"nearest": [0.1], "mmr": {"diversty": 0.5}}}',
      "diversty",
      'query.mmr takes no key "diversty"',
    ],
    [
      'POST /collections/docs/points/scroll\n{"order_by": {"key": "seq", "dir": "asc"}}',
      "dir",
      'order_by takes no key "dir"',
    ],
    [
      'POST /collections/docs/points/query\n{"query": 42, "lookup_from": {"collection": "other", "vectors": "image"}}',
      "vectors",
      'lookup_from takes no key "vectors"',
    ],
    [
      'POST /collections/docs/points/query/groups\n{"group_by": "category", "with_lookup": {"collection": "c", "payload": true}}',
      "payload",
      'with_lookup takes no key "payload"',
    ],
    [
      'POST /collections/docs/points/query/batch\n{"searches": [{"query": [0.1], "limt": 3}]}',
      "limt",
      'searches[0] takes no key "limt"',
    ],
    [
      'POST /collections/docs/points/query/batch\n{"searches": [], "extra": 1}',
      "extra",
      'The body takes no key "extra"',
    ],
  ])("%s is refused naming %s", (text, key, sentence) => {
    const refused = refusal(text);
    expect({ phase: refused.phase, key: refused.key }).toEqual({ phase: 0, key });
    expect(refused.message).toContain(sentence);
  });

  test("a required key left out is refused by name", () => {
    expect(refusal('POST /collections/docs/facet\n{"limit": 3}').message).toBe("The body needs the key key.");
    expect(refusal('POST /collections/docs/points\n{"with_payload": true}').message).toBe(
      "The body needs the key ids.",
    );
    expect(refusal('POST /collections/docs/points/query/groups\n{"query": [0.1]}').message).toBe(
      "The body needs the key group_by.",
    );
    expect(refusal('POST /collections/docs/points/query/batch\n{"searches": null}').message).toBe(
      "The body needs the key searches.",
    );
  });

  test("a query and a batch's searches take with_vectors as Qdrant reads it, sent as typed, and refuse it beside with_vector", () => {
    expect(body('POST /collections/plain/points/query\n{"query": [0.2, 0.1, 0.9, 0.7], "with_vectors": true}')).toBe(
      '{"query":[0.2,0.1,0.9,0.7],"with_vectors":true,"limit":10}',
    );
    expect(refusal('POST /collections/plain/points/query\n{"with_vectors": true, "with_vector": false}').message).toBe(
      "with_vectors and with_vector are one key to Qdrant: write one of them.",
    );
    expect(refusal('POST /collections/plain/points/query\n{"with_vectors": 3}').message).toBe(
      "with_vectors must be a list, found a number.",
    );
  });
});

describe("point ids (QE14)", () => {
  test("ids up to 18446744073709551615 are written with exactly their digits", () => {
    expect(
      body('POST /collections/docs/points\n{"ids": [9007199254740993, 9223372036854775808, 18446744073709551615]}'),
    ).toBe('{"ids":[9007199254740993,9223372036854775808,18446744073709551615]}');
  });

  test.each([
    [
      "18446744073709551616",
      "ids[0] is 18446744073709551616, outside the range of a point id, 0 to 18446744073709551615.",
    ],
    ["-1", "ids[0] is -1, outside the range of a point id, 0 to 18446744073709551615."],
    ['"42"', 'ids[0] is the string "42": write the id as a bare number, because Qdrant refuses a digit string.'],
    ['"not-a-uuid"', 'ids[0] is "not-a-uuid", which is neither an unsigned integer nor a UUID.'],
    [
      '"8d8f53130a2e-4c3b-9f1e-2b7c1d0e5a44"',
      'ids[0] is "8d8f53130a2e-4c3b-9f1e-2b7c1d0e5a44", which is neither an unsigned integer nor a UUID.',
    ],
    ["1.5", "ids[0] must be a point id, an unsigned integer or a UUID string, found a number."],
    [
      '{"kind": "int", "digits": "42"}',
      "ids[0] must be a point id, an unsigned integer or a UUID string, found an object.",
    ],
  ])("the id %s is refused with zero calls", (id, sentence) => {
    const refused = refusal(`POST /collections/docs/points\n{"ids": [${id}]}`);
    expect({ phase: refused.phase, message: refused.message }).toEqual({ phase: 0, message: sentence });
  });

  test("a scroll offset is a point id, checked apart from the window", () => {
    expect(body('POST /collections/docs/points/scroll\n{"offset": 18446744073709551615}')).toBe(
      '{"offset":18446744073709551615,"limit":10}',
    );
    expect(refusal('POST /collections/docs/points/scroll\n{"offset": 18446744073709551616}').message).toContain(
      "offset is 18446744073709551616, outside the range of a point id",
    );
    expect(refusal('POST /collections/docs/points/scroll\n{"offset": "1234-not-uuid"}').message).toBe(
      'offset is "1234-not-uuid", which is neither an unsigned integer nor a UUID.',
    );
    expect(refusal('POST /collections/docs/points/scroll\n{"offset": "9007199254740993"}').message).toBe(
      'offset is the string "9007199254740993": write the id as a bare number, because Qdrant refuses a digit string.',
    );
  });

  test("a point id in the path is the parser's: uint64 digits or a UUID", () => {
    expect(plan("GET /collections/docs/points/18446744073709551615").request.params.id).toBe("18446744073709551615");
    expect(() => parseQdrantRequest("GET /collections/docs/points/18446744073709551616")).toThrow(
      "is neither an unsigned 64-bit integer nor a UUID",
    );
  });

  test("Review Focus: a UUID written in upper case or without hyphens is accepted and sent as typed, for the server to normalise", () => {
    expect(
      body(
        'POST /collections/docs/points\n{"ids": ["8D8F5313-0A2E-4C3B-9F1E-2B7C1D0E5A44", "8d8f53130a2e4c3b9f1e2b7c1d0e5a44"]}',
      ),
    ).toBe('{"ids":["8D8F5313-0A2E-4C3B-9F1E-2B7C1D0E5A44","8d8f53130a2e4c3b9f1e2b7c1d0e5a44"]}');
    expect(
      body(
        'POST /collections/docs/points/scroll\n{"filter": {"must": [{"has_id": ["8D8F53130A2E4C3B9F1E2B7C1D0E5A44"]}]}}',
      ),
    ).toBe('{"filter":{"must":[{"has_id":["8D8F53130A2E4C3B9F1E2B7C1D0E5A44"]}]},"limit":10}');
  });
});

describe("the engine's documented defaults, sent explicitly", () => {
  test("an absent limit is 10 on a query, a scroll and a facet, and 10 with group_size 3 on a grouped query", () => {
    expect(body('POST /collections/docs/points/query\n{"query": [0.1]}')).toBe('{"query":[0.1],"limit":10}');
    expect(body("POST /collections/docs/points/scroll")).toBe('{"limit":10}');
    expect(body('POST /collections/docs/facet\n{"key": "category"}')).toBe('{"key":"category","limit":10}');
    expect(
      body('POST /collections/docs/points/query/groups\n{"query": 42, "using": "text", "group_by": "category"}'),
    ).toBe('{"query":42,"using":"text","group_by":"category","limit":10,"group_size":3}');
    expect(
      body('POST /collections/docs/points/query/batch\n{"searches": [{"query": [0.1]}, {"query": [0.2], "limit": 3}]}'),
    ).toBe('{"searches":[{"query":[0.1],"limit":10},{"query":[0.2],"limit":3}]}');
  });

  test("an absent exact on a count is true, as Qdrant's own default", () => {
    expect(body("POST /collections/docs/points/count")).toBe('{"exact":true}');
    expect(body('POST /collections/docs/points/count\n{"exact": false}')).toBe('{"exact":false}');
  });

  test("a default key written as null is the default, and a body the route takes none of is null", () => {
    expect(body('POST /collections/docs/points/scroll\n{"limit": null}')).toBe('{"limit":10}');
    expect(plan("GET /collections").body).toBeNull();
  });

  test("Review Focus: a limit written as 10.0 or as a string is refused naming limit, never truncated", () => {
    expect(refusal('POST /collections/docs/points/scroll\n{"limit": 10.0}').message).toBe(
      "limit must be an integer, found a number.",
    );
    expect(refusal('POST /collections/docs/points/query\n{"query": [0.1], "limit": "10"}').message).toBe(
      "limit must be an integer, found a string.",
    );
    expect(refusal('POST /collections/docs/points/scroll\n{"limit": 0}').message).toBe(
      "limit is 0; it takes an integer from 1 to 1000.",
    );
  });
});

describe("query keys (QE15)", () => {
  test.each([
    ["timeout=0", "The query key timeout takes a positive integer, not 0."],
    ["timeout=-1", "The query key timeout takes a positive integer, not -1."],
    ["timeout=1.5", "The query key timeout takes a positive integer, not 1.5."],
    ["timeout=abc", "The query key timeout takes a positive integer, not abc."],
    ["timeout=5&timeout=6", "The query key timeout is given twice."],
    ["wait=true", "POST collections/{collection_name}/points/query takes no query key wait."],
    ["ordering=strong", "POST collections/{collection_name}/points/query takes no query key ordering."],
    ["api_key=x", "POST collections/{collection_name}/points/query takes no query key api_key."],
  ])("?%s is refused with zero calls", (query, sentence) => {
    expect(refusal(`POST /collections/docs/points/query?${query}\n{"query": [0.1]}`).message).toContain(sentence);
  });

  test("?timeout=5 on GET /collections is refused naming the route", () => {
    expect(refusal("GET /collections?timeout=5").message).toContain("GET collections takes no query string.");
  });

  test("the declared keys and their values are kept for the wire", () => {
    expect(
      plan('POST /collections/docs/points/query?consistency=majority&timeout=5\n{"query": [0.1]}').request.query,
    ).toEqual({
      consistency: "majority",
      timeout: "5",
    });
    expect(plan("GET /collections/docs/optimizations?with=queued,completed&completed_limit=16").request.query).toEqual({
      with: "queued,completed",
      completed_limit: "16",
    });
  });
});

describe("Review Focus: a text pasted with Windows line endings", () => {
  test("reads as the same request, its // comments read out, and is refused with the same sentence", () => {
    const lf =
      '// two titles from a scroll\nPOST /collections/docs/points/scroll\n{\n    "limit": 2, // two points\n    "with_payload": ["title"]\n}';
    const crlf = lf.replaceAll("\n", "\r\n");
    expect(body(crlf)).toBe(body(lf));
    expect(body(crlf)).toBe('{"limit":2,"with_payload":["title"]}');
    const refusedLf = '// note\nPOST /collections/docs/points/scroll\n{"fliter": {}}';
    expect(refusal(refusedLf.replaceAll("\n", "\r\n")).message).toBe(refusal(refusedLf).message);
  });
});

describe("the plan", () => {
  test("names the collections phase 1 reads: the request's own for a point route, and none for any other", () => {
    expect(plan('POST /collections/docs/points/query\n{"query": [0.1]}').collections).toEqual(["docs"]);
    expect(plan("GET /collections/docs/points/42").collections).toEqual(["docs"]);
    expect(plan("POST /collections/docs/points/count").collections).toEqual([]);
    expect(plan('POST /collections/docs/facet\n{"key": "k"}').collections).toEqual([]);
    expect(plan("GET /collections/docs").collections).toEqual([]);
  });

  test("adds each collection a lookup_from names, once", () => {
    expect(
      plan(
        'POST /collections/docs/points/query\n{"prefetch": [{"query": 1, "lookup_from": {"collection": "other"}}, {"query": 2, "lookup_from": {"collection": "other", "vector": "v"}}], "query": {"fusion": "rrf"}}',
      ).collections,
    ).toEqual(["docs", "other"]);
  });

  test("a body key that names a shard key, a payload selector or a vector selector of the wrong shape is refused", () => {
    expect(refusal('POST /collections/docs/points\n{"ids": [1], "shard_key": 1.5}').message).toBe(
      "shard_key must be a shard key, a string or an unsigned integer, found a number.",
    );
    expect(refusal('POST /collections/docs/points\n{"ids": [1], "shard_key": {"target": "a"}}').message).toBe(
      "shard_key needs the key fallback.",
    );
    expect(
      body('POST /collections/docs/points\n{"ids": [1], "shard_key": ["a", 7], "with_payload": {"exclude": ["city"]}}'),
    ).toBe('{"ids":[1],"shard_key":["a",7],"with_payload":{"exclude":["city"]}}');
    expect(refusal('POST /collections/docs/points\n{"ids": [1], "with_payload": {"include": [1]}}').message).toBe(
      "with_payload.include[0] must be a string, found a number.",
    );
    expect(refusal('POST /collections/docs/points\n{"ids": [1], "with_vector": "text"}').message).toBe(
      "with_vector must be a list, found a string.",
    );
    expect(refusal('POST /collections/docs/points\n{"ids": [1], "with_vector": ["text", 3]}').message).toBe(
      "with_vector[1] must be a string, found a number.",
    );
    expect(refusal('POST /collections/docs/facet\n{"key": ""}').message).toBe(
      "key names the payload field to count by; it cannot be empty.",
    );
    expect(refusal('POST /collections/docs/points/query/groups\n{"group_by": ""}').message).toBe(
      "group_by names the payload field to group by; it cannot be empty.",
    );
  });
});
