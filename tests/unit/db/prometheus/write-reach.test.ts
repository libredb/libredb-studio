/**
 * Prometheus's write reach: the closed endpoint table `PATHS` is the whole of what Studio can ask a server for.
 *
 * Prometheus is recorded `none` on the strength of one claim: the provider builds no write request, because the
 * transport requests only the paths `PATHS` holds and every one of them is a read. This file holds the claim three
 * ways, each of which a change to the transport would have to break on purpose.
 *
 * 1. The table itself: frozen, and no value is an admin, remote-write, OTLP, reload or quit endpoint. The health and
 *    readiness probes are reads and stay.
 * 2. The transport as it runs: every method the transport object answers is called through a recording sender, and
 *    the set of paths it requested is exactly the set of `PATHS` values, the only POST being the instant query. The
 *    methods are read from the object, not from a list this file keeps, so a new method that is not driven fails.
 * 3. The source: every place `http-transport.ts` hands a path to the URL builder or to a helper that takes one
 *    passes a member of `PATHS`, or a private helper's own `path` parameter; no string or template outside the
 *    table starts with "/"; the global `URL` is never constructed or called; and only `exchange` uses the sender,
 *    only `probe` and `read` use `exchange`. The same check runs over sample sources that break each rule.
 *
 * 4. The live run: tests/fixtures/prometheus/v3.13.3/write-reach/write-reach.json, written by
 *    tests/live/prometheus-write-reach.ts through its run.sh against a Prometheus 3.13.3 by digest with the admin API,
 *    the remote-write receiver and the lifecycle endpoints on, records the TSDB head's series count unchanged across
 *    every provider surface on a read-only connection and on both agent profiles, and moved by one raw remote write.
 *    The count sees a new series only: the admin and lifecycle endpoints leave it unchanged, so it is the recorded
 *    request list, `sentByStudio`, that shows none of them was asked.
 *
 * The network module, `request.ts`, refuses redirects, and the shared endpoint builder sets the path through the URL
 * setter and refuses a URL whose path is not the one it was given; both are held by their own tests.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import {
  createHttpTransport,
  PATHS,
  type PrometheusEndpoint,
} from "@/lib/db/providers/timeseries/prometheus/http-transport";
import type { InboundResponse, OutboundRequest } from "@/lib/db/providers/timeseries/prometheus/request";
import type { PrometheusTransport } from "@/lib/db/providers/timeseries/prometheus/transport";

const ROOT = join(import.meta.dir, "..", "..", "..", "..");
const CAPTURE = join(ROOT, "tests", "fixtures", "prometheus", "v3.13.3", "write-reach", "write-reach.json");
const TRANSPORT_SOURCE = join(ROOT, "src", "lib", "db", "providers", "timeseries", "prometheus", "http-transport.ts");

/** The endpoints that change a server's data, its configuration or its process, as Prometheus 3.13 serves them. */
const WRITE_PREFIXES = ["/api/v1/admin/", "/api/v1/write", "/api/v1/otlp/", "/-/reload", "/-/quit"];

const PATH_VALUES: readonly string[] = Object.values(PATHS);

const endpoint: PrometheusEndpoint = {
  url(pathname, query) {
    const url = new URL(pathname, "http://127.0.0.1:9090");
    if (query !== undefined) url.search = query.toString();
    return url;
  },
};

/** Every method of the transport, called once with arguments its signature takes; the answers do not matter. */
const CALLS: Readonly<Record<keyof PrometheusTransport, (transport: PrometheusTransport) => Promise<unknown>>> = {
  query: (transport) => transport.query("up", { timeoutMs: 1_000, seriesLimit: 10 }),
  metricNames: (transport) => transport.metricNames({ startSeconds: 0, endSeconds: 60 }, 10),
  labelNames: (transport) => transport.labelNames("up", { startSeconds: 0, endSeconds: 60 }),
  seriesLabels: (transport) => transport.seriesLabels("up", { startSeconds: 0, endSeconds: 60 }, 10),
  metadata: (transport) => transport.metadata("up"),
  rules: (transport) => transport.rules(),
  scrapePools: (transport) => transport.scrapePools(),
  targets: (transport) => transport.targets("prometheus"),
  health: (transport) => transport.health(),
  buildInfo: (transport) => transport.buildInfo(),
  runtimeInfo: (transport) => transport.runtimeInfo(),
  flags: (transport) => transport.flags(),
  tsdbStatus: (transport) => transport.tsdbStatus(10),
};

