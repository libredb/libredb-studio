/**
 * `POST /api/db/test-connection` for an engine a provider package serves (docs/providers/CONTRACT.md, clause C-107),
 * through the real `resolvePackageAwareConnection` and a server catalog installed by the composer: an admitted engine's
 * connection is validated against its declaration's field rules, each refusal the declared sentence as a configuration
 * error whose statement was not sent, and a connection that passes them is refused at the open, which this Studio does
 * not serve for a package engine yet; a refused package's engine answers `PROVIDER_UNAVAILABLE` naming the code. The
 * factory is stood in for and never reached on either path.
 */
// oxlint-disable no-await-in-loop -- each post runs after the one before, on one rate limiter cleared per post.
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { forgetServerCatalog, installServerCatalog } from "@/lib/db/server-catalog";
import { composeServerCatalog } from "@/lib/db/server-catalog-compose";
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

beforeAll(() => {
  installServerCatalog(
    composeServerCatalog(
      [admittedFor("acme-tested", admittedManifest("acmetested", withFieldRules))],
      [{ name: "acme-gone", version: "1.0.0", engines: ["acmetestgone"], code: "PROVIDER_LOAD_FAILED" }],
    ),
  );
});
afterAll(forgetServerCatalog);

beforeEach(() => {
  factoryCalls.length = 0;
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

describe("POST /api/db/test-connection for a provider package's engine", () => {
  test("Test Connection accepts an admitted engine's connection and validates it against its declared field rules, then refuses at the open, building nothing", async () => {
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

    // A hidden database is not checked, and an empty password passes the named check.
    for (const fields of [
      { host: "db.local", user: "writer" },
      { host: "db.local", user: "reader", database: "d", password: "" },
    ]) {
      const { status, body } = await routeAnswer({ type, ...fields });
      expect([status, body.code, body.error]).toEqual([
        501,
        "PACKAGE_ENGINE_UNSUPPORTED",
        "This LibreDB Studio opens no session on an engine of a provider package yet.",
      ]);
    }
    expect(factoryCalls).toEqual([]);
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
