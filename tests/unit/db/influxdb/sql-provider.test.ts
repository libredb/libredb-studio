/**
 * The `influxdb3` provider (InfluxDB spec 5.2, 5.5, 5.6, 5.8, 6.2, 6.3, 6.6, 7; E11, E16, E17; K17): composition only,
 * driven through the real route-table client and a recording transport handed in by the constructor's client
 * factory, so every request the provider would put on the wire is seen and answered from a capture or from an answer
 * built here in the shape the captures show. `mock.module()` is not used.
 *
 * Built rather than captured: the database listings other than the seed's (the seed creates `home`, `edge` and
 * `bench`, R1), the table listing (the iox rows of `sql-tables`, which was read with no `WHERE`), the 403 of
 * `configure/database`, the 32 MiB body, the 10,001-row body and the 2,001-table listing.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { callerBoundTruncationReason } from "@/lib/db/object-kinds";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  DatabaseError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { type NodeTransport, type NodeTransportOptions, TransportError } from "@/lib/db/http/node-transport";
import { createInfluxClient, type InfluxClientFactory } from "@/lib/db/providers/timeseries/influxdb/client";
import {
  INFLUX_CONNECTION_SENTENCES,
  INFLUX_LIMITER_OPTIONS,
  INFLUX_LIST_CAP,
  INFLUX_ROW_CUT,
} from "@/lib/db/providers/timeseries/influxdb/connection-options";
import { INFLUX_ERROR_SENTENCES } from "@/lib/db/providers/timeseries/influxdb/errors";
import { INFLUXDB3_LABELS } from "@/lib/db/providers/timeseries/influxdb/labels";
import { toInfluxHealth } from "@/lib/db/providers/timeseries/influxdb/monitoring";
import { RUN_DATABASE_SENTENCES } from "@/lib/db/providers/timeseries/influxdb/run-database";
import { INFLUXDB3_OBJECT_KINDS, influxdb3PathRefusal } from "@/lib/db/providers/timeseries/influxdb/sql-objects";
import {
  evaluateInfluxSql,
  INFLUX_SQL_MAX_TEXT_BYTES,
  INFLUX_SQL_POLICY_SENTENCES,
} from "@/lib/db/providers/timeseries/influxdb/sql-policy";
import { InfluxDB3Provider } from "@/lib/db/providers/timeseries/influxdb/sql-provider";
import {
  type DatabaseConnection,
  offersColumnProfiling,
  offersCountQuery,
  offersSchemaDiagram,
  offersSqlExport,
  type ProviderOptions,
} from "@/lib/db/types";
import { DuplicateRunError } from "@/lib/db/utils/bounded-limiter";
import {
  generateCountQuery,
  generateSelectQuery,
  generateTableQuery,
  quoteIdentifier,
  quoteObjectPath,
} from "@/lib/query-generators";
import type { ColumnSchema } from "@/lib/types";
import { type InfluxCapture, type InfluxFixtureVersion, loadInfluxCapture } from "../../../helpers/influxdb-fixtures";
import {
  type RecordedInfluxRequest,
  recordingInfluxTransport,
  type ScriptedAnswer,
} from "../../../helpers/influxdb-transport";

const CONNECTION: DatabaseConnection = {
  id: "influxdb3-unit",
  name: "InfluxDB 3",
  type: "influxdb3",
  host: "127.0.0.1",
  port: 8181,
  password: "token-secret",
  database: "home",
  createdAt: new Date(0),
};

const S = INFLUX_ERROR_SENTENCES as unknown as Record<string, string & ((...parts: string[]) => string)>;

const capture = (version: InfluxFixtureVersion, name: string): InfluxCapture => loadInfluxCapture(version, name);
const v3 = (name: string): InfluxCapture => capture("3.12.0-core", name);

/** An answer built here in the shape the captures show, for what no capture holds. */
function built(status: number, body: string, contentType: string | null = "application/json"): InfluxCapture {
  return {
    version: "3.12.0-core",
    name: "built",
    image: "built",
    capturedAt: "built",
    request: { method: "POST", path: "/api/v3/query_sql", query: {}, auth: "bearer" },
    status,
    contentType,
    body,
  };
}

/** A `configure/database?format=json` answer listing these databases, in the capture's shape. */
const databases = (...names: string[]): InfluxCapture =>
  built(200, JSON.stringify(names.map((name) => ({ "iox::database": name }))));

/** A jsonl answer of these rows. */
const jsonl = (rows: readonly Record<string, unknown>[]): InfluxCapture =>
  built(200, rows.map((row) => `${JSON.stringify(row)}\n`).join(""), "application/jsonl");

/** The table listing the `WHERE table_schema = 'iox'` read answers: the iox rows of `sql-tables`. */
const IOX_TABLES = ["edge", "edge cases,m", "home", "numbers", "sparse", 'we"ird name;x'];
const TABLE_LISTING = jsonl(IOX_TABLES.map((table_name) => ({ table_name })));

/** The preview of spec 6.6, exactly. */
const PREVIEW =
  "-- Newest rows of the last hour. No row means no row is newer: widen INTERVAL '1 hour' below.\n" +
  'SELECT * FROM "home" WHERE "time" >= now() - INTERVAL \'1 hour\' ORDER BY "time" DESC';