/** The public methods the transport object really answers, read from its prototype chain. */
function methodsOf(transport: PrometheusTransport): string[] {
  const names = new Set<string>();
  for (let proto = Object.getPrototypeOf(transport); proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== "constructor" && typeof (transport as unknown as Record<string, unknown>)[name] === "function") {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

/** The private helpers of the transport class, which a public method must not reach around. */
const PRIVATE_HELPERS = ["probe", "call", "getRequest", "read", "exchange"];

describe("PATHS, the closed endpoint table", () => {
  test("is frozen", () => {
    expect(Object.isFrozen(PATHS)).toBe(true);
  });

  test("holds no admin, remote-write, OTLP, reload or quit endpoint", () => {
    for (const path of PATH_VALUES) {
      expect({ path, write: WRITE_PREFIXES.some((prefix) => path.startsWith(prefix)) }).toEqual({
        path,
        write: false,
      });
    }
  });

  test("keeps the liveness and readiness probes, which are reads", () => {
    expect(PATH_VALUES).toContain("/-/healthy");
    expect(PATH_VALUES).toContain("/-/ready");
    expect(PATH_VALUES).toContain("/health");
  });
});

describe("the transport requests exactly the PATHS values", () => {
  test("every method it answers is driven here, and the requests reach every path and no other", async () => {
    const sent: OutboundRequest[] = [];
    const send = (request: OutboundRequest): Promise<InboundResponse> => {
      sent.push(request);
      // A 404 from the liveness probe is what sends the fallback probe, so both health paths are requested.
      const status = request.url.pathname === "/-/healthy" ? 404 : 200;
      return Promise.resolve({ status, contentType: "application/json", body: '{"status":"success","data":{}}' });
    };
    const transport = createHttpTransport({}, { send, endpoint, requestTimeoutMs: 1_000, maxResponseBytes: 4_096 });

    expect(methodsOf(transport)).toEqual([...Object.keys(CALLS), ...PRIVATE_HELPERS].sort());
    for (const call of Object.values(CALLS)) {
      // An answer the decoder cannot read is a refusal after the request, which is all this test needs.
      await call(transport).catch(() => undefined);
    }

    expect([...new Set(sent.map((request) => request.url.pathname))].sort()).toEqual([...PATH_VALUES].sort());
    for (const request of sent) {
      expect({ path: request.url.pathname, method: request.method }).toEqual({
        path: request.url.pathname,
        method: request.url.pathname === PATHS.QUERY ? "POST" : "GET",
      });
    }
  });
});

/** Whether an expression is `PATHS.<member>` for a member the table has. */
function isPathsMember(node: ts.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "PATHS" &&
    Object.hasOwn(PATHS, node.name.text)
  );
}

/** The calls whose first argument is a path: the URL builder and the three helpers that take one. */
const PATH_TAKERS = ["url", "call", "probe", "read", "getRequest"];

/** The only methods allowed to reach each way out: the sender, and the helper that wraps it. */
const SENDERS: Readonly<Record<string, readonly string[]>> = { send: ["exchange"], exchange: ["probe", "read"] };

/** Whether a node lies inside the initializer of the `PATHS` declaration. */
function insidePathsTable(node: ts.Node): boolean {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name) && at.name.text === "PATHS") return true;
  }
  return false;
}

/** The text a string or template literal starts with, or null for any other node. */
function literalStart(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  return null;
}

/**
 * Every way a source could reach a server other than through a `PATHS` member, as one line each:
 * a path taker handed anything but a `PATHS` member (a helper may pass on its own `path` parameter),
 * a literal that starts with "/" outside the table, a URL built or parsed by the global `URL`, and a use
 * of the sender or of `exchange` from any method but the one allowed to use it.
 */
function escapes(source: ts.SourceFile): string[] {
  const found: string[] = [];
  const visit = (node: ts.Node, method: string | null): void => {
    const inside = ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) ? node.name.text : method;
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression.name.text;
      const argument = node.arguments[0];
      if (PATH_TAKERS.includes(callee) && argument !== undefined) {
        const helper = inside !== null && PRIVATE_HELPERS.includes(inside);
        const passesOwnPath = helper && ts.isIdentifier(argument) && argument.text === "path";
        if (!isPathsMember(argument) && !passesOwnPath) found.push(`${callee}(${argument.getText(source)})`);
      }
    }
    const start = literalStart(node);
    if (start !== null && start.startsWith("/") && !insidePathsTable(node))
      found.push(`literal ${node.getText(source)}`);
    if ((ts.isNewExpression(node) || ts.isPropertyAccessExpression(node)) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === "URL") found.push(`URL in ${inside ?? "module scope"}`);
    }
    if (ts.isPropertyAccessExpression(node) && Object.hasOwn(SENDERS, node.name.text)) {
      const allowed = SENDERS[node.name.text];
      if (inside === null || !allowed.includes(inside))
        found.push(`${node.name.text} from ${inside ?? "module scope"}`);
    }
    ts.forEachChild(node, (child) => visit(child, inside));
  };
  visit(source, null);
  return found;
}

