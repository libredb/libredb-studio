/**
 * `docs/providers/prometheus.md` quotes numbers and strings the code owns.
 *
 * Six of the numbers were set by a measurement (#1085 section 10, and the result byte budget of
 * section 5.4), so each is a named constant, the doc states it in the row of the measurement that
 * decided it, and `tests/fixtures/prometheus/README.md` records that measurement's decision. A value
 * copied into prose is true only until the constant moves, and nothing else goes red when it stops
 * being true (the same reasoning as `tests/unit/provider-docs-monitoring-citations.test.ts`).
 * So every quoted value is read back against its constant and its recorded decision, the dialog
 * strings against what `DB_UI_CONFIG` declares, the cancellation claim against the method the
 * routes detect by presence, the sentences a user reads in the tree and the source view against the
 * object surface that writes them, the escape of the PromQL string rule against the builder, the
 * Tables caption and the storage refusal against the provider and the monitoring reader, and what
 * the doc says the chart tab draws against the chart's own analysis and palette.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { analyzeData, analyzeField } from "@/components/DataCharts";
import { chartTheme } from "@/lib/charts/palette";
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
const FIXTURES = readFileSync(path.join(ROOT, "tests/fixtures/prometheus/README.md"), "utf8");
const CHARTS = readFileSync(path.join(ROOT, "src/components/DataCharts.tsx"), "utf8");

/** The table row whose first cell is exactly `cell`, or undefined. */
const rowOf = (cell: string): string | undefined => LINES.find((line) => line.startsWith(`| ${cell} |`));

/** The fixture README's entry for measurement `id`, from its heading to the next one, or undefined. */
function entryOf(id: string): string | undefined {
  const start = FIXTURES.indexOf(`\n### ${id}. `);
  if (start < 0) return undefined;
  const end = FIXTURES.indexOf("\n### ", start + 1);
  return FIXTURES.slice(start, end < 0 ? undefined : end);
}

/** Each measured constant: the measurement that decided it, its name, and its value. */
const MEASURED = [
  ["M3", "MATRIX_SAMPLE_BUDGET", MATRIX_SAMPLE_BUDGET],
  ["M10", "METRIC_LIST_CAP", METRIC_LIST_CAP],
  ["M11", "QUERY_CONCURRENCY_LIMIT", QUERY_CONCURRENCY_LIMIT],
  ["M12", "RESPONSE_BYTE_CAP", RESPONSE_BYTE_CAP],
  ["M13", "DESCRIBE_SERIES_CAP", DESCRIBE_SERIES_CAP],
  ["M14", "RESULT_BYTE_BUDGET", RESULT_BYTE_BUDGET],
] as const;

