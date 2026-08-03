/**
 * ClickHouse transport seam guard (issue #264, design spec 3.3)
 *
 * The ClickHouse provider is worth building without a client library only while
 * swapping the transport stays cheap, and it stays cheap only while the HTTP
 * envelope lives in exactly one file. This test is the mechanism that keeps that
 * true: it parses every source in the provider directory and fails the build the
 * moment the wire vocabulary is used outside http-transport.ts. It reads the
 * directory from disk rather than from a list, so it keeps holding as the provider
 * grows.
 *
 * The guard is a parser, not a grep, and it sorts the vocabulary into two classes
 * because the two need opposite treatment - established against the live server
 * (26.7.1.1315) rather than guessed:
 *
 *   SELECT DISTINCT name FROM system.columns
 *   WHERE name IN ('written_rows', 'elapsed_ns', 'statistics',
 *                  'rows_before_limit_at_least', 'default_format')
 *
 * returned `written_rows` (a column of system.processes and system.query_log) and
 * `statistics` (a column of system.columns) - both surfaces the monitoring and
 * introspection code legitimately queries by name. Those two are therefore
 * detected only as a READ off a payload, never as text, so `SELECT written_rows
 * FROM system.query_log` does not fire. Everything else in the vocabulary exists
 * nowhere in the server's own schema, so it is matched as text and a mention
 * anywhere outside the transport is a leak. A guard that cries wolf is a guard the
 * next contributor deletes, so both directions are proven below: the detector must
 * light up on the file that is SUPPOSED to speak HTTP, and stay silent on a
 * compliant one.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PROVIDER_DIR = join(ROOT, "src", "lib", "db", "providers", "sql", "clickhouse");

/** The single file allowed to know the wire format. */
const TRANSPORT_FILE = "http-transport.ts";

/**
 * Identifiers that exist nowhere in ClickHouse's own schema and nowhere in
 * English: two request parameters, three response headers, and the one envelope
 * field the seam deliberately drops (spec 2.6). Naming any of them outside the
 * transport - in a string, a header lookup or a variable - is a leak, so these are
 * matched as text, case-insensitively, because `Headers.get` is case-insensitive
 * and the transport spells them in lower case.
 */
const WIRE_TOKENS = [
  "X-ClickHouse-Summary",
  "X-ClickHouse-Exception-Code",
  // How a mid-stream failure is told apart from result data that says
  // `__exception__` (spec 2.8). Wire vocabulary like any other header.
  "X-ClickHouse-Exception-Tag",
  "X-ClickHouse-Format",
  "default_format",
  "output_format_json_quote_64bit_integers",
  "elapsed_ns",
  "rows_before_limit_at_least",
];

/**
 * Envelope and summary fields that are ALSO live column names, so text matching
 * would fire on legitimate SQL. Reading one off a payload is still a leak: the
 * neutral result calls them `mutationCount` and `executionTimeMs`.
 */
const ENVELOPE_FIELDS = new Set(["written_rows", "statistics"]);

/** Everything the transport must speak, and nothing else may. */
const WIRE_VOCABULARY = [...WIRE_TOKENS, ...ENVELOPE_FIELDS];

/**
 * Why the rule exists, printed on failure. Whoever trips this needs to see the
 * boundary they are crossing, otherwise the cheapest fix looks like deleting the
 * test.
 */
const SEAM_RULE = [
  `The ClickHouse HTTP envelope leaked out of ${TRANSPORT_FILE}.`,
  "",
  "ClickHouse's HTTP interface asks for a format through default_format, reports what it actually",
  "used in X-ClickHouse-Format, hides the row counts of a write in X-ClickHouse-Summary and wraps",
  "rows in { meta, data, statistics }. Issue #264 keeps all of that inside the transport: provider",
  "logic reads the neutral ClickHouseQueryResult (rows, fieldNames, columnTypes, executionTimeMs,",
  "mutationCount, rawText) through the ClickHouseTransport seam. That is what makes adopting a",
  "native-protocol client later one new file implementing the same interface, instead of a rewrite of",
  "the provider, the introspection and the explain strategy.",
  "",
  `Fix an access below by mapping the field inside ${TRANSPORT_FILE} and widening ClickHouseQueryResult`,
  "when the value is genuinely needed. If you tripped this on SQL rather than on the wire - system.processes",
  "and system.query_log really do have a written_rows column, and system.columns a statistics column - read",
  "it under an alias (`written_rows AS writtenRows`) so one layer keeps one vocabulary. Do not weaken or",
  "delete this test: it is the only thing keeping the seam real.",
  "",
  "Wire vocabulary outside the transport:",
].join("\n");

