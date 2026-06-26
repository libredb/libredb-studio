import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import type { TableRelations } from "@/lib/db/types";
import {
  QueryError,
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

// NOTE: mocks are defined inline (not in a shared helper) on purpose. bun's
// mock.module() is scoped per test FILE that calls it; moving these into a
// helper breaks re-application when another file in the same (non-isolated)
// process also mocks @/lib/db. See CLAUDE.md "Coverage isolation".

type AugmentedProvider = ReturnType<typeof createMockProvider> & {
  getSchemaRelations?: ReturnType<typeof mock>;
};

const mockProvider = createMockProvider() as AugmentedProvider;
const mockGetOrCreateProvider = mock(async () => mockProvider);

const mockGetSession = mock(async () => ({ role: "admin", username: "admin" }) as unknown);
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

mock.module("@/lib/db", () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mock(),
  removeProvider: mock(),
  clearProviderCache: mock(),
  getProviderCacheStats: mock(),
  QueryError,
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
  BaseDatabaseProvider: class {},
}));

const { POST } = await import("@/app/api/db/schema/relations/route");

const validConnection = {
  id: "test-1",
  name: "Test DB",
  type: "postgres",
  host: "localhost",
  port: 5432,
  database: "testdb",
};

const relations: TableRelations[] = [
  {
    name: "orders",
    foreignKeys: [{ columnName: "user_id", referencedTable: "users", referencedColumn: "id" }],
    indexes: [{ name: "orders_pkey", columns: ["id"], unique: true }],
  },
];

describe("POST /api/db/schema/relations", () => {
  beforeEach(() => {
    mockGetOrCreateProvider.mockClear();
    mockGetSession.mockClear();
    mockProvider.getSchemaRelations = mock(async () => relations);
  });

  test("returns 200 with relations when the provider implements getSchemaRelations()", async () => {
    const req = createMockRequest("/api/db/schema/relations", { method: "POST", body: validConnection });

    const res = await POST(req as never);
    const data = await parseResponseJSON<TableRelations[]>(res);

    expect(res.status).toBe(200);
    expect(Array.isArray(data)).toBe(true);
    expect(data[0].name).toBe("orders");
    expect(data[0].foreignKeys[0].referencedTable).toBe("users");
    expect(data[0].indexes[0].unique).toBe(true);
    expect(mockProvider.getSchemaRelations).toHaveBeenCalledTimes(1);
  });

  test("returns 200 with [] when the provider has no getSchemaRelations()", async () => {
    // Providers without relation introspection must yield an empty list, never
    // an error — the table tree stays usable without FK/index data.
    delete mockProvider.getSchemaRelations;

    const req = createMockRequest("/api/db/schema/relations", { method: "POST", body: validConnection });

    const res = await POST(req as never);
    const data = await parseResponseJSON<TableRelations[]>(res);

    expect(res.status).toBe(200);
    expect(data).toEqual([]);
  });

  test("returns 400 for empty request body", async () => {
    const req = new Request("http://localhost:3000/api/db/schema/relations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Empty request body");
  });

  test("returns 400 for an empty JSON object body", async () => {
    const req = createMockRequest("/api/db/schema/relations", { method: "POST", body: {} });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Empty request body");
  });

  test("returns 401 when there is no session", async () => {
    mockGetSession.mockResolvedValueOnce(null as unknown as { role: string; username: string });

    const req = createMockRequest("/api/db/schema/relations", { method: "POST", body: validConnection });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(401);
    expect(data.error).toContain("Authentication required");
    expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(0);
  });

  test("returns 400 when connection has no type field", async () => {
    const req = createMockRequest("/api/db/schema/relations", {
      method: "POST",
      body: { host: "localhost", database: "testdb" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("required");
  });

  test("returns 503 for ConnectionError", async () => {
    mockGetOrCreateProvider.mockRejectedValueOnce(new ConnectionError("Connection refused"));

    const req = createMockRequest("/api/db/schema/relations", { method: "POST", body: validConnection });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(503);
    expect(data.error).toContain("Connection refused");
    expect(data.code).toBe("CONNECTION_ERROR");
  });

  test("returns 500 when getSchemaRelations() throws (timeout/internal)", async () => {
    // The relations query is the heavy one and may time out; the route surfaces
    // the error. The client treats this as best-effort and keeps the table list.
    mockProvider.getSchemaRelations = mock(async () => {
      throw new DatabaseError("canceling statement due to statement timeout", "postgres", "INTERNAL_ERROR");
    });

    const req = createMockRequest("/api/db/schema/relations", { method: "POST", body: validConnection });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(500);
    expect(data.code).toBe("INTERNAL_ERROR");
  });
});
