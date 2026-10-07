import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { resetCache as resetSeedCache } from "@/lib/seed";

/**
 * An inline connection without an id is answered 400 CONFIG_ERROR, "Connection ID is required", by
 * every route that opens a cached provider (#1539).
 *
 * The UI always sends an id, so only a direct API caller reaches this. Before the change the routes
 * that open their provider through `getOrCreateProvider` crashed inside `providerCacheKey`, which
 * length-frames `connection.id`: a missing id threw a `TypeError` there, which `createErrorResponse`
 * answered as a 500 `INTERNAL_ERROR`. `POST /api/db/test-connection`, which builds its provider
 * through `createDatabaseProvider`, was already refused by the provider's own `validate()` with the
 * 400 this change brings to the rest.
 *
 * Unlike the other api/db tests, this file does NOT mock `@/lib/db`: the refusal is raised by the
 * real factory ahead of its cache key, and only `getSession` is mocked, to answer as an admin. The
 * session, `resolveConnection` and the factory are the real ones, per the acceptance criteria; the
 * connection is an inline PostgreSQL record whose refusal happens before any socket is opened.
 */

const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mock(async () => ({ role: "admin", username: "admin" })),
}));

const { POST: queryPost } = await import("@/app/api/db/query/route");
const { POST: healthPost } = await import("@/app/api/db/health/route");
const { POST: multiQueryPost } = await import("@/app/api/db/multi-query/route");
const { POST: testConnectionPost } = await import("@/app/api/db/test-connection/route");
const { clearProviderCache, getProviderCacheStats } = await import("@/lib/db/factory");

const workDir = mkdtempSync(join(tmpdir(), "libredb-inline-id-"));
const previousSeedConfigPath = process.env.SEED_CONFIG_PATH;
// No seed file is read on these paths, but a stray SEED_CONFIG_PATH from another test file must not
// leak into this one either; the loader is reset below per test.
if (previousSeedConfigPath === undefined) delete process.env.SEED_CONFIG_PATH;

/** An inline PostgreSQL connection with no id: the record every route here is refused for. */
function bodyWithoutId(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    connection: {
      name: "probe",
      type: "postgres",
      host: "127.0.0.1",
      port: 1,
      user: "u",
      password: "p",
      database: "d",
    },
    ...extra,
  };
}

type Handler = (request: never) => Promise<Response>;

const routes: Record<string, { handler: Handler; extra: Record<string, unknown> }> = {
  query: { handler: queryPost as unknown as Handler, extra: { sql: "SELECT 1" } },
  health: { handler: healthPost as unknown as Handler, extra: {} },
  "multi-query": { handler: multiQueryPost as unknown as Handler, extra: { sql: "SELECT 1" } },
};

async function post(
  handler: Handler,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await handler(createMockRequest("/api/db", { method: "POST", body }) as never);
  return { status: response.status, body: await parseResponseJSON<Record<string, unknown>>(response) };
}

beforeEach(() => {
  clearRateLimitState();
  resetSeedCache();
});

afterAll(() => {
  if (previousSeedConfigPath !== undefined) process.env.SEED_CONFIG_PATH = previousSeedConfigPath;
  resetSeedCache();
  rmSync(workDir, { recursive: true, force: true });
});

describe("an inline connection without an id is refused with 400 CONFIG_ERROR (#1539)", () => {
  for (const [name, { handler, extra }] of Object.entries(routes)) {
    test(`${name}: answers 400 CONFIG_ERROR, "Connection ID is required"`, async () => {
      const { status, body } = await post(handler, bodyWithoutId(extra));
      expect(status).toBe(400);
      expect(body.error).toBe("Connection ID is required");
      expect(body.code).toBe("CONFIG_ERROR");
    });

    test(`${name}: opens no provider and caches nothing`, async () => {
      await clearProviderCache();
      await post(handler, bodyWithoutId(extra));
      expect(getProviderCacheStats().size).toBe(0);
    });
  }

  test("test-connection keeps the same 400 it already answered", async () => {
    const { status, body } = await post(testConnectionPost as unknown as Handler, bodyWithoutId());
    expect(status).toBe(400);
    expect(body.error).toBe("Connection ID is required");
    expect(body.code).toBe("CONFIG_ERROR");
  });
});
