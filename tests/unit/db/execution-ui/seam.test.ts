/**
 * The seam around each engine's execution UI module: an engine module reads only the registry's leaves (`types`,
 * `shared`, and a type-only `@/lib/types`), never the registry index, the no-connection or unknown-type spec, the
 * explain request, another engine's module, a hook or a component, so one engine's commit keyword or consent deadline
 * can never reach another's output. `shared.ts` reads at most `types`, `explain-request.ts` reads nothing, and every
 * module loads in a fresh process on its own.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import ts from "typescript";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const REGISTRY = join(ROOT, "src/lib/db/execution-ui");
const ALL: readonly string[] = [...EXTERNAL_DATABASE_TYPES, "libredb"].sort();

const TYPES = "@/lib/db/execution-ui/types";
const SHARED = "@/lib/db/execution-ui/shared";

function parse(path: string, source: string): ts.SourceFile {
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

interface ImportFact {
  specifier: string;
  typeOnly: boolean;
}

/** Every import, re-export and dynamic import of `source`, each marked whether it loads nothing at run time. */
function importFacts(path: string, source: string): ImportFact[] {
  const file = parse(path, source);
  const found: ImportFact[] = [];
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier;
    if (specifier === undefined || !ts.isStringLiteral(specifier)) continue;
    let typeOnly: boolean;
    if (ts.isImportDeclaration(statement)) {
      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      typeOnly =
        clause?.isTypeOnly === true ||
        (clause !== undefined &&
          clause.name === undefined &&
          bindings !== undefined &&
          ts.isNamedImports(bindings) &&
          bindings.elements.length > 0 &&
          bindings.elements.every((element) => element.isTypeOnly));
    } else {
      typeOnly = statement.isTypeOnly;
    }
    found.push({ specifier: specifier.text, typeOnly });
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      found.push({ specifier: node.arguments[0].text, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** The repository file a specifier names, or null for a package. */
function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(ROOT, "src", specifier.slice(2))
    : specifier.startsWith(".")
      ? join(dirname(from), specifier)
      : null;
  if (base === null) return null;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${specifier}, imported by ${from}, resolves to no file`);
}

/** The engine modules as the registry index imports them, keyed by the type id each one's export names. */
function engineModules(): { id: string; specifier: string; path: string }[] {
  const index = join(REGISTRY, "index.ts");
  const file = parse(index, readFileSync(index, "utf8"));
  const found: { id: string; specifier: string; path: string }[] = [];
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith("@/lib/db/providers/")) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings === undefined || !ts.isNamedImports(bindings)) throw new Error(`${specifier} has no named import`);
    for (const element of bindings.elements) {
      const id = element.name.text.replace(/_EXECUTION_UI$/, "").toLowerCase();
      found.push({ id, specifier, path: resolveLocal(index, specifier) as string });
    }
  }
  return found;
}

const MODULES = engineModules();

/** Each import of an engine module that the seam does not allow, named by the engine. */
function engineFindings(id: string, path: string, source: string): string[] {
  return importFacts(path, source)
    .filter(
      ({ specifier, typeOnly }) =>
        specifier !== TYPES && specifier !== SHARED && !(specifier === "@/lib/types" && typeOnly),
    )
    .map(({ specifier }) => `${id}: ${relative(ROOT, path)} imports ${specifier}`);
}

describe("the engine execution UI modules", () => {
  test("the registry index imports each engine's module exactly once", () => {
    expect(MODULES.map(({ id }) => id).sort()).toEqual([...ALL]);
    expect(new Set(MODULES.map(({ specifier }) => specifier)).size).toBe(ALL.length);
  });

  test.each(MODULES.map(({ id, path }) => [id, path] as const))("%s imports only the registry's leaves", (id, path) => {
    expect(engineFindings(id, path, readFileSync(path, "utf8"))).toEqual([]);
  });

  test("an engine module that imports another engine's module fails by name", () => {
    const mysql = MODULES.find(({ id }) => id === "mysql");
    if (mysql === undefined) throw new Error("no mysql module");
    const planted = 'import { POSTGRES_EXECUTION_UI } from "@/lib/db/providers/sql/postgres-execution-ui";\n';
    expect(engineFindings("mysql", mysql.path, planted)).toEqual([
      `mysql: ${relative(ROOT, mysql.path)} imports @/lib/db/providers/sql/postgres-execution-ui`,
    ]);
    for (const forbidden of [
      "@/lib/db/execution-ui/index",
      "@/lib/db/execution-ui",
      "@/lib/db/execution-ui/no-connection",
      "@/lib/db/execution-ui/unknown-type",
      "@/lib/db/execution-ui/explain-request",
      "./no-connection",
      "@/hooks/use-query-execution",
      "@/components/agent/ConsentCard",
    ]) {
      expect(engineFindings("mysql", mysql.path, `import { x } from "${forbidden}";\n`)).toHaveLength(1);
    }
    expect(engineFindings("mysql", mysql.path, 'import { SSL } from "@/lib/types";\n')).toHaveLength(1);
    expect(engineFindings("mysql", mysql.path, 'import type { DatabaseType } from "@/lib/types";\n')).toEqual([]);
  });

  test("shared.ts imports only the registry's types, or nothing", () => {
    const path = join(REGISTRY, "shared.ts");
    const specifiers = importFacts(path, readFileSync(path, "utf8")).map(({ specifier }) => specifier);
    expect(specifiers.filter((specifier) => specifier !== "./types" && specifier !== TYPES)).toEqual([]);
  });

  test("explain-request.ts imports nothing", () => {
    const path = join(REGISTRY, "explain-request.ts");
    expect(importFacts(path, readFileSync(path, "utf8"))).toEqual([]);
  });

  test("no engine module imports the no-connection or unknown-type spec", () => {
    const targets = new Set([join(REGISTRY, "no-connection.ts"), join(REGISTRY, "unknown-type.ts")]);
    const found = MODULES.flatMap(({ id, path }) =>
      importFacts(path, readFileSync(path, "utf8"))
        .filter(({ specifier }) => targets.has(resolveLocal(path, specifier) ?? ""))
        .map(({ specifier }) => `${id} imports ${specifier}`),
    );
    expect(found).toEqual([]);
  });
});

describe("a fresh process loads each module on its own", () => {
  const paths = [...MODULES.map(({ path }) => path), join(REGISTRY, "explain-request.ts")];
  test.each(paths.map((path) => [relative(ROOT, path), path] as const))("%s", (_, path) => {
    const run = Bun.spawnSync(["bun", "-e", `await import(${JSON.stringify(path)})`], { cwd: ROOT });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
  });
});
