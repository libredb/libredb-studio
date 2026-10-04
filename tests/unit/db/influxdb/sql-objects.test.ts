/**
 * The `influxdb3` object surface (InfluxDB spec 4, E6, E13): the database listing behind the session database, the
 * session database's tables with no container level, their count and their columns. Every catalog text passes the
 * SQL policy before it is sent, `_internal` is never offered, `system.*` is never listed, and a path that is not one
 * segment is refused before any request.
 */
import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import type { InfluxAnswer, InfluxRequest, InfluxSend } from "@/lib/db/providers/timeseries/influxdb/client";
import { InfluxAnswerError, InfluxAnswerShapeError } from "@/lib/db/providers/timeseries/influxdb/errors";
import { SQL_ROUTES } from "@/lib/db/providers/timeseries/influxdb/routes";
import {
  countInfluxdb3Tables,
  describeInfluxdb3Table,
  INFLUXDB3_OBJECT_KINDS,
  influxdb3PathRefusal,
  listInfluxdb3Tables,
  readInfluxdb3Databases,
} from "@/lib/db/providers/timeseries/influxdb/sql-objects";
import { evaluateInfluxSql } from "@/lib/db/providers/timeseries/influxdb/sql-policy";
import { loadInfluxCapture } from "../../../helpers/influxdb-fixtures";

const SIGNAL = new AbortController().signal;

function answerOf(name: string): InfluxAnswer {
  const capture = loadInfluxCapture("3.12.0-core", name);
  return { status: capture.status, contentType: capture.contentType, text: capture.body };
}

function jsonl(rows: readonly unknown[]): InfluxAnswer {
  return {
    status: 200,
    contentType: "application/jsonl",
    text: rows.map((row) => `${JSON.stringify(row)}\n`).join(""),
  };
}

/** A send that answers each request with the next answer and records what it was asked. */
function recordingSend<Id extends string>(...answers: InfluxAnswer[]) {
  const requests: { request: InfluxRequest<Id>; signal: AbortSignal }[] = [];
  const send: InfluxSend<Id> = async (request, signal) => {
    requests.push({ request, signal });
    const answer = answers.shift();
    if (answer === undefined) throw new Error("no scripted answer left");
    return answer;
  };
  return { send, requests };
}

function context(send: InfluxSend<"query">) {
  return { send, signal: SIGNAL, sessionDatabase: "home" };
}

/** The iox rows of the captured information_schema.tables answer, as the listing's projection returns them. */
function ioxTableRows(): { table_name: string }[] {
  return answerOf("sql-tables")
    .text.split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { table_schema: string; table_name: string })
    .filter((row) => row.table_schema === "iox")
    .map((row) => ({ table_name: row.table_name }));
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("the read did not fail");
}

describe("INFLUXDB3_OBJECT_KINDS", () => {
  test("one relation kind, the table, with columns and no source or row writes", () => {
    expect(INFLUXDB3_OBJECT_KINDS).toEqual([
      {
        id: "table",
        role: "relation",
        label: "Table",
        labelPlural: "Tables",
        hasColumns: true,
        hasSource: false,
        acceptsRowWrites: false,
      },
    ]);
    expect(Object.isFrozen(INFLUXDB3_OBJECT_KINDS)).toBe(true);
  });
});

describe("influxdb3PathRefusal", () => {
  test("names the session database and the way to read another", () => {
    expect(influxdb3PathRefusal("home")).toBe(
      "This InfluxDB 3 connection reads one database, home, whose tables have no database prefix; set Database on the connection to read another.",
    );
  });
});

