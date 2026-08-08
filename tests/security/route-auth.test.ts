import { describe, expect, test, mock, beforeEach } from "bun:test";

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

// Each specifier is a literal inside its own arrow function: bun resolves the "@/" alias at
// parse time, so a variable module path would not resolve here.
const GUARDED_ROUTES: Array<[string, () => Promise<RouteModule>]> = [
  ["/api/ai/autopilot", () => import("@/app/api/ai/autopilot/route")],
  ["/api/ai/chat", () => import("@/app/api/ai/chat/route")],
  ["/api/ai/describe-schema", () => import("@/app/api/ai/describe-schema/route")],
  ["/api/ai/explain", () => import("@/app/api/ai/explain/route")],
  ["/api/ai/impact", () => import("@/app/api/ai/impact/route")],
  ["/api/ai/index-advisor", () => import("@/app/api/ai/index-advisor/route")],
  ["/api/ai/nl2sql", () => import("@/app/api/ai/nl2sql/route")],
  ["/api/ai/query-safety", () => import("@/app/api/ai/query-safety/route")],
  ["/api/db/disconnect", () => import("@/app/api/db/disconnect/route")],
];

describe("routes that reach a provider require a session", () => {
  beforeEach(() => {
    mockGetSession.mockClear();
    mockGetSession.mockImplementation(async () => null);
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
