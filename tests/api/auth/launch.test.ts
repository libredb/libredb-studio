/**
 * POST /api/auth/launch: exchanges a platform launch token for the same session cookie a password sign-in
 * sets (docs/LAUNCH.md). The token rules themselves are tests/unit/lib/launch/verify.test.ts; this file
 * holds the route's answers, its budget, its audit events and the three storage modes.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SignJWT } from "jose";
import { cookieJar, installNextHeadersMock, resetCookieJar } from "../../helpers/next-cookie-jar";
import { openStoreFixture, type StoreFixture } from "../../helpers/passkey-store-fixture";

installNextHeadersMock();

const { POST } = await import("@/app/api/auth/launch/route");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { getServerAuditBuffer } = await import("@/lib/audit");
const { getSession, verifyJWT } = await import("@/lib/auth");
const { resetLaunchConfigWarning } = await import("@/lib/launch/config");
const { claimLaunchJti, clearLaunchReplayState, MAX_REMEMBERED_LAUNCHES } = await import("@/lib/launch/replay");
const { requireAccountStore } = await import("@/lib/local-accounts");

const ROUTE = "POST /api/auth/launch";
// Built rather than written out, so no literal here reads as a credential to a secret scanner.
const SECRET = "l".repeat(48);
const MEMBER = "member@example.com";
// A placeholder, not a credential: a realistic literal here is what secret scanners flag.
const MEMBER_PASSWORD = "password-member";
const VARS = [
  "LAUNCH_TOKEN_SECRET",
  "LAUNCH_TOKEN_AUDIENCE",
  "LAUNCH_TOKEN_ISSUER",
  "STORAGE_PROVIDER",
  "NEXT_PUBLIC_AUTH_PROVIDER",
] as const;
const saved: Record<string, string | undefined> = {};
const NOT_LINKED =
  "This email belongs to a Studio account that a launch link cannot sign in to. Sign in with that account's password, or ask a Studio admin.";

let addressCounter = 0;

/** A fresh documentation-range address, so a case starts with an unspent budget unless it reuses one. */
function freshAddress(): string {
  addressCounter += 1;
  return `203.0.113.${addressCounter}`;
}

function enableLaunch(): void {
  process.env.LAUNCH_TOKEN_SECRET = SECRET;
  process.env.LAUNCH_TOKEN_AUDIENCE = "studio-1";
  process.env.LAUNCH_TOKEN_ISSUER = "platform";
}

async function mint(overrides: Record<string, unknown> = {}): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: "platform",
    aud: "studio-1",
    sub: "platform-user-1",
    email: MEMBER,
    role: "user",
    conn: "orders-db",
    jti: crypto.randomUUID(),
    iat,
    exp: iat + 60,
    ...overrides,
  })
    .setProtectedHeader({ alg: "HS256", typ: "libredb-launch+jwt" })
    .sign(new TextEncoder().encode(SECRET));
}

function request(body: unknown, ip: string, raw?: string): Request {
  return new Request("http://localhost:3000/api/auth/launch", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: raw ?? JSON.stringify(body),
  });
}

async function send(body: unknown, ip: string, raw?: string): Promise<Response> {
  const response = await POST(request(body, ip, raw));
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return response;
}

async function expectInvalidBody(body: unknown): Promise<void> {
  const response = await send(body, freshAddress());
  expect(response.status).toBe(400);
  expect((await response.json()).message).toBe("Invalid request body");
}

async function expectNotLinked(token: string): Promise<void> {
  const response = await send({ token }, freshAddress());
  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ success: false, message: NOT_LINKED });
}

function routeEvents() {
  return getServerAuditBuffer()
    .getAll()
    .filter((event) => event.target === ROUTE);
}

