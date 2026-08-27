/**
 * DuckDB driver seam guard (issue #424)
 *
 * Two rules about `@duckdb/node-api`, both enforced here by parsing every source in
 * the provider directory rather than by a list this test would have to remember to
 * update. Sibling of `tests/unit/db/libsql/seam-guard.test.ts`, which keeps the Hrana
 * envelope behind one file for the same reason.
 *
 * **Rule 1 - the driver lives in `client.ts` and nowhere else.** The provider logic,
 * the introspection and the result mapping are engine knowledge, not driver knowledge,
 * and the seam is what makes that true rather than merely intended. It is not
 * ceremony: `@duckdb/node-api` is one of several ways to reach this engine (the Wasm
 * build, a future neo API, a subprocess against the CLI), and any of them would answer
 * the same catalog questions - none of them with a `runAndReadAll`.
 *
 * **Rule 2 - the driver is never imported at module scope as a VALUE.** This is the
 * expensive one. `@duckdb/node-bindings-<platform>-<arch>` ships a ~70 MB
 * `libduckdb.so` next to its `duckdb.node`, and a top-level `import` would load it
 * into every process that touches the provider registry - the factory, the
 * capabilities route, and the fourteen engines that are not DuckDB. So the value
 * import lives inside `openDuckDBClient` and a `import type` (erased at compile time,
 * loading nothing) is the only static form allowed.
 *
 * Both rules prove their detectors in both directions below: a detector that finds
 * nothing anywhere is indistinguishable from a broken one.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PROVIDER_DIR = join(ROOT, "src", "lib", "db", "providers", "sql", "duckdb");

/** The single file allowed to know the driver. */
const CLIENT_FILE = "client.ts";

/** The packages that carry the native engine. */
const DRIVER_MODULES = ["@duckdb/node-api", "@duckdb/node-bindings"];

/**
 * Names only `@duckdb/node-api` has.
 *
 * Deliberately NOT including the neutral seam's own vocabulary. `columnNames`,
 * `columnTypes`, `rows`, `rowsChanged`, `interrupt` and `close` are fields and methods
 * of `DuckDBClient`/`DuckDBStatementResult`, which the rest of the directory is
 * supposed to use - a guard that fired on them would be crying wolf, and a guard that
 * cries wolf is a guard the next contributor deletes.
 */
const DRIVER_TOKENS = [
  "@duckdb/node-api",
  "@duckdb/node-bindings",
  "DuckDBInstance",
  "DuckDBConnection",
  "DuckDBResultReader",
  "runAndReadAll",
  "getRowObjectsJson",
  "getRowObjects",
  "disconnectSync",
  "closeSync",
  "access_mode",
];

const SEAM_RULE = [
  `The DuckDB driver leaked out of ${CLIENT_FILE}.`,
  "",
  "`@duckdb/node-api` opens a DuckDBInstance, connects a DuckDBConnection, and answers a statement with a",
  "DuckDBResultReader whose rows only survive serialization through getRowObjectsJson(). Issue #424 keeps all",
  "of that inside client.ts: provider logic reads the neutral DuckDBStatementResult (columnNames, columnTypes,",
  "rows, rowsChanged) through the DuckDBClient seam. That is what makes a second implementation - the Wasm",
  "build, a subprocess against the CLI - one new file rather than a rewrite of the provider and its",
  "introspection.",
  "",
  `Fix an access below by mapping it inside ${CLIENT_FILE} and widening DuckDBStatementResult when the value is`,
  "genuinely needed. Do not weaken or delete this test: it is the only thing keeping the seam real.",
  "",
  "Driver vocabulary outside the client:",
].join("\n");

interface Leak {
  file: string;
  line: number;
  token: string;
  snippet: string;
}

/**
 * The driver tokens this node spells out.
 *
 * Only text carries them: a module specifier, a property name, or an identifier that
 * names one. Comments are trivia rather than nodes, so prose naming the driver is
 * deliberately free - the point is that no code depends on it.
 */
function spelledTokens(node: ts.Node): string[] {
  const carriesText = ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node) || ts.isIdentifier(node);
  if (!carriesText) return [];

  const text = node.text.toLowerCase();
  return DRIVER_TOKENS.filter((token) => text.includes(token.toLowerCase()));
}

function findLeaks(file: string, source: string): Leak[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = source.split("\n");
  // One leak per line and token: an import specifier reports the same token as the
  // string literal it is, and reporting it twice reads like two problems.
  const found = new Map<string, Leak>();

  const visit = (node: ts.Node): void => {
    for (const token of spelledTokens(node)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
      found.set(`${line}:${token}`, { file, line: line + 1, token, snippet: lines[line].trim() });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...found.values()].sort((a, b) => a.line - b.line);
}

function violationReport(leaks: Leak[]): string {
  if (leaks.length === 0) return "";

  const offences = leaks.map((leak) => `  ${leak.file}:${leak.line} uses "${leak.token}" -> ${leak.snippet}`);
  return [SEAM_RULE, ...offences].join("\n");
}

/**
 * Every top-level `import` of a driver package that is NOT type-only.
 *
 * A `import type { DuckDBConnection } from "@duckdb/node-api"` is erased by the
 * compiler and loads nothing at runtime, which is why it is allowed and why the check
 * reads the clause rather than the specifier alone. `await import(...)` is an
 * expression rather than an ImportDeclaration, so the dynamic form this provider uses
 * is invisible to this walk by construction.
 */
function eagerDriverImports(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

  return sourceFile.statements
    .filter(ts.isImportDeclaration)
    .filter((statement) => {
      const specifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "";
      if (!DRIVER_MODULES.some((module) => specifier.startsWith(module))) return false;
      return statement.importClause?.isTypeOnly !== true;
    })
    .map((statement) => statement.getText(sourceFile));
}

function providerSources(): string[] {
  return readdirSync(PROVIDER_DIR, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".ts"))
    .sort();
}

