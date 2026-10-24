/**
 * The two encoders of one Weaviate search model (#1566 spec 3.1, 5.5, W5): `encodeGraphql` writes the one `Get` or
 * `Aggregate` document a server below 1.39.7 is sent, and `encodeRest` the REST body. Each GraphQL document is
 * compared with the body the 1.37.4 server answered, and every identifier, string and number goes through the
 * builder's checks, never through a user's text as typed.
 */
import { describe, expect, test } from "bun:test";
import { taggedNumber, type TaggedObject } from "@/lib/db/console/tagged-json";
import { QueryError } from "@/lib/db/errors";
import {
  encodeGraphql,
  encodeRest,
  GRAPHQL_METADATA,
  graphqlName,
  graphqlString,
  graphqlWhere,
  selectedProperties,
} from "@/lib/db/providers/vector/weaviate/graphql";
import { type WeaviateSearchModel, weaviatePhase1 } from "@/lib/db/providers/vector/weaviate/request";
import type { WeaviateCollectionFacts } from "@/lib/db/providers/vector/weaviate/schema";
import { handFacts, plan, recordedFacts, recordedGraphqlBodies } from "../../../helpers/weaviate-request-fixtures";

const FACTS: Readonly<Record<string, WeaviateCollectionFacts>> = Object.fromEntries(
  ["Article", "Product", "TenantNotes", "EdgeValues", "Empty", "Author"].map((name) => [name, recordedFacts(name)]),
);

/** The model phase 1 answers for a text, and the facts of its collection. */
function modelOf(text: string): { model: WeaviateSearchModel; facts: WeaviateCollectionFacts } {
  const read = plan(text);
  const facts = FACTS[read.collection as string];
  return { model: weaviatePhase1(read, facts).search as WeaviateSearchModel, facts };
}

const graphql = (text: string): string => {
  const { model, facts } = modelOf(text);
  return encodeGraphql(model, facts);
};
const documentOf = (text: string): string => (JSON.parse(graphql(text)) as { query: string }).query;
const rest = (text: string): string => {
  const read = plan(text);
  const { model } = modelOf(text);
  return encodeRest(read.body as TaggedObject, model);
};

const UUID = "9e6866af-ef70-5a5a-9b61-1ae7a41bad0d";
const VECTOR16 = "[0.1,-0.2,0.3,0.4,-0.5,0.6,0.7,-0.8,0.9,0.1,0.2,-0.3,0.4,0.5,-0.6,0.7]";

/** The console texts whose GraphQL documents the 1.37.4 server answered, in the order of the record. */
const RECORDED: readonly string[] = [
  'POST /v1/search/Article/bm25 {"query": "vector", "limit": 3, "returnProperties": ["title", "wordCount"], "returnMetadata": ["score"]}',
  'POST /v1/search/Article/bm25 {"query": "vector", "where": {"path": ["category"], "operator": "Equal", "valueText": "alpha"}, "limit": 2, "returnProperties": ["title", "category"]}',
  'POST /v1/search/Article/bm25 {"query": "vector", "limit": 2}',
  `POST /v1/search/Article/near-vector {"vector": ${VECTOR16}, "limit": 2, "returnProperties": ["title"], "returnMetadata": ["distance"]}`,
  `POST /v1/search/Article/near-object {"id": "${UUID}", "limit": 2, "returnProperties": ["title"], "returnMetadata": ["distance"]}`,
  'POST /v1/search/Article/hybrid {"query": "vector", "alpha": 0, "limit": 2, "returnProperties": ["title"]}',
  'POST /v1/search/Product/near-vector {"vector": [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8], "targetVector": "image", "limit": 1, "returnProperties": ["name"]}',
  'POST /v1/search/TenantNotes/bm25 {"query": "note", "tenant": "acme", "limit": 2}',
  'POST /v1/search/EdgeValues/bm25 {"query": "9007199254740991", "returnProperties": ["label", "big"]}',
  'POST /v1/search/Product/bm25 {"query": "product", "limit": 2, "returnProperties": ["name"]}',
  "POST /v1/aggregate/Article",
  'POST /v1/aggregate/Article {"groupBy": "category"}',
  'POST /v1/aggregate/TenantNotes {"tenant": "acme"}',
  "POST /v1/aggregate/Empty",
  'POST /v1/aggregate/Article {"where": {"path": ["location"], "operator": "WithinGeoRange", "valueGeoRange": {"geoCoordinates": {"latitude": 41, "longitude": 29}, "distance": {"max": 3000000}}}}',
  'POST /v1/aggregate/Article {"where": {"operator": "And", "operands": [{"path": ["published"], "operator": "Equal", "valueBoolean": true}, {"path": ["location"], "operator": "WithinGeoRange", "valueGeoRange": {"geoCoordinates": {"latitude": 41, "longitude": 29}, "distance": {"max": 3000000}}}]}}',
  'POST /v1/search/Article/bm25 {"query": "vector", "where": {"path": ["tags"], "operator": "ContainsAny", "valueTextArray": ["graph", "shard"]}, "limit": 50, "returnProperties": ["title"]}',
  "POST /v1/aggregate/Product",
  "POST /v1/aggregate/Author",
  "POST /v1/aggregate/EdgeValues",
];

