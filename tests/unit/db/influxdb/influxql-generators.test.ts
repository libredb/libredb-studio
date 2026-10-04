/**
 * InfluxQL generators (SPEC 6.6, I20, E6): the tree-click preview and the Generate Query text of the
 * `influxdb` type, held to the exact SPEC 6.6 texts, and every output, hostile names included, round
 * tripped through the read policy, comment lines and all, as an allowed read that names only the
 * clicked database.
 */
import { describe, expect, test } from "bun:test";
import { PREVIEW_PAGE_SIZE } from "@/hooks/use-tab-manager";
import {
  INFLUXQL_PREVIEW_LIMIT,
  INFLUXQL_PREVIEW_WINDOW,
  influxqlSelectQuery,
  influxqlTableQuery,
} from "@/lib/db/providers/timeseries/influxdb/influxql-generators";
import { evaluateInfluxql } from "@/lib/db/providers/timeseries/influxdb/influxql-policy";
import { InfluxqlQuoteError } from "@/lib/db/providers/timeseries/influxdb/influxql-quote";
import type { ColumnSchema } from "@/lib/types";

function column(name: string, type: string): ColumnSchema {
  return { name, type, nullable: true, isPrimary: false };
}

/**
 * The columns of the seeded `home` measurement (docker/influxdb/home.lp) in the server's field-key order,
 * which is by name, so the first numeric field is the integer `co`, not the `temp` of the SPEC 6.6 example.
 */
const HOME_COLUMNS: readonly ColumnSchema[] = [
  column("time", "time"),
  column("co", "integer"),
  column("hum", "float"),
  column("room", "tag"),
  column("temp", "float"),
];

const PREVIEW =
  "-- Newest points of the last hour, LIMIT 50 per series. No row means no point is newer: widen 1h below.\n" +
  'SELECT * FROM "home".."home" WHERE time > now() - 1h ORDER BY time DESC LIMIT 50';

const HOSTILE_NAMES = ['we"ird name;x', "line\nbreak", "a*/b", "a--b", "a/b/", "back\\slash", "'; DROP DATABASE x"];

/** The databases an allowed text names; fails with the refusal when the policy refuses it. */
function allowedDatabases(text: string): readonly string[] {
  const verdict = evaluateInfluxql(text);
  if (!verdict.allowed) throw new Error(`refused (${verdict.reason}): ${verdict.message}\n${text}`);
  expect(verdict.statement).toBe("SELECT");
  return verdict.namedDatabases;
}

describe("the preview constants", () => {
  test("the text's LIMIT is the shell's preview page size, and the window is one hour (K1)", () => {
    expect(INFLUXQL_PREVIEW_LIMIT).toBe(PREVIEW_PAGE_SIZE);
    expect(INFLUXQL_PREVIEW_WINDOW).toBe("1h");
  });
});

describe("influxqlTableQuery (SPEC 6.6)", () => {
  test("the exact preview text for home", () => {
    expect(influxqlTableQuery(["home", "home"])).toBe(PREVIEW);
  });

  test("the preview is an allowed read naming only its database", () => {
    expect(allowedDatabases(influxqlTableQuery(["home", "home"]))).toEqual(["home"]);
  });

  test.each(HOSTILE_NAMES.map((name) => [name]))("a hostile name %p round trips through the policy", (name) => {
    expect(allowedDatabases(influxqlTableQuery([name, name]))).toEqual([name]);
    expect(allowedDatabases(influxqlTableQuery(["home", name]))).toEqual(["home"]);
  });

  test.each([[[]], [["home"]], [["home", "home", "extra"]]])("a path of the wrong length %p is refused", (path) => {
    expect(() => influxqlTableQuery(path)).toThrow(
      `An InfluxQL preview path is [database, measurement]; received ${path.length} segment(s)`,
    );
  });

  test("a name holding a control character the scanner cannot escape throws the quoter's error", () => {
    expect(() => influxqlTableQuery(["home", "tab\there"])).toThrow(InfluxqlQuoteError);
  });
});

