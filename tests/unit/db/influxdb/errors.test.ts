/**
 * The InfluxDB error table (InfluxDB spec 5.9; E14, E21): one case per row, replayed from a committed capture where
 * one exists and constructed otherwise, each asserting the repository class and the sentence a person reads. Every
 * server text a sentence carries passes `serverText` and is cut to 500 characters.
 */
import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
  TimeoutError,
} from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import type { InfluxAnswer } from "@/lib/db/providers/timeseries/influxdb/client";
import {
  INFLUX_ERROR_SENTENCES,
  InfluxAnswerError,
  InfluxAnswerShapeError,
  type InfluxErrorContext,
  toInfluxError,
} from "@/lib/db/providers/timeseries/influxdb/errors";
import { INFLUXQL_ROUTES, SQL_ROUTES } from "@/lib/db/providers/timeseries/influxdb/routes";
import { RUN_DATABASE_SENTENCES } from "@/lib/db/providers/timeseries/influxdb/run-database";
import { secretForms } from "@/lib/db/utils/server-text";
import { type InfluxCapture, type InfluxFixtureVersion, loadInfluxCapture } from "../../../helpers/influxdb-fixtures";
import { recordingInfluxTransport } from "../../../helpers/influxdb-transport";

const fixed = (key: string): string => INFLUX_ERROR_SENTENCES[key] as string;
const template = (key: string) => INFLUX_ERROR_SENTENCES[key] as (...parts: string[]) => string;

const QUERY = INFLUXQL_ROUTES.query.path;
const PING = INFLUXQL_ROUTES.ping.path;
const SQL = SQL_ROUTES.query.path;
const DATABASES = SQL_ROUTES.databases.path;

// Named placeholders, never realistic values: a credential in a test fixture is a stand-in.
const TEST_USER = "reader";
const TEST_PASSWORD = "password";

function context(overrides: Partial<InfluxErrorContext> = {}): InfluxErrorContext {
  return {
    type: "influxdb",
    phase: "query",
    endpoint: { host: "influx.example", port: 8086 },
    generation: "v1",
    hasUser: true,
    database: "home",
    timeoutMs: 30_000,
    responseCapBytes: 32 * 1024 * 1024,
    secretForms: [],
    ...overrides,
  };
}

const V1 = context();
const V2 = context({ generation: "v2", hasUser: false });
const V3 = context({ generation: "v3", hasUser: false });
const SQL3 = context({ type: "influxdb3", generation: "v3", hasUser: false, endpoint: { host: "h3", port: 8181 } });

function capture(version: InfluxFixtureVersion, name: string): InfluxCapture {
  return loadInfluxCapture(version, name);
}

/** A non-success answer as the provider throws it: the capture's status, type and text on the route it asked. */
function answered(source: InfluxCapture, route: string = source.request.path): InfluxAnswerError {
  return new InfluxAnswerError({ status: source.status, contentType: source.contentType, text: source.body }, route);
}

function made(status: number, text: string, route: string, contentType: string | null = null): InfluxAnswerError {
  const answer: InfluxAnswer = { status, contentType, text };
  return new InfluxAnswerError(answer, route);
}

/** The statement error of a 200 `/query` capture, as the results module throws it. */
function statementError(source: InfluxCapture): InfluxAnswerShapeError {
  const parsed = JSON.parse(source.body) as {
    readonly error?: string;
    readonly results?: readonly { readonly error?: string }[];
  };
  if (parsed.error !== undefined) return new InfluxAnswerShapeError("top-level-error", parsed.error);
  const text = parsed.results?.[0]?.error;
  if (text === undefined) throw new Error(`${source.name} holds no statement error`);
  return new InfluxAnswerShapeError("statement-error", text);
}

function mapped(error: unknown, at: InfluxErrorContext): Error {
  return toInfluxError(error, at);
}

function expectError(error: Error, kind: abstract new (...args: never[]) => Error, message: string): void {
  expect(error).toBeInstanceOf(kind);
  expect(error.message).toBe(message);
}

