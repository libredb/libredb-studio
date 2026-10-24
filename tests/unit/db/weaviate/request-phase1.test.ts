/**
 * Phase 1 of the Weaviate console (#1566 spec 3.4, 5.3, W6): the rules that read the collection's definition, the
 * tenancy rule, every property a request names, the target vector, and the query vector's numbers. A refusal is a
 * `RequestRefusal` of phase 1 naming its key; nothing is sent. The definitions are the seeded server's own.
 */
import { describe, expect, test } from "bun:test";
import { type WeaviatePlan, weaviatePhase1 } from "@/lib/db/providers/vector/weaviate/request";
import type { WeaviateCollectionFacts } from "@/lib/db/providers/vector/weaviate/schema";
import { handFacts, plan, recordedFacts, refusalOf } from "../../../helpers/weaviate-request-fixtures";

const ARTICLE = recordedFacts("Article");
const PRODUCT = recordedFacts("Product");
const TENANT_NOTES = recordedFacts("TenantNotes");

const phase1 = (text: string, facts: WeaviateCollectionFacts): WeaviatePlan => weaviatePhase1(plan(text), facts);
function refused(text: string, facts: WeaviateCollectionFacts) {
  const error = refusalOf(() => phase1(text, facts));
  return { phase: error.phase, key: error.key, message: error.message };
}

describe("the tenancy rule (W6)", () => {
  test("a multi-tenant collection's data read without a tenant is refused, naming the tenant list", () => {
    expect(refused("GET /v1/objects?class=TenantNotes", TENANT_NOTES)).toEqual({
      phase: 1,
      key: "tenant",
      message:
        'The collection "TenantNotes" is multi-tenant, so the request needs a tenant (?tenant=...). Nothing was read: GET /v1/schema/TenantNotes/tenants lists its tenants and which are HOT, without waking any.',
    });
    expect(refused('POST /v1/search/TenantNotes/bm25 {"query": "note"}', TENANT_NOTES).message).toBe(
      'The collection "TenantNotes" is multi-tenant, so the request needs a tenant ("tenant": "..."). Nothing was read: GET /v1/schema/TenantNotes/tenants lists its tenants and which are HOT, without waking any.',
    );
  });

  test("the collection's own record, its tenant list and its nodes name no tenant", () => {
    for (const text of [
      "GET /v1/schema/TenantNotes",
      "GET /v1/schema/TenantNotes/tenants",
      "GET /v1/nodes/TenantNotes",
    ]) {
      expect(phase1(text, TENANT_NOTES).tenant).toBeNull();
    }
  });

  test("a multi-tenant read with its tenant opens", () => {
    expect(phase1("GET /v1/objects?class=TenantNotes&tenant=acme", TENANT_NOTES).tenant).toBe("acme");
    expect(phase1('POST /v1/aggregate/TenantNotes {"tenant": "acme"}', TENANT_NOTES).tenant).toBe("acme");
  });

  test("a tenant on a collection that is not multi-tenant is refused, but the tenant record route is not", () => {
    expect(refused("GET /v1/objects?class=Article&tenant=acme", ARTICLE)).toEqual({
      phase: 1,
      key: "tenant",
      message: 'The collection "Article" is not multi-tenant, so the request takes no tenant.',
    });
    expect(phase1("GET /v1/schema/Article/tenants/acme", ARTICLE).route.op).toBe("tenant");
  });

  test("a route that is no search answers the plan unchanged", () => {
    const read = plan("GET /v1/schema/Article");
    expect(weaviatePhase1(read, ARTICLE)).toBe(read);
  });
});

describe("the properties a request names", () => {
  test("a property the collection does not have is refused by name", () => {
    expect(refused('POST /v1/search/Article/bm25 {"query": "x", "returnProperties": ["titel"]}', ARTICLE)).toEqual({
      phase: 1,
      key: "returnProperties",
      message: 'returnProperties names "titel", which is no property of "Article".',
    });
  });

  test("a cross-reference is refused, outside this version", () => {
    expect(refused('POST /v1/search/Article/bm25 {"query": "x", "returnProperties": ["writtenBy"]}', ARTICLE)).toEqual({
      phase: 1,
      key: "returnProperties",
      message:
        'returnProperties names "writtenBy", a cross-reference: returning cross-references is outside this version of the console.',
    });
  });

  test("a boosted query property is checked without its boost", () => {
    const read = phase1('POST /v1/search/Article/bm25 {"query": "x", "queryProperties": ["title^2", "body"]}', ARTICLE);
    expect(read.search?.queryProperties).toEqual(["title^2", "body"]);
    expect(refused('POST /v1/search/Article/bm25 {"query": "x", "queryProperties": ["nope^2"]}', ARTICLE).message).toBe(
      'queryProperties names "nope", which is no property of "Article".',
    );
  });

  test("an aggregate's groupBy names a property, and an aggregate needs no vector", () => {
    expect(phase1('POST /v1/aggregate/Article {"groupBy": "category"}', ARTICLE).search?.groupBy).toBe("category");
    expect(refused('POST /v1/aggregate/Article {"groupBy": "nope"}', ARTICLE)).toEqual({
      phase: 1,
      key: "groupBy",
      message: 'groupBy names "nope", which is no property of "Article".',
    });
    const none = handFacts({ name: "Article", vectors: [], properties: ["category"] });
    expect(phase1("POST /v1/aggregate/Article", none).search?.targetVector).toBeNull();
  });
});