interface WireLeak {
  file: string;
  line: number;
  token: string;
  snippet: string;
}

/**
 * The wire tokens this node spells out.
 *
 * Only text carries them: a header lookup (`headers.get("x-clickhouse-format")`),
 * a parameter (`params.set("default_format", ...)`), a template that builds either,
 * or an identifier that names one. Comments are trivia rather than nodes, so prose
 * naming the envelope is deliberately free - the point is that no code depends on
 * it.
 */
function spelledTokens(node: ts.Node): string[] {
  const carriesText = ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node) || ts.isIdentifier(node);
  if (!carriesText) return [];

  const text = node.text.toLowerCase();
  return WIRE_TOKENS.filter((token) => text.includes(token.toLowerCase()));
}

/**
 * The payload field this node reads, or null when it reads none.
 *
 * Only three syntactic forms take a field off a payload, and all three are a leak
 * regardless of how the value is spelled afterwards:
 *
 *   summary.written_rows / summary?.written_rows   PropertyAccessExpression
 *   summary["written_rows"]                        ElementAccessExpression, literal key
 *   const { written_rows } = summary               BindingElement of an object pattern
 *
 * A declaration or a constructed literal (`interface E { statistics?: ... }`,
 * `return { written_rows: 0 }`) is deliberately not a leak: a shape is inert until
 * something reads it, and the read is what the three forms above catch.
 */
function accessedField(node: ts.Node): string | null {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node)) {
    const key = node.argumentExpression;
    return ts.isStringLiteralLike(key) ? key.text : null;
  }
  // Array patterns bind by position, so only an object pattern names a field.
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const key = node.propertyName ?? node.name;
    return ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : null;
  }
  return null;
}

function findWireLeaks(file: string, source: string): WireLeak[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = source.split("\n");
  // One leak per line and token: an element access reports the same token as the
  // string literal it contains, and reporting it twice reads like two problems.
  const found = new Map<string, WireLeak>();

  const report = (node: ts.Node, token: string): void => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
    found.set(`${line}:${token}`, { file, line: line + 1, token, snippet: lines[line].trim() });
  };

  const visit = (node: ts.Node): void => {
    for (const token of spelledTokens(node)) report(node, token);

    const field = accessedField(node);
    if (field !== null && ENVELOPE_FIELDS.has(field)) report(node, field);

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...found.values()].sort((a, b) => a.line - b.line);
}