function parse(name: string, text: string): ts.SourceFile {
  return ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true);
}

describe("http-transport.ts reaches a server only through PATHS", () => {
  const source = parse(TRANSPORT_SOURCE, readFileSync(TRANSPORT_SOURCE, "utf8"));

  test("no path, URL or sender escapes the table and the helpers that carry its members", () => {
    expect(escapes(source)).toEqual([]);
  });

  test("the file still has the path calls and the senders the check looks for", () => {
    const text = source.getText(source);
    for (const needle of ["this.call(PATHS.", "this.probe(PATHS.", "this.exchange(", "this.deps.send("]) {
      expect({ needle, present: text.includes(needle) }).toEqual({ needle, present: true });
    }
  });

  test("the check sees a spelled path and a path a public method builds", () => {
    const sample = parse(
      "sample.ts",
      'class T { async a() { await this.call("/api/v1/admin/tsdb/snapshot"); } async b(p: string) { await this.probe(p); } }',
    );
    expect(escapes(sample)).toEqual([
      'call("/api/v1/admin/tsdb/snapshot")',
      'literal "/api/v1/admin/tsdb/snapshot"',
      "probe(p)",
    ]);
  });

  test("the check sees a literal path outside the table, a spelled or a template one", () => {
    const sample = parse(
      "sample.ts",
      'const PATHS = { READY: "/-/ready" }; const a = "/-/reload"; const b = `/api/v1/admin/${a}`; const c = `/-/quit`;',
    );
    expect(escapes(sample)).toEqual(['literal "/-/reload"', "literal `/api/v1/admin/${a}`", "literal `/-/quit`"]);
  });

  test("the check sees a URL built or parsed outside the endpoint builder", () => {
    const sample = parse(
      "sample.ts",
      "class T { async health() { const u = new URL(x, base); const v = URL.parse(y); } }",
    );
    expect(escapes(sample)).toEqual(["URL in health", "URL in health"]);
  });

  test("the check sees exchange called past probe and read, and the sender called past exchange", () => {
    const sample = parse(
      "sample.ts",
      [
        "class T {",
        "  async health() { await this.exchange(request); await this.deps.send(request); }",
        "  private async read() { await this.exchange(request); }",
        "  private async exchange() { await this.deps.send(request); }",
        "}",
        "const s = deps.send;",
      ].join("\n"),
    );
    expect(escapes(sample)).toEqual(["exchange from health", "send from health", "send from module scope"]);
  });
});

interface Capture {
  readonly server: string;
  readonly readOnlyConnectionAccepted: boolean;
  readonly surfaces: readonly {
    readonly surface: string;
    readonly ok: boolean;
    readonly seriesBefore: number;
    readonly seriesAfter: number;
  }[];
  readonly studioLeftSeriesUnchanged: boolean;
  readonly sentByStudio: readonly string[];
  readonly rawWrite: { readonly status: number; readonly seriesBefore: number; readonly seriesAfter: number };
}

describe("the live run against Prometheus 3.13.3 with every write endpoint on", () => {
  const capture = JSON.parse(readFileSync(CAPTURE, "utf8")) as Capture;

  test("ran on a server that would have taken a write", () => {
    for (const flag of ["--web.enable-admin-api", "--web.enable-remote-write-receiver", "--web.enable-lifecycle"]) {
      expect(capture.server).toContain(flag);
    }
    expect(capture.readOnlyConnectionAccepted).toBe(true);
  });

  test("left the series count unchanged across every surface of every handle", () => {
    for (const handle of ["read-only connection", "agent read-only profile", "agent operations profile"]) {
      const answered = capture.surfaces.filter((entry) => entry.surface.startsWith(`${handle}: `) && entry.ok);
      expect({ handle, answered: answered.length > 10 }).toEqual({ handle, answered: true });
    }
    for (const entry of capture.surfaces) {
      expect({ surface: entry.surface, after: entry.seriesAfter }).toEqual({
        surface: entry.surface,
        after: entry.seriesBefore,
      });
    }
    expect(capture.studioLeftSeriesUnchanged).toBe(true);
  });

  test("Studio sent only reads of the table, the instant query alone as a POST", () => {
    expect(capture.sentByStudio.length).toBeGreaterThan(0);
    for (const request of capture.sentByStudio) {
      const [method, path] = request.split(" ");
      expect({ request, inTable: PATH_VALUES.includes(path) }).toEqual({ request, inTable: true });
      expect({ request, method }).toEqual({ request, method: path === PATHS.QUERY ? "POST" : "GET" });
    }
  });

  test("the control: one raw remote write, sent by the script, added a series", () => {
    expect(capture.rawWrite.status).toBe(204);
    expect(capture.rawWrite.seriesAfter).toBe(capture.rawWrite.seriesBefore + 1);
  });
});
