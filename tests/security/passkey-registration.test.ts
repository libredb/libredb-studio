/**
 * Security properties of passkey registration and management (docs/SECURITY.md, control 1.8),
 * pinned through the real routes, the real @simplewebauthn/server and a real SQLite store.
 * Each test says in a comment what it guards; refusal reasons are read from the libredb.audit.v1 stdout line.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import Database from "better-sqlite3";
import { createPackedAttestationChain, trustPackedRoot } from "../helpers/attestation-chain";
import { pinMcpTestEnvironment } from "../helpers/mcp-fixtures";
import { legacyPost } from "../helpers/mcp-harness";
// Aliased: the name is not a React hook, and the hooks lint rule reads the callee name.
import { useMcpChannel as enableMcpChannel } from "../helpers/mcp-token";
import { cookieJar, installNextHeadersMock, resetCookieJar } from "../helpers/next-cookie-jar";
import { SoftAuthenticator } from "../helpers/passkey-authenticator";
import { openStoreFixture, PASSKEY_TEST_ORIGIN, type StoreFixture } from "../helpers/passkey-store-fixture";
import { RFC6238_SECRET, totpCodeFor } from "../helpers/rfc6238";

installNextHeadersMock();

const passkeyRoute = await import("@/app/api/auth/passkey/route");
const { POST: signInRoute } = await import("@/app/api/auth/passkey/sign-in/route");
const { POST: passwordLogin } = await import("@/app/api/auth/login/route");
const adminAccountsRoute = await import("@/app/api/admin/accounts/route");
const adminAccountRoute = await import("@/app/api/admin/accounts/[email]/route");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { clearTotpReplayState } = await import("@/lib/totp");
const { signJWT } = await import("@/lib/auth");
const { listPublicAccounts } = await import("@/lib/local-accounts");
const mcpRoute = await import("@/app/api/mcp/route");
const { mintMcpToken } = await import("@/lib/mcp/token");

const AUDIT_SCHEMA = "libredb.audit.v1";
const SIGN_IN_ROUTE = "POST /api/auth/passkey/sign-in";
const REGISTRATION_COOKIE = "passkey-registration";
const ALREADY_REGISTERED = "This passkey is already registered.";
const NOT_VERIFIED = "The passkey could not be verified. Try again.";
const PASSKEYS_OIDC = "Passkeys for this sign-in are managed by your identity provider.";
// Placeholders, not credentials.
const PASSWORD = "password-owner";
const WRONG_PASSWORD = "not-the-password";

interface AuditLine {
  schema: string;
  event: string;
  action: string;
  outcome: string;
  actor: string;
  route: string;
  reason?: string;
  passkey?: string;
}

let fixture: StoreFixture;
let stdout: string[] = [];
let consoleSpies: { mockRestore(): void }[] = [];
let addressCounter = 0;

function freshAddress(): string {
  addressCounter += 1;
  return `198.18.${Math.floor(addressCounter / 250)}.${(addressCounter % 250) + 1}`;
}

beforeEach(async () => {
  resetCookieJar();
  clearRateLimitState();
  clearTotpReplayState();
  stdout = [];
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
    spyOn(console, method).mockImplementation((...args: unknown[]) => {
      stdout.push(args.map(String).join(" "));
    }),
  );
  fixture = await openStoreFixture();
});

afterEach(async () => {
  for (const spy of consoleSpies) spy.mockRestore();
  await fixture.close();
  resetCookieJar();
  clearRateLimitState();
});

function auditLines(from = 0): AuditLine[] {
  const lines: AuditLine[] = [];
  for (const line of stdout.slice(from)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if ((parsed as AuditLine | null)?.schema === AUDIT_SCHEMA) lines.push(parsed as AuditLine);
  }
  return lines;
}

async function sessionFor(email: string): Promise<void> {
  const account = await (await fixture.provider()).getAccount(email);
  if (!account) throw new Error(`${email} missing`);
  cookieJar.set("auth-token", {
    value: await signJWT({ role: account.role, username: email, sessionVersion: account.sessionVersion }),
  });
}

async function manage(body: unknown, ip = freshAddress()): Promise<Response> {
  return passkeyRoute.POST(
    new Request(`${PASSKEY_TEST_ORIGIN}/api/auth/passkey`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify(body),
    }),
  );
}

async function status(): Promise<Response> {
  return passkeyRoute.GET(
    new Request(`${PASSKEY_TEST_ORIGIN}/api/auth/passkey`, { headers: { "x-forwarded-for": freshAddress() } }),
  );
}

async function newAccount(input: { role?: "admin" | "user"; totpSecret?: string } = {}): Promise<string> {
  const email = `owner-${randomUUID()}@example.com`;
  await fixture.createAccount({ email, password: PASSWORD, role: input.role ?? "user", totpSecret: input.totpSecret });
  return email;
}

async function beginRegistration(email: string, extra: Record<string, unknown> = {}) {
  await sessionFor(email);
  const begun = await manage({ action: "register-options", password: PASSWORD, ...extra });
  expect(begun.status).toBe(200);
  return (await begun.json()).options;
}

/** Registers a passkey for an account through the route, as its signed-in owner, and signs out. */
async function register(email: string, authenticator?: SoftAuthenticator) {
  const options = await beginRegistration(email);
  const device = authenticator ?? (await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN }));
  const verified = await manage({ action: "register-verify", response: await device.register(options) });
  expect(verified.status).toBe(200);
  const { passkey } = await verified.json();
  cookieJar.clear();
  return { authenticator: device, passkeyId: passkey.id as string };
}

