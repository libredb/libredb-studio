/**
 * POST /api/db/statement/analyze (#2204, section 5.5): the web editor's run decision, answered over HTTP to a client
 * outside the browser.
 *
 * The session reader is replaced; the rest is the product's own code. The connection is resolved by the real
 * `resolveConnection`, under governance from a granted snapshot and without it from an inline record or the operator's
 * seed file, and the provider is built by the real factory, so every answer below is read off each engine's shipped
 * capabilities. The factory and `resolveConnection` are wrapped rather than replaced: the wrapper records what the
 * route handed them, and every provider the factory builds here gets a `connect` that fails the request, so a route
 * that opened a connection could not answer 200. The query event sink and the admission gate are wrapped the same
 * way, so a test can see that the route reaches neither. One test hands the route a provider whose capabilities
 * cannot be read.
 *
 * Every expected answer is the one #2204 states for its case, never one computed from the code under test.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import path from "node:path";
import * as auth from "@/lib/auth";
import * as actualDb from "@/lib/db";
import * as actualFactory from "@/lib/db/factory";
import type { DatabaseProvider } from "@/lib/db/types";
import * as actualResolve from "@/lib/seed/resolve-connection";
import type { DatabaseType } from "@/lib/types";
import { admittedConnection, grantedSnapshot } from "../../helpers/governance/granted-snapshot";

// The real functions, kept before their modules are replaced, so a wrapper never calls itself.
const realCreateDatabaseProvider = actualFactory.createDatabaseProvider;
const realResolveConnection = actualResolve.resolveConnection;

/** Every provider the factory built for a route here: what the route handed it, and its connect. */
const built: Array<{ args: unknown[]; connect: ReturnType<typeof spyOn> }> = [];

const createDatabaseProvider = mock(
  async (...args: Parameters<typeof realCreateDatabaseProvider>): Promise<DatabaseProvider> => {
    const provider = await realCreateDatabaseProvider(...args);
    const connect = spyOn(provider, "connect").mockImplementation(async () => {
      throw new Error("POST /api/db/statement/analyze must never connect");
    });
    built.push({ args, connect });
    return provider;
  },
);
mock.module("@/lib/db", () => ({ ...actualDb, createDatabaseProvider }));

const resolveConnection = mock(realResolveConnection);
mock.module("@/lib/seed/resolve-connection", () => ({ ...actualResolve, resolveConnection }));

const realAdmission = { ...(await import("@/lib/query-events/admission")) };
const admitQueryExecution = mock(realAdmission.admitQueryExecution);
mock.module("@/lib/query-events/admission", () => ({ ...realAdmission, admitQueryExecution }));

const realSink = { ...(await import("@/lib/query-events/sink")) };
const recordQueryEvent = mock(realSink.recordQueryEvent);
mock.module("@/lib/query-events/sink", () => ({ ...realSink, recordQueryEvent }));

const { POST } = await import("@/app/api/db/statement/analyze/route");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { getServerAuditBuffer } = await import("@/lib/audit");
const { logger } = await import("@/lib/logger");
const { recordGovernanceSnapshot, resetGovernanceState } = await import("@/lib/governance/state");
const seedIndex = await import("@/lib/seed");

const ISSUER = "https://idp.example.com/realms/libredb";
const ALICE: auth.UserPayload = {
  role: "user",
  username: "alice@example.com",
  idpSubject: "alice-subject",
  idpIssuer: ISSUER,
};

/** A governed connection named after its id, so the etcd one is the `orders-etcd` of case C9. */
const governed = (id: string, type: DatabaseType) => admittedConnection(id, { name: id, extra: { type } });
const ORDERS_PG = governed("orders-pg", "postgres");
const ORDERS_ORACLE = governed("orders-oracle", "oracle");
const ORDERS_REDIS = governed("orders-redis", "redis");
const ORDERS_ETCD = governed("orders-etcd", "etcd");
/** Admitted, and granted to nobody. */
const BILLING_PG = governed("billing-pg", "postgres");

const SNAPSHOT_GRANTS = [ORDERS_PG, ORDERS_ORACLE, ORDERS_REDIS, ORDERS_ETCD].map((connection) => ({
  subject: ALICE.idpSubject as string,
  connection,
  level: "read" as const,
}));

