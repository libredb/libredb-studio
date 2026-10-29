import { describe, test, expect, mock, beforeEach } from "bun:test";
import * as realAuth from "@/lib/auth";
import type { SessionReading, UserPayload } from "@/lib/auth";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { parseResponseJSON } from "../../helpers/mock-next";

// ─── Mock @/lib/auth BEFORE importing the route ─────────────────────────────
const mockReadSession = mock(async (): Promise<SessionReading> => ({ kind: "anonymous" }));
const mockGetSession = mock(async (): Promise<UserPayload | null> => null);

mock.module("@/lib/auth", () => ({
  ...realAuth,
  readSession: mockReadSession,
  getSession: mockGetSession,
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { GET } = await import("@/app/api/auth/me/route");

// ─── Tests ──────────────────────────────────────────────────────────────────
describe("GET /api/auth/me", () => {
  beforeEach(() => {
    mockReadSession.mockClear();
    mockGetSession.mockClear();
  });

  test("returns 200 with authenticated true when session exists", async () => {
    mockReadSession.mockResolvedValueOnce({
      kind: "authenticated",
      session: { role: "admin", username: "admin" },
    });

    const res = await GET();
    const data = await parseResponseJSON<{
      authenticated: boolean;
      user: { role: string; username: string };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.authenticated).toBe(true);
    expect(data.user).toEqual({ role: "admin", username: "admin" });
  });

  test("never returns the session handle of an openshift session", async () => {
    mockReadSession.mockResolvedValueOnce({
      kind: "authenticated",
      session: {
        role: "user",
        username: "dev-a",
        idpSubject: "0b6f5c1e-4d2a-4c55-9e1f-7a3b2c1d0e9f",
        idpIssuer: "https://oauth-openshift.apps.example.com",
        sessionHandle: "handle-not-a-real-value-0000000000000000000",
      },
    });

    const res = await GET();
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(text).not.toContain("sessionHandle");
    expect(text).not.toContain("handle-not-a-real-value");
    expect(JSON.parse(text).user).toEqual({
      role: "user",
      username: "dev-a",
      idpSubject: "0b6f5c1e-4d2a-4c55-9e1f-7a3b2c1d0e9f",
      idpIssuer: "https://oauth-openshift.apps.example.com",
    });
  });

  test("returns 401 with authenticated false when no session", async () => {
    mockReadSession.mockResolvedValueOnce({ kind: "anonymous" });

    const res = await GET();
    const data = await parseResponseJSON<{ authenticated: boolean }>(res);

    expect(res.status).toBe(401);
    expect(data.authenticated).toBe(false);
  });

  test("returns admin role session data", async () => {
    mockReadSession.mockResolvedValueOnce({
      kind: "authenticated",
      session: { role: "admin", username: "admin" },
    });

    const res = await GET();
    const data = await parseResponseJSON<{
      authenticated: boolean;
      user: { role: string; username: string };
    }>(res);

    expect(data.user.role).toBe("admin");
    expect(data.user.username).toBe("admin");
  });

  test("returns user role session data", async () => {
    mockReadSession.mockResolvedValueOnce({
      kind: "authenticated",
      session: { role: "user", username: "user" },
    });

    const res = await GET();
    const data = await parseResponseJSON<{
      authenticated: boolean;
      user: { role: string; username: string };
    }>(res);

    expect(res.status).toBe(200);
    expect(data.authenticated).toBe(true);
    expect(data.user.role).toBe("user");
    expect(data.user.username).toBe("user");
  });

  test("returns 503 with ACCOUNT_STORE_UNAVAILABLE when readSession reports store_unavailable", async () => {
    mockReadSession.mockResolvedValueOnce({
      kind: "store_unavailable",
      error: new Error("account db offline"),
    });

    const res = await GET();
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(503);
    expect(data.code).toBe(ApiErrorCode.ACCOUNT_STORE_UNAVAILABLE);
  });
});
