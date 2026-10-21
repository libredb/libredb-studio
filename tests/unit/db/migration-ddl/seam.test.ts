/**
 * The migration DDL seam (spec 5.3): an engine module imports only the contract's `types` and `shared`, and the
 * type-only `@/lib/types`, so it can reach no other engine's text, no registry and none of the quoting or export
 * helpers. The no-connection and unknown-type specs are built the same way and no engine module imports them; the
 * registry imports each engine module once; the generator names no type id (held here because the engine-branch guard
 * is not on this branch); and every engine module loads first in a fresh process.
 *
 * The guard is syntactic: a module name built at run time is reported, not chased. Each rule is proven both ways
 * where a planted text can show it: the real sources pass and a planted file fails by name.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import ts from "typescript";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";
import { engineModules, REGISTRY, ROOT } from "./modules";

const CONTRACT = "src/lib/db/migration-ddl";
const TYPES = `${CONTRACT}/types`;
const SHARED = `${CONTRACT}/shared`;
const NO_CONNECTION = `${CONTRACT}/no-connection.ts`;
const UNKNOWN_TYPE = `${CONTRACT}/unknown-type.ts`;
const GENERATOR = "src/lib/schema-diff/migration-generator.ts";
const TYPE_IDS: ReadonlySet<string> = new Set([...EXTERNAL_DATABASE_TYPES, "libredb"]);
const MODULES = engineModules();

interface Reference {
  /** The module the reference names, relative to the root and without extension; undefined when not a plain string. */
  readonly target: string | undefined;
  readonly specifier: string | undefined;
  readonly typeOnly: boolean;
}

const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const parse = (path: string, text: string) => ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);

/** An `@/` or relative specifier as a root-relative module name with no `.ts` and no trailing `/index`. */
function targetOf(specifier: string, file: string): string {
  let name = specifier;
  if (specifier.startsWith("@/")) name = `src/${specifier.slice(2)}`;
  else if (specifier.startsWith(".")) name = posix.normalize(posix.join(posix.dirname(file), specifier));
  return name.replace(/\.ts$/, "").replace(/\/index$/, "");
}

/** Every module a file names: import and export declarations, `import()` and `require()` calls, and import types. */
function references(file: string, text: string): Reference[] {
  const found: Reference[] = [];
  const add = (node: ts.Node | undefined, typeOnly: boolean) => {
    const specifier = node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;
    found.push({ specifier, target: specifier === undefined ? undefined : targetOf(specifier, file), typeOnly });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const clause = node.importClause;
      const bindings = clause?.namedBindings;
      const typeOnly =
        clause !== undefined &&
        (clause.isTypeOnly ||
          (clause.name === undefined &&
            bindings !== undefined &&
            ts.isNamedImports(bindings) &&
            bindings.elements.length > 0 &&
            bindings.elements.every((element) => element.isTypeOnly)));
      add(node.moduleSpecifier, typeOnly);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      add(node.moduleSpecifier, node.isTypeOnly);
    } else if (ts.isImportTypeNode(node)) {
      add(ts.isLiteralTypeNode(node.argument) ? node.argument.literal : undefined, true);
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      add(node.arguments[0], false);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file, text));
  return found;
}

/** What a file built on the contract imports beyond `types`, `shared` and the type-only `@/lib/types`. */
function seamFindings(file: string, text: string): string[] {
  const findings: string[] = [];
  for (const { specifier, target, typeOnly } of references(file, text)) {
    if (target === undefined) findings.push(`${file} loads a module whose name is not a plain string`);
    else if (target === TYPES || target === SHARED) continue;
    else if (target === "src/lib/types" && typeOnly) continue;
    else if (target === "src/lib/types")
      findings.push(`${file} imports a value from ${specifier}; it takes types only`);
    else findings.push(`${file} imports ${specifier}, which the migration DDL seam does not allow`);
  }
  return findings;
}

/** A string literal equal to a type id, and a `Record<DatabaseType, ...>` or `Set<DatabaseType>` type reference. */
function generatorFindings(file: string, text: string): string[] {
  const findings: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) && TYPE_IDS.has(node.text)) {
      findings.push(`${file} names the type id "${node.text}"`);
    } else if (ts.isTypeReferenceNode(node) || ts.isNewExpression(node)) {
      const name = ts.isTypeReferenceNode(node) ? node.typeName : node.expression;
      const first = node.typeArguments?.[0];
      if (
        ts.isIdentifier(name) &&
        (name.text === "Record" || name.text === "Set") &&
        first !== undefined &&
        ts.isTypeReferenceNode(first) &&
        first.typeName.getText() === "DatabaseType"
      )
        findings.push(`${file} declares a ${name.text}<DatabaseType ...>`);
    }
    ts.forEachChild(node, visit);
  };
  visit(parse(file, text));
  return findings;
}