/** What `editorExecutionContext` answers for Alice under governance: her own provider, file access denied. */
const ALICE_EXECUTION = { allowExternalFileAccess: false, owner: "alice-subject", ownerPoolMax: 3 };

const NOT_FOUND_BODY = {
  error: "Connection not found: it does not exist or is not granted to you",
  code: "CONNECTION_NOT_FOUND",
  statusCode: 404,
};

const TWO = "SELECT 1;\nDELETE FROM t;";
/** Case RT1: TWO with the caret in its second statement. */
const RT1_ANSWER = {
  decision: "confirm",
  statement: "DELETE FROM t",
  range: { start: 10, end: 23 },
  route: "query",
  unreadable: false,
  typedConfirmation: null,
};
const REDIS_SECOND_COMMAND =
  'Line 2 holds a second command, which begins with "DEL": each line is one Redis command, and Studio runs one command per run. Select the line to run it, and the editor sends the selection. A command continues onto the next line only inside a quoted argument or an unfinished JSON command.';
const TYPED_NAME_MISSING =
  "This statement is confirmed by typing the connection's name, and this connection has no name, so it cannot run.";

/** A caret at `cursor` with no selection. */
const at = (cursor: number) => ({ selection: { start: cursor, end: cursor }, cursor });
/** A selection of `[start, end)` with the caret at its end. */
const selected = (start: number, end: number) => ({ selection: { start, end }, cursor: end });