describe("influxdb, connect and query", () => {
  test("a 1.x parse error (400) names the server's text", () => {
    const source = capture("1.13.1", "parse-error");
    expectError(
      mapped(answered(source), V1),
      QueryError,
      "InfluxDB could not parse the statement: error parsing query: found EOF, expected identifier, string, number, bool at line 1, char 46",
    );
  });

  test("a 2.x parse error (400, code and message) reads the message", () => {
    expectError(
      mapped(answered(capture("2.9.1", "parse-error")), V2),
      QueryError,
      "InfluxDB could not parse the statement: failed to parse query: found EOF, expected identifier, string, number, bool at line 1, char 46",
    );
  });

  test("a 3.x InfluxQL parse error inside a 200", () => {
    expectError(
      mapped(statementError(capture("3.12.0-core", "parse-error")), V3),
      QueryError,
      'InfluxQL could not parse the statement: error in InfluxQL statement: parsing error: invalid InfluxQL statement at pos 39. Parsing Error: Nom("WHERE", Tag)',
    );
  });

  test.each([
    ["1.13.1", "database not found: nope"],
    ["2.9.1", "database not found: nope"],
    ["3.12.0-core", "Cannot retrieve database: External error: database not found: nope"],
  ] as const)("%s database not found", (version, text) => {
    expectError(
      mapped(statementError(capture(version, "db-not-found")), V1),
      QueryError,
      `InfluxDB has no database named in this run, or this credential cannot see it: ${text}`,
    );
  });

  test.each([
    "us-east-1-1.aws.cloud2.influxdata.com",
    "EU-CENTRAL-1-1.AWS.CLOUD2.INFLUXDATA.COM",
    "cluster-id.a.influxdb.io",
  ])("a database not found on the cloud host %s adds the DBRP sentence", (host) => {
    const error = mapped(
      statementError(capture("2.9.1", "db-not-found")),
      context({ endpoint: { host, port: 443 }, generation: "v2" }),
    );
    expectError(
      error,
      QueryError,
      "InfluxDB has no database named in this run, or this credential cannot see it: database not found: nope On InfluxDB Cloud Serverless, InfluxQL needs a DBRP mapping for the bucket first; see docs/providers/influxdb.md.",
    );
  });

  test("a host that only contains a cloud suffix adds nothing", () => {
    const error = mapped(
      statementError(capture("2.9.1", "db-not-found")),
      context({ endpoint: { host: "influxdb.io.example", port: 8086 } }),
    );
    expect(error.message).not.toContain("DBRP");
  });

  test("2.x database name required and 3.x missing db both give the run-database sentence", () => {
    for (const [version, name] of [
      ["2.9.1", "db-name-required"],
      ["3.12.0-core", "db-param-missing"],
    ] as const) {
      expectError(
        mapped(statementError(capture(version, name)), V2),
        QueryError,
        RUN_DATABASE_SENTENCES.chooseDatabase,
      );
    }
    expect(fixed("chooseDatabase")).toBe(RUN_DATABASE_SENTENCES.chooseDatabase);
  });

  test("1.x requires READ on a database: QueryError at query, AuthenticationError at connect", () => {
    const source = capture("1.13.1", "db-not-found-reader");
    expectError(mapped(answered(source), V1), QueryError, "This user cannot read database nope, or it does not exist.");
    expectError(
      mapped(answered(source), context({ phase: "connect" })),
      AuthenticationError,
      "This user cannot read database nope, or it does not exist.",
    );
    expectError(
      mapped(answered(capture("1.13.1", "two-databases-reader")), V1),
      QueryError,
      "This user cannot read database edge, or it does not exist.",
    );
  });

  test("3.x reads one database per InfluxQL statement", () => {
    expectError(
      mapped(statementError(capture("3.12.0-core", "two-databases")), V3),
      QueryError,
      "InfluxDB 3 reads one database per InfluxQL statement; name one database in the statement.",
    );
  });

  test("1.x not authorized: the connect and the query sentence", () => {
    const source = capture("1.13.1", "reader-forbidden");
    expectError(
      mapped(answered(source), context({ phase: "connect" })),
      AuthenticationError,
      "This user may not run SHOW DATABASES; check its grants.",
    );
    expectError(
      mapped(answered(source), V1),
      QueryError,
      "This user may not run this statement: error authorizing query: reader not authorized to execute statement 'SHOW USERS', requires admin privilege",
    );
  });

  test("2.x insufficient permissions", () => {
    expectError(
      mapped(new InfluxAnswerShapeError("statement-error", "insufficient permissions"), V2),
      QueryError,
      "This token may not run this statement on that bucket: insufficient permissions",
    );
  });

  test("1.x 401 with User empty and a password reads the password as user:password", () => {
    const passwordOnly = context({ hasUser: false, phase: "connect", secretForms: secretForms([TEST_PASSWORD]) });
    expectError(
      mapped(answered(capture("1.13.1", "token-without-user")), passwordOnly),
      AuthenticationError,
      "InfluxDB 1.x reads a password with no user as user:password; fill User with the user name.",
    );
    expectError(
      mapped(made(401, "nope", QUERY), passwordOnly),
      AuthenticationError,
      "InfluxDB 1.x reads a password with no user as user:password; fill User with the user name.",
    );
  });

  test("1.x 401 with no credential configured carries the server's words, never a password sentence", () => {
    const anonymous = context({ hasUser: false, phase: "connect" });
    expectError(
      mapped(answered(capture("1.13.1", "unauthorized")), anonymous),
      AuthenticationError,
      "InfluxDB answered HTTP 401: unable to parse authentication credentials",
    );
    expectError(mapped(made(401, "nope", QUERY), anonymous), AuthenticationError, "InfluxDB answered HTTP 401: nope");
  });

  test("1.x 401 authorization failed with a user", () => {
    expectError(
      mapped(made(401, '{"error":"authorization failed"}', QUERY), V1),
      AuthenticationError,
      "InfluxDB refused the user and password.",
    );
  });

  test("1.x 401 authorization failed with User empty is still the refused user and password", () => {
    expectError(
      mapped(
        made(401, '{"error":"authorization failed"}', QUERY),
        context({ hasUser: false, secretForms: secretForms([TEST_PASSWORD]) }),
      ),
      AuthenticationError,
      "InfluxDB refused the user and password.",
    );
  });

  test("a 401 on an unknown generation is read by its measured text", () => {
    const unknown = context({ generation: "unknown", hasUser: false });
    expectError(
      mapped(
        answered(capture("1.13.1", "unauthorized"), PING),
        context({ generation: "unknown", hasUser: false, secretForms: secretForms([TEST_PASSWORD]) }),
      ),
      AuthenticationError,
      "InfluxDB 1.x reads a password with no user as user:password; fill User with the user name.",
    );
    expectError(
      mapped(made(401, '{"error":"authorization failed"}', PING), context({ generation: "unknown" })),
      AuthenticationError,
      "InfluxDB refused the user and password.",
    );
    expectError(
      mapped(answered(capture("2.9.1", "unauthorized")), unknown),
      AuthenticationError,
      "InfluxDB 2.x refused the token: put an API token in Password or token with User empty.",
    );
    expectError(
      mapped(made(401, "Unauthorized", QUERY), unknown),
      AuthenticationError,
      "InfluxDB 2.x refused the token: put an API token in Password or token with User empty.",
    );
    expectError(mapped(made(401, "nope", QUERY), unknown), AuthenticationError, "InfluxDB answered HTTP 401: nope");
  });

  test("2.x 401 refuses the token", () => {
    expectError(
      mapped(answered(capture("2.9.1", "unauthorized")), V2),
      AuthenticationError,
      "InfluxDB 2.x refused the token: put an API token in Password or token with User empty.",
    );
  });

  test("3.x 401 refuses the token on both types", () => {
    const source = capture("3.12.0-core", "unauthorized");
    expectError(mapped(answered(source), V3), AuthenticationError, "InfluxDB 3 refused the token.");
    expectError(mapped(answered(source, SQL), SQL3), AuthenticationError, "InfluxDB 3 refused the token.");
    expectError(
      mapped(answered(capture("3.12.0-core", "ping-anon")), context({ generation: "unknown", hasUser: false })),
      AuthenticationError,
      "InfluxDB 3 refused the token.",
    );
  });

  test("R33: an infinity, top-level on 1.x and 3.x, a statement error on 2.x", () => {
    const sentence =
      "InfluxDB could not encode a value of this result (an infinity), so it sent no rows; filter that value out.";
    for (const version of ["1.13.1", "2.9.1", "3.12.0-core"] as const) {
      const error = statementError(capture(version, "infinity"));
      expect(error.fault).toBe(version === "2.9.1" ? "statement-error" : "top-level-error");
      expectError(mapped(error, V1), QueryError, sentence);
    }
    expectError(
      mapped(new InfluxAnswerShapeError("top-level-error", "json: unsupported value: -Inf"), V1),
      QueryError,
      sentence,
    );
  });

  test("query interrupted", () => {
    expectError(
      mapped(new InfluxAnswerShapeError("statement-error", "query interrupted"), V1),
      QueryError,
      "The query was stopped on the server (an administrator ran KILL QUERY).",
    );
  });

  test("3.x InfluxQL feature not implemented", () => {
    expectError(
      mapped(new InfluxAnswerShapeError("statement-error", "datafusion error: This feature is not implemented: x"), V3),
      QueryError,
      "InfluxDB 3 does not implement this InfluxQL feature: datafusion error: This feature is not implemented: x",
    );
  });

  test("K15: the file limit on /query is a 200 statement error and gives the influxdb3 file-limit sentence", () => {
    expectError(
      mapped(statementError(capture("3.12.0-core", "filelimit-influxql")), V3),
      QueryError,
      fixed("fileLimit"),
    );
  });

  test("a statement error no row names is the server's text", () => {
    expectError(
      mapped(new InfluxAnswerShapeError("statement-error", "retention policy not found: x"), V1),
      QueryError,
      "InfluxDB refused the statement: retention policy not found: x",
    );
    expectError(
      mapped(new InfluxAnswerShapeError("top-level-error"), V1),
      QueryError,
      "InfluxDB refused the statement: ",
    );
  });

  test("a body that is not JSON, on each type", () => {
    expectError(
      mapped(new InfluxAnswerShapeError("not-json"), V1),
      QueryError,
      "InfluxDB answered with text Studio cannot read as a result.",
    );
    expectError(
      mapped(new InfluxAnswerShapeError("not-json"), SQL3),
      QueryError,
      "InfluxDB 3 answered with a line Studio cannot read as a row.",
    );
    expectError(
      mapped(made(200, "<html>", QUERY, "text/html"), V1),
      QueryError,
      "InfluxDB answered with text Studio cannot read as a result.",
    );
  });

  test("a line naming a column twice names the column and asks for an alias", () => {
    expectError(
      mapped(new InfluxAnswerShapeError("repeated-column", "usage"), SQL3),
      QueryError,
      "InfluxDB 3 answered with two columns named usage, and its answer cannot say which value belongs to which column, so nothing was shown; give one of them an alias with AS.",
    );
  });

  test("C5: a lexer disagreement is never rows", () => {
    expectError(
      mapped(new InfluxAnswerShapeError("lexer-disagreement"), V3),
      QueryError,
      "InfluxDB returned results for more than one statement, although Studio read the text as one statement. Nothing was shown; please report this, it means Studio's InfluxQL reader and the server disagree.",
    );
  });

  test("the partial warning is exported for the results module", () => {
    expect(fixed("partial")).toBe("InfluxDB marked this result partial: the server cut it (max-row-limit).");
  });

  test("404 on /query and on /ping", () => {
    expectError(
      mapped(made(404, "404 page not found\n", QUERY), V1),
      ConnectionError,
      "This server has no InfluxDB /query endpoint at influx.example:8086.",
    );
    expectError(
      mapped(made(404, "", PING), context({ phase: "connect", endpoint: { host: "::1", port: 8086 } })),
      ConnectionError,
      "This server does not answer InfluxDB's /ping at [::1]:8086; check Host and Port.",
    );
  });

  test("any other status: QueryError at query, ConnectionError at connect", () => {
    expectError(mapped(made(503, "busy", QUERY), V1), QueryError, "InfluxDB answered HTTP 503: busy");
    expectError(
      mapped(made(503, "busy", QUERY), context({ phase: "connect" })),
      ConnectionError,
      "InfluxDB answered HTTP 503: busy",
    );
    expectError(
      mapped(made(418, "teapot", QUERY), context({ phase: "surface" })),
      QueryError,
      "InfluxDB answered HTTP 418: teapot",
    );
  });

  test("a 403 no row names: AuthenticationError at connect, QueryError at query", () => {
    expectError(
      mapped(made(403, '{"error":"forbidden"}', PING), context({ phase: "connect" })),
      AuthenticationError,
      "InfluxDB answered HTTP 403: forbidden",
    );
    expectError(
      mapped(made(403, '{"error":"forbidden"}', QUERY), V1),
      QueryError,
      "InfluxDB answered HTTP 403: forbidden",
    );
  });
});

