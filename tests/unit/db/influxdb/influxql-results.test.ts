/**
 * A `/query` body as a result (InfluxDB spec 3.4, 5.1 steps 10 and 11, 5.3 C5; E5): the document split of every
 * line's framing (K5), exact large integers, the answer-shape check, the server's errors, series flattened into one
 * grid, and the row cut and cell budget, over the captures of 1.13.1, 2.9.1 and 3.12.0 Core and over constructed
 * bodies where no capture holds the case.
 */
import { describe, expect, test } from "bun:test";
import { INFLUX_CELL_BUDGET, INFLUX_ROW_CUT } from "@/lib/db/providers/timeseries/influxdb/connection-options";
import { INFLUX_ERROR_SENTENCES, InfluxAnswerShapeError } from "@/lib/db/providers/timeseries/influxdb/errors";
import {
  type InfluxShapeLimits,
  shapeInfluxqlBody,
  splitJsonDocuments,
} from "@/lib/db/providers/timeseries/influxdb/influxql-results";
import {
  INFLUX_FIXTURE_VERSIONS,
  type InfluxFixtureVersion,
  loadDifferentialCorpus,
  loadInfluxCapture,
} from "../../../helpers/influxdb-fixtures";

const LIMITS: InfluxShapeLimits = { rowCut: INFLUX_ROW_CUT, cellBudget: INFLUX_CELL_BUDGET };

function shapeCapture(version: InfluxFixtureVersion, name: string, limits: InfluxShapeLimits = LIMITS) {
  return shapeInfluxqlBody(loadInfluxCapture(version, name).body, limits);
}

/** The fault (and server text) a body is refused with. */
function refusal(text: string): { fault: string; serverText: string | undefined } {
  try {
    shapeInfluxqlBody(text, LIMITS);
  } catch (error) {
    expect(error).toBeInstanceOf(InfluxAnswerShapeError);
    const shape = error as InfluxAnswerShapeError;
    return { fault: shape.fault, serverText: shape.serverText };
  }
  throw new Error("the body was shaped, not refused");
}

function splitFault(text: string): string {
  try {
    splitJsonDocuments(text);
  } catch (error) {
    expect(error).toBeInstanceOf(InfluxAnswerShapeError);
    return (error as InfluxAnswerShapeError).fault;
  }
  throw new Error("the body was split, not refused");
}

/** One document of one statement 0 result. */
const doc = (result: Record<string, unknown>): string => JSON.stringify({ results: [{ statement_id: 0, ...result }] });

