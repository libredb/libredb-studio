/**
 * The owner's passkey route: the session guard, the login
 * budgets on the two actions that check the password, the re-issued cookie after a removal, and
 * Cache-Control: no-store on every answer.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { cookieJar, deletedCookies, installNextHeadersMock, resetCookieJar } from "../../helpers/next-cookie-jar";
import { SoftAuthenticator } from "../../helpers/passkey-authenticator";
import {
  makeStoredPasskey,
  openStoreFixture,
  PASSKEY_TEST_ORIGIN,
  type StoreFixture,
} from "../../helpers/passkey-store-fixture";
import { RFC6238_SECRET, totpCodeFor } from "../../helpers/rfc6238";

installNextHeadersMock();

const passkeyRoute = await import("@/app/api/auth/passkey/route");
const { POST: loginRoute } = await import("@/app/api/auth/login/route");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { clearTotpReplayState } = await import("@/lib/totp");
const { ACCOUNT_CHANGED, listPublicAccounts } = await import("@/lib/local-accounts");
const { closeStorageProvider } = await import("@/lib/storage/factory");

const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const CAROL = "carol@example.com";
// Placeholders, not credentials: a realistic literal here is what secret scanners flag.
const ALICE_PASSWORD = "password-alice";
const BOB_PASSWORD = "password-bob";
const WRONG_PASSWORD = "not-the-password";
const NOT_FOUND = "No passkey with that id on your account.";
const CURRENT_CODE_MISSING = "Enter a current code from your authenticator app.";
const PASSKEYS_OIDC = "Passkeys for this sign-in are managed by your identity provider.";
const PASSKEYS_LOCAL =
  "Passkeys need STORAGE_PROVIDER=sqlite or postgres: with STORAGE_PROVIDER=local there is no account registry to keep them in.";
const MISCONFIGURED_ORIGIN = "http://passkeys.internal.test";

let fixture: StoreFixture;
let log: ReturnType<typeof spyOn<Console, "log">>;

/** Every answer of this route is no-store, so each helper checks it on the way out. */
function noStore(response: Response): Response {
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response;
}

function post(body: unknown, ip = "203.0.113.10"): Promise<Response> {
  return postRaw(JSON.stringify(body), ip);
}

async function postRaw(body: string, ip = "203.0.113.10"): Promise<Response> {
  const request = new Request("http://localhost/api/auth/passkey", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body,
  });
  return noStore(await passkeyRoute.POST(request));
}

async function get(): Promise<Response> {
  const request = new Request("http://localhost/api/auth/passkey", {
    headers: { "x-forwarded-for": "203.0.113.11" },
  });
  return noStore(await passkeyRoute.GET(request));
}

async function signIn(email: string, password: string, totp?: string): Promise<string> {
  cookieJar.delete("auth-token");
  const res = await loginRoute(
    new Request("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.12" },
      body: JSON.stringify({ email, password, ...(totp ? { totp } : {}) }),
    }) as never,
  );
  expect(res.status).toBe(200);
  return currentToken();
}

function rateLimitTrips(): Array<Record<string, unknown>> {
  return log.mock.calls
    .map((call) => call[0])
    .filter((line): line is string => typeof line === "string" && line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((line) => line.event === "rate_limit_exceeded");
}

function currentToken(): string {
  const entry = cookieJar.get("auth-token");
  if (!entry) throw new Error("no auth-token cookie");
  return entry.value;
}

function useToken(token: string): void {
  cookieJar.set("auth-token", { value: token });
}

async function register(name?: string): Promise<{ id: string; name: string }> {
  const begun = await post({ action: "register-options", password: ALICE_PASSWORD });
  expect(begun.status).toBe(200);
  const { options } = await begun.json();
  const authenticator = await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN });
  const response = await authenticator.register(options);
  const verified = await post({ action: "register-verify", response, ...(name === undefined ? {} : { name }) });
  expect(verified.status).toBe(200);
  const { passkey } = await verified.json();
  return passkey;
}

async function insertStored(email: string) {
  const provider = await fixture.provider();
  const account = await provider.getAccount(email);
  if (!account) throw new Error(`${email} missing`);
  const passkey = makeStoredPasskey({ accountEmail: email });
  await provider.insertPasskey({
    passkey,
    userHandle: randomBytes(64).toString("base64url"),
    expectedSessionVersion: account.sessionVersion,
    maxPasskeys: 20,
    challenge: { hash: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 600_000).toISOString() },
    purgeSpentBefore: new Date().toISOString(),
  });
  return passkey;
}

