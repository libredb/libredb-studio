/**
 * Trino transport seam guard (issue #424, Phase 2)
 *
 * The Trino provider is worth building without a client library only while
 * swapping the transport stays cheap, and it stays cheap only while the client
 * protocol lives in exactly one file. This test is the mechanism that keeps that
 * true: it parses every source in the provider directory and fails the build the
 * moment the protocol's vocabulary is used outside http-transport.ts. It reads
 * the directory from disk rather than from a list, so it keeps holding as the
 * provider grows.
 *
 * The stake here is higher than it was for Druid (#265) or ClickHouse (#264),
 * because the second implementation is already named. PrestoDB speaks this same
 * protocol under a different generated header prefix, and shipping it is meant to
 * be one descriptor in `transport.ts` plus a doc/test triad. That estimate holds
 * only if no file below ever writes a whole header name down - which is why the
 * transport builds every one of them as `X-${prefix}-${suffix}` and why the
 * PREFIX is the only part of a header this guard ever expects to see outside the
 * transport.
 *
 * The guard is a parser, not a grep, and it sorts the vocabulary into three
 * classes because the three need different treatment. Some protocol members are
 * spelled with words the provider legitimately uses for its own purposes -
 * `columns`, `data`, `stats`, `warnings` are English as well as wire - so those
 * are flagged only where document PARSING spells them, as an exact string. A
 * guard that cries wolf is a guard the next contributor deletes.
 *
 * Both directions are proven below: the detector must light up on the file that
 * is SUPPOSED to speak the protocol, and stay silent on a compliant one.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PROVIDER_DIR = join(ROOT, "src", "lib", "db", "providers", "sql", "trino");

/** The single file allowed to know the protocol. */
const TRANSPORT_FILE = "http-transport.ts";

/**
 * Vocabulary that exists nowhere else in this provider and nowhere in English:
 * the two endpoint paths, the members of a result document, the members of a
 * failure document, the declaration's parsed type tree, the warning envelope, the
 * server's own millisecond suffix, the throttling header, the statement's content
 * type and the auth header.
 *
 * Matched as text, case-insensitively, because a header name is case-insensitive
 * on the wire and a leak spelled `Authorization` is the same leak.
 */
const WIRE_TOKENS = [
  "/v1/statement",
  "/v1/query",
  "nextUri",
  // Cancels the running stage rather than the statement. The transport
  // deliberately does not use it; nothing else may discover it either.
  "partialCancelUri",
  "updateType",
  "updateCount",
  "typeSignature",
  "errorName",
  "errorType",
  "errorLocation",
  "failureInfo",
  "warningCode",
  // The server's timing members - `elapsedTimeMillis`, `cpuTimeMillis`,
  // `queuedTimeMillis`. The neutral result spells the same numbers `...Ms`, so
  // this suffix is a reliable marker of a document being read directly.
  "TimeMillis",
  "Retry-After",
  "text/plain",
  "authorization",
];

/**
 * Identifiers matched EXACTLY, because a substring match would fire on every
 * legitimate helper: `fetchTableStats` and `prefetchSchema` are ordinary provider
 * names, while a bare `fetch` - called, or read off `globalThis` - is the one
 * thing provider logic must never do.
 */
const EXACT_TOKENS = ["fetch"];

/**
 * Document members whose names are ordinary English. Only the spelling that
 * parsing produces can be flagged: the member as a string (`page["columns"]`,
 * `pick(page, "data")`). `result.columnTypes` and a SQL statement that happens to
 * contain the word `columns` - `FROM tpch.information_schema.columns`, which
 * introspection cannot avoid - are deliberately NOT flagged.
 */
const STRING_TOKENS = ["columns", "data", "stats", "warnings"];

/** Everything the transport must speak, and nothing else may. */
const WIRE_VOCABULARY = [...WIRE_TOKENS, ...EXACT_TOKENS, ...STRING_TOKENS];

/**
 * Why the rule exists, printed on failure. Whoever trips this needs to see the
 * boundary they are crossing, otherwise the cheapest fix looks like deleting the
 * test.
 */
