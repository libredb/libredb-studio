import { describe, test, expect, mock, beforeEach, afterEach, jest, spyOn } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import { admittedConnection, grantedSnapshot } from "../../helpers/governance/granted-snapshot";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { API_CODES } from "@/lib/governance/contract";
import { logger } from "@/lib/logger";
import { transactionGone } from "@/hooks/use-transaction-control";
import {
  QueryError,
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  TimeoutError,
  AuthenticationError,
  PoolExhaustedError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
  isRetryableError,
  mapDatabaseError,
  NO_TRANSACTION_OPENED,
} from "@/lib/db/errors";
import type { BeginTransactionOptions, BeginTransactionResult } from "@/lib/db/types";
import type { QueryEventInput } from "@/lib/query-events/types";

// ─── Create mock provider with transaction methods ──────────────────────────
const baseMockProvider = createMockProvider();

const mockTxProvider = {
  ...baseMockProvider,
  beginTransaction: mock(async (_options?: BeginTransactionOptions): Promise<BeginTransactionResult | void> => {}),
  commitTransaction: mock(async () => {}),
  rollbackTransaction: mock(async () => {}),
  isInTransaction: mock(() => true),
  queryInTransaction: mock(async () => ({
    rows: [{ id: 1, name: "Alice" }],
    fields: ["id", "name"],
    rowCount: 1,
    executionTime: 10,
  })),
};

// Non-transaction provider (no transaction methods)
const mockNonTxProvider = createMockProvider();

// Typed with the factory's arguments, so a test can hand each owner of a connection a provider of its own.
const mockGetOrCreateProvider = mock<(...args: unknown[]) => Promise<never>>(async () => mockTxProvider as never);

/** A session as `getSession` answers it; under governance it carries the identity provider subject too. */
type MockSession = { role: string; username: string; idpSubject?: string };

const mockGetSession = mock(async (): Promise<MockSession | null> => ({ role: "admin", username: "admin" }));

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

