/**
 * The engine SQL writing modules as they sit on disk, found by walking the provider tree
 * rather than read off the registry, so the seam and isolation tests check the registry
 * against the files and not the files against themselves.
 *
 * A module is a file named `sql-writing.ts` or `<id>-sql-writing.ts` under
 * `src/lib/db/providers/` (spec 5.3), and its type id is read from its one
 * `export const <ID>_SQL_WRITING`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

export const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PROVIDERS = join(ROOT, "src", "lib", "db", "providers");

export interface EngineModule {
  /** The type id, `MYSQL_SQL_WRITING` read as `mysql`. */
  readonly id: string;
  /** The export the module declares its spec under. */
  readonly exportName: string;
  readonly absPath: string;
  /** The path from the repo root, `src/lib/db/providers/sql/mysql-sql-writing.ts`. */
  readonly repoPath: string;
}

const EXPORT = /^export const ([A-Z0-9]+)_SQL_WRITING\b/gm;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return entry.name === "sql-writing.ts" || entry.name.endsWith("-sql-writing.ts") ? [full] : [];
  });
}

export const ENGINE_MODULES: readonly EngineModule[] = walk(PROVIDERS)
  .sort()
  .map((absPath) => {
    const repoPath = relative(ROOT, absPath).split("\\").join("/");
    const names = [...readFileSync(absPath, "utf8").matchAll(EXPORT)].map((match) => match[1]);
    if (names.length !== 1) throw new Error(`${repoPath} declares ${names.length} *_SQL_WRITING exports, expected 1`);
    return { id: names[0].toLowerCase(), exportName: `${names[0]}_SQL_WRITING`, absPath, repoPath };
  });

export interface TypedLiteralModule {
  /** The type id of the engine module that owns it. */
  readonly ownerId: string;
  readonly absPath: string;
  /** The path from the repo root, `src/lib/db/providers/sql/postgres-typed-literals.ts`. */
  readonly repoPath: string;
}

/**
 * The siblings an engine's typed writer lives in (spec 5.3), found on disk the same way:
 * `typed-literals.ts` beside an `<id>/sql-writing.ts`, `<id>-typed-literals.ts` beside an
 * `<id>-sql-writing.ts`. A sibling with no engine module to own it is an error.
 */
export const TYPED_LITERAL_MODULES: readonly TypedLiteralModule[] = (function find(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return find(full);
    return entry.name === "typed-literals.ts" || entry.name.endsWith("-typed-literals.ts") ? [full] : [];
  });
})(PROVIDERS)
  .sort()
  .map((absPath) => {
    const repoPath = relative(ROOT, absPath).split("\\").join("/");
    const ownerPath = absPath.replace(/typed-literals\.ts$/, "sql-writing.ts");
    const owner = ENGINE_MODULES.find((engine) => engine.absPath === ownerPath);
    if (owner === undefined) throw new Error(`${repoPath} has no engine module beside it to own it`);
    return { ownerId: owner.id, absPath, repoPath };
  });
