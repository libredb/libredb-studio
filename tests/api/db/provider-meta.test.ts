import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import { clearRateLimitState } from "@/lib/api/rate-limit";
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
} from "@/lib/db/errors";
import { mapDatabaseError } from "@/lib/db/map-database-error";
import { withheldErrorMessage } from "@/lib/db/operations/provider-text";
import type { DatabaseProvider, ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { servedEngineRecord } from "@/lib/db/server-catalog";

const { createDatabaseProvider, readProviderDeclarations: realReadProviderDeclarations } = await import(
  "@/lib/db/factory"
);

// ─── Mock declarations ──────────────────────────────────────────────────────
// The route reads a provider's declarations through readProviderDeclarations, which hands back data: the mock's
// answer is what the real one reads off `provider`, with supportsQueryCancel off the provider's surface.
const mockProvider = createMockProvider();
const declarationsOf = (provider: ReturnType<typeof createMockProvider>) => ({
  capabilities: provider.getCapabilities(),
  labels: provider.getLabels(),
  supportsQueryCancel: typeof (provider as { cancelQuery?: unknown }).cancelQuery === "function",
});
const mockReadProviderDeclarations = mock(async () => declarationsOf(mockProvider));

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

// ─── Mock auth + seed resolution BEFORE importing the route ─────────────────
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
    resolveServedConnection: mock(async (body: Record<string, unknown>) => {
      if (!body.connection && !body.connectionId) {
        throw new SeedConnectionError("Either connection or connectionId is required", 400);
      }
      const connection = body.connection as { type: string };
      return { connection, engine: servedEngineRecord(connection.type) };
    }),
    SeedConnectionError,
  };
});