async function passkeyIds(email: string): Promise<string[]> {
  return (await (await fixture.provider()).listPasskeys(email)).map((entry) => entry.id);
}

/** A passkey sign-in through the route; the status and, for a refusal, the reason of its audit line. */
async function passkeySignIn(authenticator: SoftAuthenticator): Promise<{ status: number; reason?: string }> {
  const ip = freshAddress();
  const send = (body: unknown) =>
    signInRoute(
      new Request(`${PASSKEY_TEST_ORIGIN}/api/auth/passkey/sign-in`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify(body),
      }) as never,
    );
  const { options } = await (await send({ action: "options" })).json();
  const mark = stdout.length;
  const answer = await send({ action: "verify", response: await authenticator.assert(options) });
  const line = auditLines(mark).find((entry) => entry.route === SIGN_IN_ROUTE);
  cookieJar.clear();
  return { status: answer.status, ...(line?.reason ? { reason: line.reason } : {}) };
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

async function asAdmin<T>(admin: string, run: () => Promise<T>): Promise<T> {
  await sessionFor(admin);
  try {
    return await run();
  } finally {
    cookieJar.clear();
  }
}

function adminRequest(method: string, email: string | null, body?: unknown): Request {
  const path = email === null ? "" : `/${encodeURIComponent(email)}`;
  return new Request(`${PASSKEY_TEST_ORIGIN}/api/admin/accounts${path}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": freshAddress() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function rowCounts(): Record<string, number> {
  const db = new Database(join(fixture.dir, "store.db"), { readonly: true });
  try {
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    return {
      accounts: count("accounts"),
      users: count("passkey_users"),
      credentials: count("passkey_credentials"),
      spent: count("passkey_spent_challenges"),
    };
  } finally {
    db.close();
  }
}

type FetchRecorder = { calls: string[]; restore: () => void };

function recordFetch(): FetchRecorder {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** Runs with the MCP channel on and the MCP test environment pinned, and restores every variable after. */
async function withMcp<T>(run: () => Promise<T>): Promise<T> {
  const pinned = ["NEXT_PUBLIC_APP_VERSION", "HOSTNAME", "SEED_CACHE_TTL_MS"] as const;
  const saved = pinned.map((key) => [key, process.env[key]] as const);
  pinMcpTestEnvironment();
  const restoreChannel = enableMcpChannel();
  try {
    return await run();
  } finally {
    restoreChannel();
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

/** An MCP token for the account's current session version, as the token route mints it. */
async function mcpTokenFor(email: string): Promise<string> {
  const account = await (await fixture.provider()).getAccount(email);
  if (!account) throw new Error(`${email} missing`);
  return (await mintMcpToken({ username: email, role: account.role, sessionVersion: account.sessionVersion })).token;
}

async function mcpStatus(token: string): Promise<number> {
  return (await mcpRoute.POST(legacyPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token }))).status;
}

describe("passkey registration security properties", () => {
  // Adding and removing a sign-in factor needs the current password in the same request.
  test("a session cookie alone cannot add or remove a passkey", async () => {
    const email = await newAccount();
    const { passkeyId } = await register(email);
    const before = await (await fixture.provider()).getAccount(email);
    await sessionFor(email);

    const withoutPassword = await manage({ action: "register-options" });
    expect(withoutPassword.status).toBe(400);
    const wrongPassword = await manage({ action: "register-options", password: WRONG_PASSWORD });
    expect(wrongPassword.status).toBe(401);
    expect(cookieJar.get(REGISTRATION_COOKIE)).toBeUndefined();

    expect((await manage({ action: "remove", id: passkeyId })).status).toBe(400);
    const mark = stdout.length;
    expect((await manage({ action: "remove", id: passkeyId, password: WRONG_PASSWORD })).status).toBe(401);
    expect(auditLines(mark)).toContainEqual(
      expect.objectContaining({ event: "account", action: "passkey_remove", reason: "bad_credentials" }),
    );

    expect(await passkeyIds(email)).toEqual([passkeyId]);
    expect((await (await fixture.provider()).getAccount(email))?.sessionVersion).toBe(before?.sessionVersion);
  });

  // Reauthentication is a guessing surface and shares both login budgets.
  test("wrong passwords and codes are charged to the login budgets", async () => {
    const email = await newAccount();
    const { passkeyId } = await register(email);
    await sessionFor(email);

    // Remove with a wrong password, from one address: five 401s, then the right password is 429.
    const ip = freshAddress();
    for (let i = 0; i < 5; i++) {
      // oxlint-disable-next-line no-await-in-loop -- each guess must land before the next is counted.
      expect((await manage({ action: "remove", id: passkeyId, password: WRONG_PASSWORD }, ip)).status).toBe(401);
    }
    expect((await manage({ action: "remove", id: passkeyId, password: PASSWORD }, ip)).status).toBe(429);
    expect(await passkeyIds(email)).toEqual([passkeyId]);
    expect(await passwordSignIn(email, ip)).toBe(429);

    // The same guesses spread over many addresses spend the account's budget.
    clearRateLimitState();
    await sessionFor(email);
    for (let i = 0; i < 20; i++) {
      // oxlint-disable-next-line no-await-in-loop -- as above.
      const res = await manage({ action: "remove", id: passkeyId, password: WRONG_PASSWORD });
      expect(res.status).toBe(401);
    }
    expect((await manage({ action: "remove", id: passkeyId, password: PASSWORD })).status).toBe(429);
    expect(await passkeyIds(email)).toEqual([passkeyId]);
    expect(await passwordSignIn(email, freshAddress())).toBe(429);

    // A wrong code on a TOTP account is charged the same way.
    clearRateLimitState();
    const totp = await newAccount({ totpSecret: RFC6238_SECRET });
    await sessionFor(totp);
    const codeIp = freshAddress();
    const wrongCode = totpCodeFor(RFC6238_SECRET, Date.now() - 10 * 60_000);
    for (let i = 0; i < 5; i++) {
      // oxlint-disable-next-line no-await-in-loop -- as above.
      const res = await manage({ action: "register-options", password: PASSWORD, code: wrongCode }, codeIp);
      expect(res.status).toBe(401);
    }
    const code = totpCodeFor(RFC6238_SECRET);
    expect((await manage({ action: "register-options", password: PASSWORD, code }, codeIp)).status).toBe(429);
    expect(await passwordSignIn(totp, codeIp)).toBe(429);
  });

  // `credential_id` is globally unique, so a credential cannot be moved under another account.
  test("a credential ID already registered to another account is refused and audited as a duplicate", async () => {
    const victim = await newAccount();
    const attacker = await newAccount();
    const { authenticator, passkeyId } = await register(victim);

    const victimHandle = authenticator.userHandle;
    const options = await beginRegistration(attacker);
    const mark = stdout.length;
    const refused = await manage({ action: "register-verify", response: await authenticator.register(options) });
    // The soft authenticator adopts the handle it was last asked to register; a real one keeps the victim's entry.
    authenticator.userHandle = victimHandle;
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: ALREADY_REGISTERED });
    expect(auditLines(mark)).toContainEqual(
      expect.objectContaining({
        event: "account",
        action: "passkey_add",
        outcome: "failure",
        actor: attacker,
        reason: "passkey_duplicate",
      }),
    );
    expect(await passkeyIds(attacker)).toEqual([]);
    expect(await passkeyIds(victim)).toEqual([passkeyId]);
    expect(await passkeySignIn(authenticator)).toEqual({ status: 200 });
  });

  // Every passkey endpoint refuses in OIDC mode before touching any account.
  test("an OIDC session cannot register a passkey even when a local password is configured", async () => {
    // The environment admin row exists, as it would on a server that ran in local mode before.
    await listPublicAccounts();
    expect(process.env.ADMIN_PASSWORD).toBeString();
    const adminPassword = process.env.ADMIN_PASSWORD as string;
    const before = rowCounts();
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    cookieJar.set("auth-token", { value: await signJWT({ role: "admin", username: "admin@libredb.org" }) });

    const got = await status();
    expect(got.status).toBe(200);
    expect(await got.json()).toEqual({ available: false, mode: "oidc", reason: PASSKEYS_OIDC });
    const device = await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN });
    const bodies = [
      { action: "register-options", password: adminPassword },
      { action: "register-verify", response: { id: device.credentialId } },
      { action: "rename", id: randomUUID(), name: "Mine" },
      { action: "remove", id: randomUUID(), password: adminPassword },
    ];
    for (const body of bodies) {
      // oxlint-disable-next-line no-await-in-loop -- one request after another.
      const res = await manage(body);
      expect({ action: body.action, status: res.status }).toEqual({ action: body.action, status: 409 });
      // oxlint-disable-next-line no-await-in-loop -- as above.
      expect(await res.json()).toEqual({ error: PASSKEYS_OIDC });
    }
    expect(cookieJar.get(REGISTRATION_COOKIE)).toBeUndefined();
    expect(rowCounts()).toEqual(before);
  });

  // The handle and the credentials go with the account, and a reused email inherits nothing.
  test("a recreated account with the same email gets a new user handle and none of the old passkeys", async () => {
    const admin = await newAccount({ role: "admin" });
    const email = await newAccount();
    const old = await register(email);
    const provider = await fixture.provider();
    const oldHandle = await provider.getPasskeyUserHandle(email);
    expect(oldHandle).toBeString();

    const deleted = await asAdmin(admin, () =>
      adminAccountRoute.DELETE(adminRequest("DELETE", email), { params: Promise.resolve({ email }) }),
    );
    expect(deleted.status).toBe(200);
    const created = await asAdmin(admin, () =>
      adminAccountsRoute.POST(adminRequest("POST", null, { email, password: PASSWORD, role: "user" })),
    );
    expect(created.status).toBe(201);
    expect(await passkeyIds(email)).toEqual([]);
    expect(await provider.getPasskeyUserHandle(email)).toBeNull();
    expect(await passkeySignIn(old.authenticator)).toEqual({ status: 401, reason: "passkey_unknown" });
    const fresh = await register(email);
    const newHandle = await provider.getPasskeyUserHandle(email);
    expect(newHandle).toBeString();
    expect(newHandle).not.toBe(oldHandle);
    expect(await passkeySignIn(fresh.authenticator)).toEqual({ status: 200 });

    // A delete outside Studio without foreign keys leaves the passkey rows behind.
    const second = await newAccount();
    const stale = await register(second);
    const side = new Database(join(fixture.dir, "store.db"));
    try {
      side.pragma("foreign_keys = OFF");
      side.prepare("DELETE FROM accounts WHERE email = ?").run(second);
      const left = side.prepare("SELECT COUNT(*) AS n FROM passkey_credentials WHERE account_email = ?").get(second);
      expect((left as { n: number }).n).toBe(1);
    } finally {
      side.close();
    }
    const recreated = await asAdmin(admin, () =>
      adminAccountsRoute.POST(adminRequest("POST", null, { email: second, password: PASSWORD, role: "user" })),
    );
    expect(recreated.status).toBe(201);
    expect(await passkeySignIn(stale.authenticator)).toEqual({ status: 401, reason: "passkey_unknown" });
    const control = await register(second);
    expect(await passkeySignIn(control.authenticator)).toEqual({ status: 200 });
  });

  // Only attestation "none" shapes reach the library, so no attestation can make the server fetch.
  test("registration never causes an outbound request, whatever attestation arrives", async () => {
    const email = await newAccount();
    const chain = await createPackedAttestationChain();
    const untrust = trustPackedRoot(chain.rootPem);
    const recorder = recordFetch();
    try {
      // Control: the library itself fetches the CRL of this chain.
      const probe = await beginRegistration(email);
      const device = await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN });
      const packed = await device.register(probe, { format: "packed-x5c", x5c: [chain.leafDer] });
      await verifyRegistrationResponse({
        response: packed,
        expectedChallenge: probe.challenge,
        expectedOrigin: PASSKEY_TEST_ORIGIN,
        expectedRPID: "localhost",
      }).catch(() => undefined);
      expect(recorder.calls).toContain(chain.crlUrl);
      const seen = recorder.calls.length;

      const attempts: [string, (options: never) => Promise<RegistrationResponseJSON>][] = [
        ["packed-x5c", (options) => device.register(options, { format: "packed-x5c", x5c: [chain.leafDer] })],
        ["fido-u2f", (options) => device.register(options, { format: "fido-u2f" })],
      ];
      for (const [format, build] of attempts) {
        // oxlint-disable-next-line no-await-in-loop -- each attempt needs its own ceremony cookie.
        const options = await beginRegistration(email);
        const mark = stdout.length;
        // oxlint-disable-next-line no-await-in-loop -- as above.
        const refused = await manage({ action: "register-verify", response: await build(options as never) });
        expect({ format, status: refused.status }).toEqual({ format, status: 400 });
        // oxlint-disable-next-line no-await-in-loop -- as above.
        expect(await refused.json()).toEqual({ error: NOT_VERIFIED });
        expect(auditLines(mark)).toContainEqual(
          expect.objectContaining({ action: "passkey_add", outcome: "failure", reason: "passkey_rejected" }),
        );
      }
      expect(recorder.calls).toHaveLength(seen);
      expect(await passkeyIds(email)).toEqual([]);
    } finally {
      recorder.restore();
      untrust();
    }
  });

  // An admin removes all of an account's passkeys, ends its sessions, and is on the record.
  test("an admin clear ends the target's sessions and is audited with the admin as actor", async () => {
    const admin = await newAccount({ role: "admin" });
    const target = await newAccount();
    const { authenticator } = await register(target);
    await sessionFor(target);
    const targetSession = cookieJar.get("auth-token")?.value as string;
    cookieJar.clear();

    const mark = stdout.length;
    const cleared = await asAdmin(admin, () =>
      adminAccountRoute.PATCH(adminRequest("PATCH", target, { clearPasskeys: true }), {
        params: Promise.resolve({ email: target }),
      }),
    );
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).account.passkeys).toBe(0);
    expect(auditLines(mark)).toContainEqual(
      expect.objectContaining({
        event: "account",
        action: "passkey_clear",
        outcome: "success",
        actor: admin,
        route: target,
      }),
    );

    cookieJar.set("auth-token", { value: targetSession });
    expect((await status()).status).toBe(401);
    cookieJar.clear();
    expect(await passkeyIds(target)).toEqual([]);
    expect(await passkeySignIn(authenticator)).toEqual({ status: 401, reason: "passkey_unknown" });
  });
  // Removing a passkey, by its owner or by an admin clear, ends every MCP token of the account.
  test("an owner removal and an admin clear end the account's MCP tokens", async () => {
    await withMcp(async () => {
      const admin = await newAccount({ role: "admin" });
      const owner = await newAccount();
      const first = await register(owner);
      await register(owner);

      const beforeRemoval = await mcpTokenFor(owner);
      expect(await mcpStatus(beforeRemoval)).toBe(200);
      await sessionFor(owner);
      const removed = await manage({ action: "remove", id: first.passkeyId, password: PASSWORD });
      expect(removed.status).toBe(200);
      cookieJar.clear();
      expect(await mcpStatus(beforeRemoval)).toBe(401);

      const beforeClear = await mcpTokenFor(owner);
      expect(await mcpStatus(beforeClear)).toBe(200);
      const cleared = await asAdmin(admin, () =>
        adminAccountRoute.PATCH(adminRequest("PATCH", owner, { clearPasskeys: true }), {
          params: Promise.resolve({ email: owner }),
        }),
      );
      expect(cleared.status).toBe(200);
      expect(await mcpStatus(beforeClear)).toBe(401);
      expect(await passkeyIds(owner)).toEqual([]);
    });
  });
});
