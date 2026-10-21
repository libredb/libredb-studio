import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import ts from "typescript";
import { SQL_WRITING } from "@/lib/db/sql-writing";
import { ENGINE_MODULES, ROOT, TYPED_LITERAL_MODULES, type EngineModule } from "./engine-modules";

/**
 * The seam between one engine's SQL writing module and every other one (spec 5.3).
 *
 * An engine module imports the contract's `types.ts`, `shared.ts` and the engine-neutral
 * export leaf `export-shared.ts` (spec 5.3 [T1]), plus the sibling its typed writer lives in
 * when that is large (spec 5.3), and nothing else, so no module can reach
 * another engine's rules or the registry that holds them all; a type
 * import of `@/lib/types` is allowed because it emits no code. A sibling is held to the
 * same rule and is imported under `src/` by its owner only. The registry imports each
 * engine module once, and the two named specs stay the registry's own. Every module, every
 * sibling and the export leaf also load first in a fresh process without a
 * `ReferenceError` (Review Focus 4), which is what a typed writer or provider importing
 * one directly would do. The export path itself imports no engine's module (spec 5.4).
 *
 * Imports are read off the TypeScript AST: static imports and exports, `import("x")` and
 * `require("x")` with a literal specifier.
 */
const ALLOWED = new Set([
  "@/lib/db/sql-writing/types",
  "@/lib/db/sql-writing/shared",
  "@/lib/db/sql-writing/export-shared",
]);
const TYPE_ONLY_ALLOWED = new Set(["@/lib/types"]);
const NAMED_SPECS = ["@/lib/db/sql-writing/no-connection", "@/lib/db/sql-writing/unknown-type"];

interface ImportRef {
  readonly specifier: string;
  readonly typeOnly: boolean;
}

function importsOf(file: string, text = readFileSync(file, "utf8")): ImportRef[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const refs: ImportRef[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            clause.namedBindings !== undefined &&
            ts.isNamedImports(clause.namedBindings) &&
            clause.namedBindings.elements.length > 0 &&
            clause.namedBindings.elements.every((element) => element.isTypeOnly)));
      refs.push({ specifier: node.moduleSpecifier.text, typeOnly });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      refs.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments.length > 0 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      refs.push({ specifier: node.arguments[0].text, typeOnly: false });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return refs;
}

/** `src/lib/db/providers/sql/mysql-sql-writing.ts` as the alias `@/lib/db/providers/sql/mysql-sql-writing`. */
const aliasOf = (repoPath: string): string => `@/${repoPath.replace(/^src\//, "").replace(/\.ts$/, "")}`;

/**
 * The specifiers an engine module may reach its own typed writer sibling by (spec 5.3):
 * `./typed-literals` beside a `<id>/sql-writing.ts`, `./<id>-typed-literals` beside an
 * `<id>-sql-writing.ts`, or the sibling's alias. An engine with no sibling has none.
 */
const ownTypedLiterals = (engine: EngineModule): string[] =>
  TYPED_LITERAL_MODULES.filter(({ ownerId }) => ownerId === engine.id).flatMap(({ absPath, repoPath }) => [
    `./${basename(absPath, ".ts")}`,
    aliasOf(repoPath),
  ]);

const forbiddenImports = (file: string, text?: string, own: readonly string[] = []): string[] =>
  importsOf(file, text)
    .filter(
      ({ specifier, typeOnly }) =>
        !ALLOWED.has(specifier) && !own.includes(specifier) && !(typeOnly && TYPE_ONLY_ALLOWED.has(specifier)),
    )
    .map(({ specifier, typeOnly }) => (typeOnly ? `type ${specifier}` : specifier));

/** What `types.ts` or `shared.ts` imports beyond a type-only import of the contract's types; both are leaves. */
const LEAF_TYPE_ONLY_ALLOWED = new Set(["./types", "@/lib/db/sql-writing/types", "@/lib/types", "@/lib/non-finite"]);
const LEAVES = ["types.ts", "shared.ts"].map((name) => join(ROOT, "src", "lib", "db", "sql-writing", name));

const leafViolations = (file: string, text?: string, valueAllowed: ReadonlySet<string> = new Set()): string[] =>
  importsOf(file, text)
    .filter(
      ({ specifier, typeOnly }) => !valueAllowed.has(specifier) && !(typeOnly && LEAF_TYPE_ONLY_ALLOWED.has(specifier)),
    )
    .map(({ specifier, typeOnly }) => (typeOnly ? `type ${specifier}` : specifier));

/**
 * The engine-neutral export helpers (spec 5.3): a leaf one level up, which may also take
 * values from `shared.ts` and `@/lib/non-finite`, and still nothing from the export path.
 */
const EXPORT_LEAF = join(ROOT, "src", "lib", "db", "sql-writing", "export-shared.ts");
const EXPORT_LEAF_ALLOWED = new Set(["./shared", "@/lib/db/sql-writing/shared", "@/lib/non-finite"]);

