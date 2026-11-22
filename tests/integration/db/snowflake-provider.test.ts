/**
 * Snowflake provider, end to end over the fixtures.
 *
 * The real provider, account reader, key intake and JWT signer, transport lanes, statements, row reader, decoder,
 * object surface, panels and error table all run; only Snowflake is fake. The fake is the scripted node transport of
 * `tests/helpers/snowflake-node-transport.ts`, handed to the provider through its `deps` in place of the shared
 * `createNodeTransport` and `createNodeByteTransport`, so every request goes through the transport's seam and is
 * answered from a fixture. Time is injected (`testDeps`): the clock moves only when a test moves it, and no deadline
 * fires unless a test fires it. `mock.module()` is not used, no real timer runs and no socket opens.
 *
 * The payloads are a capture: `tests/fixtures/snowflake/trial-2026-10-12-v10.37.100/` is what a Snowflake trial
 * account answered on 2026-10-12, `CURRENT_VERSION()` 10.37.100, Enterprise edition, AWS EU_CENTRAL_2, recorded by
 * `tests/live/snowflake-evidence.ts` and scrubbed. Snowflake releases weekly, so that version is the capture's, not a
 * pin. Each case replays the captured scenario of its subject and asserts the captured answers; a scenario the
 * provider stops at a refusal holds a `stopped` record naming the statement it stopped at, and nothing after it.
 *
 * Each scenario's requests are checked against the fixture's, in order: the method, the path and its query (a
 * submit's `requestId` is the run's own), and the whole body. What is BUILT, each answer in the shape the capture
 * shows, and why:
 * - the role check's columns past `R` and `S` (the user since SF-005, the database, schema and warehouse since SF-019): the capture sent the two-column check, so
 *   `load()` widens every captured role check to `SNOWFLAKE_ROLE_CHECK_SQL`, its added cells answered as the account
 *   answers that connection (`widenRoleCheck`);
 * - every submit body without `parameters.timezone`: the capture sent `timezone: "UTC"`, which Studio stopped sending
 *   so statements run in the user's own TIMEZONE (SF-009), so `load()` takes it out (`withoutTimezone`);
 * - the role check answering another role: the account refuses a role the credentials may not use at connect with
 *   390186 (`refusal-390186`, `role-restricted-pat-show`), so no captured role check answers another role;
 * - a role holding no warehouse (391920): the account answers it only with secondary roles off, which this capture
 *   does not set; the code, status and message are the orchestrator's manual probe of 2026-10-13, which does not
 *   record which request answered, so the refusal is on the status GET as the captured 422 refusals are;
 * - active secondary roles on the key-pair user (`role-check-secondary` is not captured): the cell takes the shape
 *   M38 records;
 * - a suspended warehouse under the panels: `monitoring-suspended` and its twin without MONITOR ran on a warehouse
 *   the scenario before them had started, so their state read answers STARTED; the SUSPENDED row is M25's, captured
 *   on the same warehouse in step 1;
 * - a 403 gateway page (`refusal-403` needs a request from an address the network policy refuses) and a status GET of
 *   a gone handle (`refusal-404` needs a result older than Snowflake keeps);
 * - the other dashboard panels, the inventory and a view's source, answered in the test itself
 *   (`tests/helpers/snowflake-answers.ts`);
 * - the partition past the result budget, a small gzipped body that inflates past 16 MiB (a 16 MiB body cannot be a
 *   fixture; the 1 GiB decompression bomb is `tests/unit/db/snowflake/wire-heap.test.ts`'s), a status link to another
 *   host, the answers that echo a sentinel PAT, passphrase or JWT, the 10,000-character server message, a transport
 *   failure, and the extra status GET that hangs so a run is in flight when a test cancels it or disconnects.
 *
 * The private-host case of the address policy (a PrivateLink name resolving to 10.0.0.5 under
 * DB_HTTP_BLOCK_PRIVATE_HOSTS) needs the real transport and a stubbed resolver, so it is in
 * `tests/unit/db/snowflake/security-control.test.ts`, not here.
 *
 * Every provider a test builds is disconnected after it, so no permit of the process-wide engine limiter is left held
 * for the next test.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createErrorResponse } from "@/lib/api/errors";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
} from "@/lib/db/errors";
import { TransportError } from "@/lib/db/http/node-transport";
import { SNOWFLAKE_KEY_SENTENCES } from "@/lib/db/providers/sql/snowflake/auth";
import { SNOWFLAKE, SNOWFLAKE_ERROR_SENTENCES } from "@/lib/db/providers/sql/snowflake/errors";
import { SnowflakeProvider } from "@/lib/db/providers/sql/snowflake/index";
import { SNOWFLAKE_INTROSPECT_SENTENCES, SNOWFLAKE_KIND_IDS } from "@/lib/db/providers/sql/snowflake/introspect";
import { SNOWFLAKE_MONITORING_SENTENCES } from "@/lib/db/providers/sql/snowflake/monitoring";
import { SNOWFLAKE_ROWS_SENTENCES } from "@/lib/db/providers/sql/snowflake/rows";
import { SNOWFLAKE_ROLE_CHECK_SQL, SNOWFLAKE_STATEMENT_SENTENCES } from "@/lib/db/providers/sql/snowflake/statements";
import { MAX_UNLIMITED_ROWS } from "@/lib/db/utils/query-limiter";
import { historyMaskOf, maskStatementForHistory } from "@/lib/history-mask";
import { logger } from "@/lib/logger";
import type { DatabaseConnection } from "@/lib/types";
import { ALLOWS_PRIVATE_HOSTS } from "../../helpers/egress-decisions";
import { handleAnswer, resultAnswer } from "../../helpers/snowflake-answers";
import { KEY_TEST_PASSPHRASE, pbes2Pbkdf2Pem, pkcs8Pem, rsaKey } from "../../helpers/snowflake-keys";
import {
  deferredAnswer,
  fakeClock,
  type RecordedRequest,
  type ScriptedAnswer,
  scriptedTransports,
  testDeps,
} from "../../helpers/snowflake-node-transport";

// ============================================================================
// The fixtures
// ============================================================================

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures", "snowflake", "trial-2026-10-12-v10.37.100");

interface FixtureConnection {
  readonly user: string;
  readonly authMethod: "keypair" | "pat";
  readonly role: string;
  readonly warehouse: string;
  readonly database: string;
  readonly schema: string;
}

interface FixtureExchange {
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: Record<string, unknown>;
  };
  readonly response: {
    readonly status: number;
    readonly headers: Readonly<Record<string, string>>;
    readonly body: Record<string, unknown>;
    readonly rows?: { readonly firstRow: readonly (string | null)[] };
  };
}

interface Scenario {
  readonly scenario: string;
  readonly connection: FixtureConnection;
  readonly exchanges: readonly FixtureExchange[];
  /** Present when the provider stops at a refusal: the statement it stopped at, counted from 0. */
  readonly stopped?: { readonly statement: number; readonly sql: string; readonly reason: string };
}

/** A configured name as the account answers it once resolved (the capture's names are unquoted), or null when empty. */
const named = (value: string): string | null => (value.trim() === "" ? null : value.toUpperCase());

/** The role check as the capture sent it, before the columns Studio's check added since were in it. */
const CAPTURED_ROLE_CHECK = "SELECT CURRENT_ROLE() AS r, CURRENT_SECONDARY_ROLES() AS s";

/**
 * The columns the role check reads past the captured two, each with the cell the account answers for the scenario's
 * connection: on the trial every user's NAME is its login name upper-cased. BUILT, in the captured columns' shape.
 */
const ROLE_CHECK_ADDED: readonly { readonly name: string; readonly cell: (c: FixtureConnection) => string | null }[] = [
  { name: "U", cell: (connection) => connection.user.toUpperCase() },
  { name: "D", cell: (connection) => named(connection.database) },
  { name: "C", cell: (connection) => named(connection.schema) },
  { name: "W", cell: (connection) => named(connection.warehouse) },
];

type Row = readonly (string | null)[];

/**
 * The scenario with its captured role check widened to `SNOWFLAKE_ROLE_CHECK_SQL`: the statement in the submit's
 * body, and the added columns and cells in the answer that carries the check's `R` and `S` columns. BUILT.
 */
