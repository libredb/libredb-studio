/**
 * Elasticsearch / OpenSearch transport seam guard (issue #424, Phase 1)
 *
 * ONE provider implementation serves TWO type-ids, and that is only affordable
 * while everything the two products disagree about lives in exactly one file.
 * `transport.ts:40-43` states the rule and names this test as its enforcement:
 * provider logic, introspection and monitoring read the neutral
 * `SearchQueryResult` / `SearchIndexInfo` / `SearchTransportError` through the seam,
 * so `http-transport.ts` is the only file allowed to know a path, an envelope key, a
 * product fault name, an HTTP status code or `fetch`. This test parses every source
 * in the directory from disk - not from a list - and fails the build the moment that
 * stops being true.
 *
 * The guard is a parser, not a grep, and the vocabulary is sorted into classes
 * because the classes need different treatment. What forces that here is sharper
 * than in Couchbase (#262) or Druid (#265): the NEUTRAL seam deliberately reuses the
 * wire's own English. `SearchQueryResult.rows`, `columnTypes`, `TableSchema.size`,
 * `getSchema`, `options.schema` and `SEARCH_CONTAINER_TYPES = ["object", "nested"]`
 * are all legitimate, and `rows` / `schema` / `size` are simultaneously envelope
 * keys on the wire (`{columns,rows}` on Elasticsearch against
 * `{schema,datarows,total,size}` on OpenSearch, measured). So those words are
 * matched ONLY as exact STRING literals - the spelling that envelope PARSING
 * produces - and a bare property access is left alone. A guard that cries wolf is a
 * guard the next contributor deletes.
 *
 * Deliberate holes, each cheaper than a false positive:
 * - `"type"`, `"status"`, `"error"`, `"number"` and `"query"` are NOT flagged as
 *   keys. Every one is an envelope member (`error.type`, the `_cat` status,
 *   `version.number`, the request body's `query`), and every one is also ordinary
 *   product English that will appear in a label, a `typeof` test or a metric key.
 *   The payloads they belong to are fingerprinted by their unmistakable members
 *   instead (`cluster_name`, `docs.count`, `root_cause`, ...).
 * - `"object"` and `"nested"` are NOT flagged at all: they are mapping type VALUES
 *   that cross the seam as `SearchMappingField.type` data, which is why
 *   `introspect.ts:90` may name them and `transport.ts:175` names `object` in its
 *   own doc comment.
 * - HTTP **200** is not in the status set: it is the one status that carries no
 *   classification (categorisation here is body-driven, `transport.ts:26-32`), and
 *   200 is a plausible row limit.
 *
 * Both directions are proven below: the detector must light up on the file that is
 * SUPPOSED to speak HTTP, and stay silent on a compliant one.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PROVIDER_DIR = join(ROOT, "src", "lib", "db", "providers", "sql", "search");

/** The single file allowed to know the wire format. */
const TRANSPORT_FILE = "http-transport.ts";

/**
 * Vocabulary that exists nowhere else in this provider and nowhere in English:
 * the two SQL endpoints, the three REST endpoints introspection and monitoring
 * read, the query strings that make the answers machine-readable, the `_cat` and
 * health/stats column names, the measured product fault names, and the index-name
 * shape that makes OpenSearch's query-insights index a system index without a dot.
 *
 * Matched as TEXT, case-insensitively, anywhere a node spells it - a string, a
 * template chunk, a regular expression or an identifier - because a path copied
 * into a variable name is the same leak as a path in a string.
 */
const WIRE_TOKENS = [
  // Endpoints. `/_plugins/_sql` is listed separately from `/_sql` even though it
  // contains it, so a leak names the endpoint that was actually copied.
  "/_plugins/_sql",
  "/_sql",
  "/_cat/indices",
  "/_cluster/health",
  "/_cluster/stats",
  "/_mapping",
  // The two query strings. Without `format=json` Elasticsearch answers its own
  // tabular text with no types in it, and without `bytes=b` the listing reports
  // "5.6kb" (both measured, `http-transport.ts:101-118`).
  "format=json",
  "bytes=b",
  // `_cat` columns. `pri.store.size` rather than `store.size` is a decision the
  // transport records, so the exact spelling is what must not be duplicated.
  "docs.count",
  "pri.store.size",
  // The health and stats members.
  "cluster_name",
  "number_of_nodes",
  "active_shards",
  "unassigned_shards",
  "size_in_bytes",
  // Elasticsearch's snake_case fault names, measured one probe each.
  "parsing_exception",
  "verification_exception",
  "index_not_found_exception",
  "arithmetic_exception",
  // OpenSearch's Java class names for the same faults. `ParserException` is the
  // suffix rule the transport matches on, and it contains no other token.
  "SQLFeatureNotSupportedException",
  "IndexNotFoundException",
  "SemanticCheckException",
  "NumberFormatException",
  "ParserException",
  // The system-index exception: measured on a stock OpenSearch 3.8.0,
  // `top_queries-2026.08.18-74305` carries no dot, so the dot rule alone does not
  // catch it and the name shape is part of the wire knowledge.
  "top_queries",
];

