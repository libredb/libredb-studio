/**
 * The manifest's TypeScript types are generated from its schema (docs/providers/CONTRACT.md, clause M-2), so the
 * schema is the one statement of the manifest and the types can never say something it does not.
 *
 * `scripts/generate-manifest-types.ts` reads a closed subset of JSON Schema and refuses any other keyword by name, so
 * a schema change the generator cannot express fails here rather than producing a type that is wider than the schema.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MANIFEST_SCHEMA_SHA256 } from "@libredb/provider-sdk/manifest";
import { MANIFEST_SCHEMA_TEXT } from "@libredb/provider-sdk/manifest-schema";
import {
  MANIFEST_SCHEMA_FILE,
  MANIFEST_SCHEMA_TEXT_FILE,
  MANIFEST_TYPES_FILE,
  renderManifestSchemaText,
  renderManifestTypes,
} from "../../../scripts/generate-manifest-types";

const ROOT = path.resolve(import.meta.dir, "../../..");
const SCRIPT = path.join(ROOT, "scripts/generate-manifest-types.ts");
const SCHEMA_TEXT = readFileSync(path.join(ROOT, MANIFEST_SCHEMA_FILE), "utf8");

/** A schema document around `properties` and `$defs`, closed, named Root. */
function schema(properties: Record<string, unknown>, defs: Record<string, unknown> = {}, required: string[] = []) {
  return JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "urn:libredb:test:0.1",
    title: "Root",
    type: "object",
    properties,
    required,
    additionalProperties: false,
    $defs: defs,
  });
}

describe("the committed manifest types", () => {
  test("the generated manifest types are what the schema renders", () => {
    const committed = readFileSync(path.join(ROOT, MANIFEST_TYPES_FILE), "utf8");

    expect(committed === renderManifestTypes(SCHEMA_TEXT) ? "current" : "stale: run bun run manifest:types").toBe(
      "current",
    );
  });

  test("the header names the generator, the source file and the regenerate command", () => {
    const rendered = renderManifestTypes(SCHEMA_TEXT);

    expect(rendered.startsWith("// GENERATED FILE - do not edit. Run: bun run manifest:types\n")).toBe(true);
    expect(rendered).toContain(MANIFEST_SCHEMA_FILE);
    expect(rendered).toContain("scripts/generate-manifest-types.ts");
  });

  test("the digest it carries is the SHA-256 of the schema text's bytes", () => {
    const digest = createHash("sha256").update(Buffer.from(SCHEMA_TEXT, "utf8")).digest("hex");

    expect(renderManifestTypes(SCHEMA_TEXT)).toContain(`export const MANIFEST_SCHEMA_SHA256 = "${digest}";`);
  });

  test("--check passes on the committed file, fails on a stale one naming the command, and refuses other arguments", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "manifest-types-"));
    const run = (...args: string[]) =>
      Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    try {
      expect(run("--check").exitCode).toBe(0);

      const out = path.join(dir, "types.ts");
      expect(run("--write", "--out", out).exitCode).toBe(0);
      expect(readFileSync(out, "utf8")).toBe(renderManifestTypes(SCHEMA_TEXT));

      writeFileSync(out, "// stale\n");
      const stale = run("--check", "--out", out);
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr.toString()).toContain("bun run manifest:types");

      for (const args of [[], ["--check", "--write"], ["--write", "--out"], ["--check", "--verbose"]]) {
        const refused = run(...args);
        expect(refused.exitCode).toBe(2);
        expect(refused.stderr.toString()).toContain("Usage:");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the committed schema text module", () => {
  test("the schema text module is the schema's bytes, line for line, and its SHA-256 is MANIFEST_SCHEMA_SHA256", () => {
    const committed = readFileSync(path.join(ROOT, MANIFEST_SCHEMA_TEXT_FILE), "utf8");

    expect(committed === renderManifestSchemaText(SCHEMA_TEXT) ? "current" : "stale: run bun run manifest:types").toBe(
      "current",
    );
    expect(MANIFEST_SCHEMA_TEXT).toBe(SCHEMA_TEXT);
    const bytes = new TextEncoder().encode(MANIFEST_SCHEMA_TEXT);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(MANIFEST_SCHEMA_SHA256);
    // One string literal per schema line, so a schema change is a diff of the lines it changes.
    expect(committed.split("\n").length).toBeGreaterThan(SCHEMA_TEXT.split("\n").length);
    expect(committed.startsWith("// GENERATED FILE - do not edit. Run: bun run manifest:types\n")).toBe(true);
  });

  test("--check fails on a stale schema text module, naming the command", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "manifest-schema-text-"));
    const run = (...args: string[]) =>
      Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    try {
      const types = path.join(dir, "types.ts");
      const text = path.join(dir, "schema-text.ts");
      expect(run("--write", "--out", types, "--schema-out", text).exitCode).toBe(0);
      expect(readFileSync(text, "utf8")).toBe(renderManifestSchemaText(SCHEMA_TEXT));
      expect(run("--check", "--schema-out", text, "--out", types).exitCode).toBe(0);

      writeFileSync(text, "// stale\n");
      const stale = run("--check", "--out", types, "--schema-out", text);
      expect(stale.exitCode).toBe(1);
      expect(stale.stderr.toString()).toContain(
        `${text} is not what the manifest schema renders; run: bun run manifest:types`,
      );

      for (const args of [
        ["--check", "--schema-out"],
        ["--check", "--schema-out", text, "--schema-out", text],
      ]) {
        const refused = run(...args);
        expect(refused.exitCode).toBe(2);
        expect(refused.stderr.toString()).toContain("Usage:");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a schema line holding more double quotes than single ones renders in single quotes, as the formatter writes it", () => {
    const rendered = renderManifestSchemaText('{\n  "a": "it\'s",\n  "b": 1\n}\n');

    expect(rendered).toContain(
      `export const MANIFEST_SCHEMA_TEXT = [\n  "{",\n  '  "a": "it\\'s",',\n  '  "b": 1',\n  "}",\n  "",\n].join("\\n");\n`,
    );
  });
});

