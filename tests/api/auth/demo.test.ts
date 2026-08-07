import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { AuthConfigError } from "@/lib/auth-errors";

// ─── Mock @/lib/auth BEFORE importing the route ─────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mockLogin = mock(async (_role: string, _email?: string) => {});

mock.module("@/lib/auth", () => ({
  login: mockLogin,
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  getSession: mock(async () => null),
  logout: mock(async () => {}),
}));

// ─── Import route handler AFTER mocking ─────────────────────────────────────
const { POST } = await import("@/app/api/auth/demo/route");

// ─── Tests ──────────────────────────────────────────────────────────────────
describe("POST /api/auth/demo", () => {
  const MUTATED_ENV_KEYS = ["DEMO_EMAIL", "DEMO_PASSWORD", "ADMIN_PASSWORD", "USER_PASSWORD"] as const;
  const envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    mockLogin.mockClear();
    for (const key of MUTATED_ENV_KEYS) envSnapshot[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of MUTATED_ENV_KEYS) {
      const value = envSnapshot[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("returns 404 when DEMO_EMAIL is not set — the feature is off by default", async () => {
    delete process.env.DEMO_EMAIL;
    process.env.DEMO_PASSWORD = "LibreDB.2026";

    const res = await POST(createMockRequest("/api/auth/demo", { method: "POST" }) as never);
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(404);
    expect(data.success).toBe(false);
    expect(data.message).toBe("Demo access is not enabled on this server");
    expect(mockLogin).not.toHaveBeenCalled();
  });

  test("returns 404 when DEMO_PASSWORD is not set", async () => {
    process.env.DEMO_EMAIL = "user@libredb.org";
    delete process.env.DEMO_PASSWORD;

    const res = await POST(createMockRequest("/api/auth/demo", { method: "POST" }) as never);

    expect(res.status).toBe(404);
    expect(mockLogin).not.toHaveBeenCalled();
  });

  test("signs the visitor in as the configured demo account", async () => {
    process.env.DEMO_EMAIL = "user@libredb.org";
    process.env.DEMO_PASSWORD = "LibreDB.2026";
    process.env.USER_PASSWORD = "LibreDB.2026";

    const res = await POST(createMockRequest("/api/auth/demo", { method: "POST" }) as never);
    const data = await parseResponseJSON<{ success: boolean; role: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.role).toBe("user");
    expect(mockLogin).toHaveBeenCalledWith("user", "user@libredb.org");
  });

  test("grants only the role the demo account already has — no privilege of its own", async () => {
    // The route never mints a role: it resolves DEMO_EMAIL against the same user
    // table as /api/auth/login. Pointing DEMO_EMAIL at the admin account is an
    // operator decision, visible here rather than hidden behind a bypass path.
    process.env.DEMO_EMAIL = "admin@libredb.org";
    process.env.DEMO_PASSWORD = "LibreDB.2026";
    process.env.ADMIN_PASSWORD = "LibreDB.2026";

    const res = await POST(createMockRequest("/api/auth/demo", { method: "POST" }) as never);
    const data = await parseResponseJSON<{ role: string }>(res);

    expect(data.role).toBe("admin");
  });

  test("returns 503 with an actionable message when the demo credentials match no account", async () => {
    process.env.DEMO_EMAIL = "demo@libredb.org";
    process.env.DEMO_PASSWORD = "not-the-configured-password";

    const res = await POST(createMockRequest("/api/auth/demo", { method: "POST" }) as never);
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

    // Operator misconfiguration, not a visitor error: never show the visitor
    // "invalid credentials" for a button they cannot type into.
    expect(res.status).toBe(503);
    expect(data.success).toBe(false);
    expect(data.message).toContain("DEMO_EMAIL");
    expect(mockLogin).not.toHaveBeenCalled();
  });

  test("surfaces a JWT_SECRET config error as a 503 with its message", async () => {
    process.env.DEMO_EMAIL = "user@libredb.org";
    process.env.DEMO_PASSWORD = "LibreDB.2026";
    process.env.USER_PASSWORD = "LibreDB.2026";

    const jwtMessage = "Login is unavailable: the server's JWT_SECRET is not configured.";
    mockLogin.mockImplementationOnce(async () => {
      throw new AuthConfigError(jwtMessage);
    });

    const res = await POST(createMockRequest("/api/auth/demo", { method: "POST" }) as never);
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(503);
    expect(data.message).toBe(jwtMessage);
  });

  test("returns 500 when signing the session fails for an unexpected reason", async () => {
    process.env.DEMO_EMAIL = "user@libredb.org";
    process.env.DEMO_PASSWORD = "LibreDB.2026";
    process.env.USER_PASSWORD = "LibreDB.2026";

    mockLogin.mockImplementationOnce(async () => {
      throw new Error("cookie store unavailable");
    });

    const res = await POST(createMockRequest("/api/auth/demo", { method: "POST" }) as never);
    const data = await parseResponseJSON<{ code: string; statusCode: number }>(res);

    expect(res.status).toBe(500);
    expect(data.code).toBe("INTERNAL_ERROR");
  });
});
