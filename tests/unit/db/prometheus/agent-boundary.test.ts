/**
 * The Prometheus agent path's boundary, replayed from the live capture
 * (tests/fixtures/prometheus/v3.13.3/agent-boundary/boundary.json, written by tests/live/prometheus-agent-boundary.ts
 * through its run.sh): a Prometheus 3.13.3 with the admin API, the remote-write receiver and the lifecycle endpoints
 * on, and a VictoriaMetrics v1.152.0, both by digest.
 *
 * What it holds: every request the provider sent on either server's agent-mode handles was a GET of a read path or the
 * one instant query POST, carrying only the parameters the console's request builder writes; the requests the reader
 * refused sent nothing; Studio's reads left the server's state as it was; the same admin, write and lifecycle requests,
 * sent raw by the capture script and never by Studio, were each taken by the server, which is why the closed table and
 * not the server is the boundary; and the targets the agent was shown carry no userinfo, query string or scrape
 * parameter, while the raw targets did.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PROMETHEUS_AGENT_PROJECTION } from "@/lib/db/providers/timeseries/prometheus/agent-projection";
import { PROMETHEUS_AGENT_WITHHELD } from "@/lib/db/providers/timeseries/prometheus/agent-surface";

interface SentRecord {
  readonly method: string;
  readonly path: string;
  readonly urlParameters: readonly string[];
  readonly formParameters: readonly string[];
}

interface Outcome {
  readonly ok: boolean;
  readonly answer?: unknown;
  readonly error?: string;
  readonly message?: string;
}

interface AgentCapture {
  readonly reads: Readonly<Record<string, Outcome>>;
  readonly refusedBeforeSend: Readonly<Record<string, Outcome>>;
  readonly refusalsSentNothing: boolean;
  readonly surfaces: Readonly<Record<string, Outcome>>;
}

interface TargetShape {
  readonly scrapePool: string;
  readonly scrapeUrl: { readonly query: boolean; readonly userinfo: boolean };
  readonly address: { readonly query: boolean; readonly userinfo: boolean };
  readonly scrapeParameters: readonly string[];
}

interface Capture {
  readonly prometheus: {
    readonly agent: AgentCapture;
    readonly sentByStudio: readonly SentRecord[];
    readonly studioLeftStateUnchanged: boolean;
    readonly stateBefore: { readonly seedSamplesAtFixedInstant: readonly string[]; readonly lastConfigTime: string };
    readonly stateAfterRaw: { readonly seedSamplesAtFixedInstant: readonly string[]; readonly lastConfigTime: string };
    readonly rawTargets: readonly TargetShape[];
    readonly rawRequests: readonly { readonly method: string; readonly path: string; readonly status: number }[];
    readonly flags: { readonly count: number; readonly names: readonly string[] };
  };
  readonly victoriametrics: {
    readonly agent: AgentCapture;
    readonly sentByStudio: readonly SentRecord[];
    readonly rawTargets: readonly TargetShape[];
    readonly rawRequests: readonly { readonly method: string; readonly path: string; readonly status: number }[];
  };
}

const FILE = path.resolve(import.meta.dir, "../../../fixtures/prometheus/v3.13.3/agent-boundary/boundary.json");
const TEXT = readFileSync(FILE, "utf8");
const CAPTURE = JSON.parse(TEXT) as Capture;

/** The provider's closed table of read paths, as `agent-provider.test.ts` spells it. */
const READ_PATHS: ReadonlySet<string> = new Set([
  "/api/v1/query",
  "/api/v1/label/__name__/values",
  "/api/v1/labels",
  "/api/v1/series",
  "/api/v1/metadata",
  "/api/v1/rules",
  "/api/v1/scrape_pools",
  "/api/v1/targets",
  "/api/v1/status/buildinfo",
  "/api/v1/status/runtimeinfo",
  "/api/v1/status/tsdb",
  "/-/healthy",
  "/health",
  "/-/ready",
]);

const statusOf = (requests: Capture["prometheus"]["rawRequests"], wanted: string): number | undefined =>
  requests.find((request) => request.path === wanted)?.status;

