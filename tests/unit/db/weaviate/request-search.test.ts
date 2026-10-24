/**
 * Phase 0 of the four Weaviate searches (#1566 spec 5.2, 5.3, W3): the closed body and its refused keys, the
 * inference rule (hybrid only at alpha 0), every value's kind and bound, and the default limit written in so the
 * REST and the GraphQL paths answer the same rows.
 */
import { describe, expect, test } from "bun:test";
import { type TaggedJson, toJsonText } from "@/lib/db/console/tagged-json";
import { bodyText, plan, refused, searchOf } from "../../../helpers/weaviate-request-fixtures";

const UUID = "9e6866af-ef70-5a5a-9b61-1ae7a41bad0d";
const bm25 = (body: string) => `POST /v1/search/Article/bm25 ${body}`;
const hybrid = (body: string) => `POST /v1/search/Article/hybrid ${body}`;
const nearVector = (body: string) => `POST /v1/search/Article/near-vector ${body}`;
const nearObject = (body: string) => `POST /v1/search/Article/near-object ${body}`;
const text = (value: TaggedJson | null) => (value === null ? null : toJsonText(value));

describe("the default limit", () => {
  test("a search with no limit is sent with 10, written into the body and the model", () => {
    expect(bodyText(bm25('{"query": "vector"}'))).toBe('{"query":"vector","limit":10}');
    expect(text(searchOf(bm25('{"query": "vector"}')).limit)).toBe("10");
  });

  test("a null key is dropped, and a null limit takes the default", () => {
    expect(bodyText(bm25('{"query": "vector", "limit": null, "tenant": null}'))).toBe('{"query":"vector","limit":10}');
  });

  test("a limit as typed is kept, digits and all", () => {
    expect(bodyText(bm25('{"query": "vector", "limit": 3}'))).toBe('{"query":"vector","limit":3}');
  });
});

describe("bm25", () => {
  test("the model holds every value as written", () => {
    const search = searchOf(
      bm25(
        `{"query": "vector search", "queryProperties": ["title^2", "body"], "limit": 5, "offset": 2, "autoLimit": 1, "returnProperties": ["title"], "returnMetadata": ["score", "explainScore"], "consistencyLevel": "QUORUM", "tenant": "acme"}`,
      ),
    );
    expect({
      op: search.op,
      collection: search.collection,
      query: search.query,
      queryProperties: search.queryProperties,
      limit: text(search.limit),
      offset: text(search.offset),
      autoLimit: text(search.autoLimit),
      returnProperties: search.returnProperties,
      returnMetadata: search.returnMetadata,
      consistencyLevel: search.consistencyLevel,
      tenant: search.tenant,
      targetVector: search.targetVector,
    }).toEqual({
      op: "search_bm25",
      collection: "Article",
      query: "vector search",
      queryProperties: ["title^2", "body"],
      limit: "5",
      offset: "2",
      autoLimit: "1",
      returnProperties: ["title"],
      returnMetadata: ["score", "explainScore"],
      consistencyLevel: "QUORUM",
      tenant: "acme",
      targetVector: null,
    });
    expect(plan(bm25('{"query": "x", "tenant": "acme"}')).tenant).toBe("acme");
  });

  test("query is required, must be a string and must hold words", () => {
    expect(refused(bm25("{}"))).toEqual({ phase: 0, key: "query", message: "The body needs the key query." });
    expect(refused(bm25('{"query": 3}')).message).toBe("query must be a string, found a number.");
    expect(refused(bm25('{"query": "   "}'))).toEqual({
      phase: 0,
      key: "query",
      message: "query is empty: a keyword search needs words.",
    });
  });

  test("an unknown key is refused naming the keys the body takes", () => {
    expect(refused(bm25('{"query": "x", "filter": {}}'))).toEqual({
      phase: 0,
      key: "filter",
      message:
        'The body takes no key "filter": Weaviate reads where, limit, offset, autoLimit, returnProperties, returnMetadata, tenant, consistencyLevel, query, queryProperties there and nothing else.',
    });
  });

  test("a key longer than 80 characters is shown cut", () => {
    const key = "k".repeat(81);
    expect(refused(bm25(`{"query": "x", "${key}": 1}`)).message).toStartWith(
      `The body takes no key "${"k".repeat(80)}...": Weaviate reads`,
    );
  });

  test.each([
    ["singlePrompt", "generative search sends the results to a model provider"],
    ["groupedTask", "generative search sends the results to a model provider"],
    ["rerank", "reranking sends the results to a model provider"],
    ["groupBy", "grouped search is reserved in Weaviate's REST search"],
    ["numberOfGroups", "grouped search is reserved in Weaviate's REST search"],
    ["objectsPerGroup", "grouped search is reserved in Weaviate's REST search"],
    ["returnReferences", "returning cross-references is outside this version of the console"],
  ])("%s is refused by name with its reason", (key, reason) => {
    expect(refused(bm25(`{"query": "x", "${key}": 1}`))).toEqual({
      phase: 0,
      key,
      message: `The body takes no key "${key}" in this console: ${reason}.`,
    });
  });

  test("queryProperties takes 1 to 256 boosted property names, each once", () => {
    expect(refused(bm25('{"query": "x", "queryProperties": []}'))).toEqual({
      phase: 0,
      key: "queryProperties",
      message: "queryProperties holds 0 properties; it takes 1 to 256.",
    });
    const many = JSON.stringify(Array.from({ length: 257 }, (_, index) => `p${index}`));
    expect(refused(bm25(`{"query": "x", "queryProperties": ${many}}`)).message).toBe(
      "queryProperties holds 257 properties; it takes 1 to 256.",
    );
    expect(refused(bm25('{"query": "x", "queryProperties": ["title^x"]}')).message).toBe(
      'queryProperties[0] is "title^x", which is not a Weaviate property name.',
    );
    expect(refused(bm25('{"query": "x", "queryProperties": ["title", "title"]}')).message).toBe(
      'queryProperties names "title" twice.',
    );
    expect(refused(bm25('{"query": "x", "queryProperties": [1]}')).message).toBe(
      "queryProperties[0] must be a string, found a number.",
    );
    expect(refused(bm25('{"query": "x", "queryProperties": "title"}')).message).toBe(
      "queryProperties must be a list, found a string.",
    );
  });

  test("returnProperties takes plain names, no boost", () => {
    expect(refused(bm25('{"query": "x", "returnProperties": ["title^2"]}'))).toEqual({
      phase: 0,
      key: "returnProperties",
      message: 'returnProperties[0] is "title^2", which is not a Weaviate property name.',
    });
  });

  test("returnMetadata and consistencyLevel take their words", () => {
    expect(refused(bm25('{"query": "x", "returnMetadata": ["vector"]}'))).toEqual({
      phase: 0,
      key: "returnMetadata[0]",
      message:
        'returnMetadata[0] takes one of distance, certainty, score, explainScore, creationTime, lastUpdateTime, not "vector".',
    });
    expect(refused(bm25('{"query": "x", "consistencyLevel": 1}')).message).toBe(
      "consistencyLevel takes one of ONE, QUORUM, ALL, not a number.",
    );
  });

  test("a body tenant is a tenant name", () => {
    expect(refused(bm25('{"query": "x", "tenant": "a.b"}'))).toEqual({
      phase: 0,
      key: "tenant",
      message:
        'tenant: "a.b" is not a Weaviate tenant name: it holds only letters, digits, - and _, 1 to 64 characters.',
    });
    expect(refused(bm25('{"query": "x", "tenant": true}')).message).toBe("tenant must be a string, found a boolean.");
  });
});

