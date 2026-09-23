/**
 * Prometheus query results as grid rows (#1085, sections 5.3 and 5.4)
 *
 * Every answer below is seam data, PrometheusQueryData built by hand, never wire JSON: the envelope
 * is http-transport.ts's to decode, and a shaping rule that needed a wire document to be tested
 * would be one that knew the wire. The edge cases are written inline, each beside the engine
 * behaviour it stands for.
 *
 * What is pinned is what a reader of the grid relies on without seeing it: which field a label
 * lands in, and that no two labels share one; which cells are numbers and which stay the engine's
 * text; how a matrix becomes one row per instant; and that whatever a bound cut is named in a
 * warning and reported as limited.
 */
import { describe, expect, test } from "bun:test";
import {
  formatSampleTime,
  labelFieldNames,
  MATRIX_SAMPLE_BUDGET,
  sampleCell,
  type ShapeLimits,
  shapeQueryResult,
  vectorFieldNames,
} from "@/lib/db/providers/timeseries/prometheus/results";
import {
  type PrometheusAnswer,
  type PrometheusNativeHistogram,
  type PrometheusNotice,
  type PrometheusQueryData,
  type PrometheusSeries,
  PrometheusTransportError,
} from "@/lib/db/providers/timeseries/prometheus/transport";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";

// ============================================================================
// Cells
// ============================================================================

describe("formatSampleTime", () => {
  test("writes float seconds as ISO-8601 UTC with milliseconds", () => {
    expect(formatSampleTime(1790157600)).toBe("2026-09-23T10:00:00.000Z");
    expect(formatSampleTime(1790157600.123)).toBe("2026-09-23T10:00:00.123Z");
  });

  // The engine stores integer milliseconds and writes them as float seconds, which do not always
  // multiply back exactly.
  test("rounds to the millisecond the engine stored, where truncating would lose it", () => {
    expect(formatSampleTime(1073749647.001)).toBe("2004-01-10T15:47:27.001Z");
    // The control: 1073749647.001 * 1000 is 1073749647000.9999, and Date truncates it.
    expect(new Date(1073749647.001 * 1000).toISOString()).toBe("2004-01-10T15:47:27.000Z");
  });
});

describe("sampleCell", () => {
  test("makes a finite value a number", () => {
    expect(sampleCell("1")).toBe(1);
    expect(sampleCell("0.1")).toBe(0.1);
    expect(sampleCell("-3.25")).toBe(-3.25);
    expect(sampleCell("1.7976931348623157e+308")).toBe(Number.MAX_VALUE);
  });

  // JSON would carry a NaN number as null, and in the wide matrix null means "no sample here".
  test("keeps NaN, +Inf and -Inf as the engine's text", () => {
    expect(sampleCell("NaN")).toBe("NaN");
    expect(sampleCell("+Inf")).toBe("+Inf");
    expect(sampleCell("-Inf")).toBe("-Inf");
  });
});

// ============================================================================
// Fields
// ============================================================================

