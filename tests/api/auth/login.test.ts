import { describe, test, expect, mock, spyOn, beforeEach, afterEach } from "bun:test";
import { createMockRequest, parseResponseJSON } from "../../helpers/mock-next";
import { AuthConfigError } from "@/lib/auth-errors";
import { clearRateLimitState } from "@/lib/api/rate-limit";

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
const { POST } = await import("@/app/api/auth/login/route");

// ─── Tests ──────────────────────────────────────────────────────────────────
describe("POST /api/auth/login", () => {
  // Snapshot the env vars these tests mutate and always restore them in
  // afterEach — so a failing assertion mid-test can never leak env state into
  // later tests (a plain restore() at the end of a test body would be skipped
  // when an earlier expect() throws).
  const MUTATED_ENV_KEYS = ["ADMIN_PASSWORD", "USER_PASSWORD"] as const;
  const envSnapshot: Record<string, string | undefined> = {};

  beforeEach(() => {
    clearRateLimitState();
    mockLogin.mockClear();
    for (const key of MUTATED_ENV_KEYS) envSnapshot[key] = process.env[key];
  });

  afterEach(() => {
    // Delete-on-undefined so an originally-unset var is never set to the literal string "undefined".
    for (const key of MUTATED_ENV_KEYS) {
      const value = envSnapshot[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  test("returns 200 with role admin when admin credentials are provided", async () => {
    const req = createMockRequest("/api/auth/login", {
      method: "POST",
      body: { email: "admin@libredb.org", password: "LibreDB.2026" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; role: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.role).toBe("admin");
  });

  test("returns 200 with role user when user credentials are provided", async () => {
    const req = createMockRequest("/api/auth/login", {
      method: "POST",
      body: { email: "user@libredb.org", password: "LibreDB.2026" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; role: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.role).toBe("user");
  });

  test("returns 401 when wrong password is provided", async () => {
    const req = createMockRequest("/api/auth/login", {
      method: "POST",
      body: { email: "admin@libredb.org", password: "wrong-password" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(401);
    expect(data.success).toBe(false);
    expect(data.message).toBe("Invalid email or password");
  });

  test("returns 401 when wrong email is provided", async () => {
    const req = createMockRequest("/api/auth/login", {
      method: "POST",
      body: { email: "unknown@example.com", password: "LibreDB.2026" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(401);
    expect(data.success).toBe(false);
    expect(data.message).toBe("Invalid email or password");
  });

  test("returns 401 when empty credentials are provided", async () => {
    const req = createMockRequest("/api/auth/login", {
      method: "POST",
      body: { email: "", password: "" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(401);
    expect(data.success).toBe(false);
    expect(data.message).toBe("Invalid email or password");
  });

  test("returns 400, not 500, when body is not valid JSON", async () => {
    const req = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

    // A malformed body is a client error, not a server error - it never reached credential
    // comparison, so the uniform-failure property below does not apply to it.
    expect(res.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.message).toBe("Invalid request body");
  });

  test("returns 400, not 500, when body is empty", async () => {
    const req = new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "",
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.message).toBe("Invalid request body");
  });

  test("repeated malformed bodies from one address are eventually refused, not answered indefinitely", async () => {
    const malformed = () =>
      new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.201" },
        body: "not-json",
      });

    // RATE_LIMIT_LOGIN_MAX defaults to 5: the first five spend the client bucket (one per
    // malformed body, the same budget a wrong password would spend), the sixth trips it.
    for (let i = 0; i < 5; i += 1) {
      const res = await POST(malformed() as never);
      expect(res.status).toBe(400);
    }

    const res = await POST(malformed() as never);
    const data = await parseResponseJSON<{ error: string; code: string }>(res);

    expect(res.status).toBe(429);
    expect(data.code).toBe("RATE_LIMITED");
  });

  // The malformed body's audit-line content and its bounded-log-volume property are covered in
  // tests/security/login-enumeration.test.ts ("what the audit trail records"), not here: that
  // suite runs as its own bun process, isolated from tests/api/db/maintenance.test.ts's
  // mock.module("@/lib/audit", ...) stub (an incomplete getServerAuditBuffer with no .getAll) -
  // mock.module is process-wide, and this file shares a process with that stub whenever `bun run
  // test` runs tests/unit, tests/api and tests/integration together.

  test("still returns 400 when the login_failure audit emit throws for a malformed body", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    try {
      const req = new Request("http://localhost:3000/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "not-json",
      });

      const res = await POST(req as never);
      const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

      expect(res.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.message).toBe("Invalid request body");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("calls login() with role and email for admin", async () => {
    const req = createMockRequest("/api/auth/login", {
      method: "POST",
      body: { email: "admin@libredb.org", password: "LibreDB.2026" },
    });

    await POST(req as never);

    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(mockLogin).toHaveBeenCalledWith("admin", "admin@libredb.org");
  });

  test("calls login() with role and email for user", async () => {
    const req = createMockRequest("/api/auth/login", {
      method: "POST",
      body: { email: "user@libredb.org", password: "LibreDB.2026" },
    });

    await POST(req as never);

    expect(mockLogin).toHaveBeenCalledTimes(1);
    expect(mockLogin).toHaveBeenCalledWith("user", "user@libredb.org");
  });

  test("returns 503 with an actionable message when ADMIN_PASSWORD is missing", async () => {
    delete process.env.ADMIN_PASSWORD;

    const req = createMockRequest("/api/auth/login", {
      method: "POST",
      body: { email: "admin@libredb.org", password: "LibreDB.2026" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

    // A misconfiguration is an operator error, not bad credentials: it must be
    // clearly distinguishable (503) and carry a message the login screen shows
    // via `data.message` — never the misleading "Invalid email or password".
    expect(res.status).toBe(503);
    expect(data.success).toBe(false);
    expect(data.message).toContain("ADMIN_PASSWORD");
    expect(data.message).not.toBe("Invalid email or password");
  });

  test("surfaces a JWT_SECRET config error as a 503 with its message (credentials are valid)", async () => {
    // Credentials match, but signing the session fails because JWT_SECRET is
    // missing/too short: login() throws AuthConfigError. The route must surface
    // that actionable message, not the misleading "Invalid email or password".
    const jwtMessage =
      "Login is unavailable: the server's JWT_SECRET is not configured. " +
      "Set JWT_SECRET (at least 32 characters) and restart the server.";
    mockLogin.mockImplementationOnce(async () => {
      throw new AuthConfigError(jwtMessage);
    });

    const req = createMockRequest("/api/auth/login", {
      method: "POST",
      body: { email: "admin@libredb.org", password: "LibreDB.2026" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(503);
    expect(data.success).toBe(false);
    expect(data.message).toBe(jwtMessage);
    expect(data.message).not.toBe("Invalid email or password");
  });

  test("still authenticates admin when USER_PASSWORD is not set", async () => {
    delete process.env.USER_PASSWORD;

    const req = createMockRequest("/api/auth/login", {
      method: "POST",
      body: { email: "admin@libredb.org", password: "LibreDB.2026" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; role: string }>(res);

    expect(res.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.role).toBe("admin");
  });

  test("still returns 200 and success when the login_success audit emit throws", async () => {
    // Isolated in its own try/catch, matching logout and the OIDC callback: a real session has
    // already been created by this point (login() succeeded, the cookie is set), so a broken
    // audit sink must never turn that into a 500 for a user who is in fact logged in.
    const logSpy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    try {
      const req = createMockRequest("/api/auth/login", {
        method: "POST",
        body: { email: "admin@libredb.org", password: "LibreDB.2026" },
      });

      const res = await POST(req as never);
      const data = await parseResponseJSON<{ success: boolean; role: string }>(res);

      expect(res.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.role).toBe("admin");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("still returns 429 when the rate_limit_exceeded audit emit throws", async () => {
    // Trip login_client first (default max 5) with a broken console.log, then confirm the 429
    // itself still arrives rather than degrading to a 500.
    for (let i = 0; i < 5; i += 1) {
      const req = createMockRequest("/api/auth/login", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.77" },
        body: { email: "admin@libredb.org", password: "wrong" },
      });
      await POST(req as never);
    }

    const logSpy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    try {
      const req = createMockRequest("/api/auth/login", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.77" },
        body: { email: "admin@libredb.org", password: "wrong" },
      });

      const res = await POST(req as never);

      expect(res.status).toBe(429);
    } finally {
      logSpy.mockRestore();
    }
  });

  test("still returns 401 when the login_failure audit emit throws", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    try {
      const req = createMockRequest("/api/auth/login", {
        method: "POST",
        body: { email: "admin@libredb.org", password: "wrong-password" },
      });

      const res = await POST(req as never);
      const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

      expect(res.status).toBe(401);
      expect(data.success).toBe(false);
      expect(data.message).toBe("Invalid email or password");
    } finally {
      logSpy.mockRestore();
    }
  });

  test("rejects user login when USER_PASSWORD is not set (account is optional, no default)", async () => {
    delete process.env.USER_PASSWORD;

    const req = createMockRequest("/api/auth/login", {
      method: "POST",
      body: { email: "user@libredb.org", password: "LibreDB.2026" },
    });

    const res = await POST(req as never);
    const data = await parseResponseJSON<{ success: boolean; message: string }>(res);

    expect(res.status).toBe(401);
    expect(data.success).toBe(false);
    expect(data.message).toBe("Invalid email or password");
  });
});
