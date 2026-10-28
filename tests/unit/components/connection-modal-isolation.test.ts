/**
 * The connection dialog knows no engine and no engine-specific field. `ConnectionModal.tsx` draws the engine-agnostic
 * layout (the name, the address row, the SSL / TLS and SSH panels) and maps every other field through the descriptor
 * registry in src/lib/db/connection-fields.ts and its one renderer, so it never asks whether a type takes a given
 * field, and neither it nor the form hook spells a type id: a new field or a new engine is a row of data, not an
 * edit here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { BODY_CONNECTION_FIELDS, type BodyConnectionField } from "@/lib/db/connection-fields";

const ROOT = join(import.meta.dir, "..", "..", "..");
const MODAL = "src/components/ConnectionModal.tsx";
const FORM_HOOK = "src/hooks/use-connection-form.ts";
const TYPE_IDS: ReadonlySet<string> = new Set([...EXTERNAL_DATABASE_TYPES, "libredb"]);

function source(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** Every string literal and plain template literal in a source text that a test accepts, with its line. */
function literals(text: string, accept: (literal: string) => boolean): string[] {
  const file = ts.createSourceFile("scanned.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && accept(node.text)) {
      found.push(`${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * Every identifier in a source text that names a binding, each once: a property name after a dot or before a colon
 * is left out, because it names a key of another object, such as the SSH tunnel's own `privateKey`.
 */
function identifiers(text: string): ReadonlySet<string> {
  const file = ts.createSourceFile("scanned.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    const parent = node.parent;
    const propertyName =
      parent !== undefined &&
      ((ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node));
    if (ts.isIdentifier(node) && !propertyName) found.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

const isTypeId = (text: string) => TYPE_IDS.has(text);
const isBodyField = (text: string) => (BODY_CONNECTION_FIELDS as readonly string[]).includes(text);

/**
 * The drawn fields the form hook still reads by name, each for logic of its own rather than for holding the value:
 * a pasted connection string fills these by name, the probe and the credential warning read the login, and the
 * sign-in method decides which credential a paste keeps. `privateKey` is spelled only as the SSH tunnel's sign-in
 * method, a word of the tunnel's own. Every other drawn field is held, reset, loaded, imported and saved through the
 * descriptor registry, so a new one is a descriptor row and never an edit of the hook.
 */
const NAMED_IN_FORM_HOOK: ReadonlySet<BodyConnectionField> = new Set<BodyConnectionField>([
  "user",
  "password",
  "database",
  "schema",
  "warehouse",
  "role",
  "privateKeyPassphrase",
  "authMethod",
  "privateKey",
]);

/**
 * The drawn fields the dialog spells: the database box it lays out itself in the connection-string and file-path
 * modes, and the SSH tunnel's two sign-in methods, which are words of the tunnel's own that share two fields' names.
 */
const NAMED_IN_DIALOG: readonly string[] = ["database", "password", "privateKey"];

/** The names of a field in code: the field itself and its setter. */
function namesOf(field: string): string[] {
  return [field, `set${field.charAt(0).toUpperCase()}${field.slice(1)}`];
}

describe("the connection dialog's isolation from engines", () => {
  test("the dialog never asks whether a type takes a given field", () => {
    expect(source(MODAL).match(/takesConnectionField\(/g) ?? []).toEqual([]);
  });

  test("the dialog names a drawn field only where it lays that box out itself", () => {
    const named = new Set(literals(source(MODAL), isBodyField).map((entry) => entry.split(": ")[1]));
    expect([...named].sort()).toEqual([...NAMED_IN_DIALOG].sort());
  });

  test("neither the dialog nor its form hook spells a type id", () => {
    expect(literals(source(MODAL), isTypeId)).toEqual([]);
    expect(literals(source(FORM_HOOK), isTypeId)).toEqual([]);
  });

  test("the form hook names a drawn field only for logic of its own", () => {
    const names = identifiers(source(FORM_HOOK));
    const literalNames = new Set(literals(source(FORM_HOOK), isBodyField).map((entry) => entry.split(": ")[1]));
    const named = BODY_CONNECTION_FIELDS.filter(
      (field) => namesOf(field).some((name) => names.has(name)) || literalNames.has(field),
    );
    expect([...named].sort()).toEqual([...NAMED_IN_FORM_HOOK].sort());
  });

  test("the scans find what they look for where it is written", () => {
    // Held to known positives through the same functions, so a scan that stopped matching would not pass the cases
    // above in silence.
    expect(literals('const a = "postgres"; const b = `s3`;', isTypeId)).toEqual(["1: postgres", "1: s3"]);
    expect(literals('const c = "registerMap";', isBodyField)).toEqual(["1: registerMap"]);
    expect([...identifiers("const registerMap = setRegisterMap; const o = { region: a.namespaces };")]).toEqual([
      "registerMap",
      "setRegisterMap",
      "o",
      "a",
    ]);
  });
});
