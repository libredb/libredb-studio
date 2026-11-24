import { afterAll, beforeAll, describe, test, expect, mock, beforeEach, spyOn } from "bun:test";
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
  PermissionDeniedError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
} from "@/lib/db/errors";
import { mapDatabaseError } from "@/lib/db/map-database-error";
import { SYNTHETIC_ENTITY_CAPABILITIES, SYNTHETIC_PREVIEW } from "../../fixtures/maintenance-entity-operations";
import { PROVIDER_TEXT_WITHHELD, withheldErrorMessage } from "@/lib/db/operations/provider-text";
import { TIMEOUT_SENTENCE } from "@/lib/api/error-body";
import { errorKind } from "@/lib/db/error-record";
import { logger } from "@/lib/logger";
import { createHostCore, type HostCore } from "@/lib/provider-host/core/host-core";
import type { MaintenancePreviewRecord } from "@/lib/provider-host/core/maintenance";
import { forgetHostCore, hostCore, installHostCore } from "@/lib/provider-host/instance";

// The route previews through the process's host core (src/lib/provider-host/instance.ts), so this file composes its
// own.
beforeAll(() => installHostCore(createHostCore(), "test"));
afterAll(forgetHostCore);

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
/**
 * The provider the factory stand-in last built, whose capabilities the declarations read answers: a route's connected
 * checks and the session's maintenance then agree, as they do for every shipped provider.
 */
let lastBuilt: { getCapabilities(): unknown } = mockProvider;
const mockReadProviderDeclarations = mock(async (...args: unknown[]) => {
  void args;
  return { capabilities: lastBuilt.getCapabilities(), labels: {}, supportsQueryCancel: false };
});
const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "admin", username: "admin" }),
);
const mockAuditPush = mock((_event?: unknown) => ({}));

// The spread form, not a hand-written five-key stub: `src/lib/auth.ts` exports more
// names than such a stub carries, and only one of them is being replaced here (BACKLOG D85).
const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mockGetSession,
  readSession: mock(async () => {
    const s = await mockGetSession();
    return s ? { kind: "authenticated", session: s } : { kind: "anonymous" };
  }),
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
  getOrCreateProvider: async (...args: unknown[]) => {
    const built = await (mockGetOrCreateProvider as (...given: unknown[]) => Promise<{ getCapabilities(): unknown }>)(
      ...args,
    );
    lastBuilt = built;
    return built;
  },
  readProviderDeclarations: mockReadProviderDeclarations,
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
  mapDatabaseError,
}));

const { POST } = await import("@/app/api/db/maintenance/preview/route");

// ─── Helpers ────────────────────────────────────────────────────────────────
/**
 * An etcd connection: the route reads the engine facets row of the connection's type before the factory, so the
 * type is one whose row offers the synthetic declaration's `compact`, `defragment` and `disarm`. Its `analyze` is
 * offered by PostgreSQL's row, and the test that posts it says so.
 */
