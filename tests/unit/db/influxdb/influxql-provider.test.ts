/**
 * The `influxdb` provider (InfluxDB spec 5.1, 5.5, 5.6, 5.8, 6.2, 6.3, 7; E2, E6, E7, E11, E13, E16): composition only,
 * driven through the real route-table client and a recording transport handed in by the constructor's client
 * factory, so every request the provider would put on the wire is seen and answered from a capture or from an answer
 * built here in the shape the captures show. `mock.module()` is not used.
 *
 * Built rather than captured: the `/health` 401 that leaves the generation unknown, the 32 MiB body, the 10,001-row
 * body, the `messages` notice, the empty key listings of measurements other than `home`, and the `/query` cut, which
 * no pinned line produced (R39): it is `preview-home` with `cut` set, named `synthetic` below.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { BaseDatabaseProvider } from "@/lib/db/base-provider";
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
  INFLUX_LIMITER_OPTIONS,
  INFLUX_LIST_CAP,
  INFLUX_ROW_CUT,
} from "@/lib/db/providers/timeseries/influxdb/connection-options";
import { INFLUX_ERROR_SENTENCES } from "@/lib/db/providers/timeseries/influxdb/errors";
import {
  INFLUX_CONTAINER_LEVELS,
  INFLUXQL_OBJECT_KINDS,
} from "@/lib/db/providers/timeseries/influxdb/influxql-objects";
import {
  evaluateInfluxql,
  INFLUXQL_MAX_TEXT_BYTES,
  INFLUXQL_POLICY_SENTENCES,
} from "@/lib/db/providers/timeseries/influxdb/influxql-policy";
import { InfluxDBProvider } from "@/lib/db/providers/timeseries/influxdb/influxql-provider";
import { INFLUXQL_LABELS } from "@/lib/db/providers/timeseries/influxdb/labels";
import { toInfluxHealth } from "@/lib/db/providers/timeseries/influxdb/monitoring";
import { RUN_DATABASE_SENTENCES } from "@/lib/db/providers/timeseries/influxdb/run-database";
import type { DatabaseConnection, ProviderOptions } from "@/lib/db/types";
import { DuplicateRunError } from "@/lib/db/utils/bounded-limiter";
import { DEFAULT_QUERY_LIMIT } from "@/lib/db/utils/query-limiter";
import { type InfluxCapture, type InfluxFixtureVersion, loadInfluxCapture } from "../../../helpers/influxdb-fixtures";
import {
  type RecordedInfluxRequest,
  recordingInfluxTransport,
  type ScriptedAnswer,
} from "../../../helpers/influxdb-transport";

const CONNECTION: DatabaseConnection = {
  id: "influxdb-unit",
  name: "InfluxDB",
  type: "influxdb",
  host: "127.0.0.1",
  port: 8086,
  user: "admin",
  password: "admin-password",
  createdAt: new Date(0),
};

const S = INFLUX_ERROR_SENTENCES as unknown as Record<string, string & ((...parts: string[]) => string)>;

const capture = (version: InfluxFixtureVersion, name: string): InfluxCapture => loadInfluxCapture(version, name);

/** An answer built here in the shape the captures show, for what no capture holds. */
function built(status: number, body: string, contentType: string | null = "application/json"): InfluxCapture {
  return {
    version: "1.13.1",
    name: "built",
    image: "built",
    capturedAt: "built",
    request: { method: "POST", path: "/query", query: {}, auth: "none" },
    status,
    contentType,
    body,
  };
}

/** A one-series `/query` document. */
function series(name: string, columns: readonly string[], values: readonly (readonly unknown[])[]): string {
  return `${JSON.stringify({ results: [{ statement_id: 0, series: [{ name, columns, values }] }] })}\n`;
}

const listing = (...names: string[]): InfluxCapture =>
  built(
    200,
    series(
      "databases",
      ["name"],
      names.map((name) => [name]),
    ),
  );

const EMPTY_RESULT = built(200, '{"results":[{"statement_id":0}]}\n');

/** What `/ping`, `/health` and `SHOW DATABASES` answer on each line, and on a server that names no version. */
const CONNECT: Readonly<Record<"v1" | "v2" | "v3" | "unknown", readonly InfluxCapture[]>> = {
  v1: [capture("1.13.1", "ping-anon"), capture("1.13.1", "health-anon"), capture("1.13.1", "show-databases-admin")],
  v2: [capture("2.9.1", "ping-anon"), capture("2.9.1", "health-anon"), capture("2.9.1", "show-databases-admin")],
  v3: [capture("3.12.0-core", "ping-auth"), capture("3.12.0-core", "show-databases-admin")],
  // A 1.x server with `[http] ping-auth-enabled` answers /health 401: no version is read.
  unknown: [
    capture("1.13.1", "ping-anon"),
    built(401, '{"error":"unable to parse authentication credentials"}\n'),
    capture("3.12.0-core", "show-databases-admin"),
  ],
};

interface Harness {
  readonly provider: InfluxDBProvider;
  readonly requests: RecordedInfluxRequest[];
  readonly closed: () => number;
}