describe("rendering", () => {
  test("an enum renders a union of literals", () => {
    const rendered = renderManifestTypes(schema({}, { kind: { type: "string", enum: ["x", "y"] } }));

    expect(rendered).toContain('export type Kind = "x" | "y";\n');
  });

  test("a string literal holding more double quotes than single ones renders in single quotes, as the formatter writes it", () => {
    const quotes = ['"', "`", "it's", `a"b'c`, `"\\"`, null];
    const rendered = renderManifestTypes(schema({}, { quote: { type: ["string", "null"], enum: quotes } }));

    expect(rendered).toContain(`export type Quote = '"' | "\`" | "it's" | "a\\"b'c" | '"\\\\"' | null;\n`);
  });

  test("a union longer than a line renders one member per line", () => {
    const members = Array.from({ length: 12 }, (_, index) => `member-number-${index}`);
    const rendered = renderManifestTypes(schema({}, { kind: { type: "string", enum: members } }));

    expect(rendered).toContain(`export type Kind =\n${members.map((member) => `  | "${member}"`).join("\n")};\n`);
  });

  test("a const renders a literal, and a closed object a readonly interface with optional members outside required", () => {
    const rendered = renderManifestTypes(
      schema({ a: { const: "0.1" }, b: { type: "string" }, c: { type: "integer" }, d: { type: "boolean" } }, {}, [
        "a",
        "d",
      ]),
    );

    expect(rendered).toContain(
      'export interface Root {\n  readonly a: "0.1";\n  readonly b?: string;\n  readonly c?: number;\n  readonly d: boolean;\n}\n',
    );
  });

  test("items render a readonly array, $ref the named type and oneOf a union", () => {
    const rendered = renderManifestTypes(
      schema(
        { list: { type: "array", items: { $ref: "#/$defs/kind" } }, either: { $ref: "#/$defs/either" } },
        {
          kind: { type: "string", enum: ["x"] },
          either: { oneOf: [{ $ref: "#/$defs/kind" }, { type: "null" }] },
        },
        ["list", "either"],
      ),
    );

    expect(rendered).toContain("  readonly list: readonly Kind[];\n  readonly either: Either;\n");
    expect(rendered).toContain("export type Either = Kind | null;\n");
  });

  test("an array of a union wraps the union in parentheses", () => {
    const rendered = renderManifestTypes(
      schema({ list: { type: "array", items: { type: "string", enum: ["x", "y"] } } }, {}, ["list"]),
    );

    expect(rendered).toContain('  readonly list: readonly ("x" | "y")[];\n');
  });

  test("vendor renders a read-only string-keyed record of unknown", () => {
    const rendered = renderManifestTypes(schema({ vendor: { type: "object", additionalProperties: true } }));

    expect(rendered).toContain("  readonly vendor?: Readonly<Record<string, unknown>>;\n");
  });

  test("an open object renders an index signature, and a nullable one a type alias with null", () => {
    const rendered = renderManifestTypes(
      schema(
        {},
        {
          open: { type: "object", properties: { a: { type: "string" } }, required: ["a"], additionalProperties: true },
          maybe: {
            type: ["object", "null"],
            properties: { b: { type: ["string", "null"] } },
            required: ["b"],
            additionalProperties: false,
          },
        },
      ),
    );

    expect(rendered).toContain(
      "export interface Open {\n  readonly a: string;\n  readonly [key: string]: unknown;\n}\n",
    );
    expect(rendered).toContain("export type Maybe = {\n  readonly b: string | null;\n} | null;\n");
  });

  test("a description renders a doc comment above its declaration or member", () => {
    const rendered = renderManifestTypes(
      schema({ a: { description: "The a.", type: "string" } }, { kind: { description: "A kind.", const: "k" } }),
    );

    expect(rendered).toContain("  /** The a. */\n  readonly a?: string;\n");
    expect(rendered).toContain('/** A kind. */\nexport type Kind = "k";\n');
  });

  test("rendering refuses a keyword it does not read, naming it", () => {
    const text = schema({ a: { type: "string", format: "email" } });

    expect(() => renderManifestTypes(text)).toThrow('/properties/a: the keyword "format"');
  });

  test("rendering refuses a description that would end its doc comment, naming it", () => {
    const text = schema({ a: { type: "string", description: "Ends a comment */ early." } });

    expect(() => renderManifestTypes(text)).toThrow('/properties/a: the description holds "*/"');
  });

  test("rendering refuses an inline object schema with properties", () => {
    const text = schema({ a: { type: "object", properties: { b: { type: "string" } }, additionalProperties: false } });

    expect(() => renderManifestTypes(text)).toThrow("/properties/a: an object schema with properties");
  });

  test("rendering refuses a reference outside the document's $defs", () => {
    const text = schema({ a: { $ref: "https://example.com/other.json" } });

    expect(() => renderManifestTypes(text)).toThrow('/properties/a: the reference "https://example.com/other.json"');
  });

  test("rendering refuses a reference to a definition the document does not have", () => {
    expect(() => renderManifestTypes(schema({ a: { $ref: "#/$defs/missing" } }))).toThrow(
      '/properties/a: the reference "#/$defs/missing"',
    );
  });

  test("rendering refuses a oneOf beside another keyword", () => {
    const text = schema({ a: { type: "string", oneOf: [{ const: "x" }] } });

    expect(() => renderManifestTypes(text)).toThrow("/properties/a: oneOf stands alone");
  });

  test("rendering refuses a type list that is not one type and null", () => {
    expect(() => renderManifestTypes(schema({ a: { type: ["string", "integer"] } }))).toThrow(
      "/properties/a: a type list",
    );
  });

  test("rendering refuses an object schema with no properties that is not open", () => {
    expect(() => renderManifestTypes(schema({ a: { type: "object", additionalProperties: false } }))).toThrow(
      "/properties/a: an object schema with no properties",
    );
  });

  test("rendering refuses a root without a title", () => {
    const text = JSON.stringify({ type: "object", properties: {}, additionalProperties: false });

    expect(() => renderManifestTypes(text)).toThrow("the root schema has no title");
  });
});