function widenRoleCheck(scenario: Scenario): Scenario {
  if (scenario.connection === undefined) return scenario;
  const exchanges = scenario.exchanges.map((exchange) => {
    const { request, response } = exchange;
    if (request.body?.statement === CAPTURED_ROLE_CHECK) {
      return { ...exchange, request: { ...request, body: { ...request.body, statement: SNOWFLAKE_ROLE_CHECK_SQL } } };
    }
    const meta = response.body.resultSetMetaData as { rowType?: { name: string }[] } | undefined;
    const rowType = meta?.rowType;
    if (rowType?.length !== 2 || rowType[0].name !== "R" || rowType[1].name !== "S") return exchange;
    const cells = ROLE_CHECK_ADDED.map((column) => column.cell(scenario.connection));
    const body = {
      ...response.body,
      resultSetMetaData: {
        ...meta,
        rowType: rowType.concat(ROLE_CHECK_ADDED.map((column) => Object.assign({}, rowType[1], { name: column.name }))),
      },
      data: (response.body.data as Row[]).map((row) => row.concat(cells)),
    };
    return { ...exchange, response: { ...response, body } };
  });
  return { ...scenario, exchanges };
}

/**
 * The scenario with `parameters.timezone` taken out of every captured request body: the trial captured
 * `timezone: "UTC"`, which Studio no longer sends, so each statement runs in the user's own TIMEZONE (SF-009). Every
 * other field is compared as recorded. BUILT.
 */
function withoutTimezone(scenario: Scenario): Scenario {
  const exchanges = scenario.exchanges.map((exchange) => {
    const body = exchange.request.body as { parameters?: Record<string, unknown> } | undefined;
    if (body?.parameters === undefined || !("timezone" in body.parameters)) return exchange;
    const parameters = { ...body.parameters };
    delete parameters.timezone;
    return { ...exchange, request: { ...exchange.request, body: { ...exchange.request.body, parameters } } };
  });
  return { ...scenario, exchanges };
}

const load = (name: string): Scenario =>
  withoutTimezone(widenRoleCheck(JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as Scenario));

/** A fixture's answer as the scripted transport gives it: a partition compressed again, a non-JSON body as text. */
function answerOf(response: FixtureExchange["response"]): ScriptedAnswer {
  const { status, headers, body } = response;
  if (headers["content-encoding"] === "gzip") {
    return { status, bytes: gzipSync(JSON.stringify(body)), contentEncoding: "gzip" };
  }
  const keys = Object.keys(body);
  if (keys.length === 1 && keys[0] === "text") return { status, text: String(body.text) };
  return { status, json: body };
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Scripts every exchange of the scenario, each answered once, in order, by its method and exact path. */
function replay(entry: Built, scenario: Scenario, exchanges: readonly FixtureExchange[] = scenario.exchanges): void {
  for (const exchange of exchanges) {
    const path = new URL(exchange.request.path, "https://fixture.invalid").pathname;
    entry.transports.answer(
      { method: exchange.request.method, path: new RegExp(`^${escapeRegExp(path)}$`) },
      answerOf(exchange.response),
    );
  }
}

/** The exchanges with one 200 answer's rows replaced. BUILT, in the captured answer's shape. */
function withRows(
  exchanges: readonly FixtureExchange[],
  index: number,
  data: readonly (readonly (string | null)[])[],
): FixtureExchange[] {
  return exchanges.map((exchange, at) =>
    at === index
      ? { ...exchange, response: { ...exchange.response, body: { ...exchange.response.body, data } } }
      : exchange,
  );
}

/** The index of the role check's status answer in every captured connect: the SHOW, its GET, the check, its GET. */
const ROLE_CHECK_ANSWER = 3;

/** A scenario whose role check answers `role` with the secondary roles cell `secondary`, its other cells kept. BUILT. */
function roleCheckAnswering(scenario: Scenario, role: string, secondary: string): Scenario {
  const [captured] = scenario.exchanges[ROLE_CHECK_ANSWER].response.body.data as Row[];
  return {
    ...scenario,
    exchanges: withRows(scenario.exchanges, ROLE_CHECK_ANSWER, [[role, secondary, ...captured.slice(2)]]),
  };
}

/** The secondary roles cell with none active, as connect-pat captured it, and in M38's shape with `roles` active. */
const NO_SECONDARY = '{"roles":"","value":""}';
const secondaryCell = (roles: string): string => JSON.stringify({ roles, value: "ALL" });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What the provider sent equals what the fixture records: method, path, query and body, in order. */
function expectRequests(recorded: readonly RecordedRequest[], exchanges: readonly FixtureExchange[]): void {
  expect(recorded.map((request) => `${request.method} ${new URL(request.url).pathname}`)).toEqual(
    exchanges.map((exchange) => `${exchange.request.method} ${exchange.request.path.split("?")[0]}`),
  );
  recorded.forEach((request, index) => {
    const expected = exchanges[index].request;
    const sent = new URL(request.url);
    const wanted = new URL(expected.path, "https://fixture.invalid");
    if (wanted.searchParams.has("requestId")) {
      expect(sent.searchParams.get("async")).toBe("true");
      expect(sent.searchParams.get("requestId") ?? "").toMatch(UUID);
      expect([...sent.searchParams.keys()]).toEqual([...wanted.searchParams.keys()]);
    } else {
      expect(sent.search).toBe(wanted.search);
    }
    expect(request.headers["x-snowflake-authorization-token-type"]).toBe(
      expected.headers["x-snowflake-authorization-token-type"],
    );
    if (expected.body === undefined) expect(request.body).toBeUndefined();
    else expect(JSON.parse(request.body ?? "null")).toEqual(expected.body);
  });
}

/** A refused scenario stopped where the capture stopped: its last exchange is the stopped statement's refusal. */
function expectStopped(scenario: Scenario, sql: string): void {
  expect(scenario.stopped).toEqual({ statement: expect.any(Number), sql, reason: "refused" });
  expect(scenario.exchanges.at(-1)?.response.status).toBeGreaterThanOrEqual(400);
}

// ============================================================================
// The providers
// ============================================================================

const KEY = rsaKey();
const PEM = pkcs8Pem(KEY);
const ACCOUNT = "acmeorg-probeacct";
const PAT = "sentinel-pat-7f3c9a1e5b2d4c6a8e0f";

function connectionFor(fixture: FixtureConnection, overrides: Record<string, unknown> = {}): DatabaseConnection {
  return {
    id: "snowflake-integration",
    name: "Snowflake",
    type: SNOWFLAKE,
    host: ACCOUNT,
    user: fixture.user,
    role: fixture.role,
    warehouse: fixture.warehouse,
    database: fixture.database,
    schema: fixture.schema,
    authMethod: fixture.authMethod,
    ...(fixture.authMethod === "keypair" ? { privateKey: PEM } : { password: PAT }),
    createdAt: new Date(0),
    ...overrides,
  } as DatabaseConnection;
}

interface Built {
  readonly provider: SnowflakeProvider;
  readonly transports: ReturnType<typeof scriptedTransports>;
  readonly deps: ReturnType<typeof testDeps>;
  readonly clock: ReturnType<typeof fakeClock>;
  readonly connection: DatabaseConnection;
}

const built: Built[] = [];

function build(connection: DatabaseConnection): Built {
  const transports = scriptedTransports();
  const clock = fakeClock();
  const deps = testDeps(transports, clock);
  const entry = {
    provider: new SnowflakeProvider(connection, {}, { egress: ALLOWS_PRIVATE_HOSTS }, deps),
    transports,
    deps,
    clock,
    connection,
  };
  built.push(entry);
  return entry;
}

/** A provider for the scenario's connection, with every exchange of the scenario scripted. */
function replayed(
  name: string | Scenario,
  overrides: Record<string, unknown> = {},
): { entry: Built; scenario: Scenario } {
  const scenario = typeof name === "string" ? load(name) : name;
  const entry = build(connectionFor(scenario.connection, overrides));
  replay(entry, scenario);
  return { entry, scenario };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Fires every deadline asked for, again and again, until `promise` settles. */
async function settle(entry: Built, promise: Promise<unknown>): Promise<void> {
  let settled = false;
  const done = promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  for (let round = 0; round < 50; round += 1) {
    if (settled) break;
    entry.deps.deadlines.requested.forEach((_, index) => entry.deps.deadlines.fire(index));
    // oxlint-disable-next-line no-await-in-loop -- each round lets the runs react before the next fire.
    await tick();
  }
  await done;
}

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a rejection");
}

const bodyOf = (request: RecordedRequest): Record<string, unknown> => JSON.parse(request.body ?? "{}");
const statementsSent = (entry: Built): string[] =>
  entry.transports.requests.filter((request) => request.body !== undefined).map((r) => String(bodyOf(r).statement));
const bearerOf = (request: RecordedRequest): string => (request.headers.authorization ?? "").replace(/^Bearer /, "");

// The logger and the console are watched for every sentinel; nothing is printed while the tests run.
const LOG_METHODS = ["debug", "info", "warn", "error"] as const;
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;
let spies: ReturnType<typeof spyOn>[] = [];

beforeAll(() => {
  spies = [
    ...LOG_METHODS.map((method) => spyOn(logger, method).mockImplementation(() => {})),
    ...CONSOLE_METHODS.map((method) => spyOn(console, method).mockImplementation(() => {})),
  ];
});
afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});
afterEach(async () => {
  for (const entry of built.splice(0)) {
    // oxlint-disable-next-line no-await-in-loop -- each provider releases its permits before the next.
    await settle(entry, entry.provider.disconnect());
  }
  for (const spy of spies) spy.mockClear();
});

