/**
 * The seam around each engine's connection string module: an engine module reads only the registry's leaves
 * (`types`, `shared`) and the modules of its own provider directory (Snowflake's browser-safe `account-host`, a paste
 * reader beside its provider), never the parser, the seed loader, the dialog's table, the registry index or another
 * engine's module, so one engine's scheme, URL TLS, paste or seed checks can never reach another's output. The seed loader and the connection-field record reach neither the icon set nor the
 * dialog's table at run time, and every module loads in a fresh process on its own.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import ts from "typescript";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const REGISTRY = join(ROOT, "src/lib/db/connection-string");
const ALL: readonly string[] = [...EXTERNAL_DATABASE_TYPES, "libredb"].sort();

const TYPES = "@/lib/db/connection-string/types";
const SHARED = "@/lib/db/connection-string/shared";
const ACCOUNT_HOST = "@/lib/db/providers/sql/snowflake/account-host";
const PARSER = join(ROOT, "src/lib/connection-string-parser.ts");
const PROVIDERS = join(ROOT, "src/lib/db/providers");

/** A repository path with `/` separators, so a comparison reads the same on Windows. */
const slashed = (path: string): string => path.replaceAll("\\", "/");

function parse(path: string, source: string): ts.SourceFile {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, kind);
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
      const id = element.name.text.replace(/_CONNECTION_STRING$/, "").toLowerCase();
      found.push({ id, specifier, path: resolveLocal(index, specifier) as string });
    }
  }
  return found;
}

const MODULES = engineModules();

/**
 * The provider directory an engine module owns: the directory it sits in when that directory is named for the engine
 * (`sql/snowflake/connection-string.ts`), otherwise none, since a flat module shares its directory with other engines.
 */
function ownDirectory(id: string, path: string): string | null {
  return basename(dirname(path)) === id ? slashed(dirname(path)) : null;
}

/** Whether `specifier`, imported by `path`, names a module of the engine's own directory that no other row is. */
function inOwnDirectory(id: string, path: string, specifier: string): boolean {
  const own = ownDirectory(id, path);
  if (own === null || !(specifier.startsWith("@/") || specifier.startsWith("."))) return false;
  const resolved = resolveLocal(path, specifier);
  if (resolved === null || !slashed(resolved).startsWith(`${own}/`)) return false;
  return !MODULES.some((module) => module.id !== id && slashed(module.path) === slashed(resolved));
}

/**
 * Each import of an engine module that the seam does not allow, named by the engine: only the registry's `types` and
 * `shared`, a type-only `@/lib/types`, and a module of the engine's own provider directory.
 */
function engineFindings(id: string, path: string, source: string): string[] {
  const allowed = new Set([TYPES, SHARED]);
  return importFacts(path, source)
    .filter(({ specifier, typeOnly }) => !allowed.has(specifier) && !(specifier === "@/lib/types" && typeOnly))
    .filter(({ specifier }) => !inOwnDirectory(id, path, specifier))
    .map(({ specifier }) => `${id}: ${relative(ROOT, path)} imports ${specifier}`);
}

/** Every value import the run-time graph of `entry` reaches, followed through repository files, with its importer. */
function reachedImports(entry: string): { from: string; specifier: string; resolved: string | null }[] {
  const seen = new Set<string>();
  const reached: { from: string; specifier: string; resolved: string | null }[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.pop() as string;
    if (seen.has(path)) continue;
    seen.add(path);
    for (const { specifier, typeOnly } of importFacts(path, readFileSync(path, "utf8"))) {
      if (typeOnly) continue;
      const resolved = resolveLocal(path, specifier);
      reached.push({ from: path, specifier, resolved });
      if (resolved !== null) queue.push(resolved);
    }
  }
  return reached;
}

