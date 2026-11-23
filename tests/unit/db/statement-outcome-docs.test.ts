/**
 * Every provider document states, in one header row after its Write reach row, what a failed statement answers as
 * its outcome (docs/providers/CONTRACT.md, clause E-5): `| **Failed statement outcome** | <value>: <sentence> |`.
 *
 * The value is `checkout-not-sent` when the provider's execute takes its connection or session through `checkoutPhase`
 * in src/lib/db/errors.ts, which answers a failure of that checkout `not-sent`, and `unknown` otherwise. Nothing reads
 * the fact at run time, so the provider code is its one source: the scan below reads each type-id's triad code (the
 * one file, the directory whole, or the files tests/helpers/provider-directory-map.ts gives a shared directory's
 * type-id) and finds a call of `checkoutPhase` in the TypeScript syntax tree, so a comment or a string naming it is
 * never a call. The callers found are pinned by name, so the scan cannot pass by finding nothing.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import type { DatabaseType } from "@/lib/types";
import { providerDirectoryFiles } from "../../helpers/provider-directory-map";
import { providerTriad } from "../../helpers/provider-layout";

const ROOT = path.resolve(import.meta.dir, "../../..");
const ROW = /^\| \*\*Failed statement outcome\*\* \| (checkout-not-sent|unknown): (.+) \|$/;

/** The type-ids whose provider code runs a checkout through `checkoutPhase`. */
const CLAIMING: readonly DatabaseType[] = ["mysql", "oracle", "postgres"];

interface SourceText {
  readonly path: string;
  readonly text: string;
}

/** Whether `text` calls `checkoutPhase`, by its name or as a member of a namespace import. */
function callsCheckoutPhase(source: SourceText): boolean {
  const tree = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : undefined;
      if (name === "checkoutPhase") found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

/** Every `.ts` file of `type`'s provider code. */
function providerFiles(type: DatabaseType): string[] {
  const code = providerTriad(ROOT, type).code;
  if (statSync(code).isFile()) return [code];
  const shared = providerDirectoryFiles(code, type);
  if (shared !== null) return [...shared];
  return readdirSync(code, { recursive: true, encoding: "utf8" })
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => path.join(code, entry));
}

function claims(type: DatabaseType): boolean {
  return providerFiles(type).some((file) => callsCheckoutPhase({ path: file, text: readFileSync(file, "utf8") }));
}

function outcomeRows(type: DatabaseType): RegExpExecArray[] {
  const doc = providerTriad(ROOT, type).doc;
  expect(existsSync(doc)).toBe(true);
  return readFileSync(doc, "utf8")
    .split("\n")
    .filter((line) => line.startsWith("| **Failed statement outcome**"))
    .map((line) => ROW.exec(line))
    .filter((match): match is RegExpExecArray => match !== null);
}

describe("each provider document's Failed statement outcome row", () => {
  test("each provider document has one Failed statement outcome row, checkout-not-sent exactly when its provider runs a checkout through checkoutPhase", () => {
    const claiming = SHIPPED_DATABASE_TYPES.filter((type) => claims(type));
    expect(claiming.toSorted()).toEqual([...CLAIMING].toSorted());
    for (const type of SHIPPED_DATABASE_TYPES) {
      const rows = outcomeRows(type);
      expect({ type, rows: rows.length }).toEqual({ type, rows: 1 });
      expect({ type, value: rows[0][1] }).toEqual({
        type,
        value: claiming.includes(type) ? "checkout-not-sent" : "unknown",
      });
    }
  });

  test("the row follows the Write reach row", () => {
    for (const type of SHIPPED_DATABASE_TYPES) {
      const lines = readFileSync(providerTriad(ROOT, type).doc, "utf8").split("\n");
      const reach = lines.findIndex((line) => line.startsWith("| **Write reach**"));
      expect({ type, next: lines[reach + 1]?.startsWith("| **Failed statement outcome**") }).toEqual({
        type,
        next: true,
      });
    }
  });

  test("the scan finds a call of checkoutPhase in code and never in a comment or a string", () => {
    const planted = (text: string): SourceText => ({ path: "planted.ts", text });
    expect(
      callsCheckoutPhase(
        planted("export async function query() {\n  return await checkoutPhase(() => pool.connect(), (e) => e);\n}"),
      ),
    ).toBe(true);
    expect(callsCheckoutPhase(planted("export const run = () => errors.checkoutPhase(take, map);"))).toBe(true);
    expect(
      callsCheckoutPhase(
        planted(
          [
            "// checkoutPhase(() => pool.connect(), map) is named here only in a comment.",
            "/** checkoutPhase(take, map) */",
            'const said = "checkoutPhase(take, map)";',
            "const written = `checkoutPhase(take, map)`;",
            "import { checkoutPhase } from './errors';",
            "const held = checkoutPhase;",
          ].join("\n"),
        ),
      ),
    ).toBe(false);
  });
});
