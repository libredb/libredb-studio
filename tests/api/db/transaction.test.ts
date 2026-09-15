import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import { clearRateLimitState } from "@/lib/api/rate-limit";
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
} from "@/lib/db/errors";

// ─── Create mock provider with transaction methods ──────────────────────────
const baseMockProvider = createMockProvider();

const mockTxProvider = {
  ...baseMockProvider,
  beginTransaction: mock(async () => {}),
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

const mockGetOrCreateProvider = mock(async () => mockTxProvider as never);

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

// ─── Mock auth + seed resolution BEFORE importing route ─────────────────────
mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
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

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import("@/app/api/db/transaction/route");

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
    expect(data.pagination.wasLimited).toBeDefined();
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