describe("the measurement table quotes the constants the code uses", () => {
  test("the row and entry readers find what exists and nothing that does not", () => {
    // Control for every assertion below: a reader that never matched would make each
    // containment check fail loudly, but one that matched everything would pass them all.
    expect(rowOf("M12")).toBeDefined();
    expect(rowOf("M99")).toBeUndefined();
    expect(entryOf("M12")).toContain("### M12. ");
    expect(entryOf("M12")).not.toContain("### M13. ");
    expect(entryOf("M99")).toBeUndefined();
  });

  test.each(MEASURED)("%s names %s and states its value", (id, name, value) => {
    const row = rowOf(id);
    expect(row).toBeDefined();
    expect(row).toContain(`\`${name}\``);
    expect(row).toContain(`\`${value}\``);
  });

  test.each(MEASURED)("%s is recorded with the decision that set %s to its value", (id, name, value) => {
    // A constant the doc calls measured without a recorded decision is the gap #1085's review found
    // in the result byte budget, and a decision for another value is a constant moved without one.
    expect(entryOf(id)).toContain(`Decision: \`${name}\` = \`${value}\``);
  });

  test.each([
    ["TSDB_TOP_METRICS", TSDB_TOP_METRICS],
    ["TSDB_LABEL_SCAN_LIMIT", TSDB_LABEL_SCAN_LIMIT],
    ["INVENTORY_WINDOW_MS", INVENTORY_WINDOW_MS],
    ["SOURCE_PART_LIMIT", SOURCE_PART_LIMIT],
  ] as const)("the fixed constant %s is quoted with its value", (name, value) => {
    expect(DOC).toContain(`\`${name}\` (\`${value}\`)`);
  });

  test("the share of the byte budget M3's subquery takes is the one M14 recorded", () => {
    const lines = entryOf("M14")?.split("\n") ?? [];
    const cells = (line: string): string[] =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
    const header = lines.find((line) => line.startsWith("| Answer |"));
    const row = lines.find((line) => line.startsWith("| `compose-subquery` |"));
    expect(header).toBeDefined();
    expect(row).toBeDefined();
    const column = cells(header ?? "").indexOf("Rows and fields as JSON");
    expect(column).toBeGreaterThan(0);
    const bytes = Number(cells(row ?? "")[column]);
    expect(Number.isInteger(bytes) && bytes > 0).toBe(true);
    expect(DOC).toContain(`M3's representative subquery takes ${bytes.toLocaleString("en-US")} bytes of it`);
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

describe("the chart sentences quote what the chart tab draws", () => {
  // `MAX_SERIES` and the axes the tab opens on live inside the DataCharts component, so the palette
  // the cap is defined as is read through `chartTheme`, and the component is read for the lines that
  // define the cap and choose the axes.
  const WORDS = [
    "no",
    "one",
    "two",
    "three",
    "four",
    "five",
    "six",
    "seven",
    "eight",
    "nine",
    "ten",
    "eleven",
    "twelve",
  ];

  test("a stepped subquery opens on its first series, and the lines drawn at once are the palette's size", () => {
    const size = chartTheme("light").series.length;
    expect(chartTheme("dark").series.length).toBe(size);
    expect(CHARTS).toContain("const CHART_COLORS = viz.series;");
    expect(CHARTS).toContain("const MAX_SERIES = CHART_COLORS.length;");
    expect(CHARTS).toContain("setYAxis([analysis.numericFields[0]]);");
    const line = LINES.find((candidate) => candidate.includes("Y-Axis menu"));
    expect(line).toContain("the tab opens on the first series");
    expect(line).toContain(
      `at most ${WORDS[size]}, the palette's size (\`MAX_SERIES\` in \`src/components/DataCharts.tsx\`)`,
    );
    expect(line).toContain(`"Showing first ${size} of N series"`);
  });
});

describe("the NaN and Inf sentences quote how the chart tab types a column", () => {
  // analyzeField keeps both of its thresholds inline, so each is read off its answers.
  const NON_FINITE = ["NaN", "+Inf", "-Inf"];

  /** `numbers` distinct finite values, then `strings` of the engine's non-finite texts. */
  const column = (numbers: number, strings: number): unknown[] => [
    ...Array.from({ length: numbers }, (_, index) => index + 0.5),
    ...Array.from({ length: strings }, (_, index) => NON_FINITE[index % NON_FINITE.length]),
  ];
  const typeOf = (values: unknown[]): string => analyzeField("c", values).type;
  /** A column half `NaN`, so never numbers, holding `values` distinct values: its numbers and the one string. */
  const halfNaN = (values: number): unknown[] => [
    ...column(values - 1, 0),
    ...Array.from({ length: values - 1 }, () => "NaN"),
  ];
  /** The most distinct values a half-`NaN` column holds and is still typed categorical. */
  const categoricalLimit = (): number | undefined =>
    Array.from({ length: 200 }, (_, index) => index + 2)
      .filter((values) => typeOf(halfNaN(values)) === "categorical")
      .at(-1);
  const minute = (index: number): string => new Date(Date.UTC(2026, 8, 23, 10, index)).toISOString();
  const TIMES = Array.from({ length: 60 }, (_, index) => minute(index));

  test("the share of strings at which a column stops being numbers", () => {
    // In whole percent of 100 filled cells: the first share typed as something other than numbers.
    const share = Array.from({ length: 101 }, (_, strings) => strings).find(
      (strings) => typeOf(column(100 - strings, strings)) !== "numeric",
    );
    expect(share).toBeDefined();
    if (share === undefined) return;
    // Control: one string fewer is still numbers, so the share found is the boundary.
    expect(typeOf(column(101 - share, share - 1))).toBe("numeric");
    expect(DOC).toContain(`A column whose strings are ${share}% or more of its filled cells is not typed as numbers`);
    expect(DOC).toContain(`a column ${share}% or more \`NaN\` or \`Inf\` is not drawn as a series`);
  });

  test("such a column is categorical up to the distinct values the doc names, and unknown past them", () => {
    const limit = categoricalLimit();
    expect(limit).toBeDefined();
    if (limit === undefined) return;
    expect(typeOf(halfNaN(limit + 1))).toBe("unknown");
    expect(DOC).toContain(`It is typed categorical only while it holds at most ${limit} distinct values`);
    expect(DOC).toContain(`past ${limit}, as in a mostly-\`NaN\` latency ratio`);
    expect(DOC).toContain(`becomes the default x axis only while it holds at most ${limit} distinct values`);
  });

  test("only a categorical column takes the default x axis from the timestamps", () => {
    const limit = categoricalLimit() ?? 0;
    // One row per cell of the half-`NaN` column, a minute apart, beside a column of numbers.
    const analysisOf = (values: number) => {
      const rows = halfNaN(values).map((ratio, index) => ({ timestamp: minute(index), ratio, count: index + 1 }));
      return analyzeData({ rows, fields: ["timestamp", "ratio", "count"], rowCount: rows.length, executionTime: 1 });
    };
    // The tab opens on the first categorical column, else the first date column.
    expect(CHARTS).toContain("analysis.categoricalFields[0] || analysis.dateFields[0]");
    expect(analysisOf(limit).categoricalFields).toEqual(["ratio"]);
    expect(analysisOf(limit + 1).categoricalFields).toEqual([]);
    expect(analysisOf(limit + 1).dateFields).toEqual(["timestamp"]);
    expect(DOC).toContain(
      "only then does the first categorical column in field order replace `timestamp` as the chart's default x axis",
    );
    expect(DOC).toContain("it is typed unknown and `timestamp` stays the default");
  });

  test("an answer with no numeric column draws no chart", () => {
    const rows = TIMES.map((timestamp) => ({ timestamp, value: "NaN" }));
    const analysis = analyzeData({ rows, fields: ["timestamp", "value"], rowCount: rows.length, executionTime: 1 });
    expect(analysis.isVisualizable).toBe(false);
    expect(analysis.reason).toBe("No numeric fields found for Y-axis");
    // Control: the same rows with a number in every cell are drawable.
    const numbers = TIMES.map((timestamp, index) => ({ timestamp, value: index }));
    const drawable = analyzeData({
      rows: numbers,
      fields: ["timestamp", "value"],
      rowCount: numbers.length,
      executionTime: 1,
    });
    expect(drawable.isVisualizable).toBe(true);
    expect(DOC).toContain("An answer with no numeric column draws no chart.");
  });
});
