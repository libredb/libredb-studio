/**
 * The UI does not keep per-engine tables, and the Create Table form knows no engine (#1822).
 *
 * The Create Table form once held its grammar as a `Record<DatabaseType, ...>` inside the component, beside a
 * separate `supportsCreateTable` flag on the provider, and the two disagreed: a provider could say yes with no row,
 * and the form threw or wrote PostgreSQL DDL for another engine (#648). The grammar now lives on the provider as
 * `capabilities.createTable`, so this file holds three things to that shape:
 *
 * 1. no table keyed by a type id under `src/components/` or `src/hooks/`, apart from a closed list of debt that
 *    names its backlog entry, where a listed entry that no longer exists fails too;
 * 2. `src/components/CreateTableModal.tsx` imports no `DatabaseType`, has no `dbType`, and spells no type id;
 * 3. the removed `supportsCreateTable` flag is named nowhere under `src/`, `tests/` or `docs/`, apart from this
 *    file and the history in `docs/BACKLOG.md`.
 *
 * It reads the repository's files through git's own lists (tracked, and untracked but not ignored), as
 * `tests/unit/lib/dialect-reader-allowlist.test.ts` does, so a new file is read the day it is written.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { EXTERNAL_DATABASE_TYPES } from "@/lib/db/compatibility";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SOURCE_FILE = /\.(c|m)?(t|j)sx?$/;
const THIS_FILE = "tests/unit/components/no-engine-tables-in-ui.test.ts";
const CREATE_TABLE_MODAL = "src/components/CreateTableModal.tsx";

/**
 * A `Record`, `Set` or `Map` keyed by a type id, or a mapped type over one, the shapes of a per-engine table.
 * `\s*` spans newlines, so a type argument the formatter wraps onto the next line still matches when the pattern
 * runs over a whole file. This is wider than design section 6, which named only `Record` and `Set`, on purpose.
 * A key spelled through a type alias of `DatabaseType` is still not caught.
 */
const ENGINE_TABLE =
  /(Record|Set|Map)<\s*(DatabaseType|DatabaseConnection\["type"\])|\[\s*\w+\s+in\s+(DatabaseType|DatabaseConnection\["type"\])\s*\]/;

/** A per-engine table the UI still keeps, by file and constant name, with the backlog entry that moves it. */
interface Allowed {
  readonly path: string;
  readonly name: string;
  readonly owner: string;
}

const INLINE_EDITING_DEBT =
  "the inline editor's per-engine value rules, which move to capabilities under the docs/BACKLOG.md entry filed with #1822";

/** The closed list. */
const ALLOWED: readonly Allowed[] = [
  { path: "src/hooks/use-inline-editing.ts", name: "NO_INSTANT_TYPE_DIALECTS", owner: INLINE_EDITING_DEBT },
  { path: "src/hooks/use-inline-editing.ts", name: "FLOAT64_ONLY_DIALECTS", owner: INLINE_EDITING_DEBT },
  { path: "src/hooks/use-inline-editing.ts", name: "NO_EXACT_DECIMAL_DIALECTS", owner: INLINE_EDITING_DEBT },
];

/** Every file git lists under `paths`: tracked, or untracked and not ignored. */
function listedFiles(...paths: string[]): string[] {
  const listed = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return [...new Set(listed.split("\0"))].filter((path) => path !== "" && existsSync(join(ROOT, path))).sort();
}

/**
 * The text with its comments blanked and its line count kept: a block comment becomes its own newlines, and a line
 * comment goes from `//` to the end of its line unless the `//` follows a colon or a quote (a URL in a string).
 */
function withoutComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ""))
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

/** Each 1-based line on which a per-engine table in `text` starts, once per line, matched over the whole text. */
function tableLines(text: string): number[] {
  const all = new RegExp(ENGINE_TABLE.source, "g");
  return [...new Set([...text.matchAll(all)].map((match) => text.slice(0, match.index).split("\n").length))];
}

