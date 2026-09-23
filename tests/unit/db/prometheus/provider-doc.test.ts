/**
 * `docs/providers/prometheus.md` quotes numbers and strings the code owns.
 *
 * Five of the numbers were set by a live measurement (#1085 section 10), so each is a named
 * constant and the doc states it in the row of the measurement that decided it. A value copied
 * into prose is true only until the constant moves, and nothing else goes red when it stops
 * being true (the same reasoning as `tests/unit/provider-docs-monitoring-citations.test.ts`).
 * So every quoted value is read back against its constant, the dialog strings against what
 * `DB_UI_CONFIG` declares, the cancellation claim against the method the routes detect by
 * presence, the sentences a user reads in the tree and the source view against the object
 * surface that writes them, the escape of the PromQL string rule against the builder, and the
 * Tables caption and the storage refusal against the provider and the monitoring reader.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { connectionFieldHint, connectionFieldLabel, DB_UI_CONFIG } from "@/lib/db-ui-config";
import { createDatabaseProvider } from "@/lib/db/factory";
import { isCountSampled, SOURCE_PART_LIMIT } from "@/lib/db/object-kinds";
import { QUERY_CONCURRENCY_LIMIT } from "@/lib/db/providers/timeseries/prometheus/concurrency";
import { RESPONSE_BYTE_CAP } from "@/lib/db/providers/timeseries/prometheus/http-transport";
import { PrometheusProvider } from "@/lib/db/providers/timeseries/prometheus/index";
import {
  storageStatsFrom,
  TSDB_LABEL_SCAN_LIMIT,
  TSDB_TOP_METRICS,
} from "@/lib/db/providers/timeseries/prometheus/monitoring";
import {
  DESCRIBE_SERIES_CAP,
  INVENTORY_WINDOW_MS,
  METRIC_LIST_CAP,
  type ObjectsTransport,
  PrometheusObjects,
} from "@/lib/db/providers/timeseries/prometheus/objects";
import { labelNotation } from "@/lib/db/providers/timeseries/prometheus/promql";
import { MATRIX_SAMPLE_BUDGET, RESULT_BYTE_BUDGET } from "@/lib/db/providers/timeseries/prometheus/results";
import { CENSUS_CONNECTION } from "../../../helpers/census-connection";

const ROOT = path.resolve(import.meta.dir, "../../../..");
const DOC = readFileSync(path.join(ROOT, "docs/providers/prometheus.md"), "utf8");
const LINES = DOC.split("\n");

/** The table row whose first cell is exactly `cell`, or undefined. */
const rowOf = (cell: string): string | undefined => LINES.find((line) => line.startsWith(`| ${cell} |`));

describe("the measurement table quotes the constants the code uses", () => {
  test("the row reader finds a row that exists and none that does not", () => {
    // Control for every assertion below: a reader that never matched would make each
    // containment check fail loudly, but one that matched everything would pass them all.
    expect(rowOf("M12")).toBeDefined();
    expect(rowOf("M99")).toBeUndefined();
  });

  test.each([
    ["M3", "MATRIX_SAMPLE_BUDGET", MATRIX_SAMPLE_BUDGET],
    ["M10", "METRIC_LIST_CAP", METRIC_LIST_CAP],
    ["M11", "QUERY_CONCURRENCY_LIMIT", QUERY_CONCURRENCY_LIMIT],
    ["M12", "RESPONSE_BYTE_CAP", RESPONSE_BYTE_CAP],
    ["M13", "DESCRIBE_SERIES_CAP", DESCRIBE_SERIES_CAP],
  ] as const)("%s names %s and states its value", (id, name, value) => {
    const row = rowOf(id);
    expect(row).toBeDefined();
    expect(row).toContain(`\`${name}\``);
    expect(row).toContain(`\`${value}\``);
  });

  test.each([
    ["TSDB_TOP_METRICS", TSDB_TOP_METRICS],
    ["TSDB_LABEL_SCAN_LIMIT", TSDB_LABEL_SCAN_LIMIT],
    ["INVENTORY_WINDOW_MS", INVENTORY_WINDOW_MS],
    ["SOURCE_PART_LIMIT", SOURCE_PART_LIMIT],
    ["RESULT_BYTE_BUDGET", RESULT_BYTE_BUDGET],
  ] as const)("the fixed constant %s is quoted with its value", (name, value) => {
    expect(DOC).toContain(`\`${name}\` (\`${value}\`)`);
  });
});

describe("the PromQL string rule quotes the escape the builder writes", () => {
  // Both characters are built from their codes rather than typed: a tool that decodes a typed
  // escape turns it into the character it names, which is how the doc came to show the one literal
  // the lexer refuses where it meant to show the escape.
  const replacement = String.fromCharCode(0xfffd);

  test("a U+FFFD in a name is written as the six-character escape, and the doc shows that escape", () => {
    const escape = labelNotation(replacement).slice(1, -1);
    expect(escape).toBe(`${String.fromCharCode(92)}ufffd`);
    expect(DOC).toContain(`the escape \`${escape}\``);
  });

  test("the doc holds no U+FFFD of its own", () => {
    // The test above is the control: it reads the same text and finds the escape there.
    expect(DOC).not.toContain(replacement);
  });
});