/**
 * Wire vocabulary that NOTHING in this provider may spell - the transport
 * included. Each entry is a settled decision this guard turns into a build
 * failure rather than a comment:
 *
 * - `/_query` is ES|QL. It exists only on Elasticsearch (and works on a basic
 *   licence), and a surface only one of the two products has cannot be the shared
 *   query language, so it is deliberately unused (`transport.ts:21-24`).
 * - `/_search` and `/_bulk` are the document APIs. SQL is the query language here
 *   and writes go through APIs this seam does not expose
 *   (`transport.ts:64-71`), so reaching for them is a change of scope, not a fix.
 * - `root_cause` and `caused_by` are members of Elasticsearch's error envelope
 *   that nothing reads: the fault name comes from `error.type` and the wording
 *   from `error.reason` (measured, `transport.ts:16-20`).
 */
const UNUSED_WIRE_TOKENS = ["/_query", "/_search", "/_bulk", "root_cause", "caused_by"];

/**
 * Envelope keys whose names the neutral seam deliberately shares, so only the
 * spelling that envelope parsing produces can be flagged: the key as an exact
 * string (`envelope["datarows"]`, `pick(envelope, "total")`). `result.rows`,
 * `table.size` and `options.schema` are legitimate reads of the neutral types and
 * are deliberately NOT flagged - see the header.
 */
const ENVELOPE_KEYS = [
  // Elasticsearch: `{columns:[{name,type}], rows:[[...]]}`.
  "columns",
  "rows",
  // OpenSearch: `{schema:[{name,type,alias}], datarows:[[...]], total, size}`.
  "schema",
  "datarows",
  "total",
  "alias",
  // The paging token both products spell the same way, and which an aggregation
  // gets even with no fetch_size (measured: 1000 rows plus a cursor).
  "cursor",
  // The error envelope's readable members.
  "details",
  "reason",
  // The mapping payload's nesting, and the `_cat` row's name column.
  "mappings",
  "properties",
  "fields",
  "index",
  // OpenSearch's self-identification, whose ABSENCE is Elasticsearch's signature.
  "distribution",
];

/**
 * An envelope key nothing may read as a string, the transport included.
 *
 * OpenSearch sends `size` alongside `total` on every result and Elasticsearch sends
 * neither (measured), so a page size read off one product's envelope would be a
 * number the other cannot produce. `SearchQueryResult` carries `totalHits` and
 * nothing else, and `TableSchema.size` - which `introspect.ts:334` sets from
 * `formatBytes` - is a different concept wearing the same word.
 */
const UNUSED_ENVELOPE_KEYS = ["size"];

/**
 * Identifiers matched EXACTLY, because a substring match would fire on every
 * legitimate helper: `prefetchMappings` is an ordinary provider name, while a bare
 * `fetch` - called, or read off `globalThis` - is the one thing only the transport
 * may do (`http-transport.ts:984-996`: "the only place `fetch` is called").
 */
const EXACT_TOKENS = ["fetch"];

/**
 * Statuses whose appearance in provider logic means someone is classifying a
 * failure by its code. The measured reason that is wrong, in both directions: a
 * missing index is HTTP 400 on Elasticsearch and HTTP 404 on OpenSearch, while
 * `SELECT 1/0` is HTTP 500 on Elasticsearch for a user's arithmetic. So the
 * category comes from the body, and the only two statuses that decide anything
 * (401/403, where HTTP itself fixes the meaning) are decided in the transport.
 */
const HTTP_STATUS_CODES = [400, 401, 403, 404, 405, 406, 409, 500, 502, 503];

/** Everything the transport must speak, so a silent detector cannot pass. */
const SPOKEN_VOCABULARY = [...WIRE_TOKENS, ...ENVELOPE_KEYS, ...EXACT_TOKENS];

/** Everything nobody may speak, the transport included. */
const UNSPOKEN_VOCABULARY = [...UNUSED_WIRE_TOKENS, ...UNUSED_ENVELOPE_KEYS];