describe("migration DDL seam", () => {
  test("the registry imports 42 engine modules, one per type id", () => {
    expect(MODULES.map((engine) => engine.id).sort()).toEqual([...TYPE_IDS].sort());
  });

  test("the registry imports each engine module exactly once", () => {
    const counts = new Map<string, number>();
    for (const { target } of references(REGISTRY, read(REGISTRY)))
      if (target !== undefined) counts.set(target, (counts.get(target) ?? 0) + 1);
    const repeated = MODULES.filter((engine) => counts.get(targetOf(engine.specifier, REGISTRY)) !== 1);
    expect(repeated.map((engine) => engine.id)).toEqual([]);
  });

  for (const engine of MODULES) {
    test(`${engine.id} imports only the contract's types and shared`, () => {
      expect(seamFindings(engine.path, read(engine.path))).toEqual([]);
    });
  }

  test("the no-connection and unknown-type specs import only the contract's types and shared", () => {
    expect([
      ...seamFindings(NO_CONNECTION, read(NO_CONNECTION)),
      ...seamFindings(UNKNOWN_TYPE, read(UNKNOWN_TYPE)),
    ]).toEqual([]);
  });

  test("no engine module imports the no-connection or the unknown-type spec", () => {
    const fallbacks = new Set([NO_CONNECTION, UNKNOWN_TYPE].map((path) => path.replace(/\.ts$/, "")));
    const importers = MODULES.filter((engine) =>
      references(engine.path, read(engine.path)).some(({ target }) => target !== undefined && fallbacks.has(target)),
    );
    expect(importers.map((engine) => engine.id)).toEqual([]);
  });

  test("the generator names no type id and declares no table keyed by DatabaseType", () => {
    expect(generatorFindings(GENERATOR, read(GENERATOR))).toEqual([]);
  });

  test("a planted engine module that reaches another engine fails by name", () => {
    const file = "src/lib/db/providers/sql/mysql-migration-ddl.ts";
    const planted = [
      'import { POSTGRES_MIGRATION_DDL } from "./postgres-migration-ddl";',
      'import { quoteIdentifier } from "@/lib/sql/identifier";',
      'import { MIGRATION_DDL } from "@/lib/db/migration-ddl";',
      'import { DatabaseType } from "@/lib/types";',
      'import { standardDropTable } from "../../migration-ddl/shared";',
      'import type { MigrationDdlSpec } from "@/lib/db/migration-ddl/types";',
      'import type { SchemaDiff } from "@/lib/types";',
      "const lazy = await import(name);",
    ].join("\n");
    expect(seamFindings(file, planted)).toEqual([
      `${file} imports ./postgres-migration-ddl, which the migration DDL seam does not allow`,
      `${file} imports @/lib/sql/identifier, which the migration DDL seam does not allow`,
      `${file} imports @/lib/db/migration-ddl, which the migration DDL seam does not allow`,
      `${file} imports a value from @/lib/types; it takes types only`,
      `${file} loads a module whose name is not a plain string`,
    ]);
  });

  test("a planted generator that names a type id or keys a table by DatabaseType fails by name", () => {
    const planted = [
      'const fallback = "postgres";',
      "const table: Record<DatabaseType, string> = {} as never;",
      "const ids = new Set<DatabaseType>();",
      "let seen: Set<DatabaseType>;",
      'const unrelated = "postgresql";',
    ].join("\n");
    expect(generatorFindings(GENERATOR, planted)).toEqual([
      `${GENERATOR} names the type id "postgres"`,
      `${GENERATOR} declares a Record<DatabaseType ...>`,
      `${GENERATOR} declares a Set<DatabaseType ...>`,
      `${GENERATOR} declares a Set<DatabaseType ...>`,
    ]);
  });

  // Review Focus 4: a typed writer or provider importing an engine module before anything else.
  for (const engine of MODULES) {
    test(`${engine.id} loads first in a fresh process`, () => {
      const result = Bun.spawnSync(["bun", "-e", `await import(${JSON.stringify(join(ROOT, engine.path))})`], {
        cwd: ROOT,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({ exitCode: 0, stderr: "" });
    });
  }
});
