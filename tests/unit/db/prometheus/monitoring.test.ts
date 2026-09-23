/**
 * Prometheus monitoring mappings and readers (#1085, section 6.2)
 *
 * Every input is built inline from the seam types of `transport.ts`, and each edge case says which
 * engine behaviour it stands for: these are pure mappings, and the captured v3.13.3 payloads reach
 * them through the real decoder in the provider's integration test, which is where a wire shape is
 * what is under test. The readers run over a recording fake of `MonitoringTransport`, so which
 * surface each one reads, and with which limit, is asserted rather than assumed. No
 * `mock.module()`: it is process-wide in bun.
 */
import { describe, expect, setSystemTime, test } from "bun:test";
import {
  healthFrom,
  metricNameCount,
  type MonitoringTransport,
  overviewFrom,
  PROMETHEUS_SCHEMA_NAME,
  readHealth,
  readOverview,
  readStorageStats,
  readTableStats,
  storageStatsFrom,
  tableStatsFrom,
  TSDB_LABEL_SCAN_LIMIT,
  TSDB_TOP_METRICS,
} from "@/lib/db/providers/timeseries/prometheus/monitoring";
import {
  type NamedCount,
  type PrometheusBuildInfo,
  type PrometheusHealth,
  type PrometheusRuntimeInfo,
  PrometheusTransportError,
  type PrometheusTsdbStatus,
} from "@/lib/db/providers/timeseries/prometheus/transport";

/**
 * A head block holding series, as the TSDB status reads once decoded: series and chunk counts, the
 * sampled span in milliseconds, and the two ranked lists the engine cuts at its `limit`.
 */
function tsdbStatus(overrides: Partial<PrometheusTsdbStatus> = {}): PrometheusTsdbStatus {
  return {
    headSeries: 1234,
    headChunks: 5678,
    headMinTimeMs: Date.parse("2026-09-23T10:00:00.000Z"),
    headMaxTimeMs: Date.parse("2026-09-23T11:59:45.000Z"),
    seriesByMetric: [
      { name: "prometheus_http_request_duration_seconds_bucket", value: 240 },
      { name: "up", value: 4 },
    ],
    valuesByLabel: [
      { name: "__name__", value: 812 },
      { name: "instance", value: 4 },
      { name: "job", value: 3 },
    ],
    ...overrides,
  };
}

/** A label-name list of `length` entries, the metric-name entry first with `metricNames` values. */
function labelsWithMetricNames(length: number, metricNames: number): NamedCount[] {
  return Array.from({ length }, (_, index) =>
    index === 0 ? { name: "__name__", value: metricNames } : { name: `label_${index}`, value: 1 },
  );
}

/** A label-name list of `length` entries with no metric-name entry, as a cut that dropped it reads. */
function labelsWithoutMetricNames(length: number): NamedCount[] {
  return Array.from({ length }, (_, index) => ({ name: `label_${index + 1}`, value: 1 }));
}

/** The moment the fixture server's own clock reads (`RUNTIME.serverTime`), for tests that move this process's. */
const NOW_MS = Date.parse("2026-09-23T12:00:00.000Z");

const BUILD: PrometheusBuildInfo = { version: "3.13.3" };

/**
 * Go writes a timestamp as RFC 3339 with nanoseconds; `Date.parse` keeps the milliseconds (bun 1.4.2).
 * The server's own clock reads two hours after the start, less the start's 123 ms.
 */
const RUNTIME: PrometheusRuntimeInfo = {
  startTime: "2026-09-23T10:00:00.123456789Z",
  serverTime: "2026-09-23T12:00:00.000000000Z",
  storageRetention: "15d",
};

/** The flag map as the engine publishes it: every flag by its name, every value a string. */
const FLAGS: Readonly<Record<string, string>> = { "web.max-connections": "512", "query.max-concurrency": "20" };

/** What a call threw, so its fields can be asserted; a call that returns fails the test by name. */
function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw, and it returned");
}

const HEALTHY: PrometheusHealth = {
  probes: [
    { path: "/-/healthy", status: 200 },
    { path: "/-/ready", status: 200 },
  ],
};

interface RecordedAnswers {
  readonly health?: PrometheusHealth;
  readonly tsdb?: PrometheusTsdbStatus;
  readonly buildInfoFailure?: Error;
}

