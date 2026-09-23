/**
 * Prometheus transport seam (#1085, section 3.1)
 *
 * transport.ts is type declarations apart from one class, and that class is what the rest of the
 * provider switches on: errors.ts maps a failure to a repository error class by its `category`
 * alone (5.5). A category that did not survive construction, or an instance an `instanceof` check
 * could not recognise, would send every failure down the generic branch, where a timeout reads
 * like any other error.
 *
 * The second half is the seam's reason to exist. A transport written by hand, with no wire
 * document to copy from, satisfies the interface: if a seam type ever took the wire's shape, the
 * stub below could not be written without one.
 */
import { describe, expect, spyOn, test } from "bun:test";
import {
  type PrometheusErrorCategory,
  type PrometheusMetadataEntry,
  type PrometheusQueryData,
  type PrometheusRuleGroup,
  type PrometheusTarget,
  type PrometheusTransport,
  PrometheusTransportError,
  type PrometheusTsdbStatus,
  type TimeWindow,
} from "@/lib/db/providers/timeseries/prometheus/transport";

// ============================================================================
// The classified error
// ============================================================================

/**
 * Every category the contract names, as a record, so the compiler holds this file to the union:
 * a member added there is a missing property here (TS2741), whichever arm of errors.ts it is
 * later mapped by.
 */
const EVERY_CATEGORY: Record<PrometheusErrorCategory, true> = {
  bad_data: true,
  execution: true,
  timeout: true,
  canceled: true,
  unavailable: true,
  internal: true,
  unauthorized: true,
  tls: true,
  network: true,
  too_large: true,
  deadline: true,
  aborted: true,
  credential: true,
  protocol: true,
  unmeasurable: true,
};