beforeEach(() => {
  for (const name of VARS) saved[name] = process.env[name];
  delete process.env.STORAGE_PROVIDER;
  enableLaunch();
  resetCookieJar();
  clearRateLimitState();
  clearLaunchReplayState();
  resetLaunchConfigWarning();
  getServerAuditBuffer().clear();
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("POST /api/auth/launch configuration", () => {
  test("answers 404 while launch sign-in is off, before any budget or audit", async () => {
    delete process.env.LAUNCH_TOKEN_SECRET;
    const response = await send({ token: await mint() }, freshAddress());
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      success: false,
      message: "Launch sign-in is not enabled on this server.",
    });
    expect(routeEvents()).toEqual([]);
  });

  test("answers 503 with the problem while the configuration is broken", async () => {
    process.env.LAUNCH_TOKEN_SECRET = "too-short";
    const response = await send({ token: await mint() }, freshAddress());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      success: false,
      message: "LAUNCH_TOKEN_SECRET must be at least 32 characters: launch sign-in is unavailable until it is fixed.",
    });
    expect(routeEvents()).toEqual([]);
  });

  test("answers 503 when LAUNCH_TOKEN_SECRET equals JWT_SECRET, and signs in nobody", async () => {
    const jwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = SECRET;
    try {
      const response = await send({ token: await mint() }, freshAddress());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        success: false,
        message:
          "LAUNCH_TOKEN_SECRET must differ from the key that signs sessions (JWT_SECRET): launch sign-in is unavailable until it does.",
      });
    } finally {
      if (jwtSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = jwtSecret;
    }
    expect(cookieJar.get("auth-token")).toBeUndefined();
    expect(routeEvents()).toEqual([]);
  });

  test("answers 503 under NEXT_PUBLIC_AUTH_PROVIDER=oidc, signs in nobody and records nothing", async () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await send({ token: await mint() }, freshAddress());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        success: false,
        message: "Launch sign-in is not available when NEXT_PUBLIC_AUTH_PROVIDER=oidc.",
      });
    } finally {
      errorSpy.mockRestore();
    }
    expect(cookieJar.get("auth-token")).toBeUndefined();
    expect(routeEvents()).toEqual([]);
  });
});

describe("POST /api/auth/launch with a malformed body", () => {
  test("answers 400 for a body that is not JSON, and records it", async () => {
    const response = await send(null, freshAddress(), "not-json");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ success: false, message: "Invalid request body" });
    expect(routeEvents()).toEqual([
      expect.objectContaining({ type: "login_failure", user: "anonymous", reason: "malformed_body" }),
    ]);
  });

  test("answers 400 for a body without a non-empty string token", async () => {
    await expectInvalidBody({});
    await expectInvalidBody({ token: "" });
    await expectInvalidBody({ token: 42 });
    await expectInvalidBody(["token"]);
  });

  test("answers 413 for a body over 8192 bytes", async () => {
    const response = await send({ token: "t".repeat(9000) }, freshAddress());
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ success: false, message: "Request body is too large" });
  });
});

