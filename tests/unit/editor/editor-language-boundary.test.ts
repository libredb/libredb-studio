/**
 * An editor language is a contribution its owner declares, and the shared editor reads only the registry of them.
 *
 * Three rules hold that shape, each read from the source files git lists, so a file added later is read too:
 *
 * 1. No file under `src/components/`, `src/hooks/` or `src/lib/editor/` imports a module under
 *    `src/lib/db/providers/`. A language's lexer, route table or completion source is reached through its
 *    contribution in `src/lib/db/editor-language/`, never by the shared UI naming a provider's internals.
 * 2. A `register<Name>Language(...)` call appears in the registry module only, and a
 *    `register<Name>CompletionProvider(...)` call only in an editor language row (a file under
 *    `src/lib/db/editor-language/` or a provider's `editor-language.ts`). Every other mention is the function's own
 *    declaration, so a mount that registers one language or one completion source by hand fails here.
 * 3. The shared UI spells no union of editor language ids: `EditorLanguage` is the registry's key set, and every
 *    other language type is derived from it, so a new language is one registry row and no hand-kept union.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SOURCE_FILE = /\.(c|m)?(t|j)sx?$/;
const SHARED_UI = ["src/components/", "src/hooks/", "src/lib/editor/"];
const PROVIDERS = "src/lib/db/providers/";
const REGISTRY_DIR = "src/lib/db/editor-language/";
const REGISTRY_MODULE = "src/lib/db/editor-language/index.ts";
/** A provider's editor language row: the file that declares the contribution, `editor-language.ts` or `<x>-editor-language.ts`. */
const PROVIDER_ROW = /^src\/lib\/db\/providers\/.+(?:\/|-)editor-language\.ts$/;

/** Every source file git lists under `src/`, tracked or untracked but not ignored. */
function sourceFiles(): string[] {
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "src"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return listed
    .split("\n")
    .filter((path) => SOURCE_FILE.test(path) && existsSync(join(ROOT, path)))
    .sort();
}

const IMPORT_SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|mock\.module\s*\(\s*)["']([^"']+)["']/g;

/** Each module a file imports, as a path from the repository root; a package import is left out. */
export function importedPaths(path: string, text: string): string[] {
  const paths: string[] = [];
  for (const match of text.matchAll(IMPORT_SPECIFIER)) {
    const specifier = match[1];
    if (specifier.startsWith("@/")) paths.push(`src/${specifier.slice(2)}`);
    else if (specifier.startsWith(".")) paths.push(normalize(join(dirname(path), specifier)));
  }
  return paths;
}