/** What `/ping` and `configure/database` answer on the seeded 3.12.0 server. */
const CONNECT: readonly InfluxCapture[] = [v3("ping-auth"), v3("sql-databases")];

interface Harness {
  readonly provider: InfluxDB3Provider;
  readonly requests: RecordedInfluxRequest[];
  readonly closed: () => number;
  readonly built: () => number;
}

/** A provider over the real client and a recording transport whose `close` and creations are counted. */
function harness(
  script: readonly ScriptedAnswer[],
  config: Partial<DatabaseConnection> = {},
  options: ProviderOptions = {},
  wrap: (transport: NodeTransport) => NodeTransport = (transport) => transport,
): Harness {
  const wire = recordingInfluxTransport(script);
  let closed = 0;
  let made = 0;
  const transport = (transportOptions: NodeTransportOptions): NodeTransport => {
    made += 1;
    const inner = wrap(wire.factory(transportOptions));
    return {
      request: (request) => inner.request(request),
      close() {
        closed += 1;
        inner.close();
      },
    };
  };
  const factory: InfluxClientFactory = (clientOptions, routes) => createInfluxClient(clientOptions, routes, transport);
  return {
    provider: new InfluxDB3Provider({ ...CONNECTION, ...config }, options, factory),
    requests: wire.requests,
    closed: () => closed,
    built: () => made,
  };
}

const providers: InfluxDB3Provider[] = [];

/** A provider connected to the seeded server with Database `home`, `rest` answering what follows the connect. */
async function connected(
  rest: readonly ScriptedAnswer[] = [],
  config: Partial<DatabaseConnection> = {},
  options: ProviderOptions = {},
  wrap?: (transport: NodeTransport) => NodeTransport,
): Promise<Harness> {
  const made = harness([...CONNECT, ...rest], config, options, wrap);
  await made.provider.connect();
  providers.push(made.provider);
  return made;
}

afterEach(async () => {
  // oxlint-disable-next-line no-await-in-loop -- each provider closes its own client, one after another.
  for (const provider of providers.splice(0)) await provider.disconnect();
});

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

const path = (request: RecordedInfluxRequest): string => new URL(request.url).pathname;
const sent = (request: RecordedInfluxRequest): Record<string, string> => JSON.parse(request.body as string);

/**
 * A transport that answers the first requests from the recording one and then holds every request until its signal
 * aborts, failing as the shared transport fails an aborted request.
 */
function hangingAfter(
  answered: number,
): ((transport: NodeTransport) => NodeTransport) & { readonly held: () => number } {
  let seen = 0;
  const wrap = (transport: NodeTransport): NodeTransport => ({
    request(request) {
      seen += 1;
      if (seen <= answered) return transport.request(request);
      return new Promise((_, reject) => {
        request.signal.addEventListener(
          "abort",
          () => {
            const reason: unknown = request.signal.reason;
            reject(
              reason instanceof DOMException && reason.name === "TimeoutError"
                ? new TransportError("timeout", "The request did not finish within its time limit")
                : new TransportError("aborted", "The request was cancelled"),
            );
          },
          { once: true },
        );
      });
    },
    close: () => transport.close(),
  });
  return Object.assign(wrap, { held: () => Math.max(seen - answered, 0) });
}

