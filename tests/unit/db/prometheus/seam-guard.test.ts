/**
 * Prometheus transport seam guard (#1085, section 3.1)
 *
 * Two seams, each held by parsing every source in the provider directory rather than by a list this test
 * would have to remember to update, in the shape of `tests/unit/db/trino/seam-guard.test.ts`.
 *
 * **The wire lives in `http-transport.ts`.** The endpoint paths, their parameter names, the response
 * envelope, the payload members and the `Authorization` header are known to that one file, and every
 * other module reads the neutral seam of `transport.ts`. That is what keeps a wire-compatible server
 * (VictoriaMetrics, section 7) a matter of one file, and every module above the seam testable without a
 * server.
 *
 * **The network lives in `request.ts`.** `fetch` and `node:https` are the two ways a request leaves the
 * process, and `http-transport.ts` receives the request function by injection rather than calling
 * either (3.5, dependency inversion). A module that reached the network on its own would skip the
 * refused redirects, the byte cap and the deadline `request.ts` puts on every request (#1085 S2, #1085 S5).
 *
 * The guard is a parser, not a grep, and it sorts the wire vocabulary by how it may be spelled. The seam
 * deliberately keeps several of the engine's member names as fields of its neutral types (`scrapePool`,
 * `lastError`, `evaluationTime`), so those are flagged only where document parsing spells them, as an
 * exact string. Comments are trivia rather than nodes, so prose may name anything. Both directions are
 * proven: each detector lights up on the file that is supposed to speak its vocabulary, and stays silent
 * on a compliant sample. A guard that cries wolf is a guard the next contributor deletes.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const PROVIDER_DIR = join(ROOT, "src", "lib", "db", "providers", "timeseries", "prometheus");

/** The single file allowed to know the wire. */
const TRANSPORT_FILE = "http-transport.ts";

/** The single file allowed to reach the network. */
const REQUEST_FILE = "request.ts";

/**
 * Wire vocabulary that exists nowhere else in this provider and nowhere in English: every endpoint path of
 * #1085 4.6 and 6.2, the parameter names that are not English words, the envelope's failure member, the
 * payload members of the query, targets and TSDB answers, and the auth header.
 *
 * Matched as text, case-insensitively and inside longer spellings, because a path built into a template
 * and a header spelled `Authorization` are the same leak. Deliberately NOT here: the parameter names that
 * are English and seam vocabulary at once (`query` is a seam method, `limit` a rule group field, `metric`
 * a kind id, and `start`, `end`, `state`, `timeout`), the generic envelope words `status`, `data` and
 * `error`, which a `node:https` reader may spell as stream event names, and the payload members the seam
 * kept as its own field names (`scrapeUrl`, `lastError`, `evaluationTime`, `discoveredLabels`).
 */
const WIRE_TOKENS = [
  "/api/v1/query",
  "/api/v1/label/",
  "/api/v1/labels",
  "/api/v1/series",
  "/api/v1/metadata",
  "/api/v1/rules",
  "/api/v1/scrape_pools",
  "/api/v1/targets",
  "/api/v1/status/buildinfo",
  "/api/v1/status/runtimeinfo",
  "/api/v1/status/flags",
  "/api/v1/status/tsdb",
  "/-/healthy",
  "/-/ready",
  "/health",
  "match[]",
  "rule_group[]",
  "file[]",
  "rule_name[]",
  "exclude_alerts",
  "errorType",
  "resultType",
  "activeTargets",
  "droppedTargets",
  "seriesCountByMetricName",
  "labelValueCountByLabelName",
  "headStats",
  "authorization",
];

/**
 * Wire members whose spelling other modules legitimately use as identifiers: the seam's `scrapePool`
 * field, a shaped result's `warnings`, a local list of `infos`, and the head block's `minTimeMs` and
 * `maxTimeMs` on the seam, which hold `minTime` and `maxTime` inside them. Only the spelling document
 * parsing produces is flagged: the member as an exact string (`head["numSeries"]`,
 * `params.set("scrapePool", pool)`).
 */
const STRING_TOKENS = ["warnings", "infos", "scrapePool", "numSeries", "chunkCount", "minTime", "maxTime"];

/** Everything the transport must speak, and nothing else may. */
const WIRE_VOCABULARY = [...WIRE_TOKENS, ...STRING_TOKENS];