describe("readInfluxdb3Databases", () => {
  test("lists the captured databases in server order with _internal removed", async () => {
    const { send, requests } = recordingSend<"databases">(answerOf("sql-databases"));
    expect(await readInfluxdb3Databases(send, SIGNAL)).toEqual(["bench", "edge", "home"]);
    expect(requests).toEqual([{ request: { route: "databases", values: {} }, signal: SIGNAL }]);
  });

  test("an empty listing is no database", async () => {
    const { send } = recordingSend<"databases">({ status: 200, contentType: "application/json", text: "[]" });
    expect(await readInfluxdb3Databases(send, SIGNAL)).toEqual([]);
  });

  test("an answer that is not a 200 of JSON is an answer error on the listing route", async () => {
    const forbidden = { status: 403, contentType: "application/json", text: '{"error":"forbidden"}' };
    const { send } = recordingSend<"databases">(forbidden);
    const error = await rejection(readInfluxdb3Databases(send, SIGNAL));
    expect(error).toBeInstanceOf(InfluxAnswerError);
    expect((error as InfluxAnswerError).answer).toEqual(forbidden);
    expect((error as InfluxAnswerError).route).toBe(SQL_ROUTES.databases.path);

    const html = { status: 200, contentType: "text/html", text: "<html></html>" };
    const second = recordingSend<"databases">(html);
    expect(await rejection(readInfluxdb3Databases(second.send, SIGNAL))).toBeInstanceOf(InfluxAnswerError);

    const none = { status: 200, contentType: null, text: "[]" };
    const third = recordingSend<"databases">(none);
    expect(await rejection(readInfluxdb3Databases(third.send, SIGNAL))).toBeInstanceOf(InfluxAnswerError);
  });

  test("a content type with parameters and another case is still JSON", async () => {
    const { send } = recordingSend<"databases">({
      status: 200,
      contentType: "Application/JSON; charset=utf-8",
      text: '[{"iox::database":"home"}]',
    });
    expect(await readInfluxdb3Databases(send, SIGNAL)).toEqual(["home"]);
  });

  test.each([
    ["text that is not JSON", "not json"],
    ["an object", '{"iox::database":"home"}'],
    ["an entry without the name", '[{"name":"home"}]'],
    ["a name that is not text", '[{"iox::database":7}]'],
    ["an entry that is not an object", '["home"]'],
  ])("%s is a not-json shape error", async (_, text) => {
    const { send } = recordingSend<"databases">({ status: 200, contentType: "application/json", text });
    const error = await rejection(readInfluxdb3Databases(send, SIGNAL));
    expect(error).toBeInstanceOf(InfluxAnswerShapeError);
    expect((error as InfluxAnswerShapeError).fault).toBe("not-json");
  });
});

describe("listInfluxdb3Tables", () => {
  test("lists the iox tables of the session database, and the WHERE table_schema = 'iox' text is what keeps system.* out", async () => {
    const { send, requests } = recordingSend<"query">(jsonl(ioxTableRows()));
    const listing = await listInfluxdb3Tables(context(send));
    expect(listing.truncated).toBe(false);
    expect(listing.tables.map((table) => table.name)).toEqual([
      "edge",
      "edge cases,m",
      "home",
      "numbers",
      "sparse",
      'we"ird name;x',
    ]);
    expect(listing.tables[5]).toEqual({ path: ['we"ird name;x'], name: 'we"ird name;x', kind: "table" });

    expect(requests).toHaveLength(1);
    const { request, signal } = requests[0];
    expect(signal).toBe(SIGNAL);
    expect(request).toEqual({
      route: "query",
      values: {
        db: "home",
        q: "SELECT table_name FROM information_schema.tables WHERE table_schema = 'iox' ORDER BY table_name LIMIT 2001",
      },
    });
    expect(evaluateInfluxSql(request.values.q)).toEqual({ allowed: true, keyword: "SELECT" });
  });

  test("2,001 names are the first 2,000 and a truncated listing", async () => {
    const rows = Array.from({ length: 2001 }, (_, index) => ({ table_name: `t${String(index).padStart(4, "0")}` }));
    const { send } = recordingSend<"query">(jsonl(rows));
    const listing = await listInfluxdb3Tables(context(send));
    expect(listing.tables).toHaveLength(2000);
    expect(listing.tables[1999].name).toBe("t1999");
    expect(listing.truncated).toBe(true);
  });

  test("an empty database lists no table", async () => {
    const { send } = recordingSend<"query">(answerOf("sql-empty"));
    expect(await listInfluxdb3Tables(context(send))).toEqual({ tables: [], truncated: false });
  });

  test("a row whose name is not text is a not-json shape error", async () => {
    const { send } = recordingSend<"query">(jsonl([{ table_name: 1 }]));
    const error = await rejection(listInfluxdb3Tables(context(send)));
    expect(error).toBeInstanceOf(InfluxAnswerShapeError);
    expect((error as InfluxAnswerShapeError).fault).toBe("not-json");
  });

  test("an answer that is not a 200 of JSON lines is an answer error on the query route", async () => {
    const notFound = answerOf("sql-db-not-found");
    const { send } = recordingSend<"query">(notFound);
    const error = await rejection(listInfluxdb3Tables(context(send)));
    expect(error).toBeInstanceOf(InfluxAnswerError);
    expect((error as InfluxAnswerError).route).toBe(SQL_ROUTES.query.path);
    expect((error as InfluxAnswerError).answer).toEqual(notFound);
  });
});

describe("countInfluxdb3Tables", () => {
  test("counts the listing", async () => {
    const { send } = recordingSend<"query">(jsonl(ioxTableRows()));
    expect(await countInfluxdb3Tables(context(send))).toEqual({ count: 6 });
  });

  test("over 2,000 tables the count is a floor that says what it counted", async () => {
    const rows = Array.from({ length: 2001 }, (_, index) => ({ table_name: `t${index}` }));
    const { send } = recordingSend<"query">(jsonl(rows));
    expect(await countInfluxdb3Tables(context(send))).toEqual({
      count: 2000,
      sampledFrom: "the first 2,000 tables information_schema.tables returned",
    });
  });
});

