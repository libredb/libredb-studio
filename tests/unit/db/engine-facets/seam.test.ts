/**
 * The seam around each engine's facets module: a row module imports only the contract's types, and only as types, so it
 * loads nothing at run time and one engine's declaration can never reach another's. The registry index imports each
 * engine's module, the contract types and the type-id reader, and nothing else, so reading a row loads no provider.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const INDEX = join(ROOT, "src/lib/db/engine-facets/index.ts");
const ALL: readonly string[] = [...EXTERNAL_DATABASE_TYPES, "libredb"].sort();

const TYPES = "@/lib/db/engine-facets/types";
const PROVIDERS = "@/lib/db/providers/";

interface ImportFact {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

/** Every import, re-export and dynamic import of `source`, each marked whether it loads nothing at run time. */
function importFacts(path: string, source: string): ImportFact[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
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

/** The engine modules the registry index imports, keyed by the type id each one's export names. */
function engineModules(): { id: string; specifier: string; path: string }[] {
  return importFacts(INDEX, readFileSync(INDEX, "utf8"))
    .filter(({ specifier }) => specifier.startsWith(PROVIDERS))
    .map(({ specifier }) => {
      const source = readFileSync(join(ROOT, "src", `${specifier.slice(2)}.ts`), "utf8");
      const exported = /export const ([A-Z0-9]+)_ENGINE_FACETS\b/.exec(source);
      if (exported === null) throw new Error(`${specifier} exports no engine facets row`);
      return { id: exported[1].toLowerCase(), specifier, path: join(ROOT, "src", `${specifier.slice(2)}.ts`) };
    });
}

/** Each import of an engine's module that the seam does not allow, named by the engine. */
function engineFindings(id: string, path: string, source: string): string[] {
  return importFacts(path, source)
    .filter(({ specifier, typeOnly }) => !(specifier === TYPES && typeOnly))
    .map(
      ({ specifier, typeOnly }) =>
        `${id}: ${relative(ROOT, path)} imports ${specifier}${typeOnly ? "" : " at run time"}`,
    );
}

describe("the engine facets modules", () => {
  const modules = engineModules();

  test("the registry index imports each engine's module exactly once", () => {
    expect(modules.map(({ id }) => id).sort()).toEqual([...ALL]);
    expect(new Set(modules.map(({ specifier }) => specifier)).size).toBe(ALL.length);
  });

  test("an engine's facets module imports only the contract's types, and only as types", () => {
    const findings = modules.flatMap(({ id, path }) => engineFindings(id, path, readFileSync(path, "utf8")));
    expect(findings).toEqual([]);

    const kafka = modules.find(({ id }) => id === "kafka");
    if (kafka === undefined) throw new Error("no kafka module");
    expect(engineFindings("kafka", kafka.path, `import { MONITORING_PANELS } from "${TYPES}";\n`)).toEqual([
      `kafka: ${relative(ROOT, kafka.path)} imports ${TYPES} at run time`,
    ]);
    for (const forbidden of [
      "@/lib/db/engine-facets",
      "@/lib/db/engine-facets/monitoring",
      "@/lib/db/providers/sql/postgres-engine-facets",
      "@/lib/types",
    ]) {
      expect(engineFindings("kafka", kafka.path, `import type { X } from "${forbidden}";\n`)).toHaveLength(1);
    }
  });

  test("the registry index imports each engine's module, the contract types and the type-id reader, and nothing else", () => {
    const others = importFacts(INDEX, readFileSync(INDEX, "utf8"))
      .filter(({ specifier }) => !specifier.startsWith(PROVIDERS))
      .map(({ specifier, typeOnly }) => `${specifier}${typeOnly ? " (type only)" : ""}`)
      .sort();
    expect(others).toEqual(["./types (type only)", "@/lib/db/type-id", "@/lib/types (type only)"]);
  });
});
