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
 * 3. The source: every place `http-transport.ts` hands a path to the URL builder or to its senders passes a member
 *    of `PATHS` or the `path` parameter of a private helper, and every call of those helpers passes a member of
 *    `PATHS`, so no path is spelled or assembled anywhere else in the file.
 *
 * 4. The live run: tests/fixtures/prometheus/v3.13.3/write-reach/write-reach.json, written by
 *    tests/live/prometheus-write-reach.ts through its run.sh against a Prometheus 3.13.3 by digest with the admin API,
 *    the remote-write receiver and the lifecycle endpoints on, records the TSDB head's series count unchanged across
 *    every provider surface on a read-only connection and on both agent profiles, and moved by one raw remote write.
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

describe("http-transport.ts builds every request path from PATHS", () => {
  const source = ts.createSourceFile(
    TRANSPORT_SOURCE,
    readFileSync(TRANSPORT_SOURCE, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );

  /** Every call whose first argument is a path: the URL builder and the three helpers that take one. */
  function pathCalls(): { callee: string; argument: ts.Expression; inHelper: boolean }[] {
    const found: { callee: string; argument: ts.Expression; inHelper: boolean }[] = [];
    const visit = (node: ts.Node, helper: string | null): void => {
      const inside =
        ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && PRIVATE_HELPERS.includes(node.name.text)
          ? node.name.text
          : helper;
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const callee = node.expression.name.text;
        const argument = node.arguments[0];
        if (["url", "call", "probe", "read", "getRequest"].includes(callee) && argument !== undefined) {
          found.push({ callee, argument, inHelper: inside !== null });
        }
      }
      ts.forEachChild(node, (child) => visit(child, inside));
    };
    visit(source, null);
    return found;
  }

  test("a public method passes only a PATHS member, and a helper only passes on its own path parameter", () => {
    const calls = pathCalls();
    expect(calls.length).toBeGreaterThan(0);
    for (const { callee, argument, inHelper } of calls) {
      const accepted = isPathsMember(argument) || (inHelper && ts.isIdentifier(argument) && argument.text === "path");
      expect({ callee, argument: argument.getText(source), accepted }).toEqual({
        callee,
        argument: argument.getText(source),
        accepted: true,
      });
    }
  });

  test("the check above sees a spelled path and a path a public method builds", () => {
    const sample = ts.createSourceFile(
      "sample.ts",
      'class T { async a() { await this.call("/api/v1/admin/tsdb/snapshot"); } async b(p: string) { await this.probe(p); } }',
      ts.ScriptTarget.Latest,
      true,
    );
    const rejected: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const argument = node.arguments[0];
        if (argument !== undefined && !isPathsMember(argument)) rejected.push(argument.getText(sample));
      }
      ts.forEachChild(node, visit);
    };
    visit(sample);
    expect(rejected).toEqual(['"/api/v1/admin/tsdb/snapshot"', "p"]);
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