describe("labelFieldNames and vectorFieldNames", () => {
  test("put __name__ first and sort the rest by code unit", () => {
    // Zone sorts before __name__ by code unit, so __name__ leads here by the rule and not by accident.
    expect(labelFieldNames(["job", "Zone", "instance", "__name__"])).toEqual(["__name__", "Zone", "instance", "job"]);
    // Code-unit order, not a locale's: upper case before "_", "_" before lower case.
    expect(labelFieldNames(["b", "a", "_x", "Z", "B"])).toEqual(["B", "Z", "_x", "a", "b"]);
  });

  test("list a label once however often it is named", () => {
    expect(labelFieldNames(["job", "job", "__name__", "__name__"])).toEqual(["__name__", "job"]);
  });

  test("end with timestamp and value", () => {
    expect(vectorFieldNames(["job", "__name__"])).toEqual(["__name__", "job", "timestamp", "value"]);
    expect(vectorFieldNames([])).toEqual(["timestamp", "value"]);
  });

  // Labels literally named value and timestamp, and a UTF-8 name, on one metric: the fields stay unique.
  test("quote a label named timestamp or value, and any name that is not legacy", () => {
    const fields = vectorFieldNames(["value", "timestamp", "service.name", "job", "__name__"]);

    expect(fields).toEqual(["__name__", "job", '"service.name"', '"timestamp"', '"value"', "timestamp", "value"]);
    expect(new Set(fields).size).toBe(fields.length);
  });

  test("never give two labels one field, nor a label the field timestamp or value", () => {
    const names = [
      "value",
      '"value"',
      "timestamp",
      "service.name",
      "service_name",
      'a"b',
      "a\\b",
      "U__x",
      "job",
      "__proto__",
    ];
    const fields = labelFieldNames(names);

    expect(new Set(fields).size).toBe(names.length);
    expect(fields).not.toContain("timestamp");
    expect(fields).not.toContain("value");
    // The control: each quoted field reads back to its own name and the rest are the names, so the
    // two labels above named timestamp and value did reach a field.
    const readBack = fields.map((field) => (field.startsWith('"') ? (JSON.parse(field) as string) : field));
    expect(readBack.sort()).toEqual([...names].sort());
  });
});

// ============================================================================
// Seam values for the shapes below
// ============================================================================

/** 2026-09-23T10:00:00.000Z, in the engine's float seconds. */
const T0 = 1790157600;

/** The limits the provider passes (5.4). No answer before the bounds' own tests reaches either. */
const LIMITS: ShapeLimits = { seriesLimit: DEFAULT_QUERY_LIMIT, sampleBudget: MATRIX_SAMPLE_BUDGET };

/** A native histogram as the transport decodes one. */
const HISTOGRAM: PrometheusNativeHistogram = { count: "3", sum: "0.75", buckets: [[0, "0.125", "0.25", "3"]] };

/** A series of float samples, each given as [time, the engine's text]. */
function floats(labels: Readonly<Record<string, string>>, ...points: (readonly [number, string])[]): PrometheusSeries {
  return { labels, samples: points.map(([at, value]) => ({ at, value })), histograms: [] };
}

/** An answer as the transport hands one over: `truncatedByServer` is its reading of the engine's notice. */
function answerOf(
  value: PrometheusQueryData,
  notices: readonly PrometheusNotice[] = [],
  truncatedByServer = false,
): PrometheusAnswer<PrometheusQueryData> {
  return { value, notices, truncatedByServer };
}