describe("limit, offset and autoLimit", () => {
  test.each([
    ['"limit": 0', "limit is 0; it takes an integer from 1 to 1000."],
    ['"limit": 1001', "limit is 1001; it takes an integer from 1 to 1000."],
    ['"limit": 1.5', "limit must be an integer, found a number."],
    ['"limit": "5"', "limit must be an integer, found a string."],
    ['"limit": 99999999999999999999', "limit is 99999999999999999999; it takes an integer from 1 to 1000."],
    ['"offset": -1', "offset is -1; it takes an integer from 0 to 1000."],
    ['"autoLimit": 0', "autoLimit is 0; it takes an integer from 1 to 1000."],
  ])("%s is refused", (pair, message) => {
    expect(refused(bm25(`{"query": "x", ${pair}}`)).message).toBe(message);
  });

  test("limit plus offset is at most 1,000, with the default limit counted", () => {
    expect(refused(bm25('{"query": "x", "offset": 995}'))).toEqual({
      phase: 0,
      key: "limit",
      message: "limit plus offset is 1005, above the bound of 1000 rows.",
    });
    expect(text(searchOf(bm25('{"query": "x", "limit": 500, "offset": 500}')).offset)).toBe("500");
  });
});

describe("hybrid (W3)", () => {
  test("at alpha 0 is a keyword-only search, with its own keys", () => {
    const search = searchOf(
      hybrid(
        '{"query": "vector", "alpha": 0, "fusionType": "relativeScore", "maxVectorDistance": 0.5, "targetVector": "text"}',
      ),
    );
    expect({
      op: search.op,
      fusionType: search.fusionType,
      maxVectorDistance: text(search.maxVectorDistance),
      targetVector: search.targetVector,
    }).toEqual({ op: "search_hybrid", fusionType: "relativeScore", maxVectorDistance: "0.5", targetVector: "text" });
    expect(searchOf(hybrid('{"query": "vector", "alpha": 0.0}')).op).toBe("search_hybrid");
  });

  test("alpha is required, since the server's default is 0.7", () => {
    expect(refused(hybrid('{"query": "vector"}'))).toEqual({
      phase: 0,
      key: "alpha",
      message: "The body needs the key alpha.",
    });
  });

  test("any alpha other than 0 is refused with the sentence naming the model provider", () => {
    expect(refused(hybrid('{"query": "vector", "alpha": 0.5}'))).toEqual({
      phase: 0,
      key: "alpha",
      message:
        'alpha must be 0 in this console: any other value makes Weaviate embed the query text with the collection\'s vectorizer, which sends it to a model provider. Write "alpha": 0 for a keyword-only hybrid search.',
    });
    expect(refused(hybrid('{"query": "vector", "alpha": "0"}')).message).toBe(
      "alpha must be a number, found a string.",
    );
  });

  test("fusionType, maxVectorDistance and targetVector are checked", () => {
    expect(refused(hybrid('{"query": "v", "alpha": 0, "fusionType": "rankedFusion"}')).message).toBe(
      'fusionType takes one of ranked, relativeScore, not "rankedFusion".',
    );
    expect(refused(hybrid('{"query": "v", "alpha": 0, "maxVectorDistance": "far"}')).message).toBe(
      "maxVectorDistance must be a number, found a string.",
    );
    expect(refused(hybrid('{"query": "v", "alpha": 0, "targetVector": "a b"}'))).toEqual({
      phase: 0,
      key: "targetVector",
      message: 'targetVector is "a b", which is not a Weaviate vector name.',
    });
    expect(refused(hybrid('{"query": "v", "alpha": 0, "targetVector": ["a"]}')).message).toBe(
      "targetVector must be a string, found a list.",
    );
  });
});