describe.each([
  ["Prometheus 3.13.3", CAPTURE.prometheus],
  ["VictoriaMetrics v1.152.0", CAPTURE.victoriametrics],
] as const)("%s", (_name, server) => {
  test("every request Studio sent is a GET of a read path or the instant query, with the builder's parameters only", () => {
    expect(server.sentByStudio.length).toBeGreaterThan(0);
    for (const request of server.sentByStudio) {
      expect(READ_PATHS.has(request.path)).toBe(true);
      if (request.path === "/api/v1/query") {
        expect(request.method).toBe("POST");
        expect(request.urlParameters).toEqual([]);
        expect(request.formParameters).toEqual(["query", "timeout", "limit"]);
      } else {
        expect(request.method).toBe("GET");
        expect(request.formParameters).toEqual([]);
      }
    }
  });

  test("the reads the reader refused sent nothing, each in agent mode's words", () => {
    expect(server.agent.refusalsSentNothing).toBe(true);
    for (const [name, refusal] of Object.entries(server.agent.refusedBeforeSend)) {
      expect(refusal.ok).toBe(false);
      expect(refusal.error).toBe("RefusedBeforeSendError");
      if (name !== "console")
        expect(refusal.message).toContain("Agent mode on Prometheus reads with one PromQL expression");
    }
    expect(server.agent.refusedBeforeSend.console.message).toBe(PROMETHEUS_AGENT_WITHHELD.query);
  });

  test("a vector, a matrix and an aggregation are answered, and the budgets refuse in Studio's words", () => {
    for (const read of ["vector", "matrix", "aggregate"]) expect(server.agent.reads[read].ok).toBe(true);
    expect(server.agent.reads.rowBudget.message).toStartWith("Read-only execution exceeded the row budget:");
    expect(server.agent.reads.byteBudget.message).toStartWith("Read-only execution exceeded the byte budget:");
    expect(server.agent.reads.timeBudget.message).toStartWith("Read-only execution exceeded the time budget:");
    expect(server.agent.reads.timeBudget.message).toContain("This is Studio's refusal, not the server's answer.");
    expect(server.agent.reads.parseError.message).toStartWith(
      "The server could not parse the expression (category bad_data):",
    );
  });

  test("the targets the agent was shown carry no userinfo or query string, while the raw ones did", () => {
    const names = server.agent.surfaces.targets.answer as string[];
    expect(names.some((name) => name.includes(PROMETHEUS_AGENT_PROJECTION.mark))).toBe(true);
    expect(server.rawTargets.some((target) => target.scrapeUrl.query)).toBe(true);
    expect(server.rawTargets.some((target) => target.address.userinfo)).toBe(true);
    expect(server.rawTargets.some((target) => target.scrapeParameters.includes("__param_token"))).toBe(true);
  });

  test("the overview is withheld with its reason", () => {
    expect(server.agent.surfaces.overview.message).toBe(PROMETHEUS_AGENT_WITHHELD.overview);
  });
});

describe("Prometheus 3.13.3 with the admin, remote-write and lifecycle flags on", () => {
  const server = CAPTURE.prometheus;

  test("Studio's reads left the server's state as it was", () => {
    expect(server.studioLeftStateUnchanged).toBe(true);
    expect(server.stateBefore.seedSamplesAtFixedInstant.length).toBe(1);
  });

  test("the same admin and lifecycle requests sent raw were taken, so the table is the boundary", () => {
    expect(statusOf(server.rawRequests, "/api/v1/admin/tsdb/delete_series")).toBe(204);
    expect(statusOf(server.rawRequests, "/api/v1/admin/tsdb/clean_tombstones")).toBe(204);
    expect(statusOf(server.rawRequests, "/api/v1/admin/tsdb/snapshot")).toBe(200);
    expect(statusOf(server.rawRequests, "/-/reload")).toBe(200);
    expect(statusOf(server.rawRequests, "/-/quit")).toBe(200);
    // The remote-write receiver read the body, an empty one it could not decode; OTLP was off.
    expect(statusOf(server.rawRequests, "/api/v1/write")).toBe(400);
    expect(statusOf(server.rawRequests, "/api/v1/otlp/v1/metrics")).toBe(404);
    // The raw deletion removed the seeded samples and the raw reload moved the configuration time.
    expect(server.stateAfterRaw.seedSamplesAtFixedInstant).toEqual([]);
    expect(server.stateAfterRaw.lastConfigTime).not.toBe(server.stateBefore.lastConfigTime);
  });

  test("the flags the agent never reads name paths and addresses", () => {
    expect(server.flags.names).toContain("config.file");
    expect(server.flags.names).toContain("storage.tsdb.path");
    expect(server.flags.names).toContain("web.external-url");
    expect(server.flags.count).toBe(server.flags.names.length);
  });

  test("the server's own sample limit is refused by its category, never in its text", () => {
    expect(server.agent.reads.sampleLimit.message).toStartWith(
      "The server refused to evaluate the expression (category execution)",
    );
    expect(server.agent.reads.sampleLimit.message).not.toContain("samples into memory");
  });
});

describe("VictoriaMetrics v1.152.0", () => {
  const server = CAPTURE.victoriametrics;

  test("its own import and admin endpoints were taken raw, and the agent path sent none of them", () => {
    expect(statusOf(server.rawRequests, "/api/v1/import")).toBe(204);
    expect(statusOf(server.rawRequests, "/api/v1/admin/tsdb/delete_series")).toBe(204);
    expect(statusOf(server.rawRequests, "/snapshot/create")).toBe(200);
    expect(statusOf(server.rawRequests, "/internal/force_merge")).toBe(200);
    for (const request of server.sentByStudio) {
      expect(["/api/v1/import", "/api/v1/admin/tsdb/delete_series", "/snapshot/create"]).not.toContain(request.path);
    }
  });
});

test("the capture holds no URL with a query token or userinfo", () => {
  expect(/[?&]token=/.test(TEXT)).toBe(false);
  expect(/:\/\/[^/\s"]*@/.test(TEXT)).toBe(false);
});
