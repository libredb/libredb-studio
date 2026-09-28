/**
 * The anonymous passkey sign-in route: its own
 * budget, one uniform refusal that sends the user to the password, and the same session minting as a password
 * sign-in.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AuthenticationResponseJSON } from "@simplewebauthn/server";
import Database from "better-sqlite3";
import { cookieJar, installNextHeadersMock, resetCookieJar } from "../../helpers/next-cookie-jar";
import { type AssertionOverrides, SoftAuthenticator } from "../../helpers/passkey-authenticator";
import { openStoreFixture, PASSKEY_TEST_ORIGIN, type StoreFixture } from "../../helpers/passkey-store-fixture";
import { totpCodeFor } from "../../helpers/rfc6238";

installNextHeadersMock();

const { POST } = await import("@/app/api/auth/passkey/sign-in/route");
const { POST: passwordLogin } = await import("@/app/api/auth/login/route");
const { beginPasskeyRegistration, completePasskeyRegistration } = await import("@/lib/passkey/management");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { getServerAuditBuffer } = await import("@/lib/audit");
const { getSession, verifyJWT } = await import("@/lib/auth");

const ROUTE = "POST /api/auth/passkey/sign-in";
const SIGN_IN_COOKIE = "passkey-sign-in";
const SIGN_IN_FAILED =
  "That passkey could not sign you in. If it was removed from Studio, delete it from your password manager too. Sign in with your password.";
// A placeholder, not a credential.
const PASSWORD = "password-owner";

let fixture: StoreFixture;
let addressCounter = 0;

/** A fresh documentation-range address, so a case starts with an unspent budget unless it reuses one. */
function freshAddress(): string {
  addressCounter += 1;
  return `198.51.${Math.floor(addressCounter / 250)}.${(addressCounter % 250) + 1}`;
}

beforeEach(async () => {
  resetCookieJar();
  clearRateLimitState();
  getServerAuditBuffer().clear();
  fixture = await openStoreFixture();
});

afterEach(async () => {
  await fixture.close();
  resetCookieJar();
  clearRateLimitState();
});

function request(body: unknown, ip: string, raw?: string): Request {
  return new Request(`${PASSKEY_TEST_ORIGIN}/api/auth/passkey/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: raw ?? JSON.stringify(body),
  });
}

async function send(body: unknown, ip: string, raw?: string): Promise<Response> {
  const response = await POST(request(body, ip, raw) as never);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  return response;
}

interface Owner {
  email: string;
  authenticator: SoftAuthenticator;
  passkeyId: string;
}

/** Creates an account and registers a passkey for it through the management service. */
async function enrol(input: { role?: "admin" | "user"; totpSecret?: string } = {}): Promise<Owner> {
  const email = `owner-${randomUUID()}@example.com`;
  const account = await fixture.createAccount({
    email,
    password: PASSWORD,
    role: input.role ?? "user",
    totpSecret: input.totpSecret,
  });
  const session = { role: account.role, username: email, sessionVersion: account.sessionVersion };
  const code = input.totpSecret ? { code: totpCodeFor(input.totpSecret, Date.now()) } : {};
  const options = await beginPasskeyRegistration(session, { password: PASSWORD, ...code });
  const authenticator = await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN });
  const response = await authenticator.register(options);
  const passkey = await completePasskeyRegistration(session, { response });
  cookieJar.clear();
  return { email, authenticator, passkeyId: passkey.id };
}

/** Starts a ceremony through the route and answers it with the authenticator. */
async function assertion(
  authenticator: SoftAuthenticator,
  ip: string,
  overrides: AssertionOverrides = {},
): Promise<{ response: AuthenticationResponseJSON; cookie: string }> {
  const started = await send({ action: "options" }, ip);
  expect(started.status).toBe(200);
  const { options } = await started.json();
  const cookie = cookieJar.get(SIGN_IN_COOKIE)?.value as string;
  return { response: await authenticator.assert(options, overrides), cookie };
}

async function verify(response: AuthenticationResponseJSON, ip: string): Promise<Response> {
  return send({ action: "verify", response }, ip);
}

async function refuseOnce(authenticator: SoftAuthenticator, ip: string, overrides: AssertionOverrides = {}) {
  const { response } = await assertion(authenticator, ip, overrides);
  const answer = await verify(response, ip);
  expect(answer.status).toBe(401);
}

function tableCounts(): Record<string, number> {
  const db = new Database(join(fixture.dir, "store.db"), { readonly: true });
  try {
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return {
      users: count("passkey_users"),
      credentials: count("passkey_credentials"),
      spent: count("passkey_spent_challenges"),
    };
  } finally {
    db.close();
  }
}

async function passwordSignIn(email: string, ip: string): Promise<number> {
  const response = await passwordLogin(
    new Request(`${PASSKEY_TEST_ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ email, password: PASSWORD }),
    }) as never,
  );
  return response.status;
}