function post(body: unknown): Request {
  return new Request("http://localhost:3000/api/db/statement/analyze", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function analyze(body: unknown): Promise<{ status: number; body: unknown; retryAfter: string | null }> {
  const response = await POST(post(body) as never);
  return { status: response.status, body: await response.json(), retryAfter: response.headers.get("retry-after") };
}

/** Every environment variable a test here sets, restored after each test. */
const TOUCHED_ENV = [
  "GOVERNANCE_SOURCE",
  "ALLOW_CUSTOM_CONNECTIONS",
  "KUBERNETES_ACCESS_REVIEW",
  "SEED_CONFIG_PATH",
  "ADMIN_PG_PASS",
  "USER_MYSQL_PASS",
  "SHARED_PG_PASS",
  "BOTH_PG_PASS",
  "LIBREDB_ENABLED_PROVIDERS",
  "RATE_LIMIT_QUERY_MAX",
] as const;
const savedEnv = new Map<string, string | undefined>();

let getSession: ReturnType<typeof spyOn>;
let readSession: ReturnType<typeof spyOn>;
/** The console, silenced: the factory announces each provider on it, and the audit trail writes its lines there. */
let consoleSpies: ReturnType<typeof spyOn>[] = [];

beforeAll(() => {
  for (const name of TOUCHED_ENV) savedEnv.set(name, process.env[name]);
});

beforeEach(() => {
  clearRateLimitState();
  built.length = 0;
  createDatabaseProvider.mockClear();
  resolveConnection.mockClear();
  admitQueryExecution.mockClear();
  recordQueryEvent.mockClear();
  getSession = spyOn(auth, "getSession").mockResolvedValue(ALICE);
  readSession = spyOn(auth, "readSession").mockImplementation(async () => {
    const s = await auth.getSession();
    return s ? { kind: "authenticated", session: s } : { kind: "anonymous" };
  });
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    spyOn(console, method).mockImplementation(() => {}),
  );
});

afterEach(() => {
  getSession.mockRestore();
  readSession.mockRestore();
  for (const spy of consoleSpies) spy.mockRestore();
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetGovernanceState();
  seedIndex.resetCache();
});

describe("POST /api/db/statement/analyze under governance, on the connections granted to the caller", () => {
  beforeEach(() => {
    process.env.GOVERNANCE_SOURCE = "postgres";
    recordGovernanceSnapshot(
      grantedSnapshot([ORDERS_PG, ORDERS_ORACLE, ORDERS_REDIS, ORDERS_ETCD, BILLING_PG], SNAPSHOT_GRANTS),
    );
  });

  // H9: RT1, RT17, W1, C3, C9 and N1, each with the exact body section 5 states for it.
  test.each([
    ["RT1, the caret in the second statement", { connectionId: "seed:orders-pg", text: TWO, ...at(19) }, RT1_ANSWER],
    [
      "RT17, an Oracle selection sent without its ;",
      { connectionId: "seed:orders-oracle", text: "SELECT 1 FROM dual;", ...selected(0, 19) },
      { decision: "run", statement: "SELECT 1 FROM dual", range: { start: 0, end: 19 }, route: "query" },
    ],
    [
      "W1, a data-modifying CTE",
      { connectionId: "seed:orders-pg", text: "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d", ...at(52) },
      {
        decision: "confirm",
        statement: "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
        range: { start: 0, end: 53 },
        route: "query",
        unreadable: false,
        typedConfirmation: null,
      },
    ],
    [
      "C3, a second Redis command",
      { connectionId: "seed:orders-redis", text: "GET a\nDEL b", ...at(10) },
      { decision: "refuse", statement: "GET a\nDEL b", range: { start: 0, end: 11 }, refusal: REDIS_SECOND_COMMAND },
    ],
    [
      "C9, an etcd delete of every key, confirmed by typing the connection's name",
      { connectionId: "seed:orders-etcd", text: "del '' --prefix", ...at(15) },
      {
        decision: "confirm",
        statement: "del '' --prefix",
        range: { start: 0, end: 15 },
        route: "query",
        unreadable: false,
        typedConfirmation: { type: "connection-name", expected: "orders-etcd", targets: ["every key"] },
      },
    ],
    [
      "N1, a caret in a comment-only segment",
      { connectionId: "seed:orders-pg", text: "SELECT 1;\n-- note", ...at(17) },
      {
        decision: "nothing",
      },
    ],
  ])("%s answers 200 with exactly its decision, from a provider it never connects", async (_label, body, expected) => {
    expect(await analyze(body)).toEqual({ status: 200, body: expected, retryAfter: null });
    expect(built.map(({ args }) => [(args[0] as { id: string }).id, ...args.slice(1)])).toEqual([
      [body.connectionId, {}, ALICE_EXECUTION],
    ]);
    expect(built[0].connect).not.toHaveBeenCalled();
  });

  test("builds the provider once, for the record it resolved, with editorExecutionContext's answer", async () => {
    expect((await analyze({ connectionId: "seed:orders-pg", text: TWO, ...at(19) })).status).toBe(200);

    expect(createDatabaseProvider).toHaveBeenCalledTimes(1);
    expect(built).toHaveLength(1);
    expect(built[0].args[0]).toMatchObject({ id: "seed:orders-pg", type: "postgres", name: "orders-pg" });
    expect(built[0].args.slice(1)).toEqual([{}, ALICE_EXECUTION]);
    expect(built[0].connect).not.toHaveBeenCalled();
  });

  // The text is never trimmed: the range indexes into the text as it was sent, its leading blanks counted.
  test("a text with leading blank lines answers a range that counts them", async () => {
    expect(await analyze({ connectionId: "seed:orders-pg", text: "\n\nDELETE FROM t", ...at(15) })).toEqual({
      status: 200,
      body: {
        decision: "confirm",
        statement: "DELETE FROM t",
        range: { start: 2, end: 15 },
        route: "query",
        unreadable: false,
        typedConfirmation: null,
      },
      retryAfter: null,
    });
  });

  test("ignores fields it does not read, catalog among them", async () => {
    const body = { connectionId: "seed:orders-pg", text: TWO, ...at(19), catalog: "other", sql: "DROP TABLE t" };

    expect(await analyze(body)).toEqual({ status: 200, body: RT1_ANSWER, retryAfter: null });
  });

  // H4, under governance: the connection is resolved before any field is read, so a refused one answers its refusal
  // whatever the body holds.
  test.each([
    ["with well-formed fields", { connectionId: "seed:billing-pg", text: TWO, ...at(19) }],
    ["with a field of the wrong type", { connectionId: "seed:billing-pg", text: 7 }],
    ["for an id that does not exist", { connectionId: "seed:no-such-connection", text: TWO, ...at(19) }],
  ])(
    "a seed id not granted to the caller answers 404 CONNECTION_NOT_FOUND %s, and builds nothing",
    async (_l, body) => {
      expect(await analyze(body)).toEqual({ status: 404, body: NOT_FOUND_BODY, retryAfter: null });
      expect(createDatabaseProvider).not.toHaveBeenCalled();
    },
  );

  // H5: the field checks, after the connection resolved and before any provider is built.
  test.each([
    ["text is a number", { text: 7 }, "text must be a string"],
    ["text is null", { text: null }, "text must be a string"],
    ["text is absent", { text: undefined }, "text must be a string"],
    ["selection is a string", { selection: "0,1" }, "selection must be an object"],
    ["selection is null", { selection: null }, "selection must be an object"],
    ["selection is an array", { selection: [19, 19] }, "selection must be an object"],
    ["selection.start is a fraction", { selection: { start: 0.5, end: 1 } }, "selection.start must be an integer"],
    ["selection.start is null", { selection: { start: null, end: 1 } }, "selection.start must be an integer"],
    ["selection.end is a string", { selection: { start: 0, end: "1" } }, "selection.end must be an integer"],
    ["cursor is a string", { cursor: "3" }, "cursor must be an integer"],
    ["cursor is null", { cursor: null }, "cursor must be an integer"],
    ["cursor is absent", { cursor: undefined }, "cursor must be an integer"],
  ])("%s answers 400 naming the field, and builds nothing", async (_label, fields, sentence) => {
    const body = { connectionId: "seed:orders-pg", text: TWO, ...at(19), ...fields };

    expect(await analyze(body)).toEqual({ status: 400, body: { error: sentence }, retryAfter: null });
    expect(createDatabaseProvider).not.toHaveBeenCalled();
  });

  // H6: the bound is counted in UTF-16 code units, the unit of the offsets. This text is 1,000,001 units and 1,000,000
  // code points, because its emoji is one surrogate pair.
  test("a text over 1,000,000 UTF-16 code units answers 413, and builds nothing", async () => {
    const text = `\u{1F600}${"SELECT 1;\n".repeat(99_999)}SELECT 1;`;

    expect(await analyze({ connectionId: "seed:orders-pg", text, ...at(0) })).toEqual({
      status: 413,
      body: {
        error:
          "The text is 1000001 UTF-16 code units long, over the 1000000-unit limit for statement analysis. Shorten it to run it.",
      },
      retryAfter: null,
    });
    expect(createDatabaseProvider).not.toHaveBeenCalled();
  });

  // The field checks come before the bound, so a text over it with a field of the wrong type names the field.
  test("a text over 1,000,000 UTF-16 code units with a cursor that is a string answers 400 naming the cursor, not 413", async () => {
    const text = "x".repeat(1_000_001);

    expect(
      await analyze({ connectionId: "seed:orders-pg", text, selection: { start: 0, end: 0 }, cursor: "3" }),
    ).toEqual({ status: 400, body: { error: "cursor must be an integer" }, retryAfter: null });
    expect(createDatabaseProvider).not.toHaveBeenCalled();
  });

  test("a text of exactly 1,000,000 UTF-16 code units is analysed", async () => {
    const text = "SELECT 1;\n".repeat(100_000);

    expect(await analyze({ connectionId: "seed:orders-pg", text, ...at(0) })).toEqual({
      status: 200,
      body: { decision: "run", statement: "SELECT 1", range: { start: 0, end: 8 }, route: "query" },
      retryAfter: null,
    });
  });

  // H7: offsets the run target cannot honour answer its own sentence, which carries numbers only. The rule needs the
  // provider's capabilities, so it runs once the provider is built; the provider is still never connected.
  test.each([
    [
      "a selection that ends before it starts",
      { selection: { start: 5, end: 2 }, cursor: 2 },
      "run target: selection [5, 2) is not within a text of length 24",
    ],
    [
      "a caret past the end of the text",
      { selection: { start: 0, end: 0 }, cursor: 99 },
      "run target: cursor 99 is not within a text of length 24",
    ],
  ])("%s answers 400 with the run target's sentence", async (_label, offsets, sentence) => {
    expect(await analyze({ connectionId: "seed:orders-pg", text: TWO, ...offsets })).toEqual({
      status: 400,
      body: { error: sentence },
      retryAfter: null,
    });
    expect(built).toHaveLength(1);
    expect(built[0].connect).not.toHaveBeenCalled();
  });

  // H8.
  test("a type LIBREDB_ENABLED_PROVIDERS leaves out answers 400 CONFIG_ERROR", async () => {
    process.env.LIBREDB_ENABLED_PROVIDERS = "sqlite";

    expect(await analyze({ connectionId: "seed:orders-pg", text: TWO, ...at(19) })).toEqual({
      status: 400,
      body: {
        error: "The postgres provider is not available in this distribution of LibreDB Studio.",
        code: "CONFIG_ERROR",
        statusCode: 400,
      },
      retryAfter: null,
    });
    expect(built).toHaveLength(0);
  });

  // Only the run target's RangeError is the caller's: any other failure is the server's, answered by createErrorResponse.
  test("a provider that cannot answer its capabilities answers 500 INTERNAL_ERROR, not 400", async () => {
    createDatabaseProvider.mockImplementationOnce(
      async () =>
        ({
          getCapabilities: () => {
            throw new TypeError("capabilities unreadable");
          },
        }) as unknown as DatabaseProvider,
    );

    expect(await analyze({ connectionId: "seed:orders-pg", text: TWO, ...at(19) })).toEqual({
      status: 500,
      body: { error: "capabilities unreadable", code: "INTERNAL_ERROR", statusCode: 500 },
      retryAfter: null,
    });
  });

  // A RangeError the run target did not raise is no offset of the caller's: a stack overflow inside an engine's reader
  // is one, and it is the server's, answered and logged as every other failure.
  test("a RangeError that is not the run target's answers 500 INTERNAL_ERROR, not 400", async () => {
    createDatabaseProvider.mockImplementationOnce(
      async () =>
        ({
          getCapabilities: () => {
            throw new RangeError("Maximum call stack size exceeded.");
          },
        }) as unknown as DatabaseProvider,
    );
    const errorSpy = spyOn(logger, "error");
    try {
      expect(await analyze({ connectionId: "seed:orders-pg", text: TWO, ...at(19) })).toEqual({
        status: 500,
        body: { error: "Maximum call stack size exceeded.", code: "INTERNAL_ERROR", statusCode: 500 },
        retryAfter: null,
      });
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  // H10: the canary runs. A refusal may quote a word of the text, so one run below makes Redis quote the canary itself.
  test("no log line, audit event or query event carries the text, the statement or the refusal", async () => {
    const CANARY = "canary-2204";
    const sql = `SELECT '${CANARY}' FROM t; DELETE FROM t`;
    const note = `SELECT '${CANARY}' FROM t; -- ${CANARY}`;
    const onPg = (fields: Record<string, unknown>) => ({ connectionId: "seed:orders-pg", ...fields });
    const onRedis = (fields: Record<string, unknown>) => ({ connectionId: "seed:orders-redis", ...fields });
    const loggerSpies = (["debug", "info", "warn", "error"] as const).map((method) => spyOn(logger, method));
    const auditBefore = getServerAuditBuffer().getAll().length;
    try {
      const runs: Array<[unknown, number, string | undefined]> = [
        [onPg({ text: sql, ...at(3) }), 200, "run"],
        [onPg({ text: sql, ...selected(0, sql.length) }), 200, "confirm"],
        [onPg({ text: note, ...at(note.length) }), 200, "nothing"],
        [onRedis({ text: `GET a\nDEL ${CANARY}`, ...at(9) }), 200, "refuse"],
        [onRedis({ text: `GET a\n${CANARY} b`, ...at(9) }), 200, "refuse"],
        [onPg({ text: [CANARY], ...at(0) }), 400, undefined],
        [onPg({ text: sql, selection: CANARY, cursor: 0 }), 400, undefined],
        [onPg({ text: sql, selection: { start: CANARY, end: 0 }, cursor: 0 }), 400, undefined],
        [onPg({ text: sql, selection: { start: 0, end: CANARY }, cursor: 0 }), 400, undefined],
        [onPg({ text: sql, selection: { start: 0, end: 0 }, cursor: CANARY }), 400, undefined],
        [onPg({ text: sql, ...at(999) }), 400, undefined],
        [`{"connectionId":"seed:orders-pg","text":"${CANARY}"`, 400, undefined],
        [onPg({ text: `${CANARY} ${"x".repeat(1_000_000)}`, ...at(0) }), 413, undefined],
        [{ connectionId: "seed:billing-pg", text: sql, ...at(3) }, 404, undefined],
      ];
      for (const [body, status, decision] of runs) {
        // oxlint-disable-next-line no-await-in-loop -- one request at a time, as a client sends them.
        const answer = await analyze(body);
        expect([answer.status, (answer.body as { decision?: string }).decision]).toEqual([status, decision]);
      }
      getSession.mockResolvedValue(null);
      expect((await analyze(onPg({ text: sql, ...at(3) }))).status).toBe(401);

      const said = [...consoleSpies, ...loggerSpies].flatMap((spy) =>
        (spy.mock.calls as unknown[][]).map((args) => args.map(printed).join(" ")),
      );
      // Not vacuous: the factory announced its providers, and the 404 and the 401 left audit lines.
      expect(said.some((line) => line.startsWith("[DB] Creating postgres provider"))).toBe(true);
      expect(said.filter((line) => line.includes(CANARY))).toEqual([]);
      const audited = getServerAuditBuffer().getAll().slice(auditBefore);
      expect(audited.length).toBeGreaterThan(0);
      expect(audited.filter((event) => JSON.stringify(event).includes(CANARY))).toEqual([]);
      expect(recordQueryEvent).not.toHaveBeenCalled();
      expect(admitQueryExecution).not.toHaveBeenCalled();
    } finally {
      for (const spy of loggerSpies) spy.mockRestore();
    }
  });

  // H11: one request spends one slot, so the bucket is spent after exactly RATE_LIMIT_QUERY_MAX requests.
  test("each request spends one query slot: the one after RATE_LIMIT_QUERY_MAX answers 429 with Retry-After", async () => {
    process.env.RATE_LIMIT_QUERY_MAX = "3";
    const body = { connectionId: "seed:orders-pg", text: TWO, ...at(19) };

    const statuses: number[] = [];
    for (let request = 0; request < 3; request += 1) {
      // oxlint-disable-next-line no-await-in-loop -- one request at a time, as a client sends them.
      statuses.push((await analyze(body)).status);
    }
    expect(statuses).toEqual([200, 200, 200]);

    const spent = await analyze(body);
    expect(spent.status).toBe(429);
    expect(spent.body).toMatchObject({ code: "RATE_LIMITED", statusCode: 429, retryable: true });
    expect(Number(spent.retryAfter)).toBeGreaterThan(0);
    expect(resolveConnection).toHaveBeenCalledTimes(3);
    expect(createDatabaseProvider).toHaveBeenCalledTimes(3);
  });
});

describe("POST /api/db/statement/analyze without governance", () => {
  beforeEach(() => {
    delete process.env.GOVERNANCE_SOURCE;
  });

  // H1.
  test("a request without a session answers 401 AUTH_REQUIRED, and resolves nothing", async () => {
    getSession.mockResolvedValue(null);

    expect(await analyze({ connectionId: "seed:orders-pg", text: TWO, ...at(19) })).toEqual({
      status: 401,
      body: { error: "Authentication required", code: "AUTH_REQUIRED" },
      retryAfter: null,
    });
    expect(resolveConnection).not.toHaveBeenCalled();
    expect(createDatabaseProvider).not.toHaveBeenCalled();
  });

  // H2.
  test.each([
    ["an array", []],
    ["not JSON", '{"text":'],
    ["JSON null", "null"],
  ])("a body that is %s answers 400 Invalid request body, and resolves nothing", async (_label, body) => {
    expect(await analyze(body)).toEqual({ status: 400, body: { error: "Invalid request body" }, retryAfter: null });
    expect(resolveConnection).not.toHaveBeenCalled();
  });

  // H3: the connection alone, as the custom connections census sends it.
  test("an inline connection while custom connections are off answers 403 CUSTOM_CONNECTIONS_DISABLED, and builds nothing", async () => {
    process.env.ALLOW_CUSTOM_CONNECTIONS = "false";

    expect(
      await analyze({ connection: { id: "inline-pg", name: "Inline", type: "postgres", host: "127.0.0.1", port: 1 } }),
    ).toEqual({
      status: 403,
      body: {
        error: "Custom connections are disabled on this server",
        code: "CUSTOM_CONNECTIONS_DISABLED",
        statusCode: 403,
      },
      retryAfter: null,
    });
    expect(createDatabaseProvider).not.toHaveBeenCalled();
  });

  // A name that is present and not a string is refused when the connection resolves, as on every route that resolves
  // a caller's connection, before the factory, which logs it with a string method; null is refused the same way, as no
  // name of any connection.
  test.each([
    ["null", null],
    ["a number", 5],
    ["an object", { first: "orders" }],
  ])("an inline connection whose name is %s answers 400 CONFIG_ERROR, and builds nothing", async (_label, name) => {
    const connection = { id: "inline-etcd", name, type: "etcd", host: "127.0.0.1", port: 1 };

    expect(await analyze({ connection, text: "del '' --prefix", ...at(15) })).toEqual({
      status: 400,
      body: { error: "Valid connection configuration is required", code: "CONFIG_ERROR", statusCode: 400 },
      retryAfter: null,
    });
    expect(createDatabaseProvider).not.toHaveBeenCalled();
  });

  // As every route that resolves a caller's connection answers it: a record with no type names no provider to read.
  test.each([
    ["no type", {}],
    ["an empty type", { type: "" }],
    ["a type that is not a string", { type: 5 }],
  ])("an inline connection with %s answers 400 CONFIG_ERROR, and builds nothing", async (_label, type) => {
    const connection = { id: "inline-x", name: "Inline", host: "127.0.0.1", port: 1, ...type };

    expect(await analyze({ connection, text: TWO, ...at(19) })).toEqual({
      status: 400,
      body: { error: "Valid connection configuration is required", code: "CONFIG_ERROR", statusCode: 400 },
      retryAfter: null,
    });
    expect(createDatabaseProvider).not.toHaveBeenCalled();
  });

  // H4, under the Kubernetes access review: a seed the caller's role may not see is a miss like any other.
  test("under the Kubernetes access review, a seed the caller's role may not see answers 404 CONNECTION_NOT_FOUND", async () => {
    Object.assign(process.env, {
      KUBERNETES_ACCESS_REVIEW: "on",
      SEED_CONFIG_PATH: path.resolve(import.meta.dir, "../../fixtures/seed-connections/multi-role-config.yaml"),
      ADMIN_PG_PASS: "admin-secret",
      USER_MYSQL_PASS: "user-secret",
      SHARED_PG_PASS: "shared-secret",
      BOTH_PG_PASS: "both-secret",
    });
    seedIndex.resetCache();

    expect(await analyze({ connectionId: "seed:admin-only", text: TWO, ...at(19) })).toEqual({
      status: 404,
      body: NOT_FOUND_BODY,
      retryAfter: null,
    });
    expect(createDatabaseProvider).not.toHaveBeenCalled();
  });

  // C14: the analysis reads the name of the connection the route resolved, here the caller's own inline record.
  test("an inline connection with no name refuses a statement confirmed by typing that name", async () => {
    const connection = { id: "inline-etcd", name: "", type: "etcd", host: "127.0.0.1", port: 1 };

    expect(await analyze({ connection, text: "del '' --prefix", ...at(15) })).toEqual({
      status: 200,
      body: {
        decision: "refuse",
        statement: "del '' --prefix",
        range: { start: 0, end: 15 },
        refusal: TYPED_NAME_MISSING,
      },
      retryAfter: null,
    });
    expect(built.map(({ args }) => args.slice(1))).toEqual([[{}, { allowExternalFileAccess: false }]]);
    expect(built[0].connect).not.toHaveBeenCalled();
  });
});

/** An argument of a console or logger call as text, an error's message and stack included. */
function printed(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ""}`;
  return JSON.stringify(value) ?? String(value);
}
