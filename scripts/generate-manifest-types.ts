#!/usr/bin/env bun
/**
 * Writes packages/provider-sdk/src/manifest/manifest-types.generated.ts, the TypeScript types of the provider manifest,
 * from packages/provider-sdk/src/manifest/manifest.schema.json (docs/providers/CONTRACT.md, clause M-2), and
 * packages/provider-sdk/src/manifest/manifest-schema.generated.ts, the schema's text as a module.
 *
 * The schema is the one statement of the manifest: the types are rendered from it and never written by hand, and the
 * generated module also carries `MANIFEST_SCHEMA_SHA256`, the digest `compileManifestValidator` loads the schema by.
 * tests/unit/provider-sdk/manifest-types.test.ts renders the types in memory and fails on any byte of difference.
 *
 * The renderer reads a closed subset of JSON Schema 2020-12 and refuses every other keyword by name and JSON Pointer,
 * so the types can never be wider than the schema:
 * - at the root only: `$schema`, `$id`, `$defs`, and `title`, which names the root type;
 * - anywhere: `description` (a doc comment), `$ref` to `#/$defs/<name>` (the named type), `const` (a literal), `enum`
 *   (a union of literals), `oneOf` (a union, standing alone beside at most a description), `type` (one name, or one
 *   name and "null"), `properties`, `required`, `additionalProperties` (a boolean), `items`, and the bounds `minItems`,
 *   `maxItems`, `uniqueItems`, `minimum`, `maximum`, `minLength`, `maxLength` and `pattern`, which constrain values
 *   without changing their type.
 *
 * Every object schema with `properties` is the root or a `$defs` entry, so every interface has a name the schema gives
 * it: a `$defs` key in PascalCase. An object without `properties` must be open (`additionalProperties: true`) and
 * renders as a read-only record of unknown values.
 *
 * The schema text module, `MANIFEST_SCHEMA_TEXT`, holds the schema file's text, one string literal per line joined by
 * line feeds, so its UTF-8 bytes are the file's and `compileManifestValidator` admits them by `MANIFEST_SCHEMA_SHA256`.
 * A host that bundles its server, Studio's standalone Next.js server among them, reads the schema's bytes from it: a
 * bundler parses an import of the JSON file into an object, whose serialisation is not the file's bytes, and a read of
 * the file at run time depends on the bundler copying a file no module imports.
 *
 * Run: bun scripts/generate-manifest-types.ts --write | --check [--out <file>] [--schema-out <file>]
 * --write writes both modules, --check exits 1 when either file differs from what the schema renders (an absent file
 * included), and --out names another file for the types, --schema-out for the schema text, each at most once, in
 * either order, resolved against the working directory.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The schema's path in the repository. */
export const MANIFEST_SCHEMA_FILE = "packages/provider-sdk/src/manifest/manifest.schema.json";

/** The generated module's path in the repository. */
export const MANIFEST_TYPES_FILE = "packages/provider-sdk/src/manifest/manifest-types.generated.ts";

/** The generated schema text module's path in the repository. */
export const MANIFEST_SCHEMA_TEXT_FILE = "packages/provider-sdk/src/manifest/manifest-schema.generated.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const WRITE_COMMAND = "bun run manifest:types";
const USAGE = "Usage: bun scripts/generate-manifest-types.ts --write | --check [--out <file>] [--schema-out <file>]";
const LINE_WIDTH = 120;

const ROOT_KEYWORDS = new Set(["$schema", "$id", "$defs", "title"]);
const KEYWORDS = new Set([
  "description",
  "$ref",
  "const",
  "enum",
  "oneOf",
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "pattern",
]);
const SCALAR_TYPES: Readonly<Record<string, string>> = {
  string: "string",
  integer: "number",
  number: "number",
  boolean: "boolean",
  null: "null",
};

type Schema = Record<string, unknown>;