const TEXT_TOKENS = [...WIRE_TOKENS, ...UNUSED_WIRE_TOKENS];
const KEY_TOKENS = [...ENVELOPE_KEYS, ...UNUSED_ENVELOPE_KEYS];

/**
 * Why the rule exists, printed on failure. Whoever trips this needs to see the
 * boundary they are crossing, otherwise the cheapest fix looks like deleting the
 * test.
 */
const SEAM_RULE = [
  `Elasticsearch/OpenSearch wire vocabulary leaked out of ${TRANSPORT_FILE}.`,
  "",
  "The two products speak the same shape of SQL over HTTP and disagree only in wire detail: the endpoint",
  "path (/_sql?format=json against /_plugins/_sql), the success envelope ({columns,rows} against",
  "{schema,datarows,total,size}), the alias member, and the fault name inside two different error",
  "envelopes (a snake_case type against a Java class name). Issue #424 keeps every one of those inside the",
  "transport: provider logic reads the neutral SearchQueryResult (rows, fieldNames, columnTypes,",
  "totalHits), SearchIndexInfo, SearchMappingField and the classified SearchTransportError through the",
  "SearchTransport seam. That is what makes ONE implementation serve TWO type-ids, and what makes adopting",
  "the official client library later one new file instead of a rewrite of the provider, the introspection",
  "and the monitoring.",
  "",
  `Fix a line below by mapping the value inside ${TRANSPORT_FILE} and widening the seam type when the value`,
  "is genuinely needed. Never classify a failure by its HTTP status: a missing index is 400 on",
  "Elasticsearch and 404 on OpenSearch, and SELECT 1/0 is 500 on Elasticsearch for a user's arithmetic, so",
  "categorisation is body-driven and lives in the transport. Provider logic must never call fetch. Do not",
  "weaken or delete this test - it is the only thing keeping the seam real.",
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
 * Four kinds of node spell a name: a string literal, a template chunk, a regular
 * expression (the transport recognises OpenSearch's query-insights index with one)
 * and an identifier. Comments are trivia rather than nodes, so the prose that
 * documents the wire - which every file in this directory does at length - is
 * deliberately free: the point is that no CODE depends on it.
 */
function spelling(node: ts.Node): { text: string; isString: boolean } | null {
  if (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node) || ts.isRegularExpressionLiteral(node)) {
    return { text: node.text, isString: true };
  }
  if (ts.isIdentifier(node)) return { text: node.text, isString: false };
  return null;
}

/** The HTTP status this numeric literal is, or null when it is an ordinary number. */
function statusToken(node: ts.Node): string | null {
  if (!ts.isNumericLiteral(node)) return null;
  return HTTP_STATUS_CODES.includes(Number(node.text)) ? `HTTP ${node.text}` : null;
}

/**
 * `/_plugins/_sql` CONTAINS `/_sql`, so a plain substring match reports one leak as
 * two. Only the longest match on a given spelling survives: both are leaks, and
 * naming the specific one is what tells the reader which endpoint they copied.
 */
function mostSpecific(matches: string[]): string[] {
  return matches.filter(
    (token) => !matches.some((other) => other !== token && other.toLowerCase().includes(token.toLowerCase())),
  );
}

function leakedTokens(node: ts.Node): string[] {
  const status = statusToken(node);
  if (status !== null) return [status];

  const spelled = spelling(node);
  if (spelled === null) return [];

  const lowered = spelled.text.toLowerCase();
  return mostSpecific([
    ...TEXT_TOKENS.filter((token) => lowered.includes(token.toLowerCase())),
    ...EXACT_TOKENS.filter((token) => spelled.text === token),
    // Exact, and strings only: this is the class the neutral seam shares its
    // English with, so an identifier spelling is legitimate by construction.
    ...(spelled.isString ? KEY_TOKENS.filter((token) => spelled.text === token) : []),
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
  return [...found.values()].sort((left, right) => left.line - right.line);
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

describe("Elasticsearch/OpenSearch transport seam", () => {
  const sources = providerSources();

  test("the guard scans the whole provider directory", () => {
    expect(sources).toContain(TRANSPORT_FILE);
    expect(sources.length).toBeGreaterThan(1);
  });

  // A detector that finds nothing anywhere is indistinguishable from a broken one,
  // so the file that is SUPPOSED to speak HTTP must light it up - every token,
  // because the transport is also the record of what the wire contains.
  test.each(SPOKEN_VOCABULARY)("the transport itself uses %s, proving the detector reads real code", (token) => {
    const tokens = findWireLeaks(TRANSPORT_FILE, readProviderSource(TRANSPORT_FILE)).map((leak) => leak.token);

    expect(tokens).toContain(token);
  });

  // The two statuses HTTP itself gives a fixed meaning, which is why they are the
  // only ones the transport decides anything on (`http-transport.ts:248-251`).
  test.each(["HTTP 401", "HTTP 403"])("the transport decides %s on the status, as measured", (token) => {
    const tokens = findWireLeaks(TRANSPORT_FILE, readProviderSource(TRANSPORT_FILE)).map((leak) => leak.token);

    expect(tokens).toContain(token);
  });

  test.each(UNSPOKEN_VOCABULARY)("%s is spelled nowhere in the provider, transport included", (token) => {
    const tokens = sources.flatMap((file) => findWireLeaks(file, readProviderSource(file)).map((leak) => leak.token));

    expect(tokens).not.toContain(token);
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
   * prose, read the neutral result, keep the mapping type VALUES the schema
   * decision turns on, and use the four words the implementer flagged - `rows`,
   * `columnTypes`, `size` and `schema` - as identifiers. None of it is a leak, and
   * none of it may fire.
   */
  const COMPLIANT_SAMPLE = `
/**
 * Prose may name the wire: the SQL endpoint is /_sql?format=json on Elasticsearch
 * and /_plugins/_sql on OpenSearch, the envelope is columns/rows against
 * schema/datarows/total/size, and a missing index is verification_exception at
 * HTTP 400 there and IndexNotFoundException at HTTP 404 here. Even
 * envelope["datarows"] written in a comment is prose.
 */
import type { SearchTransport } from "./transport";

export const SEARCH_CONTAINER_TYPES = ["object", "nested"];

export async function describeIndex(transport: SearchTransport, options: { schema?: string }) {
  const result = await transport.query("SELECT 1");
  const { rows, fieldNames, columnTypes, totalHits } = result;
  const [indices, mapped] = [await transport.indices(), await prefetchMappings(transport)];
  const size = rows.length;
  const schema = options.schema ?? indices[0].name;
  const table = { name: schema, columns: fieldNames ?? [], size: String(size), rowCount: totalHits ?? 0 };
  return { table, types: columnTypes ?? {}, mapped, containers: SEARCH_CONTAINER_TYPES, ok: 200 };
}
`;

  const VIOLATING_SAMPLE = `
export async function readIndices(origin: string) {
  const response = await fetch(\`\${origin}/_cat/indices?format=json&bytes=b\`);
  if (response.status === 404) return [];
  const listing = await response.json();
  const row = listing[0];
  return { docs: row["docs.count"], bytes: row["pri.store.size"], gone: row["type"] === "index_not_found_exception" };
}
`;

  test("passes a file that stays behind the seam", () => {
    expect(findWireLeaks("introspect.ts", COMPLIANT_SAMPLE)).toEqual([]);
  });

  test("fails a file that speaks the wire, once per line and token", () => {
    const leaks = findWireLeaks("index.ts", VIOLATING_SAMPLE);

    // `row["type"]` is deliberately absent: see the header on why "type" is not a
    // flagged key. The fault name on the same line is what catches that line.
    expect(leaks.map((leak) => leak.token)).toEqual([
      "fetch",
      "/_cat/indices",
      "format=json",
      "bytes=b",
      "HTTP 404",
      "docs.count",
      "pri.store.size",
      "index_not_found_exception",
    ]);
    expect(leaks[0].line).toBe(3);
    expect(leaks[4].line).toBe(4);
    expect(leaks[7].snippet).toBe(
      'return { docs: row["docs.count"], bytes: row["pri.store.size"], gone: row["type"] === "index_not_found_exception" };',
    );
  });

  test.each<[string, string, string]>([
    // `"/_sql?format=json"` would report TWO tokens - the path and the query
    // string - which is right and is why each is probed on its own here.
    ["the Elasticsearch SQL endpoint", 'const path = "/_sql";', "/_sql"],
    ["the OpenSearch SQL endpoint", 'const path = "/_plugins/_sql";', "/_plugins/_sql"],
    ["an endpoint built into a template", "const url = `${origin}/_cluster/health`;", "/_cluster/health"],
    ["the mapping endpoint", 'const path = index + "/_mapping";', "/_mapping"],
    ["the cluster stats endpoint", 'const path = "/_cluster/stats";', "/_cluster/stats"],
    // An identifier is matched as text too, so a fault name copied into a local is
    // the same leak as a fault name in a string. A PATH cannot be spelled as an
    // identifier (the slashes), which is why the template case above carries that
    // half of the rule.
    ["a fault name copied into an identifier", "const parsing_exception = category;", "parsing_exception"],
    ["the machine-readable bytes flag", 'const query = "bytes=b";', "bytes=b"],
    ["a _cat column", 'const docs = row["docs.count"];', "docs.count"],
    ["the primary-store column", 'const bytes = row["pri.store.size"];', "pri.store.size"],
    ["a health member", 'const nodes = health["number_of_nodes"];', "number_of_nodes"],
    ["a stats member", 'const bytes = store["size_in_bytes"];', "size_in_bytes"],
    ["an Elasticsearch fault name", 'if (fault === "verification_exception") return null;', "verification_exception"],
    ["an OpenSearch fault class", 'if (fault === "SemanticCheckException") return null;', "SemanticCheckException"],
    ["the parser-fault suffix rule", "const parserFault = /ParserException$/;", "ParserException"],
    ["the query-insights name shape", "const insights = /^top_queries-/;", "top_queries"],
    ["an envelope key spelled as a string", 'const rows = envelope["datarows"];', "datarows"],
    ["the Elasticsearch rows key", 'const values = envelope["rows"];', "rows"],
    ["the OpenSearch columns key", 'const declared = envelope["schema"];', "schema"],
    ["the alias member", 'const label = column["alias"] ?? column.name;', "alias"],
    ["the paging token", 'const next = envelope["cursor"];', "cursor"],
    ["the page size nothing reads", 'const page = envelope["size"];', "size"],
    ["a mapping nesting key", 'const props = payload["properties"];', "properties"],
    ["ES|QL, which is deliberately unused", 'await post("/_query", body);', "/_query"],
    ["an error member nothing reads", 'const causes = error["root_cause"];', "root_cause"],
    ["a direct fetch", 'await fetch(url, { method: "POST" });', "fetch"],
    ["a fetch off globalThis", "await globalThis.fetch(url);", "fetch"],
    ["a status-driven classification", "if (response.status === 400) return null;", "HTTP 400"],
    ["the status a missing index has on OpenSearch", "if (status === 404) return [];", "HTTP 404"],
    ["the status ES answers a division by zero with", "if (status === 500) throw new Error();", "HTTP 500"],
  ])("flags %s", (_label, source, token) => {
    const [leak, ...rest] = findWireLeaks("index.ts", source);

    expect(rest).toEqual([]);
    expect(leak.token).toBe(token);
    expect(leak.line).toBe(1);
  });

  test.each([
    // The neutral seam's own vocabulary, which is the whole point of the seam. All
    // four words the implementer flagged appear here as identifiers.
    ["the neutral result's rows", "const count = result.rows.length;"],
    ["the neutral result's column types", "const types = result.columnTypes;"],
    ["a destructured neutral result", "const { rows, fieldNames, columnTypes, totalHits } = result;"],
    ["TableSchema.size, which formatBytes produced", "const label = table.size;"],
    ["an options bag naming a schema", "const target = options.schema ?? null;"],
    ["the introspection entry point", "const tables = await getSchema(transport, options);"],
    ["an object built with identifier keys", "return { rows, total: 1, size: bytes, schema: name };"],
    // Mapping type VALUES, not wire vocabulary: introspect.ts:90 owns this list.
    ["the container mapping types", 'const containers = ["object", "nested"];'],
    ["a mapping type read off the seam", "const isContainer = field.type === containers[0];"],
    // Near misses that a substring grep would have fired on.
    ["a helper whose name merely contains fetch", "const mappings = await prefetchMappings(transport);"],
    ["a computed key that is not a literal", "const value = envelope[field];"],
    ["a local named after an envelope key", "const rows = values.slice(0, 10);"],
    // Numbers that are not statuses: the concurrency limit, the page bound, and
    // the one status that classifies nothing.
    ["the mapping concurrency", "const limit = 4;"],
    ["the page bound", "const maxPages = 1000;"],
    ["a row limit that happens to be 200", "const limit = 200;"],
    ["the default port both products ship on", "const port = 9200;"],
  ])("does not flag %s", (_label, source) => {
    expect(findWireLeaks("index.ts", source)).toEqual([]);
  });

  test("reports nothing when the seam holds", () => {
    expect(violationReport([])).toBe("");
  });

  test("the failure report explains the rule and points at the issue", () => {
    const report = violationReport(findWireLeaks("index.ts", 'const rows = envelope["datarows"];'));

    expect(report).toContain("#424");
    expect(report).toContain(TRANSPORT_FILE);
    expect(report).toContain("SearchQueryResult");
    expect(report).toContain('index.ts:1 uses "datarows" -> const rows = envelope["datarows"];');
  });
});
