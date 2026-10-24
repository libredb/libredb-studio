/**
 * The tree click and Generate Request for a Weaviate collection (#1566 spec 6.4): each text round-tripped through
 * phase 0, the probe vector accepted by the shared dense check for its dimension, and a collection name kept in its
 * place through the request line's percent-encoding.
 */
import { describe, expect, test } from "bun:test";
import { toJsonText } from "@/lib/db/console/tagged-json";
import { weaviateSelectQuery, weaviateTableQuery } from "@/lib/db/providers/vector/weaviate/generators";
import { readWeaviateClass, weaviateColumns } from "@/lib/db/providers/vector/weaviate/schema";
import { checkDenseElements, vectorNumbers } from "@/lib/db/vector/dense";
import type { ColumnSchema } from "@/lib/types";
import { plan } from "../../../helpers/weaviate-request-fixtures";

const vectorColumn = (name: string, type: string): ColumnSchema => ({ name, type, nullable: true, isPrimary: false });
const TITLE: ColumnSchema = { name: "title", type: "text", nullable: true, isPrimary: false };

/** Product's columns as the provider builds them: two named vectors, each dimension read from one object. */
const PRODUCT_COLUMNS = weaviateColumns(
  readWeaviateClass(
    {
      class: "Product",
      properties: [{ name: "name", dataType: ["text"] }],
      vectorConfig: {
        image: { vectorIndexType: "hnsw", vectorIndexConfig: { distance: "cosine" } },
        text: { vectorIndexType: "flat", vectorIndexConfig: { distance: "dot", bq: { enabled: true } } },
      },
    },
    "Product",
  ),
  new Map([
    ["image", 8],
    ["text", 4],
  ]),
);

describe("weaviateTableQuery", () => {
  test("reads the collection's first 50 objects", () => {
    expect(weaviateTableQuery(["Article"])).toBe("GET /v1/objects?class=Article&limit=50");
    expect(plan(weaviateTableQuery(["Article"])).query).toEqual({ class: "Article", limit: "50" });
  });

  test("names the last segment of the path", () => {
    expect(plan(weaviateTableQuery(["weaviate", "Product"])).collection).toBe("Product");
  });

  test("a name with a character a query string carries is percent-encoded", () => {
    expect(weaviateTableQuery(["a&b"])).toBe("GET /v1/objects?class=a%26b&limit=50");
  });
});

describe("weaviateSelectQuery", () => {
  test("a collection with named vectors searches the first, with the probe vector of its dimension", () => {
    const text = weaviateSelectQuery(["Product"], PRODUCT_COLUMNS);
    const lines = text.split("\n");
    expect(lines.slice(0, 5)).toEqual([
      "// Replace vector with your query vector: Vector(8, cosine, hnsw)",
      '// Also in this collection: vector "text", Vector(4, dot, flat, bq)',
      '// A keyword search: POST /v1/search/Product/bm25 {"query": "your words", "limit": 10}',
      "// A count: POST /v1/aggregate/Product {}",
      "POST /v1/search/Product/near-vector",
    ]);
    const search = plan(text).search;
    expect(search?.targetVector).toBe("image");
    expect(toJsonText(search?.limit ?? null)).toBe("10");
    expect(search?.returnMetadata).toEqual(["distance"]);
    const numbers = vectorNumbers(
      { name: "image", kind: "dense", dtype: "float32", dimension: 8 },
      search?.vector ?? [],
    ) as number[];
    expect(numbers).toHaveLength(8);
    expect(checkDenseElements({ name: "image", kind: "dense", dtype: "float32", dimension: 8 }, numbers)).toBeNull();
  });

  test("the unnamed vector is searched without targetVector", () => {
    const text = weaviateSelectQuery(["Article"], [TITLE, vectorColumn("$vector", "Vector(2, cosine, hnsw)")]);
    expect(text.split("\n").at(-1)).toMatch(
      /^\{"vector": \[[^\]]+\], "limit": 10, "returnMetadata": \["distance"\]\}$/,
    );
    expect(plan(text).search?.targetVector).toBeNull();
  });

  test("a vector of length 0 reads as a dimension not yet shown, never as a probe of no numbers", () => {
    const text = weaviateSelectQuery(["Article"], [vectorColumn("$vector.v", "Vector(0, cosine, hnsw)")]);
    expect(text).toContain("no object has shown its length yet");
    expect(plan(text).route.op).toBe("search_bm25");
  });

  test("with no dimension shown, the keyword search is the request and the vector search waits in a comment", () => {
    // A guessed length is a server error ("vector lengths don't match", measured on 1.40.2), so it is never sent.
    const text = weaviateSelectQuery(["Article"], [vectorColumn("$vector", "Vector(?, cosine, hnsw)")]);
    expect(text).toBe(
      [
        "// A vector search needs a query vector of Vector(?, cosine, hnsw); no object has shown its length yet, so a keyword search runs instead:",
        '// POST /v1/search/Article/near-vector {"vector": [your numbers], "limit": 10, "returnMetadata": ["distance"]}',
        "// A count: POST /v1/aggregate/Article {}",
        "POST /v1/search/Article/bm25",
        '{"query": "your words", "limit": 10}',
      ].join("\n"),
    );
    expect(plan(text).route.op).toBe("search_bm25");
  });

  test("a vector type the generator cannot read is treated as an unknown dimension", () => {
    const text = weaviateSelectQuery(["Article"], [vectorColumn("$vector.v", "vector")]);
    expect(text).toContain(
      '// POST /v1/search/Article/near-vector {"vector": [your numbers], "targetVector": "v", "limit": 10',
    );
    expect(plan(text).route.op).toBe("search_bm25");
  });

  test("a collection that declares no vector opens a bm25 search", () => {
    const text = weaviateSelectQuery(["Author"], [TITLE]);
    expect(text).toBe(
      [
        '// Collection "Author" declares no vector to search.',
        "POST /v1/search/Author/bm25",
        '{"query": "your words", "limit": 10}',
      ].join("\n"),
    );
    expect(plan(text).route.op).toBe("search_bm25");
  });

  test("a vector name reaches the body through JSON.stringify", () => {
    const text = weaviateSelectQuery(["Doc"], [vectorColumn("$vector.with_name", "Vector(2, cosine, hnsw)")]);
    expect(plan(text).search?.targetVector).toBe("with_name");
  });
});