describe("splitJsonDocuments", () => {
  test("newline-separated documents, as 1.x and 2.x frame them", () => {
    expect(splitJsonDocuments('{"a":1}\n{"b":[2,{"c":3}]}\n')).toEqual(['{"a":1}', '{"b":[2,{"c":3}]}']);
  });

  test("back-to-back documents, as 3.x frames them", () => {
    expect(splitJsonDocuments('{"a":1}{"b":2}')).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("a brace, a quote or a backslash inside a string does not end a document", () => {
    const first = String.raw`{"s":"}{\"x\\","t":"]"}`;
    expect(splitJsonDocuments(`${first}{"u":1}`)).toEqual([first, '{"u":1}']);
  });

  test("an empty or whitespace-only body holds no document", () => {
    expect(splitJsonDocuments("")).toEqual([]);
    expect(splitJsonDocuments(" \r\n\t")).toEqual([]);
  });

  test("text that is not a sequence of JSON objects is refused as not JSON", () => {
    expect(splitFault("404 page not found")).toBe("not-json");
    expect(splitFault('{"a":1}\nnope')).toBe("not-json");
    expect(splitFault('}{"a":1}')).toBe("not-json");
    expect(splitFault('{"a":')).toBe("not-json");
    expect(splitFault('{"a":"never closes')).toBe("not-json");
  });

  test("the 3.x captures split into as many documents as 1.x sends lines (K5)", () => {
    for (const version of INFLUX_FIXTURE_VERSIONS) {
      const docs = splitJsonDocuments(loadInfluxCapture(version, "group-by-room-partial").body);
      expect(docs).toHaveLength(14);
      for (const text of docs) expect(() => JSON.parse(text)).not.toThrow();
    }
  });

  test("a multi-MiB hostile body is split in linear time (R40)", () => {
    const hostile = `{"s":"${'\\"}{'.repeat(1 << 20)}"}`;
    const started = performance.now();
    expect(splitJsonDocuments(hostile)).toHaveLength(1);
    expect(splitFault(`${'{"a":['.repeat(1 << 19)}`)).toBe("not-json");
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("shapeInfluxqlBody over the captures", () => {
  for (const version of INFLUX_FIXTURE_VERSIONS) {
    describe(version, () => {
      test("preview-home: the server's columns, time first, one row", () => {
        const shaped = shapeCapture(version, "preview-home");
        expect(shaped.fields).toEqual(["time", "co", "hum", "room", "temp"]);
        expect(shaped.rows).toHaveLength(1);
        expect(shaped.rows[0]).toMatchObject({ co: 26, hum: 36.4, room: "Kitchen", temp: 22.2 });
        expect(shaped.cut).toBe(false);
        expect(shaped.warnings).toEqual([]);
      });

      test("preview-edge-empty: an empty result, whether zero bytes (3.x) or a bare statement 0", () => {
        expect(shapeCapture(version, "preview-edge-empty")).toEqual({ fields: [], rows: [], cut: false, warnings: [] });
      });

      test("group-by-room-partial: the tag leads, partial series join across documents, no partial warning (K5)", () => {
        const shaped = shapeCapture(version, "group-by-room-partial");
        expect(shaped.fields).toEqual(["room", "time", "temp"]);
        expect(shaped.rows).toHaveLength(26);
        expect(shaped.rows.filter((row) => row.room === "Kitchen")).toHaveLength(13);
        expect(shaped.rows.slice(0, 13).every((row) => row.room === "Kitchen")).toBe(true);
        expect(shaped.rows.slice(13).every((row) => row.room === "Living Room")).toBe(true);
        const kitchen = shaped.rows.slice(0, 13).map((row) => row.time as string);
        expect(kitchen).toEqual([...kitchen].sort());
        for (const row of shaped.rows) expect(Object.keys(row).sort()).toEqual(["room", "temp", "time"]);
        expect(shaped.warnings).toEqual([]);
      });

      test("regex-from-partial: a measurement column leads because the result spans several names", () => {
        const shaped = shapeCapture(version, "regex-from-partial");
        const rowCount = { "1.13.1": 39, "2.9.1": 40, "3.12.0-core": 41 }[version];
        expect(shaped.fields.slice(0, 3)).toEqual(["measurement", "time", '"quoted"']);
        expect(shaped.rows).toHaveLength(rowCount);
        expect([...new Set(shaped.rows.map((row) => row.measurement))]).toEqual([
          "edge",
          "edge cases,m",
          "home",
          "numbers",
          "sparse",
          'we"ird name;x',
        ]);
        // A field a series has no value for is JSON null in its row: `co` on a sparse point.
        const sparse = shaped.rows.find((row) => row.measurement === "sparse");
        expect(sparse).toMatchObject({ co: null, a: 1, b: 2 });
        expect(shaped.rows[0]).toMatchObject({ kind: "int64-max", v: "9223372036854775807" });
      });

      test("edge-values: integers beyond 2^53 are exact strings, times keep their nanoseconds", () => {
        const shaped = shapeCapture(version, "edge-values");
        const byKind = (kind: string) => shaped.rows.filter((row) => row.kind === kind);
        expect(byKind("int64-max")[0].v).toBe("9223372036854775807");
        expect(byKind("int64-min")[0].v).toBe("-9223372036854775808");
        expect(byKind("above-2-53")[0].v).toBe("9007199254740993");
        expect(byKind("string")[0].s).toBe(String.raw`say "hi", it's a back\slash`);
        expect(byKind("nanoseconds").map((row) => row.time)).toEqual([
          "2022-01-01T08:00:00.123456789Z",
          version === "3.12.0-core" ? "2022-01-01T08:00:00.123456790Z" : "2022-01-01T08:00:00.12345679Z",
        ]);
        expect(shaped.rows[0].time).toBe("2022-01-01T08:00:00.000000001Z");
        if (version !== "1.13.1") expect(byKind("uint64-max")[0].u).toBe("18446744073709551615");
        expect(shaped.rows).toHaveLength(version === "1.13.1" ? 7 : 8);
      });

      test("hostile-names: names arrive exactly as stored", () => {
        const shaped = shapeCapture(version, "hostile-names");
        expect(shaped.fields).toEqual(["measurement", "time", '"quoted"', "room", "room name", "t=k", "temp °C", "v"]);
        expect(shaped.rows.map((row) => row.measurement)).toEqual(["edge cases,m", 'we"ird name;x']);
        expect(shaped.rows[0]["room name"]).toBe('Café "Ünïcode",x');
      });

      test("nan: a NaN arrives as a null cell, not an error (K13, R33)", () => {
        const shaped = shapeCapture(version, "nan");
        expect(shaped.fields).toEqual(["time", "sqrt"]);
        expect(shaped.rows[0].sqrt).toBeNull();
      });

      test("infinity: the server's error, top-level on 1.x and 3.x, the statement's on 2.x", () => {
        const { fault, serverText } = refusal(loadInfluxCapture(version, "infinity").body);
        expect(fault).toBe(version === "2.9.1" ? "statement-error" : "top-level-error");
        expect(serverText).toBe("json: unsupported value: +Inf");
      });

      test("the show captures shape as one series each", () => {
        expect(shapeCapture(version, "show-measurements-home").fields).toEqual(["name"]);
        expect(shapeCapture(version, "show-field-keys-home").rows).toEqual([
          { fieldKey: "co", fieldType: "integer" },
          { fieldKey: "hum", fieldType: "float" },
          { fieldKey: "temp", fieldType: "float" },
        ]);
        expect(shapeCapture(version, "show-retention-policies-home").fields[0]).toBe("name");
      });
    });
  }
});

describe("the answer-shape check (C5, E5)", () => {
  test("the captured 3.12.0 two-statement answer, across back-to-back documents, is a lexer disagreement", () => {
    const capture = loadInfluxCapture("3.12.0-core", "differential/two-statements");
    expect(refusal(capture.body)).toEqual({ fault: "lexer-disagreement", serverText: undefined });
  });

  test("a statement error then a second statement's rows is a disagreement, not the first error", () => {
    const shown = loadDifferentialCorpus("3.12.0-core").filter((capture) => capture.body.includes('"statement_id":1'));
    expect(shown.length).toBeGreaterThan(0);
    for (const capture of shown) expect(refusal(capture.body).fault).toBe("lexer-disagreement");
  });

  test("two results in one document is a disagreement", () => {
    const body = JSON.stringify({ results: [{ statement_id: 0 }, { statement_id: 1 }] });
    expect(refusal(body).fault).toBe("lexer-disagreement");
  });

  test("a document with no result, or a result other than statement 0, is a disagreement", () => {
    expect(refusal('{"results":[]}').fault).toBe("lexer-disagreement");
    expect(refusal('{"results":[{"statement_id":1}]}').fault).toBe("lexer-disagreement");
  });

  test("a statement-0 document after one that is not partial is a second statement, a disagreement", () => {
    const databases = doc({ series: [{ name: "databases", columns: ["name"], values: [["home"]] }] });
    const home = doc({
      series: [{ name: "home", columns: ["time", "temp"], values: [["2026-10-03T01:50:41Z", 21.1]] }],
    });
    expect(refusal(`${databases}\n${home}\n`)).toEqual({ fault: "lexer-disagreement", serverText: undefined });
    const partial = doc({
      series: [{ name: "home", columns: ["time"], values: [["t1"]], partial: true }],
      partial: true,
    });
    expect(refusal(`${partial}${databases}${home}`).fault).toBe("lexer-disagreement");
  });
});

describe("errors in a 200", () => {
  test("a top-level error carries the server's text", () => {
    expect(refusal('{"error":"database not found: x"}')).toEqual({
      fault: "top-level-error",
      serverText: "database not found: x",
    });
  });

  test("a statement's own error is an error, never an empty result", () => {
    expect(refusal(doc({ error: "database not found: nowhere" }))).toEqual({
      fault: "statement-error",
      serverText: "database not found: nowhere",
    });
  });

  test("the 2.9.1 corpus, which frames the hidden statement as statement 0 too, is a disagreement", () => {
    const shown = loadDifferentialCorpus("2.9.1").filter(
      (capture) => capture.status === 200 && splitJsonDocuments(capture.body).length > 1,
    );
    expect(shown.length).toBeGreaterThan(0);
    for (const capture of shown) expect(refusal(capture.body).fault).toBe("lexer-disagreement");
  });

  test("a document that is not JSON, or JSON of another shape, is not JSON Studio reads", () => {
    for (const body of [
      '{"results":[{"statement_id":0,}]}',
      '{"results":"x"}',
      "{}",
      '{"error":5}',
      '{"results":[7]}',
      '{"results":[{"statement_id":0,"error":5}]}',
      doc({ series: {} }),
      doc({ series: [7] }),
      doc({ series: [{ name: 1, columns: ["time"], values: [] }] }),
      doc({ series: [{ name: "m", columns: "time" }] }),
      doc({ series: [{ name: "m", columns: [1] }] }),
      doc({ series: [{ name: "m", tags: [], columns: ["time"] }] }),
      doc({ series: [{ name: "m", tags: { t: 1 }, columns: ["time"] }] }),
      doc({ series: [{ name: "m", columns: ["time"], values: {} }] }),
      doc({ series: [{ name: "m", columns: ["time"], values: [7] }] }),
      doc({ messages: {} }),
      doc({ messages: [{ level: "warning" }] }),
      doc({ messages: [7] }),
    ]) {
      expect(refusal(body).fault).toBe("not-json");
    }
  });
});

describe("flattening", () => {
  test("a series column or tag named measurement renames the leading column", () => {
    const tagged = doc({
      series: [
        { name: "a", tags: { measurement: "x" }, columns: ["time", "v"], values: [["t1", 1]] },
        { name: "b", tags: { measurement: "y" }, columns: ["time", "v"], values: [["t2", 2]] },
      ],
    });
    const byTag = shapeInfluxqlBody(tagged, LIMITS);
    expect(byTag.fields).toEqual(["measurement (series)", "measurement", "time", "v"]);
    expect(byTag.rows[1]).toEqual({ "measurement (series)": "b", measurement: "y", time: "t2", v: 2 });

    const column = doc({
      series: [
        { name: "a", columns: ["time", "measurement"], values: [["t1", "m"]] },
        { name: "b", columns: ["time"], values: [["t2"]] },
      ],
    });
    expect(shapeInfluxqlBody(column, LIMITS).fields).toEqual(["measurement (series)", "time", "measurement"]);
  });

  test("one series name: no measurement column, even when a column is named measurement", () => {
    const body = doc({ series: [{ name: "a", columns: ["time", "measurement"], values: [["t1", "m"]] }] });
    expect(shapeInfluxqlBody(body, LIMITS).fields).toEqual(["time", "measurement"]);
  });

  test("a series without a name or values (SHOW RETENTION POLICIES on 1.x, an empty series)", () => {
    const body = doc({ series: [{ columns: ["name", "default"], values: [["autogen", true]] }, { columns: ["x"] }] });
    const shaped = shapeInfluxqlBody(body, LIMITS);
    expect(shaped.fields).toEqual(["name", "default", "x"]);
    expect(shaped.rows).toEqual([{ name: "autogen", default: true, x: null }]);
  });

  test("columns are the union in first-seen order; a cell a series lacks is null", () => {
    const body = [
      doc({ series: [{ name: "m", columns: ["time", "b"], values: [["t1", 1]], partial: true }], partial: true }),
      doc({ series: [{ name: "m", columns: ["time", "a", "b"], values: [["t2", 2, 3], ["t3"]] }] }),
    ].join("\n");
    const shaped = shapeInfluxqlBody(body, LIMITS);
    expect(shaped.fields).toEqual(["time", "b", "a"]);
    expect(shaped.rows).toEqual([
      { time: "t1", b: 1, a: null },
      { time: "t2", b: 3, a: 2 },
      { time: "t3", b: null, a: null },
    ]);
  });

  test("keys that look like array indices keep first-seen order", () => {
    const body = doc({ series: [{ name: "m", columns: ["time", "2", "1", "__proto__"], values: [["t", 2, 1, 0]] }] });
    const shaped = shapeInfluxqlBody(body, LIMITS);
    expect(shaped.fields).toEqual(["time", "2", "1", "__proto__"]);
    expect(Object.hasOwn(shaped.rows[0], "__proto__")).toBe(true);
    expect(shaped.rows[0]["1"]).toBe(1);
  });
});

describe("warnings", () => {
  test("a last document marked partial carries the partial sentence (the server's max-row-limit)", () => {
    const body = [
      doc({ series: [{ name: "m", columns: ["time"], values: [["t1"]], partial: true }], partial: true }),
      doc({ series: [{ name: "m", columns: ["time"], values: [["t2"]] }], partial: true }),
    ].join("\n");
    const shaped = shapeInfluxqlBody(body, LIMITS);
    expect(shaped.rows).toHaveLength(2);
    expect(shaped.warnings).toEqual([{ message: INFLUX_ERROR_SENTENCES.partial as string }]);
    expect(shaped.cut).toBe(false);
  });

  test("the server's messages are engine notices, once each, in first-seen order", () => {
    const body = [
      doc({ messages: [{ level: "warning", text: "first" }], partial: true }),
      doc({
        messages: [
          { level: "warning", text: "first" },
          { level: "info", text: "second" },
        ],
      }),
    ].join("");
    expect(shapeInfluxqlBody(body, LIMITS).warnings).toEqual([{ message: "first" }, { message: "second" }]);
  });
});

describe("bounds (spec 5.5)", () => {
  test("the row cut keeps the first rows and sets cut", () => {
    const shaped = shapeCapture("1.13.1", "group-by-room-partial", { rowCut: 3, cellBudget: INFLUX_CELL_BUDGET });
    expect(shaped.rows).toHaveLength(3);
    expect(shaped.cut).toBe(true);
  });

  test("the cell budget cuts at rows times columns", () => {
    const shaped = shapeCapture("1.13.1", "group-by-room-partial", { rowCut: INFLUX_ROW_CUT, cellBudget: 7 });
    expect(shaped.fields).toHaveLength(3);
    expect(shaped.rows).toHaveLength(2);
    expect(shaped.cut).toBe(true);
  });

  test("exactly at the bounds nothing is cut", () => {
    const shaped = shapeCapture("1.13.1", "group-by-room-partial", { rowCut: 26, cellBudget: 78 });
    expect(shaped.rows).toHaveLength(26);
    expect(shaped.cut).toBe(false);
  });
});