/** Every per-engine table under the UI directories that the closed list does not hold, and every listed one gone. */
function engineTableFindings(): string[] {
  const unmatched = [...ALLOWED];
  const findings: string[] = [];
  for (const path of listedFiles("src/components", "src/hooks").filter((file) => SOURCE_FILE.test(file))) {
    const text = withoutComments(readFileSync(join(ROOT, path), "utf8"));
    const lines = text.split("\n");
    for (const number of tableLines(text)) {
      const line = lines[number - 1];
      const at = unmatched.findIndex((allowed) => allowed.path === path && line.includes(`const ${allowed.name}`));
      if (at === -1) findings.push(`unlisted ${path}:${number} ${line.trim()}`);
      else unmatched.splice(at, 1);
    }
  }
  for (const gone of unmatched) findings.push(`listed but absent ${gone.path}: ${gone.name} (${gone.owner})`);
  return findings;
}

describe("per-engine tables in the UI (#1822)", () => {
  test("are exactly the closed list, each naming the backlog entry that moves it", () => {
    expect(engineTableFindings()).toEqual([]);
  });

  test("the table pattern matches both key spellings, so the list above is not empty by accident", () => {
    expect(ENGINE_TABLE.test("const X: Partial<Record<DatabaseType, Y>> = {};")).toBe(true);
    expect(ENGINE_TABLE.test('const X: ReadonlySet<DatabaseConnection["type"]> = new Set();')).toBe(true);
    expect(ENGINE_TABLE.test("const X: ReadonlySet<string> = new Set();")).toBe(false);
  });

  test("the table pattern matches a Map, a mapped type and a type argument wrapped onto the next line", () => {
    expect(tableLines("const X: Map<DatabaseType, string> = new Map();")).toEqual([1]);
    expect(tableLines("const X: { [K in DatabaseType]?: string } = {};")).toEqual([1]);
    expect(tableLines('const X: { [key in DatabaseConnection["type"]]: string } = {};')).toEqual([1]);
    expect(tableLines("const a = 1;\nconst X: Record<\n  DatabaseType,\n  string\n> = {};\n")).toEqual([2]);
    expect(tableLines("const X: Map<string, DatabaseType> = new Map();")).toEqual([]);
    expect(tableLines("const X: ReadonlySet<DatabaseType> = new Set<DatabaseType>();")).toEqual([1]);
  });

  test("a table in a comment is not a table", () => {
    const text = "/**\n * Record<DatabaseType, X>\n */\n// Set<DatabaseType>\nconst a = 1;\n";
    expect(withoutComments(text).split("\n")).toHaveLength(text.split("\n").length);
    expect(ENGINE_TABLE.test(withoutComments(text))).toBe(false);
  });
});

describe("the Create Table form knows no engine (#1822)", () => {
  const source = withoutComments(readFileSync(join(ROOT, CREATE_TABLE_MODAL), "utf8"));

  test("imports no DatabaseType and takes no dbType", () => {
    expect(source.match(/\b(DatabaseType|dbType)\b/g) ?? []).toEqual([]);
  });

  test("spells no type id as a string literal", () => {
    const ids = [...EXTERNAL_DATABASE_TYPES, "libredb"];
    const spelled = ids.filter((id) => ['"', "'", "`"].some((quote) => source.includes(`${quote}${id}${quote}`)));
    expect(spelled).toEqual([]);
  });
});

describe("the removed supportsCreateTable flag (#1822)", () => {
  test("is named nowhere under src, tests or docs", () => {
    const exempt = new Set([THIS_FILE, "docs/BACKLOG.md"]);
    const named = listedFiles("src", "tests", "docs")
      .filter((path) => !exempt.has(path))
      .filter((path) => readFileSync(join(ROOT, path), "utf8").includes("supportsCreateTable"));
    expect(named, "declare `createTable` in the provider's capabilities").toEqual([]);
  });
});
