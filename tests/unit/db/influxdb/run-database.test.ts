/**
 * The database a run reads on `influxdb` (SPEC 5.8, I21 as R17 words it) and the one session database
 * of `influxdb3` (R1), with the `_internal` refusal on both (I11, E13).
 * Every statement form of E13 is driven end to end: the text goes through `evaluateInfluxql`, and its
 * `namedDatabases` reach `resolveRunDatabase`, so a reader that stopped naming `_internal` for a form
 * fails here too. R31's after-dot forms are among them.
 */
import { describe, expect, test } from "bun:test";
import { evaluateInfluxql } from "@/lib/languages/influxql/policy";
import {
  INFLUX_SYSTEM_DATABASES,
  RUN_DATABASE_SENTENCES,
  resolveRunDatabase,
  resolveSessionDatabase,
} from "@/lib/db/providers/timeseries/influxdb/run-database";
import { ALLOWS_PRIVATE_HOSTS } from "../../../helpers/egress-decisions";
import {
  type InfluxAnswer,
  type InfluxClientFactory,
  type InfluxRequest,
} from "@/lib/db/providers/timeseries/influxdb/client";
import { INFLUXDB_DEFAULT_PORT } from "@/lib/db/providers/timeseries/influxdb/connection-options";
import { InfluxDBProvider } from "@/lib/db/providers/timeseries/influxdb/index";
import { type DatabaseConnection } from "@/lib/types";

// R54 (4): every option the sentence names exists; a container row has no action, and SHOW names its database with ON.
const CHOOSE =
  'Choose a database: open the statement from a measurement in the tree, set Database on the connection, or name it in the statement as "db".."measurement" (ON "db" for SHOW).';
// R44 (1): one sentence true on every line that hides `_internal`, 2.x and an unknown generation included.
const INTERNAL =
  "Studio does not read the _internal database on this server; on InfluxDB 3 it holds the server's token table.";

function namedIn(text: string): readonly string[] {
  const verdict = evaluateInfluxql(text);
  if (!verdict.allowed) throw new Error(`expected ${JSON.stringify(text)} to be allowed: ${verdict.message}`);
  return verdict.namedDatabases;
}

const base = {
  namedDatabases: [] as readonly string[],
  needsDatabase: true,
  connection: undefined as string | undefined,
  visible: undefined as readonly string[] | undefined,
  internalDatabase: "hide" as "browse" | "hide",
};

describe("RUN_DATABASE_SENTENCES", () => {
  test("the fixed sentences, verbatim", () => {
    expect(RUN_DATABASE_SENTENCES.chooseDatabase).toBe(CHOOSE);
    expect(RUN_DATABASE_SENTENCES.internalHidden).toBe(INTERNAL);
    expect(RUN_DATABASE_SENTENCES.sessionNone).toBe(
      "This InfluxDB 3 token can list no database; create one on the server or set Database on the connection.",
    );
    expect(RUN_DATABASE_SENTENCES.listingRefused).toBe(
      "This token cannot list the server's databases, which an InfluxDB 3 Enterprise database token cannot; set Database on the connection.",
    );
  });

  test("sessionMany names every database up to ten", () => {
    expect(RUN_DATABASE_SENTENCES.sessionMany(["a", "b"])).toBe(
      "This InfluxDB 3 server has more than one database (a, b), and a connection reads one: set Database on the connection.",
    );
    const ten = Array.from({ length: 10 }, (_, i) => `d${i + 1}`);
    expect(RUN_DATABASE_SENTENCES.sessionMany(ten)).toBe(
      `This InfluxDB 3 server has more than one database (${ten.join(", ")}), and a connection reads one: set Database on the connection.`,
    );
  });

  test.each([
    [11, 1],
    [25, 15],
  ])("sessionMany cuts %i names at ten and says how many more", (count, more) => {
    const names = Array.from({ length: count }, (_, i) => `d${i + 1}`);
    expect(RUN_DATABASE_SENTENCES.sessionMany(names)).toBe(
      `This InfluxDB 3 server has more than one database (${names.slice(0, 10).join(", ")} and ${more} more), and a connection reads one: set Database on the connection.`,
    );
  });
});

describe("INFLUX_SYSTEM_DATABASES", () => {
  test("is exactly _internal, _monitoring and _tasks", () => {
    expect([...INFLUX_SYSTEM_DATABASES].sort()).toEqual(["_internal", "_monitoring", "_tasks"]);
  });
});

