/**
 * The derivation of tests/fixtures/qdrant/openapi-schemas.json (tests/live/qdrant-openapi-derive.ts): its rules over
 * small inputs, and the committed file's header, which names the two pinned sources it was written from.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  localModelNames,
  QDRANT_LOCAL_MODEL_SHA256,
  type QdrantOpenApiFacts,
  qdrantOpenApiFacts,
} from "../../../live/qdrant-openapi-derive";
import { QDRANT_SPEC_SHA256, QDRANT_V1_OPERATIONS } from "../../../live/vector-route-tables";

/** A document holding the 17 v1 operations, each a GET with no body, plus what a test adds. */
function document(extra: Record<string, unknown> = {}, schemas: Record<string, unknown> = {}) {
  const paths: Record<string, unknown> = {};
  QDRANT_V1_OPERATIONS.forEach((op, index) => {
    paths[`/op${index}`] = { get: { operationId: op } };
  });
  return { paths: { ...paths, ...extra }, components: { schemas } };
}

describe("qdrantOpenApiFacts", () => {
  test("keeps the 17 v1 operations in table order, with their query keys, body schema and required keys", () => {
    const facts = qdrantOpenApiFacts(
      document(
        {
          "/op6": {
            post: {
              operationId: "get_points",
              parameters: [
                { name: "collection_name", in: "path" },
                { name: "consistency", in: "query" },
              ],
              requestBody: {
                content: { "application/json": { schema: { $ref: "#/components/schemas/PointRequest" } } },
              },
            },
          },
          "/other": { put: { operationId: "upsert_points" } },
        },
        {
          PointRequest: {
            type: "object",
            required: ["ids"],
            properties: { ids: { type: "array", items: { $ref: "#/components/schemas/ExtendedPointId" } } },
          },
          ExtendedPointId: {
            anyOf: [
              { type: "integer", format: "uint64" },
              { type: "string", format: "uuid" },
            ],
          },
        },
      ),
    );
    expect(Object.keys(facts.operations)).toEqual([...QDRANT_V1_OPERATIONS]);
    expect(facts.operations.get_points).toEqual({
      method: "POST",
      path: "/op6",
      query: ["consistency"],
      bodySchema: "PointRequest",
      required: ["ids"],
    });
    expect(facts.objects).toEqual({ PointRequest: { keys: ["ids"], required: ["ids"] } });
    expect(facts.unions).toEqual({ ExtendedPointId: ["integer (uint64)", "string (uuid)"] });
    expect(facts.enums).toEqual({});
  });

  test("follows every reference a reached schema makes, and records an enumeration's words", () => {
    const facts = qdrantOpenApiFacts(
      document(
        {
          "/op8": {
            post: {
              operationId: "scroll_points",
              requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Scroll" } } } },
            },
          },
        },
        {
          Scroll: {
            type: "object",
            properties: { order: { anyOf: [{ $ref: "#/components/schemas/Order" }, { nullable: true }] } },
          },
          Order: {
            type: "object",
            required: ["direction"],
            properties: { direction: { $ref: "#/components/schemas/Direction" } },
          },
          Direction: { type: "string", enum: ["asc", "desc"] },
        },
      ),
    );
    expect(facts.objects).toEqual({
      Order: { keys: ["direction"], required: ["direction"] },
      Scroll: { keys: ["order"], required: [] },
    });
    expect(facts.enums).toEqual({ Direction: ["asc", "desc"] });
  });

  test("refuses a document that lacks a v1 operation, a body with no schema, and a schema of another shape", () => {
    expect(() => qdrantOpenApiFacts({ paths: {}, components: { schemas: {} } })).toThrow(
      "the OpenAPI document lacks the v1 operations root,",
    );
    expect(() => qdrantOpenApiFacts({})).toThrow("the OpenAPI document has no paths or no schemas");
    expect(() =>
      qdrantOpenApiFacts(
        document({ "/op8": { post: { operationId: "scroll_points", requestBody: { content: {} } } } }),
      ),
    ).toThrow("scroll_points takes a body that references no schema");
    expect(() =>
      qdrantOpenApiFacts(
        document(
          {
            "/op8": {
              post: {
                operationId: "scroll_points",
                requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Odd" } } } },
              },
            },
          },
          { Odd: { type: "string" } },
        ),
      ),
    ).toThrow("Odd is neither an object, a union nor an enumeration");
    expect(() =>
      qdrantOpenApiFacts(
        document({
          "/op8": {
            post: {
              operationId: "scroll_points",
              requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/Gone" } } } },
            },
          },
        }),
      ),
    ).toThrow("the OpenAPI document references Gone and does not define it");
  });
});

describe("localModelNames", () => {
  test("reads the names LocalModelName::from_str matches, in source order", () => {
    const source = [
      "impl LocalModelName {",
      "    fn from_str(model_name: &str) -> Option<Self> {",
      "        match model_name.to_lowercase().as_str() {",
      '            "qdrant/bm25" => Some(LocalModelName::Bm25),',
      '            "bm25" => Some(LocalModelName::Bm25),',
      "            _ => None,",
      "        }",
      "    }",
      "}",
    ].join("\n");
    expect(localModelNames(source)).toEqual(["qdrant/bm25", "bm25"]);
  });

  test("refuses a source with no from_str, or one that matches no name", () => {
    expect(() => localModelNames("fn other() {}")).toThrow("local_model.rs holds no LocalModelName::from_str");
    expect(() => localModelNames("    fn from_str() {\n        _ => None,\n    }\n")).toThrow(
      "LocalModelName::from_str matches no model name",
    );
  });
});

describe("the committed file", () => {
  const facts = JSON.parse(
    readFileSync(join(import.meta.dir, "..", "..", "..", "fixtures", "qdrant", "openapi-schemas.json"), "utf8"),
  ) as QdrantOpenApiFacts;

  test("names its generator and both pinned sources by sha256", () => {
    expect(facts.$generated).toEqual({
      by: "tests/live/qdrant-openapi.ts",
      source: "github.com/qdrant/qdrant docs/redoc/master/openapi.json at tag v1.19.1",
      sha256: QDRANT_SPEC_SHA256,
      localModelSource: "github.com/qdrant/qdrant src/common/inference/local_model.rs at tag v1.19.1",
      localModelSha256: QDRANT_LOCAL_MODEL_SHA256,
    });
  });

  test("holds the 17 operations and the two local model names", () => {
    expect(Object.keys(facts.operations)).toEqual([...QDRANT_V1_OPERATIONS]);
    expect(facts.localModels).toEqual(["qdrant/bm25", "bm25"]);
  });
});
