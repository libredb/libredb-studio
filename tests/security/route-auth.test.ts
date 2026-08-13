import { describe, expect, test, mock, spyOn, beforeEach } from "bun:test";
import { join } from "node:path";
import { discoverRoutes } from "./helpers/discover-routes";

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

// ─── Mock @/lib/llm so a bypassed guard can never be mistaken for a working one ──
//
// Without this, a route that lost its guard would fall through to the real
// createLLMProvider() (network call, needs a valid key) and, on some failure
// modes, src/lib/api/errors.ts maps LLMAuthError to HTTP 401 — the exact status
// this test expects from the guard. A status-only assertion could then pass for
// the wrong reason. Making createLLMProvider throw a plain Error (not one of the
// LLM* classes) means a bypassed guard can only produce a 500 (the "Generic
// Error" branch in createErrorResponse), never a 401 — so 401 here can only mean
// the guard actually ran. This also means the test makes no network call.

class MockLLMError extends Error {
  statusCode?: number;
  constructor(msg: string, _provider?: string, code?: number) {
    super(msg);
    this.name = "LLMError";
    this.statusCode = code;
  }
}
class MockLLMConfigError extends MockLLMError {
  constructor(msg: string) {
    super(msg);
    this.name = "LLMConfigError";
  }
}
class MockLLMAuthError extends MockLLMError {
  constructor(msg: string) {
    super(msg, undefined, 401);
    this.name = "LLMAuthError";
  }
}
class MockLLMRateLimitError extends MockLLMError {
  constructor(msg: string) {
    super(msg, undefined, 429);
    this.name = "LLMRateLimitError";
  }
}
class MockLLMSafetyError extends MockLLMError {
  constructor(msg: string) {
    super(msg, undefined, 400);
    this.name = "LLMSafetyError";
  }
}
class MockLLMStreamError extends MockLLMError {
  constructor(msg: string) {
    super(msg);
    this.name = "LLMStreamError";
  }
}

const mockCreateLLMProvider = mock(async () => {
  throw new Error("createLLMProvider must not be reached: the guardRoute guard should have returned 401 first");
});

mock.module("@/lib/llm", () => ({
  createLLMProvider: mockCreateLLMProvider,
  LLMError: MockLLMError,
  LLMConfigError: MockLLMConfigError,
  LLMAuthError: MockLLMAuthError,
  LLMRateLimitError: MockLLMRateLimitError,
  LLMSafetyError: MockLLMSafetyError,
}));

mock.module("@/lib/llm/types", () => ({
  LLMError: MockLLMError,
  LLMConfigError: MockLLMConfigError,
  LLMAuthError: MockLLMAuthError,
  LLMRateLimitError: MockLLMRateLimitError,
  LLMSafetyError: MockLLMSafetyError,
  LLMStreamError: MockLLMStreamError,
}));

const { guardRoute } = await import("@/lib/api/require-session");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");

