/**
 * The `influxdb` object surface (InfluxDB spec 4; E6, E13): databases as the one container level, measurements as
 * the one kind, columns from `SHOW TAG KEYS` and `SHOW FIELD KEYS` plus `time`, over a recording `send` that answers
 * with the captures. Every text the surface sends is quoted by `influxql-quote.ts` and allowed by the policy, hostile
 * names included, and `_internal` is never read on a generation that hides it.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import type { InfluxAnswer, InfluxRequest } from "@/lib/db/providers/timeseries/influxdb/client";
import { INFLUX_LIST_CAP } from "@/lib/db/providers/timeseries/influxdb/connection-options";
import { InfluxAnswerError, InfluxAnswerShapeError } from "@/lib/db/providers/timeseries/influxdb/errors";
import { lexInfluxql } from "@/lib/db/providers/timeseries/influxdb/influxql-lexer";
import {
  countInfluxqlMeasurements,
  describeInfluxqlMeasurement,
  INFLUX_CONTAINER_LEVELS,
  INFLUXQL_OBJECT_KINDS,
  type InfluxqlCatalogContext,
  listInfluxqlMeasurements,
  readInfluxqlDatabases,
} from "@/lib/db/providers/timeseries/influxdb/influxql-objects";
import { evaluateInfluxql, INFLUXQL_POLICY_SENTENCES } from "@/lib/db/providers/timeseries/influxdb/influxql-policy";
import { INFLUXQL_ROUTES } from "@/lib/db/providers/timeseries/influxdb/routes";
import { RUN_DATABASE_SENTENCES } from "@/lib/db/providers/timeseries/influxdb/run-database";
import type { InfluxGeneration } from "@/lib/db/providers/timeseries/influxdb/versions";
import { type InfluxFixtureVersion, loadInfluxCapture } from "../../../helpers/influxdb-fixtures";

interface Sent {
  readonly request: InfluxRequest<"query">;
  readonly signal: AbortSignal;
}

/** A `send` that answers each request with the next scripted answer and records what it was asked. */
function recordingSend(answers: readonly (InfluxAnswer | string)[]) {
  const sent: Sent[] = [];
  const signals: AbortSignal[] = [];
  const context = (generation: InfluxGeneration): InfluxqlCatalogContext => ({
    send: async (request, signal) => {
      sent.push({ request, signal });
      const next = answers[sent.length - 1];
      if (next === undefined) throw new Error(`no answer scripted for request ${sent.length}`);
      return typeof next === "string" ? { status: 200, contentType: "application/json", text: next } : next;
    },
    signal: () => {
      const signal = new AbortController().signal;
      signals.push(signal);
      return signal;
    },
    generation,
  });
  return { sent, signals, context };
}

const body = (version: InfluxFixtureVersion, name: string): string => loadInfluxCapture(version, name).body;

/** A one-series `/query` document. */
function series(name: string, columns: readonly string[], values: readonly (readonly unknown[])[]): string {
  return JSON.stringify({ results: [{ statement_id: 0, series: [{ name, columns, values }] }] });
}

const measurementNames = (count: number): string =>
  series(
    "measurements",
    ["name"],
    Array.from({ length: count }, (_, index) => [`m${String(index).padStart(4, "0")}`]),
  );

/** Every `q` sent is allowed by the policy and names exactly the database it was sent with. */
function expectAllowed(sent: readonly Sent[]): void {
  for (const { request } of sent) {
    const verdict = evaluateInfluxql(request.values.q);
    expect(verdict.allowed).toBe(true);
    if (verdict.allowed) {
      expect(verdict.namedDatabases).toEqual(request.values.db === undefined ? [] : [request.values.db]);
    }
  }
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the read resolved");
}

describe("declarations (contract section 14)", () => {
  test("one container level, Database", () => {
    expect(INFLUX_CONTAINER_LEVELS).toEqual([{ id: "schema", label: "Database", labelPlural: "Databases" }]);
    expect(Object.isFrozen(INFLUX_CONTAINER_LEVELS)).toBe(true);
  });

  test("one kind, the measurement: a relation with columns, no source, no row writes", () => {
    expect(INFLUXQL_OBJECT_KINDS).toEqual([
      {
        id: "measurement",
        role: "relation",
        label: "Measurement",
        labelPlural: "Measurements",
        hasColumns: true,
        hasSource: false,
        acceptsRowWrites: false,
      },
    ]);
    expect(Object.isFrozen(INFLUXQL_OBJECT_KINDS)).toBe(true);
  });
});

