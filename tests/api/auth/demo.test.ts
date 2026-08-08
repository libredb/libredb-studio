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

const post = () => POST(createMockRequest("/api/auth/demo", { method: "POST" }) as never);

// ─── Tests ──────────────────────────────────────────────────────────────────
describe("POST /api/auth/demo", () => {
  const MUTATED_ENV_KEYS = ["DEMO_MODE", "DEMO_ROLE", "ADMIN_PASSWORD", "USER_PASSWORD"] as const;
  const envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    mockLogin.mockClear();
    for (const key of MUTATED_ENV_KEYS) envSnapshot[key] = process.env[key];
    delete process.env.DEMO_ROLE;
  });

  afterEach(() => {
    for (const key of MUTATED_ENV_KEYS) {
      const value = envSnapshot[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("returns 404 when DEMO_MODE is unset — off by default", async () => {
    delete process.env.DEMO_MODE;

    const res = await post();
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(404);
    expect(data.success).toBe(false);
    expect(data.message).toBe("Demo access is not enabled on this server");
    expect(mockLogin).not.toHaveBeenCalled();
  });

  test("returns 404 for a value that does not read as on", async () => {
    process.env.DEMO_MODE = "yes-please";

    expect((await post()).status).toBe(404);
    expect(mockLogin).not.toHaveBeenCalled();
  });

  test.each(["true", "on", "1", " TRUE ", "On"])("opens a demo session when DEMO_MODE is %p", async (value) => {
    process.env.DEMO_MODE = value;

    const res = await post();
    const data = await parseResponseJSON<{ success: boolean; role: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.role).toBe("user");
    expect(mockLogin).toHaveBeenCalledWith("user", "demo@libredb.org");
  });

  test("needs no account, no password and no ADMIN_PASSWORD to work", async () => {
    // The whole point of the switch: a public instance running OIDC has no local
    // accounts at all, and demo visitors must still get in.
    delete process.env.ADMIN_PASSWORD;
    delete process.env.USER_PASSWORD;
    process.env.DEMO_MODE = "true";

    expect((await post()).status).toBe(200);
  });

  test("grants admin only when an operator explicitly asks for it", async () => {
    process.env.DEMO_MODE = "true";
    process.env.DEMO_ROLE = "admin";

    const data = await parseResponseJSON<{ role: string }>(await post());

    expect(data.role).toBe("admin");
    expect(mockLogin).toHaveBeenCalledWith("admin", "demo@libredb.org");
  });

  test("falls back to the lower privilege when DEMO_ROLE is not understood", async () => {
    process.env.DEMO_MODE = "true";
    process.env.DEMO_ROLE = "superuser";

    const data = await parseResponseJSON<{ role: string }>(await post());

    expect(data.role).toBe("user");
  });

  test("surfaces a JWT_SECRET config error as a 503 with its message", async () => {
    process.env.DEMO_MODE = "true";
    const jwtMessage = "Login is unavailable: the server's JWT_SECRET is not configured.";
    mockLogin.mockImplementationOnce(async () => {
      throw new AuthConfigError(jwtMessage);
    });

    const res = await post();
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(503);
    expect(data.message).toBe(jwtMessage);
  });

  test("returns 500 when signing the session fails for an unexpected reason", async () => {
    process.env.DEMO_MODE = "true";
    mockLogin.mockImplementationOnce(async () => {
      throw new Error("cookie store unavailable");
    });

    const res = await post();
    const data = await parseResponseJSON<{ code: string }>(res);

    expect(res.status).toBe(500);
    expect(data.code).toBe("INTERNAL_ERROR");
  });
});