describe("declarations (spec 6.3)", () => {
  test("every capability field is written out, and the absent ones are absent", () => {
    const capabilities = harness([]).provider.getCapabilities();
    expect(capabilities).toEqual({
      queryLanguage: "sql",
      supportsExplain: false,
      supportsExternalQueryLimiting: true,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsResultPagination: true,
      supportsTransactions: false,
      declaresForeignKeys: false,
      tablesAreDerivedGroupings: false,
      enforcesReadOnly: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: 8181,
      identifierQuoting: "double-always",
      statementTerminator: "none",
      previewTimeWindow: {
        column: "time",
        since: "now() - INTERVAL '1 hour'",
        note: "Newest rows of the last hour. No row means no row is newer: widen INTERVAL '1 hour' below.",
        examples: [
          "A wider window: WHERE \"time\" >= now() - INTERVAL '1 day'",
          "One row per minute: SELECT date_bin(INTERVAL '1 minute', \"time\") AS minute, avg({column}) FROM {table} WHERE \"time\" >= now() - INTERVAL '1 hour' GROUP BY 1 ORDER BY 1",
          "Timestamps are UTC with no zone suffix; time AT TIME ZONE 'UTC' shows a Z.",
        ],
      },
      objectKinds: INFLUXDB3_OBJECT_KINDS,
      schemaRefreshPattern: "(?!)",
    });
    for (const absent of [
      "queryDialect",
      "explainFormat",
      "singleWriterFile",
      "maintenanceOperationSpecs",
      "previewProjection",
      "containerLevels",
      "containerPathShapes",
      "containerAddressing",
      "keyScan",
    ]) {
      expect(Object.hasOwn(capabilities, absent)).toBe(false);
    }
  });

  test("the shared readers: Count, Profile, SQL export and the diagram are offered (R9, R25)", () => {
    const capabilities = harness([]).provider.getCapabilities();
    expect(offersCountQuery(capabilities)).toBe(true);
    expect(offersColumnProfiling(capabilities)).toBe(true);
    expect(offersSqlExport(capabilities)).toBe(true);
    expect(offersSchemaDiagram(capabilities)).toBe(true);
  });

  test("spec 6.6: the declaration writes the preview and the Generate Query text exactly, with no LIMIT", () => {
    const capabilities = harness([]).provider.getCapabilities();
    const columns: ColumnSchema[] = [
      { name: "time", type: "time", nullable: false, isPrimary: false },
      { name: "room", type: "tag", nullable: true, isPrimary: false },
      { name: "temp", type: "float", nullable: true, isPrimary: false },
    ];
    expect(generateTableQuery(["home"], capabilities)).toBe(PREVIEW);
    expect(generateSelectQuery(["home"], columns, capabilities)).toBe(
      `${PREVIEW}\n` +
        "-- A wider window: WHERE \"time\" >= now() - INTERVAL '1 day'\n" +
        '-- One row per minute: SELECT date_bin(INTERVAL \'1 minute\', "time") AS minute, avg("temp") FROM "home" WHERE "time" >= now() - INTERVAL \'1 hour\' GROUP BY 1 ORDER BY 1\n' +
        "-- Timestamps are UTC with no zone suffix; time AT TIME ZONE 'UTC' shows a Z.",
    );
    // The text the sql-preview-home capture ran is this preview with the limiter's LIMIT 50 appended.
    expect(v3("sql-preview-home").request.body).toMatchObject({ q: `${PREVIEW} LIMIT 50` });
    expect(evaluateInfluxSql(PREVIEW).allowed).toBe(true);
  });

  test("R41: double-always quotes every name, so the Count of a$b passes the policy", () => {
    const capabilities = harness([]).provider.getCapabilities();
    expect(quoteIdentifier("time", capabilities)).toBe('"time"');
    expect(quoteObjectPath(["home"], capabilities)).toBe('"home"');
    const count = generateCountQuery(["a$b"], capabilities) as string;
    expect(count).toBe('SELECT COUNT(*) AS row_count\nFROM "a$b"');
    expect(evaluateInfluxSql(count).allowed).toBe(true);
    expect(evaluateInfluxSql(generateTableQuery(['we"ird name;x'], capabilities)).allowed).toBe(true);
  });

  test("the labels are the InfluxDB 3 labels, as a copy", () => {
    const { provider } = harness([]);
    expect(provider.getLabels()).toEqual(INFLUXDB3_LABELS);
    expect(provider.getLabels()).not.toBe(INFLUXDB3_LABELS);
  });

  test("K17: prepareQuery appends LIMIT and OFFSET after ORDER BY ... DESC and keeps the leading comment", () => {
    const { provider } = harness([]);
    expect(provider.prepareQuery(PREVIEW, { limit: 50, offset: 50 })).toEqual({
      query: `${PREVIEW} LIMIT 50 OFFSET 50`,
      wasLimited: true,
      limit: 50,
      offset: 50,
    });
    expect(provider.prepareQuery(PREVIEW, { limit: 50 }).query).toBe(`${PREVIEW} LIMIT 50`);
    expect(evaluateInfluxSql(`${PREVIEW} LIMIT 50 OFFSET 50`).allowed).toBe(true);
  });

  test("validate refuses an empty Host by name, and accepts a host", () => {
    expect(() => harness([], { host: "" }).provider.validate()).toThrow(
      new DatabaseConfigError("An InfluxDB 3 connection needs a host.", "influxdb3"),
    );
    expect(() => harness([]).provider.validate()).not.toThrow();
  });
});