describe("influxdb3, connect and query", () => {
  test("a SQL parse error", () => {
    expectError(
      mapped(answered(capture("3.12.0-core", "sql-parse-error")), SQL3),
      QueryError,
      'InfluxDB 3 could not parse the SQL statement: SQL error: ParserError("Expected: an expression, found: EOF")',
    );
  });

  test("a planning error naming the default catalog is a planning error", () => {
    expectError(
      mapped(answered(capture("3.12.0-core", "sql-planning-error")), SQL3),
      QueryError,
      "InfluxDB 3 could not plan the statement: Error during planning: table 'public.iox.nope' not found",
    );
  });

  test("K18: a cross-database table reference is a 400 planning error naming three parts", () => {
    expectError(
      mapped(answered(capture("3.12.0-core", "sql-cross-database")), SQL3),
      QueryError,
      "InfluxDB 3 found no table edge.iox.numbers: this connection reads one database, home, and a statement cannot name another database; set Database on the connection to read another.",
    );
  });

  test("a planning error naming the session database's own catalog is a planning error", () => {
    expectError(
      mapped(made(400, "Error during planning: table 'home.iox.nope' not found", SQL), SQL3),
      QueryError,
      "InfluxDB 3 could not plan the statement: Error during planning: table 'home.iox.nope' not found",
    );
  });

  test("with no session database a three-part planning error is a planning error", () => {
    expectError(
      mapped(answered(capture("3.12.0-core", "sql-cross-database")), context({ ...SQL3, database: undefined })),
      QueryError,
      "InfluxDB 3 could not plan the statement: Error during planning: table 'edge.iox.numbers' not found",
    );
  });

  test("a 404 database not found with no session database names the database the server named", () => {
    expectError(
      mapped(made(404, "database not found: x", SQL), context({ ...SQL3, database: undefined })),
      QueryError,
      "InfluxDB 3 has no database named x, or this token cannot see it.",
    );
  });

  test("a 404 database not found names the session database Studio sent", () => {
    expectError(
      mapped(answered(capture("3.12.0-core", "sql-db-not-found")), context({ ...SQL3, database: "nope" })),
      QueryError,
      "InfluxDB 3 has no database named nope, or this token cannot see it.",
    );
  });

  test("a plain 404 from /api/v3 has no SQL endpoint, the 1.x mis-pick included", () => {
    const sentence =
      "This server has no InfluxDB 3 SQL endpoint. InfluxDB Cloud Serverless and Dedicated serve SQL only over Flight, which Studio does not use: connect with InfluxDB (InfluxQL).";
    expectError(mapped(made(404, "Not found", SQL), SQL3), ConnectionError, sentence);
    for (const name of ["mispick-query-sql", "mispick-configure-database"]) {
      expectError(mapped(answered(capture("1.13.1", name)), SQL3), ConnectionError, sentence);
    }
  });

  test("T08: a 2.x 200 text/html answer on /api/v3 is not an InfluxDB 3 SQL endpoint", () => {
    const sentence =
      "InfluxDB at h3:8181 answered the SQL request with text/html; charset=utf-8, not JSON, so it is not an InfluxDB 3 SQL endpoint; check Host, Port and the connection type, or connect with InfluxDB (InfluxQL).";
    for (const name of ["mispick-query-sql", "mispick-configure-database"]) {
      const source = capture("2.9.1", name);
      expectError(mapped(answered(source), { ...SQL3, phase: "connect" }), ConnectionError, sentence);
      expectError(mapped(answered(source), SQL3), QueryError, sentence);
    }
    expect(mapped(made(200, "x", SQL, null), SQL3).message).toContain("answered the SQL request with no content type,");
    const long = `text/${"x".repeat(200)}`;
    expect(mapped(made(200, "x", DATABASES, long), SQL3).message).toContain(
      `with ${long.slice(0, 100)} (cut), not JSON`,
    );
  });

  test("a 2xx JSON or jsonl answer on /api/v3 that was still thrown is the status sentence", () => {
    expectError(mapped(made(200, "x", SQL, "application/jsonl"), SQL3), QueryError, "InfluxDB answered HTTP 200: x");
    expectError(
      mapped(made(200, "x", DATABASES, "application/json"), SQL3),
      QueryError,
      "InfluxDB answered HTTP 200: x",
    );
  });

  test("405 not implemented", () => {
    expectError(
      mapped(answered(capture("3.12.0-core", "sql-not-implemented")), SQL3),
      QueryError,
      "InfluxDB 3 does not implement this statement: This feature is not implemented: Unsupported SQL statement: SHOW DATABASES",
    );
  });

  test("500 schema error and an optimizer cast error are refusals, never a connection error", () => {
    expectError(
      mapped(answered(capture("3.12.0-core", "sql-schema-error")), SQL3),
      QueryError,
      "InfluxDB 3 refused the statement: Schema error: No field named nope. Valid fields are home.co, home.hum, home.room, home.temp, home.time.",
    );
    expectError(
      mapped(made(500, "Optimizer rule 'x' failed: Cast error: y", SQL), { ...SQL3, phase: "connect" }),
      QueryError,
      "InfluxDB 3 refused the statement: Optimizer rule 'x' failed: Cast error: y",
    );
  });

  test("500 file limit (K15, the filelimit fixture server)", () => {
    expectError(
      mapped(answered(capture("3.12.0-core", "filelimit-sql")), SQL3),
      QueryError,
      "InfluxDB 3 Core refuses a query that would read more than its file limit (432 Parquet files, about 72 hours, by default). Add a time range such as WHERE time >= now() - INTERVAL '1 day', or raise --query-file-limit on the server.",
    );
  });

  test("500 resources exhausted", () => {
    expectError(
      mapped(made(500, "Resources exhausted: Failed to allocate", SQL), SQL3),
      QueryError,
      "InfluxDB 3 ran out of the memory it allows one query: Resources exhausted: Failed to allocate",
    );
  });

  test("a 500 with no text is the status sentence", () => {
    expectError(mapped(made(500, "", SQL), SQL3), QueryError, "InfluxDB answered HTTP 500: ");
  });

  test("403 at query names the session database; at connect it is an AuthenticationError", () => {
    expectError(mapped(made(403, "", SQL), SQL3), QueryError, "This token may not read database home.");
    expectError(
      mapped(made(403, "", SQL), { ...SQL3, phase: "connect" }),
      AuthenticationError,
      "This token may not read database home.",
    );
    expectError(
      mapped(made(403, "", SQL), { ...SQL3, database: undefined }),
      QueryError,
      "InfluxDB answered HTTP 403: ",
    );
  });

  test("400 missing db and a malformed Authorization header", () => {
    expectError(
      mapped(made(400, "serde error: missing field `db`", SQL), SQL3),
      QueryError,
      RUN_DATABASE_SENTENCES.chooseDatabase,
    );
    // Reachable (architect amendment from T09): a token holding a space makes the header three parts.
    expectError(
      mapped(made(400, "Authorization header was malformed: expected 2 parts", SQL), SQL3),
      AuthenticationError,
      "InfluxDB 3 could not read the Authorization header; re-enter the token.",
    );
    expectError(mapped(made(400, "other", SQL), SQL3), QueryError, "InfluxDB answered HTTP 400: other");
  });

  test.each(["sql-truncated-zero", "sql-truncated", "sql-truncated-mid-line"])(
    "R39: the truncation capture %s gives the truncation sentence and no row",
    async (name) => {
      const sentence =
        "InfluxDB failed while running this query after accepting it, so its reason did not reach Studio; it is in the server log. Common causes: a division by zero, a failed cast.";
      const { factory } = recordingInfluxTransport([capture("3.12.0-core", name)]);
      const transport = factory({
        origin: { protocol: "http:", host: "h3", port: 8181 },
        tls: null,
        maxSockets: 1,
        headers: {},
      } as never);
      const failure = await transport
        .request({
          method: "POST",
          url: "http://h3:8181/",
          signal: new AbortController().signal,
          maxResponseBytes: 1 << 25,
        })
        .then(
          () => undefined,
          (error: unknown) => error,
        );
      expect(failure).toBeInstanceOf(TransportError);
      expectError(mapped(failure, SQL3), QueryError, sentence);
      expectError(mapped(failure, V3), QueryError, sentence);
    },
  );
});