/** Everything printed so far, through the logger or the console, as one text. */
const printed = (): string =>
  spies
    .flatMap((spy) => spy.mock.calls)
    .map((call) => JSON.stringify(call))
    .join("\n");

/** The reader's captured role check names STUDIO_NOWH as an active secondary role, so its connections caution so. */
const READER_SECONDARY = { message: SNOWFLAKE_STATEMENT_SENTENCES.secondaryRoles("STUDIO_NOWH", "STUDIO_RO") };

// ============================================================================
// Connect
// ============================================================================

describe("connect", () => {
  test("by key pair: the SHOW WAREHOUSES LIKE and the role check, each polled once, signed with a key-pair JWT, and no caution", async () => {
    const { entry, scenario } = replayed("connect-keypair");
    await entry.provider.connect();
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(statementsSent(entry)).toEqual(["SHOW WAREHOUSES LIKE 'STUDIO_PROBE_WH'", SNOWFLAKE_ROLE_CHECK_SQL]);
    for (const request of entry.transports.requests)
      expect(bearerOf(request)).toMatch(/^eyJ[\w-]+\.eyJ[\w-]+\.[\w-]+$/);
    expect(entry.provider.isConnected()).toBe(true);
    expect(entry.provider.connectWarnings()).toEqual([]);
  });

  test("by PAT: the token is the bearer itself, typed as a programmatic access token", async () => {
    const { entry, scenario } = replayed("connect-pat");
    await entry.provider.connect();
    expectRequests(entry.transports.requests, scenario.exchanges);
    for (const request of entry.transports.requests) expect(bearerOf(request)).toBe(PAT);
    expect(entry.provider.isConnected()).toBe(true);
    expect(entry.provider.connectWarnings()).toEqual([]);
  });

  test("by PAT with User naming another user: the role check's CURRENT_USER() refuses the connect (SF-005)", async () => {
    const { entry } = replayed("connect-pat", { user: "studio_svc" });
    const error = await caught(entry.provider.connect());
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as Error).message).toBe(SNOWFLAKE_ERROR_SENTENCES.tokenUserMismatch("STUDIO_PAT", "studio_svc"));
    expect(statementsSent(entry)).toEqual(["SHOW WAREHOUSES LIKE 'STUDIO_PROBE_WH'", SNOWFLAKE_ROLE_CHECK_SQL]);
    expect(entry.provider.isConnected()).toBe(false);
  });

  test("a Database and Schema that do not resolve: Test Connection cautions on the database (SF-019, BUILT)", async () => {
    // Measured 2026-10-14: the check under database D_NODB and schema D_NOSCHEMA answers NULL for both names.
    const captured = load("connect-keypair");
    const [row] = captured.exchanges[ROLE_CHECK_ANSWER].response.body.data as Row[];
    const scenario = {
      ...captured,
      exchanges: withRows(captured.exchanges, ROLE_CHECK_ANSWER, [[...row.slice(0, 3), null, null, row[5]]]),
    };
    const { entry } = replayed(scenario, { database: "D_NODB", schema: "D_NOSCHEMA" });
    await entry.provider.connect();
    expect(entry.provider.isConnected()).toBe(true);
    expect(entry.provider.connectWarnings()).toEqual([
      {
        code: "SNOWFLAKE_UNRESOLVED_DATABASE",
        message: SNOWFLAKE_STATEMENT_SENTENCES.unresolvedDatabase("D_NODB", "STUDIO_RW"),
      },
    ]);
  });

  test("browse-only, with no warehouse field: Test Connection succeeds with the empty-warehouse and secondary-role cautions", async () => {
    const { entry, scenario } = replayed("connect-no-warehouse");
    expect(scenario.connection.warehouse).toBe("");
    await entry.provider.connect();
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(statementsSent(entry)).toEqual(["SHOW DATABASES LIMIT 1", SNOWFLAKE_ROLE_CHECK_SQL]);
    expect(entry.transports.requests.every((request) => bodyOf(request).warehouse === undefined)).toBe(true);
    expect(entry.provider.isConnected()).toBe(true);
    expect(entry.provider.connectWarnings()).toEqual([
      { message: SNOWFLAKE_INTROSPECT_SENTENCES.emptyWarehouse },
      READER_SECONDARY,
    ]);
  });
});

// ============================================================================
// The refusals of the error table
// ============================================================================

