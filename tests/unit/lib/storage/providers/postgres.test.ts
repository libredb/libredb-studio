import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { EventEmitter } from "node:events";
import type { ServerStorageProvider } from "@/lib/storage/types";
import { logger } from "@/lib/logger";

// ── Mock pg ──────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockQuery = mock(async (..._args: any[]): Promise<any> => ({ rows: [] }));
const mockRelease = mock(() => {});
const mockEnd = mock(async () => {});

const mockClient = {
  query: mockQuery,
  release: mockRelease,
};

/**
 * A real EventEmitter, fresh per construction, mirroring what `pg` hands back. An `error`
 * event with no listener is an uncaught exception (#298), and this pool is long-lived —
 * it serves every request while STORAGE_PROVIDER=postgres — so an inert `on` in the mock
 * would hide exactly the crash this suite has to pin.
 */
function createMockPool(): EventEmitter & Record<string, any> {
  const pool = new EventEmitter() as EventEmitter & Record<string, any>;
  pool.query = mockQuery;
  pool.connect = mock(async () => mockClient);
  pool.end = mockEnd;
  return pool;
}

let mockPool = createMockPool();

const mockPoolConstructor = mock(() => {
  mockPool = createMockPool();
  return mockPool;
});

mock.module("pg", () => ({
  Pool: mockPoolConstructor,
}));
/* eslint-enable @typescript-eslint/no-explicit-any */

import { PostgresStorageProvider } from "@/lib/storage/providers/postgres";
import {
  AccountWriteConflict,
  LastAdminError,
  PasskeyRegistrationConflict,
  PasskeyRemovalConflict,
  PasskeySignInConflict,
  type StoredAccount,
  type StoredPasskey,
} from "@/lib/storage/types";

