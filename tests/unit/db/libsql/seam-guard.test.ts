/**
 * libSQL transport seam guard (issue #424 Phase 5)
 *
 * The libSQL provider is worth building without a client library only while
 * swapping the transport stays cheap, and it stays cheap only while the Hrana
 * envelope lives in exactly one file. This test is the mechanism that keeps that
 * true: it parses every source in the provider directory and fails the build the
 * moment the wire vocabulary is used outside `hrana-transport.ts`. It reads the
 * directory from disk rather than from a list, so it keeps holding as the provider
 * grows.
 *
 * There IS a plausible second implementation, which is why the seam is not
 * ceremony: Hrana also runs over WebSocket, `@tursodatabase/database` embeds the
 * engine in-process, and `@libsql/client` speaks both. Any of them would answer the
 * same questions - none of them would answer them with a `baton`.
 *
 * The guard is a parser, not a grep, and it sorts the vocabulary into two classes:
 *
 * - Tokens Hrana invented and SQLite does not have (`baton`, `base_url`,
 *   `affected_row_count`, `query_duration_ms`, `replication_index`, `decltype`,
 *   `rows_read`, `rows_written`, and the endpoint path) are matched as TEXT, so
 *   naming one anywhere outside the transport is a leak.
 * - `last_insert_rowid` is matched only as a READ off a payload, because it is also
 *   a real SQLite function: `SELECT last_insert_rowid()` is legitimate SQL that any
 *   implementation may issue, and a guard that fires on it would be crying wolf.
 *
 * `hrana` itself is deliberately NOT in the vocabulary: `index.ts` has to name the
 * concrete `LibSQLHranaTransport` to construct one, and the neutral seam publishes
 * `kind: "hrana-http"` on purpose so a caller can tell the implementations apart.
 * A guard that cries wolf is a guard the next contributor deletes, so both
 * directions are proven below: the detector must light up on the file that is
 * SUPPOSED to speak Hrana, and stay silent on a compliant one.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PROVIDER_DIR = join(ROOT, "src", "lib", "db", "providers", "sql", "libsql");

/** The single file allowed to know the wire format. */
const TRANSPORT_FILE = "hrana-transport.ts";

/**
 * Identifiers Hrana invented. None of them is a SQLite keyword, a SQLite function
 * or a column of anything SQLite publishes, so a mention outside the transport - in
 * a string, a property name or an identifier - is a leak.
 */
const WIRE_TOKENS = [
  "/v2/pipeline",
  "baton",
  "base_url",
  "affected_row_count",
  "query_duration_ms",
  "replication_index",
  "decltype",
  "rows_read",
  "rows_written",
];

/**
 * Payload fields that are ALSO real SQLite vocabulary, so text matching would fire
 * on legitimate SQL. Reading one off a payload is still a leak: the neutral result
 * calls it `lastInsertRowId`.
 */
const ENVELOPE_FIELDS = new Set(["last_insert_rowid"]);

/** Everything the transport must speak, and nothing else may. */
const WIRE_VOCABULARY = [...WIRE_TOKENS, ...ENVELOPE_FIELDS];

/**
 * Why the rule exists, printed on failure. Whoever trips this needs to see the
 * boundary they are crossing, otherwise the cheapest fix looks like deleting the
 * test.
 */