/** The monitoring slice, recording each read as it is asked for, with the limit a status read sends. */
function recordingTransport(answers: RecordedAnswers = {}): { transport: MonitoringTransport; calls: string[] } {
  const calls: string[] = [];
  const transport: MonitoringTransport = {
    health: async () => {
      calls.push("health");
      return answers.health ?? HEALTHY;
    },
    buildInfo: async () => {
      calls.push("buildInfo");
      if (answers.buildInfoFailure !== undefined) throw answers.buildInfoFailure;
      return BUILD;
    },
    runtimeInfo: async () => {
      calls.push("runtimeInfo");
      return RUNTIME;
    },
    flags: async () => {
      calls.push("flags");
      return FLAGS;
    },
    tsdbStatus: async (limit) => {
      calls.push(`tsdbStatus(${limit})`);
      return answers.tsdb ?? tsdbStatus();
    },
  };
  return { transport, calls };
}

describe("TSDB limits", () => {
  test("the label scan asks for as many label names as one TSDB status read allows", () => {
    // `serveTSDBStatus` answers bad_data above 10,000 (web/api/v1/api.go at v3.13.3, maxTSDBLimit).
    expect(TSDB_LABEL_SCAN_LIMIT).toBe(10_000);
    expect(TSDB_TOP_METRICS).toBeLessThanOrEqual(TSDB_LABEL_SCAN_LIMIT);
  });
});

describe("metricNameCount (M2)", () => {
  test("is the metric-name entry of a list shorter than the limit it was read with", () => {
    expect(metricNameCount(tsdbStatus(), 4)).toBe(812);
  });

  test("is the entry's value even when the list reaches its limit", () => {
    // The engine cuts the list by dropping whole entries, and every entry it keeps carries its
    // label's full value count (tsdb/index/postings.go, MemPostings.Stats), so a listed entry is exact.
    expect(metricNameCount(tsdbStatus(), 3)).toBe(812);
  });

  test("is undefined at the limit when the entry is absent", () => {
    // Three label names read with a limit of 3 may be the first 3 of more, and the metric-name
    // entry may be one the cut dropped, silently.
    const withoutEntry = tsdbStatus({ valuesByLabel: labelsWithoutMetricNames(3) });
    expect(metricNameCount(withoutEntry, 3)).toBeUndefined();
    // Control: the same list read with room to spare was not cut, so the entry is truly absent.
    expect(metricNameCount(withoutEntry, 4)).toBe(0);
  });

  test("is 0 for an uncut list with no metric-name entry, which is a head holding no series", () => {
    expect(metricNameCount(tsdbStatus({ valuesByLabel: [] }), TSDB_LABEL_SCAN_LIMIT)).toBe(0);
    // Control: the same limit over a list that carries the entry reads the entry.
    expect(metricNameCount(tsdbStatus(), TSDB_LABEL_SCAN_LIMIT)).toBe(812);
  });

  test("reads the entry's value and never the list's length", () => {
    const status = tsdbStatus({ valuesByLabel: labelsWithMetricNames(TSDB_LABEL_SCAN_LIMIT - 1, 777) });
    expect(metricNameCount(status, TSDB_LABEL_SCAN_LIMIT)).toBe(777);
  });
});