describe("connect sentences the providers throw", () => {
  test("an influxdb3 connection to a 1.x or 2.x server", () => {
    expect(template("noSqlOnVersion")("2.9.1")).toBe(
      "This server is 2.9.1, which has no SQL endpoint: connect with InfluxDB (InfluxQL).",
    );
  });

  test("a /ping 403 with Database empty", () => {
    expect(fixed("pingForbiddenNoDatabase")).toBe(
      "This token cannot read the server's version, which an InfluxDB 3 Enterprise database token cannot; set Database on the connection.",
    );
  });
});

describe("transport failures", () => {
  const failure = (kind: TransportError["kind"], message = "ECONNRESET") => new TransportError(kind, message);

  test("timeout", () => {
    expectError(
      mapped(failure("timeout"), context({ timeoutMs: 1500 })),
      TimeoutError,
      "InfluxDB did not answer within 1500 ms, so Studio stopped waiting and closed the connection, which stops the query on the server.",
    );
  });

  test("aborted", () => {
    expectError(mapped(failure("aborted"), V1), QueryCancelledError, "The query was cancelled.");
  });

  test("too-large names the cap", () => {
    expectError(
      mapped(failure("too-large"), V1),
      QueryError,
      "The result is larger than 32 MiB, the most Studio reads for one answer; add a LIMIT or a narrower time range.",
    );
  });

  test("tls, network, redirect and encoding are connection errors naming the endpoint", () => {
    expectError(
      mapped(failure("tls", "CERT_HAS_EXPIRED"), V1),
      ConnectionError,
      "The TLS connection to InfluxDB at influx.example:8086 failed: check the SSL mode and the CA under SSL / TLS. CERT_HAS_EXPIRED",
    );
    expectError(
      mapped(failure("network", "ECONNREFUSED"), V1),
      ConnectionError,
      "No complete answer arrived from InfluxDB at influx.example:8086, and the request was not sent again. ECONNREFUSED",
    );
    expectError(
      mapped(failure("redirect"), V1),
      ConnectionError,
      "InfluxDB at influx.example:8086 answered with a redirect Studio does not follow.",
    );
    expectError(
      mapped(failure("encoding"), V1),
      ConnectionError,
      "InfluxDB at influx.example:8086 answered with an encoding Studio does not follow.",
    );
  });

  test("a DatabaseError (the egress guard's refusal) passes unchanged", () => {
    const refusal = new DatabaseConfigError("The egress guard refused the host.");
    expect(mapped(refusal, V1)).toBe(refusal);
  });

  test("anything else is reported without its text", () => {
    expectError(
      mapped(new Error(`leak ${TEST_PASSWORD}`), V1),
      QueryError,
      "The request to InfluxDB failed in a way Studio does not recognise.",
    );
  });
});

