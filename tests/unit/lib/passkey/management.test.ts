/**
 * The owner's passkey management: list, add behind the password
 * and code, rename, and remove, each write conditional on the version the service read.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/server";
import { cookieJar, installNextHeadersMock, resetCookieJar } from "../../../helpers/next-cookie-jar";
import { SoftAuthenticator } from "../../../helpers/passkey-authenticator";
import {
  makeStoredPasskey,
  openStoreFixture,
  PASSKEY_TEST_ORIGIN,
  PASSKEY_TEST_RP_ID,
  type StoreFixture,
} from "../../../helpers/passkey-store-fixture";
import { RFC6238_SECRET, totpCodeFor } from "../../../helpers/rfc6238";

installNextHeadersMock();

const { beginPasskeyRegistration, completePasskeyRegistration, passkeyStatus, removeOwnPasskey, renameOwnPasskey } =
  await import("@/lib/passkey/management");
const { AccountError, ACCOUNT_CHANGED, changeAccount, listPublicAccounts } = await import("@/lib/local-accounts");
const { AuthConfigError } = await import("@/lib/auth-errors");
const { PASSKEY_MAX_PER_ACCOUNT } = await import("@/lib/passkey/policy");
const { challengeHash } = await import("@/lib/passkey/ceremony");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { clearTotpReplayState } = await import("@/lib/totp");

type Session = { role: "admin" | "user"; username: string; sessionVersion?: number };

const ADMIN = "admin@libredb.org";
const ALICE = "alice@example.com";
const BOB = "bob@example.com";
// Placeholders, not credentials: a realistic literal here is what secret scanners flag.
const ALICE_PASSWORD = "password-alice";
const BOB_PASSWORD = "password-bob";
const REGISTRATION_COOKIE = "passkey-registration";

const SIGN_IN_AGAIN = "Sign in again to manage passkeys.";
const SETUP_EXPIRED = "The passkey setup expired or belongs to another sign-in. Start again.";
const NOT_VERIFIED = "The passkey could not be verified. Try again.";
const ALREADY_REGISTERED = "This passkey is already registered.";
const CONCURRENT = "Another passkey was added at the same time. Start again.";
const ACCOUNT_GONE = "This account no longer exists.";
const LIMIT_REACHED = "An account holds at most 20 passkeys. Remove one before adding another.";
const NAME_INVALID = "Name a passkey with 1 to 64 characters.";
const NOT_FOUND = "No passkey with that id on your account.";
const ID_INVALID = "id must be a string.";
const NOT_IN_STORE = "This session has no account in the registry.";
const PASSKEYS_OIDC = "Passkeys for this sign-in are managed by your identity provider.";
const PASSKEYS_LOCAL =
  "Passkeys need STORAGE_PROVIDER=sqlite or postgres: with STORAGE_PROVIDER=local there is no account registry to keep them in.";
const PASSKEYS_OFF =
  "Passkeys are off on this server. An administrator turns them on by setting PASSKEY_ORIGIN to the address people open Studio at, such as https://studio.example.com.";
const ORIGIN_SCHEME =
  "PASSKEY_ORIGIN must use https: browsers offer passkeys only on a secure origin, and plain http works only for http://localhost.";

const PUBLIC_KEYS = ["backupEligible", "backupState", "createdAt", "id", "lastUsedAt", "name", "usable"];

let fixture: StoreFixture;
let log: ReturnType<typeof spyOn<Console, "log">>;

function auditLines(): Record<string, unknown>[] {
  return log.mock.calls
    .map((call) => {
      try {
        return JSON.parse(String(call[0])) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((line): line is Record<string, unknown> => line !== null && line.event === "account");
}

function audited(action: string, outcome: "success" | "failure"): Record<string, unknown>[] {
  return auditLines().filter((line) => line.action === action && line.outcome === outcome);
}

async function refusal(run: () => Promise<unknown>): Promise<InstanceType<typeof AccountError>> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AccountError) return error;
    throw error;
  }
  throw new Error("expected an AccountError");
}

async function sessionOf(email: string): Promise<Session> {
  const account = await (await fixture.provider()).getAccount(email);
  if (!account) throw new Error(`${email} missing`);
  return { role: account.role, username: account.email, sessionVersion: account.sessionVersion };
}

function registrationCookie(): string {
  const entry = cookieJar.get(REGISTRATION_COOKIE);
  if (!entry) throw new Error("no registration cookie");
  return entry.value;
}

function putRegistrationCookie(value: string): void {
  cookieJar.set(REGISTRATION_COOKIE, { value });
}

async function begin(email: string, password = ALICE_PASSWORD): Promise<PublicKeyCredentialCreationOptionsJSON> {
  return beginPasskeyRegistration(await sessionOf(email), { password });
}

async function registerWith(authenticator: SoftAuthenticator, email: string, password = ALICE_PASSWORD, name?: string) {
  const options = await begin(email, password);
  const response = await authenticator.register(options);
  return completePasskeyRegistration(await sessionOf(email), { response, ...(name === undefined ? {} : { name }) });
}

async function insertStored(email: string, overrides: Parameters<typeof makeStoredPasskey>[0]) {
  const provider = await fixture.provider();
  const account = await provider.getAccount(email);
  if (!account) throw new Error(`${email} missing`);
  const passkey = makeStoredPasskey(overrides);
  await provider.insertPasskey({
    passkey,
    userHandle: (await provider.getPasskeyUserHandle(email)) ?? randomBytes(64).toString("base64url"),
    expectedSessionVersion: account.sessionVersion,
    maxPasskeys: 1000,
    challenge: { hash: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 600_000).toISOString() },
    purgeSpentBefore: new Date().toISOString(),
  });
  return passkey;
}

async function insertMany(email: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    // oxlint-disable-next-line no-await-in-loop -- one SQLite writer, so the inserts run in turn.
    await insertStored(email, { accountEmail: email });
  }
}

async function passkeysOf(email: string) {
  return (await fixture.provider()).listPasskeys(email);
}

describe("passkey management", () => {
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

  test("status explains why passkeys are unavailable in OIDC mode and with local storage", async () => {
    const ghost: Session = { role: "user", username: "nobody@example.com", sessionVersion: 1 };
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    expect(await passkeyStatus(ghost)).toEqual({ available: false, mode: "oidc", reason: PASSKEYS_OIDC });
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    process.env.STORAGE_PROVIDER = "local";
    expect(await passkeyStatus(ghost)).toEqual({ available: false, mode: "local-storage", reason: PASSKEYS_LOCAL });
  });

  test("status lists the account's passkeys without credential IDs or keys, and marks those registered for another RP ID", async () => {
    await registerWith(
      await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN }),
      ALICE,
      ALICE_PASSWORD,
      "Laptop",
    );
    const old = await insertStored(ALICE, { accountEmail: ALICE, rpId: "old.example", name: "Old" });
    const status = await passkeyStatus(await sessionOf(ALICE));
    if (!status.available || !status.canAdd) throw new Error("expected an addable status");
    expect(status.origin).toBe(PASSKEY_TEST_ORIGIN);
    expect(status.rpId).toBe(PASSKEY_TEST_RP_ID);
    expect(status.totpEnabled).toBe(false);
    expect(status.passkeys).toHaveLength(2);
    for (const passkey of status.passkeys) expect(Object.keys(passkey).sort()).toEqual(PUBLIC_KEYS);
    expect(status.passkeys.find((passkey) => passkey.name === "Laptop")?.usable).toBe(true);
    expect(status.passkeys.find((passkey) => passkey.id === old.id)?.usable).toBe(false);
  });

  test("status keeps the list when PASSKEY_ORIGIN is unset, says adding is off, and leaves usability unknown", async () => {
    const stored = await insertStored(ALICE, { accountEmail: ALICE });
    delete process.env.PASSKEY_ORIGIN;
    const off = await passkeyStatus(await sessionOf(ALICE));
    expect(off).toEqual({
      available: true,
      canAdd: false,
      reason: PASSKEYS_OFF,
      totpEnabled: false,
      passkeys: [
        {
          id: stored.id,
          name: stored.name,
          createdAt: stored.createdAt,
          lastUsedAt: null,
          backupEligible: false,
          backupState: false,
          usable: null,
        },
      ],
    });
    process.env.PASSKEY_ORIGIN = "http://studio.example.com";
    const misconfigured = await passkeyStatus(await sessionOf(ALICE));
    if (!misconfigured.available || misconfigured.canAdd) throw new Error("expected a status without adding");
    expect(misconfigured.reason).toBe(ORIGIN_SCHEME);
    expect(misconfigured.passkeys[0].usable).toBeNull();
  });

  test("status of a session with no account row is 404", async () => {
    const error = await refusal(() =>
      passkeyStatus({ role: "user", username: "nobody@example.com", sessionVersion: 1 }),
    );
    expect(error.status).toBe(404);
    expect(error.message).toBe(NOT_IN_STORE);
  });

  test("a session without a username or session version must sign in again", async () => {
    for (const session of [
      { role: "user", username: "", sessionVersion: 1 },
      { role: "user", username: ALICE },
      { role: "user", username: ALICE, sessionVersion: 1.5 },
    ] as Session[]) {
      // oxlint-disable-next-line no-await-in-loop -- the cases share one store and run in turn.
      const error = await refusal(() => passkeyStatus(session));
      expect(error.status).toBe(401);
      expect(error.message).toBe(SIGN_IN_AGAIN);
    }
  });

  test("beginning a registration needs the current password, and a current code when TOTP is on", async () => {
    const provider = await fixture.provider();
    const alice = await sessionOf(ALICE);
    expect((await refusal(() => beginPasskeyRegistration(alice, {}))).status).toBe(400);
    expect((await refusal(() => beginPasskeyRegistration(alice, { password: "wrong-password" }))).status).toBe(401);
    expect(audited("passkey_add", "failure").map((line) => line.reason)).toEqual(["bad_credentials"]);

    const carol = "carol@example.com";
    await fixture.createAccount({ email: carol, password: ALICE_PASSWORD, role: "user", totpSecret: RFC6238_SECRET });
    const session = await sessionOf(carol);
    const missing = await refusal(() => beginPasskeyRegistration(session, { password: ALICE_PASSWORD }));
    expect(missing.status).toBe(400);
    expect(missing.codeRequired).toBe(true);
    const wrong = await refusal(() =>
      beginPasskeyRegistration(session, {
        password: ALICE_PASSWORD,
        code: totpCodeFor(RFC6238_SECRET, Date.now(), 10),
      }),
    );
    expect(wrong.status).toBe(401);
    expect(audited("passkey_add", "failure").map((line) => line.reason)).toEqual(["bad_credentials", "bad_totp"]);
    expect(cookieJar.has(REGISTRATION_COOKIE)).toBe(false);

    const options = await beginPasskeyRegistration(session, {
      password: ALICE_PASSWORD,
      code: totpCodeFor(RFC6238_SECRET),
    });
    expect(options.rp.id).toBe(PASSKEY_TEST_RP_ID);
    expect(options.user.name).toBe(carol);
    expect(cookieJar.has(REGISTRATION_COOKIE)).toBe(true);
    expect(await provider.getPasskeyUserHandle(carol)).toBeNull();
    expect(await provider.getPasskeyUserHandle(ALICE)).toBeNull();
    expect(await passkeysOf(carol)).toEqual([]);
  });

  test("beginning a registration reuses the account's user handle and excludes its current credentials", async () => {
    const authenticator = await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN });
    await registerWith(authenticator, ALICE);
    await insertStored(ALICE, { accountEmail: ALICE, rpId: "old.example" });
    const handle = await (await fixture.provider()).getPasskeyUserHandle(ALICE);
    const options = await begin(ALICE);
    expect(options.user.id).toBe(handle as string);
    expect(options.excludeCredentials?.map((entry) => entry.id)).toEqual([authenticator.credentialId]);
  });

  test("beginning a registration is refused when passkeys are not ready", async () => {
    delete process.env.PASSKEY_ORIGIN;
    const off = await refusal(() => begin(ALICE, "wrong-password"));
    expect(off.status).toBe(409);
    expect(off.message).toBe(PASSKEYS_OFF);
    expect(auditLines()).toEqual([]);
    process.env.PASSKEY_ORIGIN = "http://studio.example.com";
    await expect(begin(ALICE)).rejects.toBeInstanceOf(AuthConfigError);
  });

  test("beginning a registration from a session the account has since ended opens no ceremony", async () => {
    const stale = await sessionOf(ALICE);
    await changeAccount(ADMIN, ALICE, { role: "admin" });
    const moved = await refusal(() => beginPasskeyRegistration(stale, { password: "wrong-password" }));
    expect(moved.status).toBe(409);
    expect(moved.message).toBe(ACCOUNT_CHANGED);

    // A disabled account is refused even with a session that carries its current version.
    await changeAccount(ADMIN, ALICE, { disabled: true });
    const disabled = await refusal(async () =>
      beginPasskeyRegistration(await sessionOf(ALICE), { password: ALICE_PASSWORD }),
    );
    expect(disabled.status).toBe(409);
    expect(disabled.message).toBe(ACCOUNT_CHANGED);

    // Refused before the password, so nothing is charged or audited, and no cookie is set.
    expect(auditLines().filter((line) => line.action === "passkey_add")).toEqual([]);
    expect(cookieJar.has(REGISTRATION_COOKIE)).toBe(false);
  });

  test("the passkey past the limit is refused before the password is checked", async () => {
    await insertMany(ALICE, PASSKEY_MAX_PER_ACCOUNT);
    const error = await refusal(() => begin(ALICE, "wrong-password"));
    expect(error.status).toBe(409);
    expect(error.message).toBe(LIMIT_REACHED);
    expect(auditLines().filter((line) => line.reason === "bad_credentials")).toEqual([]);
  });

  test("completing a registration stores the passkey with the user's name, or Passkey when blank", async () => {
    const named = await registerWith(
      await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN }),
      ALICE,
      ALICE_PASSWORD,
      "  Work laptop  ",
    );
    expect(named.name).toBe("Work laptop");
    expect(named.usable).toBe(true);
    expect(Object.keys(named).sort()).toEqual(PUBLIC_KEYS);
    const blank = await registerWith(
      await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN }),
      ALICE,
      ALICE_PASSWORD,
      "",
    );
    expect(blank.name).toBe("Passkey");
    const absent = await registerWith(await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN }), ALICE);
    expect(absent.name).toBe("Passkey");

    const provider = await fixture.provider();
    const stored = await passkeysOf(ALICE);
    expect(stored.map((passkey) => passkey.id)).toEqual([named.id, blank.id, absent.id]);
    expect(stored.every((passkey) => passkey.rpId === PASSKEY_TEST_RP_ID)).toBe(true);
    const handle = await provider.getPasskeyUserHandle(ALICE);
    expect(handle).not.toBeNull();
    expect((await provider.findPasskey(stored[0].credentialId))?.userHandle).toBe(handle as string);
    const added = audited("passkey_add", "success");
    expect(added.map((line) => line.passkey)).toEqual([named.id, blank.id, absent.id]);
    expect(added[0].actor).toBe(ALICE);
    expect(added[0].route).toBe(ALICE);
  });

  test("completing a registration spends its challenge and keeps the spent-challenge grace", async () => {
    const provider = await fixture.provider();
    const insert = spyOn(provider, "insertPasskey");
    try {
      const options = await begin(ALICE);
      const response = await (await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN })).register(options);
      const before = Date.now();
      await completePasskeyRegistration(await sessionOf(ALICE), { response });
      const after = Date.now();
      expect(insert).toHaveBeenCalledTimes(1);
      const write = insert.mock.calls[0][0];
      expect(write.challenge.hash).toBe(challengeHash(options.challenge));
      const purge = Date.parse(write.purgeSpentBefore);
      // PASSKEY_SPENT_GRACE_SECONDS behind the clock, never up to now.
      expect(purge).toBeGreaterThanOrEqual(before - 600_000);
      expect(purge).toBeLessThanOrEqual(after - 600_000);
    } finally {
      insert.mockRestore();
    }
  });

  test("completing a registration refuses a ceremony for another account or session version", async () => {
    const authenticator = await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN });
    const options = await begin(ALICE);
    const cookie = registrationCookie();
    const response = await authenticator.register(options);
    const asBob = await refusal(async () => completePasskeyRegistration(await sessionOf(BOB), { response }));
    expect(asBob.status).toBe(400);
    expect(asBob.message).toBe(SETUP_EXPIRED);
    putRegistrationCookie(cookie);
    const alice = await sessionOf(ALICE);
    const moved = await refusal(() =>
      completePasskeyRegistration({ ...alice, sessionVersion: (alice.sessionVersion as number) + 1 }, { response }),
    );
    expect(moved.message).toBe(SETUP_EXPIRED);
    expect(audited("passkey_add", "failure").map((line) => line.reason)).toEqual([
      "passkey_ceremony_invalid",
      "passkey_ceremony_invalid",
    ]);
    expect(await passkeysOf(ALICE)).toEqual([]);
    expect(await passkeysOf(BOB)).toEqual([]);
  });

  test("completing a registration refuses another account's ceremony even at an equal session version", async () => {
    // Equal versions, so the ceremony's account binding is the only check that tells Bob from Alice.
    const provider = await fixture.provider();
    const alice = await sessionOf(ALICE);
    const bobRow = await provider.getAccount(BOB);
    if (!bobRow) throw new Error(`${BOB} missing`);
    await provider.updateAccount({ ...bobRow, sessionVersion: alice.sessionVersion as number }, { expected: bobRow });
    const bob = await sessionOf(BOB);
    expect(bob.sessionVersion).toBe(alice.sessionVersion);

    const options = await begin(ALICE);
    const response = await (await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN })).register(options);
    const asBob = await refusal(() => completePasskeyRegistration(bob, { response }));
    expect(asBob.status).toBe(400);
    expect(asBob.message).toBe(SETUP_EXPIRED);
    expect(audited("passkey_add", "failure")).toEqual([
      expect.objectContaining({ actor: BOB, reason: "passkey_ceremony_invalid" }),
    ]);
    expect(await passkeysOf(ALICE)).toEqual([]);
    expect(await passkeysOf(BOB)).toEqual([]);
    expect(await provider.getPasskeyUserHandle(BOB)).toBeNull();
  });

  test("completing a registration refuses a ceremony opened under another RP ID", async () => {
    const options = await begin(ALICE);
    const response = await (await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN })).register(options);
    process.env.PASSKEY_ORIGIN = "https://other.example";
    const error = await refusal(async () => completePasskeyRegistration(await sessionOf(ALICE), { response }));
    expect(error.status).toBe(400);
    expect(error.message).toBe(SETUP_EXPIRED);
    // Refused on the ceremony, not later on the response's origin.
    expect(audited("passkey_add", "failure").map((line) => line.reason)).toEqual(["passkey_ceremony_invalid"]);
    expect(await passkeysOf(ALICE)).toEqual([]);
  });

  test("a registration whose account changed after the ceremony began stores nothing", async () => {
    const provider = await fixture.provider();
    const original = provider.insertPasskey.bind(provider);
    const options = await begin(ALICE);
    const session = await sessionOf(ALICE);
    const response = await (await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN })).register(options);
    const spy = spyOn(provider, "insertPasskey").mockImplementationOnce(async (write) => {
      await changeAccount(ADMIN, ALICE, { role: "admin" });
      return original(write);
    });
    const error = await refusal(() => completePasskeyRegistration(session, { response }));
    spy.mockRestore();
    expect(error.status).toBe(409);
    expect(error.message).toBe(ACCOUNT_CHANGED);
    expect(audited("passkey_add", "failure").map((line) => line.reason)).toEqual(["passkey_ceremony_invalid"]);
    expect(await passkeysOf(ALICE)).toEqual([]);

    // The control: the same flow without the interleave stores the passkey.
    const again = await registerWith(await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN }), ALICE);
    expect((await passkeysOf(ALICE)).map((passkey) => passkey.id)).toEqual([again.id]);
  });

  test("a registration whose account was deleted after the ceremony began is 404", async () => {
    const provider = await fixture.provider();
    const original = provider.insertPasskey.bind(provider);
    const options = await begin(ALICE);
    const session = await sessionOf(ALICE);
    const response = await (await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN })).register(options);
    const spy = spyOn(provider, "insertPasskey").mockImplementationOnce(async (write) => {
      await provider.deleteAccount(ALICE);
      return original(write);
    });
    const error = await refusal(() => completePasskeyRegistration(session, { response }));
    spy.mockRestore();
    expect(error.status).toBe(404);
    expect(error.message).toBe(ACCOUNT_GONE);
    expect(audited("passkey_add", "failure")).toEqual([]);
  });

  test("a registration that the limit overtook during the ceremony is refused", async () => {
    const provider = await fixture.provider();
    const original = provider.insertPasskey.bind(provider);
    const options = await begin(ALICE);
    const session = await sessionOf(ALICE);
    const response = await (await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN })).register(options);
    const spy = spyOn(provider, "insertPasskey").mockImplementationOnce(async (write) => {
      spy.mockRestore();
      await insertMany(ALICE, PASSKEY_MAX_PER_ACCOUNT);
      return original(write);
    });
    const error = await refusal(() => completePasskeyRegistration(session, { response }));
    expect(error.status).toBe(409);
    expect(error.message).toBe(LIMIT_REACHED);
    expect(audited("passkey_add", "failure").map((line) => line.reason)).toEqual(["account_refused"]);
    expect(await passkeysOf(ALICE)).toHaveLength(PASSKEY_MAX_PER_ACCOUNT);
  });

  test("completing a registration without a ceremony cookie is refused", async () => {
    const options = await begin(ALICE);
    const response = await (await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN })).register(options);
    resetCookieJar();
    const error = await refusal(async () => completePasskeyRegistration(await sessionOf(ALICE), { response }));
    expect(error.status).toBe(400);
    expect(error.message).toBe(SETUP_EXPIRED);
    expect(await passkeysOf(ALICE)).toEqual([]);
  });

  test("a refused registration is audited with its reason and changes nothing", async () => {
    const authenticator = await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN });
    const foreign = await authenticator.register(await begin(ALICE), { origin: "https://evil.example" });
    const originError = await refusal(async () =>
      completePasskeyRegistration(await sessionOf(ALICE), { response: foreign }),
    );
    expect(originError.status).toBe(400);
    expect(originError.message).toBe(NOT_VERIFIED);
    const noUv = await authenticator.register(await begin(ALICE), { userVerified: false });
    const uvError = await refusal(async () => completePasskeyRegistration(await sessionOf(ALICE), { response: noUv }));
    expect(uvError.message).toBe(NOT_VERIFIED);
    expect(audited("passkey_add", "failure").map((line) => line.reason)).toEqual([
      "passkey_origin_mismatch",
      "passkey_rejected",
    ]);
    expect(await passkeysOf(ALICE)).toEqual([]);
  });

  test("a replayed registration is refused", async () => {
    const options = await begin(ALICE);
    const cookie = registrationCookie();
    const response = await (await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN })).register(options);
    await completePasskeyRegistration(await sessionOf(ALICE), { response });
    putRegistrationCookie(cookie);
    const error = await refusal(async () => completePasskeyRegistration(await sessionOf(ALICE), { response }));
    expect(error.status).toBe(400);
    expect(error.message).toBe(SETUP_EXPIRED);
    expect(audited("passkey_add", "failure").map((line) => line.reason)).toEqual(["passkey_replayed"]);
    expect(await passkeysOf(ALICE)).toHaveLength(1);
  });

  test("a credential already registered to another account is refused as a duplicate", async () => {
    const authenticator = await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN });
    await registerWith(authenticator, ALICE);
    const error = await refusal(() => registerWith(authenticator, BOB, BOB_PASSWORD));
    expect(error.status).toBe(409);
    expect(error.message).toBe(ALREADY_REGISTERED);
    expect(audited("passkey_add", "failure").map((line) => line.reason)).toEqual(["passkey_duplicate"]);
    expect(await passkeysOf(BOB)).toEqual([]);
  });

  test("a first registration that lost a race to another is refused", async () => {
    const first = await begin(ALICE);
    const firstCookie = registrationCookie();
    const second = await begin(ALICE);
    expect(second.user.id).not.toBe(first.user.id);
    const winner = await (await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN })).register(second);
    await completePasskeyRegistration(await sessionOf(ALICE), { response: winner });
    putRegistrationCookie(firstCookie);
    const loser = await (await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN })).register(first);
    const error = await refusal(async () => completePasskeyRegistration(await sessionOf(ALICE), { response: loser }));
    expect(error.status).toBe(409);
    expect(error.message).toBe(CONCURRENT);
    expect(audited("passkey_add", "failure").map((line) => line.reason)).toEqual(["passkey_ceremony_invalid"]);
    expect(await passkeysOf(ALICE)).toHaveLength(1);
    expect(await (await fixture.provider()).getPasskeyUserHandle(ALICE)).toBe(second.user.id);
  });

  test("a store failure other than a conflict reaches the caller unchanged, and nothing is audited as a refusal", async () => {
    const provider = await fixture.provider();
    const options = await begin(ALICE);
    const session = await sessionOf(ALICE);
    const response = await (await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN })).register(options);
    const failure = new Error("disk full");
    const spy = spyOn(provider, "insertPasskey").mockImplementationOnce(async () => {
      throw failure;
    });
    let caught: unknown;
    try {
      await completePasskeyRegistration(session, { response });
    } catch (error) {
      caught = error;
    }
    spy.mockRestore();
    expect(caught).toBe(failure);
    expect(audited("passkey_add", "failure")).toEqual([]);
  });

  test("an invalid name is refused before verification", async () => {
    for (const name of ["x".repeat(65), "   ", "bad\u0007name", 42]) {
      // oxlint-disable-next-line no-await-in-loop -- each attempt takes the one registration cookie, so they run in turn.
      const error = await refusal(async () => {
        const response = await (await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN })).register(
          await begin(ALICE),
        );
        return completePasskeyRegistration(await sessionOf(ALICE), { response, name });
      });
      expect(error.status).toBe(400);
      expect(error.message).toBe(NAME_INVALID);
    }
    expect(await passkeysOf(ALICE)).toEqual([]);
    expect(audited("passkey_add", "failure")).toEqual([]);
  });

  test("rename validates the name and touches only the caller's passkey", async () => {
    const own = await insertStored(ALICE, { accountEmail: ALICE });
    const bobs = await insertStored(BOB, { accountEmail: BOB, name: "Bob's" });
    const alice = await sessionOf(ALICE);
    const renamed = await renameOwnPasskey(alice, { id: own.id, name: " Phone " });
    expect(renamed).toEqual({
      id: own.id,
      name: "Phone",
      createdAt: own.createdAt,
      lastUsedAt: null,
      backupEligible: false,
      backupState: false,
      usable: true,
    });
    expect((await passkeysOf(ALICE))[0].name).toBe("Phone");
    expect(audited("passkey_rename", "success").map((line) => line.passkey)).toEqual([own.id]);

    const foreign = await refusal(() => renameOwnPasskey(alice, { id: bobs.id, name: "Mine" }));
    expect(foreign.status).toBe(404);
    expect(foreign.message).toBe(NOT_FOUND);
    expect((await passkeysOf(BOB))[0].name).toBe("Bob's");
    const badId = await refusal(() => renameOwnPasskey(alice, { id: 7, name: "Mine" }));
    expect(badId.status).toBe(400);
    expect(badId.message).toBe(ID_INVALID);
    for (const name of ["", "   ", undefined, "y".repeat(65)]) {
      // oxlint-disable-next-line no-await-in-loop -- the cases share one store and run in turn.
      const error = await refusal(() => renameOwnPasskey(alice, { id: own.id, name }));
      expect(error.status).toBe(400);
      expect(error.message).toBe(NAME_INVALID);
    }
    expect((await refusal(() => renameOwnPasskey(alice, null))).message).toBe(ID_INVALID);
  });

  test("removal needs the current password, and a current code when TOTP is on, and returns the advanced session version", async () => {
    const carol = "carol@example.com";
    await fixture.createAccount({ email: carol, password: ALICE_PASSWORD, role: "user", totpSecret: RFC6238_SECRET });
    const passkey = await insertStored(carol, { accountEmail: carol });
    const session = await sessionOf(carol);
    const version = session.sessionVersion as number;

    const wrong = await refusal(() =>
      removeOwnPasskey(session, { id: passkey.id, password: "wrong-password", code: totpCodeFor(RFC6238_SECRET) }),
    );
    expect(wrong.status).toBe(401);
    const noCode = await refusal(() => removeOwnPasskey(session, { id: passkey.id, password: ALICE_PASSWORD }));
    expect(noCode.status).toBe(400);
    expect(noCode.codeRequired).toBe(true);
    expect(await passkeysOf(carol)).toHaveLength(1);
    expect(audited("passkey_remove", "failure").map((line) => line.reason)).toEqual(["bad_credentials"]);

    const unknown = await refusal(() =>
      removeOwnPasskey(session, { id: "no-such-id", password: ALICE_PASSWORD, code: totpCodeFor(RFC6238_SECRET) }),
    );
    expect(unknown.status).toBe(404);
    expect(unknown.message).toBe(NOT_FOUND);
    expect((await sessionOf(carol)).sessionVersion).toBe(version);

    clearTotpReplayState();
    const next = await removeOwnPasskey(session, {
      id: passkey.id,
      password: ALICE_PASSWORD,
      code: totpCodeFor(RFC6238_SECRET),
    });
    expect(next).toBe(version + 1);
    expect((await sessionOf(carol)).sessionVersion).toBe(version + 1);
    expect(await passkeysOf(carol)).toEqual([]);
    expect(audited("passkey_remove", "success").map((line) => line.passkey)).toEqual([passkey.id]);
    expect((await refusal(() => removeOwnPasskey(session, { id: 1, password: ALICE_PASSWORD }))).message).toBe(
      ID_INVALID,
    );
  });

  test("removing another account's passkey is 404 and leaves it in place", async () => {
    const bobs = await insertStored(BOB, { accountEmail: BOB });
    const session = await sessionOf(ALICE);
    const error = await refusal(() => removeOwnPasskey(session, { id: bobs.id, password: ALICE_PASSWORD }));
    expect(error.status).toBe(404);
    expect(error.message).toBe(NOT_FOUND);
    expect((await passkeysOf(BOB)).map((passkey) => passkey.id)).toEqual([bobs.id]);
    expect((await sessionOf(ALICE)).sessionVersion).toBe(session.sessionVersion as number);
    expect(audited("passkey_remove", "success")).toEqual([]);
  });

  test("a removal after the account's sessions ended removes nothing", async () => {
    const provider = await fixture.provider();
    const passkey = await insertStored(ALICE, { accountEmail: ALICE });
    const session = await sessionOf(ALICE);
    const original = provider.deletePasskey.bind(provider);
    const spy = spyOn(provider, "deletePasskey").mockImplementationOnce(async (write) => {
      await changeAccount(ADMIN, ALICE, { role: "admin" });
      return original(write);
    });
    const error = await refusal(() => removeOwnPasskey(session, { id: passkey.id, password: ALICE_PASSWORD }));
    spy.mockRestore();
    expect(error.status).toBe(409);
    expect(error.message).toBe(ACCOUNT_CHANGED);
    expect(audited("passkey_remove", "failure").map((line) => line.reason)).toEqual(["account_refused"]);
    expect(await passkeysOf(ALICE)).toHaveLength(1);
    expect((await sessionOf(ALICE)).sessionVersion).toBe((session.sessionVersion as number) + 1);
  });

  test("a store failure during removal reaches the caller unchanged", async () => {
    const provider = await fixture.provider();
    const passkey = await insertStored(ALICE, { accountEmail: ALICE });
    const failure = new Error("disk full");
    const spy = spyOn(provider, "deletePasskey").mockImplementationOnce(async () => {
      throw failure;
    });
    let caught: unknown;
    try {
      await removeOwnPasskey(await sessionOf(ALICE), { id: passkey.id, password: ALICE_PASSWORD });
    } catch (error) {
      caught = error;
    }
    spy.mockRestore();
    expect(caught).toBe(failure);
  });

  test("removal works while PASSKEY_ORIGIN is unset", async () => {
    const passkey = await insertStored(ALICE, { accountEmail: ALICE });
    delete process.env.PASSKEY_ORIGIN;
    const session = await sessionOf(ALICE);
    const status = await passkeyStatus(session);
    expect(status.available && status.passkeys.map((entry) => entry.id)).toEqual([passkey.id]);
    const renamed = await renameOwnPasskey(session, { id: passkey.id, name: "Old phone" });
    expect(renamed.usable).toBeNull();
    const next = await removeOwnPasskey(session, { id: passkey.id, password: ALICE_PASSWORD });
    expect(next).toBe((session.sessionVersion as number) + 1);
    expect(await passkeysOf(ALICE)).toEqual([]);
  });

  test("management is refused in OIDC mode", async () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    const session = await sessionOf(ALICE);
    for (const run of [
      () => renameOwnPasskey(session, { id: "x", name: "y" }),
      () => removeOwnPasskey(session, { id: "x", password: ALICE_PASSWORD }),
      () => completePasskeyRegistration(session, {}),
    ]) {
      // oxlint-disable-next-line no-await-in-loop -- the cases share one store and run in turn.
      const error = await refusal(run);
      expect(error.status).toBe(409);
      expect(error.message).toBe(PASSKEYS_OIDC);
    }
  });
});