describe("POST /api/auth/launch with a refused token", () => {
  test("answers 401 with the refusal's own message and records its reason against no one", async () => {
    const response = await send({ token: await mint({ aud: "studio-2" }) }, freshAddress());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      message: "This launch link was issued for a different Studio.",
    });
    expect(cookieJar.get("auth-token")).toBeUndefined();
    expect(routeEvents()).toEqual([
      expect.objectContaining({
        type: "login_failure",
        action: "login",
        user: "anonymous",
        result: "failure",
        reason: "launch_token_audience",
      }),
    ]);
  });

  test("a token issued 30 seconds ahead of this server's clock is refused with the clock message", async () => {
    const ahead = Math.floor(Date.now() / 1000) + 30;
    const response = await send({ token: await mint({ iat: ahead, exp: ahead + 60 }) }, freshAddress());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      message: "This launch link is not valid yet: the clocks of the platform and this Studio disagree.",
    });
    expect(cookieJar.get("auth-token")).toBeUndefined();
    expect(routeEvents()).toEqual([
      expect.objectContaining({ type: "login_failure", user: "anonymous", reason: "launch_token_premature" }),
    ]);
  });

  test("a valid token answers 503 while the replay memory is full, and signs in nobody", async () => {
    const forgetAfter = Date.now() + 120_000;
    for (let index = 0; index < MAX_REMEMBERED_LAUNCHES; index += 1) claimLaunchJti(`filler-${index}`, forgetAfter);
    const response = await send({ token: await mint() }, freshAddress());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      success: false,
      message: "Too many launches arrived at this Studio in the last minute. Wait a minute, then open Studio again.",
    });
    expect(cookieJar.get("auth-token")).toBeUndefined();
    expect(routeEvents()).toEqual([
      expect.objectContaining({ type: "login_failure", user: "anonymous", reason: "launch_capacity_exceeded" }),
    ]);
  });

  test("a token presented twice signs in once", async () => {
    const token = await mint();
    expect((await send({ token }, freshAddress())).status).toBe(200);
    const replay = await send({ token }, freshAddress());
    expect(replay.status).toBe(401);
    expect((await replay.json()).message).toBe(
      "This launch link has already been used. Open Studio again to get a new one.",
    );
    expect(routeEvents().map((event) => event.reason)).toEqual([undefined, "launch_token_replayed"]);
  });
});

describe("POST /api/auth/launch signs in", () => {
  test("with the requested connection, as the token's email and role, without a store", async () => {
    const response = await send({ token: await mint() }, freshAddress());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      redirect: "/?connection=seed%3Aorders-db",
    });
    const session = await verifyJWT(cookieJar.get("auth-token")?.value as string);
    expect(session?.role).toBe("user");
    expect(session?.username).toBe(MEMBER);
    expect(session?.sessionVersion).toBeUndefined();
    expect(routeEvents()).toEqual([
      expect.objectContaining({ type: "login_success", action: "login", user: MEMBER, result: "success" }),
    ]);
  });

  test("to the editor when the token names no connection", async () => {
    const response = await send({ token: await mint({ conn: undefined, role: "admin" }) }, freshAddress());
    expect(await response.json()).toEqual({ success: true, redirect: "/" });
    expect((await verifyJWT(cookieJar.get("auth-token")?.value as string))?.role).toBe("admin");
  });

  test("a success clears the address's failures", async () => {
    const ip = freshAddress();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- the limiter counts refusals one by one, so each must land before the next.
      expect((await send({ token: await mint({ aud: "studio-2" }) }, ip)).status).toBe(401);
    }
    expect((await send({ token: await mint() }, ip)).status).toBe(200);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- the limiter counts refusals one by one, so each must land before the next.
      expect((await send({ token: await mint({ aud: "studio-2" }) }, ip)).status).toBe(401);
    }
  });
});

describe("POST /api/auth/launch budget", () => {
  test("the sixth refusal from one address within the window answers 429 before the body is read", async () => {
    const ip = freshAddress();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop -- the limiter counts refusals one by one, so each must land before the next.
      expect((await send({ token: await mint({ aud: "studio-2" }) }, ip)).status).toBe(401);
    }
    const token = await mint();
    const response = await send({ token }, ip);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).not.toBeNull();
    expect((await response.json()).code).toBe("RATE_LIMITED");
    expect(cookieJar.get("auth-token")).toBeUndefined();
    // The token was never verified, so its jti is unspent: once the budget is cleared, it still signs in.
    clearRateLimitState();
    expect((await send({ token }, ip)).status).toBe(200);
  });
});

describe("POST /api/auth/launch without a server store", () => {
  test("refuses the ADMIN_EMAIL address in any letter case with 403, because it signs in with a password", async () => {
    const response = await send({ token: await mint({ email: "Admin@LibreDB.org", role: "admin" }) }, freshAddress());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ success: false, message: NOT_LINKED });
    expect(cookieJar.get("auth-token")).toBeUndefined();
    expect(routeEvents()).toEqual([
      expect.objectContaining({ type: "login_failure", user: "Admin@LibreDB.org", reason: "launch_identity_mismatch" }),
    ]);
  });
});