describe("overviewFrom", () => {
  test("reports the version, the server's uptime, the published ceiling and the count", () => {
    const overview = overviewFrom({
      build: BUILD,
      runtime: RUNTIME,
      flags: FLAGS,
      metricCount: 812,
      formatDuration: (ms) => `${ms} ms`,
    });
    expect(overview).toEqual({
      version: "3.13.3",
      uptime: "7199877 ms",
      startTime: new Date("2026-09-23T10:00:00.123Z"),
      maxConnections: 512,
      databaseSize: "N/A",
      tableCount: 812,
      indexCount: 0,
    });
    // No byte figure and no open-connection count cross this API, so both keys are absent, not 0.
    expect(Object.keys(overview).sort()).toEqual([
      "databaseSize",
      "indexCount",
      "maxConnections",
      "startTime",
      "tableCount",
      "uptime",
      "version",
    ]);
  });

  test("a server publishing no ceiling flag published no ceiling, which DatabaseOverview spells 0", () => {
    const input = { build: BUILD, runtime: RUNTIME, metricCount: 1, formatDuration: String };
    expect(overviewFrom({ ...input, flags: {} }).maxConnections).toBe(0);
    // Control: where the flag is published, it is the number.
    expect(overviewFrom({ ...input, flags: FLAGS }).maxConnections).toBe(512);
  });

  test.each(["unlimited", "", "5.5", "-1"])("a ceiling flag of %j is refused rather than read as none", (value) => {
    const error = thrown(() =>
      overviewFrom({
        build: BUILD,
        runtime: RUNTIME,
        flags: { "web.max-connections": value },
        metricCount: 1,
        formatDuration: String,
      }),
    );
    expect(error).toBeInstanceOf(PrometheusTransportError);
    expect(error).toMatchObject({ category: "protocol" });
  });

  test("uptime reads the server's own clock, never this process's", () => {
    const formatDuration = (ms: number) => `${ms} ms`;
    const uptimeOf = (runtime: PrometheusRuntimeInfo) =>
      overviewFrom({ build: BUILD, runtime, flags: FLAGS, metricCount: 1, formatDuration }).uptime;
    try {
      setSystemTime(new Date(NOW_MS));
      expect(uptimeOf(RUNTIME)).toBe("7199877 ms");
      // This process's clock a day ahead of the server's moves nothing.
      setSystemTime(new Date(NOW_MS + 86_400_000));
      expect(uptimeOf(RUNTIME)).toBe("7199877 ms");
    } finally {
      setSystemTime();
    }
    // Control: a later server time is a longer uptime, so the equality above is about which clock is read.
    expect(uptimeOf({ ...RUNTIME, serverTime: "2026-09-23T13:00:00.000000000Z" })).toBe("10799877 ms");
  });

  test("a start time after the server's own time is no uptime at all, and the start time is still reported", () => {
    const measured: number[] = [];
    const formatDuration = (ms: number) => {
      measured.push(ms);
      return `${ms} ms`;
    };
    // A server whose clock stepped back after it started reports a server time before its start.
    const stepped = overviewFrom({
      build: BUILD,
      runtime: { ...RUNTIME, serverTime: "2026-09-23T09:59:55Z" },
      flags: FLAGS,
      metricCount: 1,
      formatDuration,
    });
    expect(stepped.uptime).toBe("N/A");
    expect(stepped.startTime).toEqual(new Date("2026-09-23T10:00:00.123Z"));
    expect(measured).toEqual([]);
    // Control: the fixture's server time is after its start time, and that duration is what gets formatted.
    overviewFrom({ build: BUILD, runtime: RUNTIME, flags: FLAGS, metricCount: 1, formatDuration });
    expect(measured).toEqual([7199877]);
  });

  test.each([
    ["startTime", "start time"],
    ["serverTime", "server time"],
  ] as const)("a %s that is not a timestamp is refused, naming it", (field, words) => {
    const error = thrown(() =>
      overviewFrom({
        build: BUILD,
        runtime: { ...RUNTIME, [field]: "yesterday" },
        flags: FLAGS,
        metricCount: 1,
        formatDuration: String,
      }),
    );
    expect(error).toBeInstanceOf(PrometheusTransportError);
    expect(error).toMatchObject({
      category: "protocol",
      message: `Prometheus reported a ${words} that is not a timestamp`,
    });
  });
});

describe("tableStatsFrom", () => {
  test("lists the top metrics by head series, the series count as the row count, and no byte figure", () => {
    const rows = tableStatsFrom(tsdbStatus());
    expect(rows).toEqual([
      {
        schemaName: PROMETHEUS_SCHEMA_NAME,
        tableName: "prometheus_http_request_duration_seconds_bucket",
        rowCount: 240,
        totalSize: "N/A",
        totalSizeBytes: 0,
      },
      { schemaName: PROMETHEUS_SCHEMA_NAME, tableName: "up", rowCount: 4, totalSize: "N/A", totalSizeBytes: 0 },
    ]);
    // The optional size pair is absent, which is what the Tables and Storage tabs read to draw N/A.
    expect(Object.keys(rows[0]).sort()).toEqual(["rowCount", "schemaName", "tableName", "totalSize", "totalSizeBytes"]);
    // A metric has no namespace above it, the search provider's containerless answer.
    expect(PROMETHEUS_SCHEMA_NAME).toBe("");
  });

  test("keeps at most TSDB_TOP_METRICS rows, whatever limit the status was read with", () => {
    const ranked = Array.from({ length: TSDB_TOP_METRICS + 10 }, (_, index) => ({
      name: `metric_${index}`,
      value: 1000 - index,
    }));
    const rows = tableStatsFrom(tsdbStatus({ seriesByMetric: ranked }));
    expect(rows).toHaveLength(TSDB_TOP_METRICS);
    expect(rows[0]?.tableName).toBe("metric_0");
    expect(rows[TSDB_TOP_METRICS - 1]?.tableName).toBe(`metric_${TSDB_TOP_METRICS - 1}`);
  });
});