describe("near-vector", () => {
  test("keeps every number as typed", () => {
    const search = searchOf(nearVector('{"vector": [0.1, -2, 3e-1], "distance": 0.4}'));
    expect(search.vector?.map((entry) => toJsonText(entry))).toEqual(["0.1", "-2", "3e-1"]);
    expect(text(search.distance)).toBe("0.4");
    expect(bodyText(nearVector('{"vector": [0.1, -2, 3e-1]}'))).toBe('{"vector":[0.1,-2,3e-1],"limit":10}');
  });

  test("the vector is one dense list of 1 to 65,536 numbers", () => {
    expect(refused(nearVector("{}")).message).toBe("The body needs the key vector.");
    expect(refused(nearVector('{"vector": {"a": 1}}')).message).toBe("vector must be a list, found an object.");
    expect(refused(nearVector('{"vector": [[0.1], [0.2]]}'))).toEqual({
      phase: 0,
      key: "vector",
      message: "vector is a list of lists: this console searches with one dense vector, a list of numbers.",
    });
    expect(refused(nearVector('{"vector": []}')).message).toBe("vector holds 0 numbers; it takes 1 to 65536.");
    const long = `[${new Array(65_537).fill("0").join(",")}]`;
    expect(refused(nearVector(`{"vector": ${long}}`)).message).toBe("vector holds 65537 numbers; it takes 1 to 65536.");
    expect(refused(nearVector('{"vector": [0.1, "x"]}')).message).toBe("vector[1] must be a number, found a string.");
    expect(refused(nearVector('{"vector": [null]}')).message).toBe("vector[0] must be a number, found null.");
  });

  test("certainty is from 0 to 1, and distance and certainty do not go together", () => {
    expect(text(searchOf(nearVector('{"vector": [1], "certainty": 1}')).certainty)).toBe("1");
    expect(refused(nearVector('{"vector": [1], "certainty": 1.5}'))).toEqual({
      phase: 0,
      key: "certainty",
      message: "certainty takes a number from 0 to 1.",
    });
    expect(refused(nearVector('{"vector": [1], "certainty": -0.1}')).message).toBe(
      "certainty takes a number from 0 to 1.",
    );
    expect(refused(nearVector('{"vector": [1], "distance": "near"}')).message).toBe(
      "distance must be a number, found a string.",
    );
    expect(refused(nearVector('{"vector": [1], "distance": 0.1, "certainty": 0.9}'))).toEqual({
      phase: 0,
      key: "distance",
      message: "A search takes distance or certainty, not both.",
    });
  });
});

describe("near-object", () => {
  test("takes an object id, a UUID", () => {
    expect(searchOf(nearObject(`{"id": "${UUID}"}`)).id).toBe(UUID);
    expect(refused(nearObject('{"id": "42"}'))).toEqual({
      phase: 0,
      key: "id",
      message: 'id is "42", which is not a UUID: Weaviate\'s object ids are UUIDs.',
    });
    expect(refused(nearObject('{"id": 42}')).message).toBe("id must be a string, found a number.");
  });
});