describe("influxqlSelectQuery (SPEC 6.6)", () => {
  test("the exact Generate Query text for home with the seeded columns", () => {
    expect(influxqlSelectQuery(["home", "home"], HOME_COLUMNS)).toBe(
      `${PREVIEW}\n` +
        "-- A wider window: WHERE time > now() - 1d\n" +
        '-- One point per minute: SELECT mean("co") FROM "home".."home" WHERE time > now() - 1h GROUP BY time(1m)\n' +
        '-- Another retention policy: SELECT * FROM "home"."<rp>"."home" (SHOW RETENTION POLICIES ON "home" lists them)\n' +
        '-- Tag values: SHOW TAG VALUES ON "home" FROM "home" WITH KEY = "room" (on InfluxDB 3 add WHERE time > 0)\n' +
        "-- For the Charts tab: ORDER BY time ASC, and choose time as the x axis.",
    );
  });

  test("the SPEC 6.6 example names temp when it is the first numeric field", () => {
    const columns = [column("time", "time"), column("room", "tag"), column("temp", "float"), column("co", "integer")];
    expect(influxqlSelectQuery(["home", "home"], columns)).toBe(
      `${PREVIEW}\n` +
        "-- A wider window: WHERE time > now() - 1d\n" +
        '-- One point per minute: SELECT mean("temp") FROM "home".."home" WHERE time > now() - 1h GROUP BY time(1m)\n' +
        '-- Another retention policy: SELECT * FROM "home"."<rp>"."home" (SHOW RETENTION POLICIES ON "home" lists them)\n' +
        '-- Tag values: SHOW TAG VALUES ON "home" FROM "home" WITH KEY = "room" (on InfluxDB 3 add WHERE time > 0)\n' +
        "-- For the Charts tab: ORDER BY time ASC, and choose time as the x axis.",
    );
  });

  test("an integer field counts as numeric, and a string, boolean or unsigned field does not", () => {
    const columns = [
      column("s", "string"),
      column("b", "boolean"),
      column("u", "unsigned"),
      column("n", "integer"),
      column("kind", "tag"),
    ];
    const text = influxqlSelectQuery(["edge", "edge"], columns);
    expect(text).toContain('SELECT mean("n") FROM "edge".."edge"');
    expect(text).toContain('WITH KEY = "kind"');
  });

  test('with no columns the examples name "value" and "tag"', () => {
    const text = influxqlSelectQuery(["home", "home"], []);
    expect(text).toContain('-- One point per minute: SELECT mean("value") FROM "home".."home"');
    expect(text).toContain('-- Tag values: SHOW TAG VALUES ON "home" FROM "home" WITH KEY = "tag" (on InfluxDB 3');
  });

  test("the whole text, comment lines included, is an allowed read naming only its database", () => {
    expect(allowedDatabases(influxqlSelectQuery(["home", "home"], HOME_COLUMNS))).toEqual(["home"]);
    expect(allowedDatabases(influxqlSelectQuery(["home", "home"], []))).toEqual(["home"]);
  });

  test.each(HOSTILE_NAMES.map((name) => [name]))("hostile names %p in every position round trip", (name) => {
    const columns = [column(name, "float"), column(name, "tag")];
    const text = influxqlSelectQuery([name, name], columns);
    expect(allowedDatabases(text)).toEqual([name]);
    expect(text.split("\n")).toHaveLength(7);
  });

  test("a hostile field or tag name fails the quoter rather than reaching the text", () => {
    expect(() => influxqlSelectQuery(["home", "home"], [column("f\rx", "float")])).toThrow(InfluxqlQuoteError);
    expect(() => influxqlSelectQuery(["home", "home"], [column("t\u007f", "tag")])).toThrow(InfluxqlQuoteError);
  });

  test("a path of the wrong length is refused", () => {
    expect(() => influxqlSelectQuery(["home"], HOME_COLUMNS)).toThrow(
      "An InfluxQL preview path is [database, measurement]; received 1 segment(s)",
    );
  });
});
