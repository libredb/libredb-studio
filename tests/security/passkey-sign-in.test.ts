/**
 * Security properties of passkey sign-in (docs/SECURITY.md, control 1.8), pinned through the real routes, the real
 * @simplewebauthn/server and a real SQLite store. Each test says in a comment what it guards. Every refusal is
 * read twice: the uniform 401 the caller sees, and the reason the libredb.audit.v1 stdout line records, since the
 * reason is the only place the cases differ.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import Database from "better-sqlite3";
import { cookieJar, installNextHeadersMock, requestHeaders, resetCookieJar } from "../helpers/next-cookie-jar";
import { type AssertionOverrides, SoftAuthenticator } from "../helpers/passkey-authenticator";
import { openStoreFixture, PASSKEY_TEST_ORIGIN, type StoreFixture } from "../helpers/passkey-store-fixture";
import { totpCodeFor } from "../helpers/rfc6238";

installNextHeadersMock();

const { POST: signInRoute } = await import("@/app/api/auth/passkey/sign-in/route");
const passkeyRoute = await import("@/app/api/auth/passkey/route");
const { POST: passwordLogin } = await import("@/app/api/auth/login/route");
const adminAccountRoute = await import("@/app/api/admin/accounts/[email]/route");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { clearTotpReplayState } = await import("@/lib/totp");
const { signJWT, verifyJWT } = await import("@/lib/auth");
const { closeStorageProvider } = await import("@/lib/storage/factory");

const ROUTE = "POST /api/auth/passkey/sign-in";
const SIGN_IN_COOKIE = "passkey-sign-in";
const REGISTRATION_COOKIE = "passkey-registration";
const AUDIT_SCHEMA = "libredb.audit.v1";
const SIGN_IN_FAILED =
  "That passkey could not sign you in. If it was removed from Studio, delete it from your password manager too. Sign in with your password.";
const SETUP_EXPIRED = "The passkey setup expired or belongs to another sign-in. Start again.";
// Placeholders, not credentials.
const PASSWORD = "password-owner";
const RESET_PASSWORD = "password-reset-by-admin";
const EVIL_ORIGIN = "http://evil.example";

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

interface Owner {
  email: string;
  authenticator: SoftAuthenticator;
  passkeyId: string;
}

let fixture: StoreFixture;
let stdout: string[] = [];
let consoleSpies: { mockRestore(): void }[] = [];
let addressCounter = 0;

/** A fresh documentation-range address, so no case runs into another's passkey_client budget. */
function freshAddress(): string {
  addressCounter += 1;
  return `192.0.${Math.floor(addressCounter / 250)}.${(addressCounter % 250) + 1}`;
}

beforeEach(async () => {
  resetCookieJar();
  clearRateLimitState();
  clearTotpReplayState();
  stdout = [];
  // Every console channel, so the leak test sees the logger's lines as well as the audit line.
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

function signInRequest(body: unknown, ip: string, headers: Record<string, string> = {}, url = PASSKEY_TEST_ORIGIN) {
  return new Request(`${url}/api/auth/passkey/sign-in`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip, ...headers },
    body: JSON.stringify(body),
  });
}

async function send(body: unknown, ip: string, headers: Record<string, string> = {}, url?: string) {
  return signInRoute(signInRequest(body, ip, headers, url) as never);
}

/** Starts a ceremony through the route and answers it; the cookie is returned so a case can move it. */
async function assertion(
  authenticator: SoftAuthenticator,
  ip: string,
  overrides: AssertionOverrides = {},
): Promise<{ response: AuthenticationResponseJSON; cookie: string; options: PublicKeyCredentialRequestOptionsJSON }> {
  const started = await send({ action: "options" }, ip);
  expect(started.status).toBe(200);
  const { options } = await started.json();
  const cookie = cookieJar.get(SIGN_IN_COOKIE)?.value as string;
  return { response: await authenticator.assert(options, overrides), cookie, options };
}

async function verify(
  response: AuthenticationResponseJSON,
  ip: string,
  headers: Record<string, string> = {},
  url?: string,
) {
  return send({ action: "verify", response }, ip, headers, url);
}