describe("PostgresStorageProvider", () => {
  let provider: ServerStorageProvider;

  beforeEach(() => {
    mockQuery.mockClear();
    mockEnd.mockClear();
    mockRelease.mockClear();
    mockPoolConstructor.mockClear();
    provider = new PostgresStorageProvider("postgresql://localhost:5432/test");
  });

  afterEach(async () => {
    await provider.close();
  });

  test("initialize creates table", async () => {
    await provider.initialize();
    // The tables, then the lookup of missing passkey indexes, which finds none here.
    expect(mockQuery).toHaveBeenCalledTimes(2);
    const sql = (mockQuery.mock.calls as unknown[][])[0][0] as string;
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS user_storage");
  });

  test("initialize disables SSL for localhost when no ssl params", async () => {
    const localProvider = new PostgresStorageProvider("postgresql://localhost:5432/test");
    await localProvider.initialize();

    const poolConfig = (mockPoolConstructor.mock.calls as unknown[][])[0]?.[0] as {
      ssl?: unknown;
    };
    expect(poolConfig.ssl).toBe(false);
    await localProvider.close();
  });

  test("initialize disables SSL when sslmode=disable", async () => {
    const localProvider = new PostgresStorageProvider("postgresql://localhost:5432/test?sslmode=disable");
    await localProvider.initialize();

    const poolConfig = (mockPoolConstructor.mock.calls as unknown[][])[0]?.[0] as {
      ssl?: unknown;
    };
    expect(poolConfig.ssl).toBe(false);
    await localProvider.close();
  });

  test("initialize disables SSL for docker local host aliases", async () => {
    const localProvider = new PostgresStorageProvider("postgresql://host.docker.internal:5432/test");
    await localProvider.initialize();

    const poolConfig = (mockPoolConstructor.mock.calls as unknown[][])[0]?.[0] as {
      ssl?: unknown;
    };
    expect(poolConfig.ssl).toBe(false);
    await localProvider.close();
  });

  test("initialize enables SSL when sslmode=require", async () => {
    const cloudProvider = new PostgresStorageProvider("postgresql://db.example.com:5432/test?sslmode=require");
    await cloudProvider.initialize();

    const poolConfig = (mockPoolConstructor.mock.calls as unknown[][])[0]?.[0] as {
      ssl?: unknown;
    };
    expect(poolConfig.ssl).toEqual({ rejectUnauthorized: false });
    await cloudProvider.close();
  });

  // D26: `verify-system` is this product's own mode name, and STORAGE_POSTGRES_URL is read
  // for libpq's sslmode - so a URL naming it used to fall through every branch and land on
  // the non-local default, `rejectUnauthorized: false`. Someone who typed the verifying mode
  // got no verification and no complaint. It is now the one value in this reader that
  // actually verifies.
  test("initialize verifies the chain when the URL names the form's verify-system mode", async () => {
    const cloudProvider = new PostgresStorageProvider("postgresql://db.example.com:5432/test?sslmode=verify-system");
    await cloudProvider.initialize();

    const poolConfig = (mockPoolConstructor.mock.calls as unknown[][])[0]?.[0] as {
      ssl?: unknown;
    };
    expect(poolConfig.ssl).toEqual({ rejectUnauthorized: true });
    await cloudProvider.close();
  });

  test("initialize enables SSL for non-local hosts by default", async () => {
    const cloudProvider = new PostgresStorageProvider("postgresql://db.internal.example:5432/test");
    await cloudProvider.initialize();

    const poolConfig = (mockPoolConstructor.mock.calls as unknown[][])[0]?.[0] as {
      ssl?: unknown;
    };
    expect(poolConfig.ssl).toEqual({ rejectUnauthorized: false });
    await cloudProvider.close();
  });

  test("initialize disables SSL for all loopback 127.x.x.x addresses", async () => {
    const localProvider = new PostgresStorageProvider("postgresql://127.0.0.42:5432/test");
    await localProvider.initialize();

    const poolConfig = (mockPoolConstructor.mock.calls as unknown[][])[0]?.[0] as {
      ssl?: unknown;
    };
    expect(poolConfig.ssl).toBe(false);
    await localProvider.close();
  });

  test("getAllData returns parsed collections", async () => {
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({
      rows: [
        { collection: "connections", data: JSON.stringify([{ id: "c1" }]) },
        { collection: "history", data: JSON.stringify([{ id: "h1" }]) },
      ],
    });

    const result = await provider.getAllData("admin@test.com");
    expect(result.connections as unknown).toEqual([{ id: "c1" }]);
    expect(result.history as unknown).toEqual([{ id: "h1" }]);
  });

  test("getCollection returns null when not found", async () => {
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    const result = await provider.getCollection("admin@test.com", "connections");
    expect(result).toBeNull();
  });

  test("getCollection returns parsed data", async () => {
    const data = [{ id: "c1", name: "Test" }];
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({
      rows: [{ data: JSON.stringify(data) }],
    });

    const result = await provider.getCollection("admin@test.com", "connections");
    expect(result as unknown).toEqual(data);
  });

  test("setCollection calls INSERT with ON CONFLICT", async () => {
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({ rows: [] });

    await provider.setCollection("admin@test.com", "connections", []);

    const calls = mockQuery.mock.calls as unknown[][];
    const lastCall = calls[calls.length - 1];
    const sql = lastCall[0] as string;
    expect(sql).toContain("INSERT INTO user_storage");
    expect(sql).toContain("ON CONFLICT");
  });

  test("persists exactly JSON.stringify of what it was given, adding and hiding nothing", async () => {
    // Same reasoning as the SQLite twin: the threat test's claim about the store depends on the
    // provider being a faithful serializer.
    await provider.initialize();
    mockQuery.mockClear();
    const data = [{ id: "c1", name: "Prod", type: "postgres", password: "v1:aaa:bbb" }];

    await provider.setCollection("u@example.org", "connections", data as never);

    const [, params] = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
    expect(params).toEqual(["u@example.org", "connections", JSON.stringify(data)]);
  });

  test("isHealthy returns true on success", async () => {
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({ rows: [{ ok: 1 }] });

    expect(await provider.isHealthy()).toBe(true);
  });

  test("isHealthy returns false on error", async () => {
    await provider.initialize();
    mockQuery.mockRejectedValueOnce(new Error("Connection lost"));

    expect(await provider.isHealthy()).toBe(false);
  });

  test("close calls pool.end()", async () => {
    await provider.initialize();
    await provider.close();
    expect(mockEnd).toHaveBeenCalledTimes(1);
  });

  test("mergeData uses transaction", async () => {
    await provider.initialize();

    const mockClientQuery = mock(async (): Promise<{ rows: unknown[] }> => ({ rows: [] }));
    const client = {
      query: mockClientQuery,
      release: mock(() => {}),
    };
    mockPool.connect = mock(async () => client);

    await provider.mergeData("admin@test.com", {
      connections: [
        { id: "c1", name: "Test", type: "postgres", createdAt: new Date() } as import("@/lib/types").DatabaseConnection,
      ],
    });

    const queries = (mockClientQuery.mock.calls as unknown[][]).map((c) => c[0] as string);
    expect(queries[0]).toBe("BEGIN");
    expect(queries[queries.length - 1]).toBe("COMMIT");
  });

  test("mergeData rolls back on error and releases client", async () => {
    await provider.initialize();

    let callCount = 0;
    const mockClientQuery = mock(async (sql: string): Promise<{ rows: unknown[] }> => {
      callCount++;
      // Fail on the INSERT (3rd call: BEGIN, then INSERT fails)
      if (callCount === 2) throw new Error("Insert failed");
      return { rows: [] };
    });
    const mockClientRelease = mock(() => {});
    const client = {
      query: mockClientQuery,
      release: mockClientRelease,
    };
    mockPool.connect = mock(async () => client);

    await expect(
      provider.mergeData("admin@test.com", {
        connections: [
          {
            id: "c1",
            name: "Test",
            type: "postgres",
            createdAt: new Date(),
          } as import("@/lib/types").DatabaseConnection,
        ],
      }),
    ).rejects.toThrow("Insert failed");

    // ROLLBACK should have been called
    const queries = (mockClientQuery.mock.calls as unknown[][]).map((c) => c[0] as string);
    expect(queries).toContain("ROLLBACK");
    // Client always released (finally block)
    expect(mockClientRelease).toHaveBeenCalledTimes(1);
  });

  test("mergeData only writes provided collections", async () => {
    await provider.initialize();

    const mockClientQuery = mock(async (): Promise<{ rows: unknown[] }> => ({ rows: [] }));
    const client = {
      query: mockClientQuery,
      release: mock(() => {}),
    };
    mockPool.connect = mock(async () => client);

    await provider.mergeData("admin@test.com", {
      connections: [
        { id: "c1", name: "Test", type: "postgres", createdAt: new Date() } as import("@/lib/types").DatabaseConnection,
      ],
    });

    const queries = (mockClientQuery.mock.calls as unknown[][]).map((c) => c[0] as string);
    // BEGIN + 1 INSERT + COMMIT = 3 queries
    expect(queries.length).toBe(3);
    expect(queries[0]).toBe("BEGIN");
    expect(queries[1]).toContain("INSERT INTO user_storage");
    expect(queries[2]).toBe("COMMIT");
  });

  test("getCollection returns null for corrupted JSON", async () => {
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({
      rows: [{ data: "invalid-json{{{" }],
    });

    const result = await provider.getCollection("admin@test.com", "connections");
    expect(result).toBeNull();
  });

  test("getAllData skips corrupted JSON rows", async () => {
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({
      rows: [
        { collection: "connections", data: JSON.stringify([{ id: "c1" }]) },
        { collection: "history", data: "corrupted{{{" },
      ],
    });

    const result = await provider.getAllData("admin@test.com");
    expect(result.connections as unknown).toEqual([{ id: "c1" }]);
    expect(result.history).toBeUndefined();
  });

  test("initialize throws when no connection string", async () => {
    const origEnv = process.env.STORAGE_POSTGRES_URL;
    delete process.env.STORAGE_POSTGRES_URL;
    try {
      const noUrlProvider = new PostgresStorageProvider("");
      await expect(noUrlProvider.initialize()).rejects.toThrow("STORAGE_POSTGRES_URL is required");
    } finally {
      if (origEnv !== undefined) process.env.STORAGE_POSTGRES_URL = origEnv;
    }
  });

  test("close on uninitialized provider does not throw", async () => {
    const freshProvider = new PostgresStorageProvider("postgresql://localhost/test");
    await expect(freshProvider.close()).resolves.toBeUndefined();
  });

  test("ensurePool throws when not initialized", async () => {
    const freshProvider = new PostgresStorageProvider("postgresql://localhost/test");
    await expect(freshProvider.getAllData("test@test.com")).rejects.toThrow("not initialized");
  });

  // ── Pool error events (#298) ───────────────────────────────────────────────

  test("an idle client error on the storage pool is logged and does not escalate", async () => {
    await provider.initialize();
    const idleFailure = new Error("Connection terminated unexpectedly");
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
    // Another test file replaces `@/lib/logger` wholesale, and spying on a method that is
    // already a mock reuses that mock — call history from the rest of the process comes
    // with it. Clear it so the count below is this test's own.
    errorSpy.mockClear();

    try {
      // `pg` destroys the idle client and emits on the POOL; an `error` event with no
      // listener is an uncaught exception, i.e. a dead server process.
      expect(() => mockPool.emit("error", idleFailure)).not.toThrow();
      expect(errorSpy).toHaveBeenCalledTimes(1);
      const [message, loggedError, context] = errorSpy.mock.calls[0] as [string, unknown, unknown];
      expect(message).toContain("pool");
      expect(loggedError).toBe(idleFailure);
      expect(context).toEqual({ provider: "postgres" });
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("the storage pool carries exactly one error listener", async () => {
    await provider.initialize();
    expect(mockPool.listenerCount("error")).toBe(1);
  });

  test("initialize creates the accounts table", async () => {
    await provider.initialize();
    const sql = (mockQuery.mock.calls as unknown[][])[0][0] as string;
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS accounts");
  });

  test("lists and reads accounts", async () => {
    await provider.initialize();
    mockQuery.mockClear();
    const row = {
      email: "ada@example.com",
      password_hash: "scrypt$16384$8$1$salt$key",
      role: "admin",
      totp_secret: "SECRET",
      totp_pending: null,
      disabled: 1,
      session_version: 3,
      created_at: "2026-09-25T00:00:00.000Z",
      updated_at: "2026-09-25T00:00:00.000Z",
    };
    mockQuery.mockResolvedValueOnce({ rows: [row] });
    const listed = await provider.listAccounts();
    expect(listed).toEqual([
      {
        email: "ada@example.com",
        passwordHash: row.password_hash,
        role: "admin",
        totpSecret: "SECRET",
        totpPending: null,
        disabled: true,
        sessionVersion: 3,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      },
    ]);
    expect((mockQuery.mock.calls as unknown[][])[0][0]).toContain("FROM accounts");

    mockQuery.mockResolvedValueOnce({ rows: [{ ...row, role: "user", disabled: 0, totp_secret: null }] });
    const one = await provider.getAccount("ada@example.com");
    expect(one?.role).toBe("user");
    expect(one?.disabled).toBe(false);
    expect(one?.totpSecret).toBeNull();

    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await provider.getAccount("missing@example.com")).toBeNull();
  });

  test("rejects an accounts row whose role is not admin or user", async () => {
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({
      rows: [
        {
          email: "ada@example.com",
          password_hash: "h",
          role: "owner",
          totp_secret: null,
          totp_pending: null,
          disabled: 0,
          session_version: 0,
          created_at: "t",
          updated_at: "t",
        },
      ],
    });
    await expect(provider.listAccounts()).rejects.toThrow(/role owner/);
  });

  test("rejects an accounts row whose session_version is not a whole number", async () => {
    await provider.initialize();
    const row = {
      email: "ada@example.com",
      password_hash: "h",
      role: "user",
      totp_secret: null,
      totp_pending: null,
      disabled: 0,
      created_at: "t",
      updated_at: "t",
    };
    for (const session_version of ["x", -1, 1.5]) {
      mockQuery.mockResolvedValueOnce({ rows: [{ ...row, session_version }] });
      await expect(provider.getAccount("ada@example.com")).rejects.toThrow(/session_version/);
    }
  });

  test("writes account inserts, updates and deletes", async () => {
    await provider.initialize();
    mockQuery.mockClear();
    const account = {
      email: "ada@example.com",
      passwordHash: "scrypt$hash",
      role: "user" as const,
      totpSecret: null,
      totpPending: null,
      disabled: false,
      sessionVersion: 0,
      createdAt: "t",
      updatedAt: "t",
    };
    const clientQuery = mock(async (): Promise<{ rows: unknown[]; rowCount: number }> => ({ rows: [], rowCount: 1 }));
    const release = mock(() => {});
    mockPool.connect = mock(async () => ({ query: clientQuery, release }));
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await provider.insertAccount(account);
    } finally {
      warnSpy.mockRestore();
    }
    expect(String((clientQuery.mock.calls as unknown[][]).at(-2)?.[0])).toContain("INSERT INTO accounts");
    clientQuery.mockClear();
    release.mockClear();

    await provider.updateAccount({ ...account, disabled: true }, { expected: account });
    await provider.deleteAccount(account.email);
    const sql = (clientQuery.mock.calls as unknown[][]).map((call) => call[0] as string);
    expect(sql[0]).toBe("BEGIN");
    expect(sql[1]).toContain("UPDATE accounts");
    expect(sql[2]).toBe("COMMIT");
    expect(sql[3]).toBe("BEGIN");
    expect(sql[4]).toContain("DELETE FROM accounts");
    expect(sql[5]).toContain("DELETE FROM user_storage");
    expect(sql[6]).toBe("COMMIT");
    // An unguarded write takes no lock on the admin rows.
    expect(sql.some((statement) => statement.includes("FOR UPDATE"))).toBe(false);
    expect(release).toHaveBeenCalledTimes(2);
  });

  test("a guarded write locks the enabled admins first and commits when one remains", async () => {
    await provider.initialize();
    const clientQuery = mock(
      async (sql: string): Promise<{ rows: unknown[] }> =>
        sql.includes("COUNT(*)") ? { rows: [{ n: 1 }] } : { rows: [] },
    );
    const release = mock(() => {});
    mockPool.connect = mock(async () => ({ query: clientQuery, release }));
    await provider.deleteAccount("ada@example.com", { keepEnabledAdmin: true });
    const sql = (clientQuery.mock.calls as unknown[][]).map((call) => call[0] as string);
    expect(sql[0]).toBe("BEGIN");
    expect(sql[1]).toContain("FOR UPDATE");
    expect(sql[2]).toContain("DELETE FROM accounts");
    expect(sql[4]).toContain("COUNT(*)");
    expect(sql[5]).toBe("COMMIT");
  });

  test("a guarded write that would leave no enabled admin rolls back with LastAdminError", async () => {
    await provider.initialize();
    const clientQuery = mock(
      async (sql: string): Promise<{ rows: unknown[]; rowCount: number }> =>
        sql.includes("COUNT(*)") ? { rows: [{ n: "0" }], rowCount: 1 } : { rows: [], rowCount: 1 },
    );
    const release = mock(() => {});
    mockPool.connect = mock(async () => ({ query: clientQuery, release }));
    const account = {
      email: "ada@example.com",
      passwordHash: "scrypt$hash",
      role: "user" as const,
      totpSecret: null,
      totpPending: null,
      disabled: false,
      sessionVersion: 3,
      createdAt: "t",
      updatedAt: "t",
    };
    await expect(provider.updateAccount(account, { expected: account, keepEnabledAdmin: true })).rejects.toBeInstanceOf(
      LastAdminError,
    );
    const sql = (clientQuery.mock.calls as unknown[][]).map((call) => call[0] as string);
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledTimes(1);
  });

  test("deleteAccount rolls back when the row delete fails, so no rows are orphaned", async () => {
    await provider.initialize();
    const clientQuery = mock(async (sql: string): Promise<{ rows: unknown[] }> => {
      if (sql.includes("DELETE FROM user_storage")) throw new Error("row delete refused");
      return { rows: [] };
    });
    const release = mock(() => {});
    mockPool.connect = mock(async () => ({ query: clientQuery, release }));
    await expect(provider.deleteAccount("ada@example.com")).rejects.toThrow(/row delete refused/);
    const sql = (clientQuery.mock.calls as unknown[][]).map((call) => call[0] as string);
    expect(sql).toContain("ROLLBACK");
    expect(sql).not.toContain("COMMIT");
    expect(release).toHaveBeenCalledTimes(1);
  });
  test("account reads fail before initialize", async () => {
    const fresh = new PostgresStorageProvider("postgresql://localhost:5432/test");
    await expect(fresh.listAccounts()).rejects.toThrow(/not initialized/);
  });

  // ── Passkeys (driver mechanics only; the behaviour is tests/helpers/passkey-store-contract.ts) ──

  type Reply = { rows?: unknown[]; rowCount?: number | null } | Error;

  /** A pool client that answers each statement through `reply` and records what it saw. */
  function scriptedClient(reply: (sql: string, params: unknown[]) => Reply = () => ({})) {
    const statements: { sql: string; params: unknown[] }[] = [];
    const release = mock(() => {});
    const query = mock(async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      const answer = reply(sql, params);
      if (answer instanceof Error) throw answer;
      return { rows: answer.rows ?? [], rowCount: answer.rowCount === undefined ? 1 : answer.rowCount };
    });
    mockPool.connect = mock(async () => ({ query, release }));
    return { statements, release, sql: () => statements.map((statement) => statement.sql) };
  }

  const ACCOUNT: StoredAccount = {
    email: "ada@example.com",
    passwordHash: "scrypt$hash",
    role: "user",
    totpSecret: null,
    totpPending: null,
    disabled: false,
    sessionVersion: 3,
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-28T00:00:00.000Z",
  };

  const PASSKEY: StoredPasskey = {
    id: "11111111-1111-4111-8111-111111111111",
    credentialId: "cred",
    accountEmail: ACCOUNT.email,
    publicKey: "pk",
    signCount: 0,
    transports: ["internal", "hybrid"],
    backupEligible: true,
    backupState: false,
    rpId: "studio.example.com",
    name: "Passkey",
    createdAt: "2026-09-28T00:00:00.000Z",
    lastUsedAt: null,
  };

  const PASSKEY_ROW = {
    id: PASSKEY.id,
    credential_id: "cred",
    account_email: ACCOUNT.email,
    public_key: "pk",
    sign_count: "3000000000",
    transports: '["internal","hybrid"]',
    backup_eligible: 1,
    backup_state: 0,
    rp_id: "studio.example.com",
    name: "Passkey",
    created_at: "2026-09-28T00:00:00.000Z",
    last_used_at: null,
  };

  const CHALLENGE = { hash: "ab".repeat(32), expiresAt: "2026-09-28T00:10:00.000Z" };
  const PURGE_BEFORE = "2026-09-27T23:50:00.000Z";

  function registration() {
    return {
      passkey: PASSKEY,
      userHandle: "handle",
      expectedSessionVersion: 3,
      maxPasskeys: 20,
      challenge: CHALLENGE,
      purgeSpentBefore: PURGE_BEFORE,
    };
  }

  /** Answers for an insertPasskey that succeeds, overridable per statement. */
  function registrationReplies(overrides: Partial<Record<string, Reply>> = {}) {
    return (sql: string): Reply => {
      for (const [needle, answer] of Object.entries(overrides)) if (sql.includes(needle)) return answer as Reply;
      if (sql.includes("FROM accounts")) return { rows: [{ session_version: 3 }] };
      if (sql.includes("COUNT(*)")) return { rows: [{ n: "1" }] };
      if (sql.includes("SELECT user_handle")) return { rows: [{ user_handle: "handle" }] };
      return {};
    };
  }

  test("initialize creates the passkey tables after accounts, with ON DELETE CASCADE and a BIGINT counter", async () => {
    await provider.initialize();
    const sql = (mockQuery.mock.calls as unknown[][])[0][0] as string;
    const order = [
      "CREATE TABLE IF NOT EXISTS accounts",
      "CREATE TABLE IF NOT EXISTS passkey_users",
      "CREATE TABLE IF NOT EXISTS passkey_credentials",
      "CREATE TABLE IF NOT EXISTS passkey_spent_challenges",
    ];
    const positions = order.map((fragment) => sql.indexOf(fragment));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(sql).toContain("REFERENCES accounts(email) ON DELETE CASCADE");
    expect(sql).toContain("REFERENCES passkey_users(account_email) ON DELETE CASCADE");
    expect(sql).toMatch(/sign_count\s+BIGINT NOT NULL/);
    // PostgreSQL checks table ownership before it honours IF NOT EXISTS on CREATE INDEX, so the
    // table DDL carries no index: an app user that does not own a DBA-created table would fail.
    expect(sql).not.toContain("CREATE INDEX");
  });

  test("initialize creates only the passkey indexes the schema lacks", async () => {
    const lookup =
      "SELECT index_name FROM unnest($1::text[]) AS wanted(index_name) WHERE to_regclass(index_name) IS NULL";
    const indexes = ["passkey_credentials_account", "passkey_spent_challenges_expiry"];

    // A DBA-managed schema that already has both: nothing but the lookup after the tables.
    await provider.initialize();
    const present = mockQuery.mock.calls as unknown[][];
    expect(present).toHaveLength(2);
    expect(present[1]).toEqual([lookup, [indexes]]);

    // A schema missing one creates exactly that one.
    mockQuery.mockClear();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: [{ index_name: "passkey_spent_challenges_expiry" }] });
    const partial = new PostgresStorageProvider("postgresql://localhost:5432/test");
    await partial.initialize();
    await partial.close();
    expect((mockQuery.mock.calls as unknown[][]).map((call) => call[0])).toEqual([
      expect.stringContaining("CREATE TABLE IF NOT EXISTS user_storage"),
      lookup,
      "CREATE INDEX IF NOT EXISTS passkey_spent_challenges_expiry ON passkey_spent_challenges (expires_at)",
    ]);

    // A fresh schema creates both, in order.
    mockQuery.mockClear();
    mockQuery.mockResolvedValueOnce({ rows: [] });
    mockQuery.mockResolvedValueOnce({ rows: indexes.map((index_name) => ({ index_name })) });
    const fresh = new PostgresStorageProvider("postgresql://localhost:5432/test");
    await fresh.initialize();
    await fresh.close();
    expect((mockQuery.mock.calls as unknown[][]).slice(2).map((call) => call[0])).toEqual([
      "CREATE INDEX IF NOT EXISTS passkey_credentials_account ON passkey_credentials (account_email)",
      "CREATE INDEX IF NOT EXISTS passkey_spent_challenges_expiry ON passkey_spent_challenges (expires_at)",
    ]);
  });

  test("a missing privilege during initialize names the tables, the privileges and the manual DDL", async () => {
    const denied = Object.assign(new Error("permission denied for schema public"), { code: "42501" });
    const errorSpy = spyOn(logger, "error").mockImplementation(() => {});
    try {
      mockQuery.mockRejectedValueOnce(denied);
      const failure = await provider.initialize().then(
        () => null,
        (error: unknown) => error as Error,
      );
      expect(failure?.message).toBe(
        "PostgreSQL storage cannot create or check its tables: the user in STORAGE_POSTGRES_URL lacks a privilege. It needs CREATE on the schema, and REFERENCES on accounts to create the passkey tables, or a DBA creates passkey_users, passkey_credentials and passkey_spent_challenges with their two indexes first (docs/STORAGE.md, Manual Table Creation).",
      );
      expect(failure?.cause).toBe(denied);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith("PostgreSQL storage initialization failed", denied, {
        provider: "postgres",
      });

      // Creating a missing index on a table the user does not own is the same refusal.
      const notOwner = Object.assign(new Error("must be owner of table passkey_credentials"), { code: "42501" });
      mockQuery.mockResolvedValueOnce({ rows: [] });
      mockQuery.mockResolvedValueOnce({ rows: [{ index_name: "passkey_credentials_account" }] });
      mockQuery.mockRejectedValueOnce(notOwner);
      const indexFailure = await new PostgresStorageProvider("postgresql://localhost:5432/test").initialize().then(
        () => null,
        (error: unknown) => error as Error,
      );
      expect(indexFailure?.message).toBe(failure?.message as string);
      expect(indexFailure?.cause).toBe(notOwner);

      // Any other driver error is rethrown as it came.
      const other = Object.assign(new Error("relation is broken"), { code: "XX000" });
      mockQuery.mockRejectedValueOnce(other);
      await expect(new PostgresStorageProvider("postgresql://localhost:5432/test").initialize()).rejects.toBe(other);
    } finally {
      errorSpy.mockRestore();
    }
  });

  test("the transaction helper commits, rolls back and releases, and returns the run's value", async () => {
    await provider.initialize();
    const committed = scriptedClient((sql) => (sql.includes("DELETE FROM passkey_credentials") ? { rowCount: 2 } : {}));
    expect(await provider.updateAccount(ACCOUNT, { expected: ACCOUNT, clearPasskeys: true })).toBe(2);
    expect(committed.sql()[0]).toBe("BEGIN");
    expect(committed.sql().at(-1)).toBe("COMMIT");
    expect(committed.release).toHaveBeenCalledTimes(1);

    const failure = new Error("statement refused");
    const rolledBack = scriptedClient((sql) => (sql.includes("UPDATE accounts") ? failure : {}));
    await expect(provider.updateAccount(ACCOUNT, { expected: ACCOUNT })).rejects.toBe(failure);
    expect(rolledBack.sql()).toEqual(["BEGIN", expect.stringContaining("UPDATE accounts"), "ROLLBACK"]);
    expect(rolledBack.release).toHaveBeenCalledTimes(1);
  });

  test("updateAccount is conditional on the version it read", async () => {
    await provider.initialize();
    const read = { ...ACCOUNT, sessionVersion: 3, updatedAt: "2026-09-28T01:00:00.000Z" };
    const next = { ...read, disabled: true, sessionVersion: 4, updatedAt: "2026-09-28T02:00:00.000Z" };
    const applied = scriptedClient();
    expect(await provider.updateAccount(next, { expected: read })).toBe(0);
    const update = applied.statements[1];
    expect(update.sql).toMatch(/WHERE email = \$8 AND session_version = \$9 AND updated_at = \$10$/);
    expect(update.params.slice(4, 10)).toEqual([1, 4, next.updatedAt, next.email, 3, read.updatedAt]);
    expect(applied.sql()).toEqual(["BEGIN", update.sql, "COMMIT"]);

    const stale = scriptedClient((sql) => (sql.includes("UPDATE accounts") ? { rowCount: 0 } : {}));
    await expect(provider.updateAccount(next, { expected: read, clearPasskeys: true })).rejects.toBeInstanceOf(
      AccountWriteConflict,
    );
    expect(stale.sql().at(-1)).toBe("ROLLBACK");
    expect(stale.sql().some((sql) => sql.includes("passkey_credentials"))).toBe(false);

    const cleared = scriptedClient((sql) => (sql.includes("DELETE FROM passkey_credentials") ? { rowCount: 3 } : {}));
    expect(await provider.updateAccount(next, { expected: read, clearPasskeys: true })).toBe(3);
    expect(cleared.sql()[1]).toContain("UPDATE accounts");
    expect(cleared.statements[2]).toEqual({
      sql: "DELETE FROM passkey_credentials WHERE account_email = $1",
      params: [next.email],
    });
  });

  test("insertAccount removes stale passkey rows in the same transaction", async () => {
    await provider.initialize();
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    warnSpy.mockClear();
    try {
      const stale = scriptedClient((sql) => (sql.includes("passkey_credentials") ? { rowCount: 2 } : {}));
      mockQuery.mockClear();
      await provider.insertAccount(ACCOUNT);
      // Purge first, then the insert, all on one client between BEGIN and COMMIT.
      expect(stale.statements).toEqual([
        { sql: "BEGIN", params: [] },
        { sql: "DELETE FROM passkey_credentials WHERE account_email = $1", params: [ACCOUNT.email] },
        { sql: "DELETE FROM passkey_users WHERE account_email = $1", params: [ACCOUNT.email] },
        {
          sql: expect.stringContaining("INSERT INTO accounts"),
          params: [
            ACCOUNT.email,
            ACCOUNT.passwordHash,
            ACCOUNT.role,
            ACCOUNT.totpSecret,
            ACCOUNT.totpPending,
            0,
            ACCOUNT.sessionVersion,
            ACCOUNT.createdAt,
            ACCOUNT.updatedAt,
          ],
        },
        { sql: "COMMIT", params: [] },
      ]);
      expect(stale.release).toHaveBeenCalledTimes(1);
      expect(mockQuery).not.toHaveBeenCalled();
      // The count of both tables' rows, never the email.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy).toHaveBeenCalledWith(
        "Removed passkey rows that an account deleted outside Studio left under a reused email; PostgreSQL deletes outside Studio must keep session_replication_role = origin",
        { provider: "postgres", removed: 3 },
      );

      // Nothing left behind: no warning.
      warnSpy.mockClear();
      scriptedClient((sql) => (sql.startsWith("DELETE") ? { rowCount: 0 } : {}));
      await provider.insertAccount(ACCOUNT);
      expect(warnSpy).not.toHaveBeenCalled();

      // A failed insert rolls the purge back with it and warns about nothing.
      const duplicate = new Error("duplicate key value violates unique constraint");
      const refused = scriptedClient((sql) => (sql.includes("INSERT INTO accounts") ? duplicate : {}));
      await expect(provider.insertAccount(ACCOUNT)).rejects.toBe(duplicate);
      expect(refused.sql().at(-1)).toBe("ROLLBACK");
      expect(refused.release).toHaveBeenCalledTimes(1);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("insertPasskey locks the account row before any passkey statement", async () => {
    await provider.initialize();
    const client = scriptedClient(registrationReplies());
    await provider.insertPasskey(registration());
    expect(client.statements[1]).toEqual({
      sql: "SELECT session_version FROM accounts WHERE email = $1 FOR UPDATE",
      params: [ACCOUNT.email],
    });
    expect(client.sql().at(-1)).toBe("COMMIT");
    const credential = client.statements.find((statement) => statement.sql.includes("INSERT INTO passkey_credentials"));
    expect(credential?.sql).toContain("$5::bigint");
    expect(credential?.params).toEqual([
      PASSKEY.id,
      "cred",
      ACCOUNT.email,
      "pk",
      0,
      '["internal","hybrid"]',
      1,
      0,
      "studio.example.com",
      "Passkey",
      PASSKEY.createdAt,
      null,
    ]);
  });

  test("insertPasskey maps each refusal to its conflict and rolls back", async () => {
    await provider.initialize();
    const cases: [Partial<Record<string, Reply>>, string][] = [
      [{ "FROM accounts": { rows: [] } }, "account_missing"],
      [{ "FROM accounts": { rows: [{ session_version: 4 }] } }, "session_changed"],
      [{ "INSERT INTO passkey_spent_challenges": { rowCount: 0 } }, "challenge_spent"],
      [{ "COUNT(*)": { rows: [{ n: "20" }] } }, "passkey_limit"],
      [{ "SELECT user_handle": { rows: [{ user_handle: "other" }] } }, "user_handle_changed"],
      [{ "INSERT INTO passkey_credentials": { rowCount: 0 } }, "credential_registered"],
    ];
    for (const [overrides, reason] of cases) {
      const client = scriptedClient(registrationReplies(overrides));
      // oxlint-disable-next-line no-await-in-loop -- each case replaces the pool client, so they run in turn.
      const failure = await provider.insertPasskey(registration()).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PasskeyRegistrationConflict);
      expect((failure as PasskeyRegistrationConflict).reason).toBe(reason as PasskeyRegistrationConflict["reason"]);
      expect(client.sql().at(-1)).toBe("ROLLBACK");
    }
  });

  test("every counter parameter is cast to bigint", async () => {
    await provider.initialize();
    const client = scriptedClient();
    await provider.recordPasskeySignIn({
      id: PASSKEY.id,
      signCount: 3000000000,
      backupState: true,
      usedAt: "2026-09-28T00:05:00.000Z",
      challenge: CHALLENGE,
      purgeSpentBefore: PURGE_BEFORE,
    });
    expect(client.statements[1]).toEqual({
      sql: "DELETE FROM passkey_spent_challenges WHERE expires_at < $1",
      params: [PURGE_BEFORE],
    });
    const update = client.statements.find((statement) => statement.sql.startsWith("UPDATE passkey_credentials"));
    expect(update?.sql).toBe(
      "UPDATE passkey_credentials SET sign_count = $1::bigint, backup_state = $2, last_used_at = $3 WHERE id = $4 AND ((sign_count = 0 AND $1::bigint = 0) OR sign_count < $1::bigint)",
    );
    expect(update?.params).toEqual([3000000000, 1, "2026-09-28T00:05:00.000Z", PASSKEY.id]);
    expect(client.sql().at(-1)).toBe("COMMIT");
  });

  test("recordPasskeySignIn maps each refusal to its conflict", async () => {
    await provider.initialize();
    const write = {
      id: PASSKEY.id,
      signCount: 5,
      backupState: false,
      usedAt: "2026-09-28T00:05:00.000Z",
      challenge: CHALLENGE,
      purgeSpentBefore: PURGE_BEFORE,
    };
    const cases: [(sql: string) => Reply, string][] = [
      [(sql) => (sql.startsWith("INSERT INTO passkey_spent_challenges") ? { rowCount: 0 } : {}), "challenge_spent"],
      [
        (sql) =>
          sql.startsWith("UPDATE") ? { rowCount: 0 } : sql.startsWith("SELECT 1") ? { rows: [{ "?column?": 1 }] } : {},
        "counter_not_increased",
      ],
      [(sql) => (sql.startsWith("UPDATE") ? { rowCount: 0 } : {}), "credential_missing"],
    ];
    for (const [reply, reason] of cases) {
      const client = scriptedClient(reply);
      // oxlint-disable-next-line no-await-in-loop -- each case replaces the pool client, so they run in turn.
      const failure = await provider.recordPasskeySignIn(write).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure).toBeInstanceOf(PasskeySignInConflict);
      expect((failure as PasskeySignInConflict).reason).toBe(reason as PasskeySignInConflict["reason"]);
      expect(client.sql().at(-1)).toBe("ROLLBACK");
    }
  });

  test("deletePasskey updates the account before it deletes the credential", async () => {
    await provider.initialize();
    const write = {
      email: ACCOUNT.email,
      id: PASSKEY.id,
      expectedSessionVersion: 3,
      nextSessionVersion: 4,
      updatedAt: "2026-09-28T00:05:00.000Z",
    };
    const applied = scriptedClient();
    await provider.deletePasskey(write);
    expect(applied.statements.slice(1, 3)).toEqual([
      {
        sql: "UPDATE accounts SET session_version = $1, updated_at = $2 WHERE email = $3 AND session_version = $4",
        params: [4, write.updatedAt, ACCOUNT.email, 3],
      },
      {
        sql: "DELETE FROM passkey_credentials WHERE id = $1 AND account_email = $2",
        params: [PASSKEY.id, ACCOUNT.email],
      },
    ]);
    expect(applied.sql().at(-1)).toBe("COMMIT");

    const stale = scriptedClient((sql) => (sql.startsWith("UPDATE accounts") ? { rowCount: 0 } : {}));
    const staleFailure = await provider.deletePasskey(write).then(
      () => null,
      (error: unknown) => error,
    );
    expect(staleFailure).toBeInstanceOf(PasskeyRemovalConflict);
    expect((staleFailure as PasskeyRemovalConflict).reason).toBe("session_changed");
    expect(stale.sql().some((sql) => sql.startsWith("DELETE"))).toBe(false);
    expect(stale.sql().at(-1)).toBe("ROLLBACK");

    const missing = scriptedClient((sql) => (sql.startsWith("DELETE") ? { rowCount: 0 } : {}));
    const missingFailure = await provider.deletePasskey(write).then(
      () => null,
      (error: unknown) => error,
    );
    expect((missingFailure as PasskeyRemovalConflict).reason).toBe("credential_missing");
    expect(missing.sql().at(-1)).toBe("ROLLBACK");
  });

  test("countPasskeys reads bigint counts as numbers", async () => {
    await provider.initialize();
    mockQuery.mockResolvedValueOnce({
      rows: [
        { account_email: ACCOUNT.email, n: "3" },
        { account_email: "bob@example.com", n: "1" },
      ],
    });
    const counts = await provider.countPasskeys();
    expect(counts).toEqual(
      new Map([
        [ACCOUNT.email, 3],
        ["bob@example.com", 1],
      ]),
    );
    expect((mockQuery.mock.calls as unknown[][]).at(-1)?.[0]).toBe(
      "SELECT account_email, COUNT(*) AS n FROM passkey_credentials GROUP BY account_email",
    );
  });

  test("passkey reads map bigint rows and bind the email or credential ID", async () => {
    await provider.initialize();
    mockQuery.mockClear();
    mockQuery.mockResolvedValueOnce({ rows: [PASSKEY_ROW] });
    expect(await provider.listPasskeys(ACCOUNT.email)).toEqual([{ ...PASSKEY, signCount: 3000000000 }]);
    const [listSql, listParams] = (mockQuery.mock.calls as unknown[][])[0];
    expect(listSql).toContain("WHERE account_email = $1 ORDER BY created_at, id");
    expect(listParams).toEqual([ACCOUNT.email]);

    mockQuery.mockResolvedValueOnce({ rows: [{ user_handle: "handle" }] });
    expect(await provider.getPasskeyUserHandle(ACCOUNT.email)).toBe("handle");
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await provider.getPasskeyUserHandle("missing@example.com")).toBeNull();

    mockQuery.mockResolvedValueOnce({ rows: [{ ...PASSKEY_ROW, user_handle: "handle" }] });
    expect(await provider.findPasskey("cred")).toEqual({
      passkey: { ...PASSKEY, signCount: 3000000000 },
      userHandle: "handle",
    });
    const [findSql, findParams] = (mockQuery.mock.calls as unknown[][])[3];
    expect(findSql).toContain("JOIN passkey_users u ON u.account_email = c.account_email");
    expect(findSql).toContain("WHERE c.credential_id = $1");
    expect(findParams).toEqual(["cred"]);
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await provider.findPasskey("unknown")).toBeNull();
  });

  test("renamePasskey reports whether a passkey of that account changed", async () => {
    await provider.initialize();
    mockQuery.mockClear();
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    expect(await provider.renamePasskey(ACCOUNT.email, PASSKEY.id, "Laptop")).toBe(true);
    expect((mockQuery.mock.calls as unknown[][])[0]).toEqual([
      "UPDATE passkey_credentials SET name = $1 WHERE id = $2 AND account_email = $3",
      ["Laptop", PASSKEY.id, ACCOUNT.email],
    ]);
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    expect(await provider.renamePasskey(ACCOUNT.email, "other", "Laptop")).toBe(false);
  });
});
