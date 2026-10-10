import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import ts from "typescript";

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

interface FactoryCall {
  fn: (typeof FACTORIES)[number];
  /** The number of arguments the call passes; the third is the execution context. */
  args: number;
}

/**
 * Every call of a factory in `source`, read by the TypeScript parser rather than by text: a comment
 * or a string is not code to the parser, so a doc example (`* const provider = await
 * getOrCreateProvider(...)` in a JSDoc block) or a quoted name is never counted, and a `//` or `/*`
 * inside a string (a URL) cannot hide a real call after it on the same line. The definition is a
 * function declaration, not a call, and a longer name that ends in a factory's is another identifier.
 * A call through a module object (`factory.getOrCreateProvider(...)`) is counted like a bare one.
 */
function factoryCalls(file: string, source: string): FactoryCall[] {
  // By extension: a `.ts` file parsed as TSX would misread an angle-bracket cast (`<T>value`).
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, false, kind);
  const calls: FactoryCall[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const name = ts.isIdentifier(callee)
        ? callee.text
        : ts.isPropertyAccessExpression(callee)
          ? callee.name.text
          : null;
      const fn = FACTORIES.find((factory) => factory === name);
      if (fn !== undefined) calls.push({ fn, args: node.arguments.length });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return calls;
}

interface UnposturedCall {
  file: string;
  fn: (typeof FACTORIES)[number];
}

/** Every call of a factory that passes fewer than three arguments, in every source under `rootDir`. */
function findUnposturedCalls(rootDir: string): UnposturedCall[] {
  return listSources(rootDir).flatMap((file) =>
    factoryCalls(file, readFileSync(join(rootDir, file), "utf8"))
      .filter((call) => call.args < 3)
      .map((call) => ({ file, fn: call.fn })),
  );
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
      "a capability-only read for the key-walk database field: it builds the provider to read its keyScan declaration and containerDepth before any socket, and never connects, so no handle opens",
  },
  "lib/agent/runtime.ts": {
    calls: 1,
    reason:
      "a capability-only read: it builds the provider to read its capabilities for the run plan and never connects, so no handle opens",
  },
  "app/api/agent/runs/route.ts": {
    calls: 1,
    reason:
      "a capability-only read for the run's catalog field (#1530): it builds the provider to read its catalogSessions declaration before the run exists, and never connects, so no handle opens",
  },
};

const UNPOSTURED = findUnposturedCalls(SRC_DIR);

describe("every provider factory call opens under the server-derived file-access posture", () => {
  test("the scan found the real call sites, so it is not vacuously green", () => {
    // A path or parse bug that found nothing would pass every assertion below. The routes do call
    // the factories, so the total number of calls (postured and not) must be well above zero.
    const total = listSources(SRC_DIR).reduce(
      (sum, file) => sum + factoryCalls(file, readFileSync(join(SRC_DIR, file), "utf8")).length,
      0,
    );
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

describe("the census detector, proven in both directions on scratch sources", () => {
  const scratch = mkdtempSync(join(tmpdir(), "libredb-posture-census-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  /** The unpostured calls the detector finds in one scratch file holding `source`. */
  function detect(source: string): UnposturedCall[] {
    const dir = mkdtempSync(join(scratch, "case-"));
    writeFileSync(join(dir, "route.ts"), source);
    return findUnposturedCalls(dir);
  }

  test.each([
    ["a bare call", "const p = await getOrCreateProvider(connection);"],
    [
      "a call with two arguments over several lines",
      "const p = await createDatabaseProvider(\n  connection,\n  {},\n);",
    ],
    ["a call through a module object", "const p = await factory.getOrCreateProvider(connection, {});"],
    [
      "a call after a URL string on the same line",
      'const docs = "https://example.test/x"; const p = await getOrCreateProvider(connection);',
    ],
    [
      "a call between strings that hold a block-comment opener and closer",
      'const open = "src/*"; getOrCreateProvider(connection); const close = "*/";',
    ],
  ])("%s is found", (_label, source) => {
    expect(detect(source)).toHaveLength(1);
  });

  test.each([
    [
      "a call with the posture",
      "const p = await getOrCreateProvider(connection, {}, editorExecutionContext(s, connection));",
    ],
    ["a call in a line comment", "// const p = await getOrCreateProvider(connection);"],
    ["a call in a doc comment", "/**\n * const p = await getOrCreateProvider(connection);\n */"],
    ["a call named inside a string", 'const hint = "getOrCreateProvider(connection)";'],
    ["a call named inside a template literal", "const hint = `use getOrCreateProvider(connection)`;"],
    ["the definition", "export async function getOrCreateProvider(connection: unknown) { return connection; }"],
    ["a longer name that ends in the factory's", "const p = await myGetOrCreateProvider(connection);"],
  ])("%s is not found", (_label, source) => {
    expect(detect(source)).toEqual([]);
  });
});