describe("the target vector", () => {
  test("the unnamed vector is the target of a collection that has only it, written as none", () => {
    expect(phase1('POST /v1/search/Article/near-vector {"vector": [0.1]}', ARTICLE).search?.targetVector).toBeNull();
  });

  test("a collection's only named vector is filled in for the encoders", () => {
    const single = handFacts({ name: "Article", vectors: ["text"] });
    expect(phase1('POST /v1/search/Article/near-vector {"vector": [0.1]}', single).search?.targetVector).toBe("text");
  });

  test("a collection with several vectors needs targetVector, and the one named must exist", () => {
    expect(refused('POST /v1/search/Product/near-vector {"vector": [0.1]}', PRODUCT)).toEqual({
      phase: 1,
      key: "targetVector",
      message:
        'The collection "Product" has more than one vector, so the search needs targetVector: it has image, text.',
    });
    expect(
      phase1('POST /v1/search/Product/near-vector {"vector": [0.1], "targetVector": "image"}', PRODUCT).search
        ?.targetVector,
    ).toBe("image");
    expect(refused('POST /v1/search/Product/near-vector {"vector": [0.1], "targetVector": "audio"}', PRODUCT)).toEqual({
      phase: 1,
      key: "targetVector",
      message: 'targetVector names "audio", which is no vector of "Product": it has image, text.',
    });
  });

  test("the unnamed vector is named as such, and a collection with none says so", () => {
    const both = handFacts({ name: "Mixed", vectors: ["", "image"] });
    expect(refused('POST /v1/search/Mixed/near-vector {"vector": [0.1], "targetVector": "x"}', both).message).toBe(
      'targetVector names "x", which is no vector of "Mixed": it has the unnamed vector, image.',
    );
    const none = handFacts({ name: "Bare", vectors: [] });
    expect(refused('POST /v1/search/Bare/near-vector {"vector": [0.1], "targetVector": "x"}', none).message).toBe(
      'targetVector names "x", which is no vector of "Bare": it has no vector.',
    );
    expect(refused('POST /v1/search/Bare/near-object {"id": "9e6866af-ef70-5a5a-9b61-1ae7a41bad0d"}', none)).toEqual({
      phase: 1,
      key: "targetVector",
      message: 'The collection "Bare" has no vector to search.',
    });
  });

  test("bm25 needs no vector, and names none on a collection with several", () => {
    const none = handFacts({ name: "Bare", vectors: [] });
    expect(phase1('POST /v1/search/Bare/bm25 {"query": "x"}', none).search?.targetVector).toBeNull();
    // A BM25 search reads no vector, so none is sent on either path (the REST server ignores one, measured on 1.40.2).
    expect(phase1('POST /v1/search/Product/bm25 {"query": "x"}', PRODUCT).search?.targetVector).toBeNull();
  });

  test("hybrid at alpha 0 opens on a vectorized collection, as measured", () => {
    const vectorized = handFacts({ name: "Doc", vectors: [["", "text2vec-openai"]] });
    expect(phase1('POST /v1/search/Doc/hybrid {"query": "x", "alpha": 0}', vectorized).search?.op).toBe(
      "search_hybrid",
    );
  });
});

describe("the query vector's numbers", () => {
  test("an integer a double cannot hold exactly is refused in phase 1", () => {
    expect(refused('POST /v1/search/Article/near-vector {"vector": [0.1, 9007199254740993]}', ARTICLE)).toEqual({
      phase: 1,
      key: "vector",
      message:
        "vector: The unnamed vector (float32): element 1 is 9007199254740993, outside the range a double holds exactly.",
    });
  });

  test("a number a float32 cannot hold is refused in phase 1", () => {
    expect(refused('POST /v1/search/Article/near-vector {"vector": [1e39]}', ARTICLE)).toEqual({
      phase: 1,
      key: "vector",
      message:
        "vector: The unnamed vector (float32): element 0 is 1e+39, not a finite number of absolute value at most 3.4028234663852886e+38.",
    });
  });
});
