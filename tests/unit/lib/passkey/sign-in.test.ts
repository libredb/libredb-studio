/**
 * The username-less passkey sign-in:
 * WebAuthn 7.2 in a fixed order, every refusal a closed reason, and nothing written before every check passed.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { AuthenticationResponseJSON, PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/server";
import Database from "better-sqlite3";
import type { PasskeyRefusalReason } from "@/lib/passkey/webauthn";
import type { ServerStorageProvider } from "@/lib/storage/types";
import { type AssertionOverrides, SoftAuthenticator } from "../../../helpers/passkey-authenticator";
import {
  openStoreFixture,
  PASSKEY_TEST_ORIGIN,
  PASSKEY_TEST_RP_ID,
  type StoreFixture,
} from "../../../helpers/passkey-store-fixture";
import { cookieJar, deletedCookies, installNextHeadersMock, resetCookieJar } from "../../../helpers/next-cookie-jar";

installNextHeadersMock();

const { beginPasskeySignIn, completePasskeySignIn } = await import("@/lib/passkey/sign-in");
const { buildRegistrationOptions, PasskeyRefusal, verifyRegistration } = await import("@/lib/passkey/webauthn");
const { challengeHash, openRegistrationCeremony } = await import("@/lib/passkey/ceremony");
const { AccountError } = await import("@/lib/local-accounts");
const { AuthConfigError } = await import("@/lib/auth-errors");

const SIGN_IN_COOKIE = "passkey-sign-in";
const RP = { origin: PASSKEY_TEST_ORIGIN, rpId: PASSKEY_TEST_RP_ID };
// A placeholder, not a credential.
const PASSWORD = "password-owner";

let fixture: StoreFixture;

beforeEach(async () => {
  resetCookieJar();
  fixture = await openStoreFixture();
});

afterEach(async () => {
  await fixture.close();
  resetCookieJar();
});

interface Enrolled {
  email: string;
  authenticator: SoftAuthenticator;
  passkeyId: string;
  userHandle: string;
}

/** Creates an account and registers one passkey for it through the real verification, stored with insertPasskey. */
async function enrol(
  input: { email?: string; backupEligible?: boolean; rpId?: string; signCount?: number; counterless?: boolean } = {},
): Promise<Enrolled> {
  const email = input.email ?? `owner-${randomUUID()}@example.com`;
  const account = await fixture.createAccount({ email, password: PASSWORD, role: "user" });
  const authenticator = await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN, counterless: input.counterless });
  const userHandle = randomBytes(64).toString("base64url");
  const challenge = randomBytes(32).toString("base64url");
  const options = await buildRegistrationOptions({ rp: RP, challenge, userHandle, email, exclude: [] });
  const response = await authenticator.register(options, { backupEligible: input.backupEligible ?? false });
  const verified = await verifyRegistration({ response, challenge, rp: RP });
  const passkeyId = randomUUID();
  const now = new Date().toISOString();
  await (await fixture.provider()).insertPasskey({
    passkey: {
      id: passkeyId,
      credentialId: verified.credentialId,
      accountEmail: email,
      publicKey: verified.publicKey,
      signCount: input.signCount ?? verified.signCount,
      transports: verified.transports,
      backupEligible: verified.backupEligible,
      backupState: verified.backupState,
      rpId: input.rpId ?? PASSKEY_TEST_RP_ID,
      name: "Passkey",
      createdAt: now,
      lastUsedAt: null,
    },
    userHandle,
    expectedSessionVersion: account.sessionVersion,
    maxPasskeys: 20,
    challenge: { hash: challengeHash(challenge), expiresAt: new Date(Date.now() + 600_000).toISOString() },
    purgeSpentBefore: new Date(0).toISOString(),
  });
  if (input.signCount !== undefined) authenticator.signCount = input.signCount;
  return { email, authenticator, passkeyId, userHandle };
}

/** Begins a sign-in, lets the authenticator answer it, and returns the body plus the cookie that carries the ceremony. */
async function attempt(
  enrolled: { authenticator: SoftAuthenticator },
  overrides: AssertionOverrides = {},
  clock?: () => number,
): Promise<{
  body: { response: AuthenticationResponseJSON };
  cookie: string;
  options: PublicKeyCredentialRequestOptionsJSON;
}> {
  const options = await beginPasskeySignIn(clock);
  const cookie = cookieJar.get(SIGN_IN_COOKIE)?.value;
  if (!cookie) throw new Error("beginPasskeySignIn set no cookie");
  return { body: { response: await enrolled.authenticator.assert(options, overrides) }, cookie, options };
}