function isSchema(value: unknown): value is Schema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A `$defs` key as a type name: `engineDeclaration` is `EngineDeclaration`. */
function typeName(key: string): string {
  return `${key.charAt(0).toUpperCase()}${key.slice(1)}`;
}

/**
 * A JSON value as a TypeScript literal. A string is quoted as the repository's formatter writes it: in double quotes,
 * or in single quotes where it holds more double quotes than single ones, so fewer of them are escaped.
 */
function literal(value: unknown): string {
  const json = JSON.stringify(value);
  if (typeof value !== "string") return json;
  const doubles = value.split('"').length - 1;
  const singles = value.split("'").length - 1;
  if (doubles <= singles) return json;
  return `'${json.slice(1, -1).replaceAll('\\"', '"').replaceAll("'", "\\'")}'`;
}

/** A property key as TypeScript writes it: bare when it is an identifier, quoted otherwise. */
function memberKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function docComment(schema: Schema, indent: string): string {
  return typeof schema.description === "string" ? `${indent}/** ${schema.description} */\n` : "";
}

/** The type names a schema's `type` gives: one name, or one name and "null". */
function typeList(schema: Schema, pointer: string): string[] | undefined {
  const type = schema.type;
  if (type === undefined) return undefined;
  if (typeof type === "string") return [type];
  if (
    Array.isArray(type) &&
    type.length === 2 &&
    type[1] === "null" &&
    typeof type[0] === "string" &&
    type[0] !== "null"
  ) {
    return type as string[];
  }
  throw new Error(`${pointer}: a type list must be one type name and "null"`);
}

class Renderer {
  private readonly defs: Schema;

  constructor(private readonly root: Schema) {
    this.defs = isSchema(root.$defs) ? root.$defs : {};
  }

  /** Refuses any keyword outside the subset, anywhere in the document. */
  checkKeywords(schema: Schema, pointer: string, isRoot: boolean): void {
    for (const [keyword, value] of Object.entries(schema)) {
      if (!(KEYWORDS.has(keyword) || (isRoot && ROOT_KEYWORDS.has(keyword)))) {
        throw new Error(
          `${pointer}: the keyword "${keyword}" is outside the subset scripts/generate-manifest-types.ts reads`,
        );
      }
      if (keyword === "description" && typeof value === "string" && value.includes("*/")) {
        throw new Error(
          `${pointer}: the description holds "*/", which would end its doc comment in the generated module`,
        );
      }
      if (keyword === "properties" || keyword === "$defs") {
        for (const [name, member] of Object.entries(value as Schema)) {
          this.checkKeywords(member as Schema, `${pointer}/${keyword}/${name}`, false);
        }
      }
      if (keyword === "items") this.checkKeywords(value as Schema, `${pointer}/items`, false);
      if (keyword === "oneOf") {
        (value as Schema[]).forEach((branch, index) => this.checkKeywords(branch, `${pointer}/oneOf/${index}`, false));
        const others = Object.keys(schema).filter((other) => other !== "oneOf" && other !== "description");
        if (others.length > 0) throw new Error(`${pointer}: oneOf stands alone, beside at most a description`);
      }
    }
  }

  /** The type expression of a schema that is not a named object. */
  expression(schema: Schema, pointer: string): string {
    if (typeof schema.$ref === "string") {
      const match = /^#\/\$defs\/([A-Za-z][A-Za-z0-9]*)$/.exec(schema.$ref);
      if (match === null || !Object.hasOwn(this.defs, match[1] as string)) {
        throw new Error(`${pointer}: the reference "${schema.$ref}" names no definition of this document's $defs`);
      }
      return typeName(match[1] as string);
    }
    if ("const" in schema) return literal(schema.const);
    if (Array.isArray(schema.enum)) return schema.enum.map(literal).join(" | ");
    if (Array.isArray(schema.oneOf)) {
      return schema.oneOf
        .map((branch, index) => this.expression(branch as Schema, `${pointer}/oneOf/${index}`))
        .join(" | ");
    }
    const types = typeList(schema, pointer);
    if (types === undefined) throw new Error(`${pointer}: a schema with no $ref, const, enum, oneOf or type`);
    const [type, nullable] = types as [string, string | undefined];
    const base = this.typeExpression(schema, type, pointer);
    return nullable === undefined ? base : `${base} | null`;
  }