/** Empty when the seam holds; the rule plus every offending line when it does not. */
function violationReport(leaks: WireLeak[]): string {
  if (leaks.length === 0) return "";

  const offences = leaks.map((leak) => `  ${leak.file}:${leak.line} uses "${leak.token}" -> ${leak.snippet}`);
  return [SEAM_RULE, ...offences].join("\n");
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

describe("ClickHouse transport seam", () => {
  const sources = providerSources();

  test("the guard scans the whole provider directory", () => {
    expect(sources).toContain(TRANSPORT_FILE);
    expect(sources.length).toBeGreaterThan(1);
  });

  // A detector that finds nothing anywhere is indistinguishable from a broken one,
  // so the file that is SUPPOSED to speak HTTP must light it up - every token,
  // including the one the seam deliberately drops, because the transport is also
  // the record of what the wire contains.
  test.each(WIRE_VOCABULARY)("the transport itself uses %s, proving the detector reads real code", (token) => {
    const tokens = findWireLeaks(TRANSPORT_FILE, readProviderSource(TRANSPORT_FILE)).map((leak) => leak.token);

    expect(tokens).toContain(token);
  });

  test(`the HTTP envelope is used only in ${TRANSPORT_FILE}`, () => {
    const leaks = sources
      .filter((file) => file !== TRANSPORT_FILE)
      .flatMap((file) => findWireLeaks(file, readProviderSource(file)));

    expect(violationReport(leaks)).toBe("");
  });
});

describe("the seam guard detector", () => {
  /**
   * Everything a compliant provider file legitimately does: name the envelope in
   * prose, read the neutral result, query the system tables whose columns happen
   * to share a name with a summary field, and keep a local called `statistics`.
   * None of it is a leak, and none of it may fire.
   */
  const COMPLIANT_SAMPLE = `
/**
 * Prose may name the envelope: X-ClickHouse-Summary, default_format and
 * rows_before_limit_at_least all stay behind the seam. Even summary.written_rows
 * written in a comment is prose.
 */
import type { ClickHouseTransport } from "./transport";

const SLOW_QUERIES = "SELECT query, written_rows, query_duration_ms FROM system.query_log";
const RUNNING = "SELECT query_id, elapsed, written_rows FROM system.processes";
const COLUMN_STATS = "SELECT name, type, statistics FROM system.columns WHERE database = {db:String}";

export async function slowQueries(transport: ClickHouseTransport, field: string) {
  const result = await transport.query(SLOW_QUERIES);
  const { rows, fieldNames, columnTypes } = result;
  const statistics = rows.map((row) => row[field]);
  const elapsedNs = result.executionTimeMs * 1e6;
  return { rows, fieldNames, columnTypes, statistics, elapsedNs, written: result.mutationCount, RUNNING, COLUMN_STATS };
}
`;

  const VIOLATING_SAMPLE = `
export function readEnvelope(payload: Record<string, unknown>, headers: Headers) {
  const { statistics } = payload;
  const format = headers.get("X-ClickHouse-Format");
  return { format, statistics, written: payload["written_rows"], limit: payload.rows_before_limit_at_least };
}
`;

  test("passes a file that stays behind the seam", () => {
    expect(findWireLeaks("introspect.ts", COMPLIANT_SAMPLE)).toEqual([]);
  });

  test("fails a file that speaks the wire, once per line and token", () => {
    const leaks = findWireLeaks("index.ts", VIOLATING_SAMPLE);

    expect(leaks.map((leak) => leak.token)).toEqual([
      "statistics",
      "X-ClickHouse-Format",
      "written_rows",
      "rows_before_limit_at_least",
    ]);
    expect(leaks[1].line).toBe(4);
    expect(leaks[3].snippet).toBe(
      'return { format, statistics, written: payload["written_rows"], limit: payload.rows_before_limit_at_least };',
    );
  });

  test.each<[string, string, string]>([
    ["a header read", 'const s = headers.get("x-clickhouse-summary");', "X-ClickHouse-Summary"],
    ["an exception header read", 'headers.get("X-ClickHouse-Exception-Code");', "X-ClickHouse-Exception-Code"],
    ["a request parameter", 'params.set("default_format", "JSON");', "default_format"],
    [
      "the 64-bit setting",
      'url += "&output_format_json_quote_64bit_integers=1";',
      "output_format_json_quote_64bit_integers",
    ],
    ["a token built into a template", "const u = `${base}?default_format=JSON`;", "default_format"],
    ["a variable named after a summary field", "const elapsed_ns = 1;", "elapsed_ns"],
    ["a member access on the summary", "const n = summary.written_rows;", "written_rows"],
    ["an optional-chained access", "const e = envelope?.statistics;", "statistics"],
    ["a bracket access with a literal key", 'const n = summary["written_rows"];', "written_rows"],
    ["a destructured field", "const { statistics } = envelope;", "statistics"],
    ["a renamed destructured field", "const { written_rows: n } = summary;", "written_rows"],
  ])("flags %s", (_label, source, token) => {
    const [leak, ...rest] = findWireLeaks("index.ts", source);

    expect(rest).toEqual([]);
    expect(leak.token).toBe(token);
    expect(leak.line).toBe(1);
  });

  test.each([
    ["a system column of the same name in SQL", 'const q = "SELECT written_rows FROM system.query_log";'],
    ["the statistics column of system.columns", 'const q = "SELECT statistics FROM system.columns";'],
    ["a near-miss column name", 'const q = "SELECT elapsed FROM system.processes";'],
    ["a camelCase name that is not the wire spelling", "const elapsedNs = summary.elapsed * 1e9;"],
    ["a local variable that shares a name", "const statistics = rows.slice(0, 10);"],
    ["an array destructuring binding", "const [statistics, rest] = tuple;"],
    ["a computed key that is not a literal", "const value = payload[field];"],
    ["a constructed object, which declares rather than reads", "return { statistics: null, rows };"],
    ["an interface member, which is inert until something reads it", "interface E { statistics?: number }"],
  ])("does not flag %s", (_label, source) => {
    expect(findWireLeaks("index.ts", source)).toEqual([]);
  });

  test("reports nothing when the seam holds", () => {
    expect(violationReport([])).toBe("");
  });

  test("the failure report explains the rule and points at the issue", () => {
    const report = violationReport(findWireLeaks("index.ts", "const n = summary.written_rows;"));

    expect(report).toContain("#264");
    expect(report).toContain(TRANSPORT_FILE);
    expect(report).toContain("ClickHouseQueryResult");
    expect(report).toContain('index.ts:1 uses "written_rows" -> const n = summary.written_rows;');
  });
});