function restoreCookie(value: string): void {
  cookieJar.set(SIGN_IN_COOKIE, { value });
}

async function refusalOf(run: Promise<unknown>): Promise<InstanceType<typeof PasskeyRefusal>> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(PasskeyRefusal);
    return error as InstanceType<typeof PasskeyRefusal>;
  }
  throw new Error("expected a PasskeyRefusal");
}

function sideDb(): Database.Database {
  return new Database(join(fixture.dir, "store.db"), { readonly: true });
}

function tableCounts(): Record<string, number> {
  const db = sideDb();
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

function spentHashes(): string[] {
  const db = sideDb();
  try {
    return (
      db.prepare("SELECT challenge_hash FROM passkey_spent_challenges ORDER BY challenge_hash").all() as {
        challenge_hash: string;
      }[]
    ).map((row) => row.challenge_hash);
  } finally {
    db.close();
  }
}

function credentialRow(id: string): Record<string, unknown> | undefined {
  const db = sideDb();
  try {
    return db.prepare("SELECT * FROM passkey_credentials WHERE id = ?").get(id) as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}

function withOrigin<T>(origin: string | undefined, run: () => Promise<T>): Promise<T> {
  const saved = process.env.PASSKEY_ORIGIN;
  if (origin === undefined) delete process.env.PASSKEY_ORIGIN;
  else process.env.PASSKEY_ORIGIN = origin;
  return run().finally(() => {
    if (saved === undefined) delete process.env.PASSKEY_ORIGIN;
    else process.env.PASSKEY_ORIGIN = saved;
  });
}

interface RefusalCase {
  name: string;
  reason: PasskeyRefusalReason;
  /** Whether the refusal names the account and passkey it was raised for. */
  context: boolean;
  /**
   * Prepares the store and the cookie jar; returns the body to submit, the passkey whose row must not change,
   * and the enrolled owner a refusal with context must name.
   */
  arrange(): Promise<{ body: unknown; passkeyId: string | null; email?: string }>;
}

const REFUSALS: RefusalCase[] = [
  {
    name: "no ceremony cookie",
    reason: "passkey_ceremony_invalid",
    context: false,
    async arrange() {
      const enrolled = await enrol();
      const { body } = await attempt(enrolled);
      cookieJar.delete(SIGN_IN_COOKIE);
      return { body, passkeyId: enrolled.passkeyId, email: enrolled.email };
    },
  },
  {
    name: "a registration ceremony token in the sign-in cookie",
    reason: "passkey_ceremony_invalid",
    context: false,
    async arrange() {
      const enrolled = await enrol();
      const { body } = await attempt(enrolled);
      await openRegistrationCeremony({
        rpId: PASSKEY_TEST_RP_ID,
        email: enrolled.email,
        sessionVersion: 1,
        userHandle: enrolled.userHandle,
      });
      restoreCookie(cookieJar.get("passkey-registration")?.value as string);
      return { body, passkeyId: enrolled.passkeyId, email: enrolled.email };
    },
  },
  {
    name: "a ceremony for another RP ID",
    reason: "passkey_ceremony_invalid",
    context: false,
    async arrange() {
      const enrolled = await enrol();
      const options = await withOrigin("https://other.example", () => beginPasskeySignIn());
      return {
        body: { response: await enrolled.authenticator.assert(options, { rpId: PASSKEY_TEST_RP_ID }) },
        passkeyId: enrolled.passkeyId,
        email: enrolled.email,
      };
    },
  },
  {
    name: "a response from another origin",
    reason: "passkey_origin_mismatch",
    context: false,
    async arrange() {
      const enrolled = await enrol();
      const { body } = await attempt(enrolled, { origin: "https://evil.example" });
      return { body, passkeyId: enrolled.passkeyId, email: enrolled.email };
    },
  },
  {
    name: "an unknown credential ID",
    reason: "passkey_unknown",
    context: false,
    async arrange() {
      // Opens the store, which no enrolment did here.
      await fixture.provider();
      const stranger = await SoftAuthenticator.create({ origin: PASSKEY_TEST_ORIGIN });
      stranger.userHandle = randomBytes(64).toString("base64url");
      const { body } = await attempt({ authenticator: stranger });
      return { body, passkeyId: null };
    },
  },
  {
    name: "no user handle",
    reason: "passkey_unknown",
    context: false,
    async arrange() {
      const enrolled = await enrol();
      const { body } = await attempt(enrolled, { userHandle: null });
      return { body, passkeyId: enrolled.passkeyId, email: enrolled.email };
    },
  },
  {
    name: "a user handle that is not the owner's",
    reason: "passkey_rejected",
    context: true,
    async arrange() {
      const enrolled = await enrol();
      const { body } = await attempt(enrolled, { userHandle: randomBytes(64).toString("base64url") });
      return { body, passkeyId: enrolled.passkeyId, email: enrolled.email };
    },
  },
  {
    name: "a stored credential registered for another RP ID",
    reason: "passkey_unknown",
    context: true,
    async arrange() {
      const enrolled = await enrol({ rpId: "old.example" });
      const { body } = await attempt(enrolled);
      return { body, passkeyId: enrolled.passkeyId, email: enrolled.email };
    },
  },
  {
    name: "a bad signature",
    reason: "passkey_rejected",
    context: true,
    async arrange() {
      const enrolled = await enrol();
      const { body } = await attempt(enrolled, { badSignature: true });
      return { body, passkeyId: enrolled.passkeyId, email: enrolled.email };
    },
  },
  {
    name: "user verification missing",
    reason: "passkey_rejected",
    context: true,
    async arrange() {
      const enrolled = await enrol();
      const { body } = await attempt(enrolled, { userVerified: false });
      return { body, passkeyId: enrolled.passkeyId, email: enrolled.email };
    },
  },
  {
    name: "user presence missing",
    reason: "passkey_rejected",
    context: true,
    async arrange() {
      const enrolled = await enrol();
      const { body } = await attempt(enrolled, { userPresent: false });
      return { body, passkeyId: enrolled.passkeyId, email: enrolled.email };
    },
  },
  {
    name: "a changed backup eligibility",
    reason: "passkey_rejected",
    context: true,
    async arrange() {
      const enrolled = await enrol({ backupEligible: false });
      const { body } = await attempt(enrolled, { backupEligible: true });
      return { body, passkeyId: enrolled.passkeyId, email: enrolled.email };
    },
  },
  {
    name: "a disabled account",
    reason: "passkey_account_unavailable",
    context: true,
    async arrange() {
      const enrolled = await enrol();
      const provider = await fixture.provider();
      const current = await provider.getAccount(enrolled.email);
      if (!current) throw new Error("account missing");
      await provider.updateAccount(
        { ...current, disabled: true, sessionVersion: current.sessionVersion + 1, updatedAt: new Date().toISOString() },
        { expected: current },
      );
      const { body } = await attempt(enrolled);
      return { body, passkeyId: enrolled.passkeyId, email: enrolled.email };
    },
  },
  {
    name: "a counter that did not increase",
    reason: "passkey_counter",
    context: true,
    async arrange() {
      const enrolled = await enrol({ signCount: 5 });
      const { body } = await attempt(enrolled, { signCount: 5 });
      return { body, passkeyId: enrolled.passkeyId, email: enrolled.email };
    },
  },
];

describe("beginPasskeySignIn", () => {
  test("beginning a sign-in writes nothing to the store", async () => {
    await enrol();
    const before = tableCounts();
    const challenges = new Set<string>();
    const cookies = new Set<string>();
    for (let i = 0; i < 20; i++) {
      // oxlint-disable-next-line no-await-in-loop -- each call replaces the one cookie, so they run in turn.
      const options = await beginPasskeySignIn();
      challenges.add(options.challenge);
      cookies.add(cookieJar.get(SIGN_IN_COOKIE)?.value as string);
      expect(options.rpId).toBe(PASSKEY_TEST_RP_ID);
      expect(options.allowCredentials).toBeUndefined();
    }
    expect(challenges.size).toBe(20);
    expect(cookies.size).toBe(20);
    expect(tableCounts()).toEqual(before);
  });
});

describe("completePasskeySignIn", () => {
  test("a verified assertion returns the stored account and records the use once", async () => {
    const enrolled = await enrol();
    const provider = await fixture.provider();
    const stored = await provider.getAccount(enrolled.email);
    const { body, options } = await attempt(enrolled);
    const spentBefore = tableCounts().spent;

    const result = await completePasskeySignIn(body);

    expect(result.passkeyId).toBe(enrolled.passkeyId);
    expect(result.account.email).toBe(enrolled.email);
    expect(result.account.role).toBe("user");
    expect(result.account.sessionVersion).toBe(stored?.sessionVersion as number);
    const row = credentialRow(enrolled.passkeyId);
    expect(typeof row?.last_used_at).toBe("string");
    expect(row?.sign_count).toBe(1);
    expect(spentHashes()).toContain(challengeHash(options.challenge));
    expect(tableCounts().spent).toBe(spentBefore + 1);
    expect(deletedCookies.some((entry) => entry.name === SIGN_IN_COOKIE)).toBe(true);
  });

  test("a counterless authenticator signs in again and again", async () => {
    const enrolled = await enrol({ counterless: true });
    for (let i = 0; i < 2; i++) {
      // oxlint-disable-next-line no-await-in-loop -- each sign-in needs its own ceremony, one after the other.
      const { body } = await attempt(enrolled);
      // oxlint-disable-next-line no-await-in-loop -- as above.
      const result = await completePasskeySignIn(body);
      expect(result.passkeyId).toBe(enrolled.passkeyId);
    }
    expect(credentialRow(enrolled.passkeyId)?.sign_count).toBe(0);
  });

  describe("each refusal carries its closed reason", () => {
    for (const refusalCase of REFUSALS) {
      test(refusalCase.name, async () => {
        const { body, passkeyId, email } = await refusalCase.arrange();
        const refusal = await refusalOf(completePasskeySignIn(body));
        expect(refusal.reason).toBe(refusalCase.reason);
        if (refusalCase.context) {
          expect(refusal.context).toEqual({ email: email as string, passkeyId: passkeyId as string });
        } else {
          expect(refusal.context).toEqual({});
        }
      });
    }
  });

  test("a counter refusal leaves the account enabled and the stored counter unchanged", async () => {
    const enrolled = await enrol({ signCount: 5 });
    const { body } = await attempt(enrolled, { signCount: 5 });
    await refusalOf(completePasskeySignIn(body));
    expect((await (await fixture.provider()).getAccount(enrolled.email))?.disabled).toBe(false);
    expect(credentialRow(enrolled.passkeyId)?.sign_count).toBe(5);
  });

  test("a replayed assertion is refused", async () => {
    const enrolled = await enrol();
    const { body, cookie } = await attempt(enrolled);
    await completePasskeySignIn(body);
    restoreCookie(cookie);
    const refusal = await refusalOf(completePasskeySignIn(body));
    expect(refusal.reason).toBe("passkey_replayed");
    expect(refusal.context).toEqual({ email: enrolled.email, passkeyId: enrolled.passkeyId });
  });

  describe("no refusal writes a row", () => {
    for (const refusalCase of REFUSALS) {
      test(refusalCase.name, async () => {
        const { body, passkeyId } = await refusalCase.arrange();
        const spentBefore = spentHashes();
        const rowBefore = passkeyId ? credentialRow(passkeyId) : undefined;
        await refusalOf(completePasskeySignIn(body));
        expect(spentHashes()).toEqual(spentBefore);
        if (passkeyId) expect(credentialRow(passkeyId)).toEqual(rowBefore as Record<string, unknown>);
      });
    }
  });

  test("a credential removed between the lookup and the write is refused as unknown", async () => {
    const enrolled = await enrol();
    const provider = await fixture.provider();
    const original = provider.recordPasskeySignIn.bind(provider);
    // A writer outside Studio: only the credential row goes, so the account is still as the service read it.
    const spy = spyOn(provider, "recordPasskeySignIn").mockImplementation(async (write) => {
      const db = new Database(join(fixture.dir, "store.db"));
      try {
        db.prepare("DELETE FROM passkey_credentials WHERE id = ?").run(enrolled.passkeyId);
      } finally {
        db.close();
      }
      return original(write);
    });
    try {
      const { body } = await attempt(enrolled);
      const spentBefore = spentHashes();
      const refusal = await refusalOf(completePasskeySignIn(body));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(refusal.reason).toBe("passkey_unknown");
      expect(refusal.context).toEqual({ email: enrolled.email, passkeyId: enrolled.passkeyId });
      expect(spentHashes()).toEqual(spentBefore);
    } finally {
      spy.mockRestore();
    }
  });

  describe("an account changed between the service's read and its write is refused as unavailable", () => {
    const changes: { name: string; change: (provider: ServerStorageProvider, email: string) => Promise<void> }[] = [
      {
        name: "disabled",
        change: async (provider, email) => {
          const read = await provider.getAccount(email);
          if (!read) throw new Error("account missing");
          await provider.updateAccount(
            { ...read, disabled: true, sessionVersion: read.sessionVersion + 1, updatedAt: new Date().toISOString() },
            { expected: read },
          );
        },
      },
      {
        name: "passkey removed, which moves the session version",
        change: async (provider, email) => {
          const read = await provider.getAccount(email);
          if (!read) throw new Error("account missing");
          const [passkey] = await provider.listPasskeys(email);
          await provider.deletePasskey({
            email,
            id: passkey.id,
            expectedSessionVersion: read.sessionVersion,
            nextSessionVersion: read.sessionVersion + 1,
            updatedAt: new Date().toISOString(),
          });
        },
      },
      { name: "deleted", change: (provider, email) => provider.deleteAccount(email) },
    ];
    for (const { name, change } of changes) {
      test(name, async () => {
        const enrolled = await enrol();
        const provider = await fixture.provider();
        const original = provider.recordPasskeySignIn.bind(provider);
        const spy = spyOn(provider, "recordPasskeySignIn").mockImplementation(async (write) => {
          await change(provider, enrolled.email);
          return original(write);
        });
        try {
          const { body } = await attempt(enrolled);
          const spentBefore = spentHashes();
          const refusal = await refusalOf(completePasskeySignIn(body));
          expect(spy).toHaveBeenCalledTimes(1);
          expect(refusal.reason).toBe("passkey_account_unavailable");
          expect(refusal.context).toEqual({ email: enrolled.email, passkeyId: enrolled.passkeyId });
          expect(spentHashes()).toEqual(spentBefore);
        } finally {
          spy.mockRestore();
        }
      });
    }
  });

  test("a storage failure is not a refusal", async () => {
    const enrolled = await enrol();
    const provider = await fixture.provider();
    const failure = new Error("disk full");
    const spy = spyOn(provider, "recordPasskeySignIn").mockImplementation(async () => {
      throw failure;
    });
    try {
      const { body } = await attempt(enrolled);
      await expect(completePasskeySignIn(body)).rejects.toBe(failure);
    } finally {
      spy.mockRestore();
    }
  });

  test("a replay stays refused on a replica whose clock trails by up to the grace", async () => {
    const enrolled = await enrol();
    const t = Date.now();
    const first = await attempt(enrolled, {}, () => t);
    await completePasskeySignIn(first.body, () => t);

    // A fast replica: its clock is 599 seconds past the first token's expiry, and its write purges old spent rows.
    const fast = () => t + 600_000 + 599_000;
    const second = await attempt(enrolled, {}, fast);
    await completePasskeySignIn(second.body, fast);

    // A slow replica, where the first token is still valid.
    restoreCookie(first.cookie);
    const refusal = await refusalOf(completePasskeySignIn(first.body, () => t + 599_000));
    expect(refusal.reason).toBe("passkey_replayed");
  });

  test("sign-in is refused when passkeys are not ready", async () => {
    const enrolled = await enrol();
    const { body, cookie } = await attempt(enrolled);

    const off = await withOrigin(undefined, () =>
      completePasskeySignIn(body).then(
        () => null,
        (error) => error,
      ),
    );
    expect(off).toBeInstanceOf(AccountError);
    expect((off as InstanceType<typeof AccountError>).status).toBe(409);
    const beginOff = await withOrigin(undefined, () =>
      beginPasskeySignIn().then(
        () => null,
        (error) => error,
      ),
    );
    expect(beginOff).toBeInstanceOf(AccountError);

    const bad = await withOrigin("not a url", () =>
      completePasskeySignIn(body).then(
        () => null,
        (error) => error,
      ),
    );
    expect(bad).toBeInstanceOf(AuthConfigError);

    // The cookie was never read, so it is still there and nothing was deleted.
    expect(cookieJar.get(SIGN_IN_COOKIE)?.value).toBe(cookie);
    expect(deletedCookies).toEqual([]);
  });
});
