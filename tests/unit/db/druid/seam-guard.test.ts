/**
 * Druid transport seam guard (issue #265, design spec section 0)
 *
 * The Druid provider is worth building without a client library only while
 * swapping the transport stays cheap, and it stays cheap only while the wire
 * format lives in exactly one file. This test is the mechanism that keeps that
 * true: it parses every source in the provider directory and fails the build the
 * moment Druid's HTTP vocabulary is used outside http-transport.ts. It reads the
 * directory from disk rather than from a list, so it keeps holding as the provider
 * grows.
 *
 * The guard is a parser, not a grep, and it sorts the vocabulary into three
 * classes because the three need different treatment. What forces that here is
 * something the ClickHouse guard (#264) did not face: the neutral error
 * DELIBERATELY borrows Druid's own words. `DruidTransportError` carries
 * `category`, `errorCode` and `persona` because those are the words a Druid user
 * reads in the console, which makes `error.persona` a legitimate read of the
 * NEUTRAL type - indistinguishable from `envelope.persona` without type
 * information. A guard that cries wolf is a guard the next contributor deletes, so
 * `persona` is matched only where envelope PARSING spells it (as a string), and a
 * bare property access is left alone. That hole is deliberate and is cheaper than
 * a false positive.
 *
 * Both directions are proven below: the detector must light up on the file that is
 * SUPPOSED to speak HTTP, and stay silent on a compliant one.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PROVIDER_DIR = join(ROOT, "src", "lib", "db", "providers", "sql", "druid");

/** The single file allowed to know the wire format. */
const TRANSPORT_FILE = "http-transport.ts";

/**
 * Vocabulary that exists nowhere else in this provider and nowhere in English:
 * the request's format and header flags, the endpoint path, the error
 * discriminator, the two envelope fields the neutral error does NOT carry, and
 * the auth header. Naming any of them outside the transport - in a string, a
 * property, a template or a variable - is a leak, so these are matched as text,
 * case-insensitively, because a header name is case-insensitive on the wire.
 */
const WIRE_TOKENS = [
  "resultFormat",
  "typesHeader",
  "sqlTypesHeader",
  "/druid/v2/sql",
  "druidException",
  "errorMessage",
  "errorClass",
  "authorization",
  // The availability report (#273): the header the cluster states it in and the
  // one field of it the transport reads. Provider logic reads the counted answer
  // (`unavailableSegments`) off the neutral result instead, so a second
  // implementation that learns availability another way needs no change above it.
  "X-Druid-Response-Context",
  "missingSegments",
];

/**
 * Identifiers matched EXACTLY, because a substring match would fire on every
 * legitimate helper: `fetchTableStats` and `prefetchSchema` are ordinary provider
 * names, while a bare `fetch` - called, or read off `globalThis` - is the one
 * thing spec section 15, point 4 says provider logic must never do.
 */
const EXACT_TOKENS = ["fetch"];

/**
 * Envelope fields whose names the NEUTRAL seam deliberately shares, so only the
 * spelling that envelope parsing produces can be flagged: the field as a string
 * (`body["persona"]`, `pick(body, "persona")`). `error.persona` is a legitimate
 * read of `DruidTransportError` and is deliberately NOT flagged - see the header.
 */
const STRING_TOKENS = ["persona"];

/** Everything the transport must speak, and nothing else may. */
const WIRE_VOCABULARY = [...WIRE_TOKENS, ...EXACT_TOKENS, ...STRING_TOKENS];

/**
 * Why the rule exists, printed on failure. Whoever trips this needs to see the
 * boundary they are crossing, otherwise the cheapest fix looks like deleting the
 * test.
 */