/** A provider over the real client and a recording transport whose `close` is counted. */
function harness(
  script: readonly ScriptedAnswer[],
  config: Partial<DatabaseConnection> = {},
  options: ProviderOptions = {},
  wrap: (transport: NodeTransport) => NodeTransport = (transport) => transport,
): Harness {
  const wire = recordingInfluxTransport(script);
  let closed = 0;
  const transport = (transportOptions: NodeTransportOptions): NodeTransport => {
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
    provider: new InfluxDBProvider({ ...CONNECTION, ...config }, options, factory),
    requests: wire.requests,
    closed: () => closed,
  };
}

const providers: InfluxDBProvider[] = [];

/** A provider connected on one line, with `rest` answering whatever follows the connect sequence. */
async function connected(
  line: keyof typeof CONNECT,
  rest: readonly ScriptedAnswer[] = [],
  config: Partial<DatabaseConnection> = {},
  options: ProviderOptions = {},
  wrap?: (transport: NodeTransport) => NodeTransport,
): Promise<Harness> {
  const made = harness([...CONNECT[line], ...rest], config, options, wrap);
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

const QUERY_FORM = { chunked: "true", chunk_size: "1000" };

/**
 * A transport that answers the connect sequence from the recording one and then holds every request until its
 * signal aborts, failing as the shared transport fails an aborted request.
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

describe("declarations", () => {
  test("every capability field is written out, and the absent ones are absent (spec 6.3)", () => {
    const { provider } = harness([]);
    expect(provider.getCapabilities()).toEqual({
      queryLanguage: "influxql",
      supportsExplain: false,
      supportsExternalQueryLimiting: false,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsResultPagination: false,
      supportsTransactions: false,
      declaresForeignKeys: false,
      tablesAreDerivedGroupings: false,
      enforcesReadOnly: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: 8086,
      statementTerminator: "none",
      containerLevels: INFLUX_CONTAINER_LEVELS,
      containerPathShapes: "exact",
      objectKinds: INFLUXQL_OBJECT_KINDS,
      schemaRefreshPattern: "(?!)",
    });
    for (const absent of [
      "queryDialect",
      "explainFormat",
      "singleWriterFile",
      "maintenanceOperationSpecs",
      "identifierQuoting",
      "previewProjection",
      "previewTimeWindow",
      "keyScan",
    ]) {
      expect(Object.hasOwn(provider.getCapabilities(), absent)).toBe(false);
    }
  });

  test("the labels are the InfluxQL labels, as a copy", () => {
    const { provider } = harness([]);
    expect(provider.getLabels()).toEqual(INFLUXQL_LABELS);
    expect(provider.getLabels()).not.toBe(INFLUXQL_LABELS);
  });

  test("prepareQuery passes the text through with no limit and no offset (I19)", () => {
    const { provider } = harness([]);
    expect((provider as BaseDatabaseProvider).prepareQuery("SELECT * FROM m", { limit: 10, offset: 20 })).toEqual({
      query: "SELECT * FROM m",
      wasLimited: false,
      limit: DEFAULT_QUERY_LIMIT,
      offset: 0,
    });
  });

  test("validate refuses an empty Host by name, and accepts a host", () => {
    expect(() => harness([], { host: "" }).provider.validate()).toThrow(
      new DatabaseConfigError("An InfluxDB connection needs a host.", "influxdb"),
    );
    expect(() => harness([]).provider.validate()).not.toThrow();
  });
});

describe("connect (spec 6.2)", () => {
  test("1.x: /ping 204, then /health for the version, then SHOW DATABASES with no db, under the Basic header", async () => {
    const { requests } = await connected("v1");
    expect(requests.map((request) => `${request.method} ${path(request)}`)).toEqual([
      "GET /ping",
      "GET /health",
      "POST /query",
    ]);
    expect(requests[2].form).toEqual({ q: "SHOW DATABASES", ...QUERY_FORM });
    expect(requests[2].headers).toEqual({
      authorization: `Basic ${Buffer.from("admin:admin-password").toString("base64")}`,
    });
    expect(new URL(requests[2].url).search).toBe("");
  });

  test("3.x: a JSON /ping body decides alone, so /health is not read", async () => {
    const { requests } = await connected("v3", [], { user: "" });
    expect(requests.map((request) => path(request))).toEqual(["/ping", "/query"]);
    expect(requests[0].headers).toEqual({ authorization: "Token admin-password" });
  });

  test("the cached listing: _internal is listed on 1.x and hidden on 3.x and an unknown generation", async () => {
    for (const [line, expected] of [
      ["v1", ["home", "edge", "_internal", "bench"]],
      ["v2", ["_monitoring", "_tasks", "bench", "edge", "home"]],
      ["v3", ["home", "edge", "bench"]],
      ["unknown", ["home", "edge", "bench"]],
    ] as const) {
      const answer = line === "v1" ? CONNECT.v1[2] : line === "v2" ? CONNECT.v2[2] : CONNECT.v3[1];
      // oxlint-disable-next-line no-await-in-loop -- each line connects its own provider in turn.
      const { provider } = await connected(line, [answer], { database: "home" });
      // oxlint-disable-next-line no-await-in-loop -- one line's reads are taken in order.
      const containers = await provider.listContainers();
      expect(containers.map((container) => container.name)).toEqual([...expected]);
      expect(containers.filter((container) => container.isSessionDefault).map((container) => container.name)).toEqual([
        "home",
      ]);
    }
  });

  test("a /ping 401 is the line's 401 sentence, and the client is closed", async () => {
    const made = harness([capture("3.12.0-core", "ping-anon")]);
    const error = await rejection(made.provider.connect());
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toBe(S.token3Refused);
    expect(made.closed()).toBe(1);
    expect(made.provider.isConnected()).toBe(false);
  });

  test("a /ping 404 is the not-InfluxDB sentence", async () => {
    const made = harness([built(404, "404 page not found\n", "text/plain")]);
    const error = await rejection(made.provider.connect());
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe(S.noPing("127.0.0.1:8086"));
    expect(made.closed()).toBe(1);
  });

  test("a refused SHOW DATABASES fails the connect with the grants sentence", async () => {
    const made = harness([
      capture("1.13.1", "ping-anon"),
      capture("1.13.1", "health-anon"),
      capture("1.13.1", "reader-forbidden"),
    ]);
    const error = await rejection(made.provider.connect());
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toBe(S.userMayNotListDatabases);
    expect(made.closed()).toBe(1);
  });

  test("a connection refused by its options sends nothing and builds no client", async () => {
    for (const config of [
      { host: "influx.example.com" },
      { password: "", user: "", readOnly: true, seedId: "seed-influx" },
      { host: "" },
    ]) {
      const made = harness([], config);
      // oxlint-disable-next-line no-await-in-loop -- each configuration is refused on its own provider in turn.
      const error = await rejection(made.provider.connect());
      expect(error).toBeInstanceOf(DatabaseConfigError);
      expect(made.requests).toHaveLength(0);
      expect(made.closed()).toBe(0);
    }
  });

  test("a second connect closes the client of the first, and the provider reads through the new one", async () => {
    const made = harness([...CONNECT.v1, ...CONNECT.v1, capture("1.13.1", "ping-anon")]);
    providers.push(made.provider);
    await made.provider.connect();
    expect(made.closed()).toBe(0);
    await made.provider.connect();
    expect(made.closed()).toBe(1);
    expect(await made.provider.getHealth()).toEqual(toInfluxHealth());
  });

  test("disconnect closes the client, and a call after it is refused as not connected", async () => {
    const made = await connected("v1");
    await made.provider.disconnect();
    expect(made.closed()).toBe(1);
    expect(made.provider.isConnected()).toBe(false);
    expect(await rejection(made.provider.query("SHOW DATABASES"))).toBeInstanceOf(DatabaseConfigError);
    await made.provider.disconnect();
    expect(made.closed()).toBe(1);
  });
});

/** Texts the policy refuses, each with a request it would otherwise have made (E2, E3, E9, R31 is below). */
const REFUSED: readonly string[] = [
  "",
  "   -- only a comment",
  'from(bucket: "home") |> range(start: -1h)',
  "SELECT 'unterminated FROM m",
  "SELECT * FROM m WHERE a = $a",
  "SELECT 1; DROP DATABASE x",
  "SELECT * FROM m -- c\r; DROP DATABASE x",
  "SELECT x FROM m WHERE x > 1 AND /* a/ ' */ x > 0; DROP DATABASE d -- '",
  'SELECT * FROM "home"."autogen"./\'/; DROP DATABASE d --\'',
  "DROP DATABASE x",
  "select temp into other..x from home",
  `SELECT * FROM m WHERE a = 'x${String.fromCharCode(0)}'`,
  "SELECT * FROM m WHERE a = 'é' ; DROP DATABASE x",
];

describe("the query pipeline (spec 5.1)", () => {
  test("one named database is sent as db in a form POST with no URL query, and the answer is a grid", async () => {
    const preview = capture("1.13.1", "preview-home");
    const { provider, requests } = await connected("v1", [preview]);
    const text = preview.request.form?.q as string;
    const result = await provider.query(text);
    const sent = requests[3];
    expect(sent.method).toBe("POST");
    expect(new URL(sent.url).search).toBe("");
    expect(sent.form).toEqual({ db: "home", q: text, ...QUERY_FORM });
    expect(result.fields).toEqual(["time", "co", "hum", "room", "temp"]);
    expect(result.rows).toEqual([{ time: "2026-10-04T01:50:40Z", co: 26, hum: 36.4, room: "Kitchen", temp: 22.2 }]);
    expect(result.rowCount).toBe(1);
    expect(typeof result.executionTime).toBe("number");
    expect(result.pagination).toBeUndefined();
    expect(result.warnings).toBeUndefined();
  });

  test("bound parameters are refused before any request", async () => {
    const { provider, requests } = await connected("v1");
    const error = await rejection(provider.query("SELECT * FROM m", [1]));
    expect(error).toEqual(new QueryError(INFLUXQL_POLICY_SENTENCES.boundParameter, "influxdb"));
    await rejection(provider.query("SHOW DATABASES", []));
    expect(requests).toHaveLength(4);
  });

  test("a text over 65,536 bytes is refused by its byte length, before lexing", async () => {
    const { provider, requests } = await connected("v1");
    const text = `SELECT * FROM mm WHERE a = '${"é".repeat(32_754)}'`;
    const bytes = new TextEncoder().encode(text).length;
    expect(bytes).toBe(INFLUXQL_MAX_TEXT_BYTES + 1);
    const error = await rejection(provider.query(text));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(INFLUXQL_POLICY_SENTENCES.tooLong(bytes));
    expect(requests).toHaveLength(3);
  });

  test("E2: the recording client sees no request for any refused text", async () => {
    const { provider, requests } = await connected("v1");
    for (const text of REFUSED) {
      const verdict = evaluateInfluxql(text);
      expect(verdict.allowed).toBe(false);
      // oxlint-disable-next-line no-await-in-loop -- the texts run one after another on one provider, so the request count is read between them.
      const error = await rejection(provider.query(text));
      expect(error).toBeInstanceOf(QueryError);
      if (!verdict.allowed) expect(error.message).toBe(verdict.message);
    }
    expect(requests).toHaveLength(3);
  });

  test("E7: the refusal corpus gets identical verdicts whatever generation /ping reported", async () => {
    const verdicts: string[][] = [];
    for (const line of ["v1", "v2", "v3", "unknown"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- each line connects its own provider in turn.
      const { provider, requests } = await connected(line);
      const before = requests.length;
      const messages: string[] = [];
      // oxlint-disable-next-line no-await-in-loop -- the texts run one after another on one provider.
      for (const text of REFUSED) messages.push((await rejection(provider.query(text))).message);
      expect(requests).toHaveLength(before);
      verdicts.push(messages);
    }
    expect(verdicts[1]).toEqual(verdicts[0]);
    expect(verdicts[2]).toEqual(verdicts[0]);
    expect(verdicts[3]).toEqual(verdicts[0]);
  });

  test("two named databases send no db, and the server decides", async () => {
    const answer = capture("1.13.1", "two-databases-admin");
    const { provider, requests } = await connected("v1", [answer]);
    const result = await provider.query(answer.request.form?.q as string);
    expect(requests[3].form).toEqual({ q: answer.request.form?.q as string, ...QUERY_FORM });
    expect(result.rows).toEqual([{ time: "1970-01-01T00:00:00Z", count: 4 }]);
  });

  test("with no named database: the connection's database, else the only visible one, else a refusal", async () => {
    const field = await connected("v1", [EMPTY_RESULT], { database: "edge" });
    await field.provider.query("SELECT count(temp) FROM home");
    expect(field.requests[3].form?.db).toBe("edge");

    // A 1.x admin who sees _internal and home runs against home: InfluxDB's own databases never count (R17).
    const only = harness([CONNECT.v1[0], CONNECT.v1[1], listing("_internal", "home", "_monitoring"), EMPTY_RESULT]);
    await only.provider.connect();
    providers.push(only.provider);
    await only.provider.query("SELECT count(temp) FROM home");
    expect(only.requests[3].form?.db).toBe("home");

    const none = await connected("v1");
    const error = await rejection(none.provider.query("SELECT count(temp) FROM home"));
    expect(error).toEqual(new QueryError(RUN_DATABASE_SENTENCES.chooseDatabase, "influxdb"));
    expect(none.requests).toHaveLength(3);
  });

  test("SHOW DATABASES needs no database, so it is sent with none whatever the connection names", async () => {
    const { provider, requests } = await connected("v1", [CONNECT.v1[2], CONNECT.v1[2]], { database: "home" });
    await provider.query("SHOW DATABASES");
    await provider.query("  show /* c */ databases ;");
    expect(requests[3].form).toEqual({ q: "SHOW DATABASES", ...QUERY_FORM });
    expect(requests[4].form?.db).toBeUndefined();
  });

  test("SHOW MEASUREMENTS with no ON needs a database like a SELECT does", async () => {
    const { provider, requests } = await connected("v1", [], {});
    expect((await rejection(provider.query("SHOW MEASUREMENTS"))).message).toBe(RUN_DATABASE_SENTENCES.chooseDatabase);
    expect(requests).toHaveLength(3);
  });

  const INTERNAL_TEXTS = ["SELECT * FROM _internal. rp. m", "SELECT * FROM _internal.--c\nrp.m"];

  test("E13, R31: _internal named after a dot is refused on 3.x and an unknown generation with no request", async () => {
    for (const line of ["v3", "unknown"] as const) {
      // oxlint-disable-next-line no-await-in-loop -- each generation connects its own provider in turn.
      const { provider, requests } = await connected(line);
      for (const text of INTERNAL_TEXTS) {
        // oxlint-disable-next-line no-await-in-loop -- the texts run one after another on one provider.
        const error = await rejection(provider.query(text));
        expect(error).toEqual(new QueryError(RUN_DATABASE_SENTENCES.internalHidden, "influxdb"));
      }
      // oxlint-disable-next-line no-await-in-loop -- each generation connects its own provider in turn.
      const field = await connected(line, [], { database: "_internal" });
      // oxlint-disable-next-line no-await-in-loop -- the provider was connected just above.
      expect((await rejection(field.provider.query("SELECT * FROM m"))).message).toBe(
        RUN_DATABASE_SENTENCES.internalHidden,
      );
      expect(requests).toHaveLength(CONNECT[line].length);
      expect(field.requests).toHaveLength(CONNECT[line].length);
    }
  });

  test("E13: on 1.x the same texts are sent with db=_internal", async () => {
    const { provider, requests } = await connected("v1", [EMPTY_RESULT, EMPTY_RESULT]);
    // oxlint-disable-next-line no-await-in-loop -- the scripted answers are taken in order.
    for (const text of INTERNAL_TEXTS) await provider.query(text);
    expect(requests.slice(3).map((request) => request.form)).toEqual(
      INTERNAL_TEXTS.map((q) => ({ db: "_internal", q, chunked: "true", chunk_size: "1000" })),
    );
  });

  test("a status other than 200 and a statement error in a 200 are worded by the error table", async () => {
    const { provider } = await connected("v1", [
      capture("1.13.1", "parse-error"),
      capture("1.13.1", "db-not-found"),
      capture("3.12.0-core", "two-databases"),
    ]);
    const parse = await rejection(provider.query('SELECT count(temp) FROM "home".."home"'));
    expect(parse).toBeInstanceOf(QueryError);
    expect(parse.message).toBe(
      S.parse("error parsing query: found EOF, expected identifier, string, number, bool at line 1, char 46"),
    );
    const missing = await rejection(provider.query('SELECT count(temp) FROM "nope".."home"'));
    expect(missing.message).toBe(S.databaseNotFound("database not found: nope"));
    const two = await rejection(provider.query('SELECT count(v) FROM "home".."numbers", "edge".."numbers"'));
    expect(two.message).toBe(S.oneDatabasePerStatement);
  });

  test("E5: results for more than one statement are the lexer-disagreement error, never rows", async () => {
    const { provider } = await connected("v3", [capture("3.12.0-core", "differential/two-statements")]);
    const error = await rejection(provider.query("SHOW DATABASES"));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(S.lexerDisagreement);
  });

  test.each(["zero-byte", "mid-line", "line-end"] as const)(
    "E11: a /query answer cut %s is the truncation sentence, never zero rows",
    async (cut) => {
      const preview = capture("3.12.0-core", "preview-home");
      const synthetic: InfluxCapture = {
        ...preview,
        cut,
        bytes: 0,
        synthetic: "preview-home with cut set: no /query truncation reproduces on 3.12.0 (R39, T08)",
      };
      const { provider } = await connected("v3", [synthetic]);
      const error = await rejection(provider.query(preview.request.form?.q as string));
      expect(error).toBeInstanceOf(QueryError);
      expect(error.message).toBe(S.truncated);
    },
  );

  test("E16: an answer over the 32 MiB cap is the cap sentence", async () => {
    const { provider } = await connected("v1", [built(200, "x".repeat(32 * 1024 * 1024 + 1))], { database: "home" });
    const error = await rejection(provider.query("SELECT * FROM m", undefined));
    expect(error.message).toBe(S.tooLarge("32 MiB"));
  });

  test("E16: the row cut is reported on pagination.wasLimited", async () => {
    const values = Array.from({ length: INFLUX_ROW_CUT + 1 }, (_, index) => [index, index]);
    const { provider } = await connected("v1", [built(200, series("m", ["time", "v"], values))], {
      database: "home",
    });
    const result = await provider.query("SELECT * FROM m");
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

  test("the server's notices are the result's warnings", async () => {
    const body = `${JSON.stringify({
      results: [{ statement_id: 0, messages: [{ level: "warning", text: "deprecated" }] }],
    })}\n`;
    const { provider } = await connected("v1", [built(200, body)], { database: "home" });
    const result = await provider.query("SELECT * FROM m");
    expect(result.warnings).toEqual([{ message: "deprecated" }]);
  });

  test("cancelQuery aborts a running run, which is QueryCancelledError; an unknown id answers false", async () => {
    const { provider } = await connected("v1", [], { database: "home" }, {}, hangingAfter(3));
    const running = rejection(provider.query("SELECT * FROM m", undefined, "q-cancel-1"));
    await Bun.sleep(5);
    expect(await provider.cancelQuery("q-cancel-1")).toBe(true);
    const error = await running;
    expect(error).toBeInstanceOf(QueryCancelledError);
    expect(error.message).toBe(S.cancelled);
    expect(await provider.cancelQuery("q-cancel-1")).toBe(false);
    expect(await provider.cancelQuery("q-unknown")).toBe(false);
  });

  test("a queryId already running is refused, and nothing more is sent", async () => {
    const hanging = hangingAfter(3);
    const { provider } = await connected("v1", [], { database: "home" }, {}, hanging);
    const first = rejection(provider.query("SELECT * FROM m", undefined, "q-dup"));
    await Bun.sleep(5);
    expect(hanging.held()).toBe(1);
    expect(await rejection(provider.query("SELECT * FROM m", undefined, "q-dup"))).toBeInstanceOf(DuplicateRunError);
    expect(hanging.held()).toBe(1);
    await provider.cancelQuery("q-dup");
    await first;
  });

  test("E16: the deadline is the connection's query timeout, on the transport signal", async () => {
    const { provider } = await connected("v1", [], { database: "home" }, { queryTimeout: 40 }, hangingAfter(3));
    const error = await rejection(provider.query("SELECT * FROM m"));
    expect(error).toBeInstanceOf(TimeoutError);
    expect(error.message).toBe(S.timeout("40"));
  });

  test("E16: a run whose deadline passes while it waits for a permit fails as a timeout, having sent nothing", async () => {
    const hanging = hangingAfter(3);
    const waiting = await connected("v1", [], { database: "home" }, { queryTimeout: 80 }, hanging);
    // Sixteen runs of four other providers hold every permit of the engine key.
    // Enough providers, each at its own bound, to hold every permit of the engine.
    const { perEngine, perProvider } = INFLUX_LIMITER_OPTIONS;
    const fillers: Harness[] = [];
    for (let index = 0; index < perEngine / perProvider; index += 1) {
      // oxlint-disable-next-line no-await-in-loop -- each filler connects before the next, so the engine's permits fill in order.
      fillers.push(await connected("v1", [], { database: "home" }, {}, hangingAfter(3)));
    }
    const ids = (index: number) => Array.from({ length: perProvider }, (_, run) => `q-fill-${index}-${run}`);
    const held = fillers.flatMap((filler, index) =>
      ids(index).map((id) => rejection(filler.provider.query("SELECT * FROM m", undefined, id))),
    );
    const error = await rejection(waiting.provider.query("SELECT * FROM m"));
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
    const { provider } = await connected("v1", [], { database: "home" }, {}, (transport) => ({
      request: (request) =>
        new URL(request.url).pathname === "/query" && request.form?.q !== "SHOW DATABASES"
          ? Promise.reject(new Error("secret internals"))
          : transport.request(request),
      close: () => transport.close(),
    }));
    const error = await rejection(provider.query("SELECT * FROM m"));
    expect(error.message).toBe(S.unrecognised);
  });
});

describe("the object surface (spec 4)", () => {
  const MEASUREMENTS = capture("1.13.1", "show-measurements-home");

  test("listContainers below a database answers nothing and sends nothing", async () => {
    const { provider, requests } = await connected("v1");
    expect(await provider.listContainers(["home"])).toEqual([]);
    expect(requests).toHaveLength(3);
  });

  test("countObjects and listObjects read SHOW MEASUREMENTS ON the database, with db, policy-allowed", async () => {
    const { provider, requests } = await connected("v1", [MEASUREMENTS, MEASUREMENTS]);
    expect(await provider.countObjects(["home"])).toEqual({ measurement: { count: 6 } });
    const objects = await provider.listObjects(["home"], "measurement");
    expect(objects.map((object) => object.path)).toEqual(
      ["edge", "edge cases,m", "home", "numbers", "sparse", 'we"ird name;x'].map((name) => ["home", name]),
    );
    expect(requests[3].form).toEqual({ db: "home", q: `SHOW MEASUREMENTS ON "home" LIMIT 2001`, ...QUERY_FORM });
  });

  test("a container path that is not [database] and an undeclared kind are refused with no request", async () => {
    const { provider, requests } = await connected("v1");
    for (const container of [[], ["home", "autogen"]]) {
      // oxlint-disable-next-line no-await-in-loop -- one read at a time, so none rejects unobserved.
      const error = await rejection(provider.countObjects(container));
      expect(error).toBeInstanceOf(QueryError);
      expect(error.message).toBe(`An InfluxDB container path is [database], received ${JSON.stringify(container)}`);
      // oxlint-disable-next-line no-await-in-loop -- one read at a time, so none rejects unobserved.
      expect(await rejection(provider.listObjects(container, "measurement"))).toBeInstanceOf(QueryError);
      // oxlint-disable-next-line no-await-in-loop -- one read at a time, so none rejects unobserved.
      expect(await rejection(provider.describeObjects(container, "measurement"))).toBeInstanceOf(QueryError);
    }
    for (const call of [
      () => provider.listObjects(["home"], "table"),
      () => provider.describeObject(["home", "m"], "table"),
      () => provider.describeObjects(["home"], "table"),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- one read at a time, so none rejects unobserved.
      expect((await rejection(call())).message).toBe('InfluxDB declares no object kind "table"');
    }
    const shape = await rejection(provider.describeObject(["home"], "measurement"));
    expect(shape).toBeInstanceOf(QueryError);
    expect(requests).toHaveLength(3);
  });

  test("describeObject reads the tag keys and the field keys, and adds time", async () => {
    const { provider, requests } = await connected("v1", [
      capture("1.13.1", "show-tag-keys-home"),
      capture("1.13.1", "show-field-keys-home"),
    ]);
    const detail = await provider.describeObject(["home", "home"], "measurement");
    expect(detail.columns.map((column) => [column.name, column.type])).toEqual([
      ["time", "time"],
      ["room", "tag"],
      ["co", "integer"],
      ["hum", "float"],
      ["temp", "float"],
    ]);
    expect(requests.slice(3).map((request) => request.form?.q)).toEqual([
      'SHOW TAG KEYS ON "home" FROM "home"',
      'SHOW FIELD KEYS ON "home" FROM "home"',
    ]);
  });

  test("a name holding a control character is a QueryError naming the quoter's reason, with no request", async () => {
    const { provider, requests } = await connected("v1");
    const error = await rejection(provider.describeObject(["home", `bad${String.fromCharCode(1)}name`], "measurement"));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.constructor).toBe(QueryError);
    expect(error.message.length).toBeGreaterThan(0);
    expect(requests).toHaveLength(3);
  });

  test("a surface read the server refuses is worded by the error table", async () => {
    const { provider } = await connected("v1", [capture("1.13.1", "two-databases-reader")]);
    const error = await rejection(provider.listObjects(["edge"], "measurement"));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(S.readerCannotRead("edge"));
  });

  test("describeObjects describes every listed measurement, and a caller bound is reported", async () => {
    const keys = (request: RecordedInfluxRequest): InfluxCapture => {
      const q = request.form?.q ?? "";
      if (q.startsWith("SHOW MEASUREMENTS")) return MEASUREMENTS;
      if (q === 'SHOW TAG KEYS ON "home" FROM "home"') return capture("1.13.1", "show-tag-keys-home");
      if (q === 'SHOW FIELD KEYS ON "home" FROM "home"') return capture("1.13.1", "show-field-keys-home");
      return EMPTY_RESULT;
    };
    const { provider } = await connected(
      "v1",
      Array.from({ length: 40 }, () => keys),
    );
    const all = await provider.describeObjects(["home"], "measurement");
    expect(all.truncated).toBeUndefined();
    expect(all.details.map((detail) => detail.path[1])).toEqual([
      "edge",
      "edge cases,m",
      "home",
      "numbers",
      "sparse",
      'we"ird name;x',
    ]);
    expect(all.details[2].columns).toHaveLength(5);
    expect(all.details[0].columns.map((column) => column.name)).toEqual(["time"]);

    const two = await provider.describeObjects(["home"], "measurement", 2);
    expect(two.details).toHaveLength(2);
    expect(two.truncated).toEqual({ limit: 2, reason: callerBoundTruncationReason(2) });
  });

  test("describeObjects says so when the listing cap cut the measurements", async () => {
    const names = Array.from({ length: INFLUX_LIST_CAP + 1 }, (_, index) => [`m${index}`]);
    const listed = built(200, series("measurements", ["name"], names));
    const answers: ScriptedAnswer[] = [
      listed,
      listed,
      ...Array.from({ length: INFLUX_LIST_CAP * 2 }, () => EMPTY_RESULT),
    ];
    const { provider } = await connected("v1", answers);
    const batch = await provider.describeObjects(["home"], "measurement");
    expect(batch.details).toHaveLength(INFLUX_LIST_CAP);
    expect(batch.truncated).toEqual({
      limit: INFLUX_LIST_CAP,
      reason: "the measurement listing reads at most 2,000 measurements",
    });
  });

  test("describeObjects reports no cut when the database holds exactly 2,000 measurements", async () => {
    const names = Array.from({ length: INFLUX_LIST_CAP }, (_, index) => [`m${index}`]);
    const listed = built(200, series("measurements", ["name"], names));
    const answers: ScriptedAnswer[] = [
      listed,
      listed,
      ...Array.from({ length: INFLUX_LIST_CAP * 2 }, () => EMPTY_RESULT),
    ];
    const { provider, requests } = await connected("v1", answers);
    const batch = await provider.describeObjects(["home"], "measurement");
    expect(batch.details).toHaveLength(INFLUX_LIST_CAP);
    expect(batch.truncated).toBeUndefined();
    // The listing, the one read that tells 2,000 from more, then two key reads per measurement.
    expect(requests).toHaveLength(3 + 2 + INFLUX_LIST_CAP * 2);
    expect(requests[4].form?.q).toBe('SHOW MEASUREMENTS ON "home" LIMIT 2001');
  });
});

describe("monitoring (spec 7)", () => {
  test("health is one GET /ping, reachability only", async () => {
    const { provider, requests } = await connected("v1", [capture("1.13.1", "ping-anon")]);
    expect(await provider.getHealth()).toEqual(toInfluxHealth());
    expect(path(requests[3])).toBe("/ping");
  });

  test("a /ping the server refuses is still reachability, and a /ping 5xx is thrown, worded", async () => {
    const refused = await connected("v1", [capture("3.12.0-core", "unauthorized")]);
    expect(await refused.provider.getHealth()).toEqual(toInfluxHealth());
    const failing = await connected("v1", [built(503, '{"error":"unavailable"}\n')]);
    const error = await rejection(failing.provider.getHealth());
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).not.toBe(S.unrecognised);
  });

  test("the overview counts the measurements of every visible database, and a refused read counts none", async () => {
    const { provider, requests } = await connected("v1", [
      capture("1.13.1", "show-measurements-home"),
      capture("1.13.1", "two-databases-reader"),
      EMPTY_RESULT,
      capture("1.13.1", "show-measurements-home"),
    ]);
    const overview = await provider.getOverview();
    expect(overview).toEqual({
      version: "InfluxDB 1.13.1",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "N/A",
      tableCount: 12,
      indexCount: 0,
    });
    expect(requests.slice(3).map((request) => request.form?.db)).toEqual(["home", "edge", "_internal", "bench"]);
  });

  test("the overview is a floor when a listing cap cut a database's measurements", async () => {
    const names = Array.from({ length: INFLUX_LIST_CAP + 1 }, (_, index) => [`m${index}`]);
    const { provider } = await connected("v3", [
      built(200, series("measurements", ["name"], names)),
      EMPTY_RESULT,
      EMPTY_RESULT,
    ]);
    const overview = await provider.getOverview();
    expect(overview.version).toBe("InfluxDB 3 Core 3.12.0");
    expect(overview.tableCount).toBe(INFLUX_LIST_CAP);
    expect(overview.tableCountSampledFrom).toBe(
      "the first 2,000 measurements SHOW MEASUREMENTS returned for each database",
    );
  });

  test("the overview counts none for a 401, 403, 404 or a statement error", async () => {
    const { provider } = await connected("v1", [
      capture("1.13.1", "unauthorized"),
      capture("1.13.1", "reader-forbidden"),
      built(404, "404 page not found\n", "text/plain"),
      capture("1.13.1", "db-not-found"),
    ]);
    expect((await provider.getOverview()).tableCount).toBe(0);
  });

  test("an overview read that is not a refusal is thrown, worded: a 5xx, a lexer disagreement, an unreadable body", async () => {
    const lexer = await connected("v1", [
      capture("3.12.0-core", "differential/two-statements"),
      EMPTY_RESULT,
      EMPTY_RESULT,
      EMPTY_RESULT,
    ]);
    expect((await rejection(lexer.provider.getOverview())).message).toBe(S.lexerDisagreement);
    for (const answer of [built(500, '{"error":"internal"}\n'), built(200, "not json at all\n")]) {
      // The other three databases would answer empty, so a swallowed failure would be an overview of zero.
      // oxlint-disable-next-line no-await-in-loop -- each answer is read by its own provider in turn.
      const { provider, requests } = await connected("v1", [answer, EMPTY_RESULT, EMPTY_RESULT, EMPTY_RESULT]);
      // oxlint-disable-next-line no-await-in-loop -- as above.
      const error = await rejection(provider.getOverview());
      expect(error).toBeInstanceOf(DatabaseError);
      expect(error.message).not.toBe(S.unrecognised);
      expect(requests).toHaveLength(4);
    }
  });

  test("a transport failure in the overview is thrown, worded", async () => {
    const { provider } = await connected("v1", [{ ...capture("1.13.1", "show-measurements-home"), cut: "zero-byte" }]);
    expect((await rejection(provider.getOverview())).message).toBe(S.truncated);
  });

  test("the reads InfluxDB has no route for answer their honest absence, with no request", async () => {
    const { provider, requests } = await connected("v1");
    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getTableStats()).toEqual([]);
    expect(await provider.getIndexStats()).toEqual([]);
    expect(await provider.getStorageStats()).toEqual([]);
    const maintenance = await rejection((provider as BaseDatabaseProvider).runMaintenance("vacuum"));
    expect(maintenance).toBeInstanceOf(QueryError);
    expect(maintenance.message).toBe(
      "InfluxDB has no maintenance operation in Studio, and the connection is read-only, so nothing was sent.",
    );
    expect(requests).toHaveLength(3);
  });

  test("a monitoring read before connect is refused as not connected", async () => {
    const { provider } = harness([]);
    expect(await rejection(provider.getHealth())).toBeInstanceOf(DatabaseConfigError);
    expect(await rejection(provider.getSlowQueries())).toBeInstanceOf(DatabaseConfigError);
  });
});

describe("E6: no trusted internal path", () => {
  test("every q the recording client saw is allowed by the policy", async () => {
    const answer = (request: RecordedInfluxRequest): InfluxCapture => {
      const q = request.form?.q ?? "";
      if (q === "SHOW DATABASES") return CONNECT.v1[2];
      if (q.startsWith("SHOW MEASUREMENTS")) return capture("1.13.1", "show-measurements-home");
      return EMPTY_RESULT;
    };
    const { provider, requests } = await connected(
      "v1",
      Array.from({ length: 40 }, () => answer),
      {
        database: "home",
      },
    );
    await provider.listContainers();
    await provider.countObjects(["home"]);
    await provider.describeObjects(["home"], "measurement");
    await provider.describeObject(["home", 'we"ird name;x'], "measurement");
    await provider.getOverview();
    await provider.query("SELECT * FROM m");
    const sent = requests.filter((request) => request.form !== undefined);
    expect(sent.length).toBeGreaterThan(20);
    for (const request of sent) expect(evaluateInfluxql(request.form?.q as string).allowed).toBe(true);
  });
});
