/**
 * The drift test of spec 6.4 (QE10, QE11, QE21): routes.ts against tests/fixtures/qdrant/openapi-schemas.json,
 * which tests/live/qdrant-openapi.ts writes from the OpenAPI document saved at tag v1.19.1, pinned by its SHA-256
 * and never by `info.version`, which reads `master`, and from the server's local_model.rs at the same tag.
 *
 * The table's operations, templates, query keys, body kinds and required keys equal the document's; every closed
 * key set equals the document's for that schema; every union and enumeration the request rules walk equals the
 * document's; and the local model names equal the server's.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  QDRANT_ENUMS,
  QDRANT_KEYS,
  QDRANT_KEYS_NOT_WALKED,
  QDRANT_LOCAL_MODELS,
  QDRANT_QUERY_ALIAS,
  QDRANT_ROUTES,
  QDRANT_UNIONS,
} from "@/lib/db/providers/vector/qdrant/routes";
import { QDRANT_LOCAL_MODEL_SHA256, type QdrantOpenApiFacts } from "../../../live/qdrant-openapi-derive";
import { QDRANT_SPEC_SHA256 } from "../../../live/vector-route-tables";

/** A list as plain strings, so a typed table and the document's words compare as lists. */
const words = (list: readonly string[]): string[] => [...list];

const facts = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "..", "fixtures", "qdrant", "openapi-schemas.json"), "utf8"),
) as QdrantOpenApiFacts;

describe("the pinned sources", () => {
  test("the facts were written from the OpenAPI document of tag v1.19.1 and its local_model.rs, by SHA-256", () => {
    expect(facts.$generated.sha256).toBe("eb3e5d71ba74e1d99124ca1a77d563bbfa47084f04a13ef9b197e339f5a4ce0a");
    expect(facts.$generated.sha256).toBe(QDRANT_SPEC_SHA256);
    expect(facts.$generated.source).toContain("at tag v1.19.1");
    expect(facts.$generated.localModelSha256).toBe(QDRANT_LOCAL_MODEL_SHA256);
  });
});

describe("the route table against the document", () => {
  test("every operation's method, path, query keys, body schema, body kind and required keys", () => {
    for (const route of QDRANT_ROUTES) {
      const document = facts.operations[route.op];
      expect(document, route.op).toBeDefined();
      const required = route.schema === null ? [] : [...QDRANT_KEYS[route.schema].required];
      expect(
        {
          method: route.method,
          path: `/${route.template}`,
          query: Object.keys(route.query),
          bodySchema: route.schema as string | null,
          required: required as readonly string[],
        },
        route.op,
      ).toEqual({
        method: document.method,
        path: document.path,
        query: [...document.query],
        bodySchema: document.bodySchema,
        required: document.required,
      });
      const kind = document.bodySchema === null ? "none" : document.required.length > 0 ? "required" : "optional";
      expect(route.body, route.op).toBe(kind);
    }
    expect(words(QDRANT_ROUTES.map((route) => route.op)).sort()).toEqual(Object.keys(facts.operations).sort());
  });
});

describe("the closed key sets against the document", () => {
  test("every object a v1 body reaches is closed by exactly the document's keys and required keys", () => {
    const walked = Object.fromEntries(
      Object.entries(facts.objects).filter(([name]) => !QDRANT_KEYS_NOT_WALKED.includes(name)),
    );
    expect(JSON.parse(JSON.stringify(QDRANT_KEYS))).toEqual(walked);
  });

  test("the objects no request walks sit only under an inference input's options, which a request never holds", () => {
    for (const name of QDRANT_KEYS_NOT_WALKED) expect(facts.objects[name], name).toBeDefined();
    expect(facts.unions.DocumentOptions).toEqual(["object", "Bm25Config"]);
  });

  test("the one alias the request rules accept is not a key of the document, and its key is", () => {
    expect(QDRANT_KEYS.QueryRequest.keys).not.toContain(QDRANT_QUERY_ALIAS.alias);
    expect(QDRANT_KEYS.QueryRequest.keys).toContain(QDRANT_QUERY_ALIAS.key);
  });
});

describe("the unions and enumerations against the document", () => {
  test("Condition, Match and Query hold exactly the document's members, in its order", () => {
    expect(words(QDRANT_UNIONS.Condition)).toEqual(words(facts.unions.Condition));
    expect(words(QDRANT_UNIONS.Match)).toEqual(words(facts.unions.Match));
    expect(words(QDRANT_UNIONS.Query)).toEqual(words(facts.unions.Query));
  });

  test("Expression holds every object member of the document's, in its order; a number, a string and a condition are read apart", () => {
    expect(words(QDRANT_UNIONS.Expression)).toEqual(
      facts.unions.Expression.filter((member) => Object.hasOwn(facts.objects, member)),
    );
    expect(facts.unions.Expression.filter((member) => !Object.hasOwn(facts.objects, member))).toEqual([
      "number (float)",
      "string",
      "Condition",
    ]);
  });

  test("every enumeration a request names takes exactly the document's words", () => {
    for (const [name, list] of Object.entries(QDRANT_ENUMS))
      expect(words(list), name).toEqual(words(facts.enums[name]));
  });

  test("the local models are exactly the names the server's local_model.rs runs itself", () => {
    expect(words(QDRANT_LOCAL_MODELS)).toEqual(words(facts.localModels));
  });
});