describe("resolveRunDatabase, the order of SPEC 5.8", () => {
  test("step 1: one named database is the run database, over the field and the listing", () => {
    expect(
      resolveRunDatabase({
        ...base,
        namedDatabases: namedIn('SELECT * FROM "home".."h", "home"..x'),
        connection: "other",
        visible: ["third"],
      }),
    ).toEqual({ database: "home", source: "statement" });
  });

  test("step 1: a repeated name counts once", () => {
    expect(resolveRunDatabase({ ...base, namedDatabases: ["home", "home"] })).toEqual({
      database: "home",
      source: "statement",
    });
  });

  test("step 1: more than one named database sends no db, and the server decides", () => {
    expect(
      resolveRunDatabase({
        ...base,
        namedDatabases: namedIn('SELECT * FROM "a".."h", "b"..x'),
        connection: "home",
      }),
    ).toEqual({ database: undefined, source: "server-decides" });
  });

  test("step 1: a SHOW ... ON names its database even though the statement needs one", () => {
    expect(resolveRunDatabase({ ...base, namedDatabases: namedIn('SHOW MEASUREMENTS ON "home"') })).toEqual({
      database: "home",
      source: "statement",
    });
  });

  test("a statement that needs no database is sent with no db, whatever the field says", () => {
    expect(
      resolveRunDatabase({
        ...base,
        namedDatabases: namedIn("SHOW DATABASES"),
        needsDatabase: false,
        connection: "home",
        visible: ["home"],
      }),
    ).toEqual({ database: undefined, source: "not-needed" });
  });

  test("step 2: the connection's database field", () => {
    expect(
      resolveRunDatabase({ ...base, namedDatabases: namedIn("SELECT * FROM h"), connection: "home", visible: ["x"] }),
    ).toEqual({ database: "home", source: "connection" });
  });

  test("step 2: an empty field counts as no field", () => {
    expect(resolveRunDatabase({ ...base, connection: "", visible: ["home"] })).toEqual({
      database: "home",
      source: "only-visible",
    });
  });

  test("step 3: the only database in the visible listing", () => {
    expect(resolveRunDatabase({ ...base, visible: ["home"] })).toEqual({ database: "home", source: "only-visible" });
  });

  test.each([
    ["browse", ["_internal", "home"]],
    ["hide", ["_monitoring", "_tasks", "home"]],
    ["browse", ["_monitoring", "_tasks", "home"]],
    ["hide", ["_internal", "_monitoring", "_tasks", "home"]],
  ] as const)("step 3 on %s: the system databases of %j never count", (internalDatabase, visible) => {
    expect(resolveRunDatabase({ ...base, internalDatabase, visible })).toEqual({
      database: "home",
      source: "only-visible",
    });
  });

  test.each([
    ["two ordinary databases", ["home", "edge"]],
    ["no database", []],
    ["system databases only", ["_internal", "_monitoring", "_tasks"]],
  ])("step 4: %s in the listing and no field is refused", (_, visible) => {
    expect(resolveRunDatabase({ ...base, visible, internalDatabase: "browse" })).toEqual({ refused: CHOOSE });
  });

  test("step 4: a listing never read and no field is refused", () => {
    expect(resolveRunDatabase({ ...base })).toEqual({ refused: CHOOSE });
  });
});

describe("resolveRunDatabase, _internal through every input (E13, R31)", () => {
  const forms: readonly (readonly [string, string])[] = [
    ["ON", "SHOW MEASUREMENTS ON _internal"],
    ["a FROM source", "SELECT * FROM _internal..m"],
    ["a three-segment FROM source", "SELECT * FROM _internal.monitor.runtime"],
    ["a later source of a FROM list", 'SELECT * FROM "home".."h", _internal..m'],
    ["a source inside a subquery", "SELECT * FROM (SELECT * FROM _internal..m)"],
    ["a source inside a subquery at depth two", "SELECT * FROM (SELECT * FROM (SELECT * FROM _internal..m))"],
    ["the WITH MEASUREMENT = source", 'SHOW MEASUREMENTS ON "home" WITH MEASUREMENT = _internal..m'],
    ["the WITH MEASUREMENT =~ source", "SHOW MEASUREMENTS WITH MEASUREMENT =~ _internal../cpu.*/"],
    ["a regex last segment", "SELECT * FROM _internal../cpu/"],
    ["whitespace after each dot (R31)", "SELECT * FROM _internal. rp. m"],
    ["a comment after a dot (R31)", "SELECT * FROM _internal.--c\nrp.m"],
    ["quoted segments with whitespace after each dot (R31)", 'SELECT * FROM "_internal". "rp". "m"'],
  ];

  test.each(forms)("%s: refused on hide", (_, text) => {
    const namedDatabases = namedIn(text);
    expect(namedDatabases).toContain("_internal");
    expect(resolveRunDatabase({ ...base, namedDatabases, connection: "home", visible: ["home"] })).toEqual({
      refused: INTERNAL,
    });
  });

  test.each(forms)("%s: allowed on browse", (_, text) => {
    const namedDatabases = namedIn(text);
    const result = resolveRunDatabase({ ...base, namedDatabases, internalDatabase: "browse" });
    expect(result).not.toHaveProperty("refused");
    if (namedDatabases.length === 1) expect(result).toEqual({ database: "_internal", source: "statement" });
    else expect(result).toEqual({ database: undefined, source: "server-decides" });
  });

  test("a statement naming _internal on hide is refused even when it needs no database", () => {
    expect(resolveRunDatabase({ ...base, namedDatabases: ["_internal"], needsDatabase: false })).toEqual({
      refused: INTERNAL,
    });
  });

  test("the connection field _internal: refused on hide, the run database on browse", () => {
    expect(resolveRunDatabase({ ...base, connection: "_internal" })).toEqual({ refused: INTERNAL });
    expect(resolveRunDatabase({ ...base, connection: "_internal", internalDatabase: "browse" })).toEqual({
      database: "_internal",
      source: "connection",
    });
  });

  test("the only-visible rule never yields _internal, on either value", () => {
    expect(resolveRunDatabase({ ...base, visible: ["_internal"] })).toEqual({ refused: CHOOSE });
    expect(resolveRunDatabase({ ...base, visible: ["_internal"], internalDatabase: "browse" })).toEqual({
      refused: CHOOSE,
    });
  });

  test("_monitoring and _tasks named in a statement are ordinary run databases", () => {
    expect(resolveRunDatabase({ ...base, namedDatabases: namedIn("SELECT * FROM _monitoring..m") })).toEqual({
      database: "_monitoring",
      source: "statement",
    });
  });
});