function readProviderSource(file: string): string {
  return readFileSync(join(PROVIDER_DIR, file), "utf8");
}

describe("DuckDB driver seam", () => {
  const sources = providerSources();

  test("the guard scans the whole provider directory", () => {
    expect(sources).toContain(CLIENT_FILE);
    expect(sources.length).toBeGreaterThan(1);
  });

  // A detector that finds nothing anywhere is indistinguishable from a broken one, so
  // the file that is SUPPOSED to speak to the driver must light it up.
  test.each(["@duckdb/node-api", "DuckDBInstance", "DuckDBConnection", "runAndReadAll", "getRowObjectsJson"])(
    "the client itself uses %s, proving the detector reads real code",
    (token) => {
      const tokens = findLeaks(CLIENT_FILE, readProviderSource(CLIENT_FILE)).map((leak) => leak.token);

      expect(tokens).toContain(token);
    },
  );

  test(`the driver is used only in ${CLIENT_FILE}`, () => {
    const leaks = sources
      .filter((file) => file !== CLIENT_FILE)
      .flatMap((file) => findLeaks(file, readProviderSource(file)));

    expect(violationReport(leaks)).toBe("");
  });
});

describe("the driver is never loaded at module scope", () => {
  test("no file in the provider directory imports it eagerly", () => {
    // ~70 MB of native library per process that touches the provider registry is what
    // this one line prevents.
    const eager = providerSources().flatMap((file) =>
      eagerDriverImports(file, readProviderSource(file)).map((text) => `${file}: ${text}`),
    );

    expect(eager).toEqual([]);
  });

  test("the client reaches the driver through a dynamic import inside a function", () => {
    const source = readProviderSource(CLIENT_FILE);

    expect(source).toContain('await import("@duckdb/node-api")');
  });

  test("the detector allows a type-only import and rejects a value one", () => {
    const TYPE_ONLY = 'import type { DuckDBConnection } from "@duckdb/node-api";';
    const VALUE = 'import { DuckDBInstance } from "@duckdb/node-api";';
    const NAMESPACE = 'import * as duck from "@duckdb/node-bindings";';
    const UNRELATED = 'import { readFileSync } from "node:fs";';

    expect(eagerDriverImports("sample.ts", TYPE_ONLY)).toEqual([]);
    expect(eagerDriverImports("sample.ts", UNRELATED)).toEqual([]);
    expect(eagerDriverImports("sample.ts", VALUE)).toEqual([VALUE]);
    expect(eagerDriverImports("sample.ts", NAMESPACE)).toEqual([NAMESPACE]);
  });
});

describe("the seam-guard detector", () => {
  /**
   * Everything a compliant provider file legitimately does: name the driver in prose,
   * and read the NEUTRAL result. None of it is a leak, and none of it may fire.
   */
  const COMPLIANT_SAMPLE = `
/**
 * Prose may name the driver: DuckDBInstance, runAndReadAll and getRowObjectsJson all
 * stay behind the seam, and so does access_mode.
 */
import type { DuckDBClient } from "./client";

const TABLES = "SELECT table_name FROM duckdb_tables()";

export async function readTables(client: DuckDBClient) {
  const result = await client.run(TABLES);
  return { names: result.columnNames, types: result.columnTypes, rows: result.rows, changed: result.rowsChanged };
}
`;

  const VIOLATING_SAMPLE = `
import { DuckDBInstance } from "@duckdb/node-api";

export async function open(path: string) {
  const instance = await DuckDBInstance.create(path, { access_mode: "READ_ONLY" });
  const connection = await instance.connect();
  const reader = await connection.runAndReadAll("SELECT 1");
  return reader.getRowObjectsJson();
}
`;

  test("passes a file that stays behind the seam", () => {
    expect(findLeaks("introspect.ts", COMPLIANT_SAMPLE)).toEqual([]);
  });

  test("reports every crossing in a file that does not, with the rule attached", () => {
    const leaks = findLeaks("introspect.ts", VIOLATING_SAMPLE);

    expect([...new Set(leaks.map((leak) => leak.token))].sort()).toEqual([
      "@duckdb/node-api",
      "DuckDBInstance",
      "access_mode",
      // `getRowObjects` is a substring of `getRowObjectsJson` and is matched in its own
      // right: it is the reader that throws on JSON.stringify ("Do not know how to
      // serialize a BigInt"), so naming it anywhere is worth reporting on its own.
      "getRowObjects",
      "getRowObjectsJson",
      "runAndReadAll",
    ]);
    expect(violationReport(leaks)).toContain("The DuckDB driver leaked out of");
    expect(violationReport(leaks)).toContain('uses "DuckDBInstance"');
  });
});
