/**
 * `POST /api/db/test-connection` for an engine a provider package serves (docs/providers/CONTRACT.md, clauses C-107 and
 * C-112), through the real `resolveConnection`, the real package session path and the real host core: an
 * admitted engine's connection is validated against its declaration's field rules and the open checks, each refusal a
 * not-sent configuration error, then one session opens through the package, its health is read and it is closed; a
 * package's own words never reach the client; a refused package's engine answers `PROVIDER_UNAVAILABLE` naming the
 * code. The factory is stood in for and never reached.
 *
 * The packages are in-memory records whose functions call the hooks a case sets. The deadline case runs on an engine
 * record whose budget is 50 ms; it settles on the route's own answer, never on a timer the test awaits.
 */
// oxlint-disable no-await-in-loop -- each post runs after the one before, on one rate limiter cleared per post.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ProviderImpl } from "@libredb/provider-sdk/calls";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { logger } from "@/lib/logger";
import { forgetServerCatalog, installServerCatalog, type PackageEngine } from "@/lib/db/server-catalog";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { installHostCore } from "@/lib/provider-host/instance";
import { admittedFor, admittedManifest, withFieldRules } from "../../helpers/package-catalog";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";

const mockGetSession = mock(async () => ({ role: "admin", username: "admin" }));

// The spread form, not a hand-written stub: only the session readers are replaced (backlog D85).
const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mockGetSession,
  readSession: mock(async () => ({ kind: "authenticated", session: await mockGetSession() })),
}));

/** Every call into the factory, by name: none may happen for a package engine. */
const factoryCalls: string[] = [];
const recorded = (name: string) => async (): Promise<never> => {
  factoryCalls.push(name);
  throw new Error(`the factory's ${name} was reached`);
};
mock.module("@/lib/db/factory", () => ({
  withOneShotTunnel: recorded("withOneShotTunnel"),
  createDatabaseProvider: recorded("createDatabaseProvider"),
  findOpenSingleWriterProvider: () => {
    factoryCalls.push("findOpenSingleWriterProvider");
    return null;
  },
  isSingleWriterFileOpen: () => {
    factoryCalls.push("isSingleWriterFileOpen");
    return false;
  },
  getOrCreateProvider: recorded("getOrCreateProvider"),
  removeProvider: recorded("removeProvider"),
  clearProviderCache: recorded("clearProviderCache"),
  getProviderCacheStats: () => ({ size: 0, connections: [] }),
}));

const { POST } = await import("@/app/api/db/test-connection/route");

/** The hooks the packages' functions call, set per case. */
let hooks: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
/** The names of the package calls a case saw, in order. */
const seen: string[] = [];

/** An implementation whose every function records its name and calls the case's hook. */
function hookImpl(): ProviderImpl<unknown> {
  const call =
    (name: string) =>
    (...args: unknown[]) => {
      seen.push(name);
      return (hooks[name] ?? (() => Promise.resolve(undefined)))(...args);
    };
  return {
    open: call("open"),
    close: call("close"),
    health: call("health"),
    console: { execute: call("execute") },
    monitoring: { panel: call("panel") },
  } as unknown as ProviderImpl<unknown>;
}

const HEALTH = { databaseSize: "1 MB", cacheHitRatio: "99%", slowQueries: [], activeSessions: [] };

/** Hooks of a package that opens, answers its health and closes. */
function healthyHooks(): typeof hooks {
  return {
    open: () => Promise.resolve({ handle: { session: randomUUID() } }),
    health: () => Promise.resolve(HEALTH),
    close: () => Promise.resolve(),
  };
}

beforeAll(() => {
  installHostCore(createHostCore(), "test");
  const tested = admittedFor("acme-tested", admittedManifest("acmetested", withFieldRules));
  const brief = admittedFor("acme-brief", admittedManifest("acmetestbrief"));
  const composed = composeServerCatalog(
    [
      { ...tested, record: { ...tested.record, impl: hookImpl() } },
      { ...brief, record: { ...brief.record, impl: hookImpl() } },
    ],
    [{ name: "acme-gone", version: "1.0.0", engines: ["acmetestgone"], code: "PROVIDER_LOAD_FAILED" }],
  );
  const briefEngine = composed.packages.get("acmetestbrief") as PackageEngine;
  installServerCatalog({
    packages: new Map([
      ...composed.packages,
      ["acmetestbrief", { ...briefEngine, catalog: { ...briefEngine.catalog, connectBudgetMs: 50 } }],
    ]),
    unavailable: composed.unavailable,
  });
});
afterAll(forgetServerCatalog);

beforeEach(() => {
  factoryCalls.length = 0;
  seen.length = 0;
  hooks = healthyHooks();
  mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
});

/** The route's status and body for `connection`, posted as the dialog posts it. */
async function routeAnswer(
  connection: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  clearRateLimitState();
  const request = createMockRequest("/api/db/test-connection", {
    method: "POST",
    body: { connection: { id: "user-conn", name: "Mine", ...connection } },
  });
  const response = await POST(request as never);
  return { status: response.status, body: (await parseResponseJSON(response)) as Record<string, unknown> };
}

const VALID = { type: "acmetested", host: "db.local", user: "writer" };