const SEAM_RULE = [
  `The Hrana envelope leaked out of ${TRANSPORT_FILE}.`,
  "",
  "Hrana posts a list of requests to /v2/pipeline, answers one result per request, hands back a baton to",
  "continue a server-side stream, and encodes every value as { type, value } with integers as decimal",
  "strings. Issue #424 keeps all of that inside the transport: provider logic reads the neutral",
  "LibSQLStatementResult (rows, fieldNames, columnTypes, affectedRowCount, lastInsertRowId,",
  "executionTimeMs) and the per-statement LibSQLBatchOutcome through the LibSQLTransport seam. That is",
  "what makes a WebSocket or embedded implementation one new file rather than a rewrite of the provider",
  "and its introspection.",
  "",
  `Fix an access below by mapping the field inside ${TRANSPORT_FILE} and widening LibSQLStatementResult`,
  "when the value is genuinely needed. If you tripped this on SQL - last_insert_rowid() is a real SQLite",
  "function - read it under an alias (`last_insert_rowid() AS insertedId`) so one layer keeps one",
  "vocabulary. Do not weaken or delete this test: it is the only thing keeping the seam real.",
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
 * Only text carries them: a path, a property name in a constructed envelope, or an
 * identifier that names one. Comments are trivia rather than nodes, so prose naming
 * the envelope is deliberately free - the point is that no code depends on it.
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
 *   result.last_insert_rowid / result?.last_insert_rowid   PropertyAccessExpression
 *   result["last_insert_rowid"]                            ElementAccessExpression
 *   const { last_insert_rowid } = result                   BindingElement
 *
 * A declaration or a constructed literal is deliberately not a leak: a shape is
 * inert until something reads it, and the read is what the three forms above catch.
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

describe("libSQL transport seam", () => {
  const sources = providerSources();

  test("the guard scans the whole provider directory", () => {
    expect(sources).toContain(TRANSPORT_FILE);
    expect(sources.length).toBeGreaterThan(1);
  });

  // A detector that finds nothing anywhere is indistinguishable from a broken one,
  // so the file that is SUPPOSED to speak Hrana must light it up - every token,
  // because the transport is also the record of what the wire contains.
  test.each(WIRE_VOCABULARY)("the transport itself uses %s, proving the detector reads real code", (token) => {
    const tokens = findWireLeaks(TRANSPORT_FILE, readProviderSource(TRANSPORT_FILE)).map((leak) => leak.token);

    expect(tokens).toContain(token);
  });

  test(`the Hrana envelope is used only in ${TRANSPORT_FILE}`, () => {
    const leaks = sources
      .filter((file) => file !== TRANSPORT_FILE)
      .flatMap((file) => findWireLeaks(file, readProviderSource(file)));

    expect(violationReport(leaks)).toBe("");
  });
});

describe("the seam guard detector", () => {
  /**
   * Everything a compliant provider file legitimately does: name the envelope in
   * prose, read the neutral result, and issue SQL that uses the one SQLite function
   * whose name is also a payload field. None of it is a leak, and none of it may
   * fire.
   */
  const COMPLIANT_SAMPLE = `
/**
 * Prose may name the envelope: the baton, base_url and query_duration_ms all stay
 * behind the seam. Even result.last_insert_rowid written in a comment is prose.
 */
import type { LibSQLTransport } from "./transport";

const INSERTED = "SELECT last_insert_rowid() AS insertedId";

export async function insertedId(transport: LibSQLTransport) {
  const result = await transport.execute(INSERTED);
  const { rows, fieldNames, columnTypes } = result;
  return { rows, fieldNames, columnTypes, id: result.lastInsertRowId, ms: result.executionTimeMs };
}
`;

  const VIOLATING_SAMPLE = `
export function readEnvelope(payload: Record<string, unknown>) {
  const { baton } = payload;
  const result = payload["result"] as Record<string, unknown>;
  return { baton, id: result.last_insert_rowid, ms: result.query_duration_ms, url: payload.base_url };
}
`;

  test("passes a file that stays behind the seam", () => {
    expect(findWireLeaks("introspect.ts", COMPLIANT_SAMPLE)).toEqual([]);
  });

  test("reports every crossing in a file that does not, with the rule attached", () => {
    const leaks = findWireLeaks("introspect.ts", VIOLATING_SAMPLE);

    expect(leaks.map((leak) => leak.token).sort()).toEqual([
      "base_url",
      "baton",
      "baton",
      "last_insert_rowid",
      "query_duration_ms",
    ]);
    expect(violationReport(leaks)).toContain("The Hrana envelope leaked out of");
    expect(violationReport(leaks)).toContain('uses "baton"');
  });
});
