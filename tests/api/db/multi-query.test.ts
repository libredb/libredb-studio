import { describe, test, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { installStandInVocabulary, STAND_IN_TYPE } from "../../helpers/stand-in-vocabulary";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import {
  QueryError,
  QueryCancelledError,
  TimeoutError,
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  AuthenticationError,
  PoolExhaustedError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
  isRetryableError,
  mapDatabaseError,
} from "@/lib/db/errors";
import type { QueryEventRow } from "@/lib/query-events/types";
import type { QueryEventBatchWrite, QueryEventWriteFailure } from "@/lib/query-events/postgres-sink";

// ─── Create mock objects ────────────────────────────────────────────────────
const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => mockProvider as never);

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

// ─── Mock auth + seed resolution BEFORE importing route ─────────────────────
mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  readSession: mock(async () => {
    const s = await mockGetSession();
    return s ? { kind: "authenticated", session: s } : { kind: "anonymous" };
  }),
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

/** What `resolveConnection` answers instead of the default below, for the governance tests at the end of this file. */
let resolveConnectionOverride: ((body: Record<string, unknown>) => Promise<unknown>) | undefined;

mock.module("@/lib/seed/resolve-connection", () => {
  class SeedConnectionError extends Error {
    constructor(
      message: string,
      public statusCode: number,
      public code?: string,
    ) {
      super(message);
      this.name = "SeedConnectionError";
    }
  }
  return {
    resolveConnection: mock(async (body: Record<string, unknown>) => {
      if (resolveConnectionOverride !== undefined) return resolveConnectionOverride(body);
      if (!body.connection && !body.connectionId) {
        throw new SeedConnectionError("Either connection or connectionId is required", 400);
      }
      return body.connection;
    }),
    SeedConnectionError,
  };
});

// ─── Mock dependencies BEFORE importing route ───────────────────────────────
mock.module("@/lib/db", () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mock(async () => mockProvider),
  removeProvider: mock(async () => {}),
  clearProviderCache: mock(async () => {}),
  getProviderCacheStats: mock(() => ({ size: 0, connections: [] })),
  QueryError,
  QueryCancelledError,
  TimeoutError,
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  AuthenticationError,
  PoolExhaustedError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
  isRetryableError,
  mapDatabaseError,
}));

