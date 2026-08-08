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
    });
  }
});