describe("describeInfluxdb3Table", () => {
  test("home: time, then tags, then fields, each in server order, typed from data_type", async () => {
    const { send, requests } = recordingSend<"query">(answerOf("sql-schema-home"));
    const detail = await describeInfluxdb3Table(context(send), ["home"]);
    expect(detail).toEqual({
      path: ["home"],
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
    const { request, signal } = requests[0];
    expect(signal).toBe(SIGNAL);
    expect(request).toEqual({
      route: "query",
      values: { db: "home", q: "SELECT key, data_type FROM system.influxdb_schema WHERE measurement = 'home'" },
    });
    expect(evaluateInfluxSql(request.values.q).allowed).toBe(true);
  });

  test("the hostile table: the name is a literal the policy allows, and its columns come back", async () => {
    const capture = loadInfluxCapture("3.12.0-core", "sql-schema-hostile");
    const { send, requests } = recordingSend<"query">(answerOf("sql-schema-hostile"));
    const detail = await describeInfluxdb3Table(context(send), ['we"ird name;x']);
    expect(detail.columns.map((column) => [column.name, column.type])).toEqual([
      ["time", "time"],
      ["room", "tag"],
      ["v", "integer"],
    ]);
    expect(requests[0].request.values.q).toBe((capture.request.body as { q: string }).q);
    expect(evaluateInfluxSql(requests[0].request.values.q).allowed).toBe(true);
  });

  test("a single quote in the name is doubled, and the text is still one allowed statement", async () => {
    const { send, requests } = recordingSend<"query">(jsonl([{ key: "it's", data_type: "uinteger" }]));
    const detail = await describeInfluxdb3Table(context(send), ["it's; DROP TABLE x --"]);
    expect(requests[0].request.values.q).toBe(
      "SELECT key, data_type FROM system.influxdb_schema WHERE measurement = 'it''s; DROP TABLE x --'",
    );
    expect(evaluateInfluxSql(requests[0].request.values.q).allowed).toBe(true);
    expect(detail.columns).toEqual([{ name: "it's", type: "uinteger", nullable: true, isPrimary: false }]);
  });

  test("a table the catalog does not know has no column", async () => {
    const { send } = recordingSend<"query">(answerOf("sql-empty"));
    expect((await describeInfluxdb3Table(context(send), ["gone"])).columns).toEqual([]);
  });

  test.each([[[]], [["home", "home"]], [["home", "iox", "home"]]])(
    "a path of %p is refused before any request",
    async (path) => {
      const { send, requests } = recordingSend<"query">();
      const error = await rejection(describeInfluxdb3Table(context(send), path));
      expect(error).toBeInstanceOf(QueryError);
      expect((error as QueryError).message).toBe(influxdb3PathRefusal("home"));
      expect(requests).toHaveLength(0);
    },
  );

  test("a describe text the policy refuses is never sent", async () => {
    const { send, requests } = recordingSend<"query">();
    const error = await rejection(describeInfluxdb3Table(context(send), ["x".repeat(1024 * 1024)]));
    expect(error).toBeInstanceOf(QueryError);
    expect((error as QueryError).message).toContain("bytes; an InfluxDB 3 connection in Studio sends at most");
    expect(requests).toHaveLength(0);
  });

  test.each([
    ["a key that is not text", { key: 1, data_type: "tag" }],
    ["a data_type that is not text", { key: "a", data_type: null }],
  ])("%s is a not-json shape error", async (_, row) => {
    const { send } = recordingSend<"query">(jsonl([row]));
    const error = await rejection(describeInfluxdb3Table(context(send), ["home"]));
    expect(error).toBeInstanceOf(InfluxAnswerShapeError);
    expect((error as InfluxAnswerShapeError).fault).toBe("not-json");
  });

  test("an answer that is not a 200 is an answer error", async () => {
    const failed = answerOf("sql-schema-error");
    const { send } = recordingSend<"query">(failed);
    const error = await rejection(describeInfluxdb3Table(context(send), ["home"]));
    expect(error).toBeInstanceOf(InfluxAnswerError);
  });

  test("a 4 MiB hostile column name is read in one pass (R40)", async () => {
    const name = "Query would scan '".repeat(240_000);
    const started = performance.now();
    const { send } = recordingSend<"query">(jsonl([{ key: name, data_type: "string" }]));
    const detail = await describeInfluxdb3Table(context(send), ["home"]);
    expect(detail.columns[0].name).toBe(name);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