describe("the connection section quotes what the dialog renders", () => {
  test("the password label is the declared one", () => {
    const label = connectionFieldLabel(DB_UI_CONFIG.prometheus, "password", "Password");
    expect(label).toBe("Password or token");
    expect(DOC).toContain(`"${label}"`);
  });

  test("the user label is the declared one", () => {
    const label = connectionFieldLabel(DB_UI_CONFIG.prometheus, "user", "Username");
    expect(label).toBe("User");
    expect(rowOf("`user`")).toContain(`Labelled "${label}"`);
  });

  test("the password hint is the declared one", () => {
    const hint = connectionFieldHint(DB_UI_CONFIG.prometheus, "password");
    expect(hint).toBe("Leave User empty to send this as a bearer token.");
    expect(DOC).toContain(`"${hint}"`);
  });

  test("the default port in the header table is the declared one", () => {
    expect(DB_UI_CONFIG.prometheus.defaultPort).toBe("9090");
    expect(rowOf("**Default port**")).toContain(`\`${DB_UI_CONFIG.prometheus.defaultPort}\``);
  });
});

describe("the cancellation claim matches the method the routes detect", () => {
  let log: ReturnType<typeof spyOn> | undefined;

  afterEach(() => {
    log?.mockRestore();
    log = undefined;
  });

  test("the header row says Yes exactly when cancelQuery exists (M1)", async () => {
    // Both `/api/db/cancel` and `/api/db/query` decide by `"cancelQuery" in provider`, so a doc
    // that says Yes over a provider without the method promises a button that does nothing.
    log = spyOn(console, "log").mockImplementation(() => {});
    const provider = await createDatabaseProvider(CENSUS_CONNECTION.prometheus);
    const row = rowOf("**Query cancellation**");
    expect(row).toBeDefined();
    expect(row?.startsWith("| **Query cancellation** | Yes")).toBe("cancelQuery" in provider);
  });
});

/**
 * The object surface over a transport that answers only the reads each case names. Any other read
 * fails the case by name, so a sentence below is the one that exact answer produces.
 */
function objectsOver(answers: Partial<ObjectsTransport>): PrometheusObjects {
  const unexpected = (read: string) => () => Promise.reject(new Error(`the object surface also read ${read}`));
  const transport: ObjectsTransport = {
    query: unexpected("query"),
    metricNames: unexpected("metricNames"),
    labelNames: unexpected("labelNames"),
    seriesLabels: unexpected("seriesLabels"),
    metadata: unexpected("metadata"),
    rules: unexpected("rules"),
    scrapePools: unexpected("scrapePools"),
    targets: unexpected("targets"),
    ...answers,
  };
  return new PrometheusObjects({
    transport,
    now: () => Date.parse("2026-09-23T12:00:00.000Z"),
    // The declaration the provider hands its object surface in connect().
    capabilities: new PrometheusProvider(CENSUS_CONNECTION.prometheus).getCapabilities(),
    engine: { code: "prometheus", label: "A Prometheus", attachedSegment: "required" },
    queryOptions: () => ({ timeoutMs: 30_000, seriesLimit: 500 }),
  });
}

/** `count` metric names, each distinct, the way the label-values read answers them. */
const metricNames = (count: number): string[] => Array.from({ length: count }, (_, index) => `metric_${index}`);

describe("the object section quotes the sentences the object surface writes", () => {
  test("the floor a capped metric count carries", async () => {
    const counts = await objectsOver({
      // One name more than the cap, with no notice from the server: the cut the listing detects itself.
      metricNames: async () => ({ items: metricNames(METRIC_LIST_CAP + 1), truncatedByServer: false }),
      rules: async () => [],
      scrapePools: async () => [],
      targets: async () => [],
    }).countObjects([]);
    const metric = counts.metric;

    expect(isCountSampled(metric)).toBe(true);
    if (!isCountSampled(metric)) return;
    expect(metric.count).toBe(METRIC_LIST_CAP);
    expect(DOC).toContain(`counted from ${metric.sampledFrom}"`);
  });

  test("the series bound of a whole-folder describe", async () => {
    const batch = await objectsOver({
      seriesLabels: async () => ({
        items: Array.from({ length: DESCRIBE_SERIES_CAP + 1 }, () => ({ __name__: "up", job: "prometheus" })),
        truncatedByServer: false,
      }),
    }).describeObjects([], "metric");

    expect(batch.truncated).toBeDefined();
    expect(DOC).toContain(`"${batch.truncated?.reason}"`);
  });

  test("the refusal a metric with no metadata answers", async () => {
    const document = await objectsOver({
      metricNames: async () => ({ items: ["up"], truncatedByServer: false }),
      metadata: async () => [],
    }).readObjectSource(["up"], "metric");
    const [part] = document.parts;

    expect(document.parts).toHaveLength(1);
    expect("unavailable" in part).toBe(true);
    if (!("unavailable" in part)) return;
    expect(DOC).toContain(`"${part.unavailable}"`);
  });

  test("the type of a metric's value column", async () => {
    const detail = await objectsOver({ labelNames: async () => ["__name__", "job"] }).describeObject(["up"], "metric");
    const value = detail.columns.find((column) => column.name === "value");

    expect(value).toBeDefined();
    expect(DOC).toContain(`\`${value?.type}\``);
  });
});

describe("the monitoring table quotes what the Tables and Storage tabs are told", () => {
  test("the getTableStats row names the caption the provider declares", () => {
    const caption = new PrometheusProvider(CENSUS_CONNECTION.prometheus).getLabels().tableStatsCaption;
    expect(caption).toBeDefined();
    expect(rowOf("`getTableStats()`")).toContain(`"${caption}"`);
  });

  test("the getStorageStats row quotes the refusal of a TSDB status with no head statistics", () => {
    let refusal: unknown;
    try {
      storageStatsFrom(
        { seriesByMetric: [], valuesByLabel: [] },
        { startTime: "2026-09-23T10:00:00Z", serverTime: "2026-09-23T12:00:00Z", storageRetention: "15d" },
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    expect(rowOf("`getStorageStats()`")).toContain(`"${(refusal as Error).message}"`);
  });
});
