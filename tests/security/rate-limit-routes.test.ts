import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "node:path";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { discoverRoutes } from "./helpers/discover-routes";

/**
 * Threat: an authenticated user burning the operator's LLM budget or saturating the database.
 *
 * Two things must be true and both are asserted here. The rejection must land BEFORE the provider
 * is reached - a 429 that still paid for an LLM call protects nothing - and rotating routes must
 * not multiply the budget, because an attacker who can send the same statement through
 * /api/db/multi-query would otherwise get a second allowance for free.
 */

const mockGetSession = mock(
  async (): Promise<{ role: string; username: string } | null> => ({ role: "user", username: "u@libredb.org" }),
);

mock.module("@/lib/auth", () => ({
  getSession: mockGetSession,
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

const mockCreateLLMProvider = mock(async () => ({ stream: async () => new ReadableStream() }));

mock.module("@/lib/llm", () => ({ createLLMProvider: mockCreateLLMProvider }));

const { POST: nl2sql } = await import("@/app/api/ai/nl2sql/route");
const { POST: explain } = await import("@/app/api/ai/explain/route");

function aiRequest(): Request {
  return new Request("http://localhost:3000/api/ai/nl2sql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ question: "how many employees", schemaContext: "", databaseType: "sqlite" }),
  });
}

beforeEach(() => {
  clearRateLimitState();
  mockCreateLLMProvider.mockClear();
  mockGetSession.mockImplementation(async () => ({ role: "user", username: "u@libredb.org" }));
  process.env.RATE_LIMIT_AI_MAX = "3";
});

// Symmetric with the "an unauthenticated probe" test's own delete of RATE_LIMIT_ANON_MAX: an
// env var set for this file's own tests must not leak into whichever file bun happens to run
// next in the same process. Left unrestored, the failure mode is a 429 in a test that has
// nothing to do with rate limiting, in whichever file runs after this one.
afterEach(() => {
  delete process.env.RATE_LIMIT_AI_MAX;
});

describe("the AI budget", () => {
  test("rejects with 429 once the budget is spent", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i += 1) {
        expect((await nl2sql(aiRequest() as never)).status).toBe(200);
      }
      const rejected = await nl2sql(aiRequest() as never);

      expect(rejected.status).toBe(429);
      expect(rejected.headers.get("retry-after")).toBeTruthy();
      expect(await rejected.json()).toMatchObject({ code: "RATE_LIMITED" });
    } finally {
      spy.mockRestore();
    }
  });

  test("rejects before the LLM provider is ever created", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i += 1) {
        await nl2sql(aiRequest() as never);
      }
      mockCreateLLMProvider.mockClear();

      await nl2sql(aiRequest() as never);

      expect(mockCreateLLMProvider).toHaveBeenCalledTimes(0);
    } finally {
      spy.mockRestore();
    }
  });

  test("is shared across routes, so rotating endpoints does not multiply it", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await nl2sql(aiRequest() as never);
      await nl2sql(aiRequest() as never);
      await nl2sql(aiRequest() as never);

      const rotated = await explain(
        new Request("http://localhost:3000/api/ai/explain", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sql: "SELECT 1", databaseType: "sqlite" }),
        }) as never,
      );

      expect(rotated.status).toBe(429);
    } finally {
      spy.mockRestore();
    }
  });

  test("is per user, so one caller cannot deny the budget to another", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let i = 0; i < 4; i += 1) {
        await nl2sql(aiRequest() as never);
      }

      mockGetSession.mockImplementation(async () => ({ role: "user", username: "other@libredb.org" }));

      expect((await nl2sql(aiRequest() as never)).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  test("records the trip once, so a hammering client cannot fill the log", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let i = 0; i < 8; i += 1) {
        await nl2sql(aiRequest() as never);
      }

      const trips = spy.mock.calls
        .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
        .filter((line) => line.event === "rate_limit_exceeded");

      expect(trips).toHaveLength(1);
      expect(trips[0].actor).toBe("u@libredb.org");
      expect(trips[0].route).toBe("POST /api/ai/nl2sql");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("an unauthenticated probe", () => {
  test("is denied and audited, but the denial lines are bounded", async () => {
    process.env.RATE_LIMIT_ANON_MAX = "2";
    mockGetSession.mockImplementation(async () => null);
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let i = 0; i < 10; i += 1) {
        expect((await nl2sql(aiRequest() as never)).status).toBe(401);
      }

      const denials = spy.mock.calls
        .map((call) => JSON.parse(call[0] as string) as Record<string, unknown>)
        .filter((line) => line.event === "permission_denied");

      // RATE_LIMIT_ANON_MAX (2) audit lines while consumeRateLimit still reports "allowed" for
      // the anon bucket, plus exactly one trip line once it reports the crossing - never one per
      // probe, which is the whole point of metering the audit line separately from the always-401
      // response. Confirmed against src/lib/api/rate-limit.ts's decide(): the trip is its own
      // event, not folded into the last allowed one, so the bound is max + 1, not max.
      expect(denials).toHaveLength(3);
      expect(denials[0].reason).toBe("no_session");
    } finally {
      spy.mockRestore();
      delete process.env.RATE_LIMIT_ANON_MAX;
    }
  });
});

/**
 * Enumerated from disk, not from a hardcoded list of route names: the threat is a route that
 * reaches a provider without one of the three controls (session, rate limit, audit), and a
 * hardcoded list only ever proves the routes someone remembered to add to it are covered. A
 * tenth AI route added later without wiring guardRoute is caught here automatically, the same
 * way tests/security/route-auth.test.ts's whole-tree enumeration already catches one that skips
 * the session check - both use the same discoverRoutes() helper, so they cannot drift apart.
 */
const AI_ROUTES_DIR = join(import.meta.dir, "..", "..", "src", "app", "api", "ai");

const AI_ROUTES = discoverRoutes(AI_ROUTES_DIR);

describe("every AI route enforces the shared budget", () => {
  // A directory-listing bug that silently finds zero routes would make the loop below run no
  // assertions at all - a vacuous pass. This is what keeps that possibility from going unnoticed.
  test("the filesystem enumeration finds at least today's eight AI routes", () => {
    expect(AI_ROUTES.length).toBeGreaterThanOrEqual(8);
  });

  test("each discovered route is rejected once the shared ai bucket is already spent", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let i = 0; i < 3; i += 1) {
        await nl2sql(aiRequest() as never);
      }

      for (const [name, load] of AI_ROUTES) {
        const { POST } = await load();
        // Narrows POST off its optional RouteModule type and doubles as its own assertion: a
        // discovered "AI route" that does not export POST is a bug in the route file, not
        // something this loop should silently skip.
        if (typeof POST !== "function") {
          throw new Error(`discovered route "${name}" does not export POST`);
        }
        const req = new Request(`http://localhost:3000/api/ai/${name}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });

        const res = await POST(req as never);

        expect(res.status).toBe(429);
      }
    } finally {
      spy.mockRestore();
    }
  });
});
