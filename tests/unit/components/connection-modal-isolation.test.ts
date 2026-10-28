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

const ROOT = join(import.meta.dir, "..", "..", "..");
const MODAL = "src/components/ConnectionModal.tsx";
const FORM_HOOK = "src/hooks/use-connection-form.ts";
const TYPE_IDS: ReadonlySet<string> = new Set([...EXTERNAL_DATABASE_TYPES, "libredb"]);

function source(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

/** Every string literal and plain template literal in a file whose text is a type id, with its line. */
function typeIdLiterals(path: string): string[] {
  const file = ts.createSourceFile(path, source(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && TYPE_IDS.has(node.text)) {
      found.push(`${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${node.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("the connection dialog's isolation from engines", () => {
  test("the dialog never asks whether a type takes a given field", () => {
    expect(source(MODAL).match(/takesConnectionField\(/g) ?? []).toEqual([]);
  });

  test("neither the dialog nor its form hook spells a type id", () => {
    expect(typeIdLiterals(MODAL)).toEqual([]);
    expect(typeIdLiterals(FORM_HOOK)).toEqual([]);
  });

  test("the literal scan finds a type id where one is written", () => {
    // Held to a known positive, so a scan that stopped matching would not pass the two cases above in silence.
    const probe = ts.createSourceFile("probe.ts", 'const a = "postgres"; const b = `s3`;', ts.ScriptTarget.Latest);
    const texts: string[] = [];
    const visit = (node: ts.Node): void => {
      if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && TYPE_IDS.has(node.text)) {
        texts.push(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(probe);
    expect(texts).toEqual(["postgres", "s3"]);
  });
});