const SEAM_RULE = [
  `Druid's HTTP wire format leaked out of ${TRANSPORT_FILE}.`,
  "",
  "Druid's SQL endpoint asks for rows through resultFormat/header/typesHeader/sqlTypesHeader, answers with",
  "three HEADER ROWS in front of positional data, states in a response-context header how much of the data",
  "it could reach, and reports a failure in one of two envelopes whose `error` field is a discriminator",
  "rather than a message. Issue #265 keeps all of that inside the transport: provider logic reads the neutral",
  "DruidQueryResult (rows, fieldNames, sqlTypes, nativeTypes, executionTimeMs, unavailableSegments) and the",
  "classified DruidTransportError through the DruidTransport seam. That is what makes adopting Druid's",
  "Avatica JDBC driver later one new file implementing the same interface, instead of a rewrite of the",
  "provider, the introspection and the explain strategy.",
  "",
  `Fix an access below by mapping the field inside ${TRANSPORT_FILE} and widening DruidQueryResult when the`,
  "value is genuinely needed. If you tripped this on a local name rather than on the wire, rename it to the",
  "neutral vocabulary (`message`, not `errorMessage`) so one layer keeps one vocabulary. Provider logic must",
  "never call fetch: every request goes through the seam. Do not weaken or delete this test - it is the only",
  "thing keeping the seam real.",
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
 * envelope is deliberately free - the point is that no code depends on it.
 */
function spelling(node: ts.Node): { text: string; isString: boolean } | null {
  if (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) return { text: node.text, isString: true };
  if (ts.isIdentifier(node)) return { text: node.text, isString: false };
  return null;
}

/**
 * `sqlTypesHeader` CONTAINS `typesHeader`, so a plain substring match reports one
 * leak as two. Only the longest match on a given spelling survives: both are
 * leaks, and naming the specific one is what tells the reader which flag they
 * copied.
 */
function mostSpecific(matches: string[]): string[] {
  // Lowered on both sides, like the match itself: `sqlTypesHeader` contains
  // `typesHeader` only case-insensitively.
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

describe("Druid transport seam", () => {
  const sources = providerSources();

  test("the guard scans the whole provider directory", () => {
    expect(sources).toContain(TRANSPORT_FILE);
    expect(sources.length).toBeGreaterThan(1);
  });

  // A detector that finds nothing anywhere is indistinguishable from a broken one,
  // so the file that is SUPPOSED to speak HTTP must light it up - every token,
  // including the two envelope fields the seam deliberately drops, because the
  // transport is also the record of what the wire contains.
  test.each(WIRE_VOCABULARY)("the transport itself uses %s, proving the detector reads real code", (token) => {
    const tokens = findWireLeaks(TRANSPORT_FILE, readProviderSource(TRANSPORT_FILE)).map((leak) => leak.token);

    expect(tokens).toContain(token);
  });

  test(`the wire format is used only in ${TRANSPORT_FILE}`, () => {
    const leaks = sources
      .filter((file) => file !== TRANSPORT_FILE)
      .flatMap((file) => findWireLeaks(file, readProviderSource(file)));

    expect(violationReport(leaks)).toBe("");
  });
});

describe("the seam guard detector", () => {
  /**
   * Everything a compliant provider file legitimately does: name the wire in
   * prose, read the neutral result and the classified error, branch on a category
   * by name, query the `sys` tables whose columns share a name with an envelope
   * field, and call helpers whose names merely contain "fetch". None of it is a
   * leak, and none of it may fire.
   */
  const COMPLIANT_SAMPLE = `
/**
 * Prose may name the wire: resultFormat, typesHeader and sqlTypesHeader are asked
 * for in http-transport.ts, which POSTs to /druid/v2/sql and reads errorMessage
 * out of a druidException envelope. Even body.persona written in a comment is prose.
 */
import { DRUID_ERROR_CATEGORIES, DruidTransportError } from "./transport";
import type { DruidTransport } from "./transport";

const SERVERS = 'SELECT server, host, server_type, curr_size, max_size FROM sys.servers';
const TASKS = 'SELECT task_id, datasource, status, error_msg FROM sys.tasks';

export async function storage(transport: DruidTransport, sql: string) {
  try {
    const result = await transport.query(sql, { timeoutMs: 30000, clientDeadlineMs: 35000, parameters: [] });
    const { rows, fieldNames, sqlTypes, nativeTypes, executionTimeMs, unavailableSegments } = result;
    if (unavailableSegments !== null && unavailableSegments > 0) return null;
    const stats = await fetchTableStats(transport);
    await prefetchSchema(transport);
    return { rows, fieldNames, sqlTypes, nativeTypes, executionTimeMs, stats, SERVERS, TASKS };
  } catch (error) {
    if (error instanceof DruidTransportError && error.isMonitoringUnavailable()) return null;
    if (error instanceof DruidTransportError && error.is("UNAUTHORIZED")) return null;
    const message = error instanceof Error ? error.message : String(error);
    const persona = error instanceof DruidTransportError ? error.persona : null;
    const category = error instanceof DruidTransportError ? error.category : DRUID_ERROR_CATEGORIES.DEFENSIVE;
    const code = error instanceof DruidTransportError ? error.errorCode : null;
    return { message, persona, category, code };
  }
}
`;

  const VIOLATING_SAMPLE = `
export async function readRows(origin: string, sql: string) {
  const response = await fetch(\`\${origin}/druid/v2/sql\`, {
    method: "POST",
    body: JSON.stringify({ query: sql, resultFormat: "array", typesHeader: true, sqlTypesHeader: true }),
  });
  const body = await response.json();
  if (body.error === "druidException") throw new Error(body.errorMessage);
  return body;
}
`;

  test("passes a file that stays behind the seam", () => {
    expect(findWireLeaks("introspect.ts", COMPLIANT_SAMPLE)).toEqual([]);
  });

  test("fails a file that speaks the wire, once per line and token", () => {
    const leaks = findWireLeaks("index.ts", VIOLATING_SAMPLE);

    expect(leaks.map((leak) => leak.token)).toEqual([
      "fetch",
      "/druid/v2/sql",
      "resultFormat",
      "typesHeader",
      "sqlTypesHeader",
      "druidException",
      "errorMessage",
    ]);
    expect(leaks[1].line).toBe(3);
    expect(leaks[6].snippet).toBe('if (body.error === "druidException") throw new Error(body.errorMessage);');
  });

  test.each<[string, string, string]>([
    ["a requested result format", 'const body = { resultFormat: "array" };', "resultFormat"],
    ["a native types flag", "const flags = { typesHeader: true };", "typesHeader"],
    ["a SQL types flag", "const flags = { sqlTypesHeader: true };", "sqlTypesHeader"],
    ["the endpoint path", 'const url = origin + "/druid/v2/sql";', "/druid/v2/sql"],
    ["the endpoint path built into a template", "const url = `${origin}/druid/v2/sql`;", "/druid/v2/sql"],
    ["the error discriminator", 'if (body.error === "druidException") return;', "druidException"],
    ["an envelope message read", "const text = body.errorMessage;", "errorMessage"],
    ["an envelope message read by key", 'const text = body["errorMessage"];', "errorMessage"],
    ["the legacy exception class", "const cause = payload.errorClass;", "errorClass"],
    ["the persona field spelled as a string", 'const who = body["persona"];', "persona"],
    ["the response-context header", 'const ctx = headers.get("X-Druid-Response-Context");', "X-Druid-Response-Context"],
    ["a segment-availability read", "const gaps = context.missingSegments;", "missingSegments"],
    ["an auth header", "const headers = { authorization: basic };", "authorization"],
    ["an auth header spelled for HTTP", 'headers.set("Authorization", basic);', "authorization"],
    ["a direct fetch", 'await fetch(url, { method: "POST" });', "fetch"],
    ["a fetch off globalThis", "await globalThis.fetch(url);", "fetch"],
  ])("flags %s", (_label, source, token) => {
    const [leak, ...rest] = findWireLeaks("index.ts", source);

    expect(rest).toEqual([]);
    expect(leak.token).toBe(token);
    expect(leak.line).toBe(1);
  });

  test.each([
    // The neutral error's own fields: transport.ts names three of them after
    // Druid's on purpose, so reading them is the seam working as designed.
    ["the neutral error's persona", "const who = error.persona;"],
    ["the neutral error's category", "const c = error.category;"],
    ["the neutral error's errorCode", "const c = error.errorCode;"],
    ["the neutral error's message", "const m = error.message;"],
    ["a destructured neutral error", "const { message, category, persona } = error;"],
    ["a category checked by name", 'if (error.is("UNAUTHORIZED")) return [];'],
    ["the frozen category table", "const c = DRUID_ERROR_CATEGORIES.UNAUTHORIZED;"],
    // A substring match on "fetch" would fire on both of these.
    ["a helper whose name contains fetch", "const rows = await fetchTableStats(transport);"],
    ["a prefetch helper", "await prefetchSchema(transport);"],
    // `host` is a DatabaseConnection field and a sys.servers column, so it is
    // deliberately not guarded even though the legacy envelope carries one.
    ["the host column of sys.servers", 'const q = "SELECT server, host FROM sys.servers";'],
    ["the connection's own host", "const host = this.connection.host;"],
    // Neutral seam vocabulary that reads like the wire and is not.
    ["the neutral result's fields", "const { rows, fieldNames, sqlTypes, nativeTypes } = result;"],
    ["the counted availability answer", "if (result.unavailableSegments) return [];"],
    ["the neutral options", "await transport.query(sql, { timeoutMs: 30000, clientDeadlineMs: 35000 });"],
    ["a local holding the neutral message", "const message = error.message;"],
    ["a SQL header-ish column name", 'const q = "SELECT header FROM sys.segments";'],
  ])("does not flag %s", (_label, source) => {
    expect(findWireLeaks("index.ts", source)).toEqual([]);
  });

  test("reports nothing when the seam holds", () => {
    expect(violationReport([])).toBe("");
  });

  test("the failure report explains the rule and points at the issue", () => {
    const report = violationReport(findWireLeaks("index.ts", "const text = body.errorMessage;"));

    expect(report).toContain("#265");
    expect(report).toContain(TRANSPORT_FILE);
    expect(report).toContain("DruidQueryResult");
    expect(report).toContain('index.ts:1 uses "errorMessage" -> const text = body.errorMessage;');
  });
});
