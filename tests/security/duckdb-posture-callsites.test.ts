import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/**
 * Threat: a new route that opens a provider WITHOUT the server-derived file-access posture. A handle
 * opened with no execution context denies DuckDB's file access (fail closed), and the deny posture
 * adds a cache-key segment, so for an admin's inline file-backed DuckDB connection such a route opens
 * a SECOND read-write handle on the file beside the one the other routes share: the two-writer case
 * the non-admin DuckDB file-access change exists to prevent, where whichever handle closes last
 * checkpoints over the other's committed rows.
 *
 * `tests/api/db/duckdb-posture-routes.test.ts` pins the posture for every route it names, but that is
 * a hand-kept list: a route added without the argument is invisible to it. This is the inversion
 * `tests/security/route-auth.test.ts` and `tests/security/audit-channel-callsites.test.ts` apply,
 * for the same reason: enumerate what is on disk and require a commented reason for every call that
 * skips the posture, so a new under-postured call site is red by default rather than invisible.
 *
 * It does not reproduce route-auth's recorded weakness (H10): an allowlist entry is satisfied only by
 * the exact number of under-postured calls it declares, so adding a second one in an allowlisted file
 * is still red.
 */

const SRC_DIR = join(import.meta.dir, "..", "..", "src");

/** The two factories whose third argument is the execution context (src/lib/db/factory.ts). */
const FACTORIES = ["getOrCreateProvider", "createDatabaseProvider"] as const;

/** Every .ts/.tsx file under `rootDir`, as forward-slash paths relative to it. */
function listSources(rootDir: string): string[] {
  const files: string[] = [];
  function walk(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))
        files.push(relative(rootDir, full).split(sep).join("/"));
    }
  }
  walk(rootDir);
  if (files.length === 0) throw new Error(`no TypeScript sources found under ${rootDir}`);
  return files;
}

/**
 * Remove block and line comments so a doc example (`* const provider = await getOrCreateProvider(...)`
 * in a JSDoc block) is never counted as a call site. Replaces each comment with same-length spaces so
 * the "function " lookbehind that excludes the definitions keeps working.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

/**
 * The top-level arguments of the call that opens at `openParen` (the index of its `(`). Splits on
 * commas that are not nested inside parentheses, brackets, braces or a string, so a three-argument
 * call that spans lines is still three arguments.
 */
function callArguments(source: string, openParen: number): string[] {
  let depth = 0;
  let quote: string | null = null;
  let current = "";
  const args: string[] = [];
  for (let i = openParen; i < source.length; i++) {
    const ch = source[i];
    if (quote !== null) {
      current += ch;
      if (ch === quote && source[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      if (depth === 1 && ch === "(") continue; // the call's own opening paren
      current += ch;
      continue;
    }
    if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        if (current.trim() !== "") args.push(current.trim());
        return args;
      }
      current += ch;
      continue;
    }
    if (ch === "," && depth === 1) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  throw new Error(`unbalanced call starting at index ${openParen}`);
}

interface UnposturedCall {
  file: string;
  fn: (typeof FACTORIES)[number];
}

/** Every call of a factory, outside its own definition, that passes fewer than three arguments. */
function findUnposturedCalls(rootDir: string): UnposturedCall[] {
  const found: UnposturedCall[] = [];
  for (const file of listSources(rootDir)) {
    const source = stripComments(readFileSync(join(rootDir, file), "utf8"));
    for (const fn of FACTORIES) {
      const pattern = new RegExp(`${fn}\\s*\\(`, "g");
      for (let match = pattern.exec(source); match !== null; match = pattern.exec(source)) {
        const openParen = source.indexOf("(", match.index);
        // The function DEFINITION, not a call: `export async function getOrCreateProvider(`.
        const before = source.slice(Math.max(0, match.index - 20), match.index);
        if (/function\s+$/.test(before)) continue;
        // A longer identifier that merely ends in the name is not this function.
        const prev = source[match.index - 1] ?? "";
        if (/[A-Za-z0-9_$]/.test(prev)) continue;
        if (callArguments(source, openParen).length < 3) found.push({ file, fn });
      }
    }
  }
  return found;
}

/**
 * Every call allowed to open a provider without the execution context, with the exact number of such
 * calls the file may have. Both are capability-only reads that never call `connect()`, so no handle is
 * opened and no posture applies; anything else is a bug (pass `editorExecutionContext`).
 */
const UNPOSTURED_ALLOWLIST: Record<string, { calls: number; reason: string }> = {
  "app/api/db/query/route.ts": {
    calls: 1,
    reason:
      "a capability-only read for the EXPLAIN path: it builds the provider to ask prepareQuery for the statement and never connects, so no handle opens",
  },
  "lib/agent/runtime.ts": {
    calls: 1,
    reason:
      "a capability-only read: it builds the provider to read its capabilities for the run plan and never connects, so no handle opens",
  },
};

const UNPOSTURED = findUnposturedCalls(SRC_DIR);

describe("every provider factory call opens under the server-derived file-access posture", () => {
  test("the scan found the real call sites, so it is not vacuously green", () => {
    // A path or regex bug that found nothing would pass every assertion below. The routes do call
    // the factories, so the total number of calls (postured and not) must be well above zero.
    let total = 0;
    for (const file of listSources(SRC_DIR)) {
      const source = stripComments(readFileSync(join(SRC_DIR, file), "utf8"));
      for (const fn of FACTORIES) total += source.split(new RegExp(`\\b${fn}\\s*\\(`)).length - 1;
    }
    expect(total).toBeGreaterThan(10);
  });

  test("no file outside the allowlist calls a factory without the posture", () => {
    const offenders = UNPOSTURED.filter((call) => UNPOSTURED_ALLOWLIST[call.file] === undefined).map(
      (call) => `${call.file}: ${call.fn}`,
    );
    expect(offenders).toEqual([]);
  });

  test("each allowlisted file has exactly the number of unpostured calls its reason covers", () => {
    // H10 guard: an allowlist entry is not satisfied by the file merely being named. A file allowed
    // one unpostured call that grows a second is red here, and a file whose unpostured call was given
    // the posture (so the count drops to zero) must leave the allowlist.
    for (const [file, { calls }] of Object.entries(UNPOSTURED_ALLOWLIST)) {
      const actual = UNPOSTURED.filter((call) => call.file === file).length;
      expect([file, actual]).toEqual([file, calls]);
    }
  });
});
