import { describe, expect, test, mock, beforeEach } from "bun:test";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

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
  throw new Error("createLLMProvider must not be reached: the requireSession guard should have returned 401 first");
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

const { requireSession } = await import("@/lib/api/require-session");

describe("requireSession", () => {
  beforeEach(() => {
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => ({ role: "admin", username: "admin" }));
  });

  test("returns null when a session exists", async () => {
    expect(await requireSession()).toBeNull();
  });

  test("returns a 401 response when no session exists", async () => {
    mockGetSession.mockImplementation(async () => null);

    const res = await requireSession();

    expect(res).not.toBeNull();
    expect(res?.status).toBe(401);
    expect(await res?.json()).toEqual({ error: "Authentication required" });
  });
});

type RouteModule = { POST: (req: never) => Promise<Response> };

// Enumerated from disk instead of hardcoded, so a route added under src/app/api/ai/ later is
// checked automatically instead of silently escaping this test - that was the whole gap: a
// hardcoded list only ever proves the routes someone remembered to add to it are guarded.
//
// The import specifier is a filesystem path computed at test-run time, not the "@/" alias used
// elsewhere in this file: bun resolves "@/" only when the specifier is a literal string it can
// see at parse time, and a path built from a directory listing is not one. A plain path (relative
// or absolute) has no such restriction - bun's dynamic import() resolves it like any other
// runtime module specifier, and the "@/" imports *inside* each route.ts still resolve normally
// there, since that resolution happens in that file's own context, independent of how the
// importer named it.
const AI_ROUTES_DIR = join(import.meta.dir, "..", "..", "src", "app", "api", "ai");

function discoverAiRoutes(): Array<[string, () => Promise<RouteModule>]> {
  return readdirSync(AI_ROUTES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(AI_ROUTES_DIR, entry.name, "route.ts")))
    .map((entry) => entry.name)
    .sort()
    .map((name): [string, () => Promise<RouteModule>] => [
      `/api/ai/${name}`,
      () => import(join(AI_ROUTES_DIR, name, "route.ts")) as Promise<RouteModule>,
    ]);
}

const AI_ROUTES = discoverAiRoutes();

const GUARDED_ROUTES: Array<[string, () => Promise<RouteModule>]> = [
  ...AI_ROUTES,
  ["/api/db/disconnect", () => import("@/app/api/db/disconnect/route")],
];

describe("routes that reach a provider require a session", () => {
  beforeEach(() => {
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => null);
  });

  // A directory-listing bug that silently finds zero routes would make every test below
  // vacuously pass (a `for` loop over an empty array runs no assertions). This is the guard
  // that keeps the guard honest: today there are eight AI routes, and the enumeration must find
  // at least that many, or this test suite is no longer proving what it claims to prove.
  test("the filesystem enumeration finds at least today's eight AI routes", () => {
    expect(AI_ROUTES.length).toBeGreaterThanOrEqual(8);
  });

  for (const [route, load] of GUARDED_ROUTES) {
    test(`POST ${route} returns 401 without a session`, async () => {
      const { POST } = await load();

      const req = new Request(`http://localhost${route}`, {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });

      const res = await POST(req as never);

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "Authentication required" });
    });
  }
});