describe("POST /api/auth/launch in the server store", () => {
  let fixture: StoreFixture;

  beforeEach(async () => {
    fixture = await openStoreFixture();
  });

  afterEach(async () => {
    await fixture.close();
  });

  test("provisions the account and signs in with its stored session version", async () => {
    const response = await send({ token: await mint() }, freshAddress());
    expect(response.status).toBe(200);
    const row = await (await fixture.provider()).getAccount(MEMBER);
    expect(row?.role).toBe("user");
    const session = await getSession();
    expect(session?.username).toBe(MEMBER);
    expect(session?.sessionVersion).toBe(row?.sessionVersion as number);
  });

  test("signs the launched account in again when the token's email differs only in letter case", async () => {
    const provider = await requireAccountStore();
    expect((await send({ token: await mint() }, freshAddress())).status).toBe(200);
    const created = await provider.getAccount(MEMBER);
    const response = await send({ token: await mint({ email: "Member@Example.COM" }) }, freshAddress());
    expect(response.status).toBe(200);
    const session = await getSession();
    expect(session?.username).toBe(MEMBER);
    expect(session?.sessionVersion).toBe(created?.sessionVersion as number);
    // The store keys accounts by the exact email, so a case-sensitive lookup would have inserted a second row here.
    const sameAddress = (await provider.listAccounts()).filter((account) => account.email.toLowerCase() === MEMBER);
    expect(sameAddress.map((account) => account.email)).toEqual([MEMBER]);
    expect(routeEvents().map((event) => [event.type, event.user])).toEqual([
      ["login_success", MEMBER],
      ["login_success", MEMBER],
    ]);
  });

  test("refuses an account that signs in with a password, the environment admin included, with 403", async () => {
    await requireAccountStore();
    await fixture.createAccount({ email: MEMBER, password: MEMBER_PASSWORD, role: "user" });
    await expectNotLinked(await mint());
    await expectNotLinked(await mint({ email: "admin@libredb.org", role: "admin" }));
    expect(cookieJar.get("auth-token")).toBeUndefined();
    expect(routeEvents()).toEqual([
      expect.objectContaining({ type: "login_failure", user: MEMBER, reason: "launch_identity_mismatch" }),
      expect.objectContaining({ type: "login_failure", user: "admin@libredb.org", reason: "launch_identity_mismatch" }),
    ]);
  });

  test("refuses the same email launched for another platform identity", async () => {
    expect((await send({ token: await mint() }, freshAddress())).status).toBe(200);
    resetCookieJar();
    const response = await send({ token: await mint({ sub: "platform-user-2" }) }, freshAddress());
    expect(response.status).toBe(403);
    expect(cookieJar.get("auth-token")).toBeUndefined();
  });

  test("refuses a disabled account with 401 and records it against that account", async () => {
    expect((await send({ token: await mint() }, freshAddress())).status).toBe(200);
    const provider = await fixture.provider();
    const current = await provider.getAccount(MEMBER);
    if (!current) throw new Error("account missing");
    await provider.updateAccount(
      { ...current, disabled: true, sessionVersion: current.sessionVersion + 1, updatedAt: new Date().toISOString() },
      { expected: current },
    );
    getServerAuditBuffer().clear();
    // The cookie the first launch set now names a disabled account, so getSession clears it before provisioning.
    const response = await send({ token: await mint() }, freshAddress());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      success: false,
      message: "This account is disabled in Studio. Ask a Studio admin to enable it.",
    });
    expect(cookieJar.get("auth-token")).toBeUndefined();
    expect(routeEvents()).toEqual([
      expect.objectContaining({ type: "login_failure", user: MEMBER, reason: "launch_account_disabled" }),
    ]);
  });

  test("a user token for the last enabled admin answers 409, demotes nothing and opens no session", async () => {
    const provider = await requireAccountStore();
    expect((await send({ token: await mint({ role: "admin" }) }, freshAddress())).status).toBe(200);
    const admin = await provider.getAccount("admin@libredb.org");
    if (!admin) throw new Error("the seeded admin is missing");
    await provider.updateAccount(
      { ...admin, disabled: true, sessionVersion: admin.sessionVersion + 1, updatedAt: new Date().toISOString() },
      { expected: admin },
    );
    const before = await provider.getAccount(MEMBER);
    resetCookieJar();
    getServerAuditBuffer().clear();
    const response = await send({ token: await mint({ role: "user" }) }, freshAddress());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      message:
        "Studio did not make this account a user, because it is the last enabled admin. Ask a Studio admin to make another account an admin first.",
    });
    expect(cookieJar.get("auth-token")).toBeUndefined();
    expect(await getSession()).toBeNull();
    expect(await provider.getAccount(MEMBER)).toEqual(before);
    expect(routeEvents()).toEqual([
      expect.objectContaining({ type: "login_failure", user: MEMBER, reason: "account_refused" }),
    ]);
  });

  test("answers 500 without a session when the store fails", async () => {
    const provider = await fixture.provider();
    const failing = spyOn(provider, "listAccounts").mockImplementation(async () => {
      throw new Error("database is locked");
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await send({ token: await mint() }, freshAddress());
      expect(response.status).toBe(500);
      expect(cookieJar.get("auth-token")).toBeUndefined();
    } finally {
      failing.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe("POST /api/auth/launch in a browser that is already signed in", () => {
  const OTHER = "other@example.com";

  test("does not replace a session for another account: 409 naming both, the session kept and the token spent", async () => {
    expect((await send({ token: await mint() }, freshAddress())).status).toBe(200);
    const kept = cookieJar.get("auth-token")?.value;
    getServerAuditBuffer().clear();
    const token = await mint({ email: OTHER, sub: "platform-user-2" });
    const response = await send({ token }, freshAddress());
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      success: false,
      message: `This browser is already signed in to Studio as ${MEMBER}, and this launch link is for ${OTHER}. Sign out, then open Studio again from the platform to continue as ${OTHER}.`,
      signedInAs: MEMBER,
      launchFor: OTHER,
    });
    expect(cookieJar.get("auth-token")?.value).toBe(kept);
    expect(routeEvents()).toEqual([
      expect.objectContaining({ type: "login_failure", user: OTHER, reason: "launch_session_conflict" }),
    ]);
    resetCookieJar();
    const replay = await send({ token }, freshAddress());
    expect(replay.status).toBe(401);
    expect((await replay.json()).message).toBe(
      "This launch link has already been used. Open Studio again to get a new one.",
    );
  });

  test("refreshes the session of the account it names, whatever the letter case", async () => {
    expect((await send({ token: await mint({ role: "user" }) }, freshAddress())).status).toBe(200);
    const response = await send({ token: await mint({ email: "MEMBER@example.com", role: "admin" }) }, freshAddress());
    expect(response.status).toBe(200);
    const session = await verifyJWT(cookieJar.get("auth-token")?.value as string);
    expect(session?.username).toBe("MEMBER@example.com");
    expect(session?.role).toBe("admin");
  });
});

describe("POST /api/auth/launch server faults", () => {
  test("answers 503 with the configuration message when sessions cannot be signed", async () => {
    const jwtSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "too-short";
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await send({ token: await mint() }, freshAddress());
      expect(response.status).toBe(503);
      expect((await response.json()).message).toContain("JWT_SECRET is too short");
    } finally {
      if (jwtSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = jwtSecret;
      errorSpy.mockRestore();
    }
  });

  test("a broken audit sink changes neither a success nor a refusal", async () => {
    const logSpy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await send({ token: await mint() }, freshAddress())).status).toBe(200);
      expect((await send({ token: await mint({ aud: "studio-2" }) }, freshAddress())).status).toBe(401);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
