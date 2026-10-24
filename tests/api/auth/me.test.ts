import { describe, test, expect, mock, beforeEach } from "bun:test";
import { parseResponseJSON } from "../../helpers/mock-next";

import type { SessionReading, UserPayload } from "@/lib/auth";
import { ACCOUNT_STORE_UNAVAILABLE_BODY } from "@/lib/api/account-store-error";

// ─── Mock @/lib/auth BEFORE importing the route ─────────────────────────────
const mockGetSession = mock(async (): Promise<UserPayload | null> => null);
const mockReadSession = mock(async (): Promise<SessionReading> => {
  const session = await mockGetSession();
  return session ? { kind: "authenticated", session } : { kind: "anonymous" };
});

const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  login: mock(async () => {}),
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  readSession: mockReadSession,
  getSession: mockGetSession,
  logout: mock(async () => {}),
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { GET } = await import("@/app/api/auth/me/route");

// ─── Tests ──────────────────────────────────────────────────────────────────
describe("GET /api/auth/me", () => {
  beforeEach(() => {
    mockGetSession.mockClear();
    mockReadSession.mockClear();
  });

  test("returns 200 with authenticated true when session exists", async () => {
    mockGetSession.mockResolvedValueOnce({ role: "admin", username: "admin" });

    const res = await GET();
    const data = await parseResponseJSON<{
      authenticated: boolean;
      user: { role: string; username: string };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.authenticated).toBe(true);
    expect(data.user).toEqual({ role: "admin", username: "admin" });
  });

  test("returns 401 with authenticated false when no session", async () => {
    mockGetSession.mockResolvedValueOnce(null);

    const res = await GET();
    const data = await parseResponseJSON<{ authenticated: boolean }>(res);

    expect(res.status).toBe(401);
    expect(data.authenticated).toBe(false);
  });

  test("returns admin role session data", async () => {
    mockGetSession.mockResolvedValueOnce({ role: "admin", username: "admin" });

    const res = await GET();
    const data = await parseResponseJSON<{
      authenticated: boolean;
      user: { role: string; username: string };
    }>(res);

    expect(data.user.role).toBe("admin");
    expect(data.user.username).toBe("admin");
  });

  test("returns user role session data", async () => {
    mockGetSession.mockResolvedValueOnce({ role: "user", username: "user" });

    const res = await GET();
    const data = await parseResponseJSON<{
      authenticated: boolean;
      user: { role: string; username: string };
    }>(res);

    expect(data.user.role).toBe("user");
    expect(data.user.username).toBe("user");
  });

  test("returns 503 with ACCOUNT_STORE_UNAVAILABLE when readSession reports store_unavailable", async () => {
    mockReadSession.mockResolvedValueOnce({
      kind: "store_unavailable",
      error: new Error("postgres connection refused"),
    });

    const res = await GET();
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(503);
    expect(data).toEqual(ACCOUNT_STORE_UNAVAILABLE_BODY);
  });
});
