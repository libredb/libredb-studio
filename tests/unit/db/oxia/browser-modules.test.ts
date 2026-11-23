/**
 * The Oxia modules shipped to the browser (SB2-1, SB2-3.5, contract section 12): the vocabulary row imports guard.ts,
 * which reaches commands.ts, lexer.ts and constants.ts, all bundled into the editor with the Monaco language; the
 * query generators import generators.ts, provider-meta serves labels.ts, and the Keys panel's cursor and the key
 * order are pure modules the server shares with them. Each
 * imports only another member of this set, the shared console modules and types, never a server module, a Node
 * built-in or the shared gRPC transport, and none names `Buffer`. Proven both ways: the real sources pass, and a
 * planted import fails by name.
 *
 * The set has two homes: the command language's modules (its constants, the lexer, the command table and the guard)
 * live in the oxiacli statement language's core family module, `src/lib/languages/oxiacli/`, and the provider's own
 * browser modules (its constants, the key order, the cursor, the labels and the generators) in the provider
 * directory. A member import is `./<name>` of a member in the importer's own directory, or
 * `@/lib/languages/oxiacli/<name>` of a family member.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { statementLanguageFamilyDirectory } from "../../../helpers/statement-language-family";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const OXIA_DIR = "src/lib/db/providers/keyvalue/oxia";
const FAMILY_DIR = statementLanguageFamilyDirectory("oxiacli");

/** A browser-shipped module: its `/`-joined repository directory and its file name without `.ts`. */
interface Member {
  readonly dir: string;
  readonly name: string;
}

/** The browser-shipped set: the console (T08), the key order and the cursor (T06), the labels and the generators (T12). */
const BROWSER_MODULES: readonly Member[] = [
  ...["constants", "lexer", "commands", "guard"].map((name) => ({ dir: FAMILY_DIR, name })),
  ...["constants", "order", "cursor", "labels", "generators"].map((name) => ({ dir: OXIA_DIR, name })),
];

/** The member named `name` in `dir`. */
const member = (dir: string, name: string): Member => {
  const found = BROWSER_MODULES.find((module) => module.dir === dir && module.name === name);
  if (found === undefined) throw new Error(`${dir}/${name} is not a member of the browser-shipped set`);
  return found;
};

/** The specifiers `importer` may load a member by: `./<name>` in its own directory, `@/...` for a family member. */
const memberSpecifiers = (importer: Member): Set<string> =>
  new Set(
    BROWSER_MODULES.flatMap((module) => [
      ...(module.dir === importer.dir ? [`./${module.name}`] : []),
      ...(module.dir === FAMILY_DIR ? [`@/${FAMILY_DIR.slice("src/".length)}/${module.name}`] : []),
    ]),
  );

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

function findings(module: Member, source: string): string[] {
  const allowed = memberSpecifiers(module);
  const imports = valueImports(source)
    .filter((specifier) => !allowed.has(specifier) && !SHARED.some((pattern) => pattern.test(specifier)))
    .map((specifier) => `${module.name}.ts imports ${specifier}, which is not browser-safe`);
  // Buffer is Node's; a browser module that names it fails in the editor bundle, not in a server test.
  const buffer = /\bBuffer\b/.test(source) ? [`${module.name}.ts names Buffer, which the browser does not have`] : [];
  return [...imports, ...buffer];
}

describe("the browser-shipped Oxia modules", () => {
  test.each(BROWSER_MODULES.map((module) => [`${module.dir}/${module.name}`, module] as const))(
    "%s.ts imports only the set, shared console modules and types",
    (_label, module) => {
      expect(findings(module, readFileSync(join(ROOT, module.dir, `${module.name}.ts`), "utf8"))).toEqual([]);
    },
  );

  test.each([
    ['import { grpcTarget } from "@/lib/db/grpc/tls";\n', "@/lib/db/grpc/tls"],
    ['import { toOxiaError } from "./errors";\n', "./errors"],
    ['import { createGrpcOxiaClient } from "./grpc-client";\n', "./grpc-client"],
    ['import { readFileSync } from "node:fs";\n', "node:fs"],
    ['import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";\n', "@/lib/db/utils/query-limiter"],
    ['export { viewOxiaValue } from "./values";\n', "./values"],
  ])("a planted %s in commands.ts fails by name", (planted, specifier) => {
    expect(findings(member(FAMILY_DIR, "commands"), planted)).toEqual([
      `commands.ts imports ${specifier}, which is not browser-safe`,
    ]);
  });

  test("a planted walks import in labels.ts fails by name", () => {
    expect(findings(member(OXIA_DIR, "labels"), 'import { detectKeyOrder } from "./walks";\n')).toEqual([
      "labels.ts imports ./walks, which is not browser-safe",
    ]);
  });

  test("a planted Buffer fails by name", () => {
    expect(findings(member(FAMILY_DIR, "lexer"), "const bytes = Buffer.from(text);\n")).toEqual([
      "lexer.ts names Buffer, which the browser does not have",
    ]);
  });

  test("a family member is allowed by its core path from the provider directory, and a provider member is not", () => {
    expect(
      findings(member(OXIA_DIR, "labels"), 'import { parseOxiaCommand } from "@/lib/languages/oxiacli/commands";\n'),
    ).toEqual([]);
    expect(findings(member(FAMILY_DIR, "commands"), 'import { encodeOxiaCursor } from "./cursor";\n')).toEqual([
      "commands.ts imports ./cursor, which is not browser-safe",
    ]);
  });

  test("a type-only import of a server module is allowed", () => {
    expect(
      findings(
        member(FAMILY_DIR, "commands"),
        'import type { OxiaClient } from "./client";\nimport { type DatabaseType } from "@/lib/types";\n',
      ),
    ).toEqual([]);
  });
});
