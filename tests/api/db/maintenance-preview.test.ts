import { describe, test, expect, mock, beforeEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { createMockProvider } from "../../helpers/mock-provider";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import type { MaintenanceOperation, MaintenancePreview } from "@/lib/db/types";
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
import { SYNTHETIC_ENTITY_CAPABILITIES, SYNTHETIC_PREVIEW } from "../../fixtures/maintenance-entity-operations";

/**
 * `POST /api/db/maintenance/preview` (spec 3.11, E36): an admin-only read beside the maintenance route. It makes the
 * maintenance route's request checks, requires a target because a preview is per object, and calls the provider's
 * `previewMaintenance` and nothing else. The provider is the synthetic declaration of
 * `tests/fixtures/maintenance-entity-operations.ts`; no shipped provider declares a preview.
 */

// ─── Mocks, the maintenance route's own set ─────────────────────────────────
const mockProvider = createMockProvider({ capabilities: SYNTHETIC_ENTITY_CAPABILITIES });
const declaredCapabilities = mockProvider.getCapabilities();
const mockPreviewMaintenance = mock(
  async (_type: MaintenanceOperation, _path: readonly string[]): Promise<MaintenancePreview> => SYNTHETIC_PREVIEW,
);
const mockGetOrCreateProvider = mock(async () => mockProvider as never);
const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);
const mockAuditPush = mock((_event?: unknown) => ({}));

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

mock.module("@/lib/audit", () => ({
  getServerAuditBuffer: () => ({ push: mockAuditPush }),
  emitAuditEvent: (event: Record<string, unknown>) => mockAuditPush(event as never),
  AuditRingBuffer: class {},
  loadAuditFromStorage: () => [],
  saveAuditToStorage: () => {},
}));