describe("connect (spec 6.2, 5.8)", () => {
  test("a JSON /ping decides alone, then the listing; Database is used as written, under the Bearer header", async () => {
    const { provider, requests } = await connected([TABLE_LISTING]);
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET http://127.0.0.1:8181/ping",
      "GET http://127.0.0.1:8181/api/v3/configure/database?format=json",
    ]);
    expect(requests[0].headers).toEqual({ authorization: "Bearer token-secret" });
    expect(provider.isConnected()).toBe(true);
    expect((await provider.getOverview()).version).toStartWith("InfluxDB 3 Core 3.12.0, database home");
  });

  test("the only ordinary database, _internal left out, is the session database and every read's db", async () => {
    const made = harness([v3("ping-auth"), databases("_internal", "home"), jsonl([{ x: 1 }])], { database: "" });
    providers.push(made.provider);
    await made.provider.connect();
    await made.provider.query("SELECT 1 AS x");
    expect(sent(made.requests[2])).toEqual({ db: "home", q: "SELECT 1 AS x", format: "jsonl" });
  });

  test("more than one database and Database empty: refused naming them, and the client is closed", async () => {
    const seeded = harness(CONNECT, { database: "" });
    const error = await rejection(seeded.provider.connect());
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(RUN_DATABASE_SENTENCES.sessionMany(["bench", "edge", "home"]));
    expect(seeded.closed()).toBe(1);
    expect(seeded.provider.isConnected()).toBe(false);

    // Gate 2's held case: a server holding twelve names ten and the rest as a count (R1).
    const twelve = Array.from({ length: 12 }, (_, index) => `db${String(index).padStart(2, "0")}`);
    const many = harness([v3("ping-auth"), databases("_internal", ...twelve)], { database: "" });
    const refused = await rejection(many.provider.connect());
    expect(refused.message).toBe(RUN_DATABASE_SENTENCES.sessionMany(twelve));
    expect(refused.message).toContain("db09 and 2 more");
  });

  test("no ordinary database listed and Database empty: the none sentence", async () => {
    const made = harness([v3("ping-auth"), databases("_internal")], { database: "" });
    const error = await rejection(made.provider.connect());
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(RUN_DATABASE_SENTENCES.sessionNone);
  });

  test("_internal as Database is refused, and nothing is read from it", async () => {
    const made = harness(CONNECT, { database: "_internal" });
    const error = await rejection(made.provider.connect());
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(RUN_DATABASE_SENTENCES.internalHidden);
    expect(made.requests.map(path)).toEqual(["/ping", "/api/v3/configure/database"]);
  });

  test.each([
    ["1.13.1", "InfluxDB 1.13.1"],
    ["2.9.1", "InfluxDB 2.9.1"],
  ] as const)("a %s server is refused from /ping and /health, before any /api/v3 call", async (version, name) => {
    const made = harness([capture(version, "ping-auth"), capture(version, "health-auth")]);
    const error = await rejection(made.provider.connect());
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe(S.noSqlOnVersion(name));
    expect(made.requests.map(path)).toEqual(["/ping", "/health"]);
    expect(made.closed()).toBe(1);
  });

  // The unknown row of GENERATION_TRAITS fails closed (servesSql false), so a version no line claims is refused too.
  test.each([
    ["0.13.0", "InfluxDB 0.13.0"],
    ["4.0.0", "InfluxDB 4.0.0"],
  ] as const)("a reported %s, an unknown generation, is refused from /ping and /health", async (version, name) => {
    const made = harness([
      capture("1.13.1", "ping-auth"),
      built(200, JSON.stringify({ name: "influxdb", status: "pass", checks: [], version })),
    ]);
    const error = await rejection(made.provider.connect());
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe(S.noSqlOnVersion(name));
    expect(made.requests.map(path)).toEqual(["/ping", "/health"]);
    expect(made.closed()).toBe(1);
  });

  test("a server whose /health names no version is read by the listing: 2.9.1's HTML page is the mis-pick", async () => {
    const made = harness([
      capture("2.9.1", "ping-auth"),
      built(401, '{"code":"unauthorized","message":"unauthorized access"}'),
      capture("2.9.1", "mispick-configure-database"),
    ]);
    const error = await rejection(made.provider.connect());
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe(S.notSqlContentType("127.0.0.1:8181", "text/html; charset=utf-8"));
  });

  test("a 404 from configure/database is the Cloud sentence", async () => {
    const made = harness([v3("ping-auth"), capture("1.13.1", "mispick-configure-database")]);
    const error = await rejection(made.provider.connect());
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe(S.noSqlEndpoint);
  });

  test("a /ping 403 is a resource token: refused with Database empty, after one request", async () => {
    const made = harness([v3("ping-forbidden-synthetic")], { database: "" });
    const error = await rejection(made.provider.connect());
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(S.pingForbiddenNoDatabase);
    expect(made.requests).toHaveLength(1);
    expect(made.closed()).toBe(1);
  });

  test("a /ping 403 with Database set continues as InfluxDB 3, version not reported, and checks Database", async () => {
    const forbidden = built(403, "", null);
    const made = harness([v3("ping-forbidden-synthetic"), forbidden, v3("sql-keyword-select"), TABLE_LISTING]);
    providers.push(made.provider);
    await made.provider.connect();
    expect(made.requests.map(path)).toEqual(["/ping", "/api/v3/configure/database", "/api/v3/query_sql"]);
    expect(sent(made.requests[2])).toEqual({ db: "home", q: "SELECT 1", format: "jsonl" });
    expect((await made.provider.getOverview()).version).toBe("InfluxDB 3, version not reported, database home");
  });

  test("a configure/database 403 with Database empty is the listing-refused sentence", async () => {
    const made = harness([v3("ping-auth"), built(403, "", null)], { database: "" });
    const error = await rejection(made.provider.connect());
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(RUN_DATABASE_SENTENCES.listingRefused);
  });

  test("the SELECT 1 check fails the connect when Database is missing or not readable", async () => {
    const missing = harness([v3("ping-auth"), built(403, "", null), v3("sql-db-not-found")]);
    const notFound = await rejection(missing.provider.connect());
    expect(notFound).toBeInstanceOf(QueryError);
    expect(notFound.message).toBe(S.sqlDatabaseNotFound("home"));
    expect(missing.closed()).toBe(1);

    const forbidden = harness([v3("ping-auth"), built(403, "", null), built(403, "", null)]);
    const refused = await rejection(forbidden.provider.connect());
    expect(refused).toBeInstanceOf(AuthenticationError);
    expect(refused.message).toBe(S.sqlTokenMayNotRead("home"));

    const html = harness([
      v3("ping-auth"),
      built(403, "", null),
      { ...capture("2.9.1", "mispick-query-sql"), name: "built" },
    ]);
    expect((await rejection(html.provider.connect())).message).toBe(
      S.notSqlContentType("127.0.0.1:8181", "text/html; charset=utf-8"),
    );
  });

  test("a configure/database failure that is not a 403 fails the connect, worded by the error table", async () => {
    const made = harness([v3("ping-auth"), built(500, "boom", "text/plain")]);
    const error = await rejection(made.provider.connect());
    // errors.ts reads a 500 with a text body on an /api/v3 route as the server's refusal, at every phase (I9).
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(S.sqlRefused("boom"));
    expect(made.closed()).toBe(1);
  });

  test("a /ping 401 is the InfluxDB 3 token sentence, and the client is closed", async () => {
    const made = harness([v3("ping-anon")]);
    const error = await rejection(made.provider.connect());
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toBe(S.token3Refused);
    expect(made.closed()).toBe(1);
  });

  test("a /ping 404 is the not-InfluxDB sentence", async () => {
    const made = harness([built(404, "404 page not found\n", "text/plain")]);
    const error = await rejection(made.provider.connect());
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe(S.noPing("127.0.0.1:8181"));
  });

  test("a connection refused by its options sends nothing and builds no client", async () => {
    const made = harness([], { user: "admin" });
    const error = await rejection(made.provider.connect());
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(INFLUX_CONNECTION_SENTENCES.influxdb3User);
    expect(made.requests).toHaveLength(0);
    expect(made.built()).toBe(0);
    const empty = harness([], { host: "" });
    expect((await rejection(empty.provider.connect())).message).toBe("An InfluxDB 3 connection needs a host.");
  });

  test("a second connect closes the client of the first", async () => {
    const made = harness([...CONNECT, ...CONNECT, jsonl([{ x: 1 }])]);
    providers.push(made.provider);
    await made.provider.connect();
    await made.provider.connect();
    expect(made.closed()).toBe(1);
    expect((await made.provider.query("SELECT 1 AS x")).rows).toEqual([{ x: 1 }]);
  });

  test("disconnect closes the client, and a call after it is refused as not connected", async () => {
    const made = await connected();
    await made.provider.disconnect();
    expect(made.closed()).toBe(1);
    expect(made.provider.isConnected()).toBe(false);
    await expect(made.provider.query("SELECT 1")).rejects.toThrow();
    await expect(made.provider.listObjects([], "table")).rejects.toThrow();
    // A second disconnect has nothing to close.
    await made.provider.disconnect();
    expect(made.closed()).toBe(1);
  });
});