describe("each refusal the fixtures hold, with its class and its sentence", () => {
  test("390144: the key pair is refused at the connect SHOW, naming a statement that registers the key", async () => {
    const { entry, scenario } = replayed("refusal-390144");
    const error = (await caught(entry.provider.connect())) as AuthenticationError;
    expectStopped(scenario, "SHOW WAREHOUSES LIKE 'STUDIO_PROBE_WH'");
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(error).toBeInstanceOf(AuthenticationError);
    // The account answered "JWT token is invalid. null": no login-failure id, so the sentence names none.
    expect(scenario.exchanges[0].response.body.message).toBe("JWT token is invalid. null");
    expect(error.message).toStartWith(
      "Snowflake refused the key pair (JWT token is invalid) for ACMEORG-PROBEACCT.STUDIO_READER: no user has this login name, or the key whose fingerprint is SHA256:",
    );
    expect(error.message).not.toContain("PUBLIC_KEY");
    expect(error.message).not.toContain("SYSTEM$GET_LOGIN_FAILURE_DETAILS");
    expect(error.fixStatement).toMatch(
      /^ALTER USER <name> ADD KEY PAIR libredb_studio_[0-9a-f]{8} PUBLIC_KEY = '[A-Za-z0-9+/=]+'$/,
    );
    expect(entry.provider.isConnected()).toBe(false);
  });

  test("390186: a role the user does not hold is refused at HTTP 400 on the connect submit, naming the Role field and the grant", async () => {
    const { entry, scenario } = replayed("refusal-390186");
    const error = await caught(entry.provider.connect());
    expectStopped(scenario, "SHOW WAREHOUSES LIKE 'STUDIO_PROBE_WH'");
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(scenario.exchanges[0].response.status).toBe(400);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toBe(
      SNOWFLAKE_ERROR_SENTENCES.roleRefused("STUDIO_NOWH", "studio_svc", "STUDIO_NOWH", "studio_svc"),
    );
    expect(entry.provider.isConnected()).toBe(false);
  });

  test("403: the SQL API or a network policy refused the request, read from the status alone (BUILT)", async () => {
    const entry = build(connectionFor(load("connect-keypair").connection));
    entry.transports.answer(
      { method: "POST", path: /^\/api\/v2\/statements$/ },
      { status: 403, text: "<html><body>403 Forbidden</body></html>" },
    );
    const error = await caught(entry.provider.connect());
    expect(entry.transports.requests).toHaveLength(1);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toBe(SNOWFLAKE_ERROR_SENTENCES.forbidden);
  });

  test("391920: a role that can use no warehouse, with secondary roles off, is refused at the statement (BUILT)", async () => {
    // The orchestrator's manual probe of 2026-10-13: studio_reader as STUDIO_NOWH, no warehouse field, secondary
    // roles off; the role check answers, and a statement that needs compute is refused at HTTP 422.
    const scenario = roleCheckAnswering(load("connect-no-warehouse"), "STUDIO_NOWH", NO_SECONDARY);
    const { entry } = replayed(scenario, { role: "STUDIO_NOWH" });
    entry.transports.answer({ method: "POST", path: /^\/api\/v2\/statements$/ }, handleAnswer());
    entry.transports.answer(
      { method: "GET", path: /^\/api\/v2\/statements\/[^/]+$/ },
      {
        status: 422,
        json: {
          code: "391920",
          message:
            "Unable to run the command. You must specify the warehouse to use by either setting the warehouse field in the body of the request or by setting the DEFAULT_NAMESPACE property for the current user.",
          statementHandle: "00000000-0000-0000-0000-000000000391",
        },
      },
    );
    await entry.provider.connect();
    expect(entry.provider.connectWarnings()).toEqual([{ message: SNOWFLAKE_INTROSPECT_SENTENCES.emptyWarehouse }]);
    const sql = "SELECT SUM(SEQ8() * UNIFORM(1, 10, RANDOM())) FROM TABLE(GENERATOR(ROWCOUNT => 5000000))";
    const error = await caught(entry.provider.query(sql));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(SNOWFLAKE_ERROR_SENTENCES.noWarehouse);
  });

  const statementRefusals: readonly (readonly [string, string, (message: string) => string])[] = [
    [
      "refusal-002003",
      "SELECT * FROM STUDIO_DEMO.PROBE.MISSING",
      (message) => SNOWFLAKE_ERROR_SENTENCES.objectMissing("STUDIO_RO", "'STUDIO_RO'", message),
    ],
    [
      "refusal-003001",
      "INSERT INTO STUDIO_DEMO.PROBE.WIDE (C01) VALUES (1)",
      (message) => SNOWFLAKE_ERROR_SENTENCES.privileges("STUDIO_RO", message),
    ],
    [
      "refusal-422",
      "SELECT * FORM STUDIO_DEMO.PROBE.WIDE",
      (message) => SNOWFLAKE_ERROR_SENTENCES.statementFailed(message, "001003", "42000"),
    ],
  ];
  test.each(statementRefusals)(
    "%s: a QueryError with its sentence, after the connect and its role check",
    async (name, sql, sentence) => {
      const { entry, scenario } = replayed(name);
      await entry.provider.connect();
      const error = (await caught(entry.provider.query(sql))) as QueryError;
      expectStopped(scenario, sql);
      expectRequests(entry.transports.requests, scenario.exchanges);
      expect(scenario.exchanges.at(-1)?.response.status).toBe(422);
      expect(error).toBeInstanceOf(QueryError);
      expect(error.message).toBe(sentence(String(scenario.exchanges.at(-1)?.response.body.message)));
      expect(error.query).toBe(sql);
    },
  );

  test("404 on the first submit: an account the host does not have, not a gone result (BUILT, SF-011)", async () => {
    const connect = load("refusal-422");
    const entry = build(connectionFor(connect.connection));
    entry.transports.answer(
      { method: "POST", path: /^\/api\/v2\/statements$/ },
      { status: 404, text: "<html><body>File not Found</body></html>" },
    );
    const error = await caught(entry.provider.connect());
    expect(error).toBeInstanceOf(ConnectionError);
    expect(error.message).toBe(SNOWFLAKE_ERROR_SENTENCES.accountNotFound(`${ACCOUNT}.snowflakecomputing.com`));
    expect(error.message).not.toBe(SNOWFLAKE_ERROR_SENTENCES.resultGone);
    expect(entry.transports.requests).toHaveLength(1);
  });

  test("404: the status GET of a handle whose result Snowflake no longer holds (BUILT)", async () => {
    const connect = load("refusal-422");
    const entry = build(connectionFor(connect.connection));
    replay(entry, connect, connect.exchanges.slice(0, 4));
    entry.transports.answer({ method: "POST", path: /^\/api\/v2\/statements$/ }, handleAnswer());
    entry.transports.answer(
      { method: "GET", path: /^\/api\/v2\/statements\/[^/]+$/ },
      {
        status: 404,
        json: {
          code: "333333",
          sqlState: "02000",
          message: "Statement not found.",
          statementHandle: "00000000-0000-0000-0000-000000000404",
        },
      },
    );
    await entry.provider.connect();
    const sql = "SELECT C01 FROM STUDIO_DEMO.PROBE.WIDE";
    const error = (await caught(entry.provider.query(sql))) as QueryError;
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(SNOWFLAKE_ERROR_SENTENCES.resultGone);
    expect(error.query).toBe(sql);
  });
});

// ============================================================================
// The tree and describe
// ============================================================================

describe("the tree and describe under the read-only role", () => {
  test("databases, one database's schemas and each kind of one schema, every read a SHOW", async () => {
    const { entry, scenario } = replayed("tree-show");
    await entry.provider.connect();
    const databases = await entry.provider.listContainers([]);
    const schemas = await entry.provider.listContainers(["STUDIO_DEMO"]);
    const listings: Record<string, string[]> = {};
    for (const kind of SNOWFLAKE_KIND_IDS) {
      // oxlint-disable-next-line no-await-in-loop -- the fixture answers the kinds in order.
      listings[kind] = (await entry.provider.listObjects(["STUDIO_DEMO", "PROBE"], kind)).map((object) =>
        object.path.join("."),
      );
    }
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(
      statementsSent(entry)
        .slice(2)
        .every((sql) => sql.startsWith("SHOW ")),
    ).toBe(true);
    expect(databases.map((database) => [database.name, database.isSessionDefault])).toEqual([
      ["SNOWFLAKE", false],
      ["SNOWFLAKE_LEARNING_DB", false],
      ["SNOWFLAKE_SAMPLE_DATA", false],
      ["STUDIO_DEMO", true],
    ]);
    expect(schemas.map((schema) => [schema.path, schema.isSessionDefault])).toEqual([
      [["STUDIO_DEMO", "INFORMATION_SCHEMA"], false],
      [["STUDIO_DEMO", "PROBE"], true],
    ]);
    expect(listings).toEqual({
      table: ["STUDIO_DEMO.PROBE.BIG", "STUDIO_DEMO.PROBE.EVERY_TYPE", "STUDIO_DEMO.PROBE.WIDE"],
      view: ["STUDIO_DEMO.PROBE.EVERY_TYPE_MV", "STUDIO_DEMO.PROBE.EVERY_TYPE_V"],
      stream: [],
      task: [],
      sequence: [],
      stage: [],
      "file-format": [],
      pipe: [],
      function: [],
      // SHOW PROCEDURES IN SCHEMA answered 33 built-in SYSTEM$ procedures and none of the schema's own.
      procedure: [],
    });
    const procedures = scenario.exchanges[27].response.body.data as string[][];
    expect(procedures).toHaveLength(33);
    expect(procedures.every((row) => row[3] === "Y")).toBe(true);
  });

  test("a table's statuses and row hints, and a materialized view's status", async () => {
    const { entry } = replayed("tree-show");
    await entry.provider.connect();
    await entry.provider.listContainers([]);
    await entry.provider.listContainers(["STUDIO_DEMO"]);
    const tables = await entry.provider.listObjects(["STUDIO_DEMO", "PROBE"], "table");
    const views = await entry.provider.listObjects(["STUDIO_DEMO", "PROBE"], "view");
    expect(tables.map((table) => [table.name, table.status, table.rowCount])).toEqual([
      ["BIG", undefined, 2_000_000],
      ["EVERY_TYPE", undefined, 5],
      ["WIDE", undefined, 1],
    ]);
    expect(views.map((view) => [view.name, view.status])).toEqual([
      ["EVERY_TYPE_MV", "materialized"],
      ["EVERY_TYPE_V", undefined],
    ]);
  });

  test("a table's columns in catalog spelling, no primary key, and no index on a table that is not hybrid", async () => {
    const { entry, scenario } = replayed("describe-columns");
    await entry.provider.connect();
    const detail = await entry.provider.describeObject(["STUDIO_DEMO", "PROBE", "EVERY_TYPE"], "table");
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(detail.columns.map((column) => [column.name, column.type, column.nullable])).toEqual([
      ["ID", "NUMBER(38,0)", false],
      ["N38", "NUMBER(38,0)", true],
      ["N_SCALED", "NUMBER(38,10)", true],
      ["I", "NUMBER(38,0)", true],
      ["F", "FLOAT", true],
      ["DF", "DECFLOAT(38)", true],
      ["VC", "VARCHAR(100)", true],
      ["CH", "VARCHAR(3)", true],
      ["BIN", "BINARY(8388608)", true],
      ["B", "BOOLEAN", true],
      ["D", "DATE", true],
      ["T", "TIME(9)", true],
      ["TS_NTZ", "TIMESTAMP_NTZ(9)", true],
      ["TS_LTZ", "TIMESTAMP_LTZ(9)", true],
      ["TS_TZ", "TIMESTAMP_TZ(9)", true],
      ["V", "VARIANT", true],
      ["O", "OBJECT", true],
      ["A", "ARRAY", true],
      ["SO", "OBJECT(city VARCHAR(16777216), zip NUMBER(38,0))", true],
      ["SA", "ARRAY(NUMBER(38,0))", true],
      ["M", "MAP(VARCHAR(16777216), NUMBER(38,0))", true],
      ["GEOG", "GEOGRAPHY", true],
      ["GEOM", "GEOMETRY", true],
      ["U", "UUID", true],
      ["VEC", "VECTOR(FLOAT, 3)", true],
      ["FL", "FILE", true],
    ]);
    // SHOW PRIMARY KEYS answered no row: the table declares none.
    expect(scenario.exchanges[7].response.body.data).toEqual([]);
    expect(detail.columns.every((column) => column.isPrimary === false)).toBe(true);
    expect(detail.indexes).toEqual([]);
    expect(detail.foreignKeys).toEqual([]);
  });
});