describe("PrometheusTransportError", () => {
  test("carries the category a caller branches on, the message and the detail", () => {
    const error = new PrometheusTransportError("tls", "unable to verify the first certificate", {
      code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    });

    expect(error.category).toBe("tls");
    expect(error.message).toBe("unable to verify the first certificate");
    expect(error.detail).toEqual({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" });
  });

  // Most failures have nothing to add to their category and sentence: a parse error, a refused
  // connection. The detail is then an empty object, never undefined, so `error.detail.status`
  // can be read without testing the object first.
  test("defaults the detail to an empty object", () => {
    const error = new PrometheusTransportError("bad_data", "1:4: parse error: unexpected end of input");

    expect(error.detail).toEqual({});
    expect(error.detail.status).toBeUndefined();
  });

  test("is named for its class, so an unaware catch still reports something readable", () => {
    const error = new PrometheusTransportError("network", "connect ECONNREFUSED 127.0.0.1:9090");

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("PrometheusTransportError");
    expect(String(error)).toBe("PrometheusTransportError: connect ECONNREFUSED 127.0.0.1:9090");
  });

  // Subclassing a builtin loses the prototype under a downlevel emit, and errors.ts's mapping is
  // only as good as an instanceof check. This runtime keeps the prototype by itself, so the
  // constructor's explicit restore is asserted as a call: without it every check here would still
  // pass, and the first build that downlevels classes would map every failure generically.
  test("restores its own prototype, so an instanceof check holds that a plain Error does not pass", () => {
    const restore = spyOn(Object, "setPrototypeOf");
    try {
      const caught: unknown = new PrometheusTransportError("timeout", "query timed out in expression evaluation");

      expect(restore).toHaveBeenCalledWith(caught, PrometheusTransportError.prototype);
      expect(caught instanceof PrometheusTransportError).toBe(true);
      expect(Object.getPrototypeOf(caught)).toBe(PrometheusTransportError.prototype);
    } finally {
      restore.mockRestore();
    }
    // The control: the check is not one every error passes.
    expect(new Error("query timed out in expression evaluation") instanceof PrometheusTransportError).toBe(false);
  });

  test("carries every category of the union verbatim", () => {
    const categories = Object.keys(EVERY_CATEGORY);

    expect(categories).toHaveLength(15);
    expect(categories.map((category) => new PrometheusTransportError(category, "probe").category)).toEqual(categories);
  });

  // web/api/v1/api.go also defines not_found and not_acceptable. An engine value the union does
  // not name arrives as itself, which is why `category` is typed string.
  test("carries an engine category the union does not name, unchanged", () => {
    const error = new PrometheusTransportError("not_found", "the engine's own sentence");

    expect(error.category).toBe("not_found");
    expect(Object.keys(EVERY_CATEGORY)).not.toContain("not_found");
    // The control: the list the negative reads is the union itself.
    expect(Object.keys(EVERY_CATEGORY)).toContain("bad_data");
  });
});

// ============================================================================
// The seam
// ============================================================================

const WINDOW: TimeWindow = { startSeconds: 1790154000, endSeconds: 1790157600 };

const GROUP: PrometheusRuleGroup = {
  name: "studio",
  file: "/etc/prometheus/rules/studio-a.yml",
  interval: 15,
  limit: 0,
  evaluationTime: 0.000412,
  lastEvaluation: "2026-09-23T10:00:00.123Z",
  rules: [
    {
      kind: "recording",
      name: "job:up:sum",
      query: "sum by (job) (up)",
      labels: {},
      health: "ok",
      lastError: "",
      evaluationTime: 0.0002,
      lastEvaluation: "2026-09-23T10:00:00.123Z",
    },
    {
      kind: "alerting",
      name: "AlwaysFiring",
      query: "vector(1)",
      labels: { severity: "info" },
      health: "ok",
      lastError: "",
      evaluationTime: 0.0001,
      lastEvaluation: "2026-09-23T10:00:00.124Z",
      duration: 0,
      keepFiringFor: 0,
      annotations: { summary: "Always firing." },
      state: "firing",
      alerts: [],
    },
  ],
};

const TARGET: PrometheusTarget = {
  scrapePool: "prometheus",
  scrapeUrl: "http://localhost:9090/metrics",
  health: "up",
  lastError: "",
  lastScrape: "2026-09-23T10:00:00.001Z",
  lastScrapeDuration: 0.004,
  scrapeInterval: "15s",
  scrapeTimeout: "10s",
  labels: { instance: "localhost:9090", job: "prometheus" },
  discoveredLabels: { __address__: "localhost:9090" },
};

describe("PrometheusTransport", () => {
  test("can be satisfied by hand, with no knowledge of the wire", async () => {
    const sent: string[] = [];
    const vector: PrometheusQueryData = {
      shape: "vector",
      series: [
        {
          labels: { __name__: "up", job: "prometheus" },
          samples: [{ at: 1790157600.123, value: "1" }],
          histograms: [],
        },
      ],
    };
    const stub: PrometheusTransport = {
      query: (expression) => {
        sent.push(expression);
        return Promise.resolve({ value: vector, notices: [], truncatedByServer: false });
      },
      metricNames: () => Promise.resolve({ items: ["up"], truncatedByServer: false }),
      labelNames: () => Promise.resolve(["__name__", "instance", "job"]),
      seriesLabels: () => Promise.resolve({ items: [{ __name__: "up", job: "prometheus" }], truncatedByServer: false }),
      metadata: () => Promise.resolve([{ type: "gauge", help: "Whether the target is up.", unit: "" }]),
      rules: () => Promise.resolve([GROUP]),
      scrapePools: () => Promise.resolve(["prometheus"]),
      targets: () => Promise.resolve([TARGET]),
      health: () => Promise.resolve({ probes: [{ path: "/-/healthy", status: 200 }] }),
      buildInfo: () => Promise.resolve({ version: "3.13.3" }),
      runtimeInfo: () =>
        Promise.resolve({
          startTime: "2026-09-23T09:00:00.000Z",
          serverTime: "2026-09-23T10:00:00.000Z",
          storageRetention: "15d",
        }),
      flags: () => Promise.resolve({ "web.max-connections": "512" }),
      tsdbStatus: () =>
        Promise.resolve({
          head: { series: 1, chunks: 1, minTimeMs: 1790154000000, maxTimeMs: 1790157600000 },
          seriesByMetric: [{ name: "up", value: 1 }],
          valuesByLabel: [{ name: "__name__", value: 1 }],
        }),
    };

    const answer = await stub.query("up", { timeoutMs: 60_000, seriesLimit: 500 });
    const names = await stub.metricNames(WINDOW, 2001);
    const [group] = await stub.rules();

    expect(sent).toEqual(["up"]);
    expect(answer.value).toBe(vector);
    expect(answer.truncatedByServer).toBe(false);
    expect(names).toEqual({ items: ["up"], truncatedByServer: false });
    expect(group?.rules.map((rule) => rule.kind)).toEqual(["recording", "alerting"]);
  });

  // VictoriaMetrics v1.152.0 sends no metadata unit, no target scrape interval or timeout, and no
  // head block statistics. Each value below is typed as the seam, so the compiler refuses this file
  // the moment one of those members turns required again, and nothing has to invent a value for it.
  test("carries what an engine leaves out of a description as absent, with nothing invented in its place", () => {
    const { scrapeInterval, scrapeTimeout, ...undescribed } = TARGET;
    const target: PrometheusTarget = undescribed;
    const entry: PrometheusMetadataEntry = { type: "counter", help: "Counter of HTTP requests." };
    const status: PrometheusTsdbStatus = { seriesByMetric: [{ name: "up", value: 1 }], valuesByLabel: [] };

    // The control: the full target carries both members, so their absence below is the point.
    expect([scrapeInterval, scrapeTimeout]).toEqual(["15s", "10s"]);
    expect(Object.keys(target)).not.toContain("scrapeInterval");
    expect(Object.keys(entry)).toEqual(["type", "help"]);
    expect(Object.keys(status)).toEqual(["seriesByMetric", "valuesByLabel"]);
  });
});