describe("the passkey management route", () => {
  beforeEach(async () => {
    resetCookieJar();
    clearRateLimitState();
    clearTotpReplayState();
    fixture = await openStoreFixture();
    await listPublicAccounts();
    await fixture.createAccount({ email: ALICE, password: ALICE_PASSWORD, role: "user" });
    await fixture.createAccount({ email: BOB, password: BOB_PASSWORD, role: "user" });
    log = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    log.mockRestore();
    await fixture.close();
  });

  test("GET answers 401 without a session", async () => {
    const res = await get();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Authentication required" });
  });

  test("GET lists the caller's passkeys, marked no-store", async () => {
    await signIn(ALICE, ALICE_PASSWORD);
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      available: true,
      canAdd: true,
      origin: PASSKEY_TEST_ORIGIN,
      rpId: "localhost",
      totpEnabled: false,
      passkeys: [],
    });
  });

  test("GET answers a registry that fails mid-request as a server error", async () => {
    await signIn(ALICE, ALICE_PASSWORD);
    const provider = await fixture.provider();
    const failure = spyOn(provider, "listPasskeys").mockRejectedValueOnce(new Error("database is locked"));
    const errors = spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await get();
      expect(res.status).toBe(500);
      expect(await res.json()).not.toHaveProperty("available");
    } finally {
      failure.mockRestore();
      errors.mockRestore();
    }
  });

  test("register-options with a wrong password is 401 and spends both login budgets", async () => {
    await signIn(ALICE, ALICE_PASSWORD);
    for (let i = 0; i < 5; i++) {
      // oxlint-disable-next-line no-await-in-loop -- each guess must land before the next is counted.
      expect((await post({ action: "register-options", password: WRONG_PASSWORD }, "198.51.100.1")).status).toBe(401);
    }
    expect((await post({ action: "register-options", password: ALICE_PASSWORD }, "198.51.100.1")).status).toBe(429);
    expect((await post({ action: "register-options", password: ALICE_PASSWORD }, "198.51.100.1")).status).toBe(429);
    // Each wrong password is audited on its own; the budget filling is one more event, once.
    expect(rateLimitTrips()).toEqual([
      expect.objectContaining({ route: "POST /api/auth/passkey", bucket: "login_client", actor: ALICE }),
    ]);

    clearRateLimitState();
    for (let i = 0; i < 20; i++) {
      // oxlint-disable-next-line no-await-in-loop -- each request must land before the next is counted.
      const res = await post({ action: "register-options", password: WRONG_PASSWORD }, `198.51.100.${i + 10}`);
      expect(res.status).toBe(401);
    }
    expect((await post({ action: "register-options", password: ALICE_PASSWORD }, "198.51.100.200")).status).toBe(429);
  });

  test("register-options without a code on a TOTP account answers 400 with codeRequired and spends nothing", async () => {
    await fixture.createAccount({ email: CAROL, password: ALICE_PASSWORD, role: "user", totpSecret: RFC6238_SECRET });
    await signIn(CAROL, ALICE_PASSWORD, totpCodeFor(RFC6238_SECRET));
    clearTotpReplayState();
    for (let i = 0; i < 6; i++) {
      // oxlint-disable-next-line no-await-in-loop -- each request must land before the next is counted.
      const res = await post({ action: "register-options", password: ALICE_PASSWORD }, "198.51.100.2");
      expect(res.status).toBe(400);
      // oxlint-disable-next-line no-await-in-loop -- each request must land before the next is counted.
      expect(await res.json()).toEqual({ error: CURRENT_CODE_MISSING, codeRequired: true });
    }
    const correct = await post(
      { action: "register-options", password: ALICE_PASSWORD, code: totpCodeFor(RFC6238_SECRET) },
      "198.51.100.2",
    );
    expect(correct.status).toBe(200);
  });

  test("the full registration adds a passkey that the next GET lists", async () => {
    await signIn(ALICE, ALICE_PASSWORD);
    const passkey = await register("Laptop");
    expect(passkey.name).toBe("Laptop");
    const listed = await (await get()).json();
    expect(listed.passkeys.map((entry: { id: string }) => entry.id)).toEqual([passkey.id]);
  });

  test("rename answers the renamed passkey", async () => {
    await signIn(ALICE, ALICE_PASSWORD);
    const passkey = await register();
    const res = await post({ action: "rename", id: passkey.id, name: "Phone" });
    expect(res.status).toBe(200);
    expect((await res.json()).passkey).toMatchObject({ id: passkey.id, name: "Phone" });
  });

  test("rename and remove answer 404 for another account's passkey id", async () => {
    const bobs = await insertStored(BOB);
    await signIn(ALICE, ALICE_PASSWORD);
    const renamed = await post({ action: "rename", id: bobs.id, name: "Mine now" });
    expect(renamed.status).toBe(404);
    expect(await renamed.json()).toEqual({ error: NOT_FOUND });
    const removed = await post({ action: "remove", id: bobs.id, password: ALICE_PASSWORD });
    expect(removed.status).toBe(404);
    expect(await removed.json()).toEqual({ error: NOT_FOUND });
    expect((await (await fixture.provider()).listPasskeys(BOB)).map((entry) => entry.id)).toEqual([bobs.id]);
  });

  test("remove ends the account's other sessions and re-issues the caller's own cookie", async () => {
    const t2 = await signIn(ALICE, ALICE_PASSWORD);
    const t1 = await signIn(ALICE, ALICE_PASSWORD);
    const passkey = await register();
    const res = await post({ action: "remove", id: passkey.id, password: ALICE_PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const t3 = currentToken();
    expect(t3).not.toBe(t1);

    useToken(t2);
    deletedCookies.length = 0;
    expect((await get()).status).toBe(401);
    expect(deletedCookies.map((entry) => entry.name)).toContain("auth-token");

    useToken(t3);
    const listed = await get();
    expect(listed.status).toBe(200);
    expect((await listed.json()).passkeys).toEqual([]);
  });

  test("an unknown action is 400; a body over 64 KiB is 413; invalid JSON is 400", async () => {
    await signIn(ALICE, ALICE_PASSWORD);
    for (const action of ["nope", "toString", "__proto__", 7, null]) {
      // oxlint-disable-next-line no-await-in-loop -- each request must land before the next is counted.
      const res = await post({ action });
      expect({ action, status: res.status }).toEqual({ action, status: 400 });
      // oxlint-disable-next-line no-await-in-loop -- each request must land before the next is counted.
      expect(await res.json()).toEqual({
        error: "action must be register-options, register-verify, rename or remove",
      });
    }
    const large = await post({ action: "rename", name: "x".repeat(70_000) });
    expect(large.status).toBe(413);
    expect(await large.json()).toEqual({ error: "Request body is too large" });
    const invalid = await postRaw("{not json");
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "Invalid request body" });
  });

  test("remove answers 409, keeps the passkey and re-issues nothing when the account changed underneath", async () => {
    const token = await signIn(ALICE, ALICE_PASSWORD);
    const passkey = await register();
    const provider = await fixture.provider();
    const original = provider.deletePasskey.bind(provider);
    const spy = spyOn(provider, "deletePasskey").mockImplementationOnce(async (write) => {
      const row = await provider.getAccount(ALICE);
      if (!row) throw new Error("alice missing");
      // An admin role change commits between the service's read and its conditional write.
      await provider.updateAccount(
        { ...row, role: "admin", sessionVersion: row.sessionVersion + 1, updatedAt: new Date().toISOString() },
        { expected: row },
      );
      return original(write);
    });
    try {
      const res = await post({ action: "remove", id: passkey.id, password: ALICE_PASSWORD });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: ACCOUNT_CHANGED });
    } finally {
      spy.mockRestore();
    }
    expect((await provider.listPasskeys(ALICE)).map((entry) => entry.id)).toEqual([passkey.id]);
    expect(currentToken()).toBe(token);
  });

  test("OIDC mode and local storage answer 409 with the reason", async () => {
    await signIn(ALICE, ALICE_PASSWORD);
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    const oidc = await post({ action: "register-options", password: ALICE_PASSWORD });
    expect(oidc.status).toBe(409);
    expect(await oidc.json()).toEqual({ error: PASSKEYS_OIDC });
    expect(await (await get()).json()).toEqual({ available: false, mode: "oidc", reason: PASSKEYS_OIDC });

    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    await closeStorageProvider();
    process.env.STORAGE_PROVIDER = "local";
    const local = await post({ action: "register-options", password: ALICE_PASSWORD });
    expect(local.status).toBe(409);
    expect(await local.json()).toEqual({ error: PASSKEYS_LOCAL });
    expect(await (await get()).json()).toEqual({ available: false, mode: "local-storage", reason: PASSKEYS_LOCAL });
  });

  test("a misconfigured PASSKEY_ORIGIN answers 503 naming the variable", async () => {
    await signIn(ALICE, ALICE_PASSWORD);
    process.env.PASSKEY_ORIGIN = MISCONFIGURED_ORIGIN;
    const res = await post({ action: "register-options", password: ALICE_PASSWORD });
    expect(res.status).toBe(503);
    const { error } = await res.json();
    expect(error).toContain("PASSKEY_ORIGIN");
    expect(error).not.toContain("passkeys.internal.test");
  });

  test("every response is no-store", async () => {
    // Each helper checks the header; this adds the 429 the login budget answers.
    await signIn(ALICE, ALICE_PASSWORD);
    for (let i = 0; i < 5; i++) {
      // oxlint-disable-next-line no-await-in-loop -- each request must land before the next is counted.
      await post({ action: "register-options", password: WRONG_PASSWORD }, "198.51.100.3");
    }
    const throttled = await post({ action: "register-options", password: ALICE_PASSWORD }, "198.51.100.3");
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get("retry-after")).not.toBeNull();
  });
});