describe("readInfluxqlDatabases", () => {
  test("1.x lists _internal, sends SHOW DATABASES with no db, and marks the connection's database", async () => {
    const { sent, signals, context } = recordingSend([body("1.13.1", "show-databases-admin")]);
    const containers = await readInfluxqlDatabases(context("v1"), "home");
    expect(containers).toEqual([
      { path: ["home"], name: "home", level: 0, isSessionDefault: true },
      { path: ["edge"], name: "edge", level: 0, isSessionDefault: false },
      { path: ["_internal"], name: "_internal", level: 0, isSessionDefault: false },
      { path: ["bench"], name: "bench", level: 0, isSessionDefault: false },
    ]);
    expect(sent.map((entry) => entry.request)).toEqual([{ route: "query", values: { q: "SHOW DATABASES" } }]);
    expect(sent[0].signal).toBe(signals[0]);
    expectAllowed(sent);
  });

  test("3.x and an unknown generation drop _internal (E13)", async () => {
    for (const [generation, version] of [
      ["v3", "3.12.0-core"],
      ["unknown", "1.13.1"],
    ] as const) {
      const { context } = recordingSend([body(version, "show-databases-admin")]);
      // oxlint-disable-next-line no-await-in-loop -- each generation reads its own scripted answer.
      const names = (await readInfluxqlDatabases(context(generation), undefined)).map((container) => container.name);
      expect(names).not.toContain("_internal");
      expect(names).toEqual(expect.arrayContaining(["home", "edge", "bench"]));
    }
  });

  test("2.x lists its system buckets as ordinary databases", async () => {
    const { context } = recordingSend([body("2.9.1", "show-databases-admin")]);
    const names = (await readInfluxqlDatabases(context("v2"), undefined)).map((container) => container.name);
    expect(names).toEqual(["_monitoring", "_tasks", "bench", "edge", "home"]);
  });

  test("a database name that is not text is not an answer Studio reads", async () => {
    const { context } = recordingSend([series("databases", ["name"], [[7]])]);
    const error = await rejection(readInfluxqlDatabases(context("v1"), undefined));
    expect(error).toBeInstanceOf(InfluxAnswerShapeError);
    expect((error as InfluxAnswerShapeError).fault).toBe("not-json");
  });

  test("an answer other than a 200 is handed on as the /query route's answer", async () => {
    const answer: InfluxAnswer = { status: 403, contentType: "application/json", text: '{"error":"no"}' };
    const { context } = recordingSend([answer]);
    const error = await rejection(readInfluxqlDatabases(context("v1"), undefined));
    expect(error).toBeInstanceOf(InfluxAnswerError);
    expect((error as InfluxAnswerError).answer).toBe(answer);
    expect((error as InfluxAnswerError).route).toBe(INFLUXQL_ROUTES.query.path);
  });
});

describe("listInfluxqlMeasurements and countInfluxqlMeasurements", () => {
  test("the listing reads SHOW MEASUREMENTS ON <db> LIMIT 2001 with db set, in server order", async () => {
    const { sent, context } = recordingSend([body("1.13.1", "show-measurements-home")]);
    const objects = await listInfluxqlMeasurements(context("v1"), "home");
    expect(sent.map((entry) => entry.request)).toEqual([
      { route: "query", values: { q: 'SHOW MEASUREMENTS ON "home" LIMIT 2001', db: "home" } },
    ]);
    expect(objects.map((object) => object.name)).toEqual([
      "edge",
      "edge cases,m",
      "home",
      "numbers",
      "sparse",
      'we"ird name;x',
    ]);
    expect(objects[5]).toEqual({ path: ["home", 'we"ird name;x'], name: 'we"ird name;x', kind: "measurement" });
    expectAllowed(sent);
  });

  test("an empty database answers no measurement, as zero bytes or a bare statement 0", async () => {
    const { context } = recordingSend(["", '{"results":[{"statement_id":0}]}']);
    expect(await listInfluxqlMeasurements(context("v3"), "empty")).toEqual([]);
    expect(await countInfluxqlMeasurements(context("v1"), "empty")).toEqual({ measurement: { count: 0 } });
  });

  test("the count is the listing's length up to the cap", async () => {
    const { context } = recordingSend([body("3.12.0-core", "show-measurements-edge"), measurementNames(2000)]);
    expect(await countInfluxqlMeasurements(context("v3"), "edge")).toEqual({ measurement: { count: 5 } });
    expect(await countInfluxqlMeasurements(context("v3"), "big")).toEqual({ measurement: { count: INFLUX_LIST_CAP } });
  });

  test("over the cap the count is a floor and the listing holds the first 2,000", async () => {
    const { context } = recordingSend([measurementNames(2001), measurementNames(2001)]);
    expect(await countInfluxqlMeasurements(context("v1"), "big")).toEqual({
      measurement: { count: 2000, sampledFrom: "the first 2,000 measurements SHOW MEASUREMENTS returned" },
    });
    const listed = await listInfluxqlMeasurements(context("v1"), "big");
    expect(listed).toHaveLength(INFLUX_LIST_CAP);
    expect(listed.at(-1)?.name).toBe("m1999");
  });
});

