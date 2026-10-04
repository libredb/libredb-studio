/**
 * The browser's verdict on a Milvus console text (vector-family spec 3.4, 3.9, E10, E25, E34, VF2, VF9): the guard is
 * the shared grammar plus every phase 0 rule except the version gates, and it reaches the same verdict as the
 * server's request rules, so a text it refuses is never sent and never stored.
 */
import { describe, expect, test } from "bun:test";
import { RequestRefusal } from "@/lib/db/console/dialect";
import {
  MILVUS_DESTRUCTIVE_OPERATIONS,
  milvusRefusal,
  readMilvusOperations,
} from "@/lib/db/providers/vector/milvus/guard";
import { milvusPhase0, parseMilvusRequest } from "@/lib/db/providers/vector/milvus/request";

/** The server's verdict on the same text, through request.ts. */
function serverVerdict(text: string): { phase: number; message: string } | undefined {
  try {
    milvusPhase0(parseMilvusRequest(text), { database: "default" });
    return undefined;
  } catch (error) {
    if (!(error instanceof RequestRefusal)) throw error;
    return { phase: error.phase, message: error.message };
  }
}

const SEARCH = (extra: string) =>
  `POST entities/search\n{"collectionName": "docs_int64", "annsField": "vec", "data": [[0.1, 0.2]]${extra}}`;
const HYBRID = (rerank: string, sub = "") =>
  `POST entities/hybrid_search\n{"collectionName": "docs_varchar", "search": [{"annsField": "f16", "data": [[0.1, 0.2]]${sub}}], "rerank": ${rerank}}`;

describe("milvusRefusal", () => {
  test("accepts a valid text", () => {
    expect(milvusRefusal('POST /v2/vectordb/collections/list\n{"dbName": "default"}')).toBeUndefined();
  });

  test("refuses a write with the server's own sentence", () => {
    expect(milvusRefusal('POST /v2/vectordb/entities/insert\n{"collectionName": "c", "data": []}')).toBe(
      serverVerdict('POST /v2/vectordb/entities/insert\n{"collectionName": "c", "data": []}')?.message,
    );
  });

  test("a text refused only by a version gate passes the guard: only the server holds the version (3.9)", () => {
    expect(
      milvusRefusal('POST entities/query\n{"collectionName": "c", "orderByFields": ["seq:desc"]}'),
    ).toBeUndefined();
  });
});

describe("one verdict in the browser and on the server (E25)", () => {
  test.each([
    ['POST entities/query\n{"collectionName": "c", "collectionName": "d"}', "a duplicate key, refused by the grammar"],
    [
      'POST entities/query\n{"collectionName": "c", "exprParams": {"__proto__": 1}}',
      "__proto__, refused by the grammar",
    ],
    ['POST entities/query\n{"collectionName": "c", "exprParams": {"constructor": 1}}', "constructor in exprParams"],
    ['POST entities/query\n{"collectionName": "c", "exprParams": {"prototype": 1}}', "prototype in exprParams"],
    [SEARCH(', "data": [{"constructor": 0.5}]').replace('"data": [[0.1, 0.2]], ', ""), "constructor in a sparse map"],
    [SEARCH(', "data": [{"prototype": 0.5}]').replace('"data": [[0.1, 0.2]], ', ""), "prototype in a sparse map"],
    ['POST entities/query\n{"collectionName": "c", "limit": 0}', "an explicit limit 0"],
    ["POST https://milvus.example/v2/vectordb/collections/list", "an absolute URL on the request line"],
  ])("%s (%s)", (text) => {
    const server = serverVerdict(text);
    expect(server?.phase).toBe(0);
    expect(milvusRefusal(text)).toBe(server?.message);
  });
});

describe("the E34 corpus: every input that can name a service is refused in the browser, in phase 0 (VF2, VF9)", () => {
  test.each([
    [
      SEARCH(
        ', "functionScore": {"functions": [{"name": "rerank", "type": "Rerank", "params": {"provider": "cohere"}}]}',
      ),
      "a model ranker in functionScore on search",
    ],
    [
      HYBRID('{"strategy": "rrf"}').replace('"rerank"', '"functionScore": {"functions": []}, "rerank"'),
      "functionScore on hybrid search",
    ],
    [
      SEARCH(', "functionChains": [{"params": {"endpoint": "http://example.invalid"}}]'),
      "functionChains with an endpoint",
    ],
    [SEARCH(', "searchAggregation": {"fields": ["label"]}'), "searchAggregation"],
    [SEARCH(', "searchParams": {"params": {"endpoint": "http://example.invalid"}}'), "an endpoint in searchParams"],
    [SEARCH(', "searchParams": {"params": {"x": {"url": "http://example.invalid"}}}'), "a nested url in searchParams"],
    [HYBRID('{"strategy": "rrf", "params": {"url": "http://example.invalid"}}'), "a url in rerank.params"],
    [HYBRID('{"strategy": "rrf", "params": {"k": 60, "provider": "x"}}'), "a provider in rerank.params"],
    [HYBRID('{"strategy": "rrf"}', ', "params": {"api_key": "x"}'), "an api_key in a sub-request's params"],
    [SEARCH(', "searchParams": {"credential": "label"}'), "a credential label in searchParams"],
  ])("%s (%s)", (text) => {
    expect(serverVerdict(text)?.phase).toBe(0);
    expect(milvusRefusal(text)).toBe(serverVerdict(text)?.message);
  });
});

describe("readMilvusOperations, the vocabulary row's read (3.4, E10)", () => {
  test("a text the guard accepts reads as its route class", () => {
    expect(readMilvusOperations('POST entities/query\n{"collectionName": "c"}')).toEqual(["read"]);
  });

  test("a refused text reads as undefined", () => {
    expect(readMilvusOperations('POST entities/insert\n{"collectionName": "c"}')).toBeUndefined();
    expect(readMilvusOperations('POST entities/query\n{"collectionName": "c", "limit": 0}')).toBeUndefined();
  });

  test("no v1 operation asks for a confirmation", () => {
    expect([...MILVUS_DESTRUCTIVE_OPERATIONS]).toEqual([]);
  });
});
