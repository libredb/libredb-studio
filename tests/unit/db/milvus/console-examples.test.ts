/**
 * The Milvus console examples of vector-family spec 5.4 as corpus tests: the nine requests PR 1v committed under
 * `tests/fixtures/vector/corpus/milvus-requests.json`, and examples 9 and 10, each through the real grammar, the
 * guard, phase 0 and phase 1 over the seeded collections' descriptions, to the request it sends.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { routeListText } from "@/lib/db/console/completion";
import { RequestRefusal } from "@/lib/db/console/dialect";
import { milvusRefusal } from "@/lib/db/providers/vector/milvus/guard";
import {
  type IndexReading,
  type MilvusOperation,
  milvusMetadataReads,
  milvusPhase0,
  milvusPhase1,
  parseMilvusRequest,
} from "@/lib/db/providers/vector/milvus/request";
import { MILVUS_CONSOLE, MILVUS_ROUTES } from "@/lib/db/providers/vector/milvus/routes";
import { describedCollection, describedIndex } from "../../../helpers/milvus-described";

const CORPUS = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "..", "fixtures", "vector", "corpus", "milvus-requests.json"), "utf8"),
) as { readonly requests: readonly { readonly name: string; readonly text: string }[] };

const text = (name: string): string => {
  const entry = CORPUS.requests.find((request) => request.name === name);
  if (entry === undefined) throw new Error(`no corpus request named ${name}`);
  return entry.text;
};

const INDEXES: Readonly<Record<string, IndexReading>> = {
  docs_int64: { kind: "read", response: describedIndex({ vec: { indexType: "HNSW", metric: "COSINE" } }) },
  docs_varchar: { kind: "read", response: describedIndex({ f16: { indexType: "HNSW", metric: "L2" } }) },
  fts: {
    kind: "read",
    response: describedIndex({ text_sparse: { indexType: "SPARSE_INVERTED_INDEX", metric: "BM25" } }),
  },
};

/** The whole server path of one text, reading exactly the metadata phase 1 asks for. */
function run(consoleText: string): MilvusOperation {
  const request = milvusPhase0(parseMilvusRequest(consoleText), { database: "default" });
  const reads = milvusMetadataReads(request);
  const collection = "collection" in request && request.collection !== undefined ? request.collection : "";
  return milvusPhase1(request, {
    ...(reads.describeCollection ? { collection: describedCollection(collection) } : {}),
    index: reads.describeIndex ? INDEXES[collection] : { kind: "not-read" },
  });
}

describe("every corpus request passes the guard (5.4)", () => {
  test.each(CORPUS.requests.map((request) => [request.name, request.text]))("%s", (_, consoleText) => {
    expect(milvusRefusal(consoleText)).toBeUndefined();
  });

  test("the corpus holds the nine requests", () => {
    expect(CORPUS.requests).toHaveLength(9);
  });
});

describe("the examples of 5.4", () => {
  test("1: the collections of a database", () => {
    expect(run(text("collections-list"))).toEqual({ kind: "showCollections", db: "default" });
  });

  test("2: an unloaded collection described, which loads nothing", () => {
    expect(run(text("collections-describe"))).toEqual({
      kind: "describeCollection",
      db: "default",
      request: { collection_name: "unloaded_big" },
    });
  });

  test("3: a query over scalar and dynamic fields", () => {
    const operation = run(text("query-filter"));
    expect(operation.kind === "query" && operation.request.output_fields).toEqual([
      "id",
      "seq",
      "title",
      "tags",
      "big_int",
    ]);
  });

  test("4: an exact count with no limit; the same body with a limit is refused before any call", () => {
    expect(run(text("query-count")).kind).toBe("count");
    const limited = text("query-count").replace('["count(*)"]', '["count(*)"], "limit": 10');
    expect(() => run(limited)).toThrow(RequestRefusal);
    expect(milvusRefusal(limited)).toStartWith("A count takes no limit or offset");
  });

  test("5: a get by VarChar keys in the short form, a crafted one staying one template value", () => {
    const crafted = text("get-short-form").replace('"vc-0002"', '"zz\\"] or pk in [\\"vc-0002"');
    const operation = run(crafted);
    expect(operation.kind === "query" && { ...operation.request.expr_template_values }).toEqual({
      ids: { array_val: { string_data: { data: ["vc-0001", 'zz"] or pk in ["vc-0002'] } } },
    });
  });

  test("6: a dense search after a comment line, one DescribeIndex read for its score", () => {
    const request = milvusPhase0(parseMilvusRequest(text("search-commented")), { database: "default" });
    expect(milvusMetadataReads(request)).toEqual({ describeCollection: true, describeIndex: true });
    expect(run(text("search-commented"))).toMatchObject({
      kind: "search",
      shape: { score: { kind: "metric", metric: "COSINE" } },
    });
  });

  test("7: a BM25 text search", () => {
    expect(run(text("search-bm25"))).toMatchObject({
      kind: "search",
      shape: { score: { kind: "metric", metric: "BM25" } },
    });
  });

  test("8: a hybrid search over a float16 and a sparse field with RRF, reading no DescribeIndex", () => {
    const request = milvusPhase0(parseMilvusRequest(text("hybrid-rrf")), { database: "default" });
    expect(milvusMetadataReads(request)).toEqual({ describeCollection: true, describeIndex: false });
    expect(run(text("hybrid-rrf"))).toMatchObject({
      kind: "hybridSearch",
      shape: { score: { kind: "fused", strategy: "rrf" } },
    });
  });

  test("the generated search of 3.8 lowers too", () => {
    expect(run(text("generated-search")).kind).toBe("search");
  });

  test("9: a search by primary key", () => {
    const operation = run(
      'POST /v2/vectordb/entities/search\n{"collectionName": "docs_varchar", "annsField": "f16", "ids": ["vc-0000", "vc-0001"], "outputFields": ["pk", "label"], "limit": 3}',
    );
    expect(operation).toMatchObject({
      kind: "search",
      request: { ids: { str_id: { data: ["vc-0000", "vc-0001"] } }, nq: "2" },
    });
  });

  test("10: a grouped search", () => {
    const operation = run(
      'POST /v2/vectordb/entities/search\n{"collectionName": "docs_varchar", "annsField": "f16", "data": [[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]],\n "groupingField": "label", "groupSize": 1, "outputFields": ["pk", "label"], "limit": 4}',
    );
    expect(operation.kind === "search" && operation.shape.groupingField?.name).toBe("label");
  });

  test("a write is refused before any request, naming the routes Studio runs", () => {
    expect(milvusRefusal('POST /v2/vectordb/entities/insert\n{"collectionName": "docs_int64", "data": [{}]}')).toBe(
      `entities/insert is not available in this version of the Milvus provider, which reads only. Studio runs:\n${routeListText(MILVUS_CONSOLE, MILVUS_ROUTES, ["read"])}`,
    );
  });
});
