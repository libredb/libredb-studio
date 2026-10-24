/**
 * The browser's verdict on a Weaviate console text (#1566 spec 5.8): `weaviateRefusal` is the grammar and every phase
 * 0 rule, the same two functions the provider runs first, so a text it refuses is never sent and never stored;
 * `readWeaviateOperations` is the confirmation gate's reading, the class of the route, and there is no destructive
 * operation to confirm.
 */
import { describe, expect, test } from "bun:test";
import {
  readWeaviateOperations,
  WEAVIATE_DESTRUCTIVE_OPERATIONS,
  weaviateRefusal,
} from "@/lib/db/providers/vector/weaviate/guard";
import { WEAVIATE_STATEMENT_EXAMPLE } from "@/lib/db/providers/vector/weaviate/labels";
import { WEAVIATE_RUNS } from "@/lib/db/providers/vector/weaviate/routes";

/** The examples of spec 5.4, as a user types them. */
const EXAMPLES: readonly string[] = [
  "GET /v1/objects?class=Article&limit=50",
  'POST /v1/search/Article/bm25 {"query": "vector search", "where": {"path": ["category"], "operator": "Equal", "valueText": "alpha"}, "limit": 5, "returnMetadata": ["score"]}',
  'POST /v1/search/Product/near-vector {"vector": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], "targetVector": "image", "limit": 3, "returnMetadata": ["distance"]}',
  'POST /v1/aggregate/TenantNotes {"tenant": "acme"}',
  "// the first page\n# of articles\nGET objects?class=Article",
  WEAVIATE_STATEMENT_EXAMPLE,
];

describe("weaviateRefusal", () => {
  test.each(EXAMPLES)("accepts %j", (text) => {
    expect(weaviateRefusal(text)).toBeUndefined();
  });

  test("refuses a grammar error with the grammar's sentence", () => {
    expect(weaviateRefusal("DELETE /v1/schema/Article")).toBe(
      `DELETE /v1/schema/Article is a schema, tenant, index or alias change, which this console does not run. ${WEAVIATE_RUNS} (line 1, column 1)`,
    );
  });

  test("refuses a phase 0 rule with its sentence", () => {
    expect(weaviateRefusal('POST /v1/search/Article/hybrid {"query": "x", "alpha": 0.7}')).toBe(
      'alpha must be 0 in this console: any other value makes Weaviate embed the query text with the collection\'s vectorizer, which sends it to a model provider. Write "alpha": 0 for a keyword-only hybrid search.',
    );
    expect(weaviateRefusal('POST /v1/search/Article/bm25 {"query": "x", "singlePrompt": "summarise"}')).toBe(
      'The body takes no key "singlePrompt" in this console: generative search sends the results to a model provider.',
    );
  });

  test("leaves the rules that read the collection to the server", () => {
    expect(weaviateRefusal("GET /v1/objects?class=TenantNotes")).toBeUndefined();
    expect(
      weaviateRefusal('POST /v1/search/Article/bm25 {"query": "x", "returnProperties": ["nope"]}'),
    ).toBeUndefined();
  });
});

describe("readWeaviateOperations", () => {
  test("a text the console runs reads as one read", () => {
    for (const text of EXAMPLES) expect(readWeaviateOperations(text)).toEqual(["read"]);
  });

  test("a text the console refuses reads as nothing", () => {
    expect(readWeaviateOperations("DELETE /v1/objects/Article")).toBeUndefined();
    expect(readWeaviateOperations('POST /v1/search/Article/bm25 {"query": ""}')).toBeUndefined();
  });

  test("an error that is no refusal is thrown, never read as a verdict", () => {
    expect(() => weaviateRefusal(undefined as unknown as string)).toThrow(TypeError);
    expect(() => readWeaviateOperations(undefined as unknown as string)).toThrow(TypeError);
  });

  test("no operation asks for a confirmation", () => {
    expect(WEAVIATE_DESTRUCTIVE_OPERATIONS.size).toBe(0);
  });
});