/** Sends one verify and returns the caller's view (status, body) and the one sign-in audit line it wrote. */
async function verifyObserved(
  response: AuthenticationResponseJSON,
  ip: string,
): Promise<{ status: number; body: string; line: AuditLine }> {
  const mark = stdout.length;
  const answer = await verify(response, ip);
  const lines = auditLines(mark).filter((line) => line.route === ROUTE);
  expect(lines).toHaveLength(1);
  return { status: answer.status, body: await answer.text(), line: lines[0] };
}

/** A refusal: the uniform 401 body, and a login_failure line carrying the reason the case is named for. */
async function expectRefused(response: AuthenticationResponseJSON, ip: string, reason: string): Promise<AuditLine> {
  const observed = await verifyObserved(response, ip);
  expect(observed.status).toBe(401);
  expect(JSON.parse(observed.body)).toEqual({ success: false, message: SIGN_IN_FAILED });
  expect(observed.line).toMatchObject({ event: "login_failure", outcome: "failure", reason });
  expect(cookieJar.get("auth-token")).toBeUndefined();
  return observed.line;
}

async function expectSignedIn(response: AuthenticationResponseJSON, ip: string, role: "admin" | "user" = "user") {
  const answer = await verify(response, ip);
  expect(answer.status).toBe(200);
  expect(await answer.json()).toEqual({ success: true, role });
}

/** Signs the session cookie a stored account's current session would carry. */
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

/** Creates an account and registers a passkey for it through the management route, then signs out. */
async function enrol(input: { role?: "admin" | "user"; totpSecret?: string } = {}): Promise<Owner> {
  const email = `owner-${randomUUID()}@example.com`;
  await fixture.createAccount({ email, password: PASSWORD, role: input.role ?? "user", totpSecret: input.totpSecret });
  await sessionFor(email);
  const code = input.totpSecret ? { code: totpCodeFor(input.totpSecret, Date.now()) } : {};
  const begun = await manage({ action: "register-options", password: PASSWORD, ...code });
  expect(begun.status).toBe(200);
  const { options } = await begun.json();
  const authenticator = await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN });
  const verified = await manage({ action: "register-verify", response: await authenticator.register(options) });
  expect(verified.status).toBe(200);
  const { passkey } = await verified.json();
  cookieJar.clear();
  return { email, authenticator, passkeyId: passkey.id };
}

async function createAdmin(): Promise<string> {
  const email = `admin-${randomUUID()}@example.com`;
  await fixture.createAccount({ email, password: PASSWORD, role: "admin" });
  return email;
}

async function adminPatch(admin: string, email: string, body: unknown): Promise<Response> {
  await sessionFor(admin);
  const answer = await adminAccountRoute.PATCH(
    new Request(`${PASSKEY_TEST_ORIGIN}/api/admin/accounts/${encodeURIComponent(email)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-forwarded-for": freshAddress() },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ email }) },
  );
  cookieJar.clear();
  return answer;
}

async function adminDelete(admin: string, email: string): Promise<Response> {
  await sessionFor(admin);
  const answer = await adminAccountRoute.DELETE(
    new Request(`${PASSKEY_TEST_ORIGIN}/api/admin/accounts/${encodeURIComponent(email)}`, {
      method: "DELETE",
      headers: { "x-forwarded-for": freshAddress() },
    }),
    { params: Promise.resolve({ email }) },
  );
  cookieJar.clear();
  return answer;
}

async function passwordSignIn(email: string, password: string, ip: string): Promise<number> {
  const response = await passwordLogin(
    new Request(`${PASSKEY_TEST_ORIGIN}/api/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ email, password }),
    }) as never,
  );
  return response.status;
}

/** Every row of the account and passkey tables, so a write that changes a row without adding one is seen too. */
function rowContents(): Record<string, unknown[]> {
  const db = new Database(join(fixture.dir, "store.db"), { readonly: true });
  try {
    const rows = (table: string) => db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
    return {
      accounts: rows("accounts"),
      users: rows("passkey_users"),
      credentials: rows("passkey_credentials"),
      spent: rows("passkey_spent_challenges"),
    };
  } finally {
    db.close();
  }
}