/**
 * Identifiers matched exactly: `fetchMetricNames` is an ordinary helper name, while a bare `fetch`
 * or `httpTransportFetch` sends a request and belongs only in the request module.
 */
const NETWORK_IDENTIFIERS = ["fetch", "httpTransportFetch"];

/**
 * The modules a request or a socket can leave the process through. A module name is matched only where a
 * module is named ({@link isModuleSpecifier}), never in any other string, because index.ts spells the
 * schemes "https" and "http" as data for the shared endpoint builder. A built-in answers to its bare name
 * and to its `node:` spelling alike, so a specifier is compared with that prefix removed, and a leak names
 * a built-in by its `node:` spelling, so one module is always one token.
 */
const NODE_PREFIX = "node:";
const NETWORK_BUILTINS = ["http", "https", "http2", "net", "tls"];
const NETWORK_PACKAGES = ["undici"];

/** The two ways request.ts sends, each of which it must spell. */
const REQUEST_VOCABULARY = ["httpTransportFetch", "node:https"];

/**
 * Why each rule exists, printed on failure. Whoever trips it needs to see the boundary they are crossing,
 * otherwise the cheapest fix looks like deleting the test.
 */
const WIRE_RULE = [
  `Prometheus's wire vocabulary leaked out of ${TRANSPORT_FILE}.`,
  "",
  "Issue #1085 keeps the endpoint paths, their parameters, the response envelope and every payload member inside",
  `${TRANSPORT_FILE}. Every other module reads the neutral seam of transport.ts: PrometheusQueryData, CappedList,`,
  "PrometheusRuleGroup, PrometheusTarget, PrometheusTsdbStatus, PrometheusHealth and the classified",
  "PrometheusTransportError. That is what keeps a wire-compatible server such as VictoriaMetrics one file away,",
  "and every module above the seam testable without a server.",
  "",
  `Fix an access below by decoding the member inside ${TRANSPORT_FILE} and widening the seam type when the value is`,
  "genuinely needed. A health probe's path is data to read (probe.path), never a literal to compare. If you tripped",
  "this on a local name rather than on the wire, rename it to the seam's vocabulary (head.series, not numSeries).",
  "Do not weaken or delete this test: it is the only thing keeping the seam real.",
  "",
  "Wire vocabulary outside the transport:",
].join("\n");

const NETWORK_RULE = [
  `A module other than ${REQUEST_FILE} reaches the network.`,
  "",
  `Issue #1085 sends every request through ${REQUEST_FILE}, which refuses redirects on both paths (#1085 S2),`,
  "caps every response while it streams (#1085 S5) and puts a deadline on every request. A module that calls",
  "fetch or opens a request or a socket through node:http, node:https, node:http2, node:net, node:tls or undici",
  `itself skips all three. ${TRANSPORT_FILE} receives the SendRequest function by injection; take it the same way.`,
  "Do not weaken or delete this test.",
  "",
  "Network access outside the request module:",
].join("\n");

interface Leak {
  file: string;
  line: number;
  token: string;
  snippet: string;
}

/**
 * The text this node carries, and whether it carries it as a string.
 *
 * Only three kinds of node spell a name: a string literal, a template chunk and an identifier. A module
 * specifier and the argument of an inline `import("...")` type are string literals too.
 */
function spelling(node: ts.Node): { text: string; isString: boolean } | null {
  if (ts.isStringLiteral(node) || ts.isTemplateLiteralToken(node)) return { text: node.text, isString: true };
  if (ts.isIdentifier(node)) return { text: node.text, isString: false };
  return null;
}

/**
 * One spelling can match two tokens when one contains the other (`/-/healthy` holds `/health`). Only the
 * longest match survives: naming the specific one is what tells the reader which member they copied.
 */
function mostSpecific(matches: string[]): string[] {
  return matches.filter(
    (token) => !matches.some((other) => other !== token && other.toLowerCase().includes(token.toLowerCase())),
  );
}

function wireTokens(node: ts.Node): string[] {
  const spelled = spelling(node);
  if (!spelled) return [];

  const lowered = spelled.text.toLowerCase();
  return mostSpecific([
    ...WIRE_TOKENS.filter((token) => lowered.includes(token.toLowerCase())),
    ...(spelled.isString ? STRING_TOKENS.filter((token) => spelled.text === token) : []),
  ]);
}