// ─── Mock @/lib/db BEFORE importing the route ───────────────────────────────
mock.module("@/lib/db", () => ({
  getOrCreateProvider: mock(),
  readProviderDeclarations: mockReadProviderDeclarations,
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
  mapDatabaseError,
  BaseDatabaseProvider: class {},
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import("@/app/api/db/provider-meta/route");

// ─── Fixtures ───────────────────────────────────────────────────────────────
const validConnection = {
  id: "test-1",
  name: "Test DB",
  type: "postgres",
  host: "localhost",
  port: 5432,
  database: "testdb",
};

// ─── Tests ──────────────────────────────────────────────────────────────────
describe("POST /api/db/provider-meta", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockReadProviderDeclarations.mockClear();
    mockReadProviderDeclarations.mockImplementation(async () => declarationsOf(mockProvider));
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
  });

  test("an error that holds the connection's credential keeps its status and code and holds none of it", async () => {
    const password = crypto.randomUUID();
    const connection = { ...validConnection, password };
    const send = () =>
      POST(createMockRequest("/api/db/provider-meta", { method: "POST", body: { connection } }) as never);
    mockReadProviderDeclarations.mockRejectedValueOnce(
      new DatabaseConfigError(`the file ${password} is not a database`, "postgres"),
    );
    const withheld = await send();
    const body = await parseResponseJSON<Record<string, unknown>>(withheld);
    expect(withheld.status).toBe(400);
    expect(body).toMatchObject({ code: "CONFIG_ERROR", error: withheldErrorMessage("DatabaseConfigError") });
    expect(JSON.stringify(body)).not.toContain(password);

    mockReadProviderDeclarations.mockRejectedValueOnce(
      new DatabaseConfigError("the file is not a database", "postgres"),
    );
    const clean = await send();
    expect(clean.status).toBe(400);
    expect(await parseResponseJSON(clean)).toMatchObject({ code: "CONFIG_ERROR", error: "the file is not a database" });
  });

  test("returns 401 when no session exists", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const req = createMockRequest("/api/db/provider-meta", {
      method: "POST",
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(401);
    expect(data.error).toContain("Authentication required");
  });

  test("returns 400 when body is an empty object", async () => {
    const req = createMockRequest("/api/db/provider-meta", {
      method: "POST",
      body: {},
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Empty");
  });

  test("returns 200 with capabilities and labels for valid connection", async () => {
    const req = createMockRequest("/api/db/provider-meta", {
      method: "POST",
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{
      capabilities: Record<string, unknown>;
      labels: Record<string, unknown>;
    }>(res);

    expect(res.status).toBe(200);
    expect(mockReadProviderDeclarations).toHaveBeenCalled();
    expect(data.capabilities).toBeDefined();
    expect(data.labels).toBeDefined();
    expect(data.capabilities.queryLanguage).toBe("sql");
    expect(data.labels.entityName).toBe("Table");
  });

  // The editor gates Cancel on this flag, and the cancel route refuses by the same check,
  // so the flag is read off the provider rather than declared by it (#1364).
  test("reports supportsQueryCancel from whether the provider implements cancelQuery", async () => {
    const read = async () => {
      const res = await POST(
        createMockRequest("/api/db/provider-meta", { method: "POST", body: validConnection }) as never,
      );
      return (await parseResponseJSON<{ capabilities: Record<string, unknown> }>(res)).capabilities;
    };

    expect((await read()).supportsQueryCancel).toBe(false);

    const cancellable = Object.assign(createMockProvider(), { cancelQuery: async () => true });
    mockReadProviderDeclarations.mockImplementation(async () => declarationsOf(cancellable));
    expect((await read()).supportsQueryCancel).toBe(true);
  });

  test("answers a tunnelled record's declarations without opening its tunnel", async () => {
    mockReadProviderDeclarations.mockImplementation(realReadProviderDeclarations as never);
    const res = await POST(
      createMockRequest("/api/db/provider-meta", {
        method: "POST",
        body: {
          ...validConnection,
          sshTunnel: { enabled: true, host: "bastion", port: 22, username: "jump", authMethod: "password" },
        },
      }) as never,
    );
    const data = await parseResponseJSON<{ capabilities: Record<string, unknown>; error?: string }>(res);

    expect(data.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(data.capabilities.queryLanguage).toBe("sql");
    expect(data.capabilities.supportsQueryCancel).toBe(true);
    expect(mockReadProviderDeclarations).toHaveBeenCalledTimes(1);
  });

  test("a masking exemption a provider declares that Studio's record does not hold never reaches the browser", async () => {
    mockReadProviderDeclarations.mockImplementation(realReadProviderDeclarations as never);
    const prototype = Object.getPrototypeOf(
      await createDatabaseProvider(validConnection as DatabaseConnection),
    ) as DatabaseProvider;
    const original = prototype.getCapabilities;
    const declaring = spyOn(prototype, "getCapabilities").mockImplementation(function (this: DatabaseProvider) {
      const capabilities: ProviderCapabilities = {
        ...original.call(this),
        maskingExemptColumns: {
          column: ".*",
          reason: "Every column of this engine is said to carry no personal data.",
        },
      };
      return capabilities;
    });
    try {
      const res = await POST(
        createMockRequest("/api/db/provider-meta", { method: "POST", body: validConnection }) as never,
      );
      const data = await parseResponseJSON<{ capabilities: Record<string, unknown>; error?: string }>(res);

      expect(data.error).toBeUndefined();
      expect(res.status).toBe(200);
      expect(data.capabilities.queryLanguage).toBe("sql");
      expect(Object.hasOwn(data.capabilities, "maskingExemptColumns")).toBe(false);
      expect(declaring).toHaveBeenCalled();
    } finally {
      declaring.mockRestore();
    }
  });

  test("returns 400 when body is empty", async () => {
    const req = new Request("http://localhost:3000/api/db/provider-meta", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("Empty");
  });

  test("returns 400 when connection has no type", async () => {
    const req = createMockRequest("/api/db/provider-meta", {
      method: "POST",
      body: { id: "test-1", name: "No Type" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    // The resolve's refusal of a connection that names no type, before anything is read.
    expect(res.status).toBe(400);
    expect([data.code, data.error]).toEqual([
      "PROVIDER_UNKNOWN",
      "This connection names no type, so no provider in this LibreDB Studio can open it.",
    ]);
    expect(mockReadProviderDeclarations).not.toHaveBeenCalled();
  });

  test("returns 503 for ConnectionError", async () => {
    mockReadProviderDeclarations.mockRejectedValueOnce(new ConnectionError("Connection refused"));

    const req = createMockRequest("/api/db/provider-meta", {
      method: "POST",
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(503);
    expect(data.error).toContain("Connection");
  });

  test("returns 500 for DatabaseError", async () => {
    mockReadProviderDeclarations.mockRejectedValueOnce(
      new DatabaseError("Internal failure", "postgres", "INTERNAL_ERROR"),
    );

    const req = createMockRequest("/api/db/provider-meta", {
      method: "POST",
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe("Internal failure");
    expect(data.code).toBe("INTERNAL_ERROR");
  });

  test("returns 500 for generic error", async () => {
    mockReadProviderDeclarations.mockRejectedValueOnce(new Error("Unexpected failure"));

    const req = createMockRequest("/api/db/provider-meta", {
      method: "POST",
      body: validConnection,
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ error: string }>(res);

    expect(res.status).toBe(500);
    expect(data.error).toBe("Unexpected failure");
  });
});
