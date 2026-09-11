import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { clearTotpReplayState } from "@/lib/totp";
import { RFC6238_SECRET } from "../helpers/rfc6238";

/**
 * Control 1.6. Threat: an attacker who already holds a working password — leaked, reused from
 * another breach, or read out of a `docker inspect`.
 *
 * Two properties, and the whole control is worth nothing without both:
 *   1. The password alone never produces a session. Not a session with reduced scope, not a
 *      session pending verification: no `login()` call at all.
 *   2. An accepted code cannot be presented twice. A code is valid for up to 90 seconds across
 *      the skew window, so without this a code captured in transit — a phishing proxy, a logged
 *      request body, a shoulder-surf — is a second, replayable credential.
 *
 * A third property is asserted negatively: the "code required" reply must stay unreachable
 * without the password, or it would undo the uniform 401 that control 1.5 exists to guarantee.
 */

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const mockLogin = mock(async (_role: string, _email?: string) => {});

mock.module("@/lib/auth", () => ({
  login: mockLogin,
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  getSession: mock(async () => null),
  logout: mock(async () => {}),
}));

const { POST } = await import("@/app/api/auth/login/route");

/** RFC 6238 Appendix B seed; "287082" is its six-digit code for the step containing T=59. */
const SECRET = RFC6238_SECRET;
const CODE = "287082";
const PASSWORD = "correct-horse-battery-staple";
const FROZEN_NOW = 59_000;

interface LoginBody {
  success: boolean;
  message: string;
  mfaRequired?: boolean;
}

function attempt(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.90" },
      body: JSON.stringify(body),
    }) as never,
  );
}

async function read(res: Response): Promise<LoginBody> {
  return (await res.json()) as LoginBody;
}

describe("control 1.6 — a password alone does not open a TOTP-protected account", () => {
  const ENV_KEYS = ["ADMIN_PASSWORD", "USER_PASSWORD", "ADMIN_TOTP_SECRET", "USER_TOTP_SECRET"] as const;
  const snapshot: Record<string, string | undefined> = {};
  let nowSpy: ReturnType<typeof spyOn<DateConstructor, "now">>;
  let logSpy: ReturnType<typeof spyOn<Console, "log">>;

  beforeEach(() => {
    for (const key of ENV_KEYS) snapshot[key] = process.env[key];
    process.env.ADMIN_PASSWORD = PASSWORD;
    delete process.env.USER_PASSWORD;
    delete process.env.USER_TOTP_SECRET;
    process.env.ADMIN_TOTP_SECRET = SECRET;
    // Both the code check and the replay guard read the wall clock, so the flow is pinned to the
    // instant the published vector is valid at.
    nowSpy = spyOn(Date, "now").mockReturnValue(FROZEN_NOW);
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    clearRateLimitState();
    clearTotpReplayState();
    mockLogin.mockClear();
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = snapshot[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    nowSpy.mockRestore();
    logSpy.mockRestore();
    clearRateLimitState();
    clearTotpReplayState();
  });

  test("the correct password on its own creates no session", async () => {
    const res = await attempt({ email: "admin@libredb.org", password: PASSWORD });

    expect(res.status).toBe(401);
    expect(mockLogin).not.toHaveBeenCalled();
  });

  test("a guessed code creates no session", async () => {
    for (const guess of ["000000", "111111", "287081"]) {
      const res = await attempt({ email: "admin@libredb.org", password: PASSWORD, totp: guess });
      expect(res.status).toBe(401);
    }

    expect(mockLogin).not.toHaveBeenCalled();
  });

  test("an accepted code cannot be presented a second time", async () => {
    const first = await attempt({ email: "admin@libredb.org", password: PASSWORD, totp: CODE });
    expect(first.status).toBe(200);

    const replay = await attempt({ email: "admin@libredb.org", password: PASSWORD, totp: CODE });

    expect(replay.status).toBe(401);
    expect((await read(replay)).message).toBe("Invalid authentication code");
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  test("the replay guard survives the skew window that made the code replayable", async () => {
    expect((await attempt({ email: "admin@libredb.org", password: PASSWORD, totp: CODE })).status).toBe(200);

    // One step later the same code is still within the accepted window - which is exactly the
    // interval a captured code would otherwise stay usable for.
    nowSpy.mockReturnValue(FROZEN_NOW + 30_000);
    const replay = await attempt({ email: "admin@libredb.org", password: PASSWORD, totp: CODE });

    expect(replay.status).toBe(401);
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });

  test("the second-factor reply stays unreachable without the password (control 1.5 holds)", async () => {
    const wrongPassword = await read(await attempt({ email: "admin@libredb.org", password: "guess" }));
    const unknownEmail = await read(await attempt({ email: "nobody@example.com", password: "guess" }));

    // Byte-identical, and neither admits that this deployment has a second factor at all.
    expect(wrongPassword).toEqual(unknownEmail);
    expect(wrongPassword.mfaRequired).toBeUndefined();
    expect(wrongPassword.message).toBe("Invalid email or password");
  });

  test("an account with no secret configured is unaffected", async () => {
    delete process.env.ADMIN_TOTP_SECRET;

    const res = await attempt({ email: "admin@libredb.org", password: PASSWORD });

    expect(res.status).toBe(200);
    expect(mockLogin).toHaveBeenCalledTimes(1);
  });
});