const SEAM_RULE = [
  `Trino's client protocol leaked out of ${TRANSPORT_FILE}.`,
  "",
  "A Trino statement is not a request: it is submitted to /v1/statement, answered over a chain of nextUri pages",
  "that carry the declaration and the rows separately, terminated only by the ABSENCE of the next link, and",
  "reported as failed inside an HTTP 200. Issue #424 keeps all of that inside the transport: provider logic reads",
  "the neutral TrinoQueryResult (rows, fieldNames, columnTypes, queryId, operation, affectedRows, warnings, stats)",
  "and the classified TrinoTransportError through the TrinoTransport seam, and every header is generated from",
  "TrinoDialect.headerPrefix. That is what makes PrestoDB - the same protocol under an X-Presto-* prefix - one new",
  "descriptor instead of a rewrite of the provider, the introspection and the explain strategy.",
  "",
  `Fix an access below by mapping the member inside ${TRANSPORT_FILE} and widening TrinoQueryResult when the value`,
  "is genuinely needed. If you tripped this on a local name rather than on the wire, rename it to the neutral",
  "vocabulary (`elapsedMs`, not `elapsedTimeMillis`) so one layer keeps one vocabulary. Provider logic must never",
  "call fetch: every request goes through the seam. Do not weaken or delete this test - it is the only thing",
  "keeping the seam real.",
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
 * The text this node carries, and whether it carries it as a string.
 *
 * Only three kinds of node spell a name: a string literal, a template chunk, and
 * an identifier. Comments are trivia rather than nodes, so prose naming the
 * protocol is deliberately free - the point is that no code depends on it.
 */
function spelling(node: ts.Node): { text: string; isString: boolean } | null {
  if (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) return { text: node.text, isString: true };
  if (ts.isIdentifier(node)) return { text: node.text, isString: false };
  return null;
}

/**
 * One spelling can match two tokens when one contains the other. Only the longest
 * match survives: naming the specific one is what tells the reader which member
 * they copied.
 */
function mostSpecific(matches: string[]): string[] {
  return matches.filter(
    (token) => !matches.some((other) => other !== token && other.toLowerCase().includes(token.toLowerCase())),
  );
}

function leakedTokens(node: ts.Node): string[] {
  const spelled = spelling(node);
  if (!spelled) return [];

  const lowered = spelled.text.toLowerCase();
  return mostSpecific([
    ...WIRE_TOKENS.filter((token) => lowered.includes(token.toLowerCase())),
    ...EXACT_TOKENS.filter((token) => spelled.text === token),
    ...(spelled.isString ? STRING_TOKENS.filter((token) => spelled.text === token) : []),
  ]);
}

function findWireLeaks(file: string, source: string): WireLeak[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = source.split("\n");
  // One leak per line and token: an element access reports the same token as the
  // string literal it contains, and reporting it twice reads like two problems.
  const found = new Map<string, WireLeak>();

  const visit = (node: ts.Node): void => {
    for (const token of leakedTokens(node)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
      found.set(`${line}:${token}`, { file, line: line + 1, token, snippet: lines[line].trim() });
    }
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

describe("Trino transport seam", () => {
  const sources = providerSources();

  test("the guard scans the whole provider directory", () => {
    expect(sources).toContain(TRANSPORT_FILE);
    expect(sources.length).toBeGreaterThan(1);
  });

  // A detector that finds nothing anywhere is indistinguishable from a broken one,
  // so the file that is SUPPOSED to speak the protocol must light it up - every
  // token, including the members the transport deliberately does not read, because
  // the transport is also the record of what the wire contains.
  test.each(WIRE_VOCABULARY)("the transport itself uses %s, proving the detector reads real code", (token) => {
    const tokens = findWireLeaks(TRANSPORT_FILE, readProviderSource(TRANSPORT_FILE)).map((leak) => leak.token);

    expect(tokens).toContain(token);
  });

  test(`the client protocol is used only in ${TRANSPORT_FILE}`, () => {
    const leaks = sources
      .filter((file) => file !== TRANSPORT_FILE)
      .flatMap((file) => findWireLeaks(file, readProviderSource(file)));

    expect(violationReport(leaks)).toBe("");
  });

  /**
   * The prefix is the ONE piece of a header that is allowed above the transport,
   * because it is the descriptor's whole purpose. This asserts the shape that
   * makes that safe: `transport.ts` names the product, and only the transport
   * turns it into a header.
   */
  test("the descriptor carries a product name, and only the transport turns it into a header", () => {
    expect(readProviderSource("transport.ts")).toContain('headerPrefix: "Trino"');
    // The one place a header name comes into existence, and it is generated. A
    // literal `"X-Trino-User"` here would compile, pass every other test, and
    // quietly make the second product a rewrite - which is exactly why this asserts
    // the construction rather than the absence.
    expect(readProviderSource(TRANSPORT_FILE)).toContain("`X-${this.dialect.headerPrefix}-${suffix}`");
  });
});

describe("the seam guard detector", () => {
  /**
   * Everything a compliant provider file legitimately does: name the protocol in
   * prose, read the neutral result and the classified error, branch on a category,
   * query the `information_schema` relations whose names collide with document
   * members, and call helpers whose names merely contain "fetch". None of it is a
   * leak, and none of it may fire.
   */
  const COMPLIANT_SAMPLE = `
/**
 * Prose may name the protocol: http-transport.ts POSTs to /v1/statement, follows
 * every nextUri, reads updateType and updateCount, and classifies errorName /
 * errorType out of the failure document. Even page["stats"].elapsedTimeMillis
 * written in a comment is prose.
 */
import { TRINO_DIALECT, TrinoTransportError } from "./transport";
import type { TrinoTransport } from "./transport";

const TABLES = 'SELECT table_name, table_type FROM "tpch".information_schema.tables WHERE table_schema = \\'sf1\\'';
const COLUMNS = 'SELECT column_name, data_type FROM "tpch".information_schema.columns WHERE table_schema = \\'sf1\\'';

export async function readSchema(transport: TrinoTransport, catalog: string) {
  try {
    const result = await transport.query(TABLES, { catalog, schema: "sf1" });
    const { rows, fieldNames, columnTypes, queryId, operation, affectedRows, warnings, stats } = result;
    const elapsed = stats.elapsedMs ?? stats.cpuMs ?? stats.queuedMs;
    const label = transport.dialect.displayName;
    const port = transport.dialect.defaultPort;
    const version = await transport.query(transport.dialect.versionQuery);
    const extra = await fetchTableStats(transport);
    await prefetchSchema(transport);
    await transport.cancel(queryId);
    return { rows, fieldNames, columnTypes, operation, affectedRows, warnings, elapsed, label, port, version, extra, COLUMNS };
  } catch (error) {
    if (error instanceof TrinoTransportError && error.category === "unknown-object") return [];
    const message = error instanceof Error ? error.message : String(error);
    const code = error instanceof TrinoTransportError ? error.code : null;
    const location = error instanceof TrinoTransportError ? error.location : null;
    return { message, code, location, dialect: TRINO_DIALECT.id };
  }
}
`;

  const VIOLATING_SAMPLE = `
export async function readRows(origin: string, sql: string) {
  const response = await fetch(\`\${origin}/v1/statement\`, {
    method: "POST",
    headers: { "content-type": "text/plain", authorization: basic },
    body: sql,
  });
  const page = await response.json();
  if (page.error) throw new Error(page.error.errorName);
  return { next: page.nextUri, cols: page["columns"], rows: page["data"] };
}
`;

  test("passes a file that stays behind the seam", () => {
    expect(findWireLeaks("introspect.ts", COMPLIANT_SAMPLE)).toEqual([]);
  });

  test("fails a file that speaks the protocol, once per line and token", () => {
    const leaks = findWireLeaks("index.ts", VIOLATING_SAMPLE);

    expect(leaks.map((leak) => leak.token)).toEqual([
      "fetch",
      "/v1/statement",
      "text/plain",
      "authorization",
      "errorName",
      "nextUri",
      "columns",
      "data",
    ]);
    expect(leaks[1].line).toBe(3);
    expect(leaks[4].snippet).toBe("if (page.error) throw new Error(page.error.errorName);");
  });

  test.each<[string, string, string]>([
    ["the submission path", 'const url = origin + "/v1/statement";', "/v1/statement"],
    ["the submission path built into a template", "const url = `${origin}/v1/statement`;", "/v1/statement"],
    ["the cancellation path", "const url = `${origin}/v1/query/${id}`;", "/v1/query"],
    ["the link the loop follows", "const next = page.nextUri;", "nextUri"],
    ["the link read by key", 'const next = page["nextUri"];', "nextUri"],
    ["the stage cancellation link", "const partial = page.partialCancelUri;", "partialCancelUri"],
    ["the operation member", "const op = page.updateType;", "updateType"],
    ["the mutation count member", "const n = page.updateCount;", "updateCount"],
    ["the parsed type tree", "const tree = column.typeSignature;", "typeSignature"],
    ["the fault name", "const fault = error.errorName;", "errorName"],
    ["the fault family", "const family = error.errorType;", "errorType"],
    ["the fault position", "const at = error.errorLocation;", "errorLocation"],
    ["the Java exception chain", "const cause = error.failureInfo;", "failureInfo"],
    ["the warning envelope", "const code = warning.warningCode;", "warningCode"],
    ["the server's own millisecond suffix", "const ms = stats.elapsedTimeMillis;", "TimeMillis"],
    ["the throttling header", 'const wait = headers.get("Retry-After");', "Retry-After"],
    ["the statement content type", 'const headers = { "content-type": "text/plain" };', "text/plain"],
    ["an auth header", "const headers = { authorization: basic };", "authorization"],
    ["an auth header spelled for HTTP", 'headers.set("Authorization", basic);', "authorization"],
    ["the declaration member as a string", 'const cols = page["columns"];', "columns"],
    ["the rows member as a string", 'const rows = page["data"];', "data"],
    ["the execution report as a string", 'const s = page["stats"];', "stats"],
    ["the remarks member as a string", 'const w = page["warnings"];', "warnings"],
    ["a direct fetch", 'await fetch(url, { method: "POST" });', "fetch"],
    ["a fetch off globalThis", "await globalThis.fetch(url);", "fetch"],
  ])("flags %s", (_label, source, token) => {
    const [leak, ...rest] = findWireLeaks("index.ts", source);

    expect(rest).toEqual([]);
    expect(leak.token).toBe(token);
    expect(leak.line).toBe(1);
  });

  test.each([
    // The neutral result's own fields, several of which read like the wire.
    ["the neutral result's fields", "const { rows, fieldNames, columnTypes, queryId } = result;"],
    ["the neutral mutation report", "const { operation, affectedRows } = result;"],
    ["the neutral remarks", "for (const warning of result.warnings) render(warning.code, warning.message);"],
    ["the neutral execution report", "const ms = result.stats.elapsedMs ?? result.stats.cpuMs;"],
    ["the neutral error's fields", "const { category, code, location, message } = error;"],
    ["a category checked by name", 'if (error.category === "unknown-object") return [];'],
    ["the descriptor", "const port = transport.dialect.defaultPort;"],
    ["the descriptor's product name", "const label = transport.dialect.displayName;"],
    // A substring match on "fetch" would fire on both of these.
    ["a helper whose name contains fetch", "const rows = await fetchTableStats(transport);"],
    ["a prefetch helper", "await prefetchSchema(transport);"],
    // The relations introspection cannot avoid naming. A substring match on
    // "columns" or "data" would make the schema tree unimplementable.
    ["the information_schema columns relation", 'const q = "SELECT * FROM c.information_schema.columns";'],
    ["a data_type projection", 'const q = "SELECT column_name, data_type FROM c.information_schema.columns";'],
    ["a table named data", 'const q = "SELECT * FROM lake.raw.data";'],
    // A property whose NAME contains a member word but is not one.
    ["a column type map", "const types = result.columnTypes;"],
    ["a statistics helper", "const stats = summarizeTable(rows);"],
  ])("does not flag %s", (_label, source) => {
    expect(findWireLeaks("index.ts", source)).toEqual([]);
  });

  test("reports nothing when the seam holds", () => {
    expect(violationReport([])).toBe("");
  });

  test("the failure report explains the rule and points at the issue", () => {
    const report = violationReport(findWireLeaks("index.ts", "const next = page.nextUri;"));

    expect(report).toContain("#424");
    expect(report).toContain(TRANSPORT_FILE);
    expect(report).toContain("TrinoQueryResult");
    expect(report).toContain("headerPrefix");
    expect(report).toContain('index.ts:1 uses "nextUri" -> const next = page.nextUri;');
  });
});