/** The `register<Name><suffix>(` calls in a text, its declarations left out. */
function registerCalls(text: string, suffix: string): string[] {
  const call = new RegExp(`\\bregister[A-Za-z0-9]*${suffix}\\s*\\(`, "g");
  const declaration = new RegExp(`\\bfunction\\s+register[A-Za-z0-9]*${suffix}\\s*\\($`);
  const calls: string[] = [];
  for (const match of text.matchAll(call)) {
    const upTo = text.slice(Math.max(0, match.index - 20), match.index + match[0].length);
    if (!declaration.test(upTo)) calls.push(match[0].replace(/\s*\($/, ""));
  }
  return calls;
}

/** The `register<Name>Language(` calls in a text, its declarations left out. */
export function registerLanguageCalls(text: string): string[] {
  return registerCalls(text, "Language");
}

/** The `register<Name>CompletionProvider(` calls in a text, its declarations left out. */
export function registerCompletionCalls(text: string): string[] {
  return registerCalls(text, "CompletionProvider");
}

const UNION_RUN = /(?:\|\s*"[\w-]+"\s*)+/g;

/** The string-literal union runs in a text that spell at least `min` of the given ids. */
export function literalUnionsOver(text: string, ids: ReadonlySet<string>, min: number): string[][] {
  const runs: string[][] = [];
  for (const match of text.matchAll(UNION_RUN)) {
    const members = [...match[0].matchAll(/"([\w-]+)"/g)].map((member) => member[1]);
    const hits = [...new Set(members.filter((member) => ids.has(member)))];
    if (hits.length >= min) runs.push(hits);
  }
  return runs;
}

describe("the helpers read what they claim", () => {
  test("importedPaths resolves alias, relative and dynamic imports and leaves packages out", () => {
    const text = [
      'import { a } from "@/lib/db/providers/keyvalue/etcd/lexer";',
      'import type * as Monaco from "monaco-editor";',
      'import { b } from "../db/providers/objectstore/s3/names";',
      'const c = await import("./sql-completions");',
    ].join("\n");
    expect(importedPaths("src/lib/editor/x.ts", text)).toEqual([
      "src/lib/db/providers/keyvalue/etcd/lexer",
      "src/lib/db/providers/objectstore/s3/names",
      "src/lib/editor/sql-completions",
    ]);
  });

  test("registerLanguageCalls finds calls and skips a declaration", () => {
    const text = [
      "export function registerEtcdLanguage(monaco) {}",
      "registerEtcdLanguage(monaco);",
      "registerConsoleLanguage (monaco, language);",
    ].join("\n");
    expect(registerLanguageCalls(text)).toEqual(["registerEtcdLanguage", "registerConsoleLanguage"]);
  });

  test("registerCompletionCalls finds calls and skips a declaration", () => {
    const text = [
      "export function registerSQLCompletionProvider(monaco, cache) {}",
      "const disposable = registerSQLCompletionProvider(monaco, cache);",
      "registerS3CompletionProvider (monaco, buckets);",
    ].join("\n");
    expect(registerCompletionCalls(text)).toEqual(["registerSQLCompletionProvider", "registerS3CompletionProvider"]);
  });

  test("literalUnionsOver finds a run that spells the ids and ignores one that spells too few", () => {
    const ids = new Set(["sql", "json", "redis"]);
    expect(literalUnionsOver('type A = | "sql" | "json" | "redis";', ids, 3)).toEqual([["sql", "json", "redis"]]);
    expect(literalUnionsOver('type B = "x" | "sql" | "json";', ids, 3)).toEqual([]);
  });
});

describe("the editor language boundary", () => {
  const files = sourceFiles();

  test("the scan reads the shared UI and the registry module", () => {
    expect(files).toContain("src/components/QueryEditor.tsx");
    expect(files).toContain("src/lib/editor/tab-language.ts");
    expect(files).toContain(REGISTRY_MODULE);
  });

  test("no file under src/components, src/hooks or src/lib/editor imports a provider module", () => {
    const offenders = files
      .filter((path) => SHARED_UI.some((prefix) => path.startsWith(prefix)))
      .flatMap((path) =>
        importedPaths(path, readFileSync(join(ROOT, path), "utf8"))
          .filter((imported) => imported.startsWith(PROVIDERS))
          .map((imported) => `${path} -> ${imported}`),
      );
    expect(offenders).toEqual([]);
  });

  test("a register<Name>Language call appears in the registry module only", () => {
    const offenders = files
      .filter((path) => path !== REGISTRY_MODULE)
      .flatMap((path) =>
        registerLanguageCalls(readFileSync(join(ROOT, path), "utf8")).map((call) => `${path}: ${call}`),
      );
    expect(offenders).toEqual([]);
    // The control: the registry module does register, so an empty list above is not a scan that reads nothing.
    expect(registerLanguageCalls(readFileSync(join(ROOT, REGISTRY_MODULE), "utf8")).length).toBeGreaterThan(0);
  });

  test("a register<Name>CompletionProvider call appears in an editor language row only", () => {
    const isRow = (path: string) => path.startsWith(REGISTRY_DIR) || PROVIDER_ROW.test(path);
    const offenders = files
      .filter((path) => !isRow(path))
      .flatMap((path) =>
        registerCompletionCalls(readFileSync(join(ROOT, path), "utf8")).map((call) => `${path}: ${call}`),
      );
    expect(offenders).toEqual([]);
    // The control: the rows do register completion sources, so an empty list above is not a scan that reads nothing.
    const fromRows = files
      .filter(isRow)
      .flatMap((path) => registerCompletionCalls(readFileSync(join(ROOT, path), "utf8")));
    expect(fromRows.length).toBeGreaterThan(0);
  });

  test("the shared UI spells no union of editor language ids", async () => {
    const { EDITOR_LANGUAGES } = await import("@/lib/db/editor-language");
    const ids: ReadonlySet<string> = new Set(Object.keys(EDITOR_LANGUAGES));
    const offenders = files
      .filter((path) => SHARED_UI.some((prefix) => path.startsWith(prefix)) && !path.startsWith(REGISTRY_DIR))
      .flatMap((path) =>
        literalUnionsOver(readFileSync(join(ROOT, path), "utf8"), ids, 3).map((run) => `${path}: ${run.join(", ")}`),
      );
    expect(offenders).toEqual([]);
  });
});
