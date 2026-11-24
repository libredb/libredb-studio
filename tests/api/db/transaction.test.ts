import { describe, test, expect, mock, beforeAll, afterAll, beforeEach, afterEach, spyOn, jest } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
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
  TransactionLostError,
  QueryCancelledError,
  NO_ACTIVE_TRANSACTION,
  NO_TRANSACTION_OPENED,
  ProviderTextWithheldError,
} from "@/lib/db/errors";
import { mapDatabaseError } from "@/lib/db/map-database-error";
import { markNotSent, waitedSeconds } from "@/lib/db/errors";
import { EXECUTE_SLACK_MS, queryTimeoutError } from "@/lib/api/editor-query";
import type { ExecuteRequest } from "@libredb/provider-sdk/calls";
import { createHostCore, type HostCore } from "@/lib/provider-host/core/host-core";
import { forgetHostCore, hostCore, installHostCore } from "@/lib/provider-host/instance";
import { PROVIDER_TEXT_WITHHELD, withheldErrorMessage } from "@/lib/db/operations/provider-text";
import type { BeginTransactionOptions, BeginTransactionResult } from "@/lib/db/types";
import type { QueryEventInput } from "@/lib/query-events/types";
import { CONFIRMATION_FIELD_MESSAGE } from "@/lib/api/run-confirmation";
import {
  forgetUsedRunConfirmations,
  mintRunConfirmation,
  runConfirmationIssuerForSession,
} from "@/lib/api/run-confirmation-token";

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
  // src/lib/api/editor-provider.ts imports it, and the route loads that module; this route runs no kill.
  getOrCreateMetadataProvider: mock(async () => {
    throw new Error("getOrCreateMetadataProvider is not read by this route");
  }),
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
const {
  OWNERSHIP_IDLE_MS,
  releaseTransaction,
  TRANSACTION_TIMEOUT_CHECK_MS,
  TRANSACTION_TIMEOUT_RECHECK_MS,
  transactionKey,
  transactionOwner,
} = await import("@/lib/api/transaction-ownership");

// The route's calls run through the process's host core (src/lib/provider-host/instance.ts), so this file composes its
// own.
beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

/** Runs `body` with a core `make` builds around the real one installed, then puts the real one back. */
async function withCore<T>(make: (real: HostCore) => HostCore, body: () => Promise<T>): Promise<T> {
  const real = hostCore();
  forgetHostCore();
  installHostCore(make(real), "test");
  try {
    return await body();
  } finally {
    forgetHostCore();
    installHostCore(real, "test");
  }
}

/** The reason a call's deadline aborts its signal with. */
const deadlineReason = () => new DOMException("The call's deadline has passed.", "TimeoutError");

/** A held answer, and a promise that resolves once a call reached it. */
function heldCall<T>() {
  const answer = Promise.withResolvers<T>();
  const reached = Promise.withResolvers<void>();
  return {
    answer,
    reached: reached.promise,
    call: () => {
      reached.resolve();
      return answer.promise;
    },
  };
}