// ============================================================================
// Results
// ============================================================================

/** Rows of an ID and a 1,000-character pad, gzipped, decoding to more than the 16 MiB budget. BUILT. */
function pastTheBudget(): ScriptedAnswer {
  const row = (n: number) => `["${n}","${"0".repeat(1_000)}"]`;
  const rows = Array.from({ length: 17_500 }, (_, index) => row(8_193 + index)).join(",");
  return { status: 200, bytes: gzipSync(Buffer.from(`{"data":[${rows}]}`)), contentEncoding: "gzip" };
}

const PARTITIONS_SQL = "SELECT ID, PAD FROM STUDIO_DEMO.PROBE.BIG ORDER BY ID LIMIT 8200";

describe("a result in two partitions", () => {
  test("partition 0 inline with 8,192 rows, then partition 1 fetched gzipped, 8,200 rows whole", async () => {
    const { entry, scenario } = replayed("partitions");
    await entry.provider.connect();
    const result = await entry.provider.query(PARTITIONS_SQL);
    expectRequests(entry.transports.requests, scenario.exchanges);
    const info = (scenario.exchanges[5].response.body.resultSetMetaData as { partitionInfo: { rowCount: number }[] })
      .partitionInfo;
    expect(info.map((partition) => partition.rowCount)).toEqual([8_192, 8]);
    expect(scenario.exchanges[6].response.headers["content-encoding"]).toBe("gzip");
    expect(entry.transports.requests.at(-1)?.lane).toBe(-1);
    expect(entry.transports.requests.at(-1)?.url).toEndWith("?partition=1");
    expect(result.rows).toHaveLength(8_200);
    expect(result.rows[0]).toEqual({ ID: 1, PAD: "pad-0000001" });
    expect(result.rows[8_191].ID).toBe(8_192);
    expect(result.rows[8_199]).toEqual({ ID: 8_200, PAD: "pad-0008200" });
    expect(result.warnings).toBeUndefined();
    expect(result.pagination).toBeUndefined();
  });

  test("a partition past the budget ends as the cut, with its warning and pagination saying it was limited (BUILT)", async () => {
    const scenario = load("partitions");
    const entry = build(connectionFor(scenario.connection));
    replay(entry, scenario, scenario.exchanges.slice(0, -1));
    entry.transports.answer({ method: "GET", path: /^\/api\/v2\/statements\/[^/]+$/ }, pastTheBudget());
    await entry.provider.connect();
    const result = await entry.provider.query(PARTITIONS_SQL);
    expect(entry.transports.requests.at(-1)?.url).toEndWith("?partition=1");
    expect(result.rows.length).toBeGreaterThan(8_192);
    expect(result.rows.length).toBeLessThan(8_192 + 17_500);
    expect(result.warnings).toEqual([{ message: SNOWFLAKE_ROWS_SENTENCES.byteCut(8_200) }]);
    expect(result.pagination).toEqual({
      limit: MAX_UNLIMITED_ROWS,
      offset: 0,
      hasMore: false,
      totalReturned: result.rows.length,
      wasLimited: true,
    });
  });
});

describe("every type of the type table", () => {
  test("each cell decoded and each column typed in catalog spelling, and a row of NULLs read as NULL", async () => {
    const { entry, scenario } = replayed("every-type");
    await entry.provider.connect();
    const result = await entry.provider.query("SELECT * FROM STUDIO_DEMO.PROBE.EVERY_TYPE ORDER BY 1 NULLS LAST");
    expectRequests(entry.transports.requests, scenario.exchanges);
    // The SQL API's rowType names a structured, geospatial or FILE column `object` and a UUID `text`; a geospatial
    // one also carries `extTypeName`, which types it GEOGRAPHY or GEOMETRY (SF-033). Describe reads the catalog's full
    // spelling from SHOW COLUMNS.
    expect(result.columnTypes).toEqual({
      ID: "NUMBER(38,0)",
      N38: "NUMBER(38,0)",
      N_SCALED: "NUMBER(38,10)",
      I: "NUMBER(38,0)",
      F: "FLOAT",
      DF: "DECFLOAT",
      VC: "VARCHAR(100)",
      CH: "VARCHAR(3)",
      BIN: "BINARY",
      B: "BOOLEAN",
      D: "DATE",
      T: "TIME(9)",
      TS_NTZ: "TIMESTAMP_NTZ(9)",
      TS_LTZ: "TIMESTAMP_LTZ(9)",
      TS_TZ: "TIMESTAMP_TZ(9)",
      V: "VARIANT",
      O: "OBJECT",
      A: "ARRAY",
      SO: "OBJECT",
      SA: "ARRAY",
      M: "OBJECT",
      GEOG: "GEOGRAPHY",
      GEOM: "GEOMETRY",
      U: "VARCHAR",
      VEC: "VECTOR",
      FL: "OBJECT",
    });
    expect(Object.keys(result.columnTypes ?? {})).toHaveLength(26);
    expect(result.rows).toHaveLength(5);
    const wire = scenario.exchanges[5].response.body.data as (string | null)[][];
    const columns = Object.keys(result.columnTypes ?? {});
    // The semi-structured, geospatial, UUID, VECTOR and FILE cells are their wire text verbatim, never parsed, so
    // ARRAY's `undefined` element passes as Snowflake wrote it.
    const verbatim = ["V", "O", "A", "SO", "SA", "M", "GEOG", "GEOM", "U", "VEC", "FL"];
    result.rows.forEach((row, at) => {
      for (const name of verbatim)
        expect({ name, cell: row[name] }).toEqual({ name, cell: wire[at][columns.indexOf(name)] });
    });
    expect(wire[0][columns.indexOf("A")]).toBe('[\n  1,\n  "two",\n  undefined\n]');
    const decoded = result.rows.map((row) =>
      Object.fromEntries(
        Object.entries(row)
          .filter(([name]) => !verbatim.includes(name))
          .map(([name, cell]) => [name, Buffer.isBuffer(cell) ? `0x${cell.toString("hex")}` : cell]),
      ),
    );
    const nulls = (id: number, f: string | null) => ({
      ID: id,
      N38: null,
      N_SCALED: null,
      I: null,
      F: f,
      DF: null,
      VC: null,
      CH: null,
      BIN: null,
      B: null,
      D: null,
      T: null,
      TS_NTZ: null,
      TS_LTZ: null,
      TS_TZ: null,
    });
    expect(decoded).toEqual([
      {
        ID: 1,
        N38: "9007199254740993",
        N_SCALED: "12345.6789012345",
        I: 42,
        // The wire text 3.1415899999999999 read as a number.
        F: Number("3.1415899999999999"),
        DF: "12345678901234567890.123456789012345678",
        VC: "hello snowflake",
        CH: "abc",
        BIN: "0xcafebabe",
        B: true,
        D: "2021-01-28",
        T: "22:09:37.123456789",
        TS_NTZ: "2021-01-28 22:09:37.123456789",
        TS_LTZ: "2021-01-28 22:09:37.123456789+00:00",
        TS_TZ: "2021-01-28 22:09:37.123456789+01:00",
      },
      {
        ID: 2,
        N38: "99999999999999999999999999999999999999",
        N_SCALED: "-0.0000000001",
        I: -1,
        F: "NaN",
        DF: "-0.000000000000000000000000000001",
        VC: "x",
        CH: "x",
        BIN: "0x",
        B: false,
        D: "0001-01-01",
        T: "00:00:00.000000000",
        TS_NTZ: "1969-12-31 23:59:58.500000000",
        TS_LTZ: "1969-12-31 23:59:58.500000000+00:00",
        TS_TZ: "2021-01-28 22:09:37.123456789-05:30",
      },
      nulls(3, "Infinity"),
      nulls(4, "-Infinity"),
      nulls(5, null),
    ]);
    expect(Object.entries(result.rows[4]).every(([name, cell]) => name === "ID" || cell === null)).toBe(true);
  });
});