  private typeExpression(schema: Schema, type: string, pointer: string): string {
    const scalar = SCALAR_TYPES[type];
    if (scalar !== undefined) return scalar;
    if (type === "array") {
      if (!isSchema(schema.items)) throw new Error(`${pointer}: an array schema with no items`);
      const items = this.expression(schema.items, `${pointer}/items`);
      return `readonly ${items.includes(" | ") ? `(${items})` : items}[]`;
    }
    if (type === "object") {
      if (schema.properties !== undefined) {
        throw new Error(`${pointer}: an object schema with properties must be a $defs entry, so its type has a name`);
      }
      if (schema.additionalProperties !== true) {
        throw new Error(`${pointer}: an object schema with no properties must set additionalProperties to true`);
      }
      return "Readonly<Record<string, unknown>>";
    }
    throw new Error(`${pointer}: the type "${type}" is not a JSON Schema type name`);
  }

  /** The members of an object schema with properties, one per line, each with its doc comment. */
  private members(schema: Schema, pointer: string): string {
    const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
    let body = "";
    for (const [key, member] of Object.entries(schema.properties as Schema)) {
      const memberSchema = member as Schema;
      const optional = required.has(key) ? "" : "?";
      body += docComment(memberSchema, "  ");
      body += `  readonly ${memberKey(key)}${optional}: ${this.expression(memberSchema, `${pointer}/properties/${key}`)};\n`;
    }
    if (schema.additionalProperties === true) body += "  readonly [key: string]: unknown;\n";
    else if (schema.additionalProperties !== false) {
      throw new Error(`${pointer}: an object schema with properties sets additionalProperties to true or false`);
    }
    return body;
  }

  /** One named declaration: an interface for a closed or open object, a type alias for everything else. */
  declaration(name: string, schema: Schema, pointer: string): string {
    const comment = docComment(schema, "");
    if (isSchema(schema.properties)) {
      const types = typeList(schema, pointer);
      const body = this.members(schema, pointer);
      if (types?.[0] !== "object") throw new Error(`${pointer}: a schema with properties has the type "object"`);
      return types[1] === "null"
        ? `${comment}export type ${name} = {\n${body}} | null;\n`
        : `${comment}export interface ${name} {\n${body}}\n`;
    }
    const expression = this.expression(schema, pointer);
    const oneLine = `export type ${name} = ${expression};`;
    if (oneLine.length <= LINE_WIDTH || !expression.includes(" | ")) return `${comment}${oneLine}\n`;
    const members = expression.split(" | ").map((member) => `  | ${member}`);
    return `${comment}export type ${name} =\n${members.join("\n")};\n`;
  }
}

/** The generated module for a schema text: its header, the digest of the text's bytes, and every declaration. */
export function renderManifestTypes(schemaText: string): string {
  const root = JSON.parse(schemaText) as Schema;
  if (typeof root.title !== "string") throw new Error("the root schema has no title to name its type by");
  const renderer = new Renderer(root);
  renderer.checkKeywords(root, "", true);
  const digest = createHash("sha256").update(Buffer.from(schemaText, "utf8")).digest("hex");
  const declarations = [renderer.declaration(root.title, root, "")];
  for (const [key, schema] of Object.entries(isSchema(root.$defs) ? root.$defs : {})) {
    declarations.push(renderer.declaration(typeName(key), schema as Schema, `/$defs/${key}`));
  }
  return [
    `// GENERATED FILE - do not edit. Run: ${WRITE_COMMAND}\n//\n// Source: ${MANIFEST_SCHEMA_FILE}, via\n// scripts/generate-manifest-types.ts. tests/unit/provider-sdk/manifest-types.test.ts fails on drift.\n`,
    `/** The SHA-256 of the schema file's bytes: \`compileManifestValidator\` refuses a schema with any other. */\nexport const MANIFEST_SCHEMA_SHA256 = "${digest}";\n`,
    ...declarations,
  ].join("\n");
}