describe("the engine connection string modules", () => {
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
    const planted = 'import { POSTGRES_CONNECTION_STRING } from "@/lib/db/providers/sql/postgres-connection-string";\n';
    expect(engineFindings("mysql", mysql.path, planted)).toEqual([
      `mysql: ${relative(ROOT, mysql.path)} imports @/lib/db/providers/sql/postgres-connection-string`,
    ]);
    for (const forbidden of [
      "@/lib/connection-string-parser",
      "@/lib/seed/types",
      "@/lib/db-ui-config",
      "@/lib/db/connection-string/index",
      "@/lib/db/connection-string",
      "./no-connection",
    ]) {
      expect(engineFindings("mysql", mysql.path, `import { x } from "${forbidden}";\n`)).toHaveLength(1);
    }
    expect(engineFindings("mysql", mysql.path, `import { x } from "${ACCOUNT_HOST}";\n`)).toHaveLength(1);
    const snowflake = MODULES.find(({ id }) => id === "snowflake");
    if (snowflake === undefined) throw new Error("no snowflake module");
    expect(engineFindings("snowflake", snowflake.path, `import { x } from "${ACCOUNT_HOST}";\n`)).toEqual([]);
    expect(engineFindings("snowflake", snowflake.path, 'import { x } from "./paste";\n')).toEqual([]);
    expect(
      engineFindings("snowflake", snowflake.path, 'import { x } from "@/lib/db/providers/sql/databend/paste";\n'),
    ).toHaveLength(1);
    const influxdb = MODULES.find(({ id }) => id === "influxdb");
    if (influxdb === undefined) throw new Error("no influxdb module");
    expect(engineFindings("influxdb", influxdb.path, 'import { x } from "./influxdb3-connection-string";\n')).toEqual([
      `influxdb: ${relative(ROOT, influxdb.path)} imports ./influxdb3-connection-string`,
    ]);
    expect(engineFindings("mysql", mysql.path, 'import { SSL } from "@/lib/types";\n')).toHaveLength(1);
    expect(engineFindings("mysql", mysql.path, 'import type { SSLMode } from "@/lib/types";\n')).toEqual([]);
  });

  test.each(MODULES.map(({ id, path }) => [id, path] as const))(
    "%s reaches at run time neither the parser, the registry index, nor another engine's provider module",
    (id, path) => {
      const own = ownDirectory(id, path);
      const found = reachedImports(path)
        .filter(({ resolved }) => resolved !== null)
        .filter(({ resolved }) => {
          const target = slashed(resolved as string);
          if (target === slashed(PARSER) || target === slashed(join(REGISTRY, "index.ts"))) return true;
          if (!target.startsWith(`${slashed(PROVIDERS)}/`)) return false;
          return target !== slashed(path) && (own === null || !target.startsWith(`${own}/`));
        })
        .map(({ from, specifier }) => `${relative(ROOT, from)} imports ${specifier}`);
      expect(found).toEqual([]);
    },
  );

  test("shared.ts imports only the registry's types", () => {
    const path = join(REGISTRY, "shared.ts");
    const specifiers = importFacts(path, readFileSync(path, "utf8")).map(({ specifier }) => specifier);
    expect(specifiers.filter((specifier) => specifier !== "./types" && specifier !== TYPES)).toEqual([]);
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

describe("the seed loader and the connection-field record", () => {
  const DIALOG_TABLE = join(ROOT, "src/lib/db-ui-config.ts");
  test.each(["src/lib/seed/types.ts", "src/lib/seed/connection-filter.ts", "src/lib/db/connection-fields.ts"])(
    "%s reaches neither the icon set nor the dialog's table at run time",
    (module) => {
      const found = reachedImports(join(ROOT, module))
        .filter(
          ({ specifier, resolved }) =>
            specifier === "lucide-react" || specifier.startsWith("lucide-react/") || resolved === DIALOG_TABLE,
        )
        .map(({ from, specifier }) => `${relative(ROOT, from)} imports ${specifier}`);
      expect(found).toEqual([]);
    },
  );
});

describe("a fresh process loads each module on its own", () => {
  const paths = [...MODULES.map(({ path }) => path), join(ROOT, "src/lib/db/connection-fields.ts")];
  test.each(paths.map((path) => [relative(ROOT, path), path] as const))("%s", (_, path) => {
    const run = Bun.spawnSync(["bun", "-e", `await import(${JSON.stringify(path)})`], { cwd: ROOT });
    expect(run.stderr.toString()).toBe("");
    expect(run.exitCode).toBe(0);
  });
});
