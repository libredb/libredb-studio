/**
 * The manifest schema is closed (docs/providers/CONTRACT.md, clauses M-3 and M-6): every object it defines refuses a
 * key it does not name, except `vendor`, which is the package's own, and the envelope, which a host reads before it
 * knows which schema applies. The two fixtures are the smallest manifest a third-party package writes and one shaped
 * like the Kafka provider's.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { compileManifestValidator } from "@libredb/provider-sdk/manifest";

const SCHEMA_BYTES = readFileSync(path.join(import.meta.dir, "../../src/manifest/manifest.schema.json"));
const SCHEMA = JSON.parse(SCHEMA_BYTES.toString("utf8")) as unknown;
const validator = compileManifestValidator(SCHEMA_BYTES);

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(import.meta.dir, "../fixtures", name), "utf8")) as Record<string, unknown>;
}

/** Every object schema in the document, by JSON Pointer, with its `additionalProperties`. */
function objectSchemas(node: unknown, pointer: string, found: Map<string, unknown>): Map<string, unknown> {
  if (Array.isArray(node)) {
    node.forEach((item, index) => objectSchemas(item, `${pointer}/${index}`, found));
    return found;
  }
  if (typeof node !== "object" || node === null) return found;
  const schema = node as Record<string, unknown>;
  const type = schema.type;
  if (type === "object" || (Array.isArray(type) && type.includes("object"))) {
    found.set(pointer, schema.additionalProperties);
  }
  for (const keyword of ["properties", "$defs"]) {
    const members = schema[keyword];
    if (typeof members === "object" && members !== null) {
      for (const [name, member] of Object.entries(members))
        objectSchemas(member, `${pointer}/${keyword}/${name}`, found);
    }
  }
  if (schema.items !== undefined) objectSchemas(schema.items, `${pointer}/items`, found);
  if (schema.oneOf !== undefined) objectSchemas(schema.oneOf, `${pointer}/oneOf`, found);
  return found;
}

describe("the manifest schema", () => {
  test("every object schema is closed except vendor and the envelope", () => {
    const objects = objectSchemas(SCHEMA, "", new Map());
    const open = [...objects].filter(([, additional]) => additional !== false).map(([pointer]) => pointer);

    expect(objects.size).toBeGreaterThan(20);
    expect(open).toEqual(["/properties/vendor", "/$defs/envelope"]);
    expect(objects.get("/properties/vendor")).toBe(true);
    expect(objects.get("/$defs/envelope")).toBe(true);
  });

  test("the minimal manifest is admitted", () => {
    const manifest = fixture("minimal-manifest.json");

    expect<unknown>(validator.validate(manifest)).toEqual({ admitted: true, manifest });
  });

  test("a Kafka-shaped manifest is admitted", () => {
    const manifest = fixture("kafka-manifest.json");

    expect<unknown>(validator.validate(manifest)).toEqual({ admitted: true, manifest });
  });

  test("package, name, version and publisher are unknown keys", () => {
    const manifest = {
      ...fixture("minimal-manifest.json"),
      package: { name: "@acme/provider-exampledb" },
      name: "@acme/provider-exampledb",
      version: "1.0.0",
      publisher: "acme",
    };

    expect(validator.validate(manifest)).toEqual({
      admitted: false,
      refusals: ["name", "package", "publisher", "version"].map((key) => ({
        code: "PROVIDER_SCHEMA_INVALID",
        rule: "unknown-key",
        pointer: "",
        key,
      })),
    });
  });
});