/** The error a call throws, or a test failure when it throws none. */
function thrownBy(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

// ============================================================================
// Vector
// ============================================================================

describe("shapeQueryResult on a vector", () => {
  test("gives one row per series: __name__ first when any series has it, the labels, timestamp, value", () => {
    const shaped = shapeQueryResult(
      answerOf({
        shape: "vector",
        series: [
          floats({ __name__: "up", job: "api", instance: "api-1:8080" }, [T0, "1"]),
          floats({ job: "batch" }, [T0, "0"]),
        ],
      }),
      LIMITS,
    );

    expect(shaped.fields).toEqual(["__name__", "instance", "job", "timestamp", "value"]);
    expect(shaped.rows).toEqual([
      { __name__: "up", instance: "api-1:8080", job: "api", timestamp: "2026-09-23T10:00:00.000Z", value: 1 },
      { __name__: null, instance: null, job: "batch", timestamp: "2026-09-23T10:00:00.000Z", value: 0 },
    ]);
    // Every row carries every field in field order: a label a series lacks is null, not missing.
    expect(shaped.rows.map((row) => Object.keys(row))).toEqual([shaped.fields, shaped.fields]);
    expect(shaped.warnings).toEqual([]);
    expect(shaped.wasLimited).toBe(false);
  });

  test("keeps NaN, +Inf and -Inf as text and makes every finite value a number", () => {
    const shaped = shapeQueryResult(
      answerOf({
        shape: "vector",
        series: [
          floats({ case: "nan" }, [T0, "NaN"]),
          floats({ case: "positive" }, [T0, "+Inf"]),
          floats({ case: "negative" }, [T0, "-Inf"]),
          floats({ case: "finite" }, [T0, "0.25"]),
        ],
      }),
      LIMITS,
    );

    expect(shaped.rows.map((row) => row.value)).toEqual(["NaN", "+Inf", "-Inf", 0.25]);
  });

  test("keeps a native histogram as the object the engine sent", () => {
    const series: PrometheusSeries = {
      labels: { __name__: "rpc_duration_seconds" },
      samples: [],
      histograms: [{ at: T0, histogram: HISTOGRAM }],
    };
    const [row] = shapeQueryResult(answerOf({ shape: "vector", series: [series] }), LIMITS).rows;

    expect(row.value).toBe(HISTOGRAM);
    expect(row.timestamp).toBe("2026-09-23T10:00:00.000Z");
  });

  // The grid's fields are the metric's columns in the tree, because both come from vectorFieldNames
  // over the same label names.
  test("gives labels named timestamp, value and service.name fields of their own", () => {
    const labels = { __name__: "http_server_duration", "service.name": "checkout", timestamp: "t", value: "v" };
    const shaped = shapeQueryResult(answerOf({ shape: "vector", series: [floats(labels, [T0, "12"])] }), LIMITS);

    expect(shaped.fields).toEqual(vectorFieldNames(Object.keys(labels)));
    expect(shaped.rows).toEqual([
      {
        __name__: "http_server_duration",
        '"service.name"': "checkout",
        '"timestamp"': "t",
        '"value"': "v",
        timestamp: "2026-09-23T10:00:00.000Z",
        value: 12,
      },
    ]);
  });

  // Both are legal label names. Assigned into an object, `__proto__` would set the prototype, or
  // vanish for a string, and a series lacking `constructor` would read back Object.
  test("keeps labels named __proto__ and constructor as fields like any other", () => {
    // JSON.parse writes `__proto__` as an own key, as the transport's decoder does; `{ __proto__: ... }` would not.
    const odd = JSON.parse('{"__proto__":"p","constructor":"c"}') as Record<string, string>;
    const [first, second] = shapeQueryResult(
      answerOf({ shape: "vector", series: [floats(odd, [T0, "1"]), floats({ job: "other" }, [T0, "2"])] }),
      LIMITS,
    ).rows;

    expect(Object.hasOwn(first, "__proto__")).toBe(true);
    expect(first["__proto__"]).toBe("p");
    expect(Object.getPrototypeOf(first)).toBe(Object.prototype);
    expect(second.constructor).toBeNull();
    expect(second["__proto__"]).toBeNull();
    // The control: the ordinary label of the same row.
    expect(second.job).toBe("other");
  });

  test("refuses a vector series that does not hold exactly one point", () => {
    const none = thrownBy(() =>
      shapeQueryResult(answerOf({ shape: "vector", series: [{ labels: {}, samples: [], histograms: [] }] }), LIMITS),
    );
    const two = thrownBy(() =>
      shapeQueryResult(answerOf({ shape: "vector", series: [floats({}, [T0, "1"], [T0 + 15, "2"])] }), LIMITS),
    );

    expect(none).toBeInstanceOf(PrometheusTransportError);
    expect((none as PrometheusTransportError).category).toBe("protocol");
    expect((none as Error).message).toBe(
      "The server answered a vector series holding 0 points; a vector holds exactly one per series.",
    );
    expect((two as Error).message).toContain("holding 2 points");
    // The control: one point is one row.
    const one = shapeQueryResult(answerOf({ shape: "vector", series: [floats({}, [T0, "1"])] }), LIMITS);
    expect(one.rows).toHaveLength(1);
  });
});

// ============================================================================
// Matrix
// ============================================================================

describe("shapeQueryResult on a matrix", () => {
  test("names each column by the labels that tell the series apart", () => {
    const shaped = shapeQueryResult(
      answerOf({
        shape: "matrix",
        series: [
          floats({ __name__: "up", job: "node", instance: "node-a:9100" }, [T0, "1"]),
          floats({ __name__: "up", job: "node", instance: "node-b:9100" }, [T0, "0"]),
        ],
      }),
      LIMITS,
    );

    expect(shaped.fields).toEqual(["timestamp", '{instance="node-a:9100"}', '{instance="node-b:9100"}']);
    expect(shaped.rows).toEqual([
      { timestamp: "2026-09-23T10:00:00.000Z", '{instance="node-a:9100"}': 1, '{instance="node-b:9100"}': 0 },
    ]);
    expect(shaped.wasLimited).toBe(false);
  });

  test('counts a label only some series carry as telling them apart, written name="" where absent', () => {
    const shaped = shapeQueryResult(
      answerOf({
        shape: "matrix",
        series: [floats({ job: "api", env: "prod" }, [T0, "1"]), floats({ job: "api" }, [T0, "2"])],
      }),
      LIMITS,
    );

    expect(shaped.fields).toEqual(["timestamp", '{env="prod"}', '{env=""}']);
  });

  test("puts __name__ first among them and quotes names and values as PromQL does", () => {
    const shaped = shapeQueryResult(
      answerOf({
        shape: "matrix",
        series: [
          floats({ __name__: "a_total", Region: "eu", "service.name": 'check"out' }, [T0, "1"]),
          floats({ __name__: "b_total", Region: "us", "service.name": "web" }, [T0, "2"]),
        ],
      }),
      LIMITS,
    );

    // Region sorts before __name__ by code unit, so __name__ leads by the rule.
    expect(shaped.fields).toEqual([
      "timestamp",
      '{__name__="a_total",Region="eu","service.name"="check\\"out"}',
      '{__name__="b_total",Region="us","service.name"="web"}',
    ]);
  });

  test("names the one column of a single series value", () => {
    const shaped = shapeQueryResult(
      answerOf({ shape: "matrix", series: [floats({ __name__: "up", job: "prometheus" }, [T0, "1"], [T0 + 15, "1"])] }),
      LIMITS,
    );

    expect(shaped.fields).toEqual(["timestamp", "value"]);
    expect(shaped.rows).toEqual([
      { timestamp: "2026-09-23T10:00:00.000Z", value: 1 },
      { timestamp: "2026-09-23T10:00:15.000Z", value: 1 },
    ]);
  });

  // A raw range selector samples each series at its own scrape times, so its rows are sparse.
  test("makes the rows the sorted union of the instants, null where a series has no sample", () => {
    const shaped = shapeQueryResult(
      answerOf({
        shape: "matrix",
        series: [
          floats({ instance: "a" }, [T0, "1"], [T0 + 15, "3"]),
          floats({ instance: "b" }, [T0 + 5, "2"], [T0 + 15, "NaN"]),
        ],
      }),
      LIMITS,
    );

    expect(shaped.rows).toEqual([
      { timestamp: "2026-09-23T10:00:00.000Z", '{instance="a"}': 1, '{instance="b"}': null },
      { timestamp: "2026-09-23T10:00:05.000Z", '{instance="a"}': null, '{instance="b"}': 2 },
      { timestamp: "2026-09-23T10:00:15.000Z", '{instance="a"}': 3, '{instance="b"}': "NaN" },
    ]);
  });

  test("places native histogram points as cells, beside float samples", () => {
    const shaped = shapeQueryResult(
      answerOf({
        shape: "matrix",
        series: [
          {
            labels: { mode: "native" },
            samples: [{ at: T0, value: "5" }],
            histograms: [{ at: T0 + 15, histogram: HISTOGRAM }],
          },
          floats({ mode: "classic" }, [T0 + 15, "7"]),
        ],
      }),
      LIMITS,
    );

    expect(shaped.rows).toEqual([
      { timestamp: "2026-09-23T10:00:00.000Z", '{mode="native"}': 5, '{mode="classic"}': null },
      { timestamp: "2026-09-23T10:00:15.000Z", '{mode="native"}': HISTOGRAM, '{mode="classic"}': 7 },
    ]);
    expect(shaped.rows[1]['{mode="native"}']).toBe(HISTOGRAM);
  });

  test("shapes an empty matrix as a timestamp field and no rows", () => {
    expect(shapeQueryResult(answerOf({ shape: "matrix", series: [] }), LIMITS)).toEqual({
      rows: [],
      fields: ["timestamp"],
      warnings: [],
      wasLimited: false,
    });
    // The control: an empty vector keeps its two fields.
    expect(shapeQueryResult(answerOf({ shape: "vector", series: [] }), LIMITS).fields).toEqual(["timestamp", "value"]);
  });

  test("refuses two series with one label set, whose columns could not be told apart", () => {
    const refusal = thrownBy(() =>
      shapeQueryResult(
        answerOf({ shape: "matrix", series: [floats({ job: "a" }, [T0, "1"]), floats({ job: "a" }, [T0 + 15, "2"])] }),
        LIMITS,
      ),
    );

    expect(refusal).toBeInstanceOf(PrometheusTransportError);
    expect((refusal as PrometheusTransportError).category).toBe("protocol");
    expect((refusal as Error).message).toBe(
      "The server answered a matrix holding two series with the same labels, so their columns could not be told apart.",
    );
    // The control: one label apart, they are two columns.
    const apart = shapeQueryResult(
      answerOf({ shape: "matrix", series: [floats({ job: "a" }, [T0, "1"]), floats({ job: "b" }, [T0 + 15, "2"])] }),
      LIMITS,
    );
    expect(apart.fields).toEqual(["timestamp", '{job="a"}', '{job="b"}']);
  });
});

// ============================================================================
// Scalar, string and the engine's notices
// ============================================================================

describe("shapeQueryResult on a scalar or a string", () => {
  test("gives a scalar one row, its value a number or the engine's non-finite text", () => {
    const shaped = shapeQueryResult(answerOf({ shape: "scalar", sample: { at: T0, value: "42" } }), LIMITS);

    expect(shaped.fields).toEqual(["timestamp", "value"]);
    expect(shaped.rows).toEqual([{ timestamp: "2026-09-23T10:00:00.000Z", value: 42 }]);
    expect(shapeQueryResult(answerOf({ shape: "scalar", sample: { at: T0, value: "NaN" } }), LIMITS).rows).toEqual([
      { timestamp: "2026-09-23T10:00:00.000Z", value: "NaN" },
    ]);
  });

  test("keeps a string result its text, even one that reads as a number", () => {
    const shaped = shapeQueryResult(answerOf({ shape: "string", sample: { at: T0, value: "42" } }), LIMITS);

    expect(shaped.fields).toEqual(["timestamp", "value"]);
    expect(shaped.rows).toEqual([{ timestamp: "2026-09-23T10:00:00.000Z", value: "42" }]);
  });
});

describe("shapeQueryResult's notices", () => {
  test("carries the engine's warnings and infos verbatim and in its order", () => {
    const shaped = shapeQueryResult(
      answerOf({ shape: "scalar", sample: { at: T0, value: "1" } }, [
        { level: "warning", message: 'PromQL warning: encountered a mix of histograms and floats for metric name "x"' },
        {
          level: "info",
          message: 'PromQL info: metric might not be a counter, name does not end in _total/_sum/_count/_bucket: "up"',
        },
      ]),
      LIMITS,
    );

    expect(shaped.warnings).toEqual([
      { message: 'PromQL warning: encountered a mix of histograms and floats for metric name "x"' },
      { message: 'PromQL info: metric might not be a counter, name does not end in _total/_sum/_count/_bucket: "up"' },
    ]);
    expect(shaped.wasLimited).toBe(false);
  });
});

// ============================================================================
// The bounds
// ============================================================================

/** The advice the series cap's notice ends with. */
const NARROW = "Narrow the selector or aggregate the result to see the rest.";

/** The warning v3.13.3 adds when the `limit` a query was sent cut its series (web/api/v1/api.go, M8). */
const ENGINE_CUT: PrometheusNotice = { level: "warning", message: "results truncated due to limit" };

describe("shapeQueryResult's series cap", () => {
  const TWO_SERIES: ShapeLimits = { seriesLimit: 2, sampleBudget: MATRIX_SAMPLE_BUDGET };
  const three = [floats({ job: "c" }, [T0, "3"]), floats({ job: "a" }, [T0, "1"]), floats({ job: "b" }, [T0, "2"])];

  // The transport asks for seriesLimit + 1 series, so seriesLimit + 1 without the engine's
  // notice is either the whole answer or a cut whose notice the engine dropped: it keeps ten
  // warnings (AsStrings, util/annotations/annotations.go). Only a floor is true of both.
  test("keeps the first series in engine order and names what it cut", () => {
    const shaped = shapeQueryResult(answerOf({ shape: "vector", series: three }), TWO_SERIES);

    expect(shaped.rows.map((row) => row.job)).toEqual(["c", "a"]);
    expect(shaped.warnings).toEqual([{ message: `Showing the first 2 of more than 2 series. ${NARROW}` }]);
    expect(shaped.wasLimited).toBe(true);
  });

  test("gives a vector no field for a label only a cut series carries", () => {
    const series = [
      floats({ job: "a" }, [T0, "1"]),
      floats({ job: "b" }, [T0, "2"]),
      floats({ job: "c", zone: "2" }, [T0, "3"]),
    ];

    expect(shapeQueryResult(answerOf({ shape: "vector", series }), TWO_SERIES).fields).toEqual([
      "job",
      "timestamp",
      "value",
    ]);
    // The control: kept, the same series gives zone its field.
    expect(shapeQueryResult(answerOf({ shape: "vector", series }), LIMITS).fields).toEqual([
      "job",
      "zone",
      "timestamp",
      "value",
    ]);
  });

  test("caps a matrix the same way, telling the kept series apart among themselves", () => {
    const series = [
      floats({ job: "a", zone: "1" }, [T0, "1"]),
      floats({ job: "b", zone: "1" }, [T0, "2"]),
      floats({ job: "c", zone: "2" }, [T0, "3"]),
    ];
    const shaped = shapeQueryResult(answerOf({ shape: "matrix", series }), TWO_SERIES);

    // zone differs only on the dropped series, so it names no kept column.
    expect(shaped.fields).toEqual(["timestamp", '{job="a"}', '{job="b"}']);
    expect(shaped.warnings).toEqual([{ message: `Showing the first 2 of more than 2 series. ${NARROW}` }]);
    expect(shaped.wasLimited).toBe(true);
  });

  // More than seriesLimit + 1 with no flag is a server that ignored `limit` and sent everything,
  // the one answer whose total is known.
  test("names the exact total when the server sent more than it was asked for", () => {
    const four = [...three, floats({ job: "d" }, [T0, "4"])];
    const shaped = shapeQueryResult(answerOf({ shape: "vector", series: four }), TWO_SERIES);

    expect(shaped.rows.map((row) => row.job)).toEqual(["c", "a"]);
    expect(shaped.warnings).toEqual([{ message: `Showing the first 2 of 4 series. ${NARROW}` }]);
    expect(shaped.wasLimited).toBe(true);
  });

  // The transport asks for seriesLimit + 1 series and reports the engine's own notice as
  // truncatedByServer: the server held more than it sent, by a number it did not send.
  test("says more than N when the server's own limit cut the series", () => {
    const shaped = shapeQueryResult(answerOf({ shape: "vector", series: three }, [ENGINE_CUT], true), TWO_SERIES);

    expect(shaped.rows).toHaveLength(2);
    expect(shaped.warnings).toEqual([
      { message: "results truncated due to limit" },
      { message: `Showing the first 2 of more than 3 series. ${NARROW}` },
    ]);
    expect(shaped.wasLimited).toBe(true);
  });

  // The control for the test above: the engine's sentence alone is not a cut, because results.ts
  // reads the seam's flag, which only http-transport.ts sets from that sentence.
  test("does not read the engine's sentence itself", () => {
    const shaped = shapeQueryResult(answerOf({ shape: "vector", series: three.slice(0, 2) }, [ENGINE_CUT]), TWO_SERIES);

    expect(shaped.rows).toHaveLength(2);
    expect(shaped.warnings).toEqual([{ message: "results truncated due to limit" }]);
    expect(shaped.wasLimited).toBe(false);
  });

  test("cuts nothing and says nothing at exactly the limit", () => {
    const shaped = shapeQueryResult(answerOf({ shape: "vector", series: three.slice(0, 2) }), TWO_SERIES);

    expect(shaped.rows).toHaveLength(2);
    expect(shaped.warnings).toEqual([]);
    expect(shaped.wasLimited).toBe(false);
  });

  test("writes its counts with thousands separators, as the rest of the product does", () => {
    const series = Array.from({ length: 1200 }, (_, index) => floats({ index: String(index) }, [T0, "1"]));
    const shaped = shapeQueryResult(answerOf({ shape: "vector", series }), {
      seriesLimit: 1000,
      sampleBudget: MATRIX_SAMPLE_BUDGET,
    });

    expect(shaped.rows).toHaveLength(1000);
    expect(shaped.warnings).toEqual([{ message: `Showing the first 1,000 of 1,200 series. ${NARROW}` }]);
  });
});

/** The advice the matrix budget's notice ends with. */
const COARSEN = "Use a larger step or a shorter range to see the rest.";

/**
 * A series of `count` float samples 15 seconds apart from T0, so the instants of every such series
 * fall on one shared 15-second lattice, as a stepped subquery's do.
 */
function sized(job: string, count: number): PrometheusSeries {
  return floats({ job }, ...Array.from({ length: count }, (_, index): [number, string] => [T0 + index * 15, "1"]));
}

/** The provider's series cap, with the cell budget under test. */
function budgetOf(sampleBudget: number): ShapeLimits {
  return { seriesLimit: DEFAULT_QUERY_LIMIT, sampleBudget };
}

describe("shapeQueryResult's matrix budget, in grid cells", () => {
  test("keeps whole series in order while their cells fit, and names what it cut", () => {
    const shaped = shapeQueryResult(
      answerOf({ shape: "matrix", series: [sized("a", 2), sized("b", 2), sized("c", 2)] }),
      budgetOf(5),
    );

    expect(shaped.fields).toEqual(["timestamp", '{job="a"}', '{job="b"}']);
    expect(shaped.warnings).toEqual([
      { message: `Showing 2 of 3 series and 4 of 6 cells, because a matrix result is held to 5 cells. ${COARSEN}` },
    ]);
    expect(shaped.wasLimited).toBe(true);
  });

  test("stops at the first series that does not fit, even when a later one would", () => {
    const shaped = shapeQueryResult(
      answerOf({ shape: "matrix", series: [sized("a", 2), sized("b", 4), sized("c", 1)] }),
      budgetOf(5),
    );

    expect(shaped.fields).toEqual(["timestamp", "value"]);
    expect(shaped.warnings).toEqual([
      { message: `Showing 1 of 3 series and 2 of 12 cells, because a matrix result is held to 5 cells. ${COARSEN}` },
    ]);
  });

  test("counts a native histogram point as a cell", () => {
    // At instants the float series has no sample at, so the histogram points are what grows the
    // grid: at the float series' own two instants it would be two instants by two columns, four
    // cells, inside the budget.
    const histograms: PrometheusSeries = {
      labels: { job: "h" },
      samples: [],
      histograms: [
        { at: T0 + 30, histogram: HISTOGRAM },
        { at: T0 + 45, histogram: HISTOGRAM },
      ],
    };
    const shaped = shapeQueryResult(answerOf({ shape: "matrix", series: [sized("a", 2), histograms] }), budgetOf(5));

    expect(shaped.fields).toEqual(["timestamp", "value"]);
    expect(shaped.warnings).toEqual([
      { message: `Showing 1 of 2 series and 2 of 8 cells, because a matrix result is held to 5 cells. ${COARSEN}` },
    ]);
  });

  // A raw range selector samples each series at its own scrape times, so the wide grid gives nearly
  // every sample a row of its own, and a count of samples would undercount what it builds.
  test("counts the cells of series sampled at their own instants", () => {
    const shaped = shapeQueryResult(
      answerOf({
        shape: "matrix",
        series: [
          floats({ instance: "a" }, [T0, "1"], [T0 + 15, "1"]),
          floats({ instance: "b" }, [T0 + 5, "1"], [T0 + 20, "1"]),
        ],
      }),
      budgetOf(5),
    );

    // Four samples would fit the budget, but the grid of both series is four instants by two columns.
    expect(shaped.fields).toEqual(["timestamp", "value"]);
    expect(shaped.warnings).toEqual([
      { message: `Showing 1 of 2 series and 2 of 8 cells, because a matrix result is held to 5 cells. ${COARSEN}` },
    ]);
    expect(shaped.wasLimited).toBe(true);
  });

  test("cuts nothing at exactly the budget", () => {
    const shaped = shapeQueryResult(answerOf({ shape: "matrix", series: [sized("a", 2), sized("b", 2)] }), budgetOf(4));

    expect(shaped.fields).toEqual(["timestamp", '{job="a"}', '{job="b"}']);
    expect(shaped.warnings).toEqual([]);
    expect(shaped.wasLimited).toBe(false);
  });

  test("leaves no column when the first series alone passes the budget, and says so", () => {
    expect(shapeQueryResult(answerOf({ shape: "matrix", series: [sized("a", 6)] }), budgetOf(5))).toEqual({
      rows: [],
      fields: ["timestamp"],
      warnings: [
        {
          message: `Showing 0 of 1 series and 0 of 6 cells, because a matrix result is held to 5 cells. ${COARSEN}`,
        },
      ],
      wasLimited: true,
    });
  });

  test("applies after the series cap, each bound naming its own cut", () => {
    const shaped = shapeQueryResult(
      answerOf({ shape: "matrix", series: [sized("a", 2), sized("b", 2), sized("c", 2)] }),
      { seriesLimit: 2, sampleBudget: 3 },
    );

    expect(shaped.warnings).toEqual([
      { message: `Showing the first 2 of more than 2 series. ${NARROW}` },
      { message: `Showing 1 of 2 series and 2 of 4 cells, because a matrix result is held to 3 cells. ${COARSEN}` },
    ]);
  });

  // A vector holds one sample per series, so the series cap is its bound.
  test("does not apply to a vector", () => {
    const shaped = shapeQueryResult(
      answerOf({ shape: "vector", series: [sized("a", 1), sized("b", 1), sized("c", 1)] }),
      budgetOf(1),
    );

    expect(shaped.rows).toHaveLength(3);
    expect(shaped.warnings).toEqual([]);
    expect(shaped.wasLimited).toBe(false);
  });
});