describe("the query pipeline (spec 5.2)", () => {
  test("the session database is sent as db, in a JSON body of exactly db, q and format, with no URL query", async () => {
    const preview = v3("sql-preview-home");
    const q = `${PREVIEW} LIMIT 50`;
    const { provider, requests } = await connected([preview]);
    const result = await provider.query(q);
    const request = requests.at(-1) as RecordedInfluxRequest;
    expect(`${request.method} ${request.url}`).toBe("POST http://127.0.0.1:8181/api/v3/query_sql");
    expect(request.body).toBe(JSON.stringify({ db: "home", q, format: "jsonl" }));
    expect(result.fields).toEqual(["co", "hum", "room", "temp", "time"]);
    expect(result.rows).toEqual([{ co: 26, hum: 36.4, room: "Kitchen", temp: 22.2, time: "2026-10-04T01:50:41" }]);
    expect(result.rowCount).toBe(1);
    expect(result.executionTime).toBeGreaterThanOrEqual(0);
    expect(Object.hasOwn(result, "pagination")).toBe(false);
    expect(Object.hasOwn(result, "warnings")).toBe(false);
  });

  test.each([
    "sql-keyword-select",
    "sql-keyword-with",
    "sql-keyword-values",
    "sql-keyword-show-tables",
    "sql-keyword-explain",
    "sql-keyword-describe",
  ])("E17: %s, captured on 3.12.0, is allowed and its answer is a grid", async (name) => {
    const keyword = v3(name);
    const q = (keyword.request.body as { q: string }).q;
    expect(evaluateInfluxSql(q).allowed).toBe(true);
    const { provider, requests } = await connected([keyword]);
    const result = await provider.query(q);
    expect(sent(requests.at(-1) as RecordedInfluxRequest)).toEqual({ db: "home", q, format: "jsonl" });
    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rowCount).toBe(result.rows.length);
  });

  test("an empty result has no rows and no columns (the I9 known limit)", async () => {
    const empty = v3("sql-empty");
    const { provider } = await connected([empty]);
    const result = await provider.query((empty.request.body as { q: string }).q);
    expect(result.rows).toEqual([]);
    expect(result.fields).toEqual([]);
  });

  test("bound parameters are refused before any request, and an empty list binds nothing", async () => {
    const { provider, requests } = await connected([jsonl([{ x: 1 }])]);
    const error = await rejection(provider.query("SELECT 1", [1]));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe("Studio does not send bound parameters; write the value in the statement.");
    expect(requests).toHaveLength(2);
    expect((await provider.query("SELECT 1 AS x", [])).rows).toEqual([{ x: 1 }]);
  });

  test("the policy's refusals send nothing: a write, two statements, a bare $, and a text over 1 MiB", async () => {
    const { provider, requests } = await connected();
    const over = `SELECT 1 -- ${"x".repeat(INFLUX_SQL_MAX_TEXT_BYTES)}`;
    for (const text of ["DROP TABLE home", "SELECT 1; SELECT 2", "SELECT $1", "", over]) {
      // oxlint-disable-next-line no-await-in-loop -- each refusal is checked in turn.
      const error = await rejection(provider.query(text));
      expect(error).toBeInstanceOf(QueryError);
      expect(error.message).toBe((evaluateInfluxSql(text) as { message: string }).message);
    }
    expect((await rejection(provider.query(over))).message).toBe(
      INFLUX_SQL_POLICY_SENTENCES.tooLong(new TextEncoder().encode(over).length),
    );
    expect(requests).toHaveLength(2);
  });

  test.each(["sql-truncated", "sql-truncated-mid-line", "sql-truncated-zero"])(
    "E11: %s is the truncation sentence, never rows",
    async (name) => {
      const cut = v3(name);
      const { provider } = await connected([cut]);
      const error = await rejection(provider.query((cut.request.body as { q: string }).q));
      expect(error).toBeInstanceOf(QueryError);
      expect(error.message).toBe(S.truncated);
    },
  );

  test("the error captures are worded by the error table, never shown as rows", async () => {
    const cases: readonly [string, string][] = [
      ["sql-parse-error", S.sqlParse('SQL error: ParserError("Expected: an expression, found: EOF")')],
      ["sql-cross-database", S.crossDatabase("edge.iox.numbers", "home")],
      [
        "sql-not-implemented",
        S.sqlNotImplemented("This feature is not implemented: Unsupported SQL statement: SHOW DATABASES"),
      ],
      ["filelimit-sql", S.fileLimit],
    ];
    for (const [name, message] of cases) {
      const answer = v3(name);
      // oxlint-disable-next-line no-await-in-loop -- each capture is replayed on its own provider.
      const { provider } = await connected([answer]);
      // oxlint-disable-next-line no-await-in-loop -- as above.
      const error = await rejection(provider.query((answer.request.body as { q: string }).q));
      expect(error).toBeInstanceOf(QueryError);
      expect(error.message).toBe(message);
    }
  });

  test("a 200 that is not JSON is the mis-pick sentence, never parsed as rows", async () => {
    const { provider } = await connected([{ ...capture("2.9.1", "mispick-query-sql"), name: "built" }]);
    const error = await rejection(provider.query("SELECT 1"));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(S.notSqlContentType("127.0.0.1:8181", "text/html; charset=utf-8"));
  });

  test("a line that is not a JSON object is the unreadable-row sentence", async () => {
    const { provider } = await connected([built(200, "[1]\n", "application/jsonl")]);
    expect((await rejection(provider.query("SELECT 1"))).message).toBe(S.notReadableRow);
  });

  test("E16: an answer over the 32 MiB cap is the cap sentence", async () => {
    const { provider } = await connected([built(200, "x".repeat(32 * 1024 * 1024 + 1), "application/jsonl")]);
    expect((await rejection(provider.query("SELECT 1"))).message).toBe(S.tooLarge("32 MiB"));
  });

  test("E16: the row cut is reported on pagination.wasLimited", async () => {
    const rows = Array.from({ length: INFLUX_ROW_CUT + 1 }, (_, index) => ({ v: index }));
    const { provider } = await connected([jsonl(rows)]);
    const result = await provider.query("SELECT v FROM t");
    expect(result.rows).toHaveLength(INFLUX_ROW_CUT);
    expect(result.rowCount).toBe(INFLUX_ROW_CUT);
    expect(result.pagination).toEqual({
      limit: INFLUX_ROW_CUT,
      offset: 0,
      hasMore: false,
      totalReturned: INFLUX_ROW_CUT,
      wasLimited: true,
    });
  });

  test("cancelQuery aborts a running run, which is QueryCancelledError; an unknown id answers false", async () => {
    const { provider } = await connected([], {}, {}, hangingAfter(2));
    const running = rejection(provider.query("SELECT 1", undefined, "q3-cancel"));
    await Bun.sleep(5);
    expect(await provider.cancelQuery("q3-cancel")).toBe(true);
    const error = await running;
    expect(error).toBeInstanceOf(QueryCancelledError);
    expect(error.message).toBe(S.cancelled);
    expect(await provider.cancelQuery("q3-cancel")).toBe(false);
    expect(await provider.cancelQuery("q3-unknown")).toBe(false);
  });

  test("a queryId already running is refused, and nothing more is sent", async () => {
    const hanging = hangingAfter(2);
    const { provider } = await connected([], {}, {}, hanging);
    const first = rejection(provider.query("SELECT 1", undefined, "q3-dup"));
    await Bun.sleep(5);
    expect(hanging.held()).toBe(1);
    expect(await rejection(provider.query("SELECT 1", undefined, "q3-dup"))).toBeInstanceOf(DuplicateRunError);
    expect(hanging.held()).toBe(1);
    await provider.cancelQuery("q3-dup");
    await first;
  });

  test("E16: the deadline is the connection's query timeout, on the transport signal", async () => {
    const { provider } = await connected([], {}, { queryTimeout: 40 }, hangingAfter(2));
    const error = await rejection(provider.query("SELECT 1"));
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe(S.timeout("40"));
  });

  test("E16: a run whose deadline passes while it waits for a permit fails as a timeout, having sent nothing", async () => {
    const hanging = hangingAfter(2);
    const waiting = await connected([], {}, { queryTimeout: 80 }, hanging);
    // Runs of other providers, each at its own cap, hold every permit of the engine key `influxdb3`.
    const { perEngine, perProvider } = INFLUX_LIMITER_OPTIONS;
    const fillers: Harness[] = [];
    for (let index = 0; index < perEngine / perProvider; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each filler connects before the next, so the permits fill in order.
      fillers.push(await connected([], {}, {}, hangingAfter(2)));
    }
    const ids = (index: number) => Array.from({ length: perProvider }, (_, run) => `q3-fill-${index}-${run}`);
    const held = fillers.flatMap((filler, index) =>
      ids(index).map((id) => rejection(filler.provider.query("SELECT 1", undefined, id))),
    );
    const error = await rejection(waiting.provider.query("SELECT 1"));
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe(S.timeout("80"));
    expect(hanging.held()).toBe(0);
    for (const [index, filler] of fillers.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- each run is cancelled in turn.
      for (const id of ids(index)) expect(await filler.provider.cancelQuery(id)).toBe(true);
    }
    for (const failure of await Promise.all(held)) expect(failure).toBeInstanceOf(QueryCancelledError);
  });

  test("a failure the provider did not expect is worded without its text", async () => {
    const { provider } = await connected([], {}, {}, (transport) => ({
      request: (request) =>
        new URL(request.url).pathname === "/api/v3/query_sql"
          ? Promise.reject(new Error("secret internals"))
          : transport.request(request),
      close: () => transport.close(),
    }));
    const error = await rejection(provider.query("SELECT 1"));
    expect(error.message).toBe(S.unrecognised);
    expect(error.message).not.toContain("secret");
  });
});

