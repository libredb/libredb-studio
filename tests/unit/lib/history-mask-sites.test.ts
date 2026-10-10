/**
 * Every place that writes a query history entry passes the statement, and the error text it stores, through the
 * history mask, with the mask resolved from the connection's metadata as it stands, unknown included: an error
 * can repeat the statement it refuses.
 *
 * The mask has no effect until a dialect declares credential flags, so no behaviour test of a history site can
 * tell a masked site from an unmasked one before then. This reads the source instead, through git's own file lists
 * as `tests/unit/lib/dialect-reader-allowlist.test.ts` does, so a history write added anywhere under `src/` is
 * read the day it is written.
 */
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..", "..");
const SOURCE_FILE = /\.(c|m)?(t|j)sx?$/;
const CALL = "addToHistory(";

/**
 * The one form a history write may store its statement in: the statement through `maskStatementForHistory`, with
 * the mask `historyMaskOf` resolves from the metadata, so the window before the metadata loads takes every
 * declared flag rather than none.
 */
const MASKED_QUERY =
  /\bquery:\s*maskStatementForHistory\(\s*\w+,\s*historyMaskOf\(\s*metadata\?\.capabilities\s*\)\s*,?\s*\)/;

/**
 * The one form a history write may store its error text in: through the same mask, a value that may be absent
 * tested first. Each `errorMessage` property of a call, shorthand included, has to start this way.
 */
const MASKED_ERROR =
  /^errorMessage:\s*(?:\w+\s*===\s*undefined\s*\?\s*undefined\s*:\s*)?maskStatementForHistory\(\s*\w+,\s*historyMaskOf\(\s*metadata\?\.capabilities\s*\)\s*,?\s*\)/;

/** Each `errorMessage` property of a call's object: the name where a key stands, after `{` or `,` and any comments. */
function errorProperties(call: string): readonly string[] {
  return [...call.matchAll(/[{,](?:\s|\/\/[^\n]*\n|\/\*[^*]*\*+(?:[^/*][^*]*\*+)*\/)*(errorMessage\b)/g)].map((found) =>
    call.slice((found.index ?? 0) + found[0].length - found[1].length),
  );
}

/** The argument text of every `addToHistory(` call in one source, read to its matching parenthesis. */
function historyCalls(source: string): readonly string[] {
  const calls: string[] = [];
  for (let start = source.indexOf(CALL); start >= 0; start = source.indexOf(CALL, start + CALL.length)) {
    let depth = 0;
    let end = start + CALL.length - 1;
    for (; end < source.length; end++) {
      if (source[end] === "(") depth++;
      if (source[end] === ")") depth--;
      if (depth === 0) break;
    }
    calls.push(source.slice(start, end + 1));
  }
  return calls;
}

function sourceFiles(): readonly string[] {
  const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "src"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return listed.split("\n").filter((path) => SOURCE_FILE.test(path));
}

describe("query history sites", () => {
  const sites = sourceFiles().flatMap((path) =>
    historyCalls(readFileSync(join(ROOT, path), "utf8")).map((call) => ({ path, call })),
  );

  test("the four standalone sites are the ones found, so the check below cannot pass on nothing", () => {
    expect(sites.map((site) => site.path)).toEqual([
      "src/hooks/use-query-execution.ts",
      "src/hooks/use-query-execution.ts",
      "src/hooks/use-query-execution.ts",
      "src/hooks/use-query-execution.ts",
    ]);
  });

  test("each one stores the statement through maskStatementForHistory with the metadata's mask", () => {
    for (const site of sites) {
      expect({ path: site.path, masked: MASKED_QUERY.test(site.call) }).toEqual({ path: site.path, masked: true });
    }
  });

  test("each one stores its error text through the same mask, and three of them store one", () => {
    const properties = sites.flatMap((site) => errorProperties(site.call).map((property) => ({ ...site, property })));
    expect(properties).toHaveLength(3);
    for (const site of properties) {
      expect({ path: site.path, masked: MASKED_ERROR.test(site.property) }).toEqual({ path: site.path, masked: true });
    }
  });

  test("an error text stored as it came, shorthand or not, does not pass", () => {
    const masked = (call: string): boolean[] => errorProperties(call).map((property) => MASKED_ERROR.test(property));
    expect(masked("addToHistory({ query: q, errorMessage })")).toEqual([false]);
    expect(masked("addToHistory({ query: q, // the server's text\n errorMessage })")).toEqual([false]);
    expect(masked("addToHistory({ query: q, errorMessage: error.message })")).toEqual([false]);
    expect(
      masked(
        "addToHistory({ query: q, errorMessage: maskStatementForHistory(text, historyMaskOf(metadata?.capabilities)) })",
      ),
    ).toEqual([true]);
    expect(
      masked(
        "addToHistory({ query: q, errorMessage: text === undefined ? undefined : maskStatementForHistory(text, historyMaskOf(metadata?.capabilities)) })",
      ),
    ).toEqual([true]);
  });

  test("a property after adjacent block comments is found, and a run of them is read in linear time", () => {
    expect(errorProperties("addToHistory({ query: q, /* a *//** b **/ errorMessage })")).toEqual(["errorMessage })"]);
    const started = performance.now();
    expect(errorProperties(`,/*${"*//*".repeat(30)}*/x`)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(250);
  });

  test("the form is the whole expression: a site that drops the mask or ignores the metadata does not pass", () => {
    expect(
      MASKED_QUERY.test("addToHistory({ query: maskStatementForHistory(sql, historyMaskOf(metadata?.capabilities)) })"),
    ).toBe(true);
    expect(MASKED_QUERY.test("addToHistory({ query: maskStatementForHistory(sql, undefined) })")).toBe(false);
    expect(
      MASKED_QUERY.test("addToHistory({ query: maskStatementForHistory(sql, historyMaskOf(capabilities)) })"),
    ).toBe(false);
    expect(MASKED_QUERY.test("addToHistory({ query: sql })")).toBe(false);
  });
});