/**
 * The generated schema text module for a schema text: its header and `MANIFEST_SCHEMA_TEXT`, one string literal per
 * line of the text, in the formatter's quotes, joined by line feeds, so the constant is the text exactly.
 */
export function renderManifestSchemaText(schemaText: string): string {
  const lines = schemaText.split("\n").map((line) => `  ${literal(line)},`);
  return [
    `// GENERATED FILE - do not edit. Run: ${WRITE_COMMAND}\n//\n// Source: ${MANIFEST_SCHEMA_FILE}, via\n// scripts/generate-manifest-types.ts. tests/unit/provider-sdk/manifest-types.test.ts fails on drift.\n`,
    "/**",
    " * The schema file's text, line for line: its UTF-8 bytes are the file's, so `compileManifestValidator` admits them by",
    " * `MANIFEST_SCHEMA_SHA256`. A host that bundles its code reads the schema's bytes here, since a bundler parses an",
    " * import of the JSON file into an object whose serialisation is not the file's bytes.",
    " */",
    "export const MANIFEST_SCHEMA_TEXT = [",
    ...lines,
    '].join("\\n");',
    "",
  ].join("\n");
}

/** The file contents, or null when there is no file: absent and stale have the same fix. */
function readOrNull(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The command line's options: the mode, and the types and schema text files when another than the repository's. */
interface Arguments {
  readonly mode: "--write" | "--check";
  readonly out: string | undefined;
  readonly schemaOut: string | undefined;
}

/**
 * The command line, exactly `--write` or `--check`, optionally followed by `--out <file>` and `--schema-out <file>`,
 * each at most once, in either order; null for anything else, which the command refuses with its usage line, so a
 * mistyped flag never rewrites a committed module.
 */
function parseArguments(argv: readonly string[]): Arguments | null {
  const [mode, ...rest] = argv;
  if (mode !== "--write" && mode !== "--check") return null;
  const files = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index] as string;
    const file = rest[index + 1];
    if ((flag !== "--out" && flag !== "--schema-out") || files.has(flag)) return null;
    if (file === undefined || file.startsWith("--")) return null;
    files.set(flag, file);
  }
  return { mode, out: files.get("--out"), schemaOut: files.get("--schema-out") };
}

function main(argv: readonly string[]): number {
  const parsed = parseArguments(argv);
  if (parsed === null) {
    console.error(USAGE);
    return 2;
  }
  const { mode, out, schemaOut } = parsed;
  const schemaText = readFileSync(path.join(REPO_ROOT, MANIFEST_SCHEMA_FILE), "utf8");
  const outputs = [
    {
      target: out === undefined ? path.join(REPO_ROOT, MANIFEST_TYPES_FILE) : path.resolve(out),
      next: renderManifestTypes(schemaText),
    },
    {
      target: schemaOut === undefined ? path.join(REPO_ROOT, MANIFEST_SCHEMA_TEXT_FILE) : path.resolve(schemaOut),
      next: renderManifestSchemaText(schemaText),
    },
  ];
  if (mode === "--check") {
    let current = true;
    for (const { target, next } of outputs) {
      if (readOrNull(target) !== next) {
        console.error(`${target} is not what the manifest schema renders; run: ${WRITE_COMMAND}`);
        current = false;
      } else {
        console.log(`${target} is up to date`);
      }
    }
    return current ? 0 : 1;
  }
  for (const { target, next } of outputs) {
    writeFileSync(target, next);
    console.log(`Wrote ${target}`);
  }
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
