import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../helpers/mock-next";
import { createMockProvider } from "../helpers/mock-provider";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { getServerAuditBuffer } from "@/lib/audit";

/**
 * Threat: a non-string value reaching the authoritative stdout audit line unbounded, breaking the
 * fixed-shape `libredb.audit.v1` contract. `sanitizeAuditInput` (src/lib/audit.ts) sweeps only
 * `typeof value === "string"`, so a field that is supposed to be a string but isn't at runtime -
 * because a route destructured it straight out of an untyped `await request.json()` body - was
 * skipped by the sweep entirely and copied verbatim by `toAuditLine`.
 *
 * `POST /api/db/maintenance` is the real call site: it destructures `target` from the request body
 * and passes it through `emitAuditEvent` as the AuditEvent's `target` field (which becomes `route`
 * on the stdout line). Deliberately NOT mocking `@/lib/audit` here - the whole point is to exercise
 * the real sanitizer against the real route.
 */

const mockProvider = createMockProvider();
const mockGetOrCreateProvider = mock(async () => mockProvider as never);
const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);

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
  createDatabaseProvider: mock(async () => mockProvider),
  removeProvider: mock(async () => {}),
  clearProviderCache: mock(async () => {}),
  getProviderCacheStats: mock(() => ({ size: 0, connections: [] })),
}));

const { POST } = await import("@/app/api/db/maintenance/route");

const validConnection = {
  id: "test-1",
  name: "Test DB",
  type: "postgres",
  host: "localhost",
  port: 5432,
  database: "testdb",
};

describe("POST /api/db/maintenance audit type safety", () => {
  beforeEach(() => {
    clearRateLimitState();
    getServerAuditBuffer().clear();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(
      async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
    );
  });

  test("a non-string target reaches the audit line as a bounded string, not a nested object", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      const req = createMockRequest("/api/db/maintenance", {
        method: "POST",
        body: {
          type: "vacuum",
          // A shape the AuditEvent type never produces but nothing at runtime rejects - `body` from
          // `await request.json()` is untyped, so this reaches emitAuditEvent's `target` field as-is.
          target: { nested: { token: "s3cr3t-value" } },
          connection: validConnection,
        },
      });

      const res = await POST(req as never);
      await parseResponseJSON(res);

      expect(spy).toHaveBeenCalledTimes(1);
      const line = JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>;

      // The stdout line must never carry an object where the schema promises a string, and must
      // stay within the same bound every other free-text field is held to.
      expect(typeof line.route).toBe("string");
      expect((line.route as string).length).toBeLessThanOrEqual(254);

      // The buffer the admin UI serves shares the same sanitized event - not a second, looser rule.
      const buffered = getServerAuditBuffer().getAll();
      expect(buffered).toHaveLength(1);
      expect(typeof buffered[0].target).toBe("string");
    } finally {
      spy.mockRestore();
    }
  });
});