// ─── The query event insert, faked: the sink, the builder and the admission gate stay real ──────
const realPostgresSink = await import("@/lib/query-events/postgres-sink");
/** Every row the sink handed to an insert that took it. */
const insertedEvents: QueryEventRow[] = [];
/** When set, every insert fails this way and keeps its batch queued, so the sink backs off. */
let insertFailure: QueryEventWriteFailure | null = null;
mock.module("@/lib/query-events/postgres-sink", () => ({
  ...realPostgresSink,
  writeQueryEventBatch: mock(async (rows: readonly QueryEventRow[]): Promise<QueryEventBatchWrite> => {
    if (insertFailure !== null) return { settled: 0, rejections: [], failure: insertFailure };
    insertedEvents.push(...rows);
    return { settled: rows.length, rejections: [], failure: null };
  }),
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import("@/app/api/db/multi-query/route");

// ─── Helpers ────────────────────────────────────────────────────────────────
const validConnection = {
  id: "test-1",
  name: "Test DB",
  type: "postgres",
  host: "localhost",
  port: 5432,
  database: "testdb",
};

// ─── Tests ──────────────────────────────────────────────────────────────────
describe("POST /api/db/multi-query", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateProvider.mockClear();
    (mockProvider.query as ReturnType<typeof mock>).mockClear();
    (mockProvider.prepareQuery as ReturnType<typeof mock>).mockClear();
    mockGetSession.mockClear();

    // Reset to default implementations
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider as never);
    (mockProvider.query as ReturnType<typeof mock>).mockImplementation(async () => ({
      rows: [{ id: 1, name: "Alice" }],
      fields: ["id", "name"],
      rowCount: 1,
      executionTime: 10,
    }));
    (mockProvider.prepareQuery as ReturnType<typeof mock>).mockImplementation((query: string) => ({
      query: `${query} LIMIT 50`,
      wasLimited: true,
      limit: 50,
      offset: 0,
    }));
  });

  test("returns 401 when no session exists", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const req = createMockRequest("/api/db/multi-query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM users" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(401);
    expect(data.error).toContain("Authentication required");
  });

  test("single statement returns multiStatement results", async () => {
    const req = createMockRequest("/api/db/multi-query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM users" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      multiStatement: boolean;
      statementCount: number;
      executedCount: number;
      hasError: boolean;
      statements: unknown[];
      rows: unknown[];
      fields: string[];
    }>(res);

    expect(res.status).toBe(200);
    expect(data.multiStatement).toBe(true);
    expect(data.statementCount).toBe(1);
    expect(data.executedCount).toBe(1);
    expect(data.hasError).toBe(false);
    expect(data.statements).toHaveLength(1);
    expect(data.rows).toBeDefined();
    expect(data.fields).toBeDefined();
  });

  // `JSON.stringify` writes NaN and both infinities as `null`; the main result and the
  // statement it came from both carry them as words.
  test("answers NaN and the infinities as words on the main result and its statement", async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockImplementation(async () => ({
      rows: [{ f: Number.NaN, r: Number.POSITIVE_INFINITY, n: Number.NEGATIVE_INFINITY, ok: 1.5, z: null }],
      fields: ["f", "r", "n", "ok", "z"],
      rowCount: 1,
      executionTime: 1,
    }));
    const req = createMockRequest("/api/db/multi-query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT * FROM floats" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ rows: unknown[]; statements: Array<{ rows: unknown[] }> }>(res);

    const words = [{ f: "NaN", r: "Infinity", n: "-Infinity", ok: 1.5, z: null }];
    expect(res.status).toBe(200);
    expect(data.rows).toEqual(words);
    expect(data.statements[0].rows).toEqual(words);
  });

  // ── Warnings and declared column types travel with their statement (#285) ──
  //
  // #273 gave the shared result both channels and the providers fill them, but
  // this route builds each statement result from an explicit field list, so both
  // stopped here. Silent field-dropping is only caught by asserting the far end.

  test("carries each statement's warnings and column types onto that statement", async () => {
    let call = 0;
    (mockProvider.query as ReturnType<typeof mock>).mockImplementation(async () => {
      call++;
      return {
        rows: [{ id: call }],
        fields: ["id"],
        rowCount: 1,
        executionTime: 5,
        warnings: [{ message: `notice ${call}`, code: call }],
        columnTypes: { id: call === 1 ? "BIGINT" : "INTEGER" },
      };
    });

    const req = createMockRequest("/api/db/multi-query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT 1; SELECT 2" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      statements: Array<{
        warnings?: { message: string; code?: number | string }[];
        columnTypes?: Record<string, string>;
      }>;
    }>(res);

    expect(data.statements[0].warnings).toEqual([{ message: "notice 1", code: 1 }]);
    expect(data.statements[0].columnTypes).toEqual({ id: "BIGINT" });
    expect(data.statements[1].warnings).toEqual([{ message: "notice 2", code: 2 }]);
    expect(data.statements[1].columnTypes).toEqual({ id: "INTEGER" });
  });

  test("the main result carries the channels of the statement whose rows it shows", async () => {
    // The main result is the last statement that returned rows, so those rows and
    // these notices come from the same run. Merging every statement's warnings
    // would attribute one statement's notice to another's rows.
    let call = 0;
    (mockProvider.query as ReturnType<typeof mock>).mockImplementation(async () => {
      call++;
      return call === 1
        ? { rows: [{ id: 1 }], fields: ["id"], rowCount: 1, executionTime: 5, warnings: [{ message: "first" }] }
        : {
            rows: [{ total: 2 }],
            fields: ["total"],
            rowCount: 1,
            executionTime: 5,
            warnings: [{ message: "second" }],
            columnTypes: { total: "BIGINT" },
          };
    });

    const req = createMockRequest("/api/db/multi-query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT 1; SELECT count(*) AS total FROM t" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      warnings?: { message: string }[];
      columnTypes?: Record<string, string>;
    }>(res);

    expect(data.warnings).toEqual([{ message: "second" }]);
    expect(data.columnTypes).toEqual({ total: "BIGINT" });
  });

  test("omits both channels when the engine reported neither", async () => {
    // Absent rather than empty: the grid decides whether to render anything from
    // the field's presence alone.
    const req = createMockRequest("/api/db/multi-query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT 1; SELECT 2" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<Record<string, unknown>>(res);

    expect("warnings" in data).toBe(false);
    expect("columnTypes" in data).toBe(false);
    expect("warnings" in (data.statements as Record<string, unknown>[])[0]).toBe(false);
  });

  test("multiple statements are all executed", async () => {
    let callCount = 0;
    (mockProvider.query as ReturnType<typeof mock>).mockImplementation(async () => {
      callCount++;
      return {
        rows: [{ result: callCount }],
        fields: ["result"],
        rowCount: 1,
        executionTime: 5,
      };
    });

    const req = createMockRequest("/api/db/multi-query", {
      method: "POST",
      body: {
        connection: validConnection,
        sql: "INSERT INTO users (name) VALUES ('Alice'); INSERT INTO users (name) VALUES ('Bob'); SELECT * FROM users",
      },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      multiStatement: boolean;
      statementCount: number;
      executedCount: number;
      hasError: boolean;
      statements: Array<{ status: string; index: number }>;
    }>(res);

    expect(res.status).toBe(200);
    expect(data.statementCount).toBe(3);
    expect(data.executedCount).toBe(3);
    expect(data.hasError).toBe(false);
    expect(data.statements.every((s) => s.status === "success")).toBe(true);
  });

  test("error in second statement stops execution and sets hasError", async () => {
    let callCount = 0;
    (mockProvider.query as ReturnType<typeof mock>).mockImplementation(async () => {
      callCount++;
      if (callCount === 2) {
        throw new Error("Syntax error in statement 2");
      }
      return {
        rows: [],
        fields: [],
        rowCount: 0,
        executionTime: 5,
      };
    });

    const req = createMockRequest("/api/db/multi-query", {
      method: "POST",
      body: {
        connection: validConnection,
        sql: "INSERT INTO a VALUES (1); BAD SQL HERE; SELECT * FROM b",
      },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      statementCount: number;
      executedCount: number;
      hasError: boolean;
      statements: Array<{ status: string; error?: string }>;
    }>(res);

    expect(res.status).toBe(200);
    expect(data.statementCount).toBe(3);
    expect(data.executedCount).toBe(2); // Stopped after error on 2nd
    expect(data.hasError).toBe(true);
    expect(data.statements[0].status).toBe("success");
    expect(data.statements[1].status).toBe("error");
    expect(data.statements[1].error).toContain("Syntax error");
  });

  test("the last statement failing at the bound Studio added says so; an earlier one is left alone (SF-022)", async () => {
    let callCount = 0;
    (mockProvider.query as ReturnType<typeof mock>).mockImplementation(async () => {
      callCount++;
      throw new Error(callCount === 1 ? "unexpected 'LIMIT' in statement" : 'near "LIMIT": syntax error');
    });
    const run = async (sql: string) => {
      const req = createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: { connection: validConnection, sql },
      });
      return parseResponseJSON<{ statements: Array<{ status: string; error?: string }> }>(await POST(req as never));
    };

    // The first statement of a script is sent as written, so its error is the engine's alone.
    expect((await run("SELECT 1 LIMIT; SELECT 2")).statements[0].error).toBe("unexpected 'LIMIT' in statement");
    callCount = 1;
    expect((await run("SELECT * FROM t WHERE")).statements[0].error).toBe(
      'near "LIMIT": syntax error Studio added the clause LIMIT 50 to this statement to bound its rows, so a position or token this error names may be in that clause rather than in your text.',
    );
  });

  test("missing connection returns 400", async () => {
    const req = createMockRequest("/api/db/multi-query", {
      method: "POST",
      body: { sql: "SELECT 1" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("required");
  });

  // A `sql` that is present but not a string reached the splitter and answered 500 with its own TypeError
  // ("input.slice is not a function"). It is refused in words before any provider resolves, a falsy one (0, false) included.
  for (const [label, sql] of [
    ["a number", 123],
    ["an object", { text: "SELECT 1" }],
    ["an array", ["SELECT 1"]],
    ["true", true],
    ["zero", 0],
    ["false", false],
  ] as const) {
    test(`answers 400 when sql is ${label}, before any provider resolves`, async () => {
      mockGetOrCreateProvider.mockClear();
      const req = createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: { connection: validConnection, sql },
      });

      const res = await POST(req as never);
      const data = await parseResponseJSON<{ error: string }>(res);

      expect(res.status).toBe(400);
      expect(data.error).toBe("sql must be a string");
      expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
    });
  }

  test("an empty sql keeps the answer of a missing one", async () => {
    const req = createMockRequest("/api/db/multi-query", {
      method: "POST",
      body: { connection: validConnection, sql: "" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toBe("Connection and query are required");
  });

  test("a null sql keeps the answer of a missing one", async () => {
    const req = createMockRequest("/api/db/multi-query", {
      method: "POST",
      body: { connection: validConnection, sql: null },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toBe("Connection and query are required");
  });

  test("missing sql returns 400", async () => {
    const req = createMockRequest("/api/db/multi-query", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Connection and query are required");
  });

  test("only semicolons returns 400 (no valid statements)", async () => {
    const req = createMockRequest("/api/db/multi-query", {
      method: "POST",
      body: { connection: validConnection, sql: ";;;" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("No valid SQL statements found");
  });

  // ─── The page options, held to the rule POST /api/db/query holds them to ───
  describe("page options", () => {
    const send = (options: unknown, sql = "SELECT * FROM users") =>
      POST(
        createMockRequest("/api/db/multi-query", {
          method: "POST",
          body: { connection: validConnection, sql, options },
        }) as never,
      );

    const refused: Array<[string, unknown, string]> = [
      ["a numeric string limit", { limit: "10" }, "options.limit must be a non-negative integer"],
      ["a fractional limit", { limit: 1.5 }, "options.limit must be a non-negative integer"],
      ["a negative limit", { limit: -1 }, "options.limit must be a non-negative integer"],
      ["an array limit", { limit: [10] }, "options.limit must be a non-negative integer"],
      [
        "a limit of Number.MAX_SAFE_INTEGER",
        { limit: Number.MAX_SAFE_INTEGER },
        "options.limit must be a non-negative integer",
      ],
      ["a limit of 1e21", { limit: 1e21 }, "options.limit must be a non-negative integer"],
      ["a numeric string offset", { offset: "10" }, "options.offset must be a non-negative integer"],
      ["a fractional offset", { offset: 1.5 }, "options.offset must be a non-negative integer"],
      ["a negative offset", { offset: -1 }, "options.offset must be a non-negative integer"],
      ["an array offset", { offset: [10] }, "options.offset must be a non-negative integer"],
      [
        "an offset of Number.MAX_SAFE_INTEGER",
        { offset: Number.MAX_SAFE_INTEGER },
        "options.offset must be a non-negative integer",
      ],
      ["an offset of 1e21", { offset: 1e21 }, "options.offset must be a non-negative integer"],
      ["null options", null, "options must be an object"],
      ["string options", "500", "options must be an object"],
    ];

    test.each(refused)("refuses %s with 400 before any provider resolves", async (_name, options, error) => {
      const res = await send(options);

      expect(res.status).toBe(400);
      expect((await parseResponseJSON<{ error: string }>(res)).error).toBe(error);
      expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
      expect(mockProvider.prepareQuery).not.toHaveBeenCalled();
      expect(mockProvider.query).not.toHaveBeenCalled();
    });

    // `;;;` splits into nothing to run, which the route refuses with its own sentence when the split runs first.
    test("refuses the options before the text is split", async () => {
      const res = await send({ limit: "10" }, ";;;");

      expect(res.status).toBe(400);
      expect((await parseResponseJSON<{ error: string }>(res)).error).toBe(
        "options.limit must be a non-negative integer",
      );
    });

    const accepted: Array<[string, unknown, Record<string, unknown>]> = [
      ["no options", undefined, {}],
      ["empty options", {}, {}],
      ["an integer limit and offset", { limit: 50, offset: 100 }, { limit: 50, offset: 100 }],
      ["a zero limit", { limit: 0 }, { limit: 0 }],
      [
        "one below Number.MAX_SAFE_INTEGER as limit and offset",
        { limit: Number.MAX_SAFE_INTEGER - 1, offset: Number.MAX_SAFE_INTEGER - 1 },
        { limit: Number.MAX_SAFE_INTEGER - 1, offset: Number.MAX_SAFE_INTEGER - 1 },
      ],
      ["an unlimited run", { unlimited: true }, { unlimited: true }],
    ];

    test.each(accepted)("runs %s as before", async (_name, options, prepared) => {
      const res = await send(options);

      expect(res.status).toBe(200);
      expect(mockProvider.prepareQuery).toHaveBeenCalledWith("SELECT * FROM users", prepared);
      expect(mockProvider.query).toHaveBeenCalledWith(
        "SELECT * FROM users LIMIT 50",
        undefined,
        undefined,
        expect.any(String),
      );
    });
  });

  test("last SELECT gets prepareQuery applied", async () => {
    const req = createMockRequest("/api/db/multi-query", {
      method: "POST",
      body: {
        connection: validConnection,
        sql: "INSERT INTO users (name) VALUES ('test'); SELECT * FROM users",
      },
    });

    await POST(req as never);

    // prepareQuery should have been called for the SELECT (last statement)
    expect(mockProvider.prepareQuery).toHaveBeenCalled();
  });

  test("non-SELECT statements do not get prepareQuery applied", async () => {
    const req = createMockRequest("/api/db/multi-query", {
      method: "POST",
      body: {
        connection: validConnection,
        sql: "INSERT INTO users (name) VALUES ('test')",
      },
    });

    await POST(req as never);

    // prepareQuery should NOT have been called for a single INSERT
    expect(mockProvider.prepareQuery).not.toHaveBeenCalled();
  });

  // ─── Which final statement gets bounded (#281) ─────────────────────────────
  // The route used to answer "is this a SELECT" with its own `/^\s*SELECT\b/i`,
  // which tolerates whitespace but not a comment, so an annotated final SELECT
  // reached the engine unprepared. It now reads the shared classifier.
  //
  // The ` LIMIT 50` these assert on is the mock provider's marker, not the real
  // limiter's output: what is under test here is WHICH statement the route hands
  // to `prepareQuery` and that it executes the prepared text. The bound a real
  // provider produces for these same statements is pinned at the shared seam, in
  // `tests/unit/db/query-limiter.test.ts` and `tests/unit/db/sql-base.test.ts`.
  // ── The split happens under the resolved connection's dialect (S1) ────────
  //
  // This is the one surface that EXECUTES what the splitter returns, so a fragment
  // invented by a reading the engine does not share is a statement the operator never
  // wrote. Measured on postgres 18 (container libredb-postgres): block comments nest,
  // so `/* a /* b */ ; DROP TABLE users; -- */ SELECT 1` is ONE read there - `ran = 1`,
  // and the table still in `pg_class` afterwards. The dialect-blind splitter cut it
  // into three and this route ran fragment two, a bare `DROP TABLE users`.
  describe("dialect-aware splitting", () => {
    const attack = "/* a /* b */ ; DROP TABLE users; -- */ SELECT 1";

    test("a PostgreSQL connection runs one statement and never the hidden DROP", async () => {
      const req = createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: { connection: validConnection, sql: attack },
      });

      const res = await POST(req as never);
      const data = await parseResponseJSON<{ statementCount: number; statements: { sql: string }[] }>(res);
      const executed = (mockProvider.query as ReturnType<typeof mock>).mock.calls.map((call) => call[0]);

      expect(data.statementCount).toBe(1);
      expect(executed).not.toContain("DROP TABLE users");
      expect(data.statements[0].sql).toBe(attack);
    });

    test("a MySQL connection reads the same text flat, which is that engine's own answer", async () => {
      // Measured on MySQL (container libredb-mysql): the DROP really does run there -
      // the schema's table count went to 0 - so three fragments is the honest split and
      // the confirmation gate is what must ask about it, not this route.
      const req = createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: { connection: { ...validConnection, type: "mysql", port: 3306 }, sql: attack },
      });

      const res = await POST(req as never);
      const data = await parseResponseJSON<{ statementCount: number }>(res);

      expect(data.statementCount).toBe(3);
    });
  });

  // #1312: what one request carries is the dialect's unit, not the `;`-statement.
  describe("execution units", () => {
    const executed = () => (mockProvider.query as ReturnType<typeof mock>).mock.calls.map((call) => call[0]);

    test("a T-SQL batch is ONE provider call, sent whole and unbounded", async () => {
      const sql = "DECLARE @x INT = 5; SELECT @x * 2 AS doubled;\nGO\nSELECT 3 AS c";
      const req = createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: { connection: { ...validConnection, type: "mssql", port: 1433 }, sql },
      });

      const res = await POST(req as never);
      const data = await parseResponseJSON<{ statementCount: number; statements: { sql: string }[] }>(res);

      expect(data.statementCount).toBe(2);
      // Only the script's last unit is bounded, as only its last statement was before.
      expect(executed()).toEqual(["DECLARE @x INT = 5; SELECT @x * 2 AS doubled", "SELECT 3 AS c LIMIT 50"]);
      expect(data.statements.map((statement) => statement.sql)).toEqual([
        "DECLARE @x INT = 5; SELECT @x * 2 AS doubled",
        "SELECT 3 AS c",
      ]);
    });

    const mssql = { ...validConnection, type: "mssql", port: 1433 };

    test("the last batch's last read is bounded in place, the statements before it as written", async () => {
      const req = createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: { connection: mssql, sql: "SELECT 1; SELECT * FROM big;" },
      });

      await POST(req as never);

      expect(executed()).toEqual(["SELECT 1; SELECT * FROM big LIMIT 50"]);
    });

    test.each([
      "CREATE PROCEDURE p AS SET NOCOUNT ON; SELECT * FROM big",
      "CREATE OR ALTER VIEW v AS SELECT 1 AS a; SELECT * FROM big",
      "ALTER FUNCTION f() RETURNS TABLE AS RETURN SELECT 1 AS a; SELECT * FROM big",
    ])("a batch that is a module body is never bounded, its tail being the stored body: %s", async (sql) => {
      const req = createMockRequest("/api/db/multi-query", { method: "POST", body: { connection: mssql, sql } });

      await POST(req as never);

      expect(executed()).toEqual([sql]);
    });

    test("a last batch that ends with a write is sent as written", async () => {
      const req = createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: { connection: mssql, sql: "SELECT 1; DELETE FROM t" },
      });

      await POST(req as never);

      expect(executed()).toEqual(["SELECT 1; DELETE FROM t"]);
    });

    test("a batch with several result sets shows the last one with rows", async () => {
      (mockProvider.query as ReturnType<typeof mock>).mockImplementation(async () => ({
        rows: [{ a: 1 }],
        fields: ["a"],
        rowCount: 1,
        executionTime: 1,
        resultSets: [
          { rows: [{ a: 1 }], fields: ["a"] },
          { rows: [{ b: 2 }, { b: 3 }], fields: ["b"], columnTypes: { b: "int" } },
          { rows: [], fields: ["c"] },
        ],
      }));
      const req = createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: { connection: mssql, sql: "SELECT 1 AS a; SELECT b FROM t; SELECT c FROM empty" },
      });

      const data = await parseResponseJSON<{
        rows: unknown[];
        fields: string[];
        rowCount: number;
        statements: { columnTypes?: Record<string, string> }[];
      }>(await POST(req as never));

      expect(data.rows).toEqual([{ b: 2 }, { b: 3 }]);
      expect(data.fields).toEqual(["b"]);
      expect(data.rowCount).toBe(2);
      expect(data.statements[0].columnTypes).toEqual({ b: "int" });
    });

    test.each<[string, Record<string, unknown>, number]>([
      // One result set after a write: the engine's count is the INSERT's, not the shown rows'.
      [
        "INSERT INTO t VALUES (1),(2); SELECT * FROM t",
        { rows: [{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }, { a: 5 }], fields: ["a"], rowCount: 2 },
        5,
      ],
      // No result set at all: the engine's count is the only one there is.
      ["UPDATE t SET a = 1; UPDATE u SET b = 2", { rows: [], fields: [], rowCount: 7 }, 7],
    ])("a batch's count is its shown rows when it has a result set: %s", async (sql, answer, rowCount) => {
      (mockProvider.query as ReturnType<typeof mock>).mockImplementation(async () => ({ executionTime: 1, ...answer }));
      const req = createMockRequest("/api/db/multi-query", { method: "POST", body: { connection: mssql, sql } });

      const data = await parseResponseJSON<{ statements: { rowCount: number }[] }>(await POST(req as never));

      expect(data.statements[0].rowCount).toBe(rowCount);
    });

    test("a single-statement unit keeps the engine's own result even when it carries several sets", async () => {
      (mockProvider.query as ReturnType<typeof mock>).mockImplementation(async () => ({
        rows: [{ a: 1 }],
        fields: ["a"],
        rowCount: 1,
        executionTime: 1,
        resultSets: [
          { rows: [{ a: 1 }], fields: ["a"] },
          { rows: [{ b: 2 }], fields: ["b"] },
        ],
      }));
      const req = createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: { connection: mssql, sql: "EXEC sp_help\nGO" },
      });

      const data = await parseResponseJSON<{ rows: unknown[] }>(await POST(req as never));

      expect(data.rows).toEqual([{ a: 1 }]);
    });

    test("an Oracle PL/SQL unit is one call that keeps its END;, and the `/` line is never sent", async () => {
      const req = createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: {
          connection: { ...validConnection, type: "oracle", port: 1521 },
          sql: "CREATE PROCEDURE p AS BEGIN UPDATE emp SET a = 1; END;\n/\nBEGIN p; END;",
        },
      });

      await POST(req as never);

      expect(executed()).toEqual(["CREATE PROCEDURE p AS BEGIN UPDATE emp SET a = 1; END;", "BEGIN p; END;"]);
    });
  });

  describe("final-statement classification", () => {
    test("comment-led final SELECT is prepared and the bounded SQL reaches the engine", async () => {
      const finalStatement = "-- final read\nSELECT * FROM users";

      const req = createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: {
          connection: validConnection,
          sql: `INSERT INTO users (name) VALUES ('a');\n${finalStatement}`,
          options: { limit: 50 },
        },
      });

      await POST(req as never);

      expect(mockProvider.prepareQuery).toHaveBeenCalledWith(finalStatement, { limit: 50 });
      // The response echoes the original text, so the engine-visible bound is the
      // only honest assertion that the statement was actually limited.
      expect(mockProvider.query).toHaveBeenCalledWith(
        `${finalStatement} LIMIT 50`,
        undefined,
        undefined,
        expect.any(String),
      );
    });

    test("final statement that is not a SELECT is executed unprepared", async () => {
      const req = createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: {
          connection: validConnection,
          sql: "SELECT * FROM users;\n-- annotated write\nUPDATE users SET name = 'b'",
        },
      });

      await POST(req as never);

      expect(mockProvider.prepareQuery).not.toHaveBeenCalled();
      expect(mockProvider.query).toHaveBeenCalledWith(
        "-- annotated write\nUPDATE users SET name = 'b'",
        undefined,
        undefined,
        expect.any(String),
      );
    });

    test("non-final SELECT is executed unprepared", async () => {
      const req = createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: {
          connection: validConnection,
          sql: "-- first read\nSELECT * FROM a;\nINSERT INTO b VALUES (1)",
        },
      });

      await POST(req as never);

      expect(mockProvider.prepareQuery).not.toHaveBeenCalled();
      expect(mockProvider.query).toHaveBeenCalledWith(
        "-- first read\nSELECT * FROM a",
        undefined,
        undefined,
        expect.any(String),
      );
    });

    test("comment-led final read-only CTE is prepared", async () => {
      const finalStatement = "-- read\nWITH c AS (SELECT 1 AS a) SELECT * FROM c";

      const req = createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: {
          connection: validConnection,
          sql: `INSERT INTO t VALUES (1);\n${finalStatement}`,
        },
      });

      await POST(req as never);

      expect(mockProvider.query).toHaveBeenCalledWith(
        `${finalStatement} LIMIT 50`,
        undefined,
        undefined,
        expect.any(String),
      );
    });

    test("comment-led final data-modifying CTE is executed unprepared", async () => {
      // The shared classifier types a `WITH` by the keyword its CTE list operates
      // (#287), so the `SELECT` this statement supplies itself must not win it a
      // bound - that bound would cap the rows it WRITES.
      const finalStatement = "-- write\nWITH c AS (DELETE FROM logs RETURNING id) INSERT INTO audit SELECT id FROM c";

      const req = createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: {
          connection: validConnection,
          sql: `SELECT 1;\n${finalStatement}`,
        },
      });

      await POST(req as never);

      expect(mockProvider.prepareQuery).not.toHaveBeenCalled();
      expect(mockProvider.query).toHaveBeenCalledWith(finalStatement, undefined, undefined, expect.any(String));
    });

    // The route resolves its connection before it asks the classifier, so it asks
    // under THAT connection's dialect (#292). Without the dialect this statement
    // types `SELECT` - the `#-` reads as a PostgreSQL jsonb operator, so the `)`
    // inside the comment closes the CTE body early - and the route would hand a
    // `DELETE` to `prepareQuery`. Pinned here because this is the one caller layer
    // where the route, not the provider, decides whether the statement is a read.
    test("the final statement is classified under the connection's own dialect", async () => {
      const finalStatement = "WITH t AS (\n  #- drop the ) SELECT here\n  SELECT id FROM logs\n) DELETE FROM users";

      const req = createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: {
          connection: { ...validConnection, type: "mysql" },
          sql: `SELECT 1;\n${finalStatement}`,
        },
      });

      await POST(req as never);

      expect(mockProvider.prepareQuery).not.toHaveBeenCalled();
      expect(mockProvider.query).toHaveBeenCalledWith(finalStatement, undefined, undefined, expect.any(String));
    });
  });

  test("QueryError from getOrCreateProvider returns 400", async () => {
    mockGetOrCreateProvider.mockImplementation(async () => {
      throw new QueryError("Bad query", "postgres");
    });

    const req = createMockRequest("/api/db/multi-query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT 1" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Bad query");
  });

  test("TimeoutError from getOrCreateProvider returns 504", async () => {
    mockGetOrCreateProvider.mockImplementation(async () => {
      throw new TimeoutError("Query timed out", "postgres", 30000);
    });

    const req = createMockRequest("/api/db/multi-query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT 1" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(504);
    expect(data.error).toContain("timed out");
  });
  // ── An unfinished transaction never outlives the request (D71) ────────────
  //
  // Measured 2026-09-13 through the product's own routes. `BEGIN; CREATE TABLE
  // ...; SELECT * FROM <missing>` breaks out of the loop on the third statement
  // and the transaction the first one opened stays open on the provider handle,
  // which `getOrCreateProvider` caches per `connection.id` for the whole process.
  // On PostgreSQL 17 the next request — a DIFFERENT user, on POST /api/db/query —
  // answered HTTP 500 "current transaction is aborted, commands ignored until end
  // of transaction block", and so did POST /api/db/maintenance minutes later. On
  // SQLite the loss is silent instead: the next user's INSERT answers 200 and reads
  // its own row back while an independent reader sees nothing, and a later ROLLBACK
  // destroys it with no error anywhere.

  function providerEndingTransactions(outcome: "none" | "rolled-back") {
    const endOpenQueryTransaction = mock(async () => outcome);
    mockGetOrCreateProvider.mockImplementation(async () => ({ ...mockProvider, endOpenQueryTransaction }) as never);
    return endOpenQueryTransaction;
  }

  test("ends a transaction the script left open and says so, when a statement failed", async () => {
    const endOpenQueryTransaction = providerEndingTransactions("rolled-back");
    (mockProvider.query as ReturnType<typeof mock>).mockImplementation(async (sql: string) => {
      if (sql.includes("no_such_table")) throw new Error('relation "no_such_table" does not exist');
      return { rows: [], fields: [], rowCount: 0, executionTime: 1 };
    });

    const req = createMockRequest("/api/db/multi-query", {
      method: "POST",
      body: { connection: validConnection, sql: "BEGIN; CREATE TABLE t(id int); SELECT * FROM no_such_table" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ hasError: boolean; openTransaction?: string }>(res);

    expect(endOpenQueryTransaction).toHaveBeenCalledTimes(1);
    expect(data.hasError).toBe(true);
    expect(data.openTransaction).toBe("rolled-back");
  });

  test("ends a transaction the script left open when every statement succeeded", async () => {
    // The deliberate answer to the question the defect raised: a script may NOT
    // leave a transaction open on a shared handle, error or no error. `BEGIN;
    // INSERT;` with no COMMIT is rolled back and the author is told, rather than
    // handed to whoever borrows the handle next.
    const endOpenQueryTransaction = providerEndingTransactions("rolled-back");

    const req = createMockRequest("/api/db/multi-query", {
      method: "POST",
      body: { connection: validConnection, sql: "BEGIN; INSERT INTO t VALUES (1)" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ hasError: boolean; openTransaction?: string }>(res);

    expect(endOpenQueryTransaction).toHaveBeenCalledTimes(1);
    expect(data.hasError).toBe(false);
    expect(data.openTransaction).toBe("rolled-back");
  });

  test("says nothing when the script left no transaction open", async () => {
    // Absent rather than "none": the client renders the notice from the field's
    // presence alone, the same rule the two channels above follow.
    const endOpenQueryTransaction = providerEndingTransactions("none");

    const req = createMockRequest("/api/db/multi-query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT 1" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<Record<string, unknown>>(res);

    expect(endOpenQueryTransaction).toHaveBeenCalledTimes(1);
    expect("openTransaction" in data).toBe(false);
  });

  test("every statement and the ender run under ONE scope, this request's own (D87)", async () => {
    // The ender can only reach the clients the scope it is given ran on, so a script whose
    // statements ran under one scope and whose ender named another would end nothing —
    // and a script sharing a scope with another request would end that request's work.
    // MEASURED 2026-09-15 on PostgreSQL 18.4: with one shared pointer instead of a scope,
    // a plain read on /api/db/query rolled this route's script back mid-script while the
    // script was told all four of its statements had succeeded.
    const endOpenQueryTransaction = mock(async (_scope: string) => "rolled-back" as const);
    mockGetOrCreateProvider.mockImplementation(async () => ({ ...mockProvider, endOpenQueryTransaction }) as never);

    const first = await POST(
      createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: { connection: validConnection, sql: "BEGIN; INSERT INTO t VALUES (1); SELECT 1" },
      }) as never,
    );
    expect(first.status).toBe(200);

    const scopes = (mockProvider.query as ReturnType<typeof mock>).mock.calls.map((call) => call[3]);
    expect(scopes).toHaveLength(3);
    expect(new Set(scopes).size).toBe(1);
    expect(typeof scopes[0]).toBe("string");
    expect(endOpenQueryTransaction).toHaveBeenLastCalledWith(scopes[0]);

    // And the next request is a different one: a scope is this request's own.
    (mockProvider.query as ReturnType<typeof mock>).mockClear();
    await POST(
      createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: { connection: validConnection, sql: "SELECT 1" },
      }) as never,
    );
    const second = (mockProvider.query as ReturnType<typeof mock>).mock.calls[0][3];
    expect(second).not.toBe(scopes[0]);
    expect(endOpenQueryTransaction).toHaveBeenLastCalledWith(second);
  });

  test("a provider that cannot end one is asked nothing and answers as before", async () => {
    const req = createMockRequest("/api/db/multi-query", {
      method: "POST",
      body: { connection: validConnection, sql: "SELECT 1" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<Record<string, unknown>>(res);

    expect(res.status).toBe(200);
    expect("openTransaction" in data).toBe(false);
  });
});

/**
 * A type that declares a console text bound runs one statement per request, so this route, whose SQL splitter would
 * turn one console text into several requests, refuses it before splitting anything.
 */
describe("POST /api/db/multi-query: a type that declares a console text bound", () => {
  const REFUSAL =
    "This connection type runs one statement per request: send it to POST /api/db/query, because this route would split its text into several requests.";
  let remove: () => void = () => {};

  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateProvider.mockClear();
    remove = installStandInVocabulary({ maxTextBytes: 64 });
  });

  afterEach(() => {
    remove();
    remove = () => {};
  });

  test("is refused with 400 naming POST /api/db/query, before the text is split or a provider acquired", async () => {
    // `;` alone splits into no statement, which answers "No valid SQL statements found" when the split runs first.
    const res = await POST(
      createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: { connection: { id: "stand-in-1", name: "Stand-in", type: STAND_IN_TYPE }, sql: ";" },
      }) as never,
    );
    expect(res.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(res)).error).toBe(REFUSAL);
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
  });

  test("a type that declares no bound is split and run as before", async () => {
    const res = await POST(
      createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: { connection: validConnection, sql: "SELECT 1; SELECT 2" },
      }) as never,
    );
    expect(res.status).toBe(200);
    expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(1);
  });

  test("the real influxdb row declares a bound, so an InfluxQL text is refused the same way (InfluxDB spec A.11)", async () => {
    const res = await POST(
      createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: {
          connection: { id: "influxdb-1", name: "Telegraf", type: "influxdb", host: "127.0.0.1", port: 8086 },
          sql: "SHOW DATABASES; SHOW MEASUREMENTS",
        },
      }) as never,
    );
    expect(res.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(res)).error).toBe(REFUSAL);
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
  });

  test("the real firestore row declares a bound, so a Firestore text is refused instead of split (Firestore spec 3.2)", async () => {
    const res = await POST(
      createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: {
          connection: { id: "firestore-1", name: "Orders", type: "firestore", database: "acme-orders" },
          sql: 'db.collection("a").get(); db.collection("b").get()',
        },
      }) as never,
    );
    expect(res.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(res)).error).toBe(REFUSAL);
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
  });

  test("influxdb3 declares no bound: its SQL is split under the DataFusion row and run as before", async () => {
    const res = await POST(
      createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: {
          connection: { id: "influxdb3-1", name: "Edge", type: "influxdb3", host: "127.0.0.1", port: 8181 },
          sql: "SELECT 1; SELECT 2",
        },
      }) as never,
    );
    expect(res.status).toBe(200);
    expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/db/multi-query: the request's abort", () => {
  const SCRIPT = "SELECT 1; SELECT 2; SELECT 3";

  function abortableRequest(body: Record<string, unknown>, signal: AbortSignal): Request {
    return new Request("http://localhost:3000/api/db/multi-query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  }

  /** A cancel-capable provider whose first unit waits until it is cancelled. */
  function cancellableProvider() {
    const registered: (string | undefined)[] = [];
    let release: (() => void) | undefined;
    const provider = createMockProvider();
    const cancelQuery = mock(async (_id: string) => {
      release?.();
      return true;
    });
    (provider.query as ReturnType<typeof mock>).mockImplementation(
      async (_sql: string, _params?: unknown[], queryId?: string) => {
        registered.push(queryId);
        if (registered.length === 1) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          throw new QueryCancelledError("The query was cancelled.");
        }
        return { rows: [{ n: 1 }], fields: ["n"], rowCount: 1, executionTime: 1 };
      },
    );
    Object.assign(provider, { cancelQuery });
    return { provider, cancelQuery, registered };
  }

  beforeEach(() => {
    clearRateLimitState();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
  });

  test("an abort during unit 1 of 3 cancels the request's id once and starts no further unit", async () => {
    const { provider, cancelQuery, registered } = cancellableProvider();
    mockGetOrCreateProvider.mockImplementation(async () => provider as never);
    const controller = new AbortController();
    const answer = POST(
      abortableRequest({ connection: validConnection, sql: SCRIPT, queryId: "q-1-script" }, controller.signal) as never,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await answer;
    expect(registered).toEqual(["q-1-script"]);
    expect(cancelQuery).toHaveBeenCalledTimes(1);
    expect(cancelQuery).toHaveBeenCalledWith("q-1-script");
  });

  test("a unit that ends cancelled starts no further unit, with no abort at all", async () => {
    const provider = createMockProvider();
    (provider.query as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new QueryCancelledError("The query was cancelled.");
    });
    Object.assign(provider, { cancelQuery: mock(async () => true) });
    mockGetOrCreateProvider.mockImplementation(async () => provider as never);
    const res = await POST(
      createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: { connection: validConnection, sql: SCRIPT, queryId: "q-2-script" },
      }) as never,
    );
    const body = await parseResponseJSON<{ executedCount: number }>(res);
    expect(provider.query).toHaveBeenCalledTimes(1);
    expect(body.executedCount).toBe(1);
  });

  test("a request aborted before the handler starts no statement", async () => {
    const { provider, registered } = cancellableProvider();
    mockGetOrCreateProvider.mockImplementation(async () => provider as never);
    const controller = new AbortController();
    controller.abort();
    const res = await POST(
      abortableRequest({ connection: validConnection, sql: SCRIPT, queryId: "q-3-script" }, controller.signal) as never,
    );
    expect(registered).toEqual([]);
    expect([400, 499]).toContain(res.status);
  });

  test("a provider without cancelQuery is asked nothing and the loop still stops", async () => {
    const provider = createMockProvider();
    const seen: (string | undefined)[] = [];
    let release: (() => void) | undefined;
    (provider.query as ReturnType<typeof mock>).mockImplementation(
      async (_sql: string, _params?: unknown[], queryId?: string) => {
        seen.push(queryId);
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { rows: [], fields: [], rowCount: 0, executionTime: 1 };
      },
    );
    mockGetOrCreateProvider.mockImplementation(async () => provider as never);
    const controller = new AbortController();
    const answer = POST(
      abortableRequest({ connection: validConnection, sql: SCRIPT, queryId: "q-4-script" }, controller.signal) as never,
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    release?.();
    await answer;
    // No id is bound for a provider that cannot cancel, and unit 2 never starts.
    expect(seen).toEqual([undefined]);
  });

  test("a queryId that is not a string is refused before any provider work", async () => {
    mockGetOrCreateProvider.mockClear();
    const res = await POST(
      createMockRequest("/api/db/multi-query", {
        method: "POST",
        body: { connection: validConnection, sql: SCRIPT, queryId: 42 },
      }) as never,
    );
    expect(res.status).toBe(400);
    expect((await parseResponseJSON<{ error: string }>(res)).error).toBe("queryId must be a string");
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
  });

  test("a cancel that rejects still lets the route answer, and logs no secret", async () => {
    const { provider, registered } = cancellableProvider();
    let release: (() => void) | undefined;
    (provider.query as ReturnType<typeof mock>).mockImplementation(async (_s: string, _p?: unknown[], id?: string) => {
      registered.push(id);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new QueryCancelledError("The query was cancelled.");
    });
    Object.assign(provider, {
      cancelQuery: mock(async () => {
        release?.();
        throw new Error("token sentinel-SECRET-9");
      }),
    });
    mockGetOrCreateProvider.mockImplementation(async () => provider as never);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const controller = new AbortController();
      const answer = POST(
        abortableRequest(
          { connection: validConnection, sql: SCRIPT, queryId: "q-5-script" },
          controller.signal,
        ) as never,
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort();
      const res = await answer;
      expect(res.status).toBe(200);
      expect(warn.mock.calls.flat().join(" ")).not.toContain("sentinel-SECRET-9");
    } finally {
      warn.mockRestore();
    }
  });
});