// ============================================================================
// Cancel, the role check, the panels and the role-restricted PAT
// ============================================================================

describe("a cancel", () => {
  test("a running statement cancelled by its id sends one cancel by handle and ends as cancelled", async () => {
    const scenario = load("cancel");
    const entry = build(connectionFor(scenario.connection));
    replay(entry, scenario);
    entry.transports.answer({ method: "GET", path: /^\/api\/v2\/statements\/[^/]+$/ }, { hang: true });
    await entry.provider.connect();
    const outcome = caught(entry.provider.query("SELECT SYSTEM$WAIT(120)", undefined, "q-cancel"));
    await entry.transports.received(scenario.exchanges.length);
    expect(entry.provider.hasRunsInFlight()).toBe(true);
    expect(await entry.provider.cancelQuery("q-cancel")).toBe(true);
    const error = await outcome;
    expect(error).toBeInstanceOf(QueryCancelledError);
    const sent = entry.transports.requests;
    // The fixture's exchanges, with the hanging status GET the cancel interrupted before the cancel itself.
    expectRequests([...sent.slice(0, -2), sent.at(-1) as RecordedRequest], scenario.exchanges);
    expect(sent.filter((request) => request.url.endsWith("/cancel"))).toHaveLength(1);
    expect(entry.provider.hasRunsInFlight()).toBe(false);
  });
});

describe("the role check", () => {
  test("the configured role answered: the check runs in connect, once, and the statement follows", async () => {
    const { entry, scenario } = replayed("role-check-match");
    await entry.provider.connect();
    const result = await entry.provider.query("SELECT 1 AS N");
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(statementsSent(entry).filter((sql) => sql.includes("CURRENT_ROLE()"))).toHaveLength(1);
    expect(result.rows).toEqual([{ N: 1 }]);
    expect(result.warnings).toBeUndefined();
    expect(entry.provider.connectWarnings()).toEqual([]);
  });

  test("another role answered: the connect fails and no statement is sent after the check (BUILT)", async () => {
    const scenario = roleCheckAnswering(load("role-check-match"), "STUDIO_RO", NO_SECONDARY);
    const { entry } = replayed(scenario);
    const error = await caught(entry.provider.connect());
    expectRequests(entry.transports.requests, scenario.exchanges.slice(0, 4));
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toBe(SNOWFLAKE_ERROR_SENTENCES.roleMismatch("STUDIO_RO", "STUDIO_RW"));
    expect(entry.provider.isConnected()).toBe(false);
  });

  test("active secondary roles put their caution on the connect warnings (BUILT)", async () => {
    const scenario = roleCheckAnswering(load("role-check-match"), "STUDIO_RW", secondaryCell("STUDIO_RO"));
    const { entry } = replayed(scenario);
    await entry.provider.connect();
    expect(entry.provider.connectWarnings()).toEqual([
      { message: SNOWFLAKE_STATEMENT_SENTENCES.secondaryRoles("STUDIO_RO", "STUDIO_RW") },
    ]);
    const result = await entry.provider.query("SELECT 1 AS N");
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(result.rows).toEqual([{ N: 1 }]);
  });
});

/** The scenario with its panel state read answering M25's captured SUSPENDED row of the same warehouse. BUILT. */
function suspended(name: string): Scenario {
  const scenario = load(name);
  const row = load("M25").exchanges[1].response.rows?.firstRow ?? [];
  expect(row.slice(0, 2)).toEqual(["STUDIO_PROBE_WH", "SUSPENDED"]);
  // The capture's own state read: on a warehouse the scenario before it had started.
  expect((scenario.exchanges[5].response.body.data as string[][])[0][1]).toBe("STARTED");
  return { ...scenario, exchanges: withRows(scenario.exchanges, 5, [row]) };
}

describe("the monitoring panels", () => {
  test("on a running warehouse: a fresh state read, then the Information Schema statement, polled until it answers", async () => {
    const { entry, scenario } = replayed("monitoring-started");
    await entry.provider.connect();
    const metrics = await entry.provider.getPerformanceMetrics();
    expectRequests(entry.transports.requests, scenario.exchanges);
    // 363 statements in the last hour.
    expect(metrics).toEqual({ queriesPerSecond: 0.1 });
  });

  test("on a running warehouse, by a role without MONITOR: the same two statements, and the count it may see", async () => {
    const { entry, scenario } = replayed("monitoring-started-without-monitor");
    await entry.provider.connect();
    const metrics = await entry.provider.getPerformanceMetrics();
    expectRequests(entry.transports.requests, scenario.exchanges);
    // 96 statements in the last hour: without MONITOR, the role sees only its user's own.
    expect(metrics).toEqual({ queriesPerSecond: 0.03 });
  });

  test.each(["monitoring-suspended", "monitoring-suspended-without-monitor"])(
    "%s: the state read only, no Information Schema statement, and the panel's sentence (the SUSPENDED row BUILT)",
    async (name) => {
      const { entry, scenario } = replayed(suspended(name));
      await entry.provider.connect();
      const error = await caught(entry.provider.getPerformanceMetrics());
      expectRequests(entry.transports.requests, scenario.exchanges);
      expect(error).toBeInstanceOf(QueryError);
      expect(error.message).toBe(SNOWFLAKE_MONITORING_SENTENCES.suspended("STUDIO_PROBE_WH"));
      expect(statementsSent(entry).some((sql) => sql.includes("INFORMATION_SCHEMA"))).toBe(false);
    },
  );
});