describe("resolveSessionDatabase, the order of SPEC 5.8 for influxdb3", () => {
  const session = {
    connection: undefined as string | undefined,
    visible: undefined as readonly string[] | undefined,
    internalDatabase: "hide" as "browse" | "hide",
  };

  test("step 1: the connection's database field, over the listing", () => {
    expect(resolveSessionDatabase({ ...session, connection: "home", visible: ["a", "b"] })).toEqual({
      database: "home",
      source: "connection",
    });
  });

  test("step 1: the field when the listing was refused (the provider then checks it)", () => {
    expect(resolveSessionDatabase({ ...session, connection: "home" })).toEqual({
      database: "home",
      source: "connection",
    });
  });

  test("step 2: the only non-system database listed, _internal removed", () => {
    expect(resolveSessionDatabase({ ...session, visible: ["_internal", "home"] })).toEqual({
      database: "home",
      source: "only-visible",
    });
    expect(resolveSessionDatabase({ ...session, connection: "", visible: ["home"] })).toEqual({
      database: "home",
      source: "only-visible",
    });
  });

  test("step 2 on browse still removes _internal", () => {
    expect(resolveSessionDatabase({ ...session, visible: ["_internal", "home"], internalDatabase: "browse" })).toEqual({
      database: "home",
      source: "only-visible",
    });
  });

  test("more than one listed: the names, _internal not among them", () => {
    expect(resolveSessionDatabase({ ...session, visible: ["home", "_internal", "edge"] })).toEqual({
      refused:
        "This InfluxDB 3 server has more than one database (home, edge), and a connection reads one: set Database on the connection.",
    });
  });

  test("more than one listed: eleven names are cut at ten", () => {
    const names = Array.from({ length: 11 }, (_, i) => `d${i + 1}`);
    expect(resolveSessionDatabase({ ...session, visible: names })).toEqual({
      refused: RUN_DATABASE_SENTENCES.sessionMany(names),
    });
  });

  test.each([
    ["nothing", []],
    ["only _internal", ["_internal"]],
  ])("none listed (%s)", (_, visible) => {
    expect(resolveSessionDatabase({ ...session, visible })).toEqual({ refused: RUN_DATABASE_SENTENCES.sessionNone });
  });

  test("the listing refused and Database empty", () => {
    expect(resolveSessionDatabase({ ...session })).toEqual({ refused: RUN_DATABASE_SENTENCES.listingRefused });
    expect(resolveSessionDatabase({ ...session, connection: "" })).toEqual({
      refused: RUN_DATABASE_SENTENCES.listingRefused,
    });
  });

  test("the connection field _internal: refused on hide, accepted on browse", () => {
    expect(resolveSessionDatabase({ ...session, connection: "_internal", visible: ["home"] })).toEqual({
      refused: INTERNAL,
    });
    expect(resolveSessionDatabase({ ...session, connection: "_internal", internalDatabase: "browse" })).toEqual({
      database: "_internal",
      source: "connection",
    });
  });
});