const validConnection = {
  id: "test-1",
  name: "Test DB",
  type: "etcd",
  host: "localhost",
  port: 2379,
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

  test.each<[string, string]>([
    ["null", "null"],
    ["an array", "[]"],
    ["a number", "7"],
    ["text that is not JSON", "{"],
  ])("a body that is %s answers 400 with a fixed sentence and opens no provider", async (_label, raw) => {
    const res = await POST(
      new Request("http://localhost:3000/api/db/maintenance/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: raw,
      }) as never,
    );

    expect(res.status).toBe(400);
    expect(await parseResponseJSON<{ error: string }>(res)).toEqual({ error: "Invalid request body" });
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
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
    expect(
      await parseResponseJSON<{ error: string; code: string; statusCode: number; kind: string; outcome: string }>(res),
    ).toEqual({
      error:
        '"optimize" is not a maintenance operation LibreDB Studio offers on etcd, which offers compact, defragment, disarm; no connection was opened and nothing was run.',
      code: "FACET_NOT_OFFERED",
      statusCode: 400,
      kind: "not-offered",
      outcome: "unknown",
    });
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
    expect(calledMethods()).toEqual([]);
  });

  test("an operation the engine does not offer is refused FACET_NOT_OFFERED before any provider is built", async () => {
    const res = await preview({
      type: "compact",
      target: "orders",
      connection: { ...validConnection, type: "kafka", port: 9092 },
    });

    expect(res.status).toBe(400);
    expect(
      await parseResponseJSON<{ error: string; code: string; statusCode: number; kind: string; outcome: string }>(res),
    ).toEqual({
      error:
        '"compact" is not a maintenance operation LibreDB Studio offers on Apache Kafka, which offers none; no connection was opened and nothing was run.',
      code: "FACET_NOT_OFFERED",
      statusCode: 400,
      kind: "not-offered",
      outcome: "unknown",
    });
    expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
    expect(calledMethods()).toEqual([]);
  });

  test("an engine with no maintenance answers 400 and previews nothing", async () => {
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(() => ({
      ...declaredCapabilities,
      supportsMaintenance: false,
    }));

    const res = await preview({ type: "compact", target: "orders", connection: validConnection });

    // The row offers compact on etcd, so the refusal comes from the connected server, after connect.
    expect(res.status).toBe(400);
    expect(
      await parseResponseJSON<{ error: string; code: string; statusCode: number; kind: string; outcome: string }>(res),
    ).toEqual({
      error:
        '"compact" is not a maintenance operation the etcd server this connection reaches accepts, which accepts none; nothing was run.',
      code: "FACET_NOT_OFFERED",
      statusCode: 400,
      kind: "not-offered",
      outcome: "unknown",
    });
    expect(mockGetOrCreateProvider).toHaveBeenCalledTimes(1);
    expect(mockPreviewMaintenance).not.toHaveBeenCalled();
  });

  test.each<[string, unknown]>([
    ["the number 5", 5],
    ["true", true],
    ["an object", {}],
    ["an array", []],
  ])(
    "a type that is not text is refused with a fixed sentence before any provider is built: %s",
    async (_label, type) => {
      const res = await preview({ type, target: "orders", connection: validConnection });

      expect(res.status).toBe(400);
      expect(await parseResponseJSON<{ error: string }>(res)).toEqual({
        error: '"type" must be a string naming a maintenance operation',
      });
      expect(mockGetOrCreateProvider).not.toHaveBeenCalled();
      expect(calledMethods()).toEqual([]);
    },
  );

  test("a whole-database operation answers the placement 400 in the provider's words", async () => {
    const res = await preview({ type: "defragment", target: "orders", connection: validConnection });

    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe(
      "Defragment takes no target on this database: it runs over the whole database. Omit 'target'.",
    );
    expect(calledMethods()).toEqual(["getCapabilities"]);
  });

  test.each<[string, string, string]>([
    ["a typed-target operation", "disarm", "etcd"],
    // etcd's row offers no analyze, so this one posts a connection whose row does.
    ["an operation with no confirmation", "analyze", "postgres"],
  ])("%s whose spec declares no preview answers 400", async (_label, type, engine) => {
    const res = await preview({ type, target: "orders", connection: { ...validConnection, type: engine } });

    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("This operation has no preview");
    expect(calledMethods()).toEqual(["getCapabilities"]);
  });

  test("a preview declared on an operation no row offers answers 400 and previews nothing", async () => {
    const specs = declaredCapabilities.maintenanceOperationSpecs ?? {};
    const compact = specs.compact;
    if (compact === undefined) throw new Error("the fixture declares no compact spec");
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(() => ({
      ...declaredCapabilities,
      maintenanceOperationSpecs: { ...specs, compact: { ...compact, perEntity: false, global: false } },
    }));

    const res = await preview({ type: "compact", target: "orders", connection: validConnection });

    expect(res.status).toBe(400);
    expect(await errorOf(res)).toBe("This operation has no preview");
    expect(mockPreviewMaintenance).not.toHaveBeenCalled();
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

  test("an error that holds the connection's credential keeps its status and code and holds none of it", async () => {
    const password = crypto.randomUUID();
    const connection = { ...validConnection, password };
    const send = () => preview({ type: "compact", target: "orders", container: "app", connection });
    mockPreviewMaintenance.mockImplementationOnce(async () => {
      throw new QueryError(`No object named orders for ${password}`, "postgres");
    });
    const withheld = await send();
    const body = await parseResponseJSON<Record<string, unknown>>(withheld);
    expect(withheld.status).toBe(400);
    expect(body).toMatchObject({ code: "QUERY_ERROR", error: withheldErrorMessage("QueryError") });
    expect(JSON.stringify(body)).not.toContain(password);

    mockPreviewMaintenance.mockImplementationOnce(async () => {
      throw new QueryError("No object named orders in app", "postgres");
    });
    const clean = await send();
    expect(clean.status).toBe(400);
    expect(await parseResponseJSON(clean)).toMatchObject({
      code: "QUERY_ERROR",
      error: "No object named orders in app",
    });
  });

  test("a preview's summary, refusal and note that hold the connection's credential answer the withheld sentence, and its facts as the provider answered them", async () => {
    const password = crypto.randomUUID();
    const connection = { ...validConnection, password };
    const send = () => preview({ type: "compact", target: "orders", container: "app", connection });
    const facts = [{ label: "Revision", value: "42" }];
    mockPreviewMaintenance.mockImplementationOnce(async () => ({
      summary: `Compacts the history of ${password}`,
      facts,
      refusal: `the server refused ${password}`,
      note: `read as ${password}`,
    }));
    const withheld = await send();
    const body = await parseResponseJSON<Record<string, unknown>>(withheld);
    expect(withheld.status).toBe(200);
    expect(body).toEqual({
      preview: {
        summary: PROVIDER_TEXT_WITHHELD,
        facts,
        refusal: PROVIDER_TEXT_WITHHELD,
        note: PROVIDER_TEXT_WITHHELD,
      },
    });
    expect(JSON.stringify(body)).not.toContain(password);

    const clean = { summary: "Compacts the history up to revision 42", facts, note: "as reported by the server" };
    mockPreviewMaintenance.mockImplementationOnce(async () => clean);
    expect(await parseResponseJSON(await send())).toEqual({ preview: clean });
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

describe("what the preview route answers today, which the host core keeps", () => {
  /** Each Studio error class a provider raises, and the status, code and retry hint its answer carries. */
  const STUDIO_ERRORS: readonly {
    readonly name: string;
    readonly raise: (text: string) => Error;
    readonly status: number;
    readonly code: string;
    readonly retryable?: true;
    readonly sentence?: string;
  }[] = [
    { name: "QueryError", raise: (text) => new QueryError(text, "etcd"), status: 400, code: "QUERY_ERROR" },
    {
      name: "ConnectionError",
      raise: (text) => new ConnectionError(text, "etcd"),
      status: 503,
      code: "CONNECTION_ERROR",
      retryable: true,
    },
    {
      name: "TimeoutError",
      raise: (text) => new TimeoutError(text, "etcd", 1000),
      status: 504,
      code: "TIMEOUT_ERROR",
      retryable: true,
      sentence: TIMEOUT_SENTENCE,
    },
    {
      name: "PoolExhaustedError",
      raise: (text) => new PoolExhaustedError(text, "etcd", 10),
      status: 503,
      code: "POOL_EXHAUSTED",
      retryable: true,
    },
    {
      name: "PermissionDeniedError",
      raise: (text) => new PermissionDeniedError(text, "etcd"),
      status: 403,
      code: "PERMISSION_DENIED",
    },
  ];

  beforeEach(() => {
    clearRateLimitState();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider as never);
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(() => declaredCapabilities);
    mockPreviewMaintenance.mockReset();
    (mockProvider as { previewMaintenance?: unknown }).previewMaintenance = mockPreviewMaintenance;
  });

  test("a preview's Studio error answers by its class, with its code, kind and outcome", async () => {
    for (const studio of STUDIO_ERRORS) {
      const text = `refused ${crypto.randomUUID()}`;
      const error = studio.raise(text);
      mockPreviewMaintenance.mockImplementation(async () => {
        throw error;
      });

      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each answer is its own error's.
      const response = await preview({ type: "compact", target: "orders", connection: validConnection });
      // oxlint-disable-next-line no-await-in-loop -- the answer of the request above.
      const body = await parseResponseJSON<Record<string, unknown>>(response);

      expect([studio.name, response.status]).toEqual([studio.name, studio.status]);
      expect([studio.name, body]).toEqual([
        studio.name,
        {
          error: studio.sentence ?? text,
          code: studio.code,
          statusCode: studio.status,
          ...(studio.retryable === undefined ? {} : { retryable: true }),
          kind: errorKind(error),
          outcome: "unknown",
        },
      ]);
    }
  });

  test("a preview's raw error answers 500 INTERNAL_ERROR with its own words, and no kind or outcome", async () => {
    const text = `socket ${crypto.randomUUID()}`;
    mockPreviewMaintenance.mockImplementation(async () => {
      throw new Error(text);
    });

    const response = await preview({ type: "compact", target: "orders", connection: validConnection });
    const body = await parseResponseJSON<Record<string, unknown>>(response);

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: text, code: "INTERNAL_ERROR", statusCode: 500 });
  });

  test("the provider is asked once with the operation and the object's path, its container first, and the answer is its preview", async () => {
    const answered: MaintenancePreview = {
      summary: `Compacting orders ${crypto.randomUUID()}`,
      facts: [{ label: "Revision", value: "40" }],
      refusal: "orders is busy",
      note: "as reported by the server",
    };
    const calls: [Record<string, unknown>, [MaintenanceOperation, readonly string[]]][] = [
      [{ type: "compact", target: "orders" }, ["compact", ["orders"]]],
      [{ type: "compact", target: "orders", container: "app" }, ["compact", ["app", "orders"]]],
    ];

    for (const [body, args] of calls) {
      mockPreviewMaintenance.mockReset();
      mockPreviewMaintenance.mockImplementation(async () => answered);

      // oxlint-disable-next-line no-await-in-loop -- one request at a time, so each call is its own request's.
      const response = await preview({ ...body, connection: validConnection });
      // oxlint-disable-next-line no-await-in-loop -- the answer of the request above.
      const answer = await parseResponseJSON<Record<string, unknown>>(response);

      expect([body, response.status]).toEqual([body, 200]);
      expect([body, mockPreviewMaintenance.mock.calls]).toEqual([body, [args]]);
      expect([body, answer]).toEqual([body, { preview: answered }]);
    }
  });
});

describe("the preview route on the host core", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
    mockGetOrCreateProvider.mockImplementation(async () => mockProvider as never);
    (mockProvider.getCapabilities as ReturnType<typeof mock>).mockImplementation(() => declaredCapabilities);
    mockPreviewMaintenance.mockReset();
    mockPreviewMaintenance.mockImplementation(async () => SYNTHETIC_PREVIEW);
    (mockProvider as { previewMaintenance?: unknown }).previewMaintenance = mockPreviewMaintenance;
    mockReadProviderDeclarations.mockClear();
    mockAuditPush.mockClear();
  });

  /** A preview request whose signal is `signal`, as a browser that may leave sends it. */
  function previewWith(signal?: AbortSignal): Promise<Response> {
    return POST(
      new Request("http://localhost:3000/api/db/maintenance/preview", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "compact", target: "orders", container: "app", connection: validConnection }),
        ...(signal === undefined ? {} : { signal }),
      }) as never,
    );
  }

  test("a preview whose request leaves while the provider reads answers 499 at once, outcome unknown", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const pending = Promise.withResolvers<never>();
    const reached = Promise.withResolvers<void>();
    mockPreviewMaintenance.mockImplementation(() => {
      reached.resolve();
      return pending.promise;
    });
    const caller = new AbortController();
    try {
      const answering = previewWith(caller.signal);
      await reached.promise;
      caller.abort(new DOMException("The request went away.", "AbortError"));
      const response = await answering;

      expect(response.status).toBe(499);
      expect(await parseResponseJSON(response)).toMatchObject({ code: "QUERY_CANCELLED", outcome: "unknown" });
      expect(mockAuditPush).not.toHaveBeenCalled();
      pending.reject(new Error(crypto.randomUUID()));
      await pending.promise.catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      warn.mockRestore();
    }
  });

  test("a preview whose request is already gone answers 499 not-sent and asks the provider nothing", async () => {
    const caller = new AbortController();
    caller.abort(new DOMException("The request went away.", "AbortError"));

    const response = await previewWith(caller.signal);

    expect(response.status).toBe(499);
    expect(await parseResponseJSON(response)).toMatchObject({ code: "QUERY_CANCELLED", outcome: "not-sent" });
    expect(mockPreviewMaintenance).not.toHaveBeenCalled();
  });

  test("a preview past its deadline answers 504 studio-timeout-refusal naming the preview", async () => {
    const real = hostCore();
    const stopping: HostCore = {
      ...real,
      maintenancePreviewCall: async (): Promise<MaintenancePreviewRecord> => ({
        kind: "stopped",
        reason: new DOMException("The call's deadline has passed.", "TimeoutError"),
        settled: Promise.resolve(),
      }),
    };
    forgetHostCore();
    installHostCore(stopping, "test");
    let response: Response;
    try {
      response = await previewWith();
    } finally {
      forgetHostCore();
      installHostCore(real, "test");
    }
    const body = await parseResponseJSON<Record<string, unknown>>(response);

    expect(response.status).toBe(504);
    expect(body).toMatchObject({ code: "TIMEOUT_ERROR", kind: "studio-timeout-refusal", outcome: "unknown" });
    expect(body.error).toBe(
      "The maintenance preview did not answer within the statement timeout of 60 seconds and 10 seconds more for the engine's own answer, so Studio stopped waiting for it.",
    );
  });

  test("whether a preview is offered is read from the bridged session", async () => {
    const offered = await previewWith();
    delete (mockProvider as { previewMaintenance?: unknown }).previewMaintenance;
    const withdrawn = await previewWith();

    expect(offered.status).toBe(200);
    expect(withdrawn.status).toBe(400);
    expect(await errorOf(withdrawn)).toBe("This operation has no preview");
    // The bridged session is built once the declarations are read, so both requests read them.
    expect(mockReadProviderDeclarations).toHaveBeenCalledTimes(2);
    expect(mockPreviewMaintenance).toHaveBeenCalledTimes(1);
  });
});