mock.module("@/lib/db", () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mock(async () => mockProvider),
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

const { POST } = await import("@/app/api/db/maintenance/preview/route");

// ─── Helpers ────────────────────────────────────────────────────────────────
const validConnection = {
  id: "test-1",
  name: "Test DB",
  type: "postgres",
  host: "localhost",
  port: 5432,
  database: "testdb",
};

/** Every provider method that was called, by name: an admin's preview may call `getCapabilities` and `previewMaintenance` only. */
function calledMethods(): string[] {
  return Object.entries(mockProvider)
    .filter(
      ([, value]) =>
        typeof value === "function" && "mock" in value && (value as ReturnType<typeof mock>).mock.calls.length > 0,
    )
    .map(([name]) => name)
    .sort();
}

function preview(body: Record<string, unknown>): Promise<Response> {
  return POST(createMockRequest("/api/db/maintenance/preview", { method: "POST", body }) as never);
}

async function errorOf(response: Response): Promise<string> {
  return (await parseResponseJSON<{ error: string }>(response)).error;
}

describe("POST /api/db/maintenance/preview", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider as never);
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(() => declaredCapabilities);
    mockPreviewMaintenance.mockImplementation(async () => SYNTHETIC_PREVIEW);
    (mockProvider as { previewMaintenance?: unknown }).previewMaintenance = mockPreviewMaintenance;
    mockGetSession.mockClear();
    mockGetOrCreateProvider.mockClear();
    mockAuditPush.mockClear();
    for (const value of Object.values(mockProvider)) {
      if (typeof value === "function" && "mock" in value) (value as ReturnType<typeof mock>).mockClear();
    }
  });

  test("a user gets 403 and a permission_denied audit row, and no provider is opened", async () => {
    mockGetSession.mockImplementation(async () => ({ role: "user", username: "bob" }));

    const res = await preview({ type: "compact", target: "orders", container: "app", connection: validConnection });

    expect(res.status).toBe(403);
    expect(await errorOf(res)).toContain("Admin access required");
    expect(mockAuditPush).toHaveBeenCalledTimes(1);
    expect(mockAuditPush.mock.calls[0]![0]).toMatchObject({
      type: "permission_denied",
      reason: "insufficient_role",
      user: "bob",
      target: "POST /api/db/maintenance/preview",
    });
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
    expect(calledMethods()).toEqual([]);
  });

  test("no session gets the guard's 401", async () => {
    mockGetSession.mockImplementation(async () => null);

    const res = await preview({ type: "compact", target: "orders", connection: validConnection });

    expect(res.status).toBe(401);
    expect(await errorOf(res)).toContain("Authentication required");
    expect(calledMethods()).toEqual([]);
  });

  test("an admin reads the preview: the provider is asked once, with the object's path, and nothing else runs", async () => {
    const res = await preview({ type: "compact", target: "orders", container: "app", connection: validConnection });

    expect(res.status).toBe(200);
    expect(await parseResponseJSON<{ preview: MaintenancePreview }>(res)).toEqual({ preview: SYNTHETIC_PREVIEW });
    expect(mockPreviewMaintenance).toHaveBeenCalledTimes(1);
    expect(mockPreviewMaintenance).toHaveBeenCalledWith("compact", ["app", "orders"]);
    expect(calledMethods()).toEqual(["getCapabilities", "previewMaintenance"]);
    // A preview changes nothing, so it writes no maintenance row.
    expect(mockAuditPush).not.toHaveBeenCalled();
  });

  test.each<[string, Record<string, unknown>]>([
    ["absent", {}],
    ["empty", { container: "" }],
  ])("a container that is %s maps to the object alone", async (_label, container) => {
    const res = await preview({ type: "compact", target: "orders", ...container, connection: validConnection });

    expect(res.status).toBe(200);
    expect(mockPreviewMaintenance).toHaveBeenCalledWith("compact", ["orders"]);
  });

  test.each<[string, Record<string, unknown>, string]>([
    ["a missing type", { target: "orders" }, "Maintenance type is required"],
    ["an object container", { type: "compact", target: "orders", container: { schema: "app" } }, "container"],
    ["a number container", { type: "compact", target: "orders", container: 7 }, "container"],
    ["an array container", { type: "compact", target: "orders", container: ["app"] }, "container"],
    ["a null container", { type: "compact", target: "orders", container: null }, "container"],
    ["a false container", { type: "compact", target: "orders", container: false }, "container"],
    ["an empty target", { type: "compact", target: "" }, "target"],
    ["a missing target", { type: "compact" }, "target"],
    ["a non-string target", { type: "compact", target: 7 }, "target"],
  ])("%s answers 400 before any provider is opened", async (_label, fields, fragment) => {
    const res = await preview({ ...fields, connection: validConnection });

    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain(fragment);
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
    expect(calledMethods()).toEqual([]);
  });

  test("an operation the provider does not declare answers 400 and previews nothing", async () => {
    const res = await preview({ type: "optimize", target: "orders", connection: validConnection });

    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain("not supported");
    expect(calledMethods()).toEqual(["getCapabilities"]);
  });

  test("an engine with no maintenance answers 400 and previews nothing", async () => {
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(() => ({
      ...declaredCapabilities,
      supportsMaintenance: false,
    }));

    const res = await preview({ type: "compact", target: "orders", connection: validConnection });

    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain("not supported");
    expect(mockPreviewMaintenance).not.toHaveBeenCalled();
  });

  test("a whole-database operation answers the placement 400 in the provider's words", async () => {
    const res = await preview({ type: "defragment", target: "orders", connection: validConnection });

    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe(
      "Defragment takes no target on this database: it runs over the whole database. Omit 'target'.",
    );
    expect(calledMethods()).toEqual(["getCapabilities"]);
  });

  test.each<[string, string]>([
    ["a typed-target operation", "disarm"],
    ["an operation with no confirmation", "analyze"],
  ])("%s whose spec declares no preview answers 400", async (_label, type) => {
    const res = await preview({ type, target: "orders", connection: validConnection });

    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("This operation has no preview");
    expect(calledMethods()).toEqual(["getCapabilities"]);
  });

  test("a provider that declares a preview but lacks previewMaintenance answers 400", async () => {
    delete (mockProvider as { previewMaintenance?: unknown }).previewMaintenance;

    const res = await preview({ type: "compact", target: "orders", connection: validConnection });

    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("This operation has no preview");
  });

  test("an object the provider cannot find is refused with its sentence, after exactly one preview read", async () => {
    mockPreviewMaintenance.mockImplementation(async () => {
      throw new QueryError("No object named orders in app", "postgres");
    });

    const res = await preview({ type: "compact", target: "orders", container: "app", connection: validConnection });

    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain("No object named orders in app");
    expect(mockPreviewMaintenance).toHaveBeenCalledTimes(1);
    expect(calledMethods()).toEqual(["getCapabilities", "previewMaintenance"]);
  });

  test("a provider failure answers what it maps to", async () => {
    mockPreviewMaintenance.mockImplementation(async () => {
      throw new DatabaseError("Internal preview failure", "postgres", "DATABASE_ERROR");
    });

    const res = await preview({ type: "compact", target: "orders", connection: validConnection });

    expect(res.status).toBe(500);
    expect(await errorOf(res)).toContain("Internal preview failure");
  });

  test("a missing connection answers 400", async () => {
    const res = await preview({ type: "compact", target: "orders" });

    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain("required");
    expect(calledMethods()).toEqual([]);
  });
});