describe("the dashboard's other panels, the inventory and a view's source", () => {
  /** One statement's two answers in the captured shapes: the 333334 submit, then its rows on the status GET. */
  const statement = (entry: Built, columns: readonly string[], rows: readonly (readonly (string | null)[])[]) => {
    entry.transports.answer({ method: "POST", path: /^\/api\/v2\/statements$/ }, handleAnswer());
    entry.transports.answer(
      { method: "GET", path: /^\/api\/v2\/statements\/[^/]+$/ },
      resultAnswer({ columns: columns.map((name) => ({ name, type: "text" })), rows }),
    );
  };
  const WAREHOUSE = ["name", "state", "size", "running", "queued"];

  test("each panel sends its statement through the provider, and storage answers its sentence with none", async () => {
    const { entry } = replayed("connect-keypair");
    await entry.provider.connect();
    entry.transports.requests.splice(0);
    statement(entry, WAREHOUSE, [["STUDIO_PROBE_WH", "STARTED", "X-Small", "1", "0"]]);
    statement(entry, ["name"], [["STUDIO_DEMO"]]);
    statement(entry, ["name"], [["E_TYPES"]]);
    statement(entry, ["name"], []);
    const overview = await entry.provider.getOverview();
    expect(overview.version).toBe(
      "Snowflake: 1 databases visible to role STUDIO_RW; warehouse STUDIO_PROBE_WH STARTED, X-Small, 1 running and 0 queued, Studio's own reads included",
    );
    expect([overview.tableCount, overview.indexCount]).toEqual([1, 0]);
    statement(entry, WAREHOUSE, [["STUDIO_PROBE_WH", "STARTED", "X-Small", "1", "0"]]);
    statement(
      entry,
      ["QUERY_ID", "QUERY_TEXT", "TOTAL_ELAPSED_TIME", "ROWS_PRODUCED"],
      [["q1", "SELECT 1", "12", "1"]],
    );
    expect((await entry.provider.getSlowQueries({ limit: 5 })).map((row) => [row.queryId, row.totalTime])).toEqual([
      ["q1", 12],
    ]);
    statement(entry, WAREHOUSE, [["STUDIO_PROBE_WH", "STARTED", "X-Small", "1", "0"]]);
    statement(
      entry,
      ["QUERY_ID", "USER_NAME", "DATABASE_NAME", "EXECUTION_STATUS", "QUERY_TEXT", "START_TIME", "MS"],
      [["q2", "STUDIO_SVC", "STUDIO_DEMO", "RUNNING", "SELECT 2", "0", "1500"]],
    );
    expect((await entry.provider.getActiveSessions({ limit: 5 })).map((row) => [row.pid, row.state])).toEqual([
      ["q2", "running"],
    ]);
    statement(entry, ["name", "rows", "bytes"], [["EVERY_TYPE", "2", "4096"]]);
    expect((await entry.provider.getTableStats()).map((row) => [row.tableName, row.rowCount])).toEqual([
      ["EVERY_TYPE", 2],
    ]);
    statement(entry, ["name", "table", "kind", "columns", "is_unique"], []);
    const indexes = await caught(entry.provider.getIndexStats());
    expect(indexes.message).toBe(SNOWFLAKE_MONITORING_SENTENCES.noIndexes);
    const storage = await caught(entry.provider.getStorageStats());
    expect(storage.message).toBe(SNOWFLAKE_MONITORING_SENTENCES.storage);
    const sent = statementsSent(entry);
    expect(sent.filter((sql) => sql.startsWith("SHOW WAREHOUSES"))).toHaveLength(3);
    expect(sent.at(-1)).toBe('SHOW INDEXES IN SCHEMA "STUDIO_DEMO"."PROBE"');
    expect(entry.transports.requests.filter((request) => request.body !== undefined)).toHaveLength(sent.length);
  });

  test("the inventory reads one schema's tables and their columns, and a view's source comes from SHOW VIEWS", async () => {
    const { entry } = replayed("connect-keypair");
    await entry.provider.connect();
    entry.transports.requests.splice(0);
    statement(entry, ["name", "kind"], [["EVERY_TYPE", "TABLE"]]);
    statement(
      entry,
      ["table_name", "column_name", "data_type"],
      [["EVERY_TYPE", "ID", '{"type":"FIXED","precision":38,"scale":0,"nullable":false}']],
    );
    const batch = await entry.provider.describeObjects(["STUDIO_DEMO", "PROBE"], "table", 10);
    expect(batch.details.map((detail) => [detail.path.join("."), detail.columns.map((column) => column.type)])).toEqual(
      [["STUDIO_DEMO.PROBE.EVERY_TYPE", ["NUMBER(38,0)"]]],
    );
    statement(
      entry,
      ["name", "text", "is_secure"],
      [["EVERY_TYPE_V", "CREATE VIEW EVERY_TYPE_V AS SELECT 1", "false"]],
    );
    const source = await entry.provider.readObjectSource(["STUDIO_DEMO", "PROBE", "EVERY_TYPE_V"], "view");
    expect(source.parts[0]).toMatchObject({ text: "CREATE VIEW EVERY_TYPE_V AS SELECT 1" });
    expect(statementsSent(entry).every((sql) => sql.startsWith("SHOW "))).toBe(true);
  });
});

describe("a status link to another host", () => {
  test("is refused with its sentence and never requested (BUILT)", async () => {
    const scenario = load("role-check-match");
    const entry = build(connectionFor(scenario.connection));
    replay(entry, scenario, scenario.exchanges.slice(0, 4));
    await entry.provider.connect();
    const accepted = handleAnswer("00000000-0000-0000-0000-00000000f001");
    entry.transports.answer(
      { method: "POST", path: /^\/api\/v2\/statements$/ },
      {
        ...accepted,
        json: {
          ...(accepted.json as Record<string, unknown>),
          statementStatusUrl: "https://elsewhere.invalid/api/v2/statements/00000000-0000-0000-0000-00000000f001",
        },
      },
    );
    const error = await caught(entry.provider.query("SELECT 2 AS N"));
    expect(error.message).toBe(SNOWFLAKE_STATEMENT_SENTENCES.foreignLink);
    expect(entry.transports.requests.some((request) => request.url.includes("elsewhere.invalid"))).toBe(false);
  });
});

describe("a role-restricted PAT with another configured role", () => {
  test("is refused at connect with 390186, and the SHOW after it is never sent", async () => {
    const { entry, scenario } = replayed("role-restricted-pat-show");
    const error = await caught(entry.provider.connect());
    expectStopped(scenario, "SHOW WAREHOUSES LIKE 'STUDIO_PROBE_WH'");
    expectRequests(entry.transports.requests, scenario.exchanges);
    expect(bearerOf(entry.transports.requests[0])).toBe(PAT);
    expect(bodyOf(entry.transports.requests[0]).role).toBe("STUDIO_NOWH");
    expect(scenario.exchanges[0].response.body.code).toBe("390186");
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toBe(SNOWFLAKE_ERROR_SENTENCES.tokenRoleRefused("STUDIO_NOWH", "studio_pat"));
    expect(error.message).not.toContain("GRANT");
    expect(statementsSent(entry)).not.toContain('SHOW TABLES IN SCHEMA "STUDIO_DEMO"."PROBE"');
    expect(entry.provider.isConnected()).toBe(false);
  });
});

// ============================================================================
// A role is the provider's own
// ============================================================================

describe("two providers, two roles", () => {
  test("each puts its own role, as Snowflake resolves it, in every recorded body", async () => {
    // Each role check answers the provider's own role, folded as Snowflake names it. BUILT on role-check-match.
    const roles: readonly (readonly [string, string])[] = [
      ["STUDIO_RW", "STUDIO_RW"],
      ['"Studio ""Mixed"" Role"', 'Studio "Mixed" Role'],
    ];
    const entries = roles.map(([role, folded]) => {
      const scenario = roleCheckAnswering(load("role-check-match"), folded, NO_SECONDARY);
      return replayed(scenario, { role }).entry;
    });
    for (const entry of entries) {
      // oxlint-disable-next-line no-await-in-loop -- each provider runs its own script.
      await entry.provider.connect();
      // oxlint-disable-next-line no-await-in-loop -- the statement is the third the provider sends.
      await entry.provider.query("SELECT 1 AS N");
    }
    entries.forEach((entry, index) => {
      const bodies = entry.transports.requests.filter((request) => request.body !== undefined);
      expect(bodies).toHaveLength(3);
      for (const request of bodies) {
        expect(bodyOf(request).role).toBe(roles[index][1]);
        expect(request.body).toContain(`"role":${JSON.stringify(roles[index][1])}`);
      }
    });
  });
});

// ============================================================================
// No secret in any failure's text
// ============================================================================

interface Leak {
  readonly where: string;
  readonly text: string;
}

/** The error, the route's error body and the history entry the client would store, as texts. */
async function surfaces(error: Error, sql: string, provider: SnowflakeProvider): Promise<Leak[]> {
  const body = (await createErrorResponse(error).json()) as { error: string };
  const mask = historyMaskOf(provider.getCapabilities());
  const history = {
    query: maskStatementForHistory(sql, mask),
    errorMessage: maskStatementForHistory(body.error, mask),
  };
  return [
    { where: "the error", text: JSON.stringify({ ...error, message: error.message, stack: error.stack }) },
    { where: "the route body", text: JSON.stringify(body) },
    { where: "the history entry", text: JSON.stringify(history) },
    { where: "the log", text: printed() },
  ];
}

async function expectNoSentinel(error: Error, sql: string, provider: SnowflakeProvider, sentinels: string[]) {
  expect(sentinels.every((sentinel) => sentinel.length >= 8)).toBe(true);
  for (const { where, text } of await surfaces(error, sql, provider)) {
    for (const sentinel of sentinels)
      expect({ where, holds: text.includes(sentinel) }).toEqual({ where, holds: false });
  }
}

/** A 422 failure answer whose message the test writes. BUILT. */
const failed422 = (message: string): ScriptedAnswer => ({
  status: 422,
  json: { code: "001003", sqlState: "42000", message, statementHandle: "00000000-0000-0000-0000-000000000123" },
});