/** A transaction request the caller can leave, through `signal`. */
function leavingRequest(body: Record<string, unknown>, signal: AbortSignal): Request {
  return new Request("http://localhost:3000/api/db/transaction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });
}
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
  describe("provider text that holds the connection's credential", () => {
    const password = crypto.randomUUID();
    const send = (body: Record<string, unknown>) =>
      POST(
        createMockRequest("/api/db/transaction", {
          method: "POST",
          body: { connection: { ...validConnection, password }, ...body },
        }) as never,
      );

    test("a script statement's error that holds the connection's credential is withheld", async () => {
      let call = 0;
      mockTxProvider.queryInTransaction.mockImplementation(async () => {
        call++;
        if (call === 2) throw new QueryError(`syntax error near ${password}`, "postgres");
        return { rows: [], fields: [], rowCount: 1, executionTime: 1 };
      });
      const res = await send({ action: "query", sql: "UPDATE t SET a = 1; SELEC 2" });
      const data = await parseResponseJSON<{ statements: { status: string; error?: string }[] }>(res);
      expect(res.status).toBe(200);
      expect(data.statements[0].status).toBe("success");
      expect(data.statements[1]).toMatchObject({ status: "error", error: withheldErrorMessage("QueryError") });
      expect(JSON.stringify(data)).not.toContain(password);
    });

    test("a query's warning that holds the credential is withheld", async () => {
      const clean = { message: "a notice of its own", code: "01000" };
      mockTxProvider.queryInTransaction.mockImplementationOnce(async () => ({
        rows: [],
        fields: [],
        rowCount: 0,
        executionTime: 1,
        warnings: [{ message: `a notice about ${password}`, code: "01000" }, clean],
      }));
      const res = await send({ action: "query", sql: "SELECT 1" });
      const data = await parseResponseJSON<{ warnings?: unknown[] }>(res);
      expect(data.warnings).toEqual([{ message: PROVIDER_TEXT_WITHHELD, code: "01000" }, clean]);
    });

    test("begin, commit and query failures that hold the credential keep their status and code", async () => {
      mockTxProvider.beginTransaction.mockImplementationOnce(async () => {
        throw new QueryError(`could not begin for ${password}`, "postgres");
      });
      mockTxProvider.commitTransaction.mockImplementationOnce(async () => {
        throw new TransactionLostError(`session of ${password} ended`, "postgres");
      });
      mockTxProvider.queryInTransaction.mockImplementationOnce(async () => {
        throw new QueryError(`syntax error near ${password}`, "postgres");
      });
      const cases = [
        [{ action: "begin" }, 400, "QUERY_ERROR", "QueryError"],
        [{ action: "commit" }, 503, "TRANSACTION_LOST", "TransactionLostError"],
        [{ action: "query", sql: "SELECT 1" }, 400, "QUERY_ERROR", "QueryError"],
      ] as const;
      const answers = await Promise.all(
        cases.map(async ([body]) => {
          const res = await send(body);
          return { status: res.status, data: await parseResponseJSON<Record<string, unknown>>(res) };
        }),
      );
      cases.forEach(([, status, code, replaced], index) => {
        const { status: answered, data } = answers[index];
        expect(answered).toBe(status);
        expect(data).toMatchObject({ code, error: withheldErrorMessage(replaced) });
        expect(JSON.stringify(data)).not.toContain(password);
      });
    });
  });

  describe("query action with several statements (#1390)", () => {
    type ScriptAnswer = {
      multiStatement: boolean;
      statementCount: number;
      executedCount: number;
      hasError: boolean;
      inTransaction: boolean;
      rows: unknown[];
      fields: string[];
      rowCount: number;
      pagination?: unknown;
      statements: { index: number; sql: string; status: string; error?: string }[];
    };
    const run = async (sql: string) => {
      // The stand-in carries its connection's engine; the suite's beforeEach hands every later test the shared one.
      mockGetOrCreateProvider.mockImplementation(async () => ({ ...mockTxProvider, type: "mysql" }) as never);
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

    test("bounds only the last statement, and shows the last successful result", async () => {
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

    test("shows the last successful statement even when it returns no rows (#2271)", async () => {
      // First statement answers a row; the last, an empty SELECT with its own columns.
      mockTxProvider.queryInTransaction.mockImplementationOnce(async () => ({
        rows: [{ id: 1, name: "Alice" }],
        fields: ["id"],
        rowCount: 1,
        executionTime: 1,
      }));
      mockTxProvider.queryInTransaction.mockImplementation(async () => ({
        rows: [],
        fields: ["n"],
        rowCount: 0,
        executionTime: 1,
      }));

      const { data } = await run("SELECT id FROM t; SELECT n FROM u WHERE 1 = 0");

      expect(data.rows).toEqual([]);
      expect(data.fields).toEqual(["n"]);
      expect(data.rowCount).toBe(0);
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

    test("every unit of a script inside a transaction runs through the host core's console execute sent with transaction, one call per unit", async () => {
      const seen: ExecuteRequest[] = [];
      const { res, data } = await withCore(
        (real) => ({
          ...real,
          executeCall: (session, request, ctx, limits, ports) => {
            seen.push(request);
            return real.executeCall(session, request, ctx, limits, ports);
          },
        }),
        () => run("UPDATE t SET a = 1; UPDATE t SET a = 2; SELECT * FROM t"),
      );

      expect(res.status).toBe(200);
      expect(seen.map((request) => [request.statement, request.transaction])).toEqual([
        ["UPDATE t SET a = 1", true],
        ["UPDATE t SET a = 2", true],
        ["SELECT * FROM t", true],
      ]);
      // The provider's statement members are reached only through those calls, each statement sent with one argument.
      expect(mockTxProvider.queryInTransaction.mock.calls).toEqual([
        ["UPDATE t SET a = 1"],
        ["UPDATE t SET a = 2"],
        ["SELECT * FROM t LIMIT 50"],
      ] as never);
      expect((mockTxProvider.prepareQuery as ReturnType<typeof mock>).mock.calls.map((call) => call[0])).toEqual([
        "SELECT * FROM t",
      ]);
      expect([data.statementCount, data.executedCount, data.hasError, data.inTransaction]).toEqual([3, 3, false, true]);
      expect(data.rows).toEqual([{ id: 1, name: "Alice" }]);
    });

    test("a malformed connection queryTimeout is refused with the query route's sentence before a query action opens anything", async () => {
      for (const queryTimeout of ["abc", 0, 1.5]) {
        for (const sql of ["UPDATE t SET a = 1; UPDATE t SET a = 2", "UPDATE t SET a = 1"]) {
          const req = createMockRequest("/api/db/transaction", {
            method: "POST",
            body: { connection: { ...validConnection, type: "mysql", queryTimeout }, action: "query", sql },
          });
          // oxlint-disable-next-line no-await-in-loop -- one request at a time, each read before the next.
          const res = await POST(req as never);

          expect(res.status).toBe(400);
          // oxlint-disable-next-line no-await-in-loop -- the answer of the request just sent.
          expect(await parseResponseJSON(res)).toEqual({ error: queryTimeoutError(queryTimeout) as string });
        }
      }
      expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
      expect(mockTxProvider.isInTransaction).not.toHaveBeenCalled();
      expect(mockTxProvider.queryInTransaction).not.toHaveBeenCalled();
      expect(recordedEvents).toEqual([]);
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
   * hypothetical second copy: `useQueryExecution` in `use-query-execution.ts` sends a run here whenever a
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

  // The record of a transaction follows the provider's own state after a failure: it is kept while the provider still
  // holds a transaction, and handed back once it holds none. These titles pin what the route answers today, and the
  // host core's transaction calls keep each answer (docs/providers/CONTRACT.md, clauses C-57 and C-58).
  describe("what the transaction route answers today, which the host core keeps (E21-K2, E23-K1)", () => {
    interface ErrorBody {
      readonly code: string;
      readonly kind?: string;
      readonly outcome?: string;
    }

    /** The status of a call and the code, kind and outcome of its body. */
    async function answerOf(response: Response) {
      const body = await parseResponseJSON<ErrorBody>(response);
      return { status: response.status, code: body.code, kind: body.kind, outcome: body.outcome };
    }

    /** Whether another session finds the transaction still held: its begin is refused as not owned. */
    async function heldForAnother(connectionId: string) {
      asSession("bob", "admin");
      const res = await call(connectionId, { action: "begin" });
      return { status: res.status, code: (await parseResponseJSON<{ code?: string }>(res)).code };
    }

    test("a statement that fails inside the transaction answers its error and keeps the transaction and its owner", async () => {
      openableProvider();
      asSession("alice");
      expect((await call("e21-statement-open", { action: "begin" })).status).toBe(200);
      mockTxProvider.queryInTransaction.mockImplementationOnce(async () => {
        throw new QueryError('relation "missing" does not exist', "postgres");
      });

      const failed = await answerOf(
        await call("e21-statement-open", { action: "query", sql: "SELECT * FROM missing" }),
      );

      expect(failed).toEqual({ status: 400, code: "QUERY_ERROR", kind: "query", outcome: "unknown" });
      expect(await heldForAnother("e21-statement-open")).toEqual({ status: 409, code: "TRANSACTION_NOT_OWNED" });
      asSession("alice");
      expect(await parseResponseJSON(await call("e21-statement-open", { action: "status" }))).toMatchObject({
        inTransaction: true,
        ownedByYou: true,
      });
    });

    test("a statement that fails and ends the transaction answers its error and hands the connection back", async () => {
      const provider = openableProvider();
      asSession("alice");
      expect((await call("e21-statement-lost", { action: "begin" })).status).toBe(200);
      mockTxProvider.queryInTransaction.mockImplementationOnce(async () => {
        provider.expire();
        throw new TransactionLostError("The transaction was lost: its database session ended (x).", "postgres");
      });

      const failed = await answerOf(await call("e21-statement-lost", { action: "query", sql: "SELECT 1" }));

      expect(failed).toEqual({ status: 503, code: "TRANSACTION_LOST", kind: "transaction-lost", outcome: "unknown" });
      expect(await heldForAnother("e21-statement-lost")).toEqual({ status: 200, code: undefined });
    });

    test("a COMMIT that fails and leaves the transaction open answers its error and keeps its owner", async () => {
      openableProvider();
      asSession("alice");
      expect((await call("e21-commit-open", { action: "begin" })).status).toBe(200);
      mockTxProvider.commitTransaction.mockImplementationOnce(async () => {
        throw new QueryError("could not serialize access", "postgres");
      });

      const failed = await answerOf(await call("e21-commit-open", { action: "commit" }));

      expect(failed).toEqual({ status: 400, code: "QUERY_ERROR", kind: "query", outcome: "unknown" });
      expect(await heldForAnother("e21-commit-open")).toEqual({ status: 409, code: "TRANSACTION_NOT_OWNED" });
      asSession("alice");
      expect((await call("e21-commit-open", { action: "rollback" })).status).toBe(200);
    });

    test("a COMMIT that fails and ends the transaction answers its error and hands the connection back", async () => {
      const provider = openableProvider();
      asSession("alice");
      expect((await call("e21-commit-ended", { action: "begin" })).status).toBe(200);
      // PostgreSQL ends a transaction whose COMMIT fails, as with a deferred constraint.
      mockTxProvider.commitTransaction.mockImplementationOnce(async () => {
        provider.expire();
        throw new QueryError("deferred constraint violated", "postgres");
      });

      const failed = await answerOf(await call("e21-commit-ended", { action: "commit" }));

      expect(failed).toEqual({ status: 400, code: "QUERY_ERROR", kind: "query", outcome: "unknown" });
      expect(await heldForAnother("e21-commit-ended")).toEqual({ status: 200, code: undefined });
    });

    test("a statement the engine cancelled answers 499 and keeps the transaction and its owner", async () => {
      // A cancellation the engine confirms from outside Studio, another session's pg_cancel_backend or a DBA's KILL
      // QUERY: PostgreSQL leaves the transaction aborted, so the provider still holds it.
      openableProvider();
      asSession("alice");
      expect((await call("e21-cancelled", { action: "begin" })).status).toBe(200);
      mockTxProvider.queryInTransaction.mockImplementationOnce(async () => {
        throw new QueryCancelledError("canceling statement due to user request", "postgres");
      });

      const failed = await answerOf(await call("e21-cancelled", { action: "query", sql: "SELECT pg_sleep(60)" }));

      expect(failed).toEqual({ status: 499, code: "QUERY_CANCELLED", kind: "cancelled", outcome: "unknown" });
      expect(await heldForAnother("e21-cancelled")).toEqual({ status: 409, code: "TRANSACTION_NOT_OWNED" });
      asSession("alice");
      expect(await parseResponseJSON(await call("e21-cancelled", { action: "status" }))).toMatchObject({
        inTransaction: true,
        ownedByYou: true,
      });
    });

    test("a connection lost mid-statement inside the transaction answers CONNECTION_ERROR with outcome unknown", async () => {
      openableProvider();
      asSession("alice");
      expect((await call("e23-socket-lost", { action: "begin" })).status).toBe(200);
      mockTxProvider.queryInTransaction.mockImplementationOnce(async () => {
        throw new ConnectionError("Connection terminated unexpectedly", "postgres");
      });

      const failed = await answerOf(await call("e23-socket-lost", { action: "query", sql: "UPDATE t SET n = 1" }));

      expect(failed).toEqual({ status: 503, code: "CONNECTION_ERROR", kind: "connection", outcome: "unknown" });
      // The provider still holds the transaction, so the record follows it.
      expect(await heldForAnother("e23-socket-lost")).toEqual({ status: 409, code: "TRANSACTION_NOT_OWNED" });
    });
  });

  describe("an unknown session state keeps the transaction and its owner (E21-K2, Q3)", () => {
    interface ErrorBody {
      readonly code: string;
      readonly kind?: string;
      readonly outcome?: string;
      readonly error?: string;
    }

    /** The status of a call and the code, kind and outcome of its body. */
    async function answerOf(response: Response) {
      const body = await parseResponseJSON<ErrorBody>(response);
      return { status: response.status, code: body.code, kind: body.kind, outcome: body.outcome };
    }

    /** Whether another session finds the transaction still held: its begin is refused as not owned. */
    async function heldForAnother(connectionId: string) {
      asSession("bob", "admin");
      const res = await call(connectionId, { action: "begin" });
      return { status: res.status, code: (await parseResponseJSON<{ code?: string }>(res)).code };
    }

    /** A call on `connectionId` its caller leaves through the controller answered. */
    function leaving(connectionId: string, body: Record<string, unknown>) {
      const controller = new AbortController();
      const response = POST(
        leavingRequest({ connection: { ...validConnection, id: connectionId }, ...body }, controller.signal) as never,
      );
      return { controller, response };
    }

    const statementResult = { rows: [{ id: 1, name: "Alice" }], fields: ["id", "name"], rowCount: 1, executionTime: 1 };

    test("a statement whose caller leaves answers 499 with outcome unknown, and keeps the transaction and its owner", async () => {
      openableProvider();
      asSession("alice");
      expect((await call("k2-statement-left", { action: "begin" })).status).toBe(200);
      const statement = heldCall<typeof statementResult>();
      mockTxProvider.queryInTransaction.mockImplementationOnce(statement.call);

      const left = leaving("k2-statement-left", { action: "query", sql: "UPDATE t SET n = 1" });
      await statement.reached;
      left.controller.abort();
      // The statement answers after its caller left: its answer is nobody's.
      statement.answer.resolve(statementResult);
      const answered = await answerOf(await left.response);

      expect(answered).toEqual({ status: 499, code: "QUERY_CANCELLED", kind: "cancelled", outcome: "unknown" });
      expect(await heldForAnother("k2-statement-left")).toEqual({ status: 409, code: "TRANSACTION_NOT_OWNED" });
      asSession("alice");
      expect(await parseResponseJSON(await call("k2-statement-left", { action: "status" }))).toMatchObject({
        inTransaction: true,
        ownedByYou: true,
      });
      expect((await call("k2-statement-left", { action: "rollback" })).status).toBe(200);
    });

    test("a COMMIT whose caller leaves answers 499 with outcome unknown, and keeps the transaction and its owner", async () => {
      openableProvider();
      asSession("alice");
      expect((await call("k2-commit-left", { action: "begin" })).status).toBe(200);
      const commit = heldCall<void>();
      mockTxProvider.commitTransaction.mockImplementationOnce(commit.call);

      const left = leaving("k2-commit-left", { action: "commit" });
      await commit.reached;
      const readsBefore = mockTxProvider.isInTransaction.mock.calls.length;
      left.controller.abort();
      const answered = await answerOf(await left.response);
      // Nothing reads the state after the stop: the COMMIT's own end is unknown.
      expect(mockTxProvider.isInTransaction.mock.calls.length).toBe(readsBefore);
      commit.answer.resolve();

      expect(answered).toEqual({ status: 499, code: "QUERY_CANCELLED", kind: "cancelled", outcome: "unknown" });
      expect(await heldForAnother("k2-commit-left")).toEqual({ status: 409, code: "TRANSACTION_NOT_OWNED" });
      asSession("alice");
      expect((await call("k2-commit-left", { action: "rollback" })).status).toBe(200);
    });

    test("a BEGIN, statement, COMMIT or ROLLBACK sent while a COMMIT whose caller left still runs is refused 409 by name and sends nothing, and once it settled the ROLLBACK is sent and answers by its own outcome", async () => {
      let open = false;
      mockTxProvider.isInTransaction.mockImplementation(() => open);
      mockTxProvider.beginTransaction.mockImplementation(async () => {
        open = true;
      });
      // As every provider that implements the transaction interface answers a ROLLBACK with no transaction open.
      mockTxProvider.rollbackTransaction.mockImplementation(async () => {
        if (!open) throw new QueryError(NO_ACTIVE_TRANSACTION, "postgres");
        open = false;
      });
      asSession("alice");
      expect((await call("k2-refused", { action: "begin" })).status).toBe(200);
      const commit = heldCall<void>();
      const committed = Promise.withResolvers<void>();
      mockTxProvider.commitTransaction.mockImplementationOnce(async () => {
        await commit.call();
        // The COMMIT committed after its caller left.
        open = false;
        committed.resolve();
      });
      const left = leaving("k2-refused", { action: "commit" });
      await commit.reached;
      left.controller.abort();
      expect((await left.response).status).toBe(499);

      const responses: Response[] = [];
      for (const body of [
        { action: "begin" },
        { action: "query", sql: "UPDATE t SET n = 1" },
        { action: "commit" },
        { action: "rollback" },
      ]) {
        // oxlint-disable-next-line no-await-in-loop -- one request at a time, as the editor sends them.
        responses.push(await call("k2-refused", body));
      }
      const refusals = await Promise.all(
        responses.map(async (res) => {
          const answer = await parseResponseJSON<{ code?: string; error?: string }>(res);
          return [res.status, answer.code, answer.error, transactionGone(answer)];
        }),
      );
      const refused = (named: string) => [
        409,
        "TRANSACTION_CALL_RUNNING",
        `The ${named} was not sent: a call Studio stopped waiting for is still running on this connection's transaction. Send it again once that call has finished; the status action reads the transaction's state.`,
        false,
      ];
      expect(refusals).toEqual([refused("BEGIN"), refused("statement"), refused("COMMIT"), refused("ROLLBACK")]);
      // Nothing reached the provider but the BEGIN and the COMMIT before the stop.
      expect(mockTxProvider.beginTransaction).toHaveBeenCalledTimes(1);
      expect(mockTxProvider.queryInTransaction).not.toHaveBeenCalled();
      expect(mockTxProvider.commitTransaction).toHaveBeenCalledTimes(1);
      expect(mockTxProvider.rollbackTransaction).not.toHaveBeenCalled();
      // The state read is still answered, and says the state is unknown.
      expect(await parseResponseJSON(await call("k2-refused", { action: "status" }))).toMatchObject({
        inTransaction: null,
        ownedByYou: true,
      });

      commit.answer.resolve();
      await committed.promise;
      await mockTxProvider.commitTransaction.mock.results.at(-1)?.value;
      const rollback = await call("k2-refused", { action: "rollback" });

      expect(mockTxProvider.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect([rollback.status, (await parseResponseJSON<{ error?: string }>(rollback)).error]).toEqual([
        400,
        NO_ACTIVE_TRANSACTION,
      ]);
    });

    test("while a BEGIN whose caller left still runs, the status read answers inTransaction null, and who holds the record", async () => {
      let open = false;
      mockTxProvider.isInTransaction.mockImplementation(() => open);
      mockTxProvider.rollbackTransaction.mockImplementation(async () => {
        open = false;
      });
      const begin = heldCall<void>();
      const opened = Promise.withResolvers<void>();
      mockTxProvider.beginTransaction.mockImplementationOnce(async () => {
        await begin.call();
        // The BEGIN opened the transaction after its caller left.
        open = true;
        opened.resolve();
      });
      asSession("alice");
      const left = leaving("k2-status-null", { action: "begin" });
      await begin.reached;
      left.controller.abort();
      expect((await left.response).status).toBe(499);

      // The provider answers no transaction, only because the BEGIN it still runs has not opened one.
      expect(await parseResponseJSON(await call("k2-status-null", { action: "status" }))).toMatchObject({
        inTransaction: null,
        ownedByYou: true,
        heldByAnotherSession: false,
      });
      asSession("bob", "admin");
      expect(await parseResponseJSON(await call("k2-status-null", { action: "status" }))).toMatchObject({
        inTransaction: null,
        ownedByYou: false,
        heldByAnotherSession: true,
      });

      begin.answer.resolve();
      await opened.promise;
      await mockTxProvider.beginTransaction.mock.results.at(-1)?.value;
      asSession("alice");
      expect(await parseResponseJSON(await call("k2-status-null", { action: "status" }))).toMatchObject({
        inTransaction: true,
        ownedByYou: true,
      });
      expect((await call("k2-status-null", { action: "rollback" })).status).toBe(200);
    });

    test("a state read that began before the owner's newer BEGIN claimed the record neither releases nor settles it when it answers", async () => {
      openableProvider();
      asSession("alice");
      const readTaken = Promise.withResolvers<void>();
      const answerRead = Promise.withResolvers<void>();
      let reads = 0;
      const claimed = await withCore(
        (real) => ({
          ...real,
          transactionCall: async (session, request, ctx, ports) => {
            if (request.action !== "state" || reads++ > 0) return real.transactionCall(session, request, ctx, ports);
            // The older request's read is taken while no transaction is open, and answers only after the newer BEGIN.
            const answer = await real.transactionCall(session, request, ctx, ports);
            readTaken.resolve();
            await answerRead.promise;
            return answer;
          },
        }),
        async () => {
          const older = call("k2-race", { action: "status" });
          await readTaken.promise;
          expect((await call("k2-race", { action: "begin" })).status).toBe(200);
          const record = transactionOwner(transactionKey("k2-race"));
          answerRead.resolve();
          expect(await parseResponseJSON(await older)).toMatchObject({ inTransaction: null, ownedByYou: true });
          return record;
        },
      );

      expect(claimed).not.toBeNull();
      expect(transactionOwner(transactionKey("k2-race"))).toBe(claimed);
      expect(await heldForAnother("k2-race")).toEqual({ status: 409, code: "TRANSACTION_NOT_OWNED" });
      asSession("alice");
      expect((await call("k2-race", { action: "rollback" })).status).toBe(200);
    });

    test("a BEGIN the owner sends on their own record that Studio stops waiting for holds the record's calls until it settles", async () => {
      openableProvider();
      asSession("alice");
      expect((await call("k2-begin-again", { action: "begin" })).status).toBe(200);
      const begin = heldCall<void>();
      mockTxProvider.beginTransaction.mockImplementationOnce(async () => {
        await begin.call();
        throw new QueryError("Transaction already active", "postgres");
      });
      const left = leaving("k2-begin-again", { action: "begin" });
      await begin.reached;
      left.controller.abort();
      expect((await left.response).status).toBe(499);

      const refused = await call("k2-begin-again", { action: "commit" });
      expect([refused.status, (await parseResponseJSON<{ code?: string }>(refused)).code]).toEqual([
        409,
        "TRANSACTION_CALL_RUNNING",
      ]);
      expect(mockTxProvider.commitTransaction).not.toHaveBeenCalled();
      expect(await parseResponseJSON(await call("k2-begin-again", { action: "status" }))).toMatchObject({
        inTransaction: null,
        ownedByYou: true,
      });

      begin.answer.resolve();
      await Promise.allSettled([mockTxProvider.beginTransaction.mock.results.at(-1)?.value as Promise<void>]);
      expect((await call("k2-begin-again", { action: "commit" })).status).toBe(200);
    });

    test("a begin whose caller leaves claims for its caller alone the transaction it may have opened", async () => {
      let open = false;
      mockTxProvider.isInTransaction.mockImplementation(() => open);
      mockTxProvider.rollbackTransaction.mockImplementation(async () => {
        open = false;
      });
      const begin = heldCall<void>();
      mockTxProvider.beginTransaction.mockImplementationOnce(() => {
        // The server opened the transaction; its answer has not reached Studio.
        open = true;
        return begin.call();
      });
      asSession("alice");

      const left = leaving("k2-begin-left", { action: "begin" });
      await begin.reached;
      left.controller.abort();
      begin.answer.resolve();
      const answered = await answerOf(await left.response);

      expect(answered).toEqual({ status: 499, code: "QUERY_CANCELLED", kind: "cancelled", outcome: "unknown" });
      expect(await heldForAnother("k2-begin-left")).toEqual({ status: 409, code: "TRANSACTION_NOT_OWNED" });
      asSession("alice");
      expect(await parseResponseJSON(await call("k2-begin-left", { action: "status" }))).toMatchObject({
        inTransaction: true,
        ownedByYou: true,
      });
      expect((await call("k2-begin-left", { action: "rollback" })).status).toBe(200);
    });

    test("a call past its deadline answers 504 with outcome unknown, and keeps the transaction and its owner", async () => {
      openableProvider();
      asSession("alice");
      expect((await call("k2-deadline", { action: "begin" })).status).toBe(200);
      const waited = `${waitedSeconds(60_000)} and ${waitedSeconds(EXECUTE_SLACK_MS)} more for the engine's own answer`;

      const [statement, commit] = await withCore(
        (real) => ({
          ...real,
          executeCall: async () => ({ kind: "stopped", reason: deadlineReason(), settled: Promise.resolve() }),
          transactionCall: async (session, request, ctx, ports) =>
            request.action === "state"
              ? real.transactionCall(session, request, ctx, ports)
              : { kind: "stopped", reason: deadlineReason(), settled: Promise.resolve() },
        }),
        async () => [
          await call("k2-deadline", { action: "query", sql: "UPDATE t SET n = 1" }),
          await call("k2-deadline", { action: "commit" }),
        ],
      );
      const statementBody = await parseResponseJSON<ErrorBody>(statement);
      const commitBody = await parseResponseJSON<ErrorBody>(commit);

      expect([statement.status, statementBody.code, statementBody.kind, statementBody.outcome]).toEqual([
        504,
        "TIMEOUT_ERROR",
        "studio-timeout-refusal",
        "unknown",
      ]);
      expect(statementBody.error).toBe(
        `The statement did not answer within its timeout of ${waited}, so Studio stopped waiting for it.`,
      );
      expect([commit.status, commitBody.code, commitBody.kind, commitBody.outcome]).toEqual([
        504,
        "TIMEOUT_ERROR",
        "studio-timeout-refusal",
        "unknown",
      ]);
      expect(commitBody.error).toBe(
        `The COMMIT did not answer within the statement timeout of ${waited}, so Studio stopped waiting for it, and the transaction may have been committed or rolled back.`,
      );
      expect(await heldForAnother("k2-deadline")).toEqual({ status: 409, code: "TRANSACTION_NOT_OWNED" });
      asSession("alice");
      expect((await call("k2-deadline", { action: "rollback" })).status).toBe(200);
    });

    test("an unknown state answers inTransaction null, and the next read that finds the transaction resolves it", async () => {
      openableProvider();
      asSession("alice");
      expect((await call("k2-null", { action: "begin" })).status).toBe(200);
      let reads = 0;

      const [first, second] = await withCore(
        (real) => ({
          ...real,
          transactionCall: async (session, request, ctx, ports) => {
            if (request.action === "state" && reads++ === 0) return { kind: "answered", sessionState: "unknown" };
            return real.transactionCall(session, request, ctx, ports);
          },
        }),
        async () => [
          await parseResponseJSON(await call("k2-null", { action: "status" })),
          await parseResponseJSON(await call("k2-null", { action: "status" })),
        ],
      );

      expect(first).toMatchObject({ inTransaction: null, ownedByYou: true });
      expect(second).toMatchObject({ inTransaction: true, ownedByYou: true });
      expect((await call("k2-null", { action: "rollback" })).status).toBe(200);
    });

    test("a script whose state read after its statements fails answers the statements' results with inTransaction null, and keeps the transaction and its owner unresolved", async () => {
      openableProvider();
      asSession("alice");
      expect((await call("k2-script-read", { action: "begin" })).status).toBe(200);
      let ran = 0;
      mockTxProvider.queryInTransaction.mockImplementation(async () => {
        ran += 1;
        return { rows: [], fields: [], rowCount: 1, executionTime: 1 };
      });
      // The read after the script's two statements fails once, as a provider whose session cannot answer would. Each
      // statement's own state read comes first, so it is the second read once both ran.
      let readsAfterBoth = 0;
      mockTxProvider.isInTransaction.mockImplementation(() => {
        if (ran === 2 && ++readsAfterBoth === 2) {
          ran = 0;
          throw new DatabaseError("The session state could not be read", "postgres");
        }
        return true;
      });
      const warn = spyOn(logger, "warn");
      try {
        const res = await call("k2-script-read", { action: "query", sql: "UPDATE t SET n = 1; UPDATE t SET n = 2" });
        const data = await parseResponseJSON<{
          executedCount: number;
          hasError: boolean;
          inTransaction: boolean | null;
          statements: { status: string }[];
        }>(res);

        expect([res.status, data.executedCount, data.hasError, data.inTransaction]).toEqual([200, 2, false, null]);
        expect(data.statements.map((statement) => statement.status)).toEqual(["success", "success"]);
        expect(warn).toHaveBeenCalledWith("A transaction state read failed, so the state is unknown", {
          route: "api/db/transaction",
          kind: "database",
          code: "DATABASE_ERROR",
        });
      } finally {
        warn.mockRestore();
      }
      expect(transactionOwner(transactionKey("k2-script-read"))?.unresolved).toBe(true);
      expect(await heldForAnother("k2-script-read")).toEqual({ status: 409, code: "TRANSACTION_NOT_OWNED" });
      asSession("alice");
      expect((await call("k2-script-read", { action: "rollback" })).status).toBe(200);
    });

    test("a script unit that does not answer within its deadline is that unit's error inside the 200 answer, no further unit starts, and the transaction is kept with its state unknown until that unit settles", async () => {
      openableProvider();
      asSession("alice");
      expect((await call("g2-unit-deadline", { action: "begin" })).status).toBe(200);
      const settled = Promise.withResolvers<void>();
      let executes = 0;
      const waited = `${waitedSeconds(60_000)} and ${waitedSeconds(EXECUTE_SLACK_MS)} more for the engine's own answer`;

      const res = await withCore(
        (real) => ({
          ...real,
          executeCall: async (...args) => {
            executes += 1;
            if (executes === 2) return { kind: "stopped", reason: deadlineReason(), settled: settled.promise };
            return real.executeCall(...args);
          },
        }),
        () =>
          call("g2-unit-deadline", {
            action: "query",
            sql: "UPDATE t SET n = 1; UPDATE t SET n = 2; UPDATE t SET n = 3",
          }),
      );
      const data = await parseResponseJSON<{
        executedCount: number;
        hasError: boolean;
        inTransaction: boolean | null;
        statements: { status: string; error?: string }[];
      }>(res);

      expect([res.status, data.executedCount, data.hasError, data.inTransaction]).toEqual([200, 2, true, null]);
      expect(data.statements.map((statement) => statement.status)).toEqual(["success", "error"]);
      expect(data.statements[1]?.error).toBe(
        `The statement did not answer within its timeout of ${waited}, so Studio stopped waiting for it.`,
      );
      expect(executes).toBe(2);
      expect(mockTxProvider.queryInTransaction).toHaveBeenCalledTimes(1);
      expect(transactionOwner(transactionKey("g2-unit-deadline"))?.unresolved).toBe(true);

      const refused = await call("g2-unit-deadline", { action: "rollback" });
      expect([refused.status, (await parseResponseJSON<{ code?: string }>(refused)).code]).toEqual([
        409,
        "TRANSACTION_CALL_RUNNING",
      ]);
      expect(mockTxProvider.rollbackTransaction).not.toHaveBeenCalled();
      expect(await parseResponseJSON(await call("g2-unit-deadline", { action: "status" }))).toMatchObject({
        inTransaction: null,
        ownedByYou: true,
      });

      settled.resolve();
      await settled.promise;
      expect((await call("g2-unit-deadline", { action: "rollback" })).status).toBe(200);
      expect(mockTxProvider.rollbackTransaction).toHaveBeenCalledTimes(1);
    });

    test("a script whose request leaves while a unit runs answers that unit's cancellation at once and sends no further unit", async () => {
      openableProvider();
      asSession("alice");
      expect((await call("g2-unit-left", { action: "begin" })).status).toBe(200);
      const unit = heldCall<typeof statementResult>();
      let sent = 0;
      mockTxProvider.queryInTransaction.mockImplementation(async () => {
        sent += 1;
        return sent === 2 ? unit.call() : statementResult;
      });
      const secret = randomUUID();
      const warn = spyOn(logger, "warn");
      try {
        const left = leaving("g2-unit-left", {
          action: "query",
          sql: "UPDATE t SET n = 1; UPDATE t SET n = 2; UPDATE t SET n = 3",
        });
        await unit.reached;
        left.controller.abort();
        const res = await left.response;
        const data = await parseResponseJSON<{
          executedCount: number;
          inTransaction: boolean | null;
          statements: { status: string; error?: string }[];
        }>(res);

        expect([res.status, data.executedCount, data.inTransaction]).toEqual([200, 2, null]);
        expect(data.statements[1]).toMatchObject({ status: "error", error: "The query was cancelled." });
        expect(mockTxProvider.queryInTransaction).toHaveBeenCalledTimes(2);

        // The unit fails after the route answered: logged by kind and code, its text in no log line.
        unit.answer.reject(new Error(secret));
        await new Promise<void>((resolve) => setImmediate(resolve));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(warn).toHaveBeenCalledWith("A statement Studio stopped waiting for failed afterwards", {
          route: "api/db/transaction",
          kind: "internal",
          code: "INTERNAL_ERROR",
        });
        expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
      } finally {
        warn.mockRestore();
      }
      expect(mockTxProvider.queryInTransaction).toHaveBeenCalledTimes(2);
      expect((await call("g2-unit-left", { action: "rollback" })).status).toBe(200);
    });

    test("a request that leaves while its connection opens answers 499 not-sent and runs nothing", async () => {
      const opening = Promise.withResolvers<void>();
      mockGetOrCreateProvider.mockImplementationOnce(async (...args: unknown[]) => {
        const wait = args[3] as { signal: AbortSignal } | undefined;
        opening.resolve();
        return new Promise<never>((_resolve, reject) => {
          wait?.signal.addEventListener("abort", () => reject(wait.signal.reason), { once: true });
        });
      });
      asSession("alice");

      const left = leaving("k2-open-left", { action: "query", sql: "UPDATE t SET n = 1" });
      await opening.promise;
      left.controller.abort();
      const answered = await answerOf(await left.response);

      expect(answered).toEqual({ status: 499, code: "QUERY_CANCELLED", kind: "cancelled", outcome: "not-sent" });
      expect(mockTxProvider.isInTransaction).not.toHaveBeenCalled();
      expect(mockTxProvider.queryInTransaction).not.toHaveBeenCalled();
    });

    test("a begin whose session answers it holds no transaction answers 400 with the reason, and holds nothing", async () => {
      mockTxProvider.isInTransaction.mockImplementation(() => false);
      asSession("alice");

      const res = await call("k2-begin-none", { action: "begin" });
      const data = await parseResponseJSON<{ error: string }>(res);

      expect(res.status).toBe(400);
      expect(data.error).toBe(NO_TRANSACTION_OPENED);
      expect(await parseResponseJSON(await call("k2-begin-none", { action: "status" }))).toMatchObject({
        inTransaction: false,
        ownedByYou: false,
        heldByAnotherSession: false,
      });
    });

    test("a statement's page is held to the host's page budget, as on POST /api/db/query", async () => {
      const MIB = 1_048_576;
      const mebibyte = "x".repeat(MIB);
      // How many rows of a small id and a one MiB name a 32 MiB page holds: each measures its MiB and a few bytes.
      const pageHolds = 31;
      mockTxProvider.queryInTransaction.mockImplementationOnce(async () => ({
        rows: Array.from({ length: 40 }, (_, id) => ({ id, name: mebibyte })),
        fields: ["id", "name"],
        rowCount: 40,
        executionTime: 1,
      }));
      asSession("alice");

      const res = await call("k2-page", { action: "query", sql: "SELECT n FROM t" });
      const data = await parseResponseJSON<{
        rows: unknown[];
        rowCount: number;
        inTransaction: boolean;
        pagination: { hasMore: boolean; wasLimited: boolean; totalReturned: number };
      }>(res);

      expect(res.status).toBe(200);
      expect(data.rows).toHaveLength(pageHolds);
      expect(data.rowCount).toBe(pageHolds);
      expect(data.pagination).toMatchObject({ hasMore: true, wasLimited: true, totalReturned: pageHolds });
      expect(data.inTransaction).toBe(true);
    });
  });
});

// ─── Server-level connections (#1530) ───────────────────────────────────────
describe("POST /api/db/transaction on a server-level connection (#1530)", () => {
  /** One database's session: a begin opens its transaction, as a server that opened one does. */
  function session() {
    const isInTransaction = mock(() => false);
    return {
      ...baseMockProvider,
      beginTransaction: mock(async () => {
        isInTransaction.mockImplementation(() => true);
      }),
      commitTransaction: mock(async () => {}),
      rollbackTransaction: mock(async () => {}),
      isInTransaction,
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
    const serverConnection = { ...validConnection, id: "server-1", database: "" };
    // The provider stands for the server-level connection, which `catalogChoice` reads (M-57).
    const config = server.config;
    server.config = serverConnection as typeof server.config;
    const as = (username: string) => mockGetSession.mockImplementationOnce(async () => ({ role: "admin", username }));
    const send = (body: Record<string, unknown>) =>
      POST(
        createMockRequest("/api/db/transaction", {
          method: "POST",
          body: { connection: serverConnection, ...body },
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
      try {
        for (const catalog of ["shop", "analytics"]) {
          as(catalog === "shop" ? "alice" : "bob");
          // oxlint-disable-next-line no-await-in-loop -- each rollback runs as its own user, one request at a time, as the editor sends them.
          await send({ action: "rollback", catalog });
        }
      } finally {
        server.config = config;
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
/** The 409 a credential change answers when a call of the owner's whose outcome is not known may have ended the transaction. */
const CREDENTIAL_CHANGED_OUTCOME_UNKNOWN =
  "Your access to this connection changed while your transaction was open, so the transaction cannot continue. A call of yours whose outcome Studio does not know may have ended it before Studio's rollback, so Studio cannot tell whether its changes were committed or rolled back; check the data before you run its work again. Begin a new transaction to continue with your current access.";

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

  test("governance: a rollback after a credential change waits on Studio's own 5 s allowance, and one the host stops waiting for answers 409 unconfirmed", async () => {
    providerPerKey();
    const errors = spyOn(logger, "error").mockImplementation(() => {});
    try {
      as("alice@example.com", "alice-subject");
      expect((await send({ action: "begin" }, "writer")).status).toBe(200);
      recordedEvents.length = 0;
      const controller = new AbortController();
      const seen: { deadline: number; abortedAfterCallerLeft: boolean }[] = [];
      const startedAt = Date.now();

      const res = await withCore(
        (real) => ({
          ...real,
          transactionCall: async (session, request, ctx, ports) => {
            if (request.action !== "rollback") return real.transactionCall(session, request, ctx, ports);
            // The caller leaves while the rollback runs: the allowance is Studio's own, so its signal stays.
            controller.abort();
            seen.push({ deadline: ctx.deadline, abortedAfterCallerLeft: ctx.signal.aborted });
            return { kind: "stopped", reason: deadlineReason(), settled: Promise.resolve() };
          },
        }),
        () =>
          POST(
            leavingRequest(
              {
                connection: { ...validConnection, id: "seed:orders", grantLevel: "read", user: "reader" },
                action: "query",
                sql: "SELECT 1",
              },
              controller.signal,
            ) as never,
          ),
      );
      const endedAt = Date.now();

      expect(res.status).toBe(409);
      expect(await parseResponseJSON(res)).toMatchObject({ code: "TRANSACTION_CREDENTIAL_CHANGED", rolledBack: false });
      expect(seen).toHaveLength(1);
      expect(seen[0]?.deadline).toBeGreaterThanOrEqual(startedAt + 5_000);
      expect(seen[0]?.deadline).toBeLessThanOrEqual(endedAt + 5_000);
      expect(seen[0]?.abortedAfterCallerLeft).toBe(false);
      expect(errors).toHaveBeenCalledTimes(1);
      expect((errors.mock.calls[0]?.[1] as Error | undefined)?.message).toBe(
        "The rollback after a credential change did not answer within 5 seconds, so Studio stopped waiting for it.",
      );
      expect(recordedEvents.map((event) => [event.transactionOutcome, event.statement, event.status])).toEqual([
        ["rolled-back", "ROLLBACK", "error"],
      ]);
    } finally {
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

  test("governance: a reload that tears down the owner's providers while their COMMIT still runs records unknown, never rolled-back", async () => {
    const providers = providerPerKey();
    const unregister = registerOwnerRemoval(async (connectionId, scope) => {
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
      if (writer === undefined) throw new Error("alice's writer provider was expected to be resolved by her begin.");
      const committedUnanswered = Promise.withResolvers<void>();
      const answerCommit = Promise.withResolvers<void>();

      await withCore(
        (real) => ({
          ...real,
          transactionCall: async (session, request, ctx, ports) => {
            const answer = await real.transactionCall(session, request, ctx, ports);
            if (request.action !== "commit") return answer;
            // The provider committed; the COMMIT's answer has not reached its request yet.
            committedUnanswered.resolve();
            await answerCommit.promise;
            return answer;
          },
        }),
        async () => {
          const committing = send({ action: "commit" }, "writer");
          await committedUnanswered.promise;
          // The control plane downgrades the grant while her COMMIT is still answering: the reload tears her
          // providers down and records the end of her transaction.
          await swapGovernanceSnapshot(granted("read"));
          answerCommit.resolve();
          expect((await committing).status).toBe(200);
        },
      );
      expect(writer.commitTransaction).toHaveBeenCalledTimes(1);

      expect(recordedEvents.map((event) => [event.transactionOutcome, event.statement, event.status])).toEqual([
        ["unknown", "ROLLBACK", "success"],
      ]);
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

  test("governance: a statement the engine cancelled records an open event with status error and keeps the transaction", async () => {
    const providers = providerPerOwner();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" })).status).toBe(200);
    providers.of("alice-subject")?.queryInTransaction.mockImplementationOnce(async () => {
      throw new QueryCancelledError("canceling statement due to user request", "postgres");
    });

    expect((await send({ action: "query", sql: "SELECT pg_sleep(60)" })).status).toBe(499);
    expect((await send({ action: "query", sql: "ROLLBACK TO SAVEPOINT s" })).status).toBe(200);

    expect(
      recordedEvents.map((event) => [event.transactionOutcome, event.statement, event.status, event.errorCode]),
    ).toEqual([
      ["open", "SELECT pg_sleep(60)", "error", "QUERY_CANCELLED"],
      ["open", "ROLLBACK TO SAVEPOINT s", "success", undefined],
    ]);
    expect(recordedEvents[0]?.transactionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(recordedEvents[1]?.transactionId).toBe(recordedEvents[0]?.transactionId);
  });

  test("governance: a statement that finds its transaction lost records the transaction's end, not a timeout", async () => {
    const providers = providerPerOwner();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" })).status).toBe(200);
    const provider = providers.of("alice-subject");
    // The provider found the transaction's database session ended: it holds no transaction from here on.
    provider?.queryInTransaction.mockImplementationOnce(async () => {
      await provider.rollbackTransaction();
      throw new TransactionLostError("The transaction was lost: its database session ended (x).", "postgres");
    });

    const lost = await send({ action: "query", sql: "SELECT 1" });
    expect(lost.status).toBe(503);
    expect(transactionGone(await parseResponseJSON<{ code?: string; error?: string }>(lost))).toBe(true);
    // The next request finds no record to reconcile, so nothing is recorded as timed out.
    expect((await send({ action: "status" })).status).toBe(200);

    expect(
      recordedEvents.map((event) => [event.transactionOutcome, event.statement, event.status, event.errorCode]),
    ).toEqual([["rolled-back", "SELECT 1", "error", "TRANSACTION_LOST"]]);
    expect((await send({ action: "begin" })).status).toBe(200);
  });

  test("governance: a COMMIT that fails and ends the transaction records unknown, one that leaves it open records open", async () => {
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

    // The COMMIT may have reached the server and committed, so its end is not recorded as a rollback (Q3).
    expect(recordedEvents.map((event) => [event.transactionOutcome, event.statement, event.status])).toEqual([
      ["unknown", "COMMIT", "error"],
      ["open", "ROLLBACK", "error"],
    ]);
    expect(recordedEvents[1]?.transactionId).not.toBe(recordedEvents[0]?.transactionId);
    expect((await send({ action: "rollback" })).status).toBe(200);
  });

  test("governance: a failed COMMIT's and ROLLBACK's events record the SQLSTATE the driver reported", async () => {
    const providers = providerPerOwner();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" })).status).toBe(200);
    const provider = providers.of("alice-subject");
    // A deferred unique constraint fails the COMMIT, which PostgreSQL answers by ending the transaction.
    provider?.commitTransaction.mockImplementationOnce(async () => {
      await provider.rollbackTransaction();
      throw mapDatabaseError(
        Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }),
        "postgres",
        "COMMIT",
      );
    });
    expect((await send({ action: "commit" })).status).toBe(400);

    expect((await send({ action: "begin" })).status).toBe(200);
    // A ROLLBACK that fails with a SQLSTATE on an error that carries no API code of its own.
    provider?.rollbackTransaction.mockImplementationOnce(async () => {
      const error = new DatabaseError("could not serialize access", "postgres");
      error.sqlstate = "40001";
      throw error;
    });
    expect((await send({ action: "rollback" })).status).toBe(500);

    expect(recordedEvents.map((event) => [event.statement, event.status, event.errorCode])).toEqual([
      ["COMMIT", "error", "23505"],
      ["ROLLBACK", "error", "40001"],
    ]);
    expect((await send({ action: "rollback" })).status).toBe(200);
  });

  /** `send` for a request its caller leaves through the controller answered. */
  function sendLeaving(body: Record<string, unknown>) {
    const controller = new AbortController();
    const response = POST(
      leavingRequest(
        { connection: { ...validConnection, id: "seed:orders", grantLevel: "write" }, ...body },
        controller.signal,
      ) as never,
    );
    return { controller, response };
  }

  const ended = () => recordedEvents.map((event) => [event.transactionOutcome, event.statement, event.status]);
  const emptyResult = { rows: [], fields: [], rowCount: 0, executionTime: 1 };

  /** Begins alice's transaction, then runs a statement whose caller leaves, so its session state is unknown. */
  async function statementLeft(providers: ReturnType<typeof providerPerOwner>) {
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" })).status).toBe(200);
    const provider = providers.of("alice-subject");
    const statement = heldCall<typeof emptyResult>();
    provider?.queryInTransaction.mockImplementationOnce(statement.call);
    const left = sendLeaving({ action: "query", sql: "UPDATE t SET n = 1" });
    await statement.reached;
    left.controller.abort();
    statement.answer.resolve(emptyResult);
    expect((await left.response).status).toBe(499);
    return provider;
  }

  test("governance: an unknown state records no terminal event, and a later read that finds no transaction records unknown, never timed-out or rolled-back", async () => {
    const providers = providerPerOwner();
    const provider = await statementLeft(providers);
    expect(
      recordedEvents.map((event) => [event.transactionOutcome, event.statement, event.status, event.errorCode]),
    ).toEqual([["open", "UPDATE t SET n = 1", "error", "QUERY_CANCELLED"]]);

    // The transaction ends without a call of Studio's: a COMMIT Studio stopped waiting for may have committed it.
    await provider?.rollbackTransaction();
    expect((await send({ action: "status" })).status).toBe(200);
    expect((await send({ action: "status" })).status).toBe(200);

    expect(ended()).toEqual([
      ["open", "UPDATE t SET n = 1", "error"],
      ["unknown", null, "cancelled"],
    ]);
  });

  test("governance: an unknown state the next read finds still open is resolved, and a later provider timeout records timed-out", async () => {
    const providers = providerPerOwner();
    const provider = await statementLeft(providers);
    expect(await parseResponseJSON(await send({ action: "status" }))).toMatchObject({ inTransaction: true });

    // The provider's TX_TIMEOUT_MS rolled it back with no session behind it.
    await provider?.rollbackTransaction();
    expect((await send({ action: "status" })).status).toBe(200);

    expect(ended()).toEqual([
      ["open", "UPDATE t SET n = 1", "error"],
      ["timed-out", null, "cancelled"],
    ]);
  });

  test("governance: a COMMIT that fails after it may have reached the database and leaves no transaction records unknown, never rolled-back", async () => {
    const providers = providerPerOwner();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" })).status).toBe(200);
    const provider = providers.of("alice-subject");
    // The connection was lost after the COMMIT was sent: the server may have committed before it closed.
    provider?.commitTransaction.mockImplementationOnce(async () => {
      await provider.rollbackTransaction();
      throw new ConnectionError("Connection terminated unexpectedly", "postgres");
    });

    expect((await send({ action: "commit" })).status).toBe(503);
    expect((await send({ action: "status" })).status).toBe(200);

    expect(ended()).toEqual([["unknown", "COMMIT", "error"]]);
  });

  test("governance: a COMMIT refused before it was sent that leaves no transaction records rolled-back", async () => {
    const providers = providerPerOwner();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" })).status).toBe(200);
    const provider = providers.of("alice-subject");
    // The transaction's connection was gone before the COMMIT could be sent, so no COMMIT reached the server.
    provider?.commitTransaction.mockImplementationOnce(async () => {
      await provider.rollbackTransaction();
      const refused = new ConnectionError("The transaction's connection is closed.", "postgres");
      markNotSent(refused);
      throw refused;
    });

    expect((await send({ action: "commit" })).status).toBe(503);
    expect((await send({ action: "status" })).status).toBe(200);

    expect(ended()).toEqual([["rolled-back", "COMMIT", "error"]]);
  });

  test("governance: a script unit Studio stopped waiting for records the script's open row with its code, and the end found after it settled is recorded unknown", async () => {
    const providers = providerPerOwner();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" })).status).toBe(200);
    const provider = providers.of("alice-subject");
    const unit = heldCall<typeof emptyResult>();
    let sent = 0;
    provider?.queryInTransaction.mockImplementation(async () => {
      sent += 1;
      return sent === 2 ? unit.call() : emptyResult;
    });
    const sql = "UPDATE t SET n = 1; UPDATE t SET n = 2";

    const left = sendLeaving({ action: "query", sql });
    await unit.reached;
    left.controller.abort();
    expect((await left.response).status).toBe(200);
    expect(
      recordedEvents.map((event) => [event.transactionOutcome, event.statement, event.status, event.errorCode]),
    ).toEqual([["open", sql, "error", "QUERY_CANCELLED"]]);
    // Kept, its state unknown, until the unit settles.
    expect(await parseResponseJSON(await send({ action: "status" }))).toMatchObject({
      inTransaction: null,
      ownedByYou: true,
    });

    // The unit settles, and the transaction ends without a call of Studio's.
    unit.answer.resolve(emptyResult);
    await provider?.queryInTransaction.mock.results.at(-1)?.value;
    await provider?.rollbackTransaction();
    expect((await send({ action: "status" })).status).toBe(200);
    expect((await send({ action: "status" })).status).toBe(200);

    expect(ended()).toEqual([
      ["open", sql, "error"],
      ["unknown", null, "cancelled"],
    ]);
  });

  test("governance: a COMMIT whose caller leaves records an open event, and the end a later read finds is recorded unknown", async () => {
    const providers = providerPerOwner();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" })).status).toBe(200);
    const provider = providers.of("alice-subject");
    const commit = heldCall<void>();
    provider?.commitTransaction.mockImplementationOnce(async () => {
      await commit.call();
      // The COMMIT committed after its caller left.
      await provider.rollbackTransaction();
    });

    const left = sendLeaving({ action: "commit" });
    await commit.reached;
    left.controller.abort();
    commit.answer.resolve();
    expect((await left.response).status).toBe(499);
    expect(
      recordedEvents.map((event) => [event.transactionOutcome, event.statement, event.status, event.errorCode]),
    ).toEqual([["open", "COMMIT", "error", "QUERY_CANCELLED"]]);

    await provider?.commitTransaction.mock.results.at(-1)?.value;
    expect((await send({ action: "status" })).status).toBe(200);

    expect(ended()).toEqual([
      ["open", "COMMIT", "error"],
      ["unknown", null, "cancelled"],
    ]);
  });

  /** Begins alice's transaction, then sends a COMMIT whose caller leaves while the provider still holds it. */
  async function commitLeftRunning(providers: ReturnType<typeof providerPerOwner>) {
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" })).status).toBe(200);
    const provider = providers.of("alice-subject");
    if (provider === undefined) throw new Error("alice's provider was expected to be resolved by her begin.");
    const commit = heldCall<void>();
    const committed = Promise.withResolvers<void>();
    provider.commitTransaction.mockImplementationOnce(async () => {
      await commit.call();
      // The COMMIT committed after its caller left, which ends the session's transaction.
      await provider.commitTransaction();
      committed.resolve();
    });
    const left = sendLeaving({ action: "commit" });
    await commit.reached;
    left.controller.abort();
    expect((await left.response).status).toBe(499);
    return { provider, commit, committed: committed.promise };
  }

  test("governance: a read that finds the transaction open while a COMMIT whose caller left still runs keeps the state unknown, and the end found after it is recorded unknown", async () => {
    const providers = providerPerOwner();
    const { commit, committed } = await commitLeftRunning(providers);

    // The provider reports the transaction open until the COMMIT it still runs settles, which is no evidence of its state.
    expect(await parseResponseJSON(await send({ action: "status" }))).toMatchObject({
      inTransaction: null,
      ownedByYou: true,
    });
    commit.answer.resolve();
    await committed;
    expect((await send({ action: "status" })).status).toBe(200);

    expect(ended()).toEqual([
      ["open", "COMMIT", "error"],
      ["unknown", null, "cancelled"],
    ]);
  });

  /** The 409 a state-changing call sent while a call Studio stopped waiting for still runs is answered. */
  async function refusedWhileRunning(response: Response) {
    const answer = await parseResponseJSON<{ code?: string }>(response);
    return [response.status, answer.code];
  }

  test("governance: a ROLLBACK sent while a COMMIT whose caller left still runs is refused and sends nothing, and the end the read after the COMMIT settled finds is recorded unknown", async () => {
    const providers = providerPerOwner();
    const { provider, commit, committed } = await commitLeftRunning(providers);

    // On a connection that runs one call at a time the ROLLBACK would queue behind the COMMIT, which may commit first.
    expect(await refusedWhileRunning(await send({ action: "rollback" }))).toEqual([409, "TRANSACTION_CALL_RUNNING"]);
    expect(provider.rollbackTransaction).not.toHaveBeenCalled();
    commit.answer.resolve();
    await committed;
    await provider.commitTransaction.mock.results[0]?.value;
    // The transaction the COMMIT ended is gone, and the ROLLBACK is answered as for any caller who owns none.
    expect((await send({ action: "rollback" })).status).toBe(400);
    expect(provider.rollbackTransaction).not.toHaveBeenCalled();

    expect(ended()).toEqual([
      ["open", "COMMIT", "error"],
      ["unknown", null, "cancelled"],
    ]);
  });

  test("governance: a COMMIT sent while a ROLLBACK whose caller left still runs is refused and sends nothing, and the end the read after the ROLLBACK settled finds is recorded unknown", async () => {
    const providers = providerPerOwner();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" })).status).toBe(200);
    const provider = providers.of("alice-subject");
    if (provider === undefined) throw new Error("alice's provider was expected to be resolved by her begin.");
    const rollback = heldCall<void>();
    const rolledBack = Promise.withResolvers<void>();
    provider.rollbackTransaction.mockImplementationOnce(async () => {
      await rollback.call();
      // The ROLLBACK rolled back after its caller left, which ends the session's transaction.
      await provider.rollbackTransaction();
      rolledBack.resolve();
    });
    const left = sendLeaving({ action: "rollback" });
    await rollback.reached;
    left.controller.abort();
    expect((await left.response).status).toBe(499);

    expect(await refusedWhileRunning(await send({ action: "commit" }))).toEqual([409, "TRANSACTION_CALL_RUNNING"]);
    expect(provider.commitTransaction).not.toHaveBeenCalled();
    rollback.answer.resolve();
    await rolledBack.promise;
    await provider.rollbackTransaction.mock.results[0]?.value;
    expect((await send({ action: "commit" })).status).toBe(400);
    expect(provider.commitTransaction).not.toHaveBeenCalled();

    expect(ended()).toEqual([
      ["open", "ROLLBACK", "error"],
      ["unknown", null, "cancelled"],
    ]);
  });

  test("governance: a read that answers while the owner's COMMIT has committed but not yet answered keeps the record and records nothing, and the COMMIT records committed", async () => {
    providerPerOwner();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" })).status).toBe(200);
    const key = transactionKey("seed:orders", undefined, "alice-subject");
    const committedUnanswered = Promise.withResolvers<void>();
    const answerCommit = Promise.withResolvers<void>();

    await withCore(
      (real) => ({
        ...real,
        transactionCall: async (session, request, ctx, ports) => {
          const answer = await real.transactionCall(session, request, ctx, ports);
          if (request.action !== "commit") return answer;
          // The provider committed; the COMMIT's answer has not reached its request yet.
          committedUnanswered.resolve();
          await answerCommit.promise;
          return answer;
        },
      }),
      async () => {
        const commit = send({ action: "commit" });
        await committedUnanswered.promise;
        // The read finds no transaction only because the owner's COMMIT, still unanswered, ended it.
        expect(await parseResponseJSON(await send({ action: "status" }))).toMatchObject({
          inTransaction: null,
          ownedByYou: true,
          heldByAnotherSession: false,
        });
        expect(transactionOwner(key)).not.toBeNull();
        expect(recordedEvents).toEqual([]);
        answerCommit.resolve();
        expect((await commit).status).toBe(200);
      },
    );

    expect(ended()).toEqual([["committed", "COMMIT", "success"]]);
    expect(transactionOwner(key)).toBeNull();
  });

  test("governance: a provider timeout that ends the transaction while a statement runs is recorded unknown once the statement answers", async () => {
    jest.useFakeTimers();
    try {
      const providers = providerPerOwner();
      as("alice@example.com", "alice-subject");
      expect((await send({ action: "begin" })).status).toBe(200);
      const provider = providers.of("alice-subject");
      if (provider === undefined) throw new Error("alice's provider was expected to be resolved by her begin.");
      const key = transactionKey("seed:orders", undefined, "alice-subject");
      jest.advanceTimersByTime(TRANSACTION_TIMEOUT_CHECK_MS - 2000);
      const record = transactionOwner(key);
      if (record === null) throw new Error("alice's transaction record was expected to be live.");
      // She acted a moment ago, so the lease is live when the watch looks.
      record.lastActiveAt = Date.now();
      const statement = heldCall<typeof emptyResult>();
      provider.queryInTransaction.mockImplementationOnce(statement.call);

      const run = send({ action: "query", sql: "SELECT * FROM big" });
      await statement.reached;
      // The provider's own timer ends the transaction while the statement runs, and clears its state at once, as
      // MSSQLProvider and OracleProvider do.
      await provider.rollbackTransaction();
      // The watch's look: a call is in flight, so it records nothing and looks again.
      jest.advanceTimersByTime(2000);
      statement.answer.resolve(emptyResult);
      expect(await parseResponseJSON(await run)).toMatchObject({ inTransaction: false });
      jest.advanceTimersByTime(TRANSACTION_TIMEOUT_RECHECK_MS * 3);
      await Promise.resolve();

      expect(transactionOwner(key)).toBeNull();
      expect(ended()).toEqual([
        ["open", "SELECT * FROM big", "success"],
        ["unknown", null, "success"],
      ]);
    } finally {
      jest.useRealTimers();
    }
  });

  test("governance: a typed COMMIT statement, alone or ending a script, records exactly one terminal event, unknown", async () => {
    const providers = providerPerOwner();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" })).status).toBe(200);
    const provider = providers.of("alice-subject");
    if (provider === undefined) throw new Error("alice's provider was expected to be resolved by her begin.");
    // The server ends the transaction with the statement; Studio sees only that none is left.
    const committing = async () => {
      await provider.commitTransaction();
      return emptyResult;
    };
    provider.queryInTransaction.mockImplementationOnce(committing);
    expect(await parseResponseJSON(await send({ action: "query", sql: "COMMIT" }))).toMatchObject({
      inTransaction: false,
    });
    expect((await send({ action: "status" })).status).toBe(200);

    expect((await send({ action: "begin" })).status).toBe(200);
    provider.queryInTransaction.mockImplementationOnce(async () => emptyResult).mockImplementationOnce(committing);
    expect(await parseResponseJSON(await send({ action: "query", sql: "UPDATE t SET n = 1;\nCOMMIT;" }))).toMatchObject(
      {
        inTransaction: false,
      },
    );
    expect((await send({ action: "status" })).status).toBe(200);

    expect(ended()).toEqual([
      ["open", "COMMIT", "success"],
      ["unknown", null, "success"],
      ["open", "UPDATE t SET n = 1;\nCOMMIT;", "success"],
      ["unknown", null, "success"],
    ]);
  });

  test("governance: a BEGIN that opens a new transaction while the owner's statement still runs on the old record records the old one's end unknown", async () => {
    const providers = providerPerOwner();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" })).status).toBe(200);
    const provider = providers.of("alice-subject");
    if (provider === undefined) throw new Error("alice's provider was expected to be resolved by her begin.");
    const key = transactionKey("seed:orders", undefined, "alice-subject");
    const first = transactionOwner(key);
    const statement = heldCall<typeof emptyResult>();
    provider.queryInTransaction.mockImplementationOnce(statement.call);
    const run = send({ action: "query", sql: "SELECT * FROM big" });
    await statement.reached;
    // The provider's own timer ends the transaction while the statement runs; the reconcile keeps the record, since
    // a call is in flight, and the BEGIN opens a new transaction.
    await provider.rollbackTransaction();
    expect((await send({ action: "begin" })).status).toBe(200);
    const second = transactionOwner(key);
    expect(second).not.toBe(first);
    statement.answer.resolve(emptyResult);
    expect((await run).status).toBe(200);

    expect(
      recordedEvents.map((event) => [event.transactionId === first?.transactionId, event.transactionOutcome]),
    ).toEqual([
      [true, "unknown"],
      [true, "open"],
    ]);
    expect((await send({ action: "rollback" })).status).toBe(200);
  });

  test("governance: a statement whose caller left settles before a read that finds the transaction open, which resolves the state", async () => {
    const providers = providerPerOwner();
    const provider = await statementLeft(providers);
    expect(await parseResponseJSON(await send({ action: "status" }))).toMatchObject({ inTransaction: true });
    expect((await send({ action: "rollback" })).status).toBe(200);
    expect(provider?.rollbackTransaction).toHaveBeenCalledTimes(1);

    expect(ended()).toEqual([
      ["open", "UPDATE t SET n = 1", "error"],
      ["rolled-back", "ROLLBACK", "success"],
    ]);
  });

  test("governance: a read that finds no transaction while a BEGIN whose caller left still runs keeps the record, so the transaction it opens stays its caller's and its end is recorded unknown", async () => {
    const providers = providerPerOwner();
    as("alice@example.com", "alice-subject");
    // A status read resolves alice's own provider before her begin, so the test can hold that begin.
    expect((await send({ action: "status" })).status).toBe(200);
    const provider = providers.of("alice-subject");
    if (provider === undefined) throw new Error("alice's provider was expected to be resolved by her status read.");
    const begin = heldCall<void>();
    const opened = Promise.withResolvers<void>();
    provider.beginTransaction.mockImplementationOnce(async () => {
      await begin.call();
      // The BEGIN opened the transaction after its caller left.
      await provider.beginTransaction();
      opened.resolve();
    });
    const left = sendLeaving({ action: "begin" });
    await begin.reached;
    left.controller.abort();
    expect((await left.response).status).toBe(499);
    const key = transactionKey("seed:orders", undefined, "alice-subject");
    const record = transactionOwner(key);
    if (record === null) throw new Error("The BEGIN whose caller left was expected to claim the transaction.");

    // The provider holds no transaction yet, only because the BEGIN it still runs has not opened it.
    expect(await parseResponseJSON(await send({ action: "status" }))).toMatchObject({
      inTransaction: null,
      ownedByYou: true,
    });
    expect(transactionOwner(key)).toBe(record);
    expect(record.unresolved).toBe(true);
    expect(ended()).toEqual([]);

    begin.answer.resolve();
    await opened.promise;
    expect(transactionOwner(key)).toBe(record);
    expect(record.unresolved).toBe(true);
    // The provider's own timeout rolls the transaction back before any read found it open.
    await provider.rollbackTransaction();
    expect((await send({ action: "status" })).status).toBe(200);

    expect(transactionOwner(key)).toBeNull();
    expect(ended()).toEqual([["unknown", null, "cancelled"]]);
  });

  test("governance: a lease that lapses on an unknown state records unknown, never timed-out", async () => {
    const providers = providerPerOwner();
    await statementLeft(providers);
    // The owner never comes back: the lease is aged past its idle bound, as the clock would.
    const record = transactionOwner(transactionKey("seed:orders", undefined, "alice-subject"));
    if (record === null) throw new Error("The transaction's record was expected to be kept.");
    record.lastActiveAt -= OWNERSHIP_IDLE_MS;

    expect((await send({ action: "status" })).status).toBe(200);

    expect(ended()).toEqual([
      ["open", "UPDATE t SET n = 1", "error"],
      ["unknown", null, "cancelled"],
    ]);
  });

  test("governance: a COMMIT the host refuses before it is sent records an open event and leaves the transaction as it was", async () => {
    providerPerOwner();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" })).status).toBe(200);

    const refused = await withCore(
      (real) => ({
        ...real,
        transactionCall: async (session, request, ctx, ports) =>
          request.action === "commit"
            ? { kind: "refused", called: false, refusals: [{ rule: "call-deadline-passed", pointer: "/deadline" }] }
            : real.transactionCall(session, request, ctx, ports),
      }),
      () => send({ action: "commit" }),
    );

    expect(refused.status).toBe(504);
    expect(await parseResponseJSON(refused)).toMatchObject({ code: "TIMEOUT_ERROR", outcome: "not-sent" });
    expect(await parseResponseJSON(await send({ action: "status" }))).toMatchObject({
      inTransaction: true,
      ownedByYou: true,
    });
    expect((await send({ action: "rollback" })).status).toBe(200);
    expect(
      recordedEvents.map((event) => [event.transactionOutcome, event.statement, event.status, event.errorCode]),
    ).toEqual([
      ["open", "COMMIT", "error", "TIMEOUT_ERROR"],
      ["rolled-back", "ROLLBACK", "success", undefined],
    ]);
  });

  test("governance: a credential change on a transaction whose state is unknown records unknown unless a rollback answered", async () => {
    const providers = providerPerKey();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" }, "writer")).status).toBe(200);
    const writer = providers.of("writer", "alice-subject");
    const statement = heldCall<typeof emptyResult>();
    writer?.queryInTransaction.mockImplementationOnce(statement.call);
    const controller = new AbortController();
    const left = POST(
      leavingRequest(
        {
          connection: { ...validConnection, id: "seed:orders", grantLevel: "write", user: "writer" },
          action: "query",
          sql: "UPDATE t SET n = 1",
        },
        controller.signal,
      ) as never,
    );
    await statement.reached;
    controller.abort();
    statement.answer.resolve(emptyResult);
    expect((await left).status).toBe(499);
    // The provider that holds it is gone: a disconnect ended the transaction, and how is not known.
    providers.evict("writer", "alice-subject");

    const res = await send({ action: "status" }, "reader");

    // No transaction was left to roll back, and how the one the statement ran in ended is not known.
    expect(res.status).toBe(409);
    expect(await parseResponseJSON(res)).toEqual({
      error: CREDENTIAL_CHANGED_OUTCOME_UNKNOWN,
      code: "TRANSACTION_CREDENTIAL_CHANGED",
      rolledBack: false,
    });
    expect(ended()).toEqual([
      ["open", "UPDATE t SET n = 1", "error"],
      ["unknown", "ROLLBACK", "success"],
    ]);
  });

  test("governance: a credential change while the owner's stopped COMMIT still runs records unknown, never rolled-back, and answers rolledBack false", async () => {
    const providers = providerPerKey();
    as("alice@example.com", "alice-subject");
    expect((await send({ action: "begin" }, "writer")).status).toBe(200);
    const writer = providers.of("writer", "alice-subject");
    if (writer === undefined) throw new Error("alice's writer provider was expected to be resolved by her begin.");
    const commit = heldCall<void>();
    const committed = Promise.withResolvers<void>();
    writer.commitTransaction.mockImplementationOnce(async () => {
      await commit.call();
      // The COMMIT committed after its caller left.
      await writer.commitTransaction();
      committed.resolve();
    });
    const controller = new AbortController();
    const left = POST(
      leavingRequest(
        {
          connection: { ...validConnection, id: "seed:orders", grantLevel: "write", user: "writer" },
          action: "commit",
        },
        controller.signal,
      ) as never,
    );
    await commit.reached;
    controller.abort();
    expect((await left).status).toBe(499);
    // Studio's ROLLBACK queues behind the COMMIT on the transaction's connection, and finds nothing left to roll back,
    // which PostgreSQL answers with a warning, a success.
    const rollback = heldCall<void>();
    writer.rollbackTransaction.mockImplementationOnce(async () => {
      void rollback.call();
      await committed.promise;
    });

    // The grant was downgraded: her next request resolves the read credential.
    const changed = send({ action: "status" }, "reader");
    await rollback.reached;
    commit.answer.resolve();
    const res = await changed;

    expect(res.status).toBe(409);
    expect(await parseResponseJSON(res)).toEqual({
      error: CREDENTIAL_CHANGED_OUTCOME_UNKNOWN,
      code: "TRANSACTION_CREDENTIAL_CHANGED",
      rolledBack: false,
    });
    expect(writer.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(ended()).toEqual([
      ["open", "COMMIT", "error"],
      ["unknown", "ROLLBACK", "success"],
    ]);
  });

  test("governance: a credential change whose old provider cannot be read is logged, and the answer is still 409 with rolledBack false", async () => {
    providerPerKey();
    const errors = spyOn(logger, "error").mockImplementation(() => {});
    try {
      as("alice@example.com", "alice-subject");
      expect((await send({ action: "begin" }, "writer")).status).toBe(200);
      const unreadable = new Error(crypto.randomUUID());
      mockFindCachedProvider.mockImplementationOnce(() => {
        throw unreadable;
      });

      const res = await send({ action: "status" }, "reader");

      expect(res.status).toBe(409);
      expect(await parseResponseJSON(res)).toMatchObject({ code: "TRANSACTION_CREDENTIAL_CHANGED", rolledBack: false });
      expect(errors).toHaveBeenCalledTimes(1);
      expect(errors.mock.calls[0]?.[1]).toBe(unreadable);
      expect(ended()).toEqual([["rolled-back", "ROLLBACK", "error"]]);
    } finally {
      errors.mockRestore();
    }
  });

  /** `send` with the connection's password set, so a provider's text can hold it. */
  function sendHolding(password: string, body: Record<string, unknown>, user?: string) {
    return POST(
      createMockRequest("/api/db/transaction", {
        method: "POST",
        body: {
          connection: {
            ...validConnection,
            id: "seed:orders",
            grantLevel: user === "reader" ? "read" : "write",
            password,
            ...(user === undefined ? {} : { user }),
          },
          ...body,
        },
      }) as never,
    );
  }

  test("governance: a failed commit's and a failed query's events record the withheld sentence", async () => {
    const password = crypto.randomUUID();
    const providers = providerPerOwner();
    as("alice@example.com", "alice-subject");
    expect((await sendHolding(password, { action: "begin" })).status).toBe(200);
    const provider = providers.of("alice-subject");
    provider?.queryInTransaction.mockImplementationOnce(async () => {
      throw new QueryError(`syntax error near ${password}`, "postgres");
    });
    expect((await sendHolding(password, { action: "query", sql: "SELECT 1" })).status).toBe(400);
    provider?.commitTransaction.mockImplementationOnce(async () => {
      throw new QueryError(`commit failed for ${password}`, "postgres");
    });
    expect((await sendHolding(password, { action: "commit" })).status).toBe(400);

    expect(recordedEvents.map((event) => [event.statement, event.errorCode, event.errorMessage])).toEqual([
      ["SELECT 1", "QUERY_ERROR", withheldErrorMessage("QueryError")],
      ["COMMIT", "QUERY_ERROR", withheldErrorMessage("QueryError")],
    ]);
    expect(JSON.stringify(recordedEvents)).not.toContain(password);
    expect((await sendHolding(password, { action: "rollback" })).status).toBe(200);
  });

  test("governance: a failed rollback after a credential change logs the withheld error", async () => {
    // The write and the read credential differ, as they do under governance: the provider rolled back on holds the
    // write credential that begin resolved, which the request now resolving the read credential does not carry.
    const writerPassword = crypto.randomUUID();
    const readerPassword = crypto.randomUUID();
    const providers = providerPerKey();
    const errors = spyOn(logger, "error").mockImplementation(() => {});
    try {
      as("alice@example.com", "alice-subject");
      expect((await sendHolding(writerPassword, { action: "begin" }, "writer")).status).toBe(200);
      providers.of("writer", "alice-subject")?.rollbackTransaction.mockImplementationOnce(async () => {
        throw new ConnectionError(`connection of ${writerPassword} terminated`, "postgres");
      });

      const res = await sendHolding(readerPassword, { action: "rollback" }, "reader");

      expect(res.status).toBe(409);
      expect(errors).toHaveBeenCalledTimes(1);
      const logged = errors.mock.calls[0]?.[1];
      expect(logged).toBeInstanceOf(ProviderTextWithheldError);
      for (const password of [writerPassword, readerPassword]) {
        expect(JSON.stringify(errors.mock.calls)).not.toContain(password);
        expect(String((logged as Error).stack)).not.toContain(password);
      }
      expect((await sendHolding(readerPassword, { action: "begin" }, "reader")).status).toBe(200);
      expect((await sendHolding(readerPassword, { action: "rollback" }, "reader")).status).toBe(200);
    } finally {
      errors.mockRestore();
    }
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

// ─── The server's confirmation of a run (FND-5) ─────────────────────────────
describe("POST /api/db/transaction: the server's confirmation of a run", () => {
  const original = process.env.LIBREDB_RUN_CONFIRMATION;
  const session = { role: "user" as const, username: "alice", iat: 1_700_000_000 };
  let warn: ReturnType<typeof spyOn>;

  function run(body: Record<string, unknown>) {
    return POST(createMockRequest("/api/db/transaction", { method: "POST", body }) as never);
  }

  function nothingRan(): void {
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
    expect(mockTxProvider.queryInTransaction).not.toHaveBeenCalled();
    expect(mockAdmitQueryExecution).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    delete process.env.LIBREDB_RUN_CONFIRMATION;
    clearRateLimitState();
    forgetUsedRunConfirmations();
    mockGetOrCreateProvider.mockClear();
    mockGetOrCreateProvider.mockImplementation(async () => mockTxProvider as never);
    mockAdmitQueryExecution.mockClear();
    mockTxProvider.isInTransaction.mockImplementation(() => true);
    mockTxProvider.queryInTransaction.mockClear();
    mockTxProvider.beginTransaction.mockClear();
    mockTxProvider.beginTransaction.mockImplementation(async () => {});
    mockTxProvider.commitTransaction.mockClear();
    mockTxProvider.commitTransaction.mockImplementation(async () => {});
    mockTxProvider.rollbackTransaction.mockClear();
    mockTxProvider.rollbackTransaction.mockImplementation(async () => {});
    mockTxProvider.queryInTransaction.mockImplementation(async () => ({
      rows: [{ id: 1, name: "Alice" }],
      fields: ["id", "name"],
      rowCount: 1,
      executionTime: 1,
    }));
    (mockTxProvider.prepareQuery as ReturnType<typeof mock>).mockImplementation((query: string) => ({
      query,
      wasLimited: false,
      limit: 50,
      offset: 0,
    }));
    mockGetSession.mockImplementation(async () => session);
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    releaseTransaction(transactionKey(validConnection.id, undefined, undefined));
    if (original === undefined) delete process.env.LIBREDB_RUN_CONFIRMATION;
    else process.env.LIBREDB_RUN_CONFIRMATION = original;
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
  });

  describe("server confirmation, advisory", () => {
    test("a write sent without the field runs in the transaction and its answer says unconfirmed", async () => {
      const res = await run({ connection: validConnection, action: "query", sql: "DELETE FROM t" });
      expect(res.status).toBe(200);
      expect((await parseResponseJSON<{ confirmation?: string }>(res)).confirmation).toBe("unconfirmed");
      expect(mockTxProvider.queryInTransaction).toHaveBeenCalledTimes(1);
      expect(
        warn.mock.calls.filter(
          (call: unknown[]) => (call[1] as { route?: string } | undefined)?.route === "api/db/transaction",
        ),
      ).toEqual([
        [
          "A statement that needs a confirmation ran without one",
          { route: "api/db/transaction", type: "postgres", user: "alice" },
        ],
      ]);
    });

    test("a script that writes, sent without the field, runs and its answer says unconfirmed", async () => {
      const res = await run({ connection: validConnection, action: "query", sql: "SELECT 1; DROP TABLE t" });
      expect(res.status).toBe(200);
      expect((await parseResponseJSON<{ confirmation?: string }>(res)).confirmation).toBe("unconfirmed");
    });

    test("a read runs with no field in its answer", async () => {
      const res = await run({ connection: validConnection, action: "query", sql: "SELECT 1" });
      expect(res.status).toBe(200);
      expect(await parseResponseJSON<Record<string, unknown>>(res)).not.toHaveProperty("confirmation");
    });
  });

  describe("server confirmation, ask", () => {
    test.each(["advisory", "required"])(
      "a write that asks is answered 428 in %s mode, before any provider",
      async (mode) => {
        process.env.LIBREDB_RUN_CONFIRMATION = mode;
        const res = await run({
          connection: validConnection,
          action: "query",
          sql: "DELETE FROM t",
          confirmation: "ask",
        });
        expect(res.status).toBe(428);
        expect(await parseResponseJSON(res)).toMatchObject({ code: "CONFIRMATION_REQUIRED" });
        nothingRan();
      },
    );

    test("a malformed field is refused before any provider", async () => {
      const res = await run({ connection: validConnection, action: "query", sql: "SELECT 1", confirmation: 0 });
      expect(res.status).toBe(400);
      expect(await parseResponseJSON(res)).toEqual({ error: CONFIRMATION_FIELD_MESSAGE });
      nothingRan();
    });
  });

  describe("server confirmation, required", () => {
    beforeEach(() => {
      process.env.LIBREDB_RUN_CONFIRMATION = "required";
    });

    test("a write sent without the field is answered 428, and the token runs it once", async () => {
      const body = { connection: validConnection, action: "query", sql: "DELETE FROM t WHERE id = $1", params: [7] };
      const asked = await run(body);
      expect(asked.status).toBe(428);
      nothingRan();
      const { token } = (await parseResponseJSON<{ confirmation: { token: string } }>(asked)).confirmation;
      const ran = await run({ ...body, confirmation: { token } });
      expect(ran.status).toBe(200);
      expect(mockTxProvider.queryInTransaction).toHaveBeenCalledTimes(1);
      const again = await run({ ...body, confirmation: { token } });
      expect(again.status).toBe(400);
      expect(await parseResponseJSON(again)).toEqual({
        error: "this confirmation has already been used",
        code: "CONFIRMATION_INVALID",
      });
    });

    test("a token minted on this route is refused on POST /api/db/query's route name, and the reverse here", async () => {
      const issued = await mintRunConfirmation({
        issuer: runConfirmationIssuerForSession(session),
        connection: validConnection as never,
        catalog: undefined,
        route: "query",
        statement: "DELETE FROM t",
        params: undefined,
        verdict: { decision: "confirm", unreadable: false, typedConfirmation: null, classificationFailed: false },
      });
      const res = await run({
        connection: validConnection,
        action: "query",
        sql: "DELETE FROM t",
        confirmation: { token: issued.token },
      });
      expect(res.status).toBe(400);
      expect((await parseResponseJSON<{ error: string }>(res)).error).toBe(
        "this confirmation was issued for another route",
      );
    });

    test("begin, commit and rollback are not classified", async () => {
      mockTxProvider.isInTransaction.mockImplementation(() => false);
      // The session holds a transaction from the begin on, as a server that opened one does.
      mockTxProvider.beginTransaction.mockImplementationOnce(async () => {
        mockTxProvider.isInTransaction.mockImplementation(() => true);
      });
      const begun = await run({ connection: validConnection, action: "begin", sql: "DROP TABLE t" });
      expect(begun.status).toBe(200);
      mockTxProvider.isInTransaction.mockImplementation(() => true);
      expect((await run({ connection: validConnection, action: "commit", sql: "DROP TABLE t" })).status).toBe(200);
      expect((await run({ connection: validConnection, action: "rollback", confirmation: "nonsense" })).status).toBe(
        200,
      );
    });
  });

  describe("server confirmation, order", () => {
    test.each([
      ["a missing statement", { connection: validConnection, action: "query", confirmation: "ask" }],
      ["a statement that is not text", { connection: validConnection, action: "query", sql: 1, confirmation: "ask" }],
      [
        "bad bound values",
        { connection: validConnection, action: "query", sql: "DELETE FROM t", params: "x", confirmation: "ask" },
      ],
      [
        "bad page bounds",
        {
          connection: validConnection,
          action: "query",
          sql: "DELETE FROM t",
          options: { offset: -1 },
          confirmation: "ask",
        },
      ],
      ["a missing action", { connection: validConnection, sql: "DELETE FROM t", confirmation: "ask" }],
    ] as const)("%s is refused for its fields whatever the confirmation holds", async (_label, body) => {
      process.env.LIBREDB_RUN_CONFIRMATION = "required";
      const res = await run(body as Record<string, unknown>);
      expect(res.status).toBe(400);
      expect(await parseResponseJSON<Record<string, unknown>>(res)).not.toHaveProperty("code", "CONFIRMATION_REQUIRED");
      nothingRan();
    });
  });

  describe("server confirmation, production", () => {
    test("advisory asks the query action that writes on production and sends no field, and nothing runs", async () => {
      const name = crypto.randomUUID();
      const production = { ...validConnection, name, environment: "production" };
      recordedEvents.length = 0;
      const res = await run({ connection: production, action: "query", sql: "DELETE FROM t" });
      expect(res.status).toBe(428);
      const { confirmation } = await parseResponseJSON<{
        confirmation: { token: string; typedConfirmation: unknown };
      }>(res);
      expect(confirmation.token).toEqual(expect.any(String));
      expect(confirmation.typedConfirmation).toEqual({ type: "connection-name", expected: name, targets: [] });
      nothingRan();
      expect(recordedEvents).toEqual([]);
    });

    test("advisory still runs the query action that writes with no field off production, marked unconfirmed", async () => {
      const staging = { ...validConnection, name: crypto.randomUUID(), environment: "staging" };
      const res = await run({ connection: staging, action: "query", sql: "DELETE FROM t" });
      expect(res.status).toBe(200);
      expect((await parseResponseJSON<{ confirmation?: string }>(res)).confirmation).toBe("unconfirmed");
      expect(mockTxProvider.queryInTransaction).toHaveBeenCalledTimes(1);
    });

    test("advisory runs a read in the query action on production with no field", async () => {
      const production = { ...validConnection, name: crypto.randomUUID(), environment: "production" };
      const res = await run({ connection: production, action: "query", sql: "SELECT 1" });
      expect(res.status).toBe(200);
      expect(mockTxProvider.queryInTransaction).toHaveBeenCalledTimes(1);
    });

    test("the query action asks for the name on production, and runs once with it", async () => {
      process.env.LIBREDB_RUN_CONFIRMATION = "required";
      const name = crypto.randomUUID();
      const production = { ...validConnection, name, environment: "production" };
      const body = { connection: production, action: "query", sql: "DELETE FROM t" };
      const asked = await run(body);
      expect(asked.status).toBe(428);
      const { confirmation } = await parseResponseJSON<{
        confirmation: { token: string; typedConfirmation: unknown };
      }>(asked);
      expect(confirmation.typedConfirmation).toEqual({ type: "connection-name", expected: name, targets: [] });
      expect((await run({ ...body, confirmation: { token: confirmation.token } })).status).toBe(428);
      expect(
        (await run({ ...body, confirmation: { token: confirmation.token, typed: crypto.randomUUID() } })).status,
      ).toBe(400);
      nothingRan();
      const ran = await run({ ...body, confirmation: { token: confirmation.token, typed: name } });
      expect(ran.status).toBe(200);
      expect(mockTxProvider.queryInTransaction).toHaveBeenCalledTimes(1);
    });

    test("begin, commit and rollback are not classified on production", async () => {
      process.env.LIBREDB_RUN_CONFIRMATION = "required";
      const production = { ...validConnection, name: crypto.randomUUID(), environment: "production" };
      // The session holds a transaction from each begin on, as a server that opened one does.
      mockTxProvider.beginTransaction.mockImplementation(async () => {
        mockTxProvider.isInTransaction.mockImplementation(() => true);
      });
      mockTxProvider.isInTransaction.mockImplementation(() => false);
      expect((await run({ connection: production, action: "begin" })).status).toBe(200);
      mockTxProvider.isInTransaction.mockImplementation(() => true);
      expect((await run({ connection: production, action: "commit" })).status).toBe(200);
      mockTxProvider.isInTransaction.mockImplementation(() => false);
      expect((await run({ connection: production, action: "begin" })).status).toBe(200);
      mockTxProvider.isInTransaction.mockImplementation(() => true);
      expect((await run({ connection: production, action: "rollback" })).status).toBe(200);
    });
  });
});

describe("the transaction route on the provider host", () => {
  test("the transaction route reads no session state but through the host", () => {
    const root = path.join(import.meta.dir, "..", "..", "..");
    // The code of each file, its comment lines left out: a comment may name what the code no longer calls.
    const code = (...parts: string[]) =>
      readFileSync(path.join(root, ...parts), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .join("\n");
    const route = code("src", "app", "api", "db", "transaction", "route.ts");
    const ownership = code("src", "lib", "api", "transaction-ownership.ts");

    expect(route.includes("isInTransaction")).toBe(false);
    expect(ownership.includes("isInTransaction")).toBe(false);
    expect(route.includes("queryInTransaction")).toBe(false);
    expect(route.includes("prepareQuery")).toBe(false);
  });
});
