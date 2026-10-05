/**
 * Control 1.9 (docs/SECURITY.md): a platform launch token signs in only while launch sign-in is configured and
 * never under OIDC, only as HS256 typed libredb-launch+jwt under this server's launch secret for its issuer and
 * audience, issued for at most 60 seconds, and once, even when the replay memory is full; it never replaces a
 * session for another account, never reaches an account that has a password or another platform identity,
 * never signs in a disabled account or demotes the last enabled admin, and the token itself reaches no log
 * line and no audit record.
 *
 * Through the real route, the real verifier and the real store, with nothing mocked but next/headers: each case
 * is a way an attacker who holds a link, a copy of one, or no link at all would try to get a session.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { SignJWT } from "jose";
import { cookieJar, installNextHeadersMock, resetCookieJar } from "../helpers/next-cookie-jar";
import { openStoreFixture, type StoreFixture } from "../helpers/passkey-store-fixture";

installNextHeadersMock();

const { POST } = await import("@/app/api/auth/launch/route");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { resetLaunchConfigWarning } = await import("@/lib/launch/config");
const { claimLaunchJti, clearLaunchReplayState, MAX_REMEMBERED_LAUNCHES } = await import("@/lib/launch/replay");
const { requireAccountStore } = await import("@/lib/local-accounts");

// Built rather than written out, so no literal here reads as a credential to a secret scanner.
const SECRET = "x".repeat(64);
const OTHER_SECRET = "y".repeat(64);
const LAUNCH_TYPE = "libredb-launch+jwt";
const VARS = [
  "LAUNCH_TOKEN_SECRET",
  "LAUNCH_TOKEN_AUDIENCE",
  "LAUNCH_TOKEN_ISSUER",
  "STORAGE_PROVIDER",
  "NEXT_PUBLIC_AUTH_PROVIDER",
] as const;
const saved: Record<string, string | undefined> = {};

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const iat = Math.floor(Date.now() / 1000);
  return {
    iss: "platform",
    aud: "studio-1",
    sub: "platform-user-1",
    email: "member@example.com",
    role: "admin",
    jti: crypto.randomUUID(),
    iat,
    exp: iat + 60,
    ...overrides,
  };
}

function sign(payload: Record<string, unknown>, alg = "HS256", secret = SECRET, typ = LAUNCH_TYPE): Promise<string> {
  return new SignJWT(payload).setProtectedHeader({ alg, typ }).sign(new TextEncoder().encode(secret));
}

/** An unsecured token of the launch type, which UnsecuredJWT cannot produce: it writes no typ. */
function unsigned(payload: Record<string, unknown>): string {
  const head = Buffer.from(JSON.stringify({ alg: "none", typ: LAUNCH_TYPE })).toString("base64url");
  return `${head}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.`;
}

async function launch(token: string): Promise<Response> {
  return POST(
    new Request("http://localhost:3000/api/auth/launch", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
      body: JSON.stringify({ token }),
    }),
  );
}

beforeEach(() => {
  for (const name of VARS) saved[name] = process.env[name];
  delete process.env.STORAGE_PROVIDER;
  process.env.LAUNCH_TOKEN_SECRET = SECRET;
  process.env.LAUNCH_TOKEN_AUDIENCE = "studio-1";
  process.env.LAUNCH_TOKEN_ISSUER = "platform";
  resetCookieJar();
  clearRateLimitState();
  clearLaunchReplayState();
  resetLaunchConfigWarning();
});

afterEach(() => {
  for (const name of VARS) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("a launch token that must not create a session", () => {
  test("any token is refused while launch sign-in is not configured", async () => {
    delete process.env.LAUNCH_TOKEN_SECRET;
    expect((await launch(await sign(claims()))).status).toBe(404);
    expect(cookieJar.get("auth-token")).toBeUndefined();
  });

  test("a valid token signs in nobody under OIDC, where the registry would never see a disable or a role change", async () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await launch(await sign(claims()))).status).toBe(503);
    } finally {
      errorSpy.mockRestore();
    }
    expect(cookieJar.get("auth-token")).toBeUndefined();
  });

  test("a link someone else sends never swaps the session of a browser that is signed in", async () => {
    expect((await launch(await sign(claims()))).status).toBe(200);
    const victim = cookieJar.get("auth-token")?.value;
    const sent = await sign(claims({ email: "attacker@example.com", sub: "platform-user-2" }));
    expect((await launch(sent)).status).toBe(409);
    expect(cookieJar.get("auth-token")?.value).toBe(victim);
    resetCookieJar();
    // Spent by the refusal, so it cannot be tried again once the session is gone.
    expect((await launch(sent)).status).toBe(401);
    expect(cookieJar.get("auth-token")).toBeUndefined();
  });

  test("a token that is unsigned, of another JWT type, signed under another algorithm or under another secret is refused", async () => {
    expect((await launch(unsigned(claims()))).status).toBe(401);
    expect((await launch(await sign(claims(), "HS256", SECRET, "JWT"))).status).toBe(401);
    expect((await launch(await sign(claims(), "HS512"))).status).toBe(401);
    expect((await launch(await sign(claims(), "HS256", OTHER_SECRET))).status).toBe(401);
    expect(cookieJar.get("auth-token")).toBeUndefined();
  });

  test("a token for another Studio, from another issuer or living longer than 60 seconds is refused", async () => {
    expect((await launch(await sign(claims({ aud: "studio-2" })))).status).toBe(401);
    expect((await launch(await sign(claims({ iss: "someone-else" })))).status).toBe(401);
    expect((await launch(await sign(claims({ exp: Math.floor(Date.now() / 1000) + 3600 })))).status).toBe(401);
    expect(cookieJar.get("auth-token")).toBeUndefined();
  });

  test("a captured token cannot be replayed after it signed someone in", async () => {
    const token = await sign(claims());
    expect((await launch(token)).status).toBe(200);
    resetCookieJar();
    expect((await launch(token)).status).toBe(401);
    expect(cookieJar.get("auth-token")).toBeUndefined();
  });

  test("a flood that fills the replay memory refuses new tokens and never frees a spent one for replay", async () => {
    const spent = await sign(claims());
    expect((await launch(spent)).status).toBe(200);
    resetCookieJar();
    // The spent token holds one place, so these fill the rest with launches that could still verify.
    const forgetAfter = Date.now() + 120_000;
    for (let index = 1; index < MAX_REMEMBERED_LAUNCHES; index += 1) claimLaunchJti(`filler-${index}`, forgetAfter);
    expect((await launch(await sign(claims()))).status).toBe(503);
    expect((await launch(spent)).status).toBe(401);
    expect(cookieJar.get("auth-token")).toBeUndefined();
  });
});