/**
 * Whether a string literal is where a module is named: the specifier of an import or an export,
 * `import x = require("...")`, the first argument of `require(...)` or of `import(...)`, or the argument
 * of an inline `import("...")` type.
 */
function isModuleSpecifier(node: ts.StringLiteralLike): boolean {
  const parent = node.parent;
  if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent)) return parent.moduleSpecifier === node;
  if (ts.isExternalModuleReference(parent)) return parent.expression === node;
  if (ts.isCallExpression(parent)) {
    const callee = parent.expression;
    const loads = callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
    return loads && parent.arguments[0] === node;
  }
  return ts.isLiteralTypeNode(parent) && ts.isImportTypeNode(parent.parent) && parent.parent.argument === parent;
}

/** The network module a specifier names, as a leak reports it, or null for any other module. */
function networkModule(specifier: string): string | null {
  const name = specifier.startsWith(NODE_PREFIX) ? specifier.slice(NODE_PREFIX.length) : specifier;
  if (NETWORK_BUILTINS.includes(name)) return `${NODE_PREFIX}${name}`;
  return NETWORK_PACKAGES.includes(name) ? name : null;
}

function networkTokens(node: ts.Node): string[] {
  const spelled = spelling(node);
  if (!spelled) return [];

  const named = ts.isStringLiteralLike(node) && isModuleSpecifier(node) ? networkModule(node.text) : null;
  return [...NETWORK_IDENTIFIERS.filter((token) => spelled.text === token), ...(named === null ? [] : [named])];
}

