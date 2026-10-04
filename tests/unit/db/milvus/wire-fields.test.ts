/**
 * The seam's wire types against the descriptor (vector-family spec 5.1).
 *
 * `client.ts` types every message the adapter sends and reads as an interface named `Wire` plus the descriptor's
 * message name. This file holds each declared property to that message's fields, or its oneof names: a field name
 * misspelled, a 64-bit integer typed as a number, a message typed as the wrong one, or a repeated field typed as one
 * value fails here instead of reading `undefined`. It also holds that no public request type carries `db_name`: the
 * database has one source, `CallOptions.db` (E16). It reads both files as text and imports neither: only the adapter
 * imports the descriptor.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const MILVUS_DIR = path.join(ROOT, "src", "lib", "db", "providers", "vector", "milvus");
const CLIENT_FILE = path.join(MILVUS_DIR, "client.ts");
const DESCRIPTOR_FILE = path.join(MILVUS_DIR, "proto", "descriptor.ts");

interface DescriptorField {
  readonly type: string;
  readonly rule?: string;
  readonly keyType?: string;
}
interface DescriptorType {
  readonly fields?: Readonly<Record<string, DescriptorField>>;
  readonly oneofs?: Readonly<Record<string, unknown>>;
  readonly values?: Readonly<Record<string, number>>;
  readonly nested?: Readonly<Record<string, DescriptorType>>;
}

function readDescriptor(): Readonly<Record<string, DescriptorType>> {
  const text = readFileSync(DESCRIPTOR_FILE, "utf8");
  const source = ts.createSourceFile(DESCRIPTOR_FILE, text, ts.ScriptTarget.Latest, true);
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const [declaration] = statement.declarationList.declarations;
    const initializer = declaration.initializer;
    if (
      declaration.name.getText(source) !== "MILVUS_DESCRIPTOR" ||
      initializer === undefined ||
      !ts.isAsExpression(initializer)
    ) {
      continue;
    }
    const root = JSON.parse(initializer.expression.getText(source)) as {
      nested: { milvus: { nested: { proto: DescriptorType } } };
    };
    return root.nested.milvus.nested.proto.nested ?? {};
  }
  throw new Error("proto/descriptor.ts declares no MILVUS_DESCRIPTOR");
}

const PACKAGES = readDescriptor();

/** The one message of that name across milvus, common and schema, or undefined when none holds it or two do. */
function message(name: string): { readonly qualified: string; readonly type: DescriptorType } | undefined {
  const holders = Object.entries(PACKAGES).filter(([, pkg]) => pkg.nested?.[name]?.fields !== undefined);
  if (holders.length !== 1) return undefined;
  const [pkg, holder] = holders[0];
  return { qualified: `${pkg}.${name}`, type: holder.nested?.[name] as DescriptorType };
}

function isEnum(typeName: string): boolean {
  const last = typeName.split(".").at(-1) as string;
  return Object.values(PACKAGES).some((pkg) => pkg.nested?.[last]?.values !== undefined);
}

const SIXTY_FOUR = new Set(["int64", "uint64", "sint64", "fixed64", "sfixed64"]);
const NUMBERS = new Set(["int32", "uint32", "sint32", "fixed32", "sfixed32", "float", "double"]);

/** What a field's declared TypeScript type must be, as MILVUS_LOADER_OPTIONS decodes it. */
function expectedType(field: DescriptorField): string {
  if (field.keyType !== undefined) return "map";
  if (SIXTY_FOUR.has(field.type)) return "string";
  if (NUMBERS.has(field.type)) return "number";
  if (field.type === "bool") return "boolean";
  if (field.type === "string") return "string";
  if (field.type === "bytes") return "Uint8Array";
  if (isEnum(field.type)) return "enum";
  return `Wire${field.type.split(".").at(-1)}`;
}

/** A declared type reduced to its base: readonly, `| null` and `[]` removed, `Omit<X, ...>` read as X. */
function baseOf(text: string): { readonly base: string; readonly array: boolean } {
  let base = text
    .replace(/\breadonly\s+/g, "")
    .replace(/\s*\|\s*null\b/, "")
    .trim();
  const array = base.endsWith("[]");
  if (array) base = base.slice(0, -2).trim();
  const omitted = /^Omit<(\w+),/.exec(base);
  if (omitted !== null) base = omitted[1];
  if (/^MilvusInt64$/.test(base)) base = "string";
  if (/^"[^"]*"(\s*\|\s*"[^"]*")*$/.test(base)) base = "string";
  return { base, array };
}

