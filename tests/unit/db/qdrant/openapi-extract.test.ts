/**
 * The extract of Qdrant's pinned OpenAPI document (vector-family spec 6.4, QE10, QE21): the rules of the derivation,
 * over small documents. The committed tests/fixtures/qdrant/openapi-extract.json is held in qdrant-fixtures.test.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  QDRANT_OPENAPI_SHA256,
  QDRANT_OPENAPI_SOURCE,
  QDRANT_V1_OPERATION_IDS,
  qdrantOpenApiExtract,
} from "../../../live/qdrant-openapi-extract";

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });

/** A document declaring all 17 operations with no body, which a test then changes. */
function document(): {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, unknown> };
} {
  return {
    paths: Object.fromEntries(QDRANT_V1_OPERATION_IDS.map((op) => [`/${op}`, { get: { operationId: op } }])),
    components: { schemas: {} },
  };
}

describe("qdrantOpenApiExtract", () => {
  test("keeps each operation's method, path, parameters by place and body schema", () => {
    const doc = document();
    delete doc.paths["/scroll_points"];
    doc.paths["/collections/{collection_name}/points/scroll"] = {
      post: {
        operationId: "scroll_points",
        summary: "Scroll points",
        parameters: [
          { name: "collection_name", in: "path" },
          { name: "consistency", in: "query" },
          { name: "timeout", in: "query" },
          { name: "x-trace", in: "header" },
          "not a parameter",
        ],
        requestBody: { description: "prose", content: { "application/json": { schema: ref("ScrollRequest") } } },
      },
      parameters: "ignored",
    };
    doc.components.schemas = {
      ScrollRequest: {
        type: "object",
        description: "prose",
        properties: { filter: { anyOf: [ref("Filter"), { nullable: true }] } },
      },
      Filter: {
        type: "object",
        title: "prose",
        properties: { must: { example: 1, type: "array", items: ref("Filter") } },
        additionalProperties: false,
      },
      Unreached: { type: "string" },
    };
    const extract = qdrantOpenApiExtract(doc, "a test");
    expect(extract.$generated).toEqual({ by: "a test", source: QDRANT_OPENAPI_SOURCE, sha256: QDRANT_OPENAPI_SHA256 });
    expect(extract.operations.map((operation) => operation.op)).toEqual([...QDRANT_V1_OPERATION_IDS]);
    expect(extract.operations.find((operation) => operation.op === "scroll_points")).toEqual({
      op: "scroll_points",
      method: "POST",
      path: "/collections/{collection_name}/points/scroll",
      pathParameters: ["collection_name"],
      queryParameters: ["consistency", "timeout"],
      requestBody: "ScrollRequest",
      requestBodyRequired: false,
    });
    expect(extract.operations.find((operation) => operation.op === "root")).toEqual({
      op: "root",
      method: "GET",
      path: "/root",
      pathParameters: [],
      queryParameters: [],
      requestBody: null,
      requestBodyRequired: false,
    });
    // Only what a request body reaches, sorted, without its prose.
    expect(extract.schemas).toEqual({
      Filter: {
        type: "object",
        properties: { must: { type: "array", items: ref("Filter") } },
        additionalProperties: false,
      },
      ScrollRequest: { type: "object", properties: { filter: { anyOf: [ref("Filter"), { nullable: true }] } } },
    });
  });

  test("a property that is named like a prose key is a key of the schema, and is kept", () => {
    const doc = document();
    doc.paths["/count_points"] = {
      post: {
        operationId: "count_points",
        requestBody: { required: true, content: { "application/json": { schema: ref("Body") } } },
      },
    };
    doc.components.schemas = {
      Body: { properties: { description: { type: "string", description: "prose" }, title: { type: "string" } } },
    };
    const extract = qdrantOpenApiExtract(doc, "a test");
    expect(extract.schemas.Body).toEqual({
      properties: { description: { type: "string" }, title: { type: "string" } },
    });
    expect(extract.operations.find((operation) => operation.op === "count_points")?.requestBodyRequired).toBe(true);
  });

  test.each<readonly [string, () => unknown, string]>([
    ["a document that is no object", () => "text", "is not an OpenAPI document"],
    ["a document without components", () => ({ paths: {} }), "is not an OpenAPI document"],
    ["a document without schemas", () => ({ paths: {}, components: {} }), "defines no schemas"],
    [
      "a missing operation",
      () => {
        const doc = document();
        delete doc.paths["/facet"];
        delete doc.paths["/root"];
        return doc;
      },
      "does not declare root, facet",
    ],
    [
      "an operation declared twice",
      () => {
        const doc = document();
        doc.paths["/again"] = { get: { operationId: "root" }, post: "not an operation" };
        doc.paths["/not-an-item"] = "text" as never;
        return doc;
      },
      "declares root twice",
    ],
    [
      "a body that references no schema",
      () => {
        const doc = document();
        doc.paths["/facet"] = {
          post: {
            operationId: "facet",
            requestBody: { content: { "application/json": { schema: { type: "object" } } } },
          },
        };
        return doc;
      },
      "the request body of facet does not reference a schema",
    ],
    [
      "a reference to a schema the document does not define",
      () => {
        const doc = document();
        doc.paths["/facet"] = {
          post: { operationId: "facet", requestBody: { content: { "application/json": { schema: ref("Missing") } } } },
        };
        return doc;
      },
      "references the schema Missing, which it does not define",
    ],
    [
      "a reference outside the schemas",
      () => {
        const doc = document();
        doc.paths["/facet"] = {
          post: { operationId: "facet", requestBody: { content: { "application/json": { schema: ref("Body") } } } },
        };
        doc.components.schemas = { Body: { properties: { a: { $ref: "#/components/parameters/x" } } } };
        return doc;
      },
      "references #/components/parameters/x, outside its schemas",
    ],
  ])("%s is refused by name", (_name, build, message) => {
    expect(() => qdrantOpenApiExtract(build(), "a test")).toThrow(message);
  });
});