function findLeaks(file: string, source: string, tokensOf: (node: ts.Node) => string[]): Leak[] {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const lines = source.split("\n");
  // One leak per line and token: an element access reports the same token as the string literal it
  // contains, and reporting it twice reads like two problems.
  const found = new Map<string, Leak>();

  const visit = (node: ts.Node): void => {
    for (const token of tokensOf(node)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
      found.set(`${line}:${token}`, { file, line: line + 1, token, snippet: (lines[line] ?? "").trim() });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return [...found.values()].sort((a, b) => a.line - b.line);
}

function findWireLeaks(file: string, source: string): Leak[] {
  return findLeaks(file, source, wireTokens);
}

function findNetworkLeaks(file: string, source: string): Leak[] {
  return findLeaks(file, source, networkTokens);
}

/** Empty when the seam holds; the rule plus every offending line when it does not. */
function violationReport(rule: string, leaks: Leak[]): string {
  if (leaks.length === 0) return "";

  const offences = leaks.map((leak) => `  ${leak.file}:${leak.line} uses "${leak.token}" -> ${leak.snippet}`);
  return [rule, ...offences].join("\n");
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

describe("the Prometheus wire seam", () => {
  const sources = providerSources();

  test("the guard scans the whole provider directory", () => {
    expect(sources).toContain(TRANSPORT_FILE);
    expect(sources).toContain(REQUEST_FILE);
    expect(sources.length).toBeGreaterThan(2);
  });

  // A detector that finds nothing anywhere is indistinguishable from a broken one, so the file that is
  // SUPPOSED to speak the wire must light up every token, the members it deliberately does not read
  // included, because the transport is also the record of what the wire carries.
  test.each(WIRE_VOCABULARY)("the transport itself uses %s, proving the detector reads real code", (token) => {
    const tokens = findWireLeaks(TRANSPORT_FILE, readProviderSource(TRANSPORT_FILE)).map((leak) => leak.token);

    expect(tokens).toContain(token);
  });

  test(`the wire is spoken only in ${TRANSPORT_FILE}`, () => {
    const leaks = sources
      .filter((file) => file !== TRANSPORT_FILE)
      .flatMap((file) => findWireLeaks(file, readProviderSource(file)));

    expect(violationReport(WIRE_RULE, leaks)).toBe("");
  });

  test("the transport reaches the network only through the sender it was given", () => {
    // The construction first, as the control: the one call that sends is the injected one.
    expect(readProviderSource(TRANSPORT_FILE)).toContain("this.deps.send(request)");
    expect(findNetworkLeaks(TRANSPORT_FILE, readProviderSource(TRANSPORT_FILE))).toEqual([]);
  });
});

describe("the Prometheus network seam", () => {
  const sources = providerSources();

  test.each(REQUEST_VOCABULARY)("the request module itself uses %s, proving the detector reads real code", (token) => {
    const tokens = findNetworkLeaks(REQUEST_FILE, readProviderSource(REQUEST_FILE)).map((leak) => leak.token);

    expect(tokens).toContain(token);
  });

  test(`the network is reached only from ${REQUEST_FILE}`, () => {
    const leaks = sources
      .filter((file) => file !== REQUEST_FILE)
      .flatMap((file) => findNetworkLeaks(file, readProviderSource(file)));

    expect(violationReport(NETWORK_RULE, leaks)).toBe("");
  });
});

describe("the seam guard detectors", () => {
  /**
   * Everything a compliant provider file legitimately does: name the wire in prose, read the neutral seam
   * (whose field names include engine words), slice the transport with a Pick of method names, read a
   * health probe's path as data, pick a flag by name, and call helpers whose names merely contain "fetch".
   * None of it is a leak, and none of it may fire.
   */
  const COMPLIANT_SAMPLE = `
/**
 * Prose may name the wire: http-transport.ts POSTs to /api/v1/query, sends match[] to /api/v1/series,
 * reads resultType, errorType, activeTargets and headStats, and builds the authorization header. It never
 * calls fetch, and request.ts is the only file that imports node:https. A comment is free.
 */
import type { PrometheusTransport, PrometheusTsdbStatus, TimeWindow } from "./transport";
import { PrometheusTransportError } from "./transport";
import { ALL_METRICS_SELECTOR, metricSelector } from "./promql";

type Reader = Pick<PrometheusTransport, "query" | "metricNames" | "seriesLabels" | "scrapePools" | "targets" | "health">;

export function headOf(tsdb: PrometheusTsdbStatus, flags: Readonly<Record<string, string>>) {
  const head = [tsdb.head?.series, tsdb.head?.chunks, tsdb.head?.minTimeMs, tsdb.head?.maxTimeMs];
  return { head, top: tsdb.seriesByMetric, labels: tsdb.valuesByLabel, ceiling: flags["web.max-connections"] };
}

export async function readInventory(transport: Reader, window: TimeWindow) {
  try {
    const names = await transport.metricNames(window, 2001);
    const series = await transport.seriesLabels(ALL_METRICS_SELECTOR, window, 20_000);
    const pools = await transport.scrapePools();
    const targets = await transport.targets(pools[0]);
    const rows = targets.map((target) => [target.scrapePool, target.scrapeUrl, target.health, target.lastError]);
    const health = await transport.health();
    const said = health.probes.map((probe) => \`\${probe.path} answered \${probe.status}\`);
    const answer = await transport.query(metricSelector("up"), { timeoutMs: 30_000, seriesLimit: 500 });
    const warnings = answer.notices.filter((notice) => notice.level === "warning");
    const infos = answer.notices.filter((notice) => notice.level === "info");
    const kind = "scrape_pool";
    const label = "__name__";
    const truncated = names.truncatedByServer || series.truncatedByServer;
    const more = await fetchMetricNames(transport);
    return { rows, said, warnings, infos, kind, label, truncated, more };
  } catch (error) {
    if (error instanceof PrometheusTransportError && error.category === "bad_data") return null;
    throw error;
  }
}
`;

  const VIOLATING_SAMPLE = `
export async function readTargets(origin: string, token: string) {
  const response = await fetch(\`\${origin}/api/v1/targets?state=active\`, {
    headers: { authorization: \`Bearer \${token}\` },
  });
  const document = await response.json();
  if (document.status === "error") throw new Error(document.errorType);
  return { active: document.data.activeTargets, pool: document.data["scrapePool"] };
}
`;

  test("pass a file that stays behind both seams", () => {
    expect(findWireLeaks("objects.ts", COMPLIANT_SAMPLE)).toEqual([]);
    expect(findNetworkLeaks("objects.ts", COMPLIANT_SAMPLE)).toEqual([]);
  });

  test("fail a file that speaks the wire, once per line and token", () => {
    const leaks = findWireLeaks("objects.ts", VIOLATING_SAMPLE);

    expect(leaks.map((leak) => leak.token)).toEqual([
      "/api/v1/targets",
      "authorization",
      "errorType",
      "activeTargets",
      "scrapePool",
    ]);
    expect(leaks.map((leak) => leak.line)).toEqual([3, 4, 7, 8, 8]);
    expect(leaks[2]?.snippet).toBe('if (document.status === "error") throw new Error(document.errorType);');
  });

  test("fail a file that reaches the network", () => {
    expect(findNetworkLeaks("objects.ts", VIOLATING_SAMPLE)).toEqual([
      {
        file: "objects.ts",
        line: 3,
        token: "fetch",
        snippet: "const response = await fetch(`${origin}/api/v1/targets?state=active`, {",
      },
    ]);
  });

  test.each<[string, string, string]>([
    ["the query path", 'const path = "/api/v1/query";', "/api/v1/query"],
    ["the label-values path built into a template", "const path = `/api/v1/label/${name}/values`;", "/api/v1/label/"],
    ["the label names path", 'const path = "/api/v1/labels";', "/api/v1/labels"],
    ["the series path", 'const path = "/api/v1/series";', "/api/v1/series"],
    ["the metadata path", 'const path = "/api/v1/metadata";', "/api/v1/metadata"],
    ["the rules path", 'const path = "/api/v1/rules";', "/api/v1/rules"],
    ["the scrape pools path", 'const path = "/api/v1/scrape_pools";', "/api/v1/scrape_pools"],
    ["the targets path", 'const path = "/api/v1/targets";', "/api/v1/targets"],
    ["the build information path", 'const path = "/api/v1/status/buildinfo";', "/api/v1/status/buildinfo"],
    ["the runtime information path", 'const path = "/api/v1/status/runtimeinfo";', "/api/v1/status/runtimeinfo"],
    ["the flags path", 'const path = "/api/v1/status/flags";', "/api/v1/status/flags"],
    ["the TSDB status path", 'const path = "/api/v1/status/tsdb";', "/api/v1/status/tsdb"],
    ["a liveness path compared as a literal", 'if (probe.path === "/-/healthy") return;', "/-/healthy"],
    ["the readiness path", 'const path = "/-/ready";', "/-/ready"],
    ["the fallback health path", 'const path = "/health";', "/health"],
    ["the matcher parameter", 'params.set("match[]", selector);', "match[]"],
    ["the group filter", 'params.append("rule_group[]", group);', "rule_group[]"],
    ["the file filter", 'params.append("file[]", file);', "file[]"],
    ["the rule filter", 'params.append("rule_name[]", name);', "rule_name[]"],
    ["the alert exclusion", 'params.set("exclude_alerts", "true");', "exclude_alerts"],
    ["the failure type", "const type = envelope.errorType;", "errorType"],
    ["the result type", "const shape = data.resultType;", "resultType"],
    ["the active targets", "const list = data.activeTargets;", "activeTargets"],
    ["the dropped targets", "const list = data.droppedTargets;", "droppedTargets"],
    ["the series counts by metric", "const top = data.seriesCountByMetricName;", "seriesCountByMetricName"],
    ["the value counts by label", "const counts = data.labelValueCountByLabelName;", "labelValueCountByLabelName"],
    ["the head block statistics", "const head = data.headStats;", "headStats"],
    ["an auth header", "const headers = { authorization: basic };", "authorization"],
    ["an auth header spelled for HTTP", 'headers.set("Authorization", basic);', "authorization"],
    ["the warnings read by key", 'const notes = envelope["warnings"];', "warnings"],
    ["the infos read by key", 'const notes = envelope["infos"];', "infos"],
    ["the pool filter as a string", 'params.set("scrapePool", pool);', "scrapePool"],
    ["the head series read by key", 'const series = head["numSeries"];', "numSeries"],
    ["the head chunks read by key", 'const chunks = head["chunkCount"];', "chunkCount"],
    ["the head start read by key", 'const from = head["minTime"];', "minTime"],
    ["the head end read by key", 'const to = head["maxTime"];', "maxTime"],
  ])("the wire detector flags %s", (_label, source, token) => {
    const [leak, ...rest] = findWireLeaks("objects.ts", source);

    expect(rest).toEqual([]);
    expect(leak?.token).toBe(token);
    expect(leak?.line).toBe(1);
  });

  test.each<[string, string, string]>([
    ["a direct fetch", 'await fetch(url, { method: "POST" });', "fetch"],
    ["a guarded fetch outside the request module", "await httpTransportFetch(url);", "httpTransportFetch"],
    ["a fetch off globalThis", "await globalThis.fetch(url);", "fetch"],
    ["a fetch read by key", 'const send = globalThis["fetch"];', "fetch"],
    ["an https import", 'import { request } from "node:https";', "node:https"],
    ["an http import", 'import { request } from "node:http";', "node:http"],
    ["an http2 import", 'import { connect } from "node:http2";', "node:http2"],
    ["an undici import", 'import { request } from "undici";', "undici"],
    ["a dynamic https import", 'const https = await import("node:https");', "node:https"],
    ["an inline import type", 'let response: import("node:http").IncomingMessage;', "node:http"],
    ["an https import by its bare name", 'import { request } from "https";', "node:https"],
    ["a tls import", 'import { connect } from "node:tls";', "node:tls"],
    ["a net module through require", 'const net = require("net");', "node:net"],
    ["an http module re-exported", 'export { request } from "node:http";', "node:http"],
    ["an http2 module through import-equals", 'import http2 = require("http2");', "node:http2"],
  ])("the network detector flags %s", (_label, source, token) => {
    const [leak, ...rest] = findNetworkLeaks("objects.ts", source);

    expect(rest).toEqual([]);
    expect(leak?.token).toBe(token);
    expect(leak?.line).toBe(1);
  });

  test.each([
    ["the seam's target fields", "const { scrapePool, scrapeUrl, lastError, health, discoveredLabels } = target;"],
    [
      "the seam's head block fields",
      "const span = [tsdb.head?.series, tsdb.head?.chunks, tsdb.head?.minTimeMs, tsdb.head?.maxTimeMs];",
    ],
    ["the seam's top lists", "const top = [tsdb.seriesByMetric, tsdb.valuesByLabel];"],
    ["a local list of info notices", 'const infos = answer.notices.filter((notice) => notice.level === "info");'],
    ["a shaped result's warnings", "for (const warning of shaped.warnings) render(warning.message);"],
    ["a kind id", 'const kind = "scrape_pool";'],
    ["a flag the overview reads", 'const ceiling = flags["web.max-connections"];'],
    ["a transport slice", 'type Reader = Pick<PrometheusTransport, "query" | "scrapePools" | "targets" | "health">;'],
    ["a probe read as data", "const said = probes.map((probe) => `${probe.path} answered ${probe.status}`);"],
    ["the metric name label", 'const label = "__name__";'],
    ["the all-metrics selector", `const selector = '{__name__=~".+"}';`],
    ["a category checked by name", 'if (error.category === "bad_data") return [];'],
    ["a helper whose name holds fetch", "const names = await fetchMetricNames(transport);"],
    ["a selector from the one builder", 'const selector = metricSelector("up");'],
    ["the URL module", 'import { urlToHttpOptions } from "node:url";'],
    [
      "the schemes the shared endpoint builder takes",
      'const origin = httpOrigin(secure ? "https" : "http", host, port);',
    ],
  ])("the detectors pass %s", (_label, source) => {
    expect(findWireLeaks("objects.ts", source)).toEqual([]);
    expect(findNetworkLeaks("objects.ts", source)).toEqual([]);
  });

  test("a report is empty when the seam holds", () => {
    expect(violationReport(WIRE_RULE, [])).toBe("");
    expect(violationReport(NETWORK_RULE, [])).toBe("");
  });

  test("the wire report explains the rule and points at the issue", () => {
    const leak = 'if (probe.path === "/-/healthy") return;';
    const report = violationReport(WIRE_RULE, findWireLeaks("monitoring.ts", leak));

    expect(report).toContain("#1085");
    expect(report).toContain(TRANSPORT_FILE);
    expect(report).toContain("PrometheusQueryData");
    expect(report).toContain('monitoring.ts:1 uses "/-/healthy" -> if (probe.path === "/-/healthy") return;');
  });

  test("the network report explains the rule and points at the issue", () => {
    const report = violationReport(NETWORK_RULE, findNetworkLeaks("objects.ts", "await globalThis.fetch(url);"));

    expect(report).toContain("#1085");
    expect(report).toContain(REQUEST_FILE);
    expect(report).toContain("SendRequest");
    expect(report).toContain('objects.ts:1 uses "fetch" -> await globalThis.fetch(url);');
  });
});
