/**
 * The kubectl statement language's core family module, `src/lib/languages/kubectl/`: the lexer, the command table,
 * the parser, the paging clause, the gate's reading, the confirmation row, the five caps a statement is read against
 * and the quantity reader. The editor bundles the lexer with the Monaco language, the confirmation gate reads the
 * row, and the agent's tool definitions read the quantity reader, so every module of the family is browser-safe.
 * Each imports only another member of the family, the shared console modules and types, never a provider module, a
 * server module or a Node built-in, and none names `Buffer`. Proven both ways: the real sources pass, and a planted
 * import fails by name.
 *
 * The family's modules are written here as `FAMILY`, and one test holds that list equal to the directory's listing,
 * so a module added to the family fails until it is written here, and is held from then on. A member import is
 * `./<name>` or `@/lib/languages/kubectl/<name>` of a family member.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { statementLanguageFamilyDirectory } from "../../../helpers/statement-language-family";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const FAMILY_DIR = statementLanguageFamilyDirectory("kubectl");

/** The family's modules, by file name without `.ts`, read from the family directory. */
const familyModules = (): string[] =>
  readdirSync(join(ROOT, ...FAMILY_DIR.split("/")))
    .filter((file) => file.endsWith(".ts"))
    .map((file) => file.slice(0, -".ts".length))
    .sort((a, b) => a.localeCompare(b));

/** The specifiers a family module may load a member by: `./<name>` and `@/lib/languages/kubectl/<name>`. */
const memberSpecifiers = (members: readonly string[]): Set<string> =>
  new Set(members.flatMap((name) => [`./${name}`, `@/${FAMILY_DIR.slice("src/".length)}/${name}`]));

const SHARED = [/^@\/lib\/db\/console\/[a-z-]+$/];

/** Every value import of `source` (type-only imports and type-only names are allowed anywhere). */
function valueImports(source: string): string[] {
  const file = ts.createSourceFile("module.ts", source, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      if (clause?.isTypeOnly === true) continue;
      const bindings = clause?.namedBindings;
      const onlyTypes =
        clause !== undefined &&
        clause.name === undefined &&
        bindings !== undefined &&
        ts.isNamedImports(bindings) &&
        bindings.elements.every((element) => element.isTypeOnly);
      if (onlyTypes) continue;
    } else if (statement.isTypeOnly) continue;
    found.push(specifier.text);
  }
  return found;
}

/** What `name.ts` with this source imports or names that a family module may not, given the family's members. */
function findings(name: string, source: string, members: readonly string[]): string[] {
  const allowed = memberSpecifiers(members);
  const imports = valueImports(source)
    .filter((specifier) => !allowed.has(specifier) && !SHARED.some((pattern) => pattern.test(specifier)))
    .map((specifier) => `${name}.ts imports ${specifier}, which is not browser-safe`);
  // Buffer is Node's; a browser module that names it fails in the editor bundle, not in a server test.
  const buffer = /\bBuffer\b/.test(source) ? [`${name}.ts names Buffer, which the browser does not have`] : [];
  return [...imports, ...buffer];
}

/** The eight modules the kubectl slice of PR 8 moved or split into the family. */
const FAMILY = ["commands", "constants", "destructive", "guard", "lexer", "paging", "parse", "quantity"];

describe("the kubectl family modules", () => {
  test("the kubectl family directory holds the language's eight modules", () => {
    expect(familyModules()).toEqual(FAMILY);
  });

  test.each(FAMILY)("%s.ts imports only family members, the shared console modules and types", (name) => {
    const members = familyModules();
    const source = readFileSync(join(ROOT, ...FAMILY_DIR.split("/"), `${name}.ts`), "utf8");
    expect(findings(name, source, members)).toEqual([]);
  });

  test.each([
    ['import { readFileSync } from "node:fs";\n', "node:fs"],
    [
      'import { KUBERNETES_TYPE } from "@/lib/db/providers/platform/kubernetes/limits";\n',
      "@/lib/db/providers/platform/kubernetes/limits",
    ],
    ['import { objectOf } from "./context";\n', "./context"],
    ['import { createNodeTransport } from "@/lib/db/http/node-transport";\n', "@/lib/db/http/node-transport"],
    ['export { readTop } from "./top";\n', "./top"],
  ])("a planted %s in constants.ts fails by name", (planted, specifier) => {
    expect(findings("constants", planted, FAMILY)).toEqual([
      `constants.ts imports ${specifier}, which is not browser-safe`,
    ]);
  });

  test("a planted Buffer fails by name", () => {
    expect(findings("lexer", "const bytes = Buffer.from(text);\n", FAMILY)).toEqual([
      "lexer.ts names Buffer, which the browser does not have",
    ]);
  });

  test("a family member is allowed by its relative and its core path, and a provider module is not", () => {
    expect(findings("guard", 'import { readKubectlRun } from "./paging";\n', FAMILY)).toEqual([]);
    expect(
      findings("destructive", 'import { kubectlRefusal } from "@/lib/languages/kubectl/guard";\n', FAMILY),
    ).toEqual([]);
    expect(
      findings(
        "destructive",
        'import { kubectlRefusal } from "@/lib/db/providers/platform/kubernetes/console/guard";\n',
        FAMILY,
      ),
    ).toEqual([
      "destructive.ts imports @/lib/db/providers/platform/kubernetes/console/guard, which is not browser-safe",
    ]);
  });

  test("a type-only import of a server module is allowed", () => {
    expect(
      findings(
        "paging",
        'import type { KubectlContext } from "@/lib/db/providers/platform/kubernetes/console/context";\nimport { type PreparedQuery } from "@/lib/db/types";\n',
        FAMILY,
      ),
    ).toEqual([]);
  });
});