describe("passkey sign-in security properties", () => {
  // The expected origin comes only from PASSKEY_ORIGIN.
  test("an assertion for another origin is refused whatever Host and X-Forwarded-Host say", async () => {
    const owner = await enrol();
    const spoofed = { host: "evil.example", "x-forwarded-host": "evil.example", "x-forwarded-proto": "http" };
    for (const [name, value] of Object.entries(spoofed)) requestHeaders.set(name, value);
    const ip = freshAddress();

    const started = await send({ action: "options" }, ip, spoofed, EVIL_ORIGIN);
    expect(started.status).toBe(200);
    const { options } = await started.json();
    // The headers do not move the RP ID either.
    expect(options.rpId).toBe("localhost");
    const forEvil = await owner.authenticator.assert(options, { origin: EVIL_ORIGIN });
    const mark = stdout.length;
    const refused = await verify(forEvil, ip, spoofed, EVIL_ORIGIN);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ success: false, message: SIGN_IN_FAILED });
    expect(auditLines(mark).find((line) => line.route === ROUTE)).toMatchObject({
      event: "login_failure",
      reason: "passkey_origin_mismatch",
    });

    // The same headers with an assertion for the configured origin sign in: they are ignored both ways.
    const again = await send({ action: "options" }, ip, spoofed, EVIL_ORIGIN);
    const genuine = await owner.authenticator.assert((await again.json()).options);
    const accepted = await verify(genuine, ip, spoofed, EVIL_ORIGIN);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ success: true, role: "user" });
  });

  // User verification is required, so possession alone never replaces password plus code.
  test("an assertion without user verification cannot enter a TOTP-protected account", async () => {
    const owner = await enrol({ totpSecret: "JBSWY3DPEHPK3PXP" });
    const ip = freshAddress();
    const { response } = await assertion(owner.authenticator, ip, { userVerified: false });
    const line = await expectRefused(response, ip, "passkey_rejected");
    expect(line).toMatchObject({ actor: owner.email, passkey: owner.passkeyId });

    // Control: the same authenticator with UV signs in without a code.
    await expectSignedIn((await assertion(owner.authenticator, ip)).response, ip);
  });

  // The spent challenge lives in the store, not in a process.
  test("a replayed assertion is refused on a second provider instance over the same database", async () => {
    const owner = await enrol();
    const ip = freshAddress();
    const { response, cookie } = await assertion(owner.authenticator, ip);
    await expectSignedIn(response, ip);

    // The next request builds a fresh provider: a second process's view of the same file.
    await closeStorageProvider();
    cookieJar.clear();
    cookieJar.set(SIGN_IN_COOKIE, { value: cookie });
    const line = await expectRefused(response, ip, "passkey_replayed");
    expect(line).toMatchObject({ actor: owner.email, passkey: owner.passkeyId });
  });

  // A ceremony token is bound to its purpose.
  test("a registration ceremony cannot complete a sign-in, nor a sign-in ceremony a registration", async () => {
    const owner = await enrol();
    const ip = freshAddress();

    // A registration cookie under the sign-in name, answered over its own challenge.
    await sessionFor(owner.email);
    const begun = await manage({ action: "register-options", password: PASSWORD });
    expect(begun.status).toBe(200);
    const registration = (await begun.json()).options;
    const registrationCookie = cookieJar.get(REGISTRATION_COOKIE)?.value as string;
    cookieJar.clear();
    const signInOptions = (await (await send({ action: "options" }, ip)).json()).options;
    cookieJar.set(SIGN_IN_COOKIE, { value: registrationCookie });
    const overRegistration = await owner.authenticator.assert(signInOptions, { challenge: registration.challenge });
    await expectRefused(overRegistration, ip, "passkey_ceremony_invalid");

    // A sign-in cookie under the registration name, answered over its own challenge.
    const signInChallenge = (await (await send({ action: "options" }, ip)).json()).options.challenge;
    const signInCookie = cookieJar.get(SIGN_IN_COOKIE)?.value as string;
    await sessionFor(owner.email);
    const again = await manage({ action: "register-options", password: PASSWORD });
    const creation = (await again.json()).options;
    cookieJar.set(REGISTRATION_COOKIE, { value: signInCookie });
    const second = await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN });
    const mark = stdout.length;
    const refused = await manage({
      action: "register-verify",
      response: await second.register({ ...creation, challenge: signInChallenge }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: SETUP_EXPIRED });
    expect(auditLines(mark)).toContainEqual(
      expect.objectContaining({ event: "account", action: "passkey_add", reason: "passkey_ceremony_invalid" }),
    );
    expect((await (await fixture.provider()).listPasskeys(owner.email)).map((entry) => entry.id)).toEqual([
      owner.passkeyId,
    ]);
  });

  // The HttpOnly SameSite=Strict cookie binds the challenge to the browser that started the ceremony.
  test("an assertion completed in a browser that did not start the ceremony is refused", async () => {
    const attacker = await enrol();
    const ip = freshAddress();
    // Browser A, the attacker's: options and a valid assertion over them.
    const { response, cookie } = await assertion(attacker.authenticator, ip);

    // Browser B, the victim's, with no ceremony cookie.
    cookieJar.clear();
    await expectRefused(response, ip, "passkey_ceremony_invalid");
    expect(cookieJar.get("auth-token")).toBeUndefined();

    // Browser B with a ceremony of its own: the challenge in the assertion is not B's.
    cookieJar.clear();
    await send({ action: "options" }, ip);
    await expectRefused(response, ip, "passkey_rejected");
    expect(cookieJar.get("auth-token")).toBeUndefined();

    // Control: in browser A the same assertion signs in, so only the browser binding refused it above.
    cookieJar.clear();
    cookieJar.set(SIGN_IN_COOKIE, { value: cookie });
    await expectSignedIn(response, ip);
  });

  // The account is read after the signature, and deletes cascade.
  test("a disabled account, a deleted account and a removed passkey are refused", async () => {
    const admin = await createAdmin();
    const disabled = await enrol();
    const deleted = await enrol();
    const removed = await enrol();

    expect((await adminPatch(admin, disabled.email, { disabled: true })).status).toBe(200);
    const ipDisabled = freshAddress();
    const disabledLine = await expectRefused(
      (await assertion(disabled.authenticator, ipDisabled)).response,
      ipDisabled,
      "passkey_account_unavailable",
    );
    expect(disabledLine).toMatchObject({ actor: disabled.email, passkey: disabled.passkeyId });

    expect((await adminDelete(admin, deleted.email)).status).toBe(200);
    const ipDeleted = freshAddress();
    const deletedLine = await expectRefused(
      (await assertion(deleted.authenticator, ipDeleted)).response,
      ipDeleted,
      "passkey_unknown",
    );
    expect(deletedLine.actor).toBe("anonymous");

    await sessionFor(removed.email);
    expect((await manage({ action: "remove", id: removed.passkeyId, password: PASSWORD })).status).toBe(200);
    cookieJar.clear();
    const ipRemoved = freshAddress();
    await expectRefused((await assertion(removed.authenticator, ipRemoved)).response, ipRemoved, "passkey_unknown");
  });

  // The session is minted from the stored role.
  test("a role change reaches the next passkey session", async () => {
    const admin = await createAdmin();
    const owner = await enrol({ role: "admin" });
    expect((await adminPatch(admin, owner.email, { role: "user" })).status).toBe(200);
    const ip = freshAddress();
    await expectSignedIn((await assertion(owner.authenticator, ip)).response, ip, "user");
    const payload = await verifyJWT(cookieJar.get("auth-token")?.value as string);
    expect(payload?.role).toBe("user");
    expect(payload?.sessionVersion).toBe((await (await fixture.provider()).getAccount(owner.email))?.sessionVersion);
  });

  // A cloned authenticator is refused on a verified signature, and the account is never locked.
  test("a counter regression is refused and audited without locking the account", async () => {
    const owner = await enrol();
    const ip = freshAddress();
    await expectSignedIn((await assertion(owner.authenticator, ip)).response, ip);
    cookieJar.clear();
    const provider = await fixture.provider();
    const storedCount = (await provider.listPasskeys(owner.email))[0].signCount;
    expect(storedCount).toBeGreaterThan(0);

    for (const signCount of [storedCount, 0]) {
      // oxlint-disable-next-line no-await-in-loop -- each attempt replaces the one ceremony cookie.
      const { response } = await assertion(owner.authenticator, ip, { signCount });
      // oxlint-disable-next-line no-await-in-loop -- as above.
      const line = await expectRefused(response, ip, "passkey_counter");
      expect(line).toMatchObject({ actor: owner.email, passkey: owner.passkeyId });
    }
    expect((await provider.listPasskeys(owner.email))[0].signCount).toBe(storedCount);
    expect((await provider.getAccount(owner.email))?.disabled).toBe(false);
    expect(await passwordSignIn(owner.email, PASSWORD, freshAddress())).toBe(200);
    cookieJar.clear();
    // A counter past the stored one still signs in.
    const next = await assertion(owner.authenticator, freshAddress(), { signCount: storedCount + 1 });
    await expectSignedIn(next.response, freshAddress());
  });

  // An admin password set is a recovery, so it removes passkeys unless the admin keeps them.
  test("a passkey added with the old password is refused after an admin password set, and signs in when the admin kept it", async () => {
    const admin = await createAdmin();
    const recovered = await enrol();
    const kept = await enrol();

    expect((await adminPatch(admin, recovered.email, { password: RESET_PASSWORD })).status).toBe(200);
    const ip = freshAddress();
    await expectRefused((await assertion(recovered.authenticator, ip)).response, ip, "passkey_unknown");

    expect((await adminPatch(admin, kept.email, { password: RESET_PASSWORD, keepPasskeys: true })).status).toBe(200);
    await expectSignedIn((await assertion(kept.authenticator, ip)).response, ip);
  });

  // The response's user handle must be the handle of the account that owns the credential.
  test("a user handle that does not own the credential is refused", async () => {
    const owner = await enrol();
    const other = await enrol();
    const ip = freshAddress();
    for (const userHandle of [other.authenticator.userHandle, randomBytes(64).toString("base64url")]) {
      // oxlint-disable-next-line no-await-in-loop -- each attempt replaces the one ceremony cookie.
      const { response } = await assertion(owner.authenticator, ip, { userHandle });
      // oxlint-disable-next-line no-await-in-loop -- as above.
      const line = await expectRefused(response, ip, "passkey_rejected");
      expect(line).toMatchObject({ actor: owner.email, passkey: owner.passkeyId });
    }
  });

  // Options are stateless and a refused verify writes nothing.
  test("no anonymous request writes a row unless an assertion verifies", async () => {
    const owner = await enrol();
    const stranger = await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN });
    stranger.userHandle = randomBytes(64).toString("base64url");
    const before = rowContents();

    for (let i = 0; i < 50; i++) {
      // oxlint-disable-next-line no-await-in-loop -- one request after another.
      expect((await send({ action: "options" }, freshAddress())).status).toBe(200);
    }
    const refusals: [SoftAuthenticator, AssertionOverrides, string][] = [
      [owner.authenticator, { badSignature: true }, "passkey_rejected"],
      [owner.authenticator, { userVerified: false }, "passkey_rejected"],
      [owner.authenticator, { origin: EVIL_ORIGIN }, "passkey_origin_mismatch"],
      [owner.authenticator, { userHandle: null }, "passkey_unknown"],
      [stranger, {}, "passkey_unknown"],
    ];
    for (let i = 0; i < 50; i++) {
      const [authenticator, overrides, reason] = refusals[i % refusals.length];
      const ip = freshAddress();
      // oxlint-disable-next-line no-await-in-loop -- each refusal replaces the one ceremony cookie.
      const { response } = await assertion(authenticator, ip, overrides);
      // oxlint-disable-next-line no-await-in-loop -- as above.
      await expectRefused(response, ip, reason);
    }
    expect(rowContents()).toEqual(before);

    // The control: one assertion that verifies does write, spending its challenge and marking the passkey used.
    const ip = freshAddress();
    const { response } = await assertion(owner.authenticator, ip);
    await expectSignedIn(response, ip);
    const after = rowContents();
    expect(after.spent).toHaveLength(before.spent.length + 1);
    const used = after.credentials.find((row) => (row as { id: string }).id === owner.passkeyId);
    expect((used as { last_used_at: string | null }).last_used_at).not.toBeNull();
  });

  // One answer for every refusal; the reason is only in the audit line.
  test("refusals are indistinguishable to the caller", async () => {
    const owner = await enrol();
    const disabled = await enrol();
    await (async () => {
      const provider = await fixture.provider();
      const current = await provider.getAccount(disabled.email);
      if (!current) throw new Error("account missing");
      await provider.updateAccount(
        { ...current, disabled: true, sessionVersion: current.sessionVersion + 1, updatedAt: new Date().toISOString() },
        { expected: current },
      );
    })();
    const stranger = await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN });
    stranger.userHandle = randomBytes(64).toString("base64url");

    const observed: { reason: string; status: number; body: string }[] = [];
    const observe = async (expected: string, response: AuthenticationResponseJSON, ip: string) => {
      const result = await verifyObserved(response, ip);
      expect({ expected, reason: result.line.reason }).toEqual({ expected, reason: expected });
      observed.push({ reason: expected, status: result.status, body: result.body });
    };

    const noCeremony = await assertion(owner.authenticator, freshAddress());
    cookieJar.delete(SIGN_IN_COOKIE);
    await observe("passkey_ceremony_invalid", noCeremony.response, freshAddress());
    await observe(
      "passkey_origin_mismatch",
      (await assertion(owner.authenticator, freshAddress(), { origin: EVIL_ORIGIN })).response,
      freshAddress(),
    );
    await observe("passkey_unknown", (await assertion(stranger, freshAddress())).response, freshAddress());
    await observe(
      "passkey_rejected",
      (await assertion(owner.authenticator, freshAddress(), { badSignature: true })).response,
      freshAddress(),
    );
    await observe(
      "passkey_rejected",
      (await assertion(owner.authenticator, freshAddress(), { backupEligible: true })).response,
      freshAddress(),
    );
    await observe(
      "passkey_rejected",
      (await assertion(owner.authenticator, freshAddress(), { crossOrigin: true })).response,
      freshAddress(),
    );
    const replay = await assertion(owner.authenticator, freshAddress());
    await expectSignedIn(replay.response, freshAddress());
    cookieJar.clear();
    cookieJar.set(SIGN_IN_COOKIE, { value: replay.cookie });
    await observe("passkey_replayed", replay.response, freshAddress());
    await observe(
      "passkey_counter",
      (await assertion(owner.authenticator, freshAddress(), { signCount: 0 })).response,
      freshAddress(),
    );
    await observe(
      "passkey_account_unavailable",
      (await assertion(disabled.authenticator, freshAddress())).response,
      freshAddress(),
    );

    expect(new Set(observed.map((entry) => entry.reason)).size).toBe(7);
    expect(new Set(observed.map((entry) => entry.status))).toEqual(new Set([401]));
    expect(new Set(observed.map((entry) => entry.body)).size).toBe(1);
    expect(JSON.parse(observed[0].body)).toEqual({ success: false, message: SIGN_IN_FAILED });
  });

  // The audit record carries a closed reason and the internal id, never WebAuthn material.
  test("audit lines carry the internal passkey id and never a challenge, key or credential ID", async () => {
    const email = `owner-${randomUUID()}@example.com`;
    await fixture.createAccount({ email, password: PASSWORD, role: "user" });
    await sessionFor(email);
    const secrets: string[] = [];

    const begun = await manage({ action: "register-options", password: PASSWORD });
    const creation = (await begun.json()).options;
    secrets.push(creation.challenge, creation.user.id);
    const authenticator = await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN });
    const registered = await manage({ action: "register-verify", response: await authenticator.register(creation) });
    expect(registered.status).toBe(200);
    const passkeyId: string = (await registered.json()).passkey.id;
    const stored = (await (await fixture.provider()).listPasskeys(email))[0];
    secrets.push(stored.credentialId, stored.publicKey, authenticator.credentialId, authenticator.userHandle as string);
    const session = cookieJar.get("auth-token")?.value as string;

    cookieJar.clear();
    const ip = freshAddress();
    const signedIn = await assertion(authenticator, ip);
    secrets.push(signedIn.options.challenge);
    await expectSignedIn(signedIn.response, ip);
    cookieJar.clear();
    const refused = await assertion(authenticator, ip, { badSignature: true });
    secrets.push(refused.options.challenge);
    await expectRefused(refused.response, ip, "passkey_rejected");

    cookieJar.set("auth-token", { value: session });
    expect((await manage({ action: "rename", id: passkeyId, name: "Laptop" })).status).toBe(200);
    expect((await manage({ action: "remove", id: passkeyId, password: PASSWORD })).status).toBe(200);

    for (const line of stdout) {
      for (const secret of secrets) {
        expect({ line, leaks: line.includes(secret) }).toEqual({ line, leaks: false });
      }
    }
    const withPasskey = auditLines().filter((line) => line.passkey !== undefined);
    expect(withPasskey.map((line) => `${line.action}/${line.outcome}`)).toEqual([
      "passkey_add/success",
      "login/success",
      "login/failure",
      "passkey_rename/success",
      "passkey_remove/success",
    ]);
    for (const line of withPasskey) expect(line.passkey).toBe(passkeyId);
  });
});