describe("encodeGraphql against the record", () => {
  test("every recorded document is written byte for byte from its REST search text", () => {
    expect(RECORDED.map(graphql)).toEqual([...recordedGraphqlBodies()]);
  });
});

describe("encodeGraphql", () => {
  test("a hybrid search writes alpha 0, its properties, fusion, distance and target as GraphQL spells them", () => {
    const product =
      'POST /v1/search/Product/hybrid {"query": "lamp", "alpha": 0, "queryProperties": ["name^2"], "fusionType": "relativeScore", "maxVectorDistance": 0.25, "targetVector": "text", "limit": 4}';
    expect(documentOf(product)).toBe(
      '{Get{Product(hybrid:{query:"lamp",alpha:0,properties:["name^2"],fusionType:relativeScoreFusion,maxVectorDistance:0.25,targetVectors:["text"]},limit:4){name price sku _additional{id}}}}',
    );
    expect(
      documentOf(
        'POST /v1/search/Product/hybrid {"query": "lamp", "alpha": 0, "fusionType": "ranked", "targetVector": "text"}',
      ),
    ).toContain("fusionType:rankedFusion");
  });

  test("bm25 properties, offset, autocut and consistency level are written as arguments", () => {
    expect(
      documentOf(
        'POST /v1/search/Article/bm25 {"query": "vector", "queryProperties": ["title^2", "body"], "limit": 5, "offset": 3, "autoLimit": 1, "consistencyLevel": "ONE", "returnProperties": ["title"]}',
      ),
    ).toBe(
      '{Get{Article(bm25:{query:"vector",properties:["title^2","body"]},limit:5,offset:3,autocut:1,consistencyLevel:ONE){title _additional{id}}}}',
    );
  });

  test("near-vector and near-object write distance or certainty as typed", () => {
    expect(documentOf('POST /v1/search/Article/near-vector {"vector": [1e-3, 2], "certainty": 0.75}')).toBe(
      "{Get{Article(nearVector:{vector:[1e-3,2],certainty:0.75},limit:10){title body category tags wordCount rating published publishedAt location{latitude longitude} meta{source revision} _additional{id}}}}",
    );
    expect(
      documentOf(
        `POST /v1/search/Article/near-object {"id": "${UUID}", "distance": 0.5, "returnProperties": ["title"]}`,
      ),
    ).toBe(`{Get{Article(nearObject:{id:"${UUID}",distance:0.5},limit:10){title _additional{id}}}}`);
  });

  test("every metadata word is written as _additional spells it", () => {
    const words = Object.keys(GRAPHQL_METADATA);
    expect(
      documentOf(
        `POST /v1/search/Article/bm25 {"query": "x", "returnProperties": ["title"], "returnMetadata": ${JSON.stringify(words)}}`,
      ),
    ).toBe(
      '{Get{Article(bm25:{query:"x"},limit:10){title _additional{id distance certainty score explainScore creationTimeUnix lastUpdateTimeUnix}}}}',
    );
  });

  test("a collection with no selectable property selects _additional alone", () => {
    const facts = handFacts({ name: "Linked", properties: [], references: ["owner"] });
    const read = plan('POST /v1/search/Linked/bm25 {"query": "x"}');
    const model = weaviatePhase1(read, facts).search as WeaviateSearchModel;
    expect(JSON.parse(encodeGraphql(model, facts)).query).toBe(
      '{Get{Linked(bm25:{query:"x"},limit:10){_additional{id}}}}',
    );
  });

  test("an aggregate with a where filter and a group limit", () => {
    expect(
      documentOf(
        'POST /v1/aggregate/Article {"where": {"path": ["published"], "operator": "Equal", "valueBoolean": true}, "groupBy": "category", "limit": 2}',
      ),
    ).toBe(
      '{Aggregate{Article(where:{path:["published"],operator:Equal,valueBoolean:true},groupBy:["category"],limit:2){meta{count} groupedBy{value path}}}}',
    );
  });

  test("a string is escaped by JSON's rules, so a quote or a brace stays inside it", () => {
    expect(documentOf('POST /v1/search/Article/bm25 {"query": "a\\"}){x}\\n", "returnProperties": ["title"]}')).toBe(
      '{Get{Article(bm25:{query:"a\\"}){x}\\n"},limit:10){title _additional{id}}}}',
    );
  });

  test("a text that is not well-formed Unicode is refused before anything is sent", () => {
    const { model, facts } = modelOf('POST /v1/search/Article/bm25 {"query": "x"}');
    expect(() => encodeGraphql({ ...model, query: "\uD800" }, facts)).toThrow(
      new QueryError("A text in the request is not well-formed Unicode, so it cannot be sent over GraphQL."),
    );
  });

  test("an identifier that is no GraphQL name is refused, whatever reached the encoder", () => {
    const { model, facts } = modelOf('POST /v1/search/Article/bm25 {"query": "x"}');
    expect(() => encodeGraphql({ ...model, collection: "Article){x" }, facts)).toThrow(
      '"Article){x" cannot be written as a GraphQL name, so nothing was sent.',
    );
    expect(() => encodeGraphql({ ...model, consistencyLevel: "TWO" }, facts)).toThrow(
      '"TWO" is not a word this encoder writes, so nothing was sent.',
    );
  });

  test("a number Studio produced is written as JSON writes it, and anything else that is no number is refused", () => {
    const { model, facts } = modelOf('POST /v1/search/Article/bm25 {"query": "x", "returnProperties": ["title"]}');
    expect(JSON.parse(encodeGraphql({ ...model, limit: 5 }, facts)).query).toBe(
      '{Get{Article(bm25:{query:"x"},limit:5.0){title _additional{id}}}}',
    );
    expect(() => encodeGraphql({ ...model, limit: "5" }, facts)).toThrow(
      "A number in the request cannot be written as a GraphQL number, so nothing was sent.",
    );
    expect(() => encodeGraphql({ ...model, limit: Number.NaN }, facts)).toThrow(
      "A number in the request cannot be written as a GraphQL number, so nothing was sent.",
    );
  });
});

