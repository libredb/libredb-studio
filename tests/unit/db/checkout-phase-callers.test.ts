/**
 * The providers whose execute takes its connection or session through `checkoutPhase` in src/lib/db/errors.ts, which
 * answers a failure of that checkout `not-sent` (docs/providers/CONTRACT.md, clause E-5), so a failed checkout is
 * never reported as a statement that may have reached the server.
 *
 * Nothing reads the fact at run time, so the provider code is its one source: the scan below reads each type-id's
 * triad code (the one file, the directory whole, or the files tests/helpers/provider-directory-map.ts gives a shared
 * directory's type-id) and finds a call of `checkoutPhase` in the TypeScript syntax tree, so a comment or a string
 * naming it is never a call. The callers found are pinned by name, so the scan cannot pass by finding nothing, and a
 * provider that starts or stops running its checkout through `checkoutPhase` changes this list on purpose.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { SHIPPED_DATABASE_TYPES } from "@/lib/db/compatibility";
import type { DatabaseType } from "@/lib/types";
import { providerDirectoryFiles } from "../../helpers/provider-directory-map";
import { providerTriad } from "../../helpers/provider-layout";

const ROOT = path.resolve(import.meta.dir, "../../..");

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

describe("the providers that run a checkout through checkoutPhase", () => {
  test("the type-ids whose provider code calls checkoutPhase are mysql, oracle and postgres", () => {
    const claiming = SHIPPED_DATABASE_TYPES.filter((type) => claims(type));
    expect(claiming.toSorted()).toEqual([...CLAIMING].toSorted());
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