const { recordGovernanceSnapshot, resetGovernanceState } = await import("@/lib/governance/state");
const { validateSettings } = await import("@/lib/governance/settings");
const { grantedSnapshot } = await import("../../helpers/governance/granted-snapshot");
const { queryEventInput } = await import("../../helpers/governance/query-event-input");
const { flushQueryEvents, queryEventSinkState, recordQueryEvent, resetQueryEventSink } = await import(
  "@/lib/query-events/sink"
);
const { SeedConnectionError: MockedSeedConnectionError } = (await import(
  "@/lib/seed/resolve-connection"
)) as unknown as {
  SeedConnectionError: new (message: string, statusCode: number, code?: string) => Error;
};
const { logger } = await import("@/lib/logger");

/**
 * The query events of a script (docs/GOVERNANCE.md#query-events): under governance one `multi-query` event per unit
 * that ran, with its index and one correlation id for the whole request, no row for a unit that never ran, and one
 * `refused` event for a request turned away before any unit ran. The sink, the builder and the admission gate are the
 * real ones; only the insert is faked, and every test reads the rows the sink handed to it.
 */
describe("POST /api/db/multi-query: query events under governance", () => {
  const SUBJECT = "8d0f6a4e-2b1c-4f3a-9e7d-5c6b4a3f2e1d";
  const governedSession = { role: "user", username: "alice@example.com", idpSubject: SUBJECT };
  /** A governed record as `resolveConnection` hands it out under a read grant. */
  const governedConnection = {
    id: "seed:orders",
    name: "Orders",
    type: "postgres",
    host: "orders.db.example.internal",
    port: 5432,
    database: "orders",
    user: "reader",
    password: "example-only-read-password",
    managed: true,
    literal: true,
    grantLevel: "read",
  };
  const ENV: Readonly<Record<string, string>> = {
    GOVERNANCE_SOURCE: "postgres",
    GOVERNANCE_POSTGRES_URL: "postgresql://libredb_studio@db.internal:5432/libredb?sslmode=verify-full",
    GOVERNANCE_INSTANCE_ID: "libredb-studio",
  };
  let saved: Record<string, string | undefined> = {};

  function settings(...rows: { readonly key: string; readonly value: unknown }[]): void {
    recordGovernanceSnapshot({
      ...grantedSnapshot([], []),
      settings: validateSettings(
        rows.map(({ key, value }) => ({ key, value, updated_at: new Date() })),
        1,
      ),
    });
  }

  /** Every event the sink holds, inserted at once, as the shutdown flush inserts them. */
  async function recordedEvents(): Promise<QueryEventRow[]> {
    await flushQueryEvents();
    return insertedEvents;
  }

  function run(body: Record<string, unknown>) {
    return POST(createMockRequest("/api/db/multi-query", { method: "POST", body }) as never);
  }

  beforeEach(() => {
    saved = {};
    for (const [name, value] of Object.entries(ENV)) {
      saved[name] = process.env[name];
      process.env[name] = value;
    }
    clearRateLimitState();
    insertedEvents.length = 0;
    insertFailure = null;
    settings({ key: "queryLog.statementCapture", value: "full" });
    resolveConnectionOverride = async () => governedConnection;
    mockGetSession.mockImplementation(async () => governedSession);
    mockGetOrCreateProvider.mockClear();
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider as never);
    (mockProvider.query as ReturnType<typeof mock>).mockClear();
    (mockProvider.query as ReturnType<typeof mock>).mockImplementation(async (sql: string) => {
      if (sql.includes("missing")) {
        throw mapDatabaseError(
          Object.assign(new Error('relation "missing" does not exist'), { code: "42P01" }),
          "postgres",
          sql,
        );
      }
      return { rows: [{ id: 1 }, { id: 2 }, { id: 3 }], fields: ["id"], rowCount: 3, executionTime: 2 };
    });
    (mockProvider.prepareQuery as ReturnType<typeof mock>).mockImplementation((query: string) => ({
      query: `${query} LIMIT 50`,
      wasLimited: true,
      limit: 50,
      offset: 0,
    }));
  });

  afterEach(() => {
    resetQueryEventSink();
    resetGovernanceState();
    resolveConnectionOverride = undefined;
    insertFailure = null;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
  });

  test("governance: one event per executed unit and none after the first error", async () => {
    const res = await run({
      connectionId: "seed:orders",
      sql: "SELECT id FROM orders; SELECT * FROM missing; SELECT id FROM customers",
    });

    expect(res.status).toBe(200);
    const events = await recordedEvents();
    expect(events.map((event) => [event.unit_index, event.status])).toEqual([
      [0, "success"],
      [1, "error"],
    ]);
    expect(events[0]).toMatchObject({
      source: "multi-query",
      subject: SUBJECT,
      connection_id: "orders",
      engine: "postgres",
      access_level: "read",
      statement: "SELECT id FROM orders",
      row_count: 3,
    });
    expect(events[1]).toMatchObject({ statement: "SELECT * FROM missing", error_code: "42P01", row_count: null });
    const correlationId = events[0].correlation_id;
    expect(correlationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(events[1].correlation_id).toBe(correlationId);
  });

  test("governance: the last unit keeps the text the user wrote, not the bound added to it", async () => {
    await run({ connectionId: "seed:orders", sql: "SELECT id FROM orders" });

    const events = await recordedEvents();
    expect(mockProvider.query).toHaveBeenCalledWith(
      "SELECT id FROM orders LIMIT 50",
      undefined,
      undefined,
      expect.any(String),
    );
    expect(events.map((event) => event.statement)).toEqual(["SELECT id FROM orders"]);
  });

  test("governance: each request has a correlation id of its own", async () => {
    await run({ connectionId: "seed:orders", sql: "SELECT 1" });
    await run({ connectionId: "seed:orders", sql: "SELECT 2" });

    const events = await recordedEvents();
    expect(events).toHaveLength(2);
    expect(events[0].correlation_id).not.toBe(events[1].correlation_id);
  });

  test("governance: a cancelled unit records status cancelled", async () => {
    (mockProvider.query as ReturnType<typeof mock>).mockImplementation(async () => {
      throw new QueryCancelledError("The query was cancelled.");
    });

    await run({ connectionId: "seed:orders", sql: "SELECT pg_sleep(60); SELECT 2" });

    const events = await recordedEvents();
    expect(events.map((event) => [event.unit_index, event.status])).toEqual([[0, "cancelled"]]);
  });

  test("governance: refuse mode with a backing-off sink answers 503 AUDIT_UNAVAILABLE and records one refused event", async () => {
    settings({ key: "queryLog.onSinkFailure", value: "refuse" });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      insertFailure = { sqlstate: "08006", reason: "08006" };
      recordQueryEvent(queryEventInput());
      await flushQueryEvents();

      const res = await run({ connectionId: "seed:orders", sql: "SELECT 1; SELECT 2" });

      expect(res.status).toBe(503);
      expect(((await res.json()) as { code: string }).code).toBe("AUDIT_UNAVAILABLE");
      expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
      expect(mockProvider.query).not.toHaveBeenCalled();

      insertFailure = null;
      const refused = (await recordedEvents()).filter((event) => event.source === "multi-query");
      expect(refused).toHaveLength(1);
      expect(refused[0]).toMatchObject({
        status: "refused",
        engine: "postgres",
        access_level: "read",
        unit_index: null,
        error_code: "AUDIT_UNAVAILABLE",
      });
    } finally {
      warn.mockRestore();
    }
  });

  test("governance: a non-granted id records a refused event with null engine and access level", async () => {
    resolveConnectionOverride = async () => {
      throw new MockedSeedConnectionError(
        "Connection not found: it does not exist or is not granted to you",
        404,
        "CONNECTION_NOT_FOUND",
      );
    };

    const res = await run({ connectionId: "seed:payroll", sql: "SELECT 1; SELECT 2" });

    expect(res.status).toBe(404);
    const events = await recordedEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "multi-query",
      status: "refused",
      connection_id: "payroll",
      engine: null,
      access_level: null,
      statement: null,
      error_code: "CONNECTION_NOT_FOUND",
    });
  });

  test("governance: a request refused as malformed records nothing", async () => {
    const res = await run({ connectionId: "seed:orders", sql: "   " });

    expect(res.status).toBe(400);
    expect(await recordedEvents()).toEqual([]);
  });

  test("with governance off the route records nothing", async () => {
    process.env.GOVERNANCE_SOURCE = "";

    const res = await run({ connectionId: "seed:orders", sql: "SELECT 1; SELECT * FROM missing" });

    expect(res.status).toBe(200);
    expect(queryEventSinkState().queued).toBe(0);
    expect(await recordedEvents()).toEqual([]);
  });
});

// A JSON `null` body or one that is not JSON at all answered 500 INTERNAL_ERROR with the runtime's own text ("Cannot destructure property 'sql' ...").
// Any body that is not a JSON object is the caller's malformed request, answered before any connection resolves.
describe("POST /api/db/multi-query: a body that is not a JSON object", () => {
  test.each<[string, string]>([
    ["null", "null"],
    ["an array", "[]"],
    ["a number", "7"],
    ["a string", '"x"'],
    ["text that is not JSON", "{not json"],
  ])("a body that is %s answers 400 and opens no provider", async (_label, raw) => {
    mockGetOrCreateProvider.mockClear();
    const res = await POST(
      new Request("http://localhost:3000/api/db/multi-query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      }) as never,
    );

    expect(res.status).toBe(400);
    expect(await parseResponseJSON(res)).toEqual({ error: "Invalid request body" });
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
  });
});