describe("graphqlWhere", () => {
  const whereOf = (where: string): string =>
    graphqlWhere(plan(`POST /v1/search/Article/bm25 {"query": "x", "where": ${where}}`).search?.where as TaggedObject);

  test("nested operands and a number keep their spelling, and a value list goes under the scalar key", () => {
    expect(
      whereOf(
        '{"operator": "Or", "operands": [{"path": ["tags"], "operator": "ContainsAny", "valueTextArray": ["a", "b"]}, {"path": ["rating"], "operator": "GreaterThan", "valueNumber": 4.50}]}',
      ),
    ).toBe(
      '{operator:Or,operands:[{path:["tags"],operator:ContainsAny,valueText:["a","b"]},{path:["rating"],operator:GreaterThan,valueNumber:4.50}]}',
    );
  });

  test("every value<Type>Array key is written as its scalar key, which is the only spelling GraphQL accepts", () => {
    // Measured on 1.37.4, 1.38.22 and 1.40.2: valueTextArray is an "Unknown field", valueText with a list answers
    // the count REST answers for valueTextArray.
    for (const [key, value, written] of [
      ["valueTextArray", '["a"]', 'valueText:["a"]'],
      ["valueStringArray", '["a"]', 'valueString:["a"]'],
      ["valueIntArray", "[1, 2]", "valueInt:[1,2]"],
      ["valueNumberArray", "[1.5]", "valueNumber:[1.5]"],
      ["valueBooleanArray", "[true]", "valueBoolean:[true]"],
      ["valueDateArray", '["2026-01-01T00:00:00Z"]', 'valueDate:["2026-01-01T00:00:00Z"]'],
    ]) {
      expect(whereOf(`{"path": ["tags"], "operator": "ContainsAny", "${key}": ${value}}`)).toBe(
        `{path:["tags"],operator:ContainsAny,${written}}`,
      );
    }
  });

  test("a geo range is written in a fixed order, whatever order it was typed in", () => {
    expect(
      whereOf(
        '{"path": ["location"], "operator": "WithinGeoRange", "valueGeoRange": {"distance": {"max": 2000}, "geoCoordinates": {"longitude": 2.35, "latitude": 48.85}}}',
      ),
    ).toBe(
      '{path:["location"],operator:WithinGeoRange,valueGeoRange:{geoCoordinates:{latitude:48.85,longitude:2.35},distance:{max:2000}}}',
    );
  });

  test("a null key is left out", () => {
    const filter = Object.assign(Object.create(null), {
      path: ["title"],
      operator: "IsNull",
      valueBoolean: false,
      valueText: null,
    }) as TaggedObject;
    expect(graphqlWhere(filter)).toBe('{path:["title"],operator:IsNull,valueBoolean:false}');
  });

  test("an operator outside Weaviate's words is refused", () => {
    const filter = Object.assign(Object.create(null), {
      operator: "Equal}){x",
      path: ["a"],
      valueInt: taggedNumber("1"),
    });
    expect(() => graphqlWhere(filter as TaggedObject)).toThrow(
      '"Equal}){x" is not a word this encoder writes, so nothing was sent.',
    );
  });
});