describe("guardRoute", () => {
  beforeEach(() => {
    clearRateLimitState();
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
  });

  test("returns the session when the caller is authenticated", async () => {
    const request = new Request("http://localhost:3000/api/db/query", { method: "POST" });

    const guard = await guardRoute({ route: "POST /api/db/query", bucket: "query", request });

    expect(guard).toEqual({ session: { role: "admin", username: "admin" } });
  });

  test("returns a 401 response when no session exists", async () => {
    mockGetSession.mockImplementation(async () => null);
    const request = new Request("http://localhost:3000/api/db/query", { method: "POST" });

    const guard = await guardRoute({ route: "POST /api/db/query", bucket: "query", request });

    expect("response" in guard).toBe(true);
    const response = (guard as { response: Response }).response;
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Authentication required" });
  });

  test("still returns 401 when the permission_denied audit emit throws", async () => {
    // Isolated in its own try/catch: a broken audit sink must never change a denial this route
    // already decided into an unrelated 500.
    mockGetSession.mockImplementation(async () => null);
    const logSpy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    try {
      const request = new Request("http://localhost:3000/api/db/query", { method: "POST" });

      const guard = await guardRoute({ route: "POST /api/db/query", bucket: "query", request });

      expect("response" in guard).toBe(true);
      const response = (guard as { response: Response }).response;
      expect(response.status).toBe(401);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("still returns 429 when the rate_limit_exceeded audit emit throws", async () => {
    const request = () => new Request("http://localhost:3000/api/db/query", { method: "POST" });
    // Trip the "query" bucket (default max 120) with a working audit sink first.
    for (let i = 0; i < 120; i += 1) {
      await guardRoute({ route: "POST /api/db/query", bucket: "query", request: request() });
    }

    const logSpy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    try {
      const guard = await guardRoute({ route: "POST /api/db/query", bucket: "query", request: request() });

      expect("response" in guard).toBe(true);
      const response = (guard as { response: Response }).response;
      expect(response.status).toBe(429);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// Enumerated from disk instead of hardcoded, so a route added ANYWHERE under src/app/api/ is
// checked automatically instead of silently escaping this test. This replaces a curated
// GUARDED_ROUTES list (AI routes discovered dynamically, plus one hand-picked db/ entry) that
// was itself an instance of the exact failure it was trying to prevent: it never covered
// db/query, db/multi-query, db/transaction, db/maintenance, db/cancel, db/health,
// db/monitoring, db/pool-stats, db/profile, db/provider-meta, db/schema, db/schema/list,
// db/schema/relations, db/schema-snapshot, db/test-connection or admin/fleet-health - eleven of
// which reached a database provider through a bare inline getSession() with no rate limit and
// no denial audit, sitting undetected next to routes that had already been fixed. Walking the
// whole tree and requiring an explicit reason for every exemption is what makes a newly added
// provider-reaching route red by default instead of invisible by default.
const API_ROOT_DIR = join(import.meta.dir, "..", "..", "src", "app", "api");

const ALL_ROUTES = discoverRoutes(API_ROOT_DIR);

/**
 * Every route that legitimately reaches no database or LLM provider, so the enumeration below
 * does not require it to call guardRoute. Every entry needs a reason: an unexplained addition
 * here is exactly the hand-maintained-inventory drift this enumeration exists to prevent, and
 * the sanity check below fails if a key does not match a route that actually exists.
 *
 * One entry (`agent/drive`) is NOT in that category and says so in its own reason: it does reach
 * a provider, and it is exempt from THIS enumeration only because the enumeration probes with a
 * POST carrying no credential and asserts guardRoute's exact 401 body. That route cannot have a
 * user session by construction - it is the durable transport's callback - so it authenticates
 * with a server-minted single-purpose credential instead, and the same "no credential, no work"
 * property is proven against it in tests/api/agent/drive.test.ts. An exemption whose reason is a
 * different verified control is the only kind allowed here; "it has no auth" never is.
 */
const ROUTES_WITHOUT_A_PROVIDER: Record<string, string> = {
  "admin/audit": "reads/writes the in-process audit ring buffer only; no database or LLM provider",
  "agent/config":
    "answers whether the agent runtime is enabled, from process.env alone; no database or LLM provider (GET, no POST export). It still requires a session — a bare getSession() like connections/managed, because metering a visibility probe out of the ai bucket would spend a run's budget on rendering a panel — and tests/api/agent/config.test.ts proves an unauthenticated caller learns nothing about the flag",
  "agent/drive":
    "reaches a provider, but is the durable transport's callback and can have no user session: it verifies a server-minted single-purpose credential and its 401 body differs from guardRoute's on purpose (tests/api/agent/drive.test.ts)",
  "agent/runs/[runId]":
    "reads and cancels one run's own durable ledger; no database or LLM provider (GET/DELETE, no POST export). Its session check is guardRoute, through src/lib/api/agent-run-access.ts",
  "agent/runs/[runId]/artifacts/[correlationId]":
    "hands back rows one run already stored, from process memory; no database or LLM provider is reached to answer it (GET, no POST export). Same guardRoute path as above, through src/lib/api/agent-run-access.ts, and tests/api/agent/artifacts.test.ts proves an unauthenticated caller gets 401 and reads nothing",
  "agent/runs/[runId]/stream":
    "follows one run's own durable ledger; no database or LLM provider (GET, no POST export). Same guardRoute path as above",
  "auth/login": "authenticates the credential itself; a session cannot be required before one exists",
  "auth/logout": "clears the session cookie unconditionally; touches no provider either way",
  "auth/me": "reads the caller's own session claims only (GET, no POST export)",
  "auth/oidc/callback": "completes the OIDC exchange that CREATES the session (GET, no POST export)",
  "auth/oidc/login": "starts the OIDC redirect before a session exists (GET, no POST export)",
  "connections/managed": "reads seed config metadata only; never opens a database connection (GET, no POST export)",
  storage: "reaches the app's own storage backend (STORAGE_PROVIDER), not a user database or LLM provider (GET only)",
  "storage/[collection]": "same storage backend as above, scoped to the caller's own data (PUT, no POST export)",
  "storage/config": "publicly documents whether server storage is enabled; no session, no provider (GET only)",
  "storage/migrate": "same storage backend as above; its own 401 body differs from guardRoute's on purpose",
};

const PROVIDER_ROUTES = ALL_ROUTES.filter(([key]) => !(key in ROUTES_WITHOUT_A_PROVIDER));

describe("routes that reach a provider require a session", () => {
  beforeEach(() => {
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => null);
  });

  // A directory-listing bug that silently finds zero routes would make every test below
  // vacuously pass (a `for` loop over an empty array runs no assertions). This is the guard
  // that keeps the guard honest: today there are 22 provider-reaching routes (16 db/ + 4 AI +
  // admin/fleet-health + agent/runs), and the enumeration must find at least that many, or
  // this test suite is no longer proving what it claims to prove.
  test("the filesystem enumeration finds at least today's 22 provider-reaching routes", () => {
    expect(PROVIDER_ROUTES.length).toBeGreaterThanOrEqual(22);
  });

  // A recursion bug that only ever looked one level deep would still pass the check above by
  // over-counting somewhere else; this independently confirms the AI routes specifically -
  // exactly one directory level under src/app/api/ai/ - are still found by the same walk that
  // also has to reach three levels deep for db/schema/list and db/schema/relations.
  //
  // Four since #331 T2 removed nl2sql, autopilot, impact and index-advisor with the panels they
  // served: chat, describe-schema, explain, query-safety.
  test("the same walk finds at least today's four AI routes", () => {
    expect(ALL_ROUTES.filter(([key]) => key.startsWith("ai/")).length).toBeGreaterThanOrEqual(4);
  });

  // A typo'd or stale allowlist key silently exempts fewer routes than intended (or a route
  // that no longer exists) without ever failing loudly - this is what catches that.
  test("every allowlist entry names a route that actually exists", () => {
    for (const key of Object.keys(ROUTES_WITHOUT_A_PROVIDER)) {
      expect(ALL_ROUTES.some(([routeKey]) => routeKey === key)).toBe(true);
    }
  });

  for (const [route, load] of PROVIDER_ROUTES) {
    test(`POST /api/${route} returns 401 without a session`, async () => {
      const routeModule = await load();
      const POST = routeModule.POST;
      // Narrows POST off its optional RouteModule type and doubles as its own assertion: a
      // route in PROVIDER_ROUTES that exports no POST is either missing one or belongs in the
      // allowlist above, not something this loop should silently skip.
      if (typeof POST !== "function") {
        throw new Error(`"${route}" reaches a provider but exports no POST - allowlist it or add one`);
      }

      // A non-empty body clears every route's own pre-guard "empty body" check (several parse
      // and validate the body before reaching the guard), so every route's guard is reached
      // regardless of what it validates afterward - the guard-here-blocks-everything property
      // this test proves does not depend on the request being otherwise well-formed.
      const req = new Request(`http://localhost/api/${route}`, {
        method: "POST",
        body: JSON.stringify({ probe: true }),
        headers: { "Content-Type": "application/json" },
      });

      const res = await POST(req as never);

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Authentication required" });
    });
  }
});