interface WireInterface {
  readonly name: string;
  readonly properties: ReadonlyArray<{ readonly name: string; readonly type: string }>;
}

function wireInterfaces(): WireInterface[] {
  const text = readFileSync(CLIENT_FILE, "utf8");
  const source = ts.createSourceFile(CLIENT_FILE, text, ts.ScriptTarget.Latest, true);
  return source.statements
    .filter(
      (statement): statement is ts.InterfaceDeclaration =>
        ts.isInterfaceDeclaration(statement) && statement.name.text.startsWith("Wire"),
    )
    .map((declaration) => ({
      name: declaration.name.text,
      properties: declaration.members
        .filter(ts.isPropertySignature)
        .map((member) => ({ name: member.name.getText(source), type: member.type?.getText(source) ?? "" })),
    }));
}

function requestAliases(): Array<{ readonly name: string; readonly text: string }> {
  const text = readFileSync(CLIENT_FILE, "utf8");
  const source = ts.createSourceFile(CLIENT_FILE, text, ts.ScriptTarget.Latest, true);
  return source.statements
    .filter(
      (statement): statement is ts.TypeAliasDeclaration =>
        ts.isTypeAliasDeclaration(statement) && statement.name.text.endsWith("Request"),
    )
    .map((alias) => ({ name: alias.name.text, text: alias.type.getText(source) }));
}

describe("every Wire interface of client.ts is a descriptor message, field for field", () => {
  const interfaces = wireInterfaces();

  test("there are wire interfaces to check", () => {
    expect(interfaces.length).toBeGreaterThan(40);
  });

  test.each(interfaces.map((wire) => [wire.name, wire] as const))("%s", (_name, wire) => {
    const found = message(wire.name.slice("Wire".length));
    expect({ interface: wire.name, message: found?.qualified ?? "none" }).not.toEqual({
      interface: wire.name,
      message: "none",
    });
    const fields = found?.type.fields ?? {};
    const oneofs = Object.keys(found?.type.oneofs ?? {});
    for (const property of wire.properties) {
      if (oneofs.includes(property.name) && !(property.name in fields)) {
        expect({ property: property.name, type: property.type }).toEqual({ property: property.name, type: "string" });
        continue;
      }
      const field = fields[property.name];
      expect({ property: property.name, declared: field !== undefined }).toEqual({
        property: property.name,
        declared: true,
      });
      if (field === undefined) continue;
      const expected = expectedType(field);
      const { base, array } = baseOf(property.type);
      if (expected === "map") {
        expect({ property: property.name, map: property.type.startsWith("Readonly<Record<string,") }).toEqual({
          property: property.name,
          map: true,
        });
        continue;
      }
      expect({ property: property.name, repeated: array }).toEqual({
        property: property.name,
        repeated: field.rule === "repeated",
      });
      expect({ property: property.name, type: base }).toEqual({
        property: property.name,
        type: expected === "enum" ? "string" : expected,
      });
    }
  });
});

describe("the public request types (E16)", () => {
  test('every one is Omit<Wire...Request, "db_name">, and its wire message has a db_name field', () => {
    const aliases = requestAliases();
    expect(aliases.length).toBe(15);
    for (const alias of aliases) {
      expect({ alias: alias.name, text: alias.text }).toEqual({
        alias: alias.name,
        text: `Omit<Wire${alias.name}, "db_name">`,
      });
      expect({ alias: alias.name, hasDbName: message(alias.name)?.type.fields?.db_name !== undefined }).toEqual({
        alias: alias.name,
        hasDbName: true,
      });
    }
  });

  test("a hybrid search's sub-requests carry no db_name of their own", () => {
    const hybrid = wireInterfaces().find((wire) => wire.name === "WireHybridSearchRequest");
    expect(hybrid?.properties.find((property) => property.name === "requests")?.type).toBe(
      'readonly Omit<WireSearchRequest, "db_name">[]',
    );
  });

  test("no request type can carry a function score, a function chain, an aggregation, a highlighter, a namespace or a refresh", () => {
    const forbidden = [
      "function_score",
      "function_chains",
      "search_aggregation",
      "highlighter",
      "namespace",
      "refresh",
      "replica_number",
      "load_params",
    ];
    for (const wire of wireInterfaces().filter((candidate) => candidate.name.endsWith("Request"))) {
      for (const property of wire.properties)
        expect({ wire: wire.name, property: property.name, forbidden: forbidden.includes(property.name) }).toEqual({
          wire: wire.name,
          property: property.name,
          forbidden: false,
        });
    }
  });
});