describe("the builder's pieces", () => {
  test("graphqlName takes a GraphQL name only", () => {
    expect(graphqlName("_a1")).toBe("_a1");
    expect(() => graphqlName("1a")).toThrow(QueryError);
  });

  test("graphqlString is JSON's escaping", () => {
    expect(graphqlString('say "hi"\t')).toBe('"say \\"hi\\"\\t"');
  });

  test("selectedProperties keeps the properties named that have a selection, in the order named", () => {
    const { model, facts } = modelOf(
      'POST /v1/search/Article/bm25 {"query": "x", "returnProperties": ["location", "title"]}',
    );
    expect(selectedProperties(model, facts)).toEqual([
      { name: "location", fields: [{ name: "latitude" }, { name: "longitude" }] },
      { name: "title" },
    ]);
    expect(selectedProperties({ ...model, returnProperties: ["writtenBy"] }, facts)).toEqual([]);
  });
});

describe("encodeRest", () => {
  test("writes the checked body back, the default limit in it", () => {
    expect(rest('POST /v1/search/Article/bm25 {"query": "vector", "limit": 2}')).toBe('{"query":"vector","limit":2}');
    expect(rest('POST /v1/search/Article/bm25 {"query": "vector"}')).toBe('{"query":"vector","limit":10}');
  });

  test("adds the target vector phase 1 found when the body names none", () => {
    const facts = handFacts({ name: "Doc", vectors: ["text"] });
    const read = plan('POST /v1/search/Doc/near-vector {"vector": [0.5], "limit": 1}');
    const model = weaviatePhase1(read, facts).search as WeaviateSearchModel;
    expect(encodeRest(read.body as TaggedObject, model)).toBe('{"vector":[0.5],"limit":1,"targetVector":"text"}');
  });

  test("keeps a target vector the body names, and adds none for the unnamed vector", () => {
    expect(rest('POST /v1/search/Product/near-vector {"vector": [0.1], "targetVector": "image", "limit": 1}')).toBe(
      '{"vector":[0.1],"targetVector":"image","limit":1}',
    );
    expect(rest('POST /v1/search/Article/near-vector {"vector": [0.1]}')).toBe('{"vector":[0.1],"limit":10}');
  });

  test("an aggregate body is sent as checked", () => {
    expect(rest('POST /v1/aggregate/TenantNotes {"tenant": "acme"}')).toBe('{"tenant":"acme"}');
    expect(rest("POST /v1/aggregate/Article")).toBe("{}");
  });
});