describe("describeInfluxqlMeasurement", () => {
  test("time, then tags, then fields, in server order, with their types and nullability", async () => {
    const { sent, signals, context } = recordingSend([
      body("2.9.1", "show-tag-keys-home"),
      body("2.9.1", "show-field-keys-home"),
    ]);
    const detail = await describeInfluxqlMeasurement(context("v2"), "home", "home");
    expect(sent.map((entry) => entry.request.values)).toEqual([
      { q: 'SHOW TAG KEYS ON "home" FROM "home"', db: "home" },
      { q: 'SHOW FIELD KEYS ON "home" FROM "home"', db: "home" },
    ]);
    expect(sent.map((entry) => entry.signal)).toEqual(signals);
    expect(detail).toEqual({
      path: ["home", "home"],
      columns: [
        { name: "time", type: "time", nullable: false, isPrimary: false },
        { name: "room", type: "tag", nullable: true, isPrimary: false },
        { name: "co", type: "integer", nullable: true, isPrimary: false },
        { name: "hum", type: "float", nullable: true, isPrimary: false },
        { name: "temp", type: "float", nullable: true, isPrimary: false },
      ],
      indexes: [],
      foreignKeys: [],
    });
    expectAllowed(sent);
  });

  test("a measurement with no tag keys: zero bytes on 3.x", async () => {
    const { context } = recordingSend(["", series("numbers", ["fieldKey", "fieldType"], [["u", "unsigned"]])]);
    const detail = await describeInfluxqlMeasurement(context("v3"), "edge", "numbers");
    expect(detail.columns.map((column) => [column.name, column.type])).toEqual([
      ["time", "time"],
      ["u", "unsigned"],
    ]);
  });

  test("a field type that is not text is not an answer Studio reads", async () => {
    const { context } = recordingSend(["", series("m", ["fieldKey", "fieldType"], [["f", null]])]);
    const error = await rejection(describeInfluxqlMeasurement(context("v1"), "home", "m"));
    expect((error as InfluxAnswerShapeError).fault).toBe("not-json");
  });
});

describe("no trusted internal path (E6)", () => {
  const HOSTILE = ['we"ird name;x', "line\nbreak", "*/", "/*", "--", "/", "\\", 'a\\"b', "x; DROP DATABASE y", "ünï"];

  test("hostile database and measurement names round-trip through the quoter and the policy", async () => {
    for (const name of HOSTILE) {
      const { sent, context } = recordingSend(["", "", ""]);
      // oxlint-disable-next-line no-await-in-loop -- the scripted answers are taken in order.
      await listInfluxqlMeasurements(context("v1"), name);
      // oxlint-disable-next-line no-await-in-loop -- the scripted answers are taken in order.
      await describeInfluxqlMeasurement(context("v1"), name, name);
      expect(sent).toHaveLength(3);
      expectAllowed(sent);
      for (const { request } of sent.slice(1)) {
        const values = lexInfluxql(request.values.q)
          .filter((token) => token.kind === "quoted-identifier")
          .map((token) => token.value);
        expect(values).toEqual([name, name]);
      }
    }
  });

  test("a text the policy refuses is never sent", async () => {
    const { sent, context } = recordingSend([]);
    const long = "m".repeat(70_000);
    const error = await rejection(listInfluxqlMeasurements(context("v1"), long));
    expect(error).toBeInstanceOf(QueryError);
    const bytes = new TextEncoder().encode(`SHOW MEASUREMENTS ON "${long}" LIMIT 2001`).length;
    expect((error as Error).message).toBe(INFLUXQL_POLICY_SENTENCES.tooLong(bytes));
    expect(sent).toEqual([]);
  });
});

describe("_internal (E13)", () => {
  test("3.x and an unknown generation never read it, and nothing is sent", async () => {
    for (const generation of ["v3", "unknown"] as const) {
      const { sent, context } = recordingSend([]);
      for (const read of [
        () => listInfluxqlMeasurements(context(generation), "_internal"),
        () => countInfluxqlMeasurements(context(generation), "_internal"),
        () => describeInfluxqlMeasurement(context(generation), "_internal", "tokens"),
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- one read at a time, so none rejects unobserved.
        const error = await rejection(read());
        expect(error).toBeInstanceOf(QueryError);
        expect((error as Error).message).toBe(RUN_DATABASE_SENTENCES.internalHidden);
      }
      expect(sent).toEqual([]);
    }
  });

  test("1.x browses it", async () => {
    const { sent, context } = recordingSend([series("measurements", ["name"], [["runtime"]])]);
    expect((await listInfluxqlMeasurements(context("v1"), "_internal")).map((object) => object.path)).toEqual([
      ["_internal", "runtime"],
    ]);
    expect(sent[0].request.values.db).toBe("_internal");
  });
});