const SRC = join(ROOT, "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** A relative or `@/` specifier as the `.ts` path it names; a package specifier as `undefined`. */
const resolvedPath = (from: string, specifier: string): string | undefined => {
  if (specifier.startsWith("@/")) return `${join(SRC, specifier.slice(2))}.ts`;
  if (specifier.startsWith(".")) return `${resolve(dirname(from), specifier)}.ts`;
  return undefined;
};

/**
 * Each file under `src/` and the paths its imports resolve to. Parsing the whole tree is most of
 * this file's time, so `beforeAll` does it once and every sibling's importer check reads it.
 */
let srcImports: ReadonlyMap<string, readonly string[]> = new Map();

beforeAll(() => {
  srcImports = new Map(
    sourceFiles(SRC).map((file) => [
      file,
      importsOf(file).flatMap(({ specifier }) => resolvedPath(file, specifier) ?? []),
    ]),
  );
}, 60_000);

/** Every file under `src/` that imports `target`, by whatever spelling, as a path from the repo root. */
const importersOf = (target: string): string[] =>
  [...srcImports]
    .filter(([, targets]) => targets.includes(target))
    .map(([file]) =>
      file
        .slice(ROOT.length + 1)
        .split("\\")
        .join("/"),
    );

describe("SQL writing seam", () => {
  // Every engine module may import these two, so an import here reaches every engine transitively.
  for (const leaf of LEAVES) {
    test(`${leaf.slice(ROOT.length + 1)}: imports nothing but types`, () => {
      expect(leafViolations(leaf)).toEqual([]);
    });
  }

  test("a planted import in a leaf is caught", () => {
    const shared = LEAVES[1];
    expect(leafViolations(shared, `import { quoteIdentifier } from "@/lib/sql/identifier";\n`)).toEqual([
      "@/lib/sql/identifier",
    ]);
    expect(leafViolations(shared, `import type { X } from "@/lib/export/result-export";\n`)).toEqual([
      "type @/lib/export/result-export",
    ]);
    expect(leafViolations(shared, `import { SqlWritingSpec } from "./types";\n`)).toEqual(["./types"]);
    expect(leafViolations(shared, `import type { SqlWritingSpec } from "./types";\n`)).toEqual([]);
  });

  test("export-shared.ts: imports only the shared leaf, the non-finite words and types", () => {
    expect(leafViolations(EXPORT_LEAF, undefined, EXPORT_LEAF_ALLOWED)).toEqual([]);
  });

  test("a planted import in the export leaf is caught", () => {
    expect(
      leafViolations(
        EXPORT_LEAF,
        `import { buildResultExport } from "@/lib/export/result-export";\n`,
        EXPORT_LEAF_ALLOWED,
      ),
    ).toEqual(["@/lib/export/result-export"]);
  });

  test("the modules on disk are the registry's rows", () => {
    expect(ENGINE_MODULES.map(({ id }) => id).sort()).toEqual(Object.keys(SQL_WRITING).sort());
  });

  for (const engine of ENGINE_MODULES) {
    test(`${engine.id}: imports only the contract's types and shared building blocks`, () => {
      expect({
        id: engine.id,
        forbidden: forbiddenImports(engine.absPath, undefined, ownTypedLiterals(engine)),
      }).toEqual({ id: engine.id, forbidden: [] });
    });
  }

  test("the typed writer siblings on disk and their owners", () => {
    expect(TYPED_LITERAL_MODULES.map(({ ownerId }) => ownerId)).toEqual([
      "cassandra",
      "clickhouse",
      "databend",
      "duckdb",
      "postgres",
      "snowflake",
      "spark",
      "trino",
    ]);
  });

  for (const sibling of TYPED_LITERAL_MODULES) {
    test(`${sibling.repoPath}: imports only the contract's types, shared building blocks and export leaf`, () => {
      expect({ path: sibling.repoPath, forbidden: forbiddenImports(sibling.absPath) }).toEqual({
        path: sibling.repoPath,
        forbidden: [],
      });
    });

    test(`${sibling.repoPath}: is imported under src/ by ${sibling.ownerId}'s module only`, () => {
      const owners = ENGINE_MODULES.filter(({ id }) => id === sibling.ownerId).map(({ repoPath }) => repoPath);
      expect(importersOf(sibling.absPath)).toEqual(owners);
    });
  }

  // Spec 5.4: the export path reads every engine's facts through the registry.
  for (const file of ["result-export.ts", "typed-literals.ts"]) {
    test(`src/lib/export/${file}: imports nothing from an engine's provider tree`, () => {
      const reached = importsOf(join(SRC, "lib", "export", file))
        .map(({ specifier }) => specifier)
        .filter((specifier) => specifier.startsWith("@/lib/db/providers/"));
      expect(reached).toEqual([]);
    });
  }

  test("no engine module imports a named spec", () => {
    const offenders = ENGINE_MODULES.filter((engine) =>
      importsOf(engine.absPath).some(({ specifier }) => NAMED_SPECS.includes(specifier)),
    ).map(({ id }) => id);
    expect(offenders).toEqual([]);
  });

  test("the registry imports each engine module once", () => {
    const specifiers = importsOf(join(ROOT, "src", "lib", "db", "sql-writing", "index.ts")).map(
      ({ specifier }) => specifier,
    );
    for (const engine of ENGINE_MODULES) {
      expect({ id: engine.id, count: specifiers.filter((s) => s === aliasOf(engine.repoPath)).length }).toEqual({
        id: engine.id,
        count: 1,
      });
    }
  });

  test("a planted cross-engine import is caught", () => {
    const mysql = ENGINE_MODULES.find(({ id }) => id === "mysql");
    if (mysql === undefined) throw new Error("mysql module not found");
    const planted = `import { POSTGRES_SQL_WRITING } from "@/lib/db/providers/sql/postgres-sql-writing";\n${readFileSync(mysql.absPath, "utf8")}`;
    expect(forbiddenImports(mysql.absPath, planted)).toEqual(["@/lib/db/providers/sql/postgres-sql-writing"]);
    expect(forbiddenImports(mysql.absPath, `import { SQL_WRITING } from "@/lib/db/sql-writing";\n`)).toEqual([
      "@/lib/db/sql-writing",
    ]);
    expect(forbiddenImports(mysql.absPath, `export * from "@/lib/sql/values";\n`)).toEqual(["@/lib/sql/values"]);
    expect(forbiddenImports(mysql.absPath, `const v = await import("@/lib/sql/identifier");\n`)).toEqual([
      "@/lib/sql/identifier",
    ]);
    expect(forbiddenImports(mysql.absPath, `import { type X, Y } from "@/lib/types";\n`)).toEqual(["@/lib/types"]);
    expect(forbiddenImports(mysql.absPath, `import type { DatabaseType } from "@/lib/types";\n`)).toEqual([]);
    // Only the engine's own sibling is allowed: another engine's typed writer is not.
    expect(
      forbiddenImports(
        mysql.absPath,
        `import { postgresLiteral } from "./postgres-typed-literals";\n`,
        ownTypedLiterals(mysql),
      ),
    ).toEqual(["./postgres-typed-literals"]);
    expect(
      forbiddenImports(
        mysql.absPath,
        `import { postgresLiteral } from "@/lib/db/providers/sql/postgres-typed-literals";\n`,
        ownTypedLiterals(mysql),
      ),
    ).toEqual(["@/lib/db/providers/sql/postgres-typed-literals"]);
    expect(
      forbiddenImports(
        mysql.absPath,
        `import { buildResultExport } from "@/lib/export/result-export";\n`,
        ownTypedLiterals(mysql),
      ),
    ).toEqual(["@/lib/export/result-export"]);
    const cassandra = ENGINE_MODULES.find(({ id }) => id === "cassandra");
    if (cassandra === undefined) throw new Error("cassandra module not found");
    expect(
      forbiddenImports(
        cassandra.absPath,
        `import { cassandraLiteral } from "@/lib/db/providers/sql/cassandra/typed-literals";\n`,
        ownTypedLiterals(cassandra),
      ),
    ).toEqual([]);
  });

  test("an importer is found by either spelling of the sibling", () => {
    const sibling = TYPED_LITERAL_MODULES.find(({ ownerId }) => ownerId === "postgres");
    if (sibling === undefined) throw new Error("postgres typed writer sibling not found");
    const mysql = join(SRC, "lib", "db", "providers", "sql", "mysql-sql-writing.ts");
    expect(resolvedPath(mysql, "./postgres-typed-literals")).toBe(sibling.absPath);
    expect(resolvedPath(mysql, "@/lib/db/providers/sql/postgres-typed-literals")).toBe(sibling.absPath);
    expect(resolvedPath(mysql, "typescript")).toBeUndefined();
  });

  // Spec 5.4: the inline editor reads its key column kinds and bound edits from the registry,
  // so it imports nothing from either export module or any engine's own module.
  test("the inline editing hook imports no export module and no engine module", () => {
    const forbidden = importsOf(join(ROOT, "src", "hooks", "use-inline-editing.ts"))
      .map(({ specifier }) => specifier)
      .filter(
        (specifier) =>
          specifier.startsWith("@/lib/export/result-export") ||
          specifier.startsWith("@/lib/export/typed-literals") ||
          specifier.startsWith("@/lib/db/providers/"),
      );
    expect(forbidden).toEqual([]);
  });

  const loadsFirst = [
    ...ENGINE_MODULES.map(({ id, absPath }) => ({ id, absPath })),
    ...TYPED_LITERAL_MODULES.map(({ repoPath, absPath }) => ({ id: repoPath, absPath })),
    { id: EXPORT_LEAF.slice(ROOT.length + 1), absPath: EXPORT_LEAF },
  ];
  for (const { id, absPath } of loadsFirst) {
    test(`${id}: loads first in a fresh process`, () => {
      const result = Bun.spawnSync(["bun", "-e", `await import(${JSON.stringify(absPath)});`], {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect({ id, exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
        id,
        exitCode: 0,
        stderr: "",
      });
    });
  }
});