describe("storageStatsFrom", () => {
  test("one head-block row: counts in its name, span and retention in its location, no byte figure", () => {
    const rows = storageStatsFrom(tsdbStatus(), RUNTIME);
    expect(rows).toEqual([
      {
        name: "Head block: 1,234 series, 5,678 chunks",
        location: "2026-09-23T10:00:00.000Z to 2026-09-23T11:59:45.000Z, retention 15d",
        size: "N/A",
        sizeBytes: 0,
      },
    ]);
    // No capacity crosses the API either, so there is no share to draw.
    expect(Object.keys(rows[0]).sort()).toEqual(["location", "name", "size", "sizeBytes"]);
  });

  test("an empty head, whose span is the engine's int64 extremes, reads as no samples", () => {
    // resetInMemoryState() starts a head at minTime MaxInt64 and maxTime MinInt64 (tsdb/head.go,
    // v3.13.3); JSON.parse turns both into these doubles, and neither is a date in range.
    const empty = tsdbStatus({
      headSeries: 0,
      headChunks: 0,
      headMinTimeMs: JSON.parse("9223372036854775807") as number,
      headMaxTimeMs: JSON.parse("-9223372036854775808") as number,
    });
    expect(storageStatsFrom(empty, RUNTIME)[0]?.location).toBe("no samples, retention 15d");
    // Control: a head with samples reports its span.
    expect(storageStatsFrom(tsdbStatus(), RUNTIME)[0]?.location).toContain(" to ");
  });
});

describe("healthFrom", () => {
  test("a server answering every probe 200 is healthy, with nothing it cannot measure filled in", () => {
    const health = healthFrom(HEALTHY);
    expect(health).toEqual({ databaseSize: "N/A", cacheHitRatio: "N/A", slowQueries: [], activeSessions: [] });
    // `activeConnections` is absent: nothing counts open connections over this API.
    expect(Object.keys(health).sort()).toEqual(["activeSessions", "cacheHitRatio", "databaseSize", "slowQueries"]);
  });

  test("names the first probe that answered neither 200 nor a superseded 404, with its status", () => {
    const error = thrown(() =>
      healthFrom({
        probes: [
          { path: "/-/healthy", status: 200 },
          { path: "/-/ready", status: 503 },
        ],
      }),
    );
    expect(error).toBeInstanceOf(PrometheusTransportError);
    expect(error).toMatchObject({
      category: "unavailable",
      message: "Prometheus answered its health probe /-/ready with HTTP 503",
      detail: { status: 503 },
    });
  });

  test("a 404 from /-/healthy that /health answered 200 is the fallback, not a failure", () => {
    const fallback: PrometheusHealth = {
      probes: [
        { path: "/-/healthy", status: 404 },
        { path: "/health", status: 200 },
        { path: "/-/ready", status: 200 },
      ],
    };
    expect(healthFrom(fallback)).toEqual(healthFrom(HEALTHY));
    // Control: the same fallback answering 503 is a failure, and it is the probe named.
    const failing: PrometheusHealth = {
      probes: [
        { path: "/-/healthy", status: 404 },
        { path: "/health", status: 503 },
        { path: "/-/ready", status: 200 },
      ],
    };
    expect(thrown(() => healthFrom(failing))).toMatchObject({
      category: "unavailable",
      message: "Prometheus answered its health probe /health with HTTP 503",
    });
  });

  test("a /health that answered 404 is the failure named, never the /-/healthy 404 it superseded", () => {
    const withReadiness = (status: number): PrometheusHealth => ({
      probes: [
        { path: "/-/healthy", status: 404 },
        { path: "/health", status: 404 },
        { path: "/-/ready", status },
      ],
    });
    const named = { category: "unavailable", message: "Prometheus answered its health probe /health with HTTP 404" };
    expect(thrown(() => healthFrom(withReadiness(404)))).toMatchObject(named);
    // A ready server changes nothing: the fallback's own 404 is still the failure.
    expect(thrown(() => healthFrom(withReadiness(200)))).toMatchObject(named);
  });

  test("a 404 that no fallback followed is a failure", () => {
    const readinessMissing: PrometheusHealth = {
      probes: [
        { path: "/-/healthy", status: 200 },
        { path: "/-/ready", status: 404 },
      ],
    };
    expect(thrown(() => healthFrom(readinessMissing))).toMatchObject({
      category: "unavailable",
      message: "Prometheus answered its health probe /-/ready with HTTP 404",
      detail: { status: 404 },
    });
    // Control: the same read with readiness answering 200 is healthy.
    expect(() => healthFrom(HEALTHY)).not.toThrow();
  });

  test("a read that carries no probe has nothing to judge and is refused as a fault in the answer", () => {
    expect(thrown(() => healthFrom({ probes: [] }))).toMatchObject({ category: "protocol" });
  });
});