mock.module("@/lib/seed/resolve-connection", () => {
  class SeedConnectionError extends Error {
    constructor(
      message: string,
      public statusCode: number,
    ) {
      super(message);
      this.name = "SeedConnectionError";
    }
  }
  return {
    resolveConnection: mock(async (body: Record<string, unknown>) => {
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
  createDatabaseProvider: mock(async () => mockTxProvider),
  removeProvider: mock(async () => {}),
  clearProviderCache: mock(async () => {}),
  getProviderCacheStats: mock(() => ({ size: 0, connections: [] })),
  QueryError,
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  TimeoutError,
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

// ─── The factory's writable cache as the route reads it under governance (docs/GOVERNANCE.md#per-user-providers) ───
//
// `editorCacheKey` frames what the factory's key frames for these tests: the connection, the credential it opens with,
// and the owner. `findCachedProvider` answers nothing until a test registers its providers.
const mockEditorCacheKey = mock(async (connection: { id: string; user?: string }, execution?: { owner?: string }) =>
  JSON.stringify([connection.id, connection.user ?? null, execution?.owner ?? null]),
);
const mockFindCachedProvider = mock<(key: string) => unknown>(() => null);

mock.module("@/lib/db/factory", () => ({
  editorCacheKey: mockEditorCacheKey,
  findCachedProvider: mockFindCachedProvider,
}));

// ─── Query events (docs/GOVERNANCE.md#query-events) ─────────────────────────
//
// The sink is replaced, so a recorded event is read here instead of being queued for the governance pool
// (`src/lib/query-events/sink.ts`), and the admission gate is a double a test can close;
// tests/unit/lib/query-events/admission.test.ts pins the real gate.
const realSink = { ...(await import("@/lib/query-events/sink")) };
const recordedEvents: QueryEventInput[] = [];
mock.module("@/lib/query-events/sink", () => ({
  ...realSink,
  recordQueryEvent: (input: QueryEventInput) => {
    recordedEvents.push(input);
  },
}));
const mockAdmitQueryExecution = mock(() => {});
mock.module("@/lib/query-events/admission", () => ({ admitQueryExecution: mockAdmitQueryExecution }));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import("@/app/api/db/transaction/route");
const { releaseTransaction, transactionKey } = await import("@/lib/api/transaction-ownership");
const { registerOwnerRemoval } = await import("@/lib/db/owner-removal");
const { swapGovernanceSnapshot } = await import("@/lib/governance/snapshot");
const { recordGovernanceSnapshot, resetGovernanceState } = await import("@/lib/governance/state");

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
describe("POST /api/db/transaction", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetOrCreateProvider.mockClear();
    mockTxProvider.beginTransaction.mockClear();
    mockTxProvider.commitTransaction.mockClear();
    mockTxProvider.rollbackTransaction.mockClear();
    mockTxProvider.isInTransaction.mockClear();
    mockTxProvider.queryInTransaction.mockClear();
    (mockTxProvider.prepareQuery as ReturnType<typeof mock>).mockClear();

    // Reset to default implementations
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
    mockGetOrCreateProvider.mockImplementation(async () => mockTxProvider as never);
    mockTxProvider.beginTransaction.mockImplementation(async () => {});
    mockTxProvider.commitTransaction.mockImplementation(async () => {});
    mockTxProvider.rollbackTransaction.mockImplementation(async () => {});
    mockTxProvider.isInTransaction.mockImplementation(() => true);
    mockTxProvider.queryInTransaction.mockImplementation(async () => ({
      rows: [{ id: 1, name: "Alice" }],
      fields: ["id", "name"],
      rowCount: 1,
      executionTime: 10,
    }));
    // The implementation, not just the call log: `mockClear()` above leaves a previous
    // test's `mockImplementation` in place, and the pagination tests below install one.
    // Restores `createMockProvider`'s default.
    (mockTxProvider.prepareQuery as ReturnType<typeof mock>).mockImplementation((query: string) => ({
      query: `${query} LIMIT 50`,
      wasLimited: true,
      limit: 50,
      offset: 0,
    }));
  });

  // `count` is what the engine answered to the statement that ran, which asks for one row past the
  // 50-row page (#1440): 50 is a page that ended exactly full, 51 is a page with a next one.
  for (const [count, providerLimited, expectedMore, expectedReturned, expectedLimited] of [
    [2, false, false, 2, false],
    [50, false, false, 50, false],
    [51, false, true, 50, true],
    [2, true, false, 2, true],
  ] as const) {
    test(`reports a ${count}-row answer with provider cut=${providerLimited} accurately`, async () => {
      (mockTxProvider.queryInTransaction as ReturnType<typeof mock>).mockResolvedValueOnce({
        rows: Array.from({ length: count }, (_, i) => ({ id: i + 1 })),
        fields: ["id"],
        rowCount: count,
        executionTime: 1,
        pagination: { limit: 50, offset: 0, hasMore: false, totalReturned: count, wasLimited: providerLimited },
      });
      const req = createMockRequest("/api/db/transaction", {
        method: "POST",
        body: { connection: validConnection, action: "query", sql: "SELECT * FROM users" },
      });
      const res = await POST(req as never);
      const data = await parseResponseJSON<{ pagination: unknown }>(res);
      expect(res.status).toBe(200);
      expect(data.pagination).toEqual({
        limit: 50,
        offset: 0,
        hasMore: expectedMore,
        totalReturned: expectedReturned,
        wasLimited: expectedLimited,
      });
    });
  }

  // `JSON.stringify` writes NaN and both infinities as `null`; inside a transaction they
  // travel as words just as on `/api/db/query`.
  test("answers NaN and the infinities as words, not as null", async () => {
    (mockTxProvider.queryInTransaction as ReturnType<typeof mock>).mockResolvedValueOnce({
      rows: [{ f: Number.NaN, r: Number.POSITIVE_INFINITY, n: Number.NEGATIVE_INFINITY, ok: 1.5, z: null }],
      fields: ["f", "r", "n", "ok", "z"],
      rowCount: 1,
      executionTime: 1,
    });
    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: { connection: validConnection, action: "query", sql: "SELECT * FROM floats" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ rows: unknown[] }>(res);

    expect(res.status).toBe(200);
    expect(data.rows).toEqual([{ f: "NaN", r: "Infinity", n: "-Infinity", ok: 1.5, z: null }]);
  });

  test("returns 401 when no session exists", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: { connection: validConnection, action: "begin" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(401);
    expect(data.error).toContain("Authentication required");
  });

  test("without governance a transaction records no query event and arms no timer", async () => {
    recordedEvents.length = 0;
    const timers = spyOn(globalThis, "setTimeout");
    try {
      for (const body of [
        { action: "begin" },
        { action: "query", sql: "INSERT INTO t VALUES (1)" },
        { action: "commit" },
        { action: "begin" },
        { action: "rollback" },
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- one action after another, as the editor sends them.
        const res = await POST(
          createMockRequest("/api/db/transaction", {
            method: "POST",
            body: { connection: validConnection, ...body },
          }) as never,
        );
        expect(res.status).toBe(200);
      }
      expect(recordedEvents).toEqual([]);
      expect(timers).not.toHaveBeenCalled();
    } finally {
      timers.mockRestore();
    }
  });

  test("begin action returns status active", async () => {
    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: { connection: validConnection, action: "begin" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ status: string; message: string }>(res);

    expect(res.status).toBe(200);
    expect(data.status).toBe("active");
    expect(data.message).toBe("Transaction started");
    expect(mockTxProvider.beginTransaction).toHaveBeenCalledTimes(1);
    // A manual BEGIN does not ask for a reported state, and a provider that says nothing
    // about the state is answered with `null`, not with a claim either way.
    expect(mockTxProvider.beginTransaction.mock.calls[0]?.[0]).toEqual({ requireReportedState: false });
    expect((data as { stateReported?: unknown }).stateReported).toBeNull();
  });

  test("begin carries what the provider learned about the server's transaction state", async () => {
    mockTxProvider.beginTransaction.mockImplementation(async () => ({ stateReported: false }));
    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: { connection: validConnection, action: "begin" },
    });

    const data = await parseResponseJSON<{ stateReported: boolean | null }>(await POST(req as never));
    expect(data.stateReported).toBe(false);
  });

  test("SANDBOX's begin asks the provider for a reported state", async () => {
    // Only a literal `true` asks: the flag refuses work, so nothing truthy-but-odd turns it on.
    for (const [requireReportedState, expected] of [
      [true, true],
      ["yes", false],
    ] as const) {
      mockTxProvider.beginTransaction.mockClear();
      const req = createMockRequest("/api/db/transaction", {
        method: "POST",
        body: {
          connection: { ...validConnection, id: `sandbox-flag-${expected}` },
          action: "begin",
          requireReportedState,
        },
      });
      expect((await POST(req as never)).status).toBe(200);
      expect(mockTxProvider.beginTransaction.mock.calls[0]?.[0]).toEqual({ requireReportedState: expected });
    }
  });

  test("commit action returns status committed", async () => {
    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: { connection: validConnection, action: "commit" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ status: string; message: string }>(res);

    expect(res.status).toBe(200);
    expect(data.status).toBe("committed");
    expect(data.message).toBe("Transaction committed");
    expect(mockTxProvider.commitTransaction).toHaveBeenCalledTimes(1);
  });

  test("rollback action returns status rolled_back", async () => {
    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: { connection: validConnection, action: "rollback" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ status: string; message: string }>(res);

    expect(res.status).toBe(200);
    expect(data.status).toBe("rolled_back");
    expect(data.message).toBe("Transaction rolled back");
    expect(mockTxProvider.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  test("query action sends no copy of a multi-result text's every set (#1312)", async () => {
    (mockTxProvider.queryInTransaction as ReturnType<typeof mock>).mockResolvedValueOnce({
      rows: [{ a: 1 }],
      fields: ["a"],
      rowCount: 1,
      executionTime: 1,
      resultSets: [
        { rows: [{ a: 1 }], fields: ["a"] },
        { rows: [{ b: 2 }], fields: ["b"] },
      ],
    });
    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      // A T-SQL batch is one request, so the two sets come back from one call. Under a dialect
      // that runs one statement per call the route sends them one by one instead (#1390).
      body: { connection: { ...validConnection, type: "mssql" }, action: "query", sql: "SELECT 1 AS a; SELECT 2 AS b" },
    });

    const data = await parseResponseJSON<Record<string, unknown>>(await POST(req as never));
    expect(mockTxProvider.queryInTransaction).toHaveBeenCalledTimes(1);

    expect(data.rows).toEqual([{ a: 1 }]);
    expect(Object.hasOwn(data, "resultSets")).toBe(false);
  });

  /**
   * A selection of several statements inside BEGIN or SANDBOX (#1390). It reached the engine as
   * one text, and MySQL 26.7.0, which runs one statement per call, answered a syntax error at
   * the start of the second. The route runs them in order on the transaction's connection and
   * answers in the multi-statement shape `/api/db/multi-query` uses.
   */
  describe("query action with several statements (#1390)", () => {
    type ScriptAnswer = {
      multiStatement: boolean;
      statementCount: number;
      executedCount: number;
      hasError: boolean;
      inTransaction: boolean;
      rows: unknown[];
      pagination?: unknown;
      statements: { index: number; sql: string; status: string; error?: string }[];
    };
    const run = async (sql: string) => {
      const req = createMockRequest("/api/db/transaction", {
        method: "POST",
        body: { connection: { ...validConnection, type: "mysql" }, action: "query", sql },
      });
      const res = await POST(req as never);
      return { res, data: await parseResponseJSON<ScriptAnswer>(res) };
    };

    test("runs each statement in order inside the transaction", async () => {
      const { res, data } = await run(
        "UPDATE e2e.ui_t SET price = 6 WHERE id = 2;\nUPDATE e2e.ui_t SET price = 7 WHERE id = 1;",
      );

      expect(res.status).toBe(200);
      const sent = mockTxProvider.queryInTransaction.mock.calls.map((call) => String((call as unknown[])[0]));
      expect(sent).toHaveLength(2);
      expect(sent[0]).toContain("price = 6");
      expect(sent[0]).not.toContain("price = 7");
      expect(sent[1]).toContain("price = 7");
      expect(data.multiStatement).toBe(true);
      expect(data.statementCount).toBe(2);
      expect(data.executedCount).toBe(2);
      expect(data.hasError).toBe(false);
      expect(data.inTransaction).toBe(true);
      // A script has no next page: Load More would run every statement again.
      expect(data.pagination).toBeUndefined();
    });

    test("bounds only the last statement, and shows the last result that has rows", async () => {
      mockTxProvider.queryInTransaction.mockImplementationOnce(async () => ({
        rows: [],
        fields: [],
        rowCount: 1,
        executionTime: 1,
      }));
      const { data } = await run("UPDATE t SET a = 1; SELECT * FROM t");

      const sent = mockTxProvider.queryInTransaction.mock.calls.map((call) => String((call as unknown[])[0]));
      expect(sent[0]).not.toContain("LIMIT 50");
      expect(sent[1]).toContain("LIMIT 50");
      expect(data.rows).toEqual([{ id: 1, name: "Alice" }]);
    });

    test("stops at the first failure and names it", async () => {
      mockTxProvider.queryInTransaction.mockImplementationOnce(async () => {
        throw new Error("Duplicate entry '1' for key 'PRIMARY'");
      });
      const { res, data } = await run("INSERT INTO t VALUES (1); UPDATE t SET a = 2");

      expect(res.status).toBe(200);
      expect(mockTxProvider.queryInTransaction).toHaveBeenCalledTimes(1);
      expect(data.hasError).toBe(true);
      expect(data.executedCount).toBe(1);
      expect(data.statements[0]).toMatchObject({ index: 0, status: "error" });
      expect(data.statements[0].error).toContain("Duplicate entry");
    });

    test("a script's last statement failing at the bound Studio added says so (SF-022)", async () => {
      mockTxProvider.queryInTransaction.mockImplementationOnce(async () => ({
        rows: [],
        fields: [],
        rowCount: 1,
        executionTime: 1,
      }));
      mockTxProvider.queryInTransaction.mockImplementationOnce(async () => {
        throw new Error('syntax error at or near "LIMIT"');
      });
      const { data } = await run("UPDATE t SET a = 1; SELECT * FROM t WHERE");

      expect(data.statements[1].error).toBe(
        'syntax error at or near "LIMIT" Studio added the clause LIMIT 50 to this statement to bound its rows, so a position or token this error names may be in that clause rather than in your text.',
      );
    });

    test("a statement and a trailing comment stay one statement", async () => {
      const { data } = await run("SELECT * FROM t; -- note");

      expect(mockTxProvider.queryInTransaction).toHaveBeenCalledTimes(1);
      expect(data.multiStatement).toBeUndefined();
      expect(data.pagination).toBeDefined();
      // Sent as the splitter read it, without the comment fragment, as the script route sends it.
      expect(String((mockTxProvider.queryInTransaction.mock.calls[0] as unknown[])[0])).toBe(
        "SELECT * FROM t LIMIT 50",
      );
    });

    test("an Oracle block followed by its `/` line is sent without the separator", async () => {
      const req = createMockRequest("/api/db/transaction", {
        method: "POST",
        body: {
          connection: { ...validConnection, type: "oracle" },
          action: "query",
          sql: "BEGIN\n  UPDATE t SET a = 1;\nEND;\n/",
        },
      });
      const res = await POST(req as never);

      expect(res.status).toBe(200);
      const sent = String((mockTxProvider.queryInTransaction.mock.calls[0] as unknown[])[0]);
      expect(sent).toContain("END;");
      expect(sent).not.toContain("/");
    });

    test("a statement that ended the transaction is reported and the connection handed back", async () => {
      mockTxProvider.isInTransaction.mockImplementation(() => true);
      mockTxProvider.queryInTransaction.mockImplementationOnce(async () => {
        mockTxProvider.isInTransaction.mockImplementation(() => false);
        return { rows: [], fields: [], rowCount: 0, executionTime: 1 };
      });
      const { data } = await run("UPDATE t SET a = 1; COMMIT");

      expect(data.inTransaction).toBe(false);
    });
  });

  test("a lone statement failing at the bound Studio added says so; another failure is left alone (SF-022)", async () => {
    const send = async (message: string) => {
      (mockTxProvider.queryInTransaction as ReturnType<typeof mock>).mockImplementationOnce(async () => {
        throw new QueryError(message);
      });
      const req = createMockRequest("/api/db/transaction", {
        method: "POST",
        body: { connection: validConnection, action: "query", sql: "SELECT * FROM users WHERE" },
      });
      return parseResponseJSON<{ error: string }>(await POST(req as never));
    };

    expect((await send("syntax error line 1 at position 26 unexpected '50'")).error).toBe(
      "syntax error line 1 at position 26 unexpected '50' Studio added the clause LIMIT 50 to this statement to bound its rows, so a position or token this error names may be in that clause rather than in your text.",
    );
    expect((await send("relation users does not exist")).error).toBe("relation users does not exist");
  });

  test("query action with sql returns result with pagination", async () => {
    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: { connection: validConnection, action: "query", sql: "SELECT * FROM users" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      rows: unknown[];
      fields: string[];
      rowCount: number;
      inTransaction: boolean;
      pagination: { limit: number; offset: number; hasMore: boolean; totalReturned: number; wasLimited: boolean };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.inTransaction).toBe(true);
    expect(data.rows).toBeDefined();
    expect(data.fields).toBeDefined();
    expect(data.pagination).toBeDefined();
    expect(data.pagination.wasLimited).toBe(false);
  });

  /**
   * `hasMore` requires that the bound is OURS, on THIS route too (#816).
   *
   * Neither the design nor its review names this endpoint, and it computes the same
   * `hasMore` off the same `prepareQuery` call as `/api/db/query`. It is not a
   * hypothetical second copy: `use-query-execution.ts:391` sends a run here whenever a
   * transaction is open or the playground is driving, Load More included, so a control
   * offered on a statement the limiter declined to rewrite would re-run it unchanged and
   * append the rows already on screen. One field, one meaning, both routes.
   */
  test("refuses a limit that is not a non-negative integer before the limiter runs", async () => {
    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: { connection: validConnection, action: "query", sql: "SELECT 1", options: { limit: "500" } },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(400);
    expect(mockTxProvider.prepareQuery).not.toHaveBeenCalled();
    expect(mockTxProvider.queryInTransaction).not.toHaveBeenCalled();
  });

  test("offers no next page inside a transaction when the limiter left the statement alone", async () => {
    (mockTxProvider.prepareQuery as ReturnType<typeof mock>).mockImplementation((query: string) => ({
      query,
      wasLimited: false,
      limit: 2,
      offset: 0,
    }));
    (mockTxProvider.queryInTransaction as ReturnType<typeof mock>).mockImplementation(async () => ({
      rows: [{ id: 1 }, { id: 2 }],
      fields: ["id"],
      rowCount: 2,
      executionTime: 3,
    }));

    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: { connection: validConnection, action: "query", sql: "SELECT * FROM users LIMIT 2" },
    });

    const data = await parseResponseJSON<{
      pagination: { hasMore: boolean; wasLimited: boolean; limit: number };
    }>(await POST(req as never));

    // Exactly `limit` rows came back, which is the whole of the old condition.
    expect(data.pagination.limit).toBe(2);
    expect(data.pagination.wasLimited).toBe(false);
    expect(data.pagination.hasMore).toBe(false);
  });

  test("still offers the next page inside a transaction when the bound is the limiter's", async () => {
    // The control, paired with the negative above so neither can pass by accident.
    (mockTxProvider.prepareQuery as ReturnType<typeof mock>).mockImplementation((query: string) => ({
      query: `${query} LIMIT 2`,
      wasLimited: true,
      limit: 2,
      offset: 0,
    }));
    // The statement that runs asks for one row past the page, so a next page is three rows here.
    (mockTxProvider.queryInTransaction as ReturnType<typeof mock>).mockImplementation(async () => ({
      rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
      fields: ["id"],
      rowCount: 3,
      executionTime: 3,
    }));

    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: { connection: validConnection, action: "query", sql: "SELECT * FROM users" },
    });

    const data = await parseResponseJSON<{
      rows: unknown[];
      rowCount: number;
      pagination: { hasMore: boolean; wasLimited: boolean; totalReturned: number };
    }>(await POST(req as never));

    expect(data.pagination.wasLimited).toBe(true);
    expect(data.pagination.hasMore).toBe(true);
    // The probe row is not part of the answer (#1440).
    expect(data.rows).toEqual([{ id: 1 }, { id: 2 }]);
    expect(data.rowCount).toBe(2);
    expect(data.pagination.totalReturned).toBe(2);
  });

  // A row edit applied while a transaction is open takes this endpoint, so the
  // values have to be bound here too — otherwise the transaction path would be the
  // one place a generated statement still carried its values as text (#290).

  test("query action binds the request's parameters", async () => {
    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: {
        connection: validConnection,
        action: "query",
        sql: `UPDATE users SET "name" = $1 WHERE "id" = $2`,
        params: ["\\' WHERE 1=1 -- ", 7],
      },
    });

    const res = await POST(req as never);

    expect(res.status).toBe(200);
    expect(mockTxProvider.queryInTransaction).toHaveBeenCalledWith(
      `UPDATE users SET "name" = $1 WHERE "id" = $2 LIMIT 50`,
      ["\\' WHERE 1=1 -- ", 7],
    );
  });

  test("query action returns 400 for a parameter the driver cannot bind as a scalar", async () => {
    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: {
        connection: validConnection,
        action: "query",
        sql: "SELECT * FROM users WHERE id = $1",
        params: [{ nested: true }],
      },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("params");
    expect(mockTxProvider.queryInTransaction).not.toHaveBeenCalled();
  });

  // A `sql` that is present but not a string answered 500 with a TypeError of its own, thrown by the splitter or, with
  // `params`, by the provider's prepareQuery. It is refused in words before any provider resolves, a falsy one (0,
  // false) included.
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
      const req = createMockRequest("/api/db/transaction", {
        method: "POST",
        body: { connection: validConnection, action: "query", sql },
      });

      const res = await POST(req as never);
      const data = await parseResponseJSON<{ error: string }>(res);

      expect(res.status).toBe(400);
      expect(data.error).toBe("sql must be a string");
      expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
    });
  }

  // Only the query action reads `sql`: another action that carries one that is not a string answers as it does
  // without one.
  for (const [action, sql, answer, providerCall] of [
    ["begin", 123, { status: "active", message: "Transaction started" }, mockTxProvider.beginTransaction],
    ["commit", ["COMMIT"], { status: "committed", message: "Transaction committed" }, mockTxProvider.commitTransaction],
    ["rollback", 0, { status: "rolled_back", message: "Transaction rolled back" }, mockTxProvider.rollbackTransaction],
    ["status", { text: "SELECT 1" }, { inTransaction: true }, mockTxProvider.isInTransaction],
  ] as const) {
    test(`the ${action} action ignores a sql that is not a string`, async () => {
      const req = createMockRequest("/api/db/transaction", {
        method: "POST",
        body: { connection: validConnection, action, sql },
      });

      const res = await POST(req as never);

      expect(res.status).toBe(200);
      expect(await parseResponseJSON<Record<string, unknown>>(res)).toMatchObject(answer);
      expect(providerCall).toHaveBeenCalledTimes(1);
    });
  }

  test("an empty sql keeps the answer of a missing one", async () => {
    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: { connection: validConnection, action: "query", sql: "" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toBe("SQL query is required for transaction query");
  });

  test("a null sql keeps the answer of a missing one", async () => {
    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: { connection: validConnection, action: "query", sql: null },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toBe("SQL query is required for transaction query");
  });

  test("query action without sql returns 400", async () => {
    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: { connection: validConnection, action: "query" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("SQL query is required");
  });

  test("status action returns inTransaction boolean", async () => {
    mockTxProvider.isInTransaction.mockImplementation(() => false);

    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: { connection: validConnection, action: "status" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ inTransaction: boolean }>(res);

    expect(res.status).toBe(200);
    expect(data.inTransaction).toBe(false);
  });

  test("unknown action returns 400", async () => {
    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: { connection: validConnection, action: "invalid-action" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Unknown transaction action");
  });

  test("missing connection returns 400", async () => {
    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: { action: "begin" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("required");
  });

  test("missing action returns 400", async () => {
    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: { connection: validConnection },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Connection and action are required");
  });

  test("provider without transaction support returns 400", async () => {
    mockGetOrCreateProvider.mockImplementation(async () => mockNonTxProvider as never);

    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: { connection: validConnection, action: "begin" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("not supported");
  });

  test("QueryError returns 400", async () => {
    mockTxProvider.beginTransaction.mockImplementation(async () => {
      throw new QueryError("Syntax error near BEGIN", "postgres");
    });

    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: { connection: validConnection, action: "begin" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Syntax error");
  });

  // ─── Transaction ownership (D72) ──────────────────────────────────────────
  //
  // Measured on PostgreSQL 18.4 on 2026-09-13, through POST /api/db/transaction, two Studio
  // sessions on ONE connection id: `user` opened a transaction and inserted a row, `admin` was
  // refused its own begin with 400 "Transaction already active", and was then allowed to roll
  // back with 200. The engine had zero rows and `user`'s own commit came back "No active
  // transaction". txActive/txClient live on the provider, and getOrCreateProvider caches one
  // provider per connection id, so every Studio user on that connection drove one transaction.

  /** A provider double whose transaction state actually changes, so ownership can be observed. */
  function openableProvider() {
    let txOpen = false;
    mockTxProvider.isInTransaction.mockImplementation(() => txOpen);
    mockTxProvider.beginTransaction.mockImplementation(async () => {
      txOpen = true;
    });
    mockTxProvider.commitTransaction.mockImplementation(async () => {
      txOpen = false;
    });
    mockTxProvider.rollbackTransaction.mockImplementation(async () => {
      txOpen = false;
    });
    return {
      /** Stand in for PostgresProvider's TX_TIMEOUT_MS auto-rollback: no session behind it. */
      expire: () => {
        txOpen = false;
      },
    };
  }

  function asSession(username: string, role = "user") {
    mockGetSession.mockImplementation(async () => ({ role, username }));
  }

  function call(connectionId: string, body: Record<string, unknown>) {
    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: { connection: { ...validConnection, id: connectionId }, ...body },
    });
    return POST(req as never);
  }

  test("a second session cannot roll back the transaction another session opened", async () => {
    openableProvider();

    asSession("alice");
    expect((await call("d72-rollback", { action: "begin" })).status).toBe(200);

    asSession("bob", "admin");
    const res = await call("d72-rollback", { action: "rollback" });
    const data = await parseResponseJSON<{ error: string; code: string; availableAt: string }>(res);

    expect(res.status).toBe(409);
    expect(data.code).toBe("TRANSACTION_NOT_OWNED");
    expect(data.error).toContain("belongs to another session");
    expect(data.availableAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(mockTxProvider.rollbackTransaction).not.toHaveBeenCalled();
  });

  test("a second session cannot begin, query or commit on another session's transaction", async () => {
    openableProvider();

    asSession("alice");
    expect((await call("d72-actions", { action: "begin" })).status).toBe(200);

    asSession("bob", "admin");
    // Collected rather than asserted inside the loop: an assertion in a loop body certifies
    // nothing if the loop runs zero times, and these two arrays are wrong at the wrong LENGTH.
    const statuses: number[] = [];
    const codes: string[] = [];
    for (const body of [{ action: "begin" }, { action: "commit" }, { action: "query", sql: "SELECT 1" }]) {
      const res = await call("d72-actions", body);
      statuses.push(res.status);
      codes.push((await parseResponseJSON<{ code: string }>(res)).code);
    }
    expect(statuses).toEqual([409, 409, 409]);
    expect(codes).toEqual(["TRANSACTION_NOT_OWNED", "TRANSACTION_NOT_OWNED", "TRANSACTION_NOT_OWNED"]);

    expect(mockTxProvider.beginTransaction).toHaveBeenCalledTimes(1);
    expect(mockTxProvider.commitTransaction).not.toHaveBeenCalled();
    expect(mockTxProvider.queryInTransaction).not.toHaveBeenCalled();
  });

  test("the owner keeps full control of its own transaction, and hands the connection back on commit", async () => {
    openableProvider();

    asSession("alice");
    expect((await call("d72-owner", { action: "begin" })).status).toBe(200);
    expect((await call("d72-owner", { action: "query", sql: "SELECT 1" })).status).toBe(200);
    expect((await call("d72-owner", { action: "commit" })).status).toBe(200);

    asSession("bob", "admin");
    expect((await call("d72-owner", { action: "begin" })).status).toBe(200);
    expect(mockTxProvider.beginTransaction).toHaveBeenCalledTimes(2);
  });

  test("without governance no provider key is computed or compared, so another credential is answered as before", async () => {
    // The credential-change refusal is governance's (docs/GOVERNANCE.md#per-user-providers): without it the record
    // names no provider key, and a request that opens the connection with another credential reaches the shared
    // provider exactly as it always did.
    openableProvider();
    mockEditorCacheKey.mockClear();
    mockFindCachedProvider.mockClear();

    asSession("alice");
    expect((await call("d72-credential", { action: "begin" })).status).toBe(200);
    const res = await POST(
      createMockRequest("/api/db/transaction", {
        method: "POST",
        body: { connection: { ...validConnection, id: "d72-credential", user: "another-user" }, action: "commit" },
      }) as never,
    );

    expect(res.status).toBe(200);
    expect(mockTxProvider.commitTransaction).toHaveBeenCalledTimes(1);
    expect(mockEditorCacheKey).not.toHaveBeenCalled();
    expect(mockFindCachedProvider).not.toHaveBeenCalled();
  });

  test("status is answered for every session and says who holds the transaction", async () => {
    openableProvider();

    asSession("alice");
    await call("d72-status", { action: "begin" });

    const mine = await parseResponseJSON<{
      inTransaction: boolean;
      ownedByYou: boolean;
      heldByAnotherSession: boolean;
      startedAt: string | null;
    }>(await call("d72-status", { action: "status" }));
    expect(mine).toMatchObject({ inTransaction: true, ownedByYou: true, heldByAnotherSession: false });
    expect(mine.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    asSession("bob", "admin");
    const res = await call("d72-status", { action: "status" });
    expect(res.status).toBe(200);
    expect(await parseResponseJSON(res)).toMatchObject({
      inTransaction: true,
      ownedByYou: false,
      heldByAnotherSession: true,
    });
  });

  test("a transaction the provider auto-rolled back leaves no owner behind", async () => {
    const provider = openableProvider();

    asSession("alice");
    await call("d72-expired", { action: "begin" });
    provider.expire();

    asSession("bob", "admin");
    const res = await call("d72-expired", { action: "begin" });

    expect(res.status).toBe(200);
    expect(mockTxProvider.beginTransaction).toHaveBeenCalledTimes(2);
  });

  test("an owner that never comes back releases the connection once its lease lapses", async () => {
    openableProvider();

    asSession("alice");
    await call("d72-abandoned", { action: "begin" });

    // MSSQLProvider and OracleProvider have no TX_TIMEOUT_MS of their own, so the transaction
    // stays open forever. Without the lease the refusal above would never lift for anyone else.
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60 * 1000;
    try {
      asSession("bob", "admin");
      const res = await call("d72-abandoned", { action: "rollback" });
      expect(res.status).toBe(200);
      expect(mockTxProvider.rollbackTransaction).toHaveBeenCalledTimes(1);
    } finally {
      Date.now = realNow;
    }
  });

  test("a begin the provider refuses does not make the caller the owner of an open transaction", async () => {
    // The escape-hatch state: a transaction is open and no record names an owner, which is what a
    // restarted process finds, and what a lapsed lease leaves behind. Any session may end it. A
    // claim written before the provider answered would hand that transaction to whoever asked
    // first, and the provider's own "Transaction already active" would be the only thing they saw.
    mockTxProvider.isInTransaction.mockImplementation(() => true);
    mockTxProvider.beginTransaction.mockImplementation(async () => {
      throw new QueryError("Transaction already active", "postgres");
    });

    asSession("alice");
    expect((await call("d72-unowned", { action: "begin" })).status).toBe(400);

    asSession("bob", "admin");
    expect(await parseResponseJSON(await call("d72-unowned", { action: "status" }))).toMatchObject({
      inTransaction: true,
      ownedByYou: false,
      heldByAnotherSession: false,
    });
    expect((await call("d72-unowned", { action: "rollback" })).status).toBe(200);
    expect(mockTxProvider.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  test("a begin that throws records no owner", async () => {
    openableProvider();
    mockTxProvider.beginTransaction.mockImplementation(async () => {
      throw new QueryError("Transaction already active", "postgres");
    });

    asSession("alice");
    expect((await call("d72-failed-begin", { action: "begin" })).status).toBe(400);

    openableProvider();
    asSession("bob", "admin");
    expect((await call("d72-failed-begin", { action: "begin" })).status).toBe(200);
  });

  test("a statement that ended the transaction is reported, and the connection is handed back", async () => {
    // The provider ends its session when the server says the statement committed (MySQL DDL,
    // a typed COMMIT). The caller is told, instead of being left to ask for a ROLLBACK that
    // would answer success and undo nothing.
    const provider = openableProvider();
    mockTxProvider.queryInTransaction.mockImplementationOnce(async () => {
      provider.expire();
      return { rows: [], fields: [], rowCount: 0, executionTime: 1 };
    });

    asSession("alice");
    await call("sandbox-ddl", { action: "begin" });
    const res = await call("sandbox-ddl", { action: "query", sql: "CREATE TABLE t (id INT)" });

    expect(res.status).toBe(200);
    expect((await parseResponseJSON<{ inTransaction: boolean }>(res)).inTransaction).toBe(false);

    // The record went with the transaction: another session may begin at once.
    asSession("bob", "admin");
    expect((await call("sandbox-ddl", { action: "begin" })).status).toBe(200);
  });

  test("a begin the server opened no transaction for answers 400 with the reason", async () => {
    mockTxProvider.beginTransaction.mockImplementation(async () => {
      throw new QueryError(NO_TRANSACTION_OPENED, "postgres");
    });

    const res = await call("no-tx-engine", { action: "begin" });
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toBe(NO_TRANSACTION_OPENED);
  });

  test("DatabaseError returns 500", async () => {
    mockTxProvider.beginTransaction.mockImplementation(async () => {
      throw new DatabaseError("Internal database error", "postgres", "DATABASE_ERROR");
    });

    const req = createMockRequest("/api/db/transaction", {
      method: "POST",
      body: { connection: validConnection, action: "begin" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toContain("Internal database error");
  });
});

// ─── Server-level connections (#1530) ───────────────────────────────────────
describe("POST /api/db/transaction on a server-level connection (#1530)", () => {
  function session() {
    return {
      ...baseMockProvider,
      beginTransaction: mock(async () => {}),
      commitTransaction: mock(async () => {}),
      rollbackTransaction: mock(async () => {}),
      isInTransaction: mock(() => false),
      queryInTransaction: mock(async () => ({ rows: [], fields: [], rowCount: 0, executionTime: 1 })),
    };
  }

  test("each database holds its own transaction, owned by whoever opened it there", async () => {
    const sessions = { shop: session(), analytics: session() };
    mockTxProvider.beginTransaction.mockClear();
    const defaults = mockTxProvider.getCapabilities();
    const capabilities = mockTxProvider.getCapabilities as ReturnType<typeof mock>;
    capabilities.mockImplementation(() => ({ ...defaults, catalogSessions: true }));
    const server = mockTxProvider as typeof mockTxProvider & { forCatalog?: unknown };
    server.forCatalog = mock(async (catalog: "shop" | "analytics") => sessions[catalog]);
    const as = (username: string) => mockGetSession.mockImplementationOnce(async () => ({ role: "admin", username }));
    const send = (body: Record<string, unknown>) =>
      POST(
        createMockRequest("/api/db/transaction", {
          method: "POST",
          body: { connection: { ...validConnection, id: "server-1", database: "" }, ...body },
        }) as never,
      );
    try {
      as("alice");
      expect((await send({ action: "begin", catalog: "shop" })).status).toBe(200);
      expect(sessions.shop.beginTransaction).toHaveBeenCalledTimes(1);
      sessions.shop.isInTransaction.mockImplementation(() => true);

      // Another database is another transaction, so Alice's does not refuse Bob there.
      as("bob");
      expect((await send({ action: "begin", catalog: "analytics" })).status).toBe(200);
      sessions.analytics.isInTransaction.mockImplementation(() => true);

      // And Alice's is still hers.
      as("bob");
      const refused = await send({ action: "commit", catalog: "shop" });
      expect(refused.status).toBe(409);
      expect(sessions.shop.commitTransaction).not.toHaveBeenCalled();

      as("alice");
      expect((await send({ action: "query", catalog: "shop", sql: "SELECT 1" })).status).toBe(200);
      expect(sessions.shop.queryInTransaction).toHaveBeenCalledTimes(1);
      expect(mockTxProvider.beginTransaction).not.toHaveBeenCalled();
    } finally {
      capabilities.mockImplementation(() => defaults);
      delete server.forCatalog;
      for (const catalog of ["shop", "analytics"]) {
        as(catalog === "shop" ? "alice" : "bob");
        await send({ action: "rollback", catalog });
      }
    }
  });
});

// ─── Per-user transactions under governance (docs/GOVERNANCE.md#per-user-providers) ───
//
// Under governance every user of a connection has a provider of their own, so a transaction is one
// user's: the factory keys the provider by the owner the execution context names, the session's
// identity provider subject, and the ownership record is keyed and owned by that subject too. Without
// it, a user whose own provider holds no transaction would drop another user's record on reconcile, and
// that user's transaction would become anyone's to end.
describe("POST /api/db/transaction under governance", () => {
  let savedSource: string | undefined;

  beforeEach(() => {
    savedSource = process.env.GOVERNANCE_SOURCE;
    process.env.GOVERNANCE_SOURCE = "postgres";
    clearRateLimitState();
  });

  afterEach(() => {
    if (savedSource === undefined) delete process.env.GOVERNANCE_SOURCE;
    else process.env.GOVERNANCE_SOURCE = savedSource;
    mockGetOrCreateProvider.mockImplementation(async () => mockTxProvider as never);
    mockFindCachedProvider.mockImplementation(() => null);
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
    mockAdmitQueryExecution.mockReset();
    recordedEvents.length = 0;
    // A record a test left open would be reconciled, and recorded, by the next test's first request.
    for (const subject of ["alice-subject", "bob-subject"])
      releaseTransaction(transactionKey("seed:orders", undefined, subject));
  });

  /** A provider double whose transaction state changes, as each owner's own provider would. */
  function transactionProvider() {
    let open = false;
    return {
      ...baseMockProvider,
      beginTransaction: mock(async () => {
        open = true;
      }),
      commitTransaction: mock(async () => {
        open = false;
      }),
      rollbackTransaction: mock(async () => {
        open = false;
      }),
      isInTransaction: mock(() => open),
      queryInTransaction: mock(async () => ({ rows: [], fields: [], rowCount: 0, executionTime: 1 })),
    };
  }

  /**
   * The factory as it keys providers: one per owner the execution context names, and one shared by every caller
   * that names none, which is every caller without governance.
   */
  function providerPerOwner() {
    const shared = transactionProvider();
    const owned = new Map<string, ReturnType<typeof transactionProvider>>();
    mockGetOrCreateProvider.mockImplementation(async (...args: unknown[]) => {
      const owner = (args[2] as { owner?: string } | undefined)?.owner;
      if (owner === undefined) return shared as never;
      if (!owned.has(owner)) owned.set(owner, transactionProvider());
      return owned.get(owner) as never;
    });
    return { shared, of: (owner: string) => owned.get(owner) };
  }

  /**
   * The factory as it caches providers under governance: one per key, and the key frames the credential the connection
   * opens with as well as the owner, so a grant level that changes resolves another provider. `findCachedProvider`
   * answers from the same providers, and `evict` stands in for the idle sweep or a disconnect removing one.
   */
  function providerPerKey() {
    const providers = new Map<string, ReturnType<typeof transactionProvider>>();
    mockGetOrCreateProvider.mockImplementation(async (...args: unknown[]) => {
      const key = await mockEditorCacheKey(args[0] as { id: string }, args[2] as { owner?: string });
      if (!providers.has(key)) providers.set(key, transactionProvider());
      return providers.get(key) as never;
    });
    mockFindCachedProvider.mockImplementation((key: string) => providers.get(key) ?? null);
    const keyOf = (user: string, owner: string) => JSON.stringify(["seed:orders", user, owner]);
    return {
      of: (user: string, owner: string) => providers.get(keyOf(user, owner)),
      evict: (user: string, owner: string) => providers.delete(keyOf(user, owner)),
      /**
       * The owner-scoped removal of the factory (docs/GOVERNANCE.md#per-user-providers): every provider of `owner` on
       * `connectionId` leaves the cache, and an open transaction on it is rolled back, as `teardownProvider` in
       * src/lib/db/factory.ts does.
       */
      removeOwner: async (connectionId: string, owner: string) => {
        for (const [key, provider] of [...providers]) {
          const [id, , keyOwner] = JSON.parse(key) as [string, string | null, string | null];
          if (id !== connectionId || keyOwner !== owner) continue;
          providers.delete(key);
          // oxlint-disable-next-line no-await-in-loop -- one provider at a time, as the double has no pool to wait on.
          if (provider.isInTransaction()) await provider.rollbackTransaction();
        }
      },
    };
  }

  function as(username: string, idpSubject: string) {
    mockGetSession.mockImplementation(async () => ({ role: "user", username, idpSubject }));
  }

  /** `user` is the database user of the credential the caller's grant level resolves, absent for the tests above. */
  function send(body: Record<string, unknown>, user?: string) {
    return POST(
      createMockRequest("/api/db/transaction", {
        method: "POST",
        body: {
          // A governed connection carries the level of its credential, as `resolveConnection` hands it to the route.
          connection: {
            ...validConnection,
            id: "seed:orders",
            grantLevel: user === "reader" ? "read" : "write",
            ...(user === undefined ? {} : { user }),
          },
          ...body,
        },
      }) as never,
    );
  }

  test("governance: user B neither sees nor joins user A's open transaction and can begin its own", async () => {
    const providers = providerPerOwner();

    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" })).status).toBe(200);

    // B does not see A's transaction: nothing is open for B, and nothing is held by anyone else.
    as("bob@example.com", "bob-subject");
    expect(await parseResponseJSON<Record<string, unknown>>(await send({ action: "status" }))).toEqual({
      inTransaction: false,
      ownedByYou: false,
      heldByAnotherSession: false,
      startedAt: null,
    });
    // Nor joins it: B holds no transaction, so B's statement is refused before any provider runs it.
    expect((await send({ action: "query", sql: "SELECT 1" })).status).toBe(400);
    expect(providers.of("bob-subject")?.queryInTransaction).not.toHaveBeenCalled();
    // And B begins a transaction of its own.
    expect((await send({ action: "begin" })).status).toBe(200);
    expect(providers.of("bob-subject")?.beginTransaction).toHaveBeenCalledTimes(1);

    // A's transaction is still A's, untouched by anything B did.
    as("alice@example.com", "alice-subject");
    expect(await parseResponseJSON(await send({ action: "status" }))).toMatchObject({
      inTransaction: true,
      ownedByYou: true,
      heldByAnotherSession: false,
    });
    expect((await send({ action: "commit" })).status).toBe(200);
    expect(providers.of("alice-subject")?.queryInTransaction).not.toHaveBeenCalled();
    expect(providers.of("alice-subject")?.commitTransaction).toHaveBeenCalledTimes(1);
    expect(providers.of("bob-subject")?.isInTransaction()).toBe(true);
    // No request reached the provider every caller shares.
    expect(providers.shared.beginTransaction).not.toHaveBeenCalled();

    as("bob@example.com", "bob-subject");
    expect((await send({ action: "rollback" })).status).toBe(200);
  });

  test("governance: the transaction belongs to the subject, so a session whose username changed keeps it", async () => {
    // Under governance the subject names the user and the username is a display label
    // (docs/GOVERNANCE.md#row-semantics): an email changed in the identity provider must not lock its owner out of the
    // transaction it opened.
    const providers = providerPerOwner();

    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" })).status).toBe(200);

    as("alice.smith@example.org", "alice-subject");
    expect(await parseResponseJSON(await send({ action: "status" }))).toMatchObject({
      inTransaction: true,
      ownedByYou: true,
      heldByAnotherSession: false,
    });
    expect((await send({ action: "rollback" })).status).toBe(200);
    expect(providers.of("alice-subject")?.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  // ─── A credential that changes under an open transaction (docs/GOVERNANCE.md#per-user-providers) ───
  //
  // The connection a governed request resolves carries the credential of the caller's grant level, and the provider's
  // cache key frames that credential, so a grant downgraded from write to read, or a credential sealed again, resolves
  // a provider other than the one the transaction was opened on. That transaction would otherwise stay open under a
  // credential the caller no longer holds, on a provider their requests no longer reach.

  test("governance: a request that resolves a different provider key rolls back the old transaction and answers 409 TRANSACTION_CREDENTIAL_CHANGED", async () => {
    const providers = providerPerKey();
    as("alice@example.com", "alice-subject");

    // A write grant: the connection opens with the write credential, and the transaction is held on that provider.
    expect((await send({ action: "begin" }, "writer")).status).toBe(200);
    const writer = providers.of("writer", "alice-subject");
    expect(writer?.isInTransaction()).toBe(true);

    // The grant is downgraded to read: the same connection now opens with the read credential, under another key.
    mockGetOrCreateProvider.mockClear();
    const res = await send({ action: "query", sql: "INSERT INTO orders VALUES (1)" }, "reader");
    const data = await parseResponseJSON<{ error: string; code: string; rolledBack: boolean }>(res);

    expect(res.status).toBe(409);
    expect(data.code).toBe("TRANSACTION_CREDENTIAL_CHANGED");
    // The status and the code are the ones governance contract v1 publishes for this refusal
    // (docs/GOVERNANCE.md#api-codes).
    const published: readonly { code: string; httpStatus: number }[] = API_CODES;
    expect(published).toContainEqual({ code: data.code, httpStatus: res.status });
    expect(data.rolledBack).toBe(true);
    expect(data.error).toBe(
      "Your access to this connection changed while your transaction was open, so the transaction was rolled back and none of its changes were saved. Begin a new transaction to continue with your current access.",
    );
    // Rolled back on the provider that holds it, and the statement ran nowhere: the answer opens no provider at all.
    expect(writer?.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(writer?.isInTransaction()).toBe(false);
    expect(writer?.queryInTransaction).not.toHaveBeenCalled();
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();

    // The record went with it: the next request runs under the read credential, and its begin opens a transaction there.
    expect((await send({ action: "begin" }, "reader")).status).toBe(200);
    expect(providers.of("reader", "alice-subject")?.beginTransaction).toHaveBeenCalledTimes(1);
    expect((await send({ action: "rollback" }, "reader")).status).toBe(200);
    expect(writer?.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  test("governance: when the old provider is no longer cached the record is released and the answer is still 409", async () => {
    const providers = providerPerKey();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" }, "writer")).status).toBe(200);
    const writer = providers.of("writer", "alice-subject");
    // The idle sweep or a disconnect removed the provider, and its transaction ended with its connection.
    providers.evict("writer", "alice-subject");

    const res = await send({ action: "commit" }, "reader");

    expect(res.status).toBe(409);
    expect(await parseResponseJSON(res)).toMatchObject({ code: "TRANSACTION_CREDENTIAL_CHANGED", rolledBack: true });
    // Nothing was left to roll back, and the commit reached no provider.
    expect(writer?.rollbackTransaction).not.toHaveBeenCalled();
    expect(writer?.commitTransaction).not.toHaveBeenCalled();
    // Released: the next begin is answered under the new credential.
    expect((await send({ action: "begin" }, "reader")).status).toBe(200);
    expect((await send({ action: "rollback" }, "reader")).status).toBe(200);
  });

  test("governance: a transaction its provider already ended is not rolled back again, and even status answers 409", async () => {
    const providers = providerPerKey();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" }, "writer")).status).toBe(200);
    const writer = providers.of("writer", "alice-subject");
    // PostgresProvider's TX_TIMEOUT_MS rolled it back with no session behind it, and the provider stays cached.
    await writer?.rollbackTransaction();
    writer?.rollbackTransaction.mockClear();

    // Status is answered for every session otherwise, but the caller's own transaction ended without a word to them,
    // so it learns that here rather than from a status that only says nothing is open.
    const res = await send({ action: "status" }, "reader");

    expect(res.status).toBe(409);
    expect(await parseResponseJSON(res)).toMatchObject({ code: "TRANSACTION_CREDENTIAL_CHANGED", rolledBack: true });
    expect(writer?.rollbackTransaction).not.toHaveBeenCalled();
  });

  test("governance: a rollback that fails is logged, and the answer is still 409 with rolledBack false", async () => {
    const providers = providerPerKey();
    const errors = spyOn(logger, "error").mockImplementation(() => {});
    try {
      as("alice@example.com", "alice-subject");
      expect((await send({ action: "begin" }, "writer")).status).toBe(200);
      const writer = providers.of("writer", "alice-subject");
      writer?.rollbackTransaction.mockImplementationOnce(async () => {
        throw new ConnectionError("Connection terminated unexpectedly", "postgres");
      });

      const res = await send({ action: "rollback" }, "reader");
      const data = await parseResponseJSON<{ error: string; code: string; rolledBack: boolean }>(res);

      expect(res.status).toBe(409);
      expect(data.code).toBe("TRANSACTION_CREDENTIAL_CHANGED");
      expect(data.rolledBack).toBe(false);
      expect(data.error).toBe(
        "Your access to this connection changed while your transaction was open, so the transaction cannot continue. Studio asked the database to roll it back and could not confirm that it did; none of its changes were committed. Begin a new transaction to continue with your current access.",
      );
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0]?.[2]).toEqual({ route: "api/db/transaction", connectionId: "seed:orders" });
      // Released all the same: the record names a provider the caller's requests no longer reach.
      expect((await send({ action: "begin" }, "reader")).status).toBe(200);
      expect((await send({ action: "rollback" }, "reader")).status).toBe(200);
    } finally {
      errors.mockRestore();
    }
  });

  test("governance: a rollback that does not finish within 5 s is abandoned, and the answer is still 409", async () => {
    const providers = providerPerKey();
    const errors = spyOn(logger, "error").mockImplementation(() => {});
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" }, "writer")).status).toBe(200);
    const writer = providers.of("writer", "alice-subject");
    writer?.rollbackTransaction.mockImplementationOnce(() => new Promise<void>(() => {}));

    jest.useFakeTimers();
    try {
      let answered = false;
      const pending = send({ action: "query", sql: "SELECT 1" }, "reader").then((res) => {
        answered = true;
        return res;
      });
      // Bun's fake timers leave setImmediate real, so this lets the request run up to the rollback it waits on.
      for (let turn = 0; turn < 50 && writer?.rollbackTransaction.mock.calls.length === 0; turn++) {
        // oxlint-disable-next-line no-await-in-loop -- a poll: each turn lets the request run one step further.
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(writer?.rollbackTransaction).toHaveBeenCalledTimes(1);

      jest.advanceTimersByTime(4999);
      await new Promise((resolve) => setImmediate(resolve));
      expect(answered).toBe(false);

      jest.advanceTimersByTime(1);
      const res = await pending;
      expect(res.status).toBe(409);
      expect(await parseResponseJSON(res)).toMatchObject({ code: "TRANSACTION_CREDENTIAL_CHANGED", rolledBack: false });
      expect(String(errors.mock.calls[0]?.[1])).toContain("timed out after 5000ms");
    } finally {
      jest.useRealTimers();
      errors.mockRestore();
    }
  });

  // ─── A grant a reload takes away or changes (docs/GOVERNANCE.md#per-user-providers) ───
  //
  // The reload that reads a downgrade does not wait for the owner's next request: once it swaps the new snapshot in, it
  // asks every copy of the factory to tear down the owner's providers of that connection, and the teardown rolls back
  // the open transaction there (src/lib/governance/snapshot.ts, src/lib/db/owner-removal.ts). The factory's own
  // teardown is pinned in tests/isolated/factory.test.ts; here the route's factory is the double above, registered as
  // a copy of the factory registers itself.

  test("governance: a downgrade from write to read rolls back the open write transaction", async () => {
    const providers = providerPerKey();
    const removals: unknown[][] = [];
    const unregister = registerOwnerRemoval(async (connectionId, scope) => {
      removals.push([connectionId, scope]);
      await providers.removeOwner(connectionId, scope.owner);
    });
    const ORDERS = admittedConnection("orders", { write: true });
    const granted = (level: "read" | "write") =>
      grantedSnapshot([ORDERS], [{ subject: "alice-subject", connection: ORDERS, level }]);
    const quiet = [spyOn(logger, "info"), spyOn(logger, "debug")].map((spy) => spy.mockImplementation(() => {}));
    try {
      recordGovernanceSnapshot(granted("write"));
      as("alice@example.com", "alice-subject");
      expect((await send({ action: "begin" }, "writer")).status).toBe(200);
      const writer = providers.of("writer", "alice-subject");
      expect(writer?.isInTransaction()).toBe(true);

      // The control plane downgrades the grant, and the reload that reads it swaps the new snapshot in.
      await swapGovernanceSnapshot(granted("read"));

      // The reload itself rolled the write transaction back, before any request of Alice's.
      expect(removals).toEqual([["seed:orders", { owner: "alice-subject" }]]);
      expect(writer?.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(writer?.isInTransaction()).toBe(false);
      // Her next request resolves the read credential and learns what happened, and nothing is rolled back twice.
      const res = await send({ action: "status" }, "reader");
      expect(res.status).toBe(409);
      expect(await parseResponseJSON(res)).toMatchObject({ code: "TRANSACTION_CREDENTIAL_CHANGED", rolledBack: true });
      expect(writer?.rollbackTransaction).toHaveBeenCalledTimes(1);
      // The reload recorded the rollback it caused, once: the 409 that told her records nothing more.
      expect(recordedEvents.map((event) => [event.transactionOutcome, event.statement, event.status])).toEqual([
        ["rolled-back", "ROLLBACK", "success"],
      ]);
      // She begins again under the read credential.
      expect((await send({ action: "begin" }, "reader")).status).toBe(200);
      expect(providers.of("reader", "alice-subject")?.isInTransaction()).toBe(true);
      expect((await send({ action: "rollback" }, "reader")).status).toBe(200);
    } finally {
      unregister();
      resetGovernanceState();
      for (const spy of quiet) spy.mockRestore();
    }
  });

  // ─── Transaction events (docs/GOVERNANCE.md#query-events) ─────────────────

  /** The events recorded so far, reduced to what a test compares. */
  const outcomes = () =>
    recordedEvents.map((event) => [event.transactionOutcome, event.statement, event.status, event.transactionId]);

  test("governance: begin, query and commit record one open event and one committed event with the same transaction_id", async () => {
    providerPerOwner();
    as("alice@example.com", "alice-subject");

    expect((await send({ action: "begin" })).status).toBe(200);
    expect((await send({ action: "status" })).status).toBe(200);
    // Begin and status run no statement of the user's, so they record nothing.
    expect(recordedEvents).toEqual([]);
    expect((await send({ action: "query", sql: "INSERT INTO orders VALUES (1)" })).status).toBe(200);
    expect((await send({ action: "commit" })).status).toBe(200);

    expect(recordedEvents).toHaveLength(2);
    const [statement, committed] = recordedEvents;
    expect(statement).toMatchObject({
      source: "transaction",
      principal: { subject: "alice-subject", username: "alice@example.com", role: "user" },
      connection: { id: "seed:orders", name: "Test DB", engine: "postgres", accessLevel: "write" },
      statement: "INSERT INTO orders VALUES (1)",
      status: "success",
      rowCount: 0,
      transactionOutcome: "open",
    });
    expect(committed).toMatchObject({
      source: "transaction",
      statement: "COMMIT",
      status: "success",
      transactionOutcome: "committed",
    });
    expect(statement.transactionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(committed.transactionId).toBe(statement.transactionId);
    expect(mockAdmitQueryExecution).toHaveBeenCalledTimes(3);

    // The next transaction carries another id, and its rollback ends it.
    expect((await send({ action: "begin" })).status).toBe(200);
    expect((await send({ action: "query", sql: "UPDATE orders SET n = 1; DELETE FROM orders" })).status).toBe(200);
    expect((await send({ action: "rollback" })).status).toBe(200);
    const next = recordedEvents.slice(2);
    expect(next.map((event) => [event.transactionOutcome, event.statement, event.status])).toEqual([
      ["open", "UPDATE orders SET n = 1; DELETE FROM orders", "success"],
      ["rolled-back", "ROLLBACK", "success"],
    ]);
    expect(next[0]?.transactionId).not.toBe(statement.transactionId);
    expect(next[1]?.transactionId).toBe(next[0]?.transactionId);
  });

  test("governance: the 409 TRANSACTION_CREDENTIAL_CHANGED path records rolled-back for the old transaction", async () => {
    const providers = providerPerKey();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" }, "writer")).status).toBe(200);
    expect((await send({ action: "query", sql: "INSERT INTO orders VALUES (1)" }, "writer")).status).toBe(200);
    const opened = recordedEvents[0]?.transactionId;

    const res = await send({ action: "query", sql: "SELECT 1" }, "reader");

    expect(res.status).toBe(409);
    expect(providers.of("writer", "alice-subject")?.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(outcomes()).toEqual([
      ["open", "INSERT INTO orders VALUES (1)", "success", opened],
      ["rolled-back", "ROLLBACK", "success", opened],
    ]);
    expect(recordedEvents[1]?.connection.accessLevel).toBe("write");
  });

  test("governance: an unconfirmed rollback after a credential change records rolled-back with status error", async () => {
    const providers = providerPerKey();
    const errors = spyOn(logger, "error").mockImplementation(() => {});
    try {
      as("alice@example.com", "alice-subject");
      expect((await send({ action: "begin" }, "writer")).status).toBe(200);
      providers.of("writer", "alice-subject")?.rollbackTransaction.mockImplementationOnce(async () => {
        throw new ConnectionError("Connection terminated unexpectedly", "postgres");
      });

      expect((await send({ action: "status" }, "reader")).status).toBe(409);

      expect(recordedEvents.map((event) => [event.transactionOutcome, event.status])).toEqual([
        ["rolled-back", "error"],
      ]);
    } finally {
      errors.mockRestore();
    }
  });

  test("governance: a transaction the provider timed out is recorded once by the reconcile", async () => {
    const providers = providerPerOwner();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" })).status).toBe(200);
    // The provider's TX_TIMEOUT_MS rolled it back with no session behind it.
    await providers.of("alice-subject")?.rollbackTransaction();

    expect((await send({ action: "status" })).status).toBe(200);
    expect((await send({ action: "status" })).status).toBe(200);

    expect(recordedEvents.map((event) => [event.transactionOutcome, event.statement, event.status])).toEqual([
      ["timed-out", null, "cancelled"],
    ]);
  });

  test("governance: a failing statement records an open event with status error", async () => {
    const providers = providerPerOwner();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" })).status).toBe(200);
    providers.of("alice-subject")?.queryInTransaction.mockImplementationOnce(async () => {
      throw new QueryError('relation "missing" does not exist', "postgres");
    });

    expect((await send({ action: "query", sql: "SELECT * FROM missing" })).status).toBe(400);

    expect(recordedEvents).toHaveLength(1);
    expect(recordedEvents[0]).toMatchObject({
      statement: "SELECT * FROM missing",
      status: "error",
      errorCode: "QUERY_ERROR",
      errorMessage: 'relation "missing" does not exist',
      transactionOutcome: "open",
    });
    expect(recordedEvents[0]?.rowCount).toBeUndefined();
  });

  test("governance: a COMMIT that ends the transaction in failure records rolled-back, one that leaves it open records open", async () => {
    const providers = providerPerOwner();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" })).status).toBe(200);
    const provider = providers.of("alice-subject");
    // PostgreSQL ends a transaction whose COMMIT fails, as with a deferred constraint.
    provider?.commitTransaction.mockImplementationOnce(async () => {
      await provider.rollbackTransaction();
      throw new QueryError("deferred constraint violated", "postgres");
    });
    expect((await send({ action: "commit" })).status).toBe(400);

    expect((await send({ action: "begin" })).status).toBe(200);
    // A ROLLBACK the server did not answer leaves the transaction open.
    provider?.rollbackTransaction.mockImplementationOnce(async () => {
      throw new ConnectionError("Connection terminated unexpectedly", "postgres");
    });
    expect((await send({ action: "rollback" })).status).toBe(503);

    expect(recordedEvents.map((event) => [event.transactionOutcome, event.statement, event.status])).toEqual([
      ["rolled-back", "COMMIT", "error"],
      ["open", "ROLLBACK", "error"],
    ]);
    expect(recordedEvents[1]?.transactionId).not.toBe(recordedEvents[0]?.transactionId);
    expect((await send({ action: "rollback" })).status).toBe(200);
  });

  test("governance: a closed admission gate refuses begin and query before the provider runs them", async () => {
    const providers = providerPerOwner();
    as("alice@example.com", "alice-subject");
    const { SeedConnectionError } = await import("@/lib/seed/resolve-connection");
    mockAdmitQueryExecution.mockImplementation(() => {
      throw new SeedConnectionError("Query execution is unavailable while this server cannot record query events", 503);
    });

    expect((await send({ action: "begin" })).status).toBe(503);
    expect((await send({ action: "query", sql: "SELECT 1" })).status).toBe(503);

    expect(providers.of("alice-subject")?.beginTransaction).not.toHaveBeenCalled();
    expect(providers.of("alice-subject")?.queryInTransaction).not.toHaveBeenCalled();
    expect(recordedEvents).toEqual([]);
  });

  test("under governance a query action without a transaction the caller owns sends no statement unrecorded", async () => {
    const providers = providerPerOwner();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" })).status).toBe(200);
    const provider = providers.of("alice-subject");
    // The provider's own timeout rolled the transaction back, and the reconcile of the next request drops the record.
    await provider?.rollbackTransaction();
    provider?.rollbackTransaction.mockClear();

    // Refused the way the provider itself refuses a statement outside a transaction, so the editor's own reading of
    // the answer, transactionGone(), leaves transaction mode instead of refusing every later run.
    const afterTimeout = await send({ action: "query", sql: "INSERT INTO orders VALUES (1)" });
    expect(afterTimeout.status).toBe(400);
    expect(transactionGone(await parseResponseJSON<{ code?: string; error?: string }>(afterTimeout))).toBe(true);

    // A transaction the provider holds with no record of the caller's behind it, as a record lost to a race would leave.
    expect((await send({ action: "begin" })).status).toBe(200);
    releaseTransaction(transactionKey("seed:orders", undefined, "alice-subject"));
    for (const body of [
      { action: "query", sql: "INSERT INTO orders VALUES (2)" },
      { action: "query", sql: "UPDATE orders SET n = 1; DELETE FROM orders" },
      { action: "commit" },
      { action: "rollback" },
    ]) {
      const refused = await send(body);
      expect(refused.status).toBe(400);
      expect(transactionGone(await parseResponseJSON<{ code?: string; error?: string }>(refused))).toBe(true);
    }

    expect(provider?.queryInTransaction).not.toHaveBeenCalled();
    expect(provider?.commitTransaction).not.toHaveBeenCalled();
    expect(provider?.rollbackTransaction).not.toHaveBeenCalled();
    // Only the timeout's own terminal event: no statement reached the database without its event.
    expect(recordedEvents.map((event) => [event.transactionOutcome, event.statement])).toEqual([["timed-out", null]]);
  });

  test("under governance every action that sends a statement is refused with AUDIT_UNAVAILABLE while the sink refuses", async () => {
    const providers = providerPerOwner();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" })).status).toBe(200);
    const provider = providers.of("alice-subject");
    provider?.beginTransaction.mockClear();
    const { SeedConnectionError } = await import("@/lib/seed/resolve-connection");
    mockAdmitQueryExecution.mockImplementation(() => {
      throw Object.assign(
        new SeedConnectionError("Query execution is unavailable while this server cannot record query events", 503),
        { code: "AUDIT_UNAVAILABLE" },
      );
    });

    for (const body of [
      { action: "query", sql: "INSERT INTO orders VALUES (1)" },
      { action: "query", sql: "UPDATE orders SET n = 1; DELETE FROM orders" },
      { action: "commit" },
      { action: "rollback" },
      { action: "begin" },
    ]) {
      const res = await send(body);
      expect(res.status).toBe(503);
      expect((await parseResponseJSON<{ code: string }>(res)).code).toBe("AUDIT_UNAVAILABLE");
    }

    expect(provider?.beginTransaction).not.toHaveBeenCalled();
    expect(provider?.queryInTransaction).not.toHaveBeenCalled();
    expect(provider?.commitTransaction).not.toHaveBeenCalled();
    expect(provider?.rollbackTransaction).not.toHaveBeenCalled();
    expect(recordedEvents).toEqual([]);
    // The transaction is still the caller's, and the status answer sends no statement.
    expect((await send({ action: "status" })).status).toBe(200);
  });
});

// The key of a transaction, per owner under governance (docs/GOVERNANCE.md#per-user-providers).
describe("transactionKey", () => {
  test("without an owner the key is byte-identical, and an owner is framed into it", () => {
    expect(transactionKey("seed:orders")).toBe("seed:orders");
    expect(transactionKey("seed:orders", "shop")).toBe('["seed:orders","shop"]');
    expect(transactionKey("seed:orders", undefined, "alice-subject")).toBe('["seed:orders",null,"alice-subject"]');
    expect(transactionKey("seed:orders", "shop", "alice-subject")).toBe('["seed:orders","shop","alice-subject"]');
  });
});

// A JSON `null` body or one that is not JSON at all answered 500 INTERNAL_ERROR with the runtime's own text ("Cannot destructure property 'action' ...").
// Any body that is not a JSON object is the caller's malformed request, answered before any connection resolves.
describe("POST /api/db/transaction: a body that is not a JSON object", () => {
  test.each<[string, string]>([
    ["null", "null"],
    ["an array", "[]"],
    ["a number", "7"],
    ["a string", '"x"'],
    ["text that is not JSON", "{not json"],
  ])("a body that is %s answers 400 and opens no provider", async (_label, raw) => {
    mockGetOrCreateProvider.mockClear();
    const res = await POST(
      new Request("http://localhost:3000/api/db/transaction", {
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