describe("the object surface (spec 4, R16)", () => {
  const SCHEMA = v3("sql-schema-home");
  const LISTING_Q =
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'iox' ORDER BY table_name LIMIT 2001";

  test("listContainers answers nothing and sends nothing: the session database has no container node", async () => {
    const { provider, requests } = await connected();
    expect(await provider.listContainers()).toEqual([]);
    expect(requests).toHaveLength(2);
  });

  test("countObjects and listObjects read the iox tables of the session database, policy-allowed", async () => {
    const { provider, requests } = await connected([TABLE_LISTING, TABLE_LISTING]);
    expect(await provider.countObjects([])).toEqual({ table: { count: IOX_TABLES.length } });
    const objects = await provider.listObjects([], "table");
    expect(objects.map((object) => object.path)).toEqual(IOX_TABLES.map((name) => [name]));
    expect(requests.slice(2).map(sent)).toEqual([
      { db: "home", q: LISTING_Q, format: "jsonl" },
      { db: "home", q: LISTING_Q, format: "jsonl" },
    ]);
  });

  test("a container path that is not empty and an undeclared kind are refused with no request", async () => {
    const { provider, requests } = await connected();
    for (const call of [
      () => provider.countObjects(["home"]),
      () => provider.listObjects(["home"], "table"),
      () => provider.describeObjects(["home"], "table"),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- each refusal is checked in turn.
      const error = await rejection(call());
      expect(error).toBeInstanceOf(QueryError);
      expect(error.message).toBe('An InfluxDB 3 container path is empty, received ["home"]');
    }
    for (const call of [
      () => provider.listObjects([], "measurement"),
      () => provider.describeObject(["home"], "measurement"),
      () => provider.describeObjects([], "measurement"),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- as above.
      expect((await rejection(call())).message).toBe('InfluxDB 3 declares no object kind "measurement"');
    }
    expect(requests).toHaveLength(2);
  });

  test("describeObject reads system.influxdb_schema: time, tags, fields", async () => {
    const { provider, requests } = await connected([SCHEMA]);
    const detail = await provider.describeObject(["home"], "table");
    expect(sent(requests[2])).toEqual({ db: "home", q: (SCHEMA.request.body as { q: string }).q, format: "jsonl" });
    expect(detail.path).toEqual(["home"]);
    expect(detail.columns.map((column) => `${column.name}:${column.type}`)).toEqual([
      "time:time",
      "room:tag",
      "co:integer",
      "hum:float",
      "temp:float",
    ]);
  });

  test("a path naming a database, or no table, is refused with the session database's sentence and no request", async () => {
    const { provider, requests } = await connected();
    for (const objectPath of [["home", "home"], [], ["_internal", "system", "tokens"]]) {
      // oxlint-disable-next-line no-await-in-loop -- each path is checked in turn.
      const error = await rejection(provider.describeObject(objectPath, "table"));
      expect(error).toBeInstanceOf(QueryError);
      expect(error.message).toBe(influxdb3PathRefusal("home"));
    }
    expect(requests).toHaveLength(2);
  });

  test("a surface read the server refuses is worded by the error table", async () => {
    const { provider } = await connected([built(403, "", null)]);
    const error = await rejection(provider.listObjects([], "table"));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(S.sqlTokenMayNotRead("home"));
  });

  test("describeObjects describes every listed table in turn, and a caller bound is reported", async () => {
    const two = jsonl([{ table_name: "home" }, { table_name: "edge" }]);
    const { provider, requests } = await connected([two, SCHEMA, SCHEMA, two, SCHEMA]);
    const all = await provider.describeObjects([], "table");
    expect(all.details.map((detail) => detail.path)).toEqual([["home"], ["edge"]]);
    expect(Object.hasOwn(all, "truncated")).toBe(false);
    const one = await provider.describeObjects([], "table", 1);
    expect(one.details).toHaveLength(1);
    expect(one.truncated).toEqual({ limit: 1, reason: callerBoundTruncationReason(1) });
    expect(requests).toHaveLength(2 + 3 + 2);
  });

  test("describeObjects says so when the listing cap cut the tables", async () => {
    const names = Array.from({ length: INFLUX_LIST_CAP + 1 }, (_, index) => ({ table_name: `t${index}` }));
    const schemas = Array.from({ length: INFLUX_LIST_CAP }, () => built(200, "", "application/jsonl"));
    const { provider } = await connected([jsonl(names), ...schemas]);
    const batch = await provider.describeObjects([], "table");
    expect(batch.details).toHaveLength(INFLUX_LIST_CAP);
    expect(batch.truncated).toEqual({
      limit: INFLUX_LIST_CAP,
      reason: "the table listing reads at most 2,000 tables",
    });
  });
});

describe("monitoring (spec 7)", () => {
  test("health is one GET /ping, reachability only; a refusal is reachability too", async () => {
    const { provider, requests } = await connected([v3("ping-auth"), v3("ping-forbidden-synthetic")]);
    expect(await provider.getHealth()).toEqual(toInfluxHealth());
    expect(await provider.getHealth()).toEqual(toInfluxHealth());
    expect(requests.slice(2).map(path)).toEqual(["/ping", "/ping"]);
  });

  test("a /ping 5xx is thrown, worded", async () => {
    const { provider } = await connected([built(503, "down", "text/plain")]);
    const error = await rejection(provider.getHealth());
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(S.httpStatus("503", "down"));
  });

  test("the overview names the version and the session database, and counts its tables", async () => {
    const { provider } = await connected([TABLE_LISTING]);
    expect(await provider.getOverview()).toEqual({
      version: "InfluxDB 3 Core 3.12.0, database home",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: IOX_TABLES.length,
      indexCount: 0,
    });
  });

  test("the overview is a floor when the listing cap cut the tables", async () => {
    const names = Array.from({ length: INFLUX_LIST_CAP + 1 }, (_, index) => ({ table_name: `t${index}` }));
    const { provider } = await connected([jsonl(names)]);
    const overview = await provider.getOverview();
    expect(overview.tableCount).toBe(INFLUX_LIST_CAP);
    expect(overview.tableCountSampledFrom).toBe("the first 2,000 tables the session database's table listing returned");
  });

  test.each([401, 403, 404])("the overview counts no table for a %i", async (status) => {
    const { provider } = await connected([built(status, "", null)]);
    expect((await provider.getOverview()).tableCount).toBe(0);
  });

  test("an overview read that is not a refusal is thrown, worded", async () => {
    const { provider } = await connected([built(500, "boom", "text/plain")]);
    const error = await rejection(provider.getOverview());
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(S.sqlRefused("boom"));
  });

  test("the reads InfluxDB 3 has no route for answer their honest absence, with no request", async () => {
    const { provider, requests } = await connected();
    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getTableStats()).toEqual([]);
    expect(await provider.getIndexStats()).toEqual([]);
    expect(await provider.getStorageStats()).toEqual([]);
    const maintenance = await rejection(provider.runMaintenance());
    expect(maintenance).toBeInstanceOf(QueryError);
    expect(maintenance.message).toBe(
      "InfluxDB 3 has no maintenance operation in Studio, and the connection is read-only, so nothing was sent.",
    );
    expect(requests).toHaveLength(2);
  });

  test("a monitoring read before connect is refused as not connected", async () => {
    const { provider } = harness([]);
    for (const read of [() => provider.getHealth(), () => provider.getOverview(), () => provider.getTableStats()]) {
      // oxlint-disable-next-line no-await-in-loop -- each read is checked in turn.
      expect(await rejection(read())).toBeInstanceOf(DatabaseError);
    }
  });
});

describe("E6: no trusted internal path", () => {
  test("every q the recording client saw is allowed by the policy", async () => {
    const forbidden = built(403, "", null);
    const made = harness([
      v3("ping-forbidden-synthetic"),
      forbidden,
      v3("sql-keyword-select"),
      TABLE_LISTING,
      v3("sql-schema-home"),
    ]);
    providers.push(made.provider);
    await made.provider.connect();
    await made.provider.listObjects([], "table");
    await made.provider.describeObject(["home"], "table");
    const texts = made.requests.filter((request) => request.body !== undefined).map((request) => sent(request).q);
    expect(texts).toHaveLength(3);
    for (const q of texts) expect(evaluateInfluxSql(q).allowed).toBe(true);
  });
});