describe("POST /api/db/test-connection for a provider package's engine", () => {
  test("Test Connection opens an admitted engine's session through its package, reads its health and closes it", async () => {
    const type = "acmetested";
    const refusals: [Record<string, unknown>, string][] = [
      [{ database: "d" }, "Enter the host. Nothing was sent."],
      [{ host: "Bad Host", database: "d" }, "Host is letters, digits, dots and hyphens."],
      [{ host: "db.local", user: "ab" }, "User is 3 to 16 characters."],
      [{ host: "db.local" }, "Enter the database. Nothing was sent."],
      [
        { host: "db.local", user: "writer", password: randomUUID() },
        "This LibreDB Studio cannot run the check the provider package declares for the field password, so it does not send this connection.",
      ],
    ];
    for (const [fields, sentence] of refusals) {
      const { status, body } = await routeAnswer({ type, ...fields });
      expect([status, body.code, body.error, body.outcome]).toEqual([400, "CONFIG_ERROR", sentence, "not-sent"]);
    }
    expect(seen).toEqual([]);

    // A hidden database is not checked, and an empty password passes the named check.
    for (const fields of [
      { host: "db.local", user: "writer" },
      { host: "db.local", user: "reader", database: "d", password: "" },
    ]) {
      seen.length = 0;
      const { status, body } = await routeAnswer({ type, ...fields });
      expect(status).toBe(200);
      expect([body.success, body.message, typeof body.latency]).toEqual([true, "Connection successful", "number"]);
      expect(seen).toEqual(["open", "health", "close"]);
    }
    expect(factoryCalls).toEqual([]);
  });

  test("a health failure answers the degraded success with Studio's sentence naming its code, and the session is still closed", async () => {
    const secret = randomUUID();
    hooks.health = () => Promise.reject(new Error(secret));
    const error = spyOn(logger, "error");
    try {
      const { status, body } = await routeAnswer(VALID);
      expect(status).toBe(200);
      expect(body).toEqual({
        success: true,
        degraded: true,
        message:
          "Connected, but this server answered no health data: The provider package's health failed (INTERNAL_ERROR); the server's log holds its words.",
      });
      expect(JSON.stringify(body)).not.toContain(secret);
      expect(seen).toEqual(["open", "health", "close"]);
      expect(error.mock.calls.filter(([line]) => line === "A provider package's health failed")).toHaveLength(1);
    } finally {
      error.mockRestore();
    }
  });

  test("an open past the engine's connect budget answers ConnectionError naming the budget, and the late session is closed once it settles", async () => {
    let answer!: (value: unknown) => void;
    let closed!: () => void;
    const closing = new Promise<void>((resolve) => {
      closed = resolve;
    });
    hooks.open = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    hooks.close = (handle) => {
      closed();
      expect(handle).toEqual({ late: true });
      return Promise.resolve();
    };
    const { status, body } = await routeAnswer({ type: "acmetestbrief", host: "db.local" });
    expect([status, body.code]).toEqual([503, "CONNECTION_ERROR"]);
    expect(body.error).toStartWith("The connection test got no answer within");
    answer({ handle: { late: true } });
    await closing;
    expect(seen).toEqual(["open", "close"]);
  });

  test("an open that fails answers Studio's sentence naming its code, not-sent, and a close that fails does not change the answer", async () => {
    const secret = randomUUID();
    hooks.open = () => Promise.reject(new Error(secret));
    const error = spyOn(logger, "error");
    const warn = spyOn(logger, "warn");
    try {
      const failed = await routeAnswer(VALID);
      expect([failed.status, failed.body.code, failed.body.outcome]).toEqual([503, "CONNECTION_ERROR", "not-sent"]);
      expect(failed.body.error).toBe(
        "The provider package's open failed (INTERNAL_ERROR); the server's log holds its words.",
      );
      expect(JSON.stringify(failed.body)).not.toContain(secret);

      hooks = { ...healthyHooks(), close: () => Promise.reject(new Error(secret)) };
      const answered = await routeAnswer(VALID);
      expect([answered.status, answered.body.message]).toEqual([200, "Connection successful"]);
      const line = warn.mock.calls.find(
        ([text]) => text === "Test Connection's session of a provider package did not close",
      );
      expect(line?.[1]).toMatchObject({ close: "failed", kind: "internal", code: "INTERNAL_ERROR" });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  test("the open checks refuse before the budget starts", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        { readOnly: true },
        "readOnly: true is refused for acmetested: its provider package's engine does not enforce a read-only mode in this LibreDB Studio, so the connection would open able to write. Remove readOnly from the connection, or connect with a database role that cannot write.",
      ],
      [
        { sshTunnel: { enabled: true, host: "b", port: 22, username: "u", authMethod: "password" } },
        "This LibreDB Studio opens no SSH tunnel for an engine of a provider package, so it does not open this connection. Turn the tunnel off.",
      ],
    ];
    for (const [fields, sentence] of cases) {
      const { status, body } = await routeAnswer({ ...VALID, ...fields });
      expect([status, body.code, body.error, body.outcome]).toEqual([400, "CONFIG_ERROR", sentence, "not-sent"]);
    }
    mockGetSession.mockImplementation(async () => ({ role: "user", username: "user" }));
    const { status, body } = await routeAnswer(VALID);
    expect([status, body.code]).toEqual([400, "CONFIG_ERROR"]);
    expect(body.error).toStartWith("Connections of this engine require an administrator");
    expect(seen).toEqual([]);
  });

  test("Test Connection answers PROVIDER_UNAVAILABLE naming the refusal code for a refused package's engine", async () => {
    const { status, body } = await routeAnswer({ type: "acmetestgone", host: "db.local" });
    expect([status, body.code]).toEqual([503, "PROVIDER_UNAVAILABLE"]);
    expect(body.error).toBe(
      'The connection type "acmetestgone" is served by a provider package this LibreDB Studio refused when it started (PROVIDER_LOAD_FAILED), so no provider can open it; the server\'s log names the package and why.',
    );
    expect(factoryCalls).toEqual([]);
  });
});