function routeEvents() {
  return getServerAuditBuffer()
    .getAll()
    .filter((event) => event.target === ROUTE);
}

async function disable(email: string): Promise<void> {
  const provider = await fixture.provider();
  const current = await provider.getAccount(email);
  if (!current) throw new Error("account missing");
  await provider.updateAccount(
    { ...current, disabled: true, sessionVersion: current.sessionVersion + 1, updatedAt: new Date().toISOString() },
    { expected: current },
  );
}

async function removePasskey(owner: Owner): Promise<void> {
  const provider = await fixture.provider();
  const current = await provider.getAccount(owner.email);
  if (!current) throw new Error("account missing");
  await provider.deletePasskey({
    email: owner.email,
    id: owner.passkeyId,
    expectedSessionVersion: current.sessionVersion,
    nextSessionVersion: current.sessionVersion + 1,
    updatedAt: new Date().toISOString(),
  });
}

function withEnv<T>(key: string, value: string | undefined, run: () => Promise<T>): Promise<T> {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  return run().finally(() => {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  });
}

describe("POST /api/auth/passkey/sign-in", () => {
  test("options set the ceremony cookie and answer no-store without touching the store", async () => {
    await enrol();
    const before = tableCounts();
    const response = await send({ action: "options" }, freshAddress());
    expect(response.status).toBe(200);
    const { options } = await response.json();
    expect(typeof options.challenge).toBe("string");
    expect(options.allowCredentials).toBeUndefined();
    expect(cookieJar.get(SIGN_IN_COOKIE)?.value).toBeString();
    expect(tableCounts()).toEqual(before);
  });

  test("a verified passkey signs in with the stored role and session version, and the next request keeps the session", async () => {
    const owner = await enrol({ role: "admin" });
    const stored = await (await fixture.provider()).getAccount(owner.email);
    const ip = freshAddress();
    const { response } = await assertion(owner.authenticator, ip);

    const answer = await verify(response, ip);

    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ success: true, role: "admin" });
    const token = cookieJar.get("auth-token")?.value as string;
    const payload = await verifyJWT(token);
    expect(payload?.role).toBe("admin");
    expect(payload?.username).toBe(owner.email);
    expect(payload?.sessionVersion).toBe(stored?.sessionVersion as number);
    const session = await getSession();
    expect(session?.username).toBe(owner.email);
    expect(session?.role).toBe("admin");
    expect(session?.sessionVersion).toBe(stored?.sessionVersion as number);
  });

  test("an account disabled between the service's read and the store write answers the uniform 401 and sets no session", async () => {
    const owner = await enrol({ role: "admin" });
    const ip = freshAddress();
    const { response } = await assertion(owner.authenticator, ip);
    const provider = await fixture.provider();
    const original = provider.recordPasskeySignIn.bind(provider);
    const spy = spyOn(provider, "recordPasskeySignIn").mockImplementation(async (write) => {
      await disable(owner.email);
      return original(write);
    });
    try {
      const answer = await verify(response, ip);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(answer.status).toBe(401);
      expect(await answer.json()).toEqual({ success: false, message: SIGN_IN_FAILED });
    } finally {
      spy.mockRestore();
    }
    expect(cookieJar.get("auth-token")).toBeUndefined();
    expect(routeEvents()).toEqual([
      expect.objectContaining({
        type: "login_failure",
        user: owner.email,
        reason: "passkey_account_unavailable",
        passkey: owner.passkeyId,
      }),
    ]);
  });

  test("a passkey signs in an account that has TOTP without a code", async () => {
    const owner = await enrol({ totpSecret: "JBSWY3DPEHPK3PXP" });
    const ip = freshAddress();
    const { response } = await assertion(owner.authenticator, ip);
    const answer = await verify(response, ip);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ success: true, role: "user" });
  });

  test("every refusal answers the same 401 body", async () => {
    const ip = freshAddress();
    const bodies: string[] = [];
    const record = async (answer: Response) => {
      expect(answer.status).toBe(401);
      bodies.push(await answer.text());
    };

    // No ceremony.
    const noCeremony = await enrol();
    const first = await assertion(noCeremony.authenticator, ip);
    cookieJar.delete(SIGN_IN_COOKIE);
    await record(await verify(first.response, ip));

    // Unknown credential.
    const stranger = await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN });
    stranger.userHandle = randomBytes(64).toString("base64url");
    await record(await verify((await assertion(stranger, ip)).response, ip));

    // Bad signature.
    await record(await verify((await assertion(noCeremony.authenticator, ip, { badSignature: true })).response, ip));

    // User verification missing.
    await record(await verify((await assertion(noCeremony.authenticator, ip, { userVerified: false })).response, ip));

    // Replay: a verified assertion submitted again with its own ceremony cookie.
    const replayed = await assertion(noCeremony.authenticator, ip);
    expect((await verify(replayed.response, ip)).status).toBe(200);
    cookieJar.set(SIGN_IN_COOKIE, { value: replayed.cookie });
    await record(await verify(replayed.response, ip));

    // Counter regression: the stored counter is past 0 after the sign-in above.
    await record(await verify((await assertion(noCeremony.authenticator, ip, { signCount: 0 })).response, ip));

    // Disabled account.
    const disabled = await enrol();
    await disable(disabled.email);
    await record(await verify((await assertion(disabled.authenticator, freshAddress())).response, freshAddress()));

    expect(bodies).toHaveLength(7);
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toEqual({ success: false, message: SIGN_IN_FAILED });
  });

  test("failures spend passkey_client and never the login budgets", async () => {
    const owner = await enrol();
    const ip = freshAddress();
    for (let i = 0; i < 10; i++) {
      // oxlint-disable-next-line no-await-in-loop -- each refusal replaces the one ceremony cookie.
      await refuseOnce(owner.authenticator, ip, { badSignature: true });
    }
    const limited = await send({ action: "options" }, ip);
    expect(limited.status).toBe(429);

    clearRateLimitState();
    for (let i = 0; i < 25; i++) {
      // The credential is known, so a route that charged the account budget would have spent it here.
      // oxlint-disable-next-line no-await-in-loop -- as above.
      await refuseOnce(owner.authenticator, freshAddress(), { badSignature: true });
    }
    expect(await passwordSignIn(owner.email, freshAddress())).toBe(200);
  });

  test("refusals of a removed passkey from one address leave that address's password sign-in allowed", async () => {
    const owner = await enrol();
    await removePasskey(owner);
    const ip = freshAddress();
    let status = 0;
    for (let i = 0; i < 20 && status !== 429; i++) {
      // oxlint-disable-next-line no-await-in-loop -- each attempt replaces the one ceremony cookie.
      const started = await send({ action: "options" }, ip);
      status = started.status;
      if (status === 429) break;
      // oxlint-disable-next-line no-await-in-loop -- as above.
      const { options } = await started.json();
      // oxlint-disable-next-line no-await-in-loop -- as above.
      const answer = await verify(await owner.authenticator.assert(options), ip);
      expect(answer.status).toBe(401);
    }
    expect(status).toBe(429);
    expect(await passwordSignIn(owner.email, ip)).toBe(200);
  });

  test("a client over its passkey budget gets 429 before any verification", async () => {
    const owner = await enrol();
    const ip = freshAddress();
    for (let i = 0; i < 10; i++) {
      // oxlint-disable-next-line no-await-in-loop -- one request after another from the same address.
      expect((await send({}, ip)).status).toBe(400);
    }
    const { response } = await assertion(owner.authenticator, freshAddress());
    cookieJar.clear();

    const options = await send({ action: "options" }, ip);
    expect(options.status).toBe(429);
    const verified = await verify(response, ip);
    expect(verified.status).toBe(429);
    expect(cookieJar.size).toBe(0);
    // The budget is checked before the body is read, so a malformed or oversized body is 429 too, not 400 or 413.
    const malformedBefore = routeEvents().filter((event) => event.reason === "malformed_body").length;
    expect((await send(undefined, ip, "{not json")).status).toBe(429);
    expect((await send({ action: "verify", padding: "x".repeat(70_000) }, ip)).status).toBe(429);
    expect(routeEvents().filter((event) => event.reason === "malformed_body")).toHaveLength(malformedBefore);
  });

  test("a malformed or oversized body is 400 or 413 and spends passkey_client", async () => {
    const ip = freshAddress();
    const answers = [
      await send(undefined, ip, "{not json"),
      await send({ action: "unknown" }, ip),
      await send(["options"], ip),
      await send({ action: "verify", padding: "x".repeat(70_000) }, ip),
    ];
    expect(answers.map((answer) => answer.status)).toEqual([400, 400, 400, 413]);
    expect(await answers[0].json()).toEqual({ success: false, message: "Invalid request body" });
    expect(await answers[3].json()).toEqual({ success: false, message: "Request body is too large" });
    const failures = routeEvents().filter((event) => event.type === "login_failure");
    expect(failures).toHaveLength(4);
    for (const event of failures) {
      expect(event.reason).toBe("malformed_body");
      expect(event.user).toBe("anonymous");
    }
    for (let i = 0; i < 6; i++) {
      // oxlint-disable-next-line no-await-in-loop -- one request after another from the same address.
      await send(undefined, ip, "");
    }
    expect((await send({ action: "options" }, ip)).status).toBe(429);
  });

  test("OIDC mode and local storage answer 409", async () => {
    await fixture.provider();
    const oidc = await withEnv("NEXT_PUBLIC_AUTH_PROVIDER", "oidc", () => send({ action: "options" }, freshAddress()));
    expect(oidc.status).toBe(409);
    const oidcBody = await oidc.json();
    expect(oidcBody.success).toBe(false);
    expect(oidcBody.message).toContain("identity provider");

    const local = await withEnv("STORAGE_PROVIDER", "local", () => send({ action: "verify" }, freshAddress()));
    expect(local.status).toBe(409);
    const localBody = await local.json();
    expect(localBody.success).toBe(false);
    expect(localBody.message).toContain("STORAGE_PROVIDER");
  });

  test("a misconfigured PASSKEY_ORIGIN answers 503", async () => {
    const answer = await withEnv("PASSKEY_ORIGIN", "ftp://studio.example.com", () =>
      send({ action: "options" }, freshAddress()),
    );
    expect(answer.status).toBe(503);
    const body = await answer.json();
    expect(body.success).toBe(false);
    expect(body.message).toContain("PASSKEY_ORIGIN");
    expect(body.message).not.toContain("ftp://studio.example.com");
  });

  test("a misconfigured PASSKEY_ORIGIN writes no log line per request", async () => {
    // An anonymous caller must not be able to fill the log; the configuration reader warns once per process.
    const lines: unknown[][] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args);
      }),
    );
    try {
      await withEnv("PASSKEY_ORIGIN", "https://studio.example.com/studio", async () => {
        for (let i = 0; i < 20; i++) {
          // oxlint-disable-next-line no-await-in-loop -- one request after another.
          expect((await send({ action: "options" }, freshAddress())).status).toBe(503);
        }
      });
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    expect(lines).toEqual([]);
  });

  test("success and refusal are audited once with the passkey id", async () => {
    const owner = await enrol();
    const ip = freshAddress();
    const { response } = await assertion(owner.authenticator, ip);
    expect((await verify(response, ip)).status).toBe(200);
    const successes = routeEvents();
    expect(successes).toHaveLength(1);
    expect(successes[0]).toMatchObject({
      type: "login_success",
      action: "login",
      user: owner.email,
      result: "success",
      passkey: owner.passkeyId,
    });

    getServerAuditBuffer().clear();
    const disabled = await enrol();
    await disable(disabled.email);
    await refuseOnce(disabled.authenticator, ip);
    const refusals = routeEvents();
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({
      type: "login_failure",
      user: disabled.email,
      result: "failure",
      reason: "passkey_account_unavailable",
      passkey: disabled.passkeyId,
    });

    getServerAuditBuffer().clear();
    const stranger = await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN });
    stranger.userHandle = randomBytes(64).toString("base64url");
    await refuseOnce(stranger, ip);
    const unknown = routeEvents();
    expect(unknown).toHaveLength(1);
    expect(unknown[0]).toMatchObject({ type: "login_failure", user: "anonymous", reason: "passkey_unknown" });
    expect(unknown[0].passkey).toBeUndefined();
  });

  test("a broken audit sink does not change the outcome", async () => {
    const owner = await enrol();
    const ip = freshAddress();
    const { response: refused } = await assertion(owner.authenticator, freshAddress(), { badSignature: true });
    const signInCookie = cookieJar.get(SIGN_IN_COOKIE)?.value as string;
    const logSpy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await send(undefined, ip, "{")).status).toBe(400);
      cookieJar.set(SIGN_IN_COOKIE, { value: signInCookie });
      expect((await verify(refused, ip)).status).toBe(401);
      const again = await assertion(owner.authenticator, ip);
      expect((await verify(again.response, ip)).status).toBe(200);
    } finally {
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test("a storage failure is a 500, not a refusal", async () => {
    const owner = await enrol();
    const ip = freshAddress();
    const { response } = await assertion(owner.authenticator, ip);
    const provider = await fixture.provider();
    const spy = spyOn(provider, "findPasskey").mockImplementation(async () => {
      throw new Error("disk full");
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect((await verify(response, ip)).status).toBe(500);
      expect(routeEvents()).toHaveLength(0);
    } finally {
      spy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