describe("every failure path with sentinel credentials", () => {
  const SVC = load("connect-keypair").connection;
  const PAT_USER = load("connect-pat").connection;
  const PASSPHRASE = "sentinel-passphrase-41b7c2";
  const ENCRYPTED = pbes2Pbkdf2Pem(KEY, KEY_TEST_PASSPHRASE, 1_000);
  const pemBody = (pem: string): string => pem.split("\n")[1] as string;

  test("a key that is not a key: refused before any socket, the key's text in no surface", async () => {
    const body = "U0VOVElORUwta2V5LWJvZHktOWQ0ZTFhN2M=";
    const entry = build(
      connectionFor(SVC, { privateKey: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----` }),
    );
    const error = await caught(entry.provider.connect());
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(entry.transports.requests).toHaveLength(0);
    await expectNoSentinel(error, "", entry.provider, [body]);
  });

  test("a wrong passphrase: its fixed sentence, the passphrase in no surface", async () => {
    const entry = build(connectionFor(SVC, { privateKey: ENCRYPTED, privateKeyPassphrase: PASSPHRASE }));
    const error = await caught(entry.provider.connect());
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(SNOWFLAKE_KEY_SENTENCES.wrongPassphrase);
    expect(entry.transports.requests).toHaveLength(0);
    await expectNoSentinel(error, "", entry.provider, [PASSPHRASE, pemBody(ENCRYPTED)]);
  });

  test("an encrypted key without a passphrase: its fixed sentence, the key in no surface", async () => {
    const entry = build(connectionFor(SVC, { privateKey: ENCRYPTED }));
    const error = await caught(entry.provider.connect());
    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(error.message).toBe(SNOWFLAKE_KEY_SENTENCES.needsPassphrase);
    await expectNoSentinel(error, "", entry.provider, [pemBody(ENCRYPTED)]);
  });

  test("a 401 whose body echoes the PAT", async () => {
    const entry = build(connectionFor(PAT_USER));
    entry.transports.answer(
      { method: "POST", path: /^\/api\/v2\/statements$/ },
      { status: 401, json: { code: "390303", message: `Invalid OAuth access token. ${PAT}` } },
    );
    const error = await caught(entry.provider.connect());
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.message).toBe(SNOWFLAKE_ERROR_SENTENCES.patRefused);
    await expectNoSentinel(error, "", entry.provider, [PAT]);
  });

  test("a 401 whose body echoes the JWT it was sent", async () => {
    const entry = build(connectionFor(SVC));
    const answer = deferredAnswer();
    entry.transports.answer({ method: "POST", path: /^\/api\/v2\/statements$/ }, answer.answer);
    const outcome = caught(entry.provider.connect());
    await entry.transports.received(1);
    const jwt = bearerOf(entry.transports.requests[0]);
    answer.resolve({ status: 401, json: { code: "390144", message: `JWT token is invalid. ${jwt}` } });
    const error = await outcome;
    expect(error).toBeInstanceOf(AuthenticationError);
    await expectNoSentinel(error, "", entry.provider, [jwt]);
  });

  test("a 422 whose body echoes the PAT", async () => {
    const sql = "SELECT 1 FORM DUAL";
    const scenario = load("connect-pat");
    const entry = build(connectionFor(PAT_USER));
    replay(entry, scenario);
    entry.transports.answer({ method: "POST", path: /^\/api\/v2\/statements$/ }, handleAnswer());
    entry.transports.answer({ method: "GET", path: /^\/api\/v2\/statements\/[^/]+$/ }, failed422(`near ${PAT}`));
    await entry.provider.connect();
    const error = await caught(entry.provider.query(sql));
    expect(error).toBeInstanceOf(QueryError);
    await expectNoSentinel(error, sql, entry.provider, [PAT]);
  });

  test("a 422 whose body echoes the JWT in use", async () => {
    const sql = "SELECT 1 FORM DUAL";
    const entry = build(connectionFor(SVC));
    replay(entry, load("connect-keypair"));
    const answer = deferredAnswer();
    entry.transports.answer({ method: "POST", path: /^\/api\/v2\/statements$/ }, handleAnswer());
    entry.transports.answer({ method: "GET", path: /^\/api\/v2\/statements\/[^/]+$/ }, answer.answer);
    await entry.provider.connect();
    const outcome = caught(entry.provider.query(sql));
    await entry.transports.received(6);
    const jwt = bearerOf(entry.transports.requests[5]);
    answer.resolve(failed422(`near ${jwt}`));
    const error = await outcome;
    expect(error).toBeInstanceOf(QueryError);
    await expectNoSentinel(error, sql, entry.provider, [jwt]);
  });

  test("a transport failure", async () => {
    const entry = build(connectionFor(PAT_USER));
    entry.transports.answer(
      { method: "POST", path: /^\/api\/v2\/statements$/ },
      { fail: new TransportError("network", "socket hang up") },
    );
    const error = await caught(entry.provider.connect());
    expect(error).toBeInstanceOf(ConnectionError);
    await expectNoSentinel(error, "", entry.provider, [PAT]);
  });

  test("a 401 answered on the old lane after a renewal, echoing the previous token", async () => {
    const sql = "SELECT 1 AS N";
    const scenario = load("connect-keypair");
    const entry = build(connectionFor(SVC));
    replay(entry, scenario);
    await entry.provider.connect();
    const old = deferredAnswer();
    entry.transports.answer({ method: "POST", path: /^\/api\/v2\/statements$/ }, old.answer);
    const outcome = caught(entry.provider.query(sql));
    await entry.transports.received(5);
    const previous = bearerOf(entry.transports.requests[4]);
    // Ten minutes and a second later the next request signs a new token, on a new lane.
    entry.clock.advance(601_000);
    const tree = load("tree-show");
    replay(entry, tree, tree.exchanges.slice(4, 6));
    await entry.provider.listContainers([]);
    const [renewed, polled] = entry.transports.requests.slice(5);
    expect(bearerOf(renewed)).not.toBe(previous);
    expect(renewed.lane).not.toBe(entry.transports.requests[4].lane);
    expect(polled.lane).toBe(renewed.lane);
    old.resolve({ status: 401, json: { code: "390144", message: `JWT token is invalid. ${previous}` } });
    const error = await outcome;
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(entry.transports.closedLanes).toContain(entry.transports.requests[4].lane);
    await expectNoSentinel(error, sql, entry.provider, [previous, bearerOf(renewed)]);
  });

  test("a 10,000-character server message is cut in the error", async () => {
    const sql = "SELECT 1 FORM DUAL";
    const entry = build(connectionFor(PAT_USER));
    replay(entry, load("connect-pat"));
    entry.transports.answer({ method: "POST", path: /^\/api\/v2\/statements$/ }, handleAnswer());
    entry.transports.answer({ method: "GET", path: /^\/api\/v2\/statements\/[^/]+$/ }, failed422("x".repeat(10_000)));
    await entry.provider.connect();
    const error = await caught(entry.provider.query(sql));
    expect(error.message).toContain("x".repeat(2_000));
    expect(error.message).not.toContain("x".repeat(2_001));
  });
});

// ============================================================================
// disconnect() ends what runs
// ============================================================================

describe("disconnect() with two runs in flight", () => {
  test("sends two cancels, one per handle", async () => {
    const scenario = load("connect-keypair");
    const entry = build(connectionFor(scenario.connection));
    replay(entry, scenario);
    const handles = ["00000000-0000-0000-0000-00000000a001", "00000000-0000-0000-0000-00000000a002"];
    entry.transports.answer({ method: "POST", path: /^\/api\/v2\/statements$/ }, ...handles.map(handleAnswer));
    entry.transports.answer({ method: "GET", path: /^\/api\/v2\/statements\/[^/]+$/ }, { hang: true }, { hang: true });
    entry.transports.answer(
      { method: "POST", path: /^\/api\/v2\/statements\/[^/]+\/cancel$/ },
      ...handles.map((handle) => ({ status: 200, json: { code: "000604", statementHandle: handle } })),
    );
    await entry.provider.connect();
    const runs = [
      caught(entry.provider.query("SELECT 1", undefined, "a")),
      caught(entry.provider.query("SELECT 2", undefined, "b")),
    ];
    await entry.transports.received(8);
    expect(entry.provider.hasRunsInFlight()).toBe(true);
    // No deadline is fired: each cancel is answered at once, and every run ends on the lifetime's abort.
    await entry.provider.disconnect();
    for (const error of await Promise.all(runs)) expect(error).toBeInstanceOf(QueryCancelledError);
    const cancelled = entry.transports.requests
      .filter((request) => request.url.endsWith("/cancel"))
      .map((request) => new URL(request.url).pathname);
    expect(cancelled.sort()).toEqual(handles.map((handle) => `/api/v2/statements/${handle}/cancel`));
    expect(entry.provider.hasRunsInFlight()).toBe(false);
  });
});
