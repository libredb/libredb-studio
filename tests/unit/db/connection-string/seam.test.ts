/**
 * The seam around each engine's connection string module: an engine module reads only the registry's leaves
 * (`types`, `shared`) and the modules of its own provider directory (Snowflake's browser-safe `account-host`, a paste
 * reader beside its provider), never the parser, the seed loader, the dialog's table, the registry index or another
 * engine's module, so one engine's URL TLS reader, paste reader or seed check can never reach another's output. Only an
 * engine whose declaration names a connection string function has a module: the registry index imports its
 * `<ID>_URL_TLS`, `<ID>_PASTE_READER` and `<ID>_SEED_CHECK` exports. The seed loader and the connection-field record
 * reach neither the icon set nor the dialog's table at run time, and every module loads in a fresh process on its own.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import ts from "typescript";
import { BUNDLED_CONNECTION_STRINGS } from "@/lib/db/engine-catalog/connection-string.generated";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const REGISTRY = join(ROOT, "src/lib/db/connection-string");
/** The engines whose declaration names a URL TLS reader, a paste reader or a seed check. */
const NAMING: readonly string[] = Object.entries(BUNDLED_CONNECTION_STRINGS)
  .filter(([, entry]) => entry.urlTls !== null || entry.paste !== null || entry.seedCheck !== null)
  .map(([id]) => id)
  .sort();
/** An export the registry index binds: an engine's id, upper-cased, then the slot it fills. */
const BOUND_EXPORT = /^([A-Z0-9]+)_(URL_TLS|PASTE_READER|SEED_CHECK)$/;

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

/**
 * The repository file a specifier names, or null for a package. A JSON import names its file with its extension (the
 * root package.json, which src/lib/provider-host/legacy-adapter/identity.ts reads for its version).
 */
function resolveLocal(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? join(ROOT, "src", specifier.slice(2))
    : specifier.startsWith(".")
      ? join(dirname(from), specifier)
      : null;
  if (base === null) return null;
  if (extname(base) === ".json" && existsSync(base)) return base;
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`${specifier}, imported by ${from}, resolves to no file`);
}

/** The engine modules as the registry index imports them, keyed by the type id their exports name, each once. */
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
    const ids = new Set(
      bindings.elements.map((element) => {
        const bound = BOUND_EXPORT.exec(element.name.text);
        if (bound === null)
          throw new Error(`${specifier} exports ${element.name.text}, which the index binds no slot to`);
        return (bound[1] as string).toLowerCase();
      }),
    );
    if (ids.size !== 1) throw new Error(`${specifier} exports the functions of ${[...ids].join(", ")}`);
    found.push({ id: [...ids][0] as string, specifier, path: resolveLocal(index, specifier) as string });
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

/**
 * Every value import the run-time graph of `entry` reaches, followed through repository files, with its importer. A
 * JSON file is a leaf: it imports nothing.
 */
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
      if (resolved !== null && extname(resolved) !== ".json") queue.push(resolved);
    }
  }
  return reached;
}

describe("the engine connection string modules", () => {
  test("the registry index imports the module of exactly the engines whose declaration names a connection string function, each once", () => {
    expect(MODULES.map(({ id }) => id).sort()).toEqual([...NAMING]);
    expect(new Set(MODULES.map(({ specifier }) => specifier)).size).toBe(NAMING.length);
    expect(NAMING.length).toBe(15);
  });

  test.each(MODULES.map(({ id, path }) => [id, path] as const))("%s imports only the registry's leaves", (id, path) => {
    expect(engineFindings(id, path, readFileSync(path, "utf8"))).toEqual([]);
  });

  test("an engine module that imports another engine's module fails by name", () => {
    const mysql = MODULES.find(({ id }) => id === "mysql");
    if (mysql === undefined) throw new Error("no mysql module");
    const planted = 'import { POSTGRES_PASTE_READER } from "@/lib/db/providers/sql/postgres-connection-string";\n';
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
    // A flat module shares its directory with other engines, so a sibling engine's module there is another engine's.
    expect(engineFindings("mysql", mysql.path, 'import { x } from "./postgres-connection-string";\n')).toEqual([
      `mysql: ${relative(ROOT, mysql.path)} imports ./postgres-connection-string`,
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

  test("no engine module imports the no-connection spec", () => {
    const targets = new Set([join(REGISTRY, "no-connection.ts")]);
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