const INFLUXDB: DatabaseConnection = {
  id: "influxdb-doc",
  name: "InfluxDB",
  type: "influxdb",
  host: "127.0.0.1",
  port: INFLUXDB_DEFAULT_PORT,
  createdAt: new Date(0),
};
/** A client that answers the connect sequence of a 1.x server and records every request it is handed. */
function scriptedClient(): { readonly factory: InfluxClientFactory; readonly requests: InfluxRequest<string>[] } {
  const requests: InfluxRequest<string>[] = [];
  const answer = (status: number, text: string): InfluxAnswer => ({ status, contentType: "application/json", text });
  const client = {
    send: async (request: InfluxRequest<string>): Promise<InfluxAnswer> => {
      requests.push(request);
      if (request.route === "ping") return answer(204, "");
      if (request.route === "health") return answer(200, '{"version":"1.13.1"}');
      if (request.values.q === "SHOW DATABASES" && requests.length === 3) {
        return answer(
          200,
          '{"results":[{"statement_id":0,"series":[{"name":"databases","columns":["name"],"values":[["home"],["edge"]]}]}]}',
        );
      }
      return answer(200, '{"results":[{"statement_id":0}]}');
    },
    close: () => {},
  };
  return { factory: (() => client) as unknown as InfluxClientFactory, requests };
}

describe("the database a statement is sent with", () => {
  test("a statement that is not server-wide is sent with the connection's database", async () => {
    const { factory, requests } = scriptedClient();
    const connected = new InfluxDBProvider(
      { ...INFLUXDB, database: "home" },
      {},
      { egress: ALLOWS_PRIVATE_HOSTS },
      factory,
    );
    await connected.connect();
    await connected.query("SHOW MEASUREMENTS");
    const sent = requests[requests.length - 1].values;
    expect(sent.db).toBe("home");
    await connected.disconnect();
  });

  test("every SHOW form of the grammar is sent with its own text", async () => {
    // Every SHOW statement of the influxql v1.4.1 parser.
    const grammar: Readonly<Record<string, string>> = {
      "SHOW CONTINUOUS QUERIES": "SHOW CONTINUOUS QUERIES",
      "SHOW DATABASES": "SHOW DATABASES",
      "SHOW DIAGNOSTICS": "SHOW DIAGNOSTICS",
      "SHOW FIELD KEY CARDINALITY": "SHOW FIELD KEY CARDINALITY",
      "SHOW FIELD KEY EXACT CARDINALITY": "SHOW FIELD KEY EXACT CARDINALITY",
      "SHOW FIELD KEYS": "SHOW FIELD KEYS",
      "SHOW GRANTS FOR": 'SHOW GRANTS FOR "reader"',
      "SHOW MEASUREMENT CARDINALITY": "SHOW MEASUREMENT CARDINALITY",
      "SHOW MEASUREMENT EXACT CARDINALITY": "SHOW MEASUREMENT EXACT CARDINALITY",
      "SHOW MEASUREMENTS": "SHOW MEASUREMENTS",
      "SHOW QUERIES": "SHOW QUERIES",
      "SHOW RETENTION POLICIES": "SHOW RETENTION POLICIES",
      "SHOW SERIES": "SHOW SERIES",
      "SHOW SERIES CARDINALITY": "SHOW SERIES CARDINALITY",
      "SHOW SERIES EXACT CARDINALITY": "SHOW SERIES EXACT CARDINALITY",
      "SHOW SHARD GROUPS": "SHOW SHARD GROUPS",
      "SHOW SHARDS": "SHOW SHARDS",
      "SHOW STATS": "SHOW STATS",
      "SHOW SUBSCRIPTIONS": "SHOW SUBSCRIPTIONS",
      "SHOW TAG KEY CARDINALITY": "SHOW TAG KEY CARDINALITY",
      "SHOW TAG KEY EXACT CARDINALITY": "SHOW TAG KEY EXACT CARDINALITY",
      "SHOW TAG KEYS": "SHOW TAG KEYS",
      "SHOW TAG VALUES": 'SHOW TAG VALUES WITH KEY = "room"',
      "SHOW TAG VALUES CARDINALITY": 'SHOW TAG VALUES CARDINALITY WITH KEY = "room"',
      "SHOW USERS": "SHOW USERS",
    };
    const { factory, requests } = scriptedClient();
    const connected = new InfluxDBProvider(
      { ...INFLUXDB, database: "home" },
      {},
      { egress: ALLOWS_PRIVATE_HOSTS },
      factory,
    );
    await connected.connect();

    for (const text of Object.values(grammar)) {
      // oxlint-disable-next-line no-await-in-loop -- each run's request is read as the last one recorded.
      await connected.query(text);
      const sent = requests[requests.length - 1].values;
      expect(sent.q).toBe(text);
    }
    await connected.disconnect();
  });
});

describe("the session database sentence", () => {
  test("more than ten session databases are listed as ten and a count of the rest", () => {
    // Up to ten names, then "and N more".
    const twelve = Array.from({ length: 12 }, (_, at) => `db${at + 1}`);
    expect(RUN_DATABASE_SENTENCES.sessionMany(twelve)).toContain("db10 and 2 more");
  });
});