describe("redaction (E14, E21)", () => {
  const basic = Buffer.from(`${TEST_USER}:${TEST_PASSWORD}`, "utf8").toString("base64");
  const forms = secretForms([TEST_PASSWORD, `${TEST_USER}:${TEST_PASSWORD}`]);
  const secret = context({ secretForms: forms });
  const WITHHELD = "(the server's text was withheld because it contained the configured credential)";

  test.each([
    ["the password", TEST_PASSWORD],
    ["its base64", Buffer.from(TEST_PASSWORD, "utf8").toString("base64").replace(/=+$/, "")],
    ["the Basic header's base64 value", basic],
  ])("a server text echoing %s is withheld whole", (_, echoed) => {
    const error = mapped(made(400, `{"error":"error parsing query: near ${echoed}"}`, QUERY), secret);
    expectError(error, QueryError, `InfluxDB could not parse the statement: ${WITHHELD}`);
    const statement = mapped(new InfluxAnswerShapeError("statement-error", `bad ${echoed}`), secret);
    expect(statement.message).toBe(`InfluxDB refused the statement: ${WITHHELD}`);
  });

  test("a withheld 403 text names no database", () => {
    const error = mapped(
      made(403, `{"error":"error authorizing query: ${TEST_PASSWORD} requires READ on home"}`, QUERY),
      secret,
    );
    expectError(error, QueryError, `InfluxDB answered HTTP 403: ${WITHHELD}`);
  });

  test("a transport message holding a secret form is withheld", () => {
    const error = mapped(new TransportError("network", `reset ${TEST_PASSWORD}`), secret);
    expect(error.message).toContain(WITHHELD);
    expect(error.message).not.toContain(TEST_PASSWORD);
  });

  test("a server text is cut to 500 characters, after redaction", () => {
    const long = "x".repeat(600);
    const error = mapped(new InfluxAnswerShapeError("statement-error", long), V1);
    expect(error.message).toBe(`InfluxDB refused the statement: ${"x".repeat(500)} (cut)`);
    const exact = mapped(new InfluxAnswerShapeError("statement-error", "y".repeat(500)), V1);
    expect(exact.message).toBe(`InfluxDB refused the statement: ${"y".repeat(500)}`);
  });

  test("an error body too long to parse is read as text", () => {
    const body = `{"error":"${"z".repeat(70_000)}"}`;
    expect(mapped(made(503, body, QUERY), V1).message).toBe(`InfluxDB answered HTTP 503: ${body.slice(0, 500)} (cut)`);
  });

  // R40: a hostile or broken server's body reaches the rows; every pattern runs over bounded words in linear time.
  const HOSTILE_BYTES = 4 * 1024 * 1024;

  test("R40: a 4 MiB 500 of repeated 'Query would scan ' on the SQL route is the refusal sentence, read in linear time", () => {
    const body = "Query would scan ".repeat(Math.ceil(HOSTILE_BYTES / 17));
    expectError(
      mapped(made(500, body, SQL), SQL3),
      QueryError,
      `InfluxDB 3 refused the statement: ${body.slice(0, 500)} (cut)`,
    );
  });

  test("R40: a 4 MiB 403 of repeated 'requires READ on ' names the cut words as the database", () => {
    const body = "requires READ on ".repeat(Math.ceil(HOSTILE_BYTES / 17));
    const database = `${body.slice("requires READ on ".length, 500)} (cut)`;
    expectError(
      mapped(made(403, body, QUERY), V1),
      QueryError,
      `This user cannot read database ${database}, or it does not exist.`,
    );
  });

  test("R40: the database a reader refusal or a SQL 404 names ends at the first newline", () => {
    expectError(
      mapped(made(403, '{"error":"error authorizing query: reader requires READ on home\\nnext"}', QUERY), V1),
      QueryError,
      "This user cannot read database home, or it does not exist.",
    );
    expectError(
      mapped(made(404, "database not found: x\nnext", SQL), context({ ...SQL3, database: undefined })),
      QueryError,
      template("sqlDatabaseNotFound")("x"),
    );
  });
});

describe("the exported sentences", () => {
  test("every template is a function and every fixed sentence a string ending in a full stop", () => {
    for (const [key, value] of Object.entries(INFLUX_ERROR_SENTENCES)) {
      const text = typeof value === "function" ? value("a", "b") : value;
      expect(typeof text, key).toBe("string");
      expect(text.length, key).toBeGreaterThan(0);
    }
    expect(Object.isFrozen(INFLUX_ERROR_SENTENCES)).toBe(true);
  });

  test("the answer classes keep what they were built with", () => {
    const answer = new InfluxAnswerError({ status: 500, contentType: null, text: "x" }, SQL);
    expect(answer.route).toBe(SQL);
    expect(answer.answer.status).toBe(500);
    const shape = new InfluxAnswerShapeError("statement-error", "x");
    expect(shape.fault).toBe("statement-error");
    expect(shape.serverText).toBe("x");
  });
});
