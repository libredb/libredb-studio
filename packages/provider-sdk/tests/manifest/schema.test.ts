/**
 * The manifest schema is closed (docs/providers/CONTRACT.md, clauses M-3 and M-6): every object it defines refuses a
 * key it does not name, except `vendor`, which is the package's own, and the envelope, which a host reads before it
 * knows which schema applies. The two fixtures are the smallest manifest a third-party package writes and one shaped
 * like the Kafka provider's.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { compileManifestValidator } from "@libredb/provider-sdk/manifest";

const SCHEMA_BYTES = readFileSync(path.join(import.meta.dir, "../../src/manifest/manifest.schema.json"));
const SCHEMA = JSON.parse(SCHEMA_BYTES.toString("utf8")) as unknown;
const validator = compileManifestValidator(SCHEMA_BYTES);

/**
 * Engine ids as the isolation ratchet defines them (scripts/isolation-ratchet.ts): the base name of every legacy
 * declaration under src/lib/db/engine-declarations/ and the id of every packages/provider-<id>/ directory but the SDK's.
 * The leg reads Studio's tree from the repository root; when the SDK leaves this repository it is dropped, since the
 * ratchet's `nonEnginePackages` counter holds the same rule.
 */
function engineIds(): Set<string> {
  const root = path.join(import.meta.dir, "../../../..");
  const declarations = readdirSync(path.join(root, "src/lib/db/engine-declarations"))
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length));
  const packaged = readdirSync(path.join(root, "packages"))
    .filter((directory) => directory.startsWith("provider-") && directory !== "provider-sdk")
    .map((directory) => directory.slice("provider-".length));
  return new Set([...declarations, ...packaged]);
}

/** Every `enum` value in the document, by the JSON Pointer of the schema that states it. */
function enumValues(node: unknown, pointer: string, found: [string, unknown][]): [string, unknown][] {
  if (Array.isArray(node)) {
    node.forEach((item, index) => enumValues(item, `${pointer}/${index}`, found));
    return found;
  }
  if (typeof node !== "object" || node === null) return found;
  for (const [key, member] of Object.entries(node)) {
    if (key === "enum" && Array.isArray(member)) for (const value of member) found.push([pointer, value]);
    else enumValues(member, `${pointer}/${key}`, found);
  }
  return found;
}

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

  test("the engine list is bounded at 64, and each facet list by the size of its vocabulary", () => {
    const schema = SCHEMA as {
      properties: { engines: { maxItems?: unknown } };
      $defs: Record<string, { enum?: unknown[]; properties?: Record<string, { maxItems?: unknown }> }>;
    };
    const facets = schema.$defs.facets?.properties ?? {};

    expect(schema.properties.engines.maxItems).toBe(64);
    expect(schema.$defs.maintenanceOperation?.enum).toHaveLength(11);
    expect(facets.maintenance?.maxItems).toBe(schema.$defs.maintenanceOperation?.enum?.length);
    expect(schema.$defs.agentReading?.enum).toHaveLength(6);
    expect(facets.agentReadings?.maxItems).toBe(schema.$defs.agentReading?.enum?.length);
  });

  test("the manifest schema names no engine id: every editor name is a form, and no enum value is an engine id", () => {
    const defs = (SCHEMA as { $defs: Record<string, Record<string, unknown>> }).$defs;
    const names = ["explainFormat", "queryDialect", "queryLanguage", "monacoLanguageId", "formatterLanguage"];
    const forms = names.map((name) => [name, typeof defs[name]?.pattern, defs[name]?.enum]);
    const ids = engineIds();
    const naming = enumValues(SCHEMA, "", []).filter(([, value]) => typeof value === "string" && ids.has(value));

    expect(ids.size).toBeGreaterThan(40);
    expect(forms).toEqual(names.map((name) => [name, "string", undefined]));
    expect(naming).toEqual([]);
  });
});