describe("the readers", () => {
  test("readOverview reads build, runtime, flags and one label scan, each once", async () => {
    const { transport, calls } = recordingTransport();
    const overview = await readOverview(transport, (ms) => `${ms} ms`);
    expect(overview.tableCount).toBe(812);
    expect(overview.version).toBe("3.13.3");
    expect([...calls].sort()).toEqual(["buildInfo", "flags", "runtimeInfo", `tsdbStatus(${TSDB_LABEL_SCAN_LIMIT})`]);
  });

  test("readOverview refuses a metric count it cannot make exact, and never reports the list's length", async () => {
    // A full list the metric-name entry is not in: the engine's cut may have dropped it.
    const cut = recordingTransport({
      tsdb: tsdbStatus({ valuesByLabel: labelsWithoutMetricNames(TSDB_LABEL_SCAN_LIMIT) }),
    });
    const refused = readOverview(cut.transport, String);
    await expect(refused).rejects.toBeInstanceOf(PrometheusTransportError);
    await expect(refused).rejects.toMatchObject({ category: "unmeasurable" });
    await expect(refused).rejects.toThrow(`${TSDB_LABEL_SCAN_LIMIT.toLocaleString("en-US")} label names`);
    // Control: a full list that carries the entry reads the entry, not the 10,000 names.
    const listed = recordingTransport({
      tsdb: tsdbStatus({ valuesByLabel: labelsWithMetricNames(TSDB_LABEL_SCAN_LIMIT, 777) }),
    });
    expect((await readOverview(listed.transport, String)).tableCount).toBe(777);
  });

  test("readHealth judges the probes, then proves the API answers with the build read", async () => {
    const { transport, calls } = recordingTransport();
    expect(await readHealth(transport)).toEqual(healthFrom(HEALTHY));
    expect(calls).toEqual(["health", "buildInfo"]);
  });

  test("readHealth stops at an unhealthy probe and sends nothing after it", async () => {
    const { transport, calls } = recordingTransport({ health: { probes: [{ path: "/-/healthy", status: 500 }] } });
    await expect(readHealth(transport)).rejects.toMatchObject({ category: "unavailable" });
    expect(calls).toEqual(["health"]);
  });

  test("readHealth fails when the API behind healthy probes does not answer", async () => {
    const down = new PrometheusTransportError(
      "protocol",
      "Prometheus answered with a body that is not the API envelope",
    );
    const { transport } = recordingTransport({ buildInfoFailure: down });
    await expect(readHealth(transport)).rejects.toBe(down);
  });

  test("readTableStats reads the top metrics by series once, at TSDB_TOP_METRICS", async () => {
    const { transport, calls } = recordingTransport();
    expect(await readTableStats(transport)).toEqual(tableStatsFrom(tsdbStatus()));
    expect(calls).toEqual([`tsdbStatus(${TSDB_TOP_METRICS})`]);
  });

  test("readStorageStats reads the head and the retention, at the limit the table read sends", async () => {
    const { transport, calls } = recordingTransport();
    expect(await readStorageStats(transport)).toEqual(storageStatsFrom(tsdbStatus(), RUNTIME));
    expect([...calls].sort()).toEqual(["runtimeInfo", `tsdbStatus(${TSDB_TOP_METRICS})`]);
  });
});