describe("the token itself is never written down", () => {
  test("no log line and no audit record carries the token, whether it signs in or is refused", async () => {
    const outputs: string[] = [];
    const record = (...args: unknown[]) => {
      outputs.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(" "));
    };
    const spies = [
      spyOn(console, "log").mockImplementation(record),
      spyOn(console, "info").mockImplementation(record),
      spyOn(console, "warn").mockImplementation(record),
      spyOn(console, "error").mockImplementation(record),
    ];
    const accepted = await sign(claims());
    const refused = await sign(claims(), "HS256", OTHER_SECRET);
    try {
      expect((await launch(accepted)).status).toBe(200);
      expect((await launch(refused)).status).toBe(401);
      expect((await launch(accepted)).status).toBe(401);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(outputs.length).toBeGreaterThan(0);
    for (const output of outputs) {
      expect(output).not.toContain(accepted);
      expect(output).not.toContain(refused);
      expect(output).not.toContain(accepted.split(".")[2]);
    }
  });
});

describe("in the server store", () => {
  let fixture: StoreFixture;

  beforeEach(async () => {
    fixture = await openStoreFixture();
  });

  afterEach(async () => {
    await fixture.close();
  });

  test("a valid token never reaches an account that has a password, the environment admin included", async () => {
    await requireAccountStore();
    // A placeholder, not a credential: a realistic literal here is what secret scanners flag.
    await fixture.createAccount({ email: "member@example.com", password: "password-member", role: "user" });
    expect((await launch(await sign(claims({ role: "admin" })))).status).toBe(403);
    expect((await launch(await sign(claims({ email: "admin@libredb.org", role: "user" })))).status).toBe(403);
    expect(cookieJar.get("auth-token")).toBeUndefined();
    const provider = await fixture.provider();
    expect((await provider.getAccount("member@example.com"))?.role).toBe("user");
    const admin = await provider.getAccount("admin@libredb.org");
    expect(admin?.role).toBe("admin");
    expect(admin?.disabled).toBe(false);
  });

  test("a valid token for a reassigned email never reaches the account of the identity that had it", async () => {
    expect((await launch(await sign(claims()))).status).toBe(200);
    resetCookieJar();
    expect((await launch(await sign(claims({ sub: "platform-user-2" })))).status).toBe(403);
    expect(cookieJar.get("auth-token")).toBeUndefined();
  });

  test("a valid token never signs in a disabled account, whatever role it claims", async () => {
    expect((await launch(await sign(claims({ role: "user" })))).status).toBe(200);
    resetCookieJar();
    const provider = await fixture.provider();
    const current = await provider.getAccount("member@example.com");
    if (!current) throw new Error("account missing");
    await provider.updateAccount(
      { ...current, disabled: true, sessionVersion: current.sessionVersion + 1, updatedAt: new Date().toISOString() },
      { expected: current },
    );
    expect((await launch(await sign(claims({ role: "admin" })))).status).toBe(401);
    expect(cookieJar.get("auth-token")).toBeUndefined();
    expect((await provider.getAccount("member@example.com"))?.disabled).toBe(true);
  });

  test("a valid token never leaves the registry without an enabled admin", async () => {
    expect((await launch(await sign(claims({ role: "admin" })))).status).toBe(200);
    resetCookieJar();
    const provider = await fixture.provider();
    const admin = await provider.getAccount("admin@libredb.org");
    if (!admin) throw new Error("the seeded admin is missing");
    await provider.updateAccount(
      { ...admin, disabled: true, sessionVersion: admin.sessionVersion + 1, updatedAt: new Date().toISOString() },
      { expected: admin },
    );
    expect((await launch(await sign(claims({ role: "user" })))).status).toBe(409);
    expect(cookieJar.get("auth-token")).toBeUndefined();
    const launched = await provider.getAccount("member@example.com");
    expect(launched?.role).toBe("admin");
    expect(launched?.disabled).toBe(false);
  });
});
