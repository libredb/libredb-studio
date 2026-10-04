import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import Database from "better-sqlite3";
import { makeStoredPasskey, openStoreFixture, type StoreFixture } from "../../helpers/passkey-store-fixture";
import { RFC6238_SECRET, totpCodeFor } from "../../helpers/rfc6238";

// The account service's side of passkeys (#785): every write carries the version it read, an
// admin password set is a recovery that removes passkeys unless kept, break-glass removes the env
// admin's, and the passkey services reuse this module's reauthentication and audit helpers.

const {
  ACCOUNT_CHANGED,
  AccountError,
  auditAccountChange,
  auditAccountRefusal,
  beginTotpEnrolment,
  changeAccount,
  confirmOwner,
  confirmTotpEnrolment,
  disableOwnTotp,
  listPublicAccounts,
  requireAccountStore,
  requireOwnAccount,
  resolveLocalAuthUsers,
} = await import("@/lib/local-accounts");
const { clearRateLimitState } = await import("@/lib/api/rate-limit");
const { closeStorageProvider } = await import("@/lib/storage/factory");
const { clearTotpReplayState } = await import("@/lib/totp");

const ADMIN = "admin@libredb.org";
const ALICE = "alice@example.com";
// Placeholders, not credentials: a realistic literal here is what secret scanners flag.
const ALICE_PASSWORD = "password-alice";
const NEW_PASSWORD = "new-password-1";

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

function actions(): unknown[] {
  return auditLines().map((line) => line.action);
}

async function addPasskeys(email: string, count: number): Promise<void> {
  const provider = await fixture.provider();
  const handle = (await provider.getPasskeyUserHandle(email)) ?? randomBytes(64).toString("base64url");
  for (let i = 0; i < count; i++) {
    const account = await provider.getAccount(email);
    if (!account) throw new Error(`${email} missing`);
    const now = new Date().toISOString();
    await provider.insertPasskey({
      passkey: makeStoredPasskey({ accountEmail: email }),
      userHandle: handle,
      expectedSessionVersion: account.sessionVersion,
      maxPasskeys: 20,
      challenge: { hash: randomBytes(32).toString("hex"), expiresAt: new Date(Date.now() + 600_000).toISOString() },
      purgeSpentBefore: now,
    });
  }
}

async function stored(email: string) {
  const row = await (await fixture.provider()).getAccount(email);
  if (!row) throw new Error(`${email} missing`);
  return row;
}

async function passkeyCount(email: string): Promise<number> {
  return (await (await fixture.provider()).listPasskeys(email)).length;
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

describe("local accounts and passkeys", () => {
  beforeEach(async () => {
    clearRateLimitState();
    clearTotpReplayState();
    fixture = await openStoreFixture();
    // Seeds the env admin (and user) into the empty registry before any test account exists.
    await listPublicAccounts();
    await fixture.createAccount({ email: ALICE, password: ALICE_PASSWORD, role: "user" });
    log = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    log.mockRestore();
    await fixture.close();
  });

  test("totpCodeFor produces the RFC 6238 Appendix B code for its seed at T=59", () => {
    expect(totpCodeFor(RFC6238_SECRET, 59_000)).toBe("287082");
  });

  test("an admin clearPasskeys patch removes the passkeys and ends the account's sessions", async () => {
    await addPasskeys(ALICE, 2);
    const before = await stored(ALICE);
    const changed = await changeAccount(ADMIN, ALICE, { clearPasskeys: true });
    expect(changed.account.passkeys).toBe(0);
    expect(changed.sessionVersion).toBe(before.sessionVersion + 1);
    expect((await stored(ALICE)).sessionVersion).toBe(before.sessionVersion + 1);
    expect(await passkeyCount(ALICE)).toBe(0);
    const clears = auditLines().filter((line) => line.action === "passkey_clear");
    expect(clears).toHaveLength(1);
    expect(clears[0]).toMatchObject({ actor: ADMIN, route: ALICE, outcome: "success" });
  });

  test("clearPasskeys must be true", async () => {
    for (const clearPasskeys of [false, "yes"]) {
      const error = await refusal(() => changeAccount(ADMIN, ALICE, { clearPasskeys }));
      expect(error.status).toBe(400);
      expect(error.message).toBe("clearPasskeys must be true.");
    }
  });

  test("clearPasskeys combines with other fields in one change", async () => {
    await addPasskeys(ALICE, 1);
    const before = await stored(ALICE);
    const changed = await changeAccount(ADMIN, ALICE, { clearPasskeys: true, disabled: true });
    expect(changed.account).toMatchObject({ disabled: true, passkeys: 0 });
    const after = await stored(ALICE);
    expect(after.disabled).toBe(true);
    expect(after.sessionVersion).toBe(before.sessionVersion + 1);
    expect(await passkeyCount(ALICE)).toBe(0);
  });

  test("an admin password set removes the account's passkeys and ends its sessions", async () => {
    await addPasskeys(ALICE, 2);
    const before = await stored(ALICE);
    const changed = await changeAccount(ADMIN, ALICE, { password: NEW_PASSWORD });
    expect(changed.account.passkeys).toBe(0);
    expect((await stored(ALICE)).sessionVersion).toBe(before.sessionVersion + 1);
    expect(await passkeyCount(ALICE)).toBe(0);
    expect(actions()).toEqual(["password", "passkey_clear"]);

    log.mockClear();
    const bob = await fixture.createAccount({ email: "bob@example.com", password: ALICE_PASSWORD, role: "user" });
    const bobChanged = await changeAccount(ADMIN, bob.email, { password: NEW_PASSWORD });
    expect(bobChanged.account.passkeys).toBe(0);
    expect(bobChanged.sessionVersion).toBe(bob.sessionVersion + 1);
    expect(actions()).toEqual(["password"]);
  });

  test("keepPasskeys keeps them, and applies only with a new password", async () => {
    await addPasskeys(ALICE, 2);
    const before = await stored(ALICE);
    const kept = await changeAccount(ADMIN, ALICE, { password: NEW_PASSWORD, keepPasskeys: true });
    expect(kept.account.passkeys).toBe(2);
    expect(await passkeyCount(ALICE)).toBe(2);
    expect((await stored(ALICE)).sessionVersion).toBe(before.sessionVersion + 1);
    expect(actions()).toEqual(["password"]);

    for (const body of [{ keepPasskeys: true }, { password: NEW_PASSWORD, keepPasskeys: true, clearPasskeys: true }]) {
      const error = await refusal(() => changeAccount(ADMIN, ALICE, body));
      expect(error.status).toBe(400);
      expect(error.message).toBe(
        "keepPasskeys applies only together with a new password, and never with clearPasskeys.",
      );
    }
    const typed = await refusal(() => changeAccount(ADMIN, ALICE, { password: NEW_PASSWORD, keepPasskeys: "yes" }));
    expect(typed.status).toBe(400);
    expect(typed.message).toBe("keepPasskeys must be true.");
    expect(await passkeyCount(ALICE)).toBe(2);
  });

  test("a change that keeps sessions reports the account's current passkey count", async () => {
    await addPasskeys(ALICE, 2);
    const before = await stored(ALICE);
    const changed = await changeAccount(ADMIN, ALICE, { clearTotp: true });
    expect(changed.account.passkeys).toBe(2);
    expect(changed.sessionVersion).toBe(before.sessionVersion);
  });

  test("a change that keeps passkeys counts them without parsing a row, before the write", async () => {
    await addPasskeys(ALICE, 2);
    await addPasskeys(ADMIN, 1);
    // A row this release cannot parse, as a rollback past a widened transport list leaves behind.
    const db = new Database(join(fixture.dir, "store.db"));
    try {
      db.prepare("UPDATE passkey_credentials SET transports = ? WHERE account_email = ?").run(
        JSON.stringify(["future-transport"]),
        ALICE,
      );
    } finally {
      db.close();
    }
    await expect((await fixture.provider()).listPasskeys(ALICE)).rejects.toThrow("future-transport");

    const disabled = await changeAccount(ADMIN, ALICE, { disabled: true });
    expect(disabled.account).toMatchObject({ disabled: true, passkeys: 2 });
    expect((await stored(ALICE)).disabled).toBe(true);

    // A count that fails refuses the change before it commits, never after.
    const provider = await fixture.provider();
    const count = spyOn(provider, "countPasskeys").mockImplementation(async () => {
      throw new Error("store down");
    });
    try {
      await expect(changeAccount(ADMIN, ALICE, { role: "admin" })).rejects.toThrow("store down");
      expect((await stored(ALICE)).role).toBe("user");
    } finally {
      count.mockRestore();
    }
  });

  describe("a concurrent disable committed between the read and the write is never reverted", () => {
    // The first updateAccount call stands for a write that read the row, then waited (scrypt, a
    // round trip) while an admin disabled the account. The admin change's own updateAccount is
    // re-entrant and goes straight to the original method.
    async function withDisableRace<T>(run: () => Promise<T>, email = ALICE): Promise<T> {
      const provider = await fixture.provider();
      const original = provider.updateAccount.bind(provider);
      let raced = false;
      const spy = spyOn(provider, "updateAccount").mockImplementation(async (account, options) => {
        if (!raced) {
          raced = true;
          await changeAccount(ADMIN, email, { disabled: true });
        }
        return original(account, options);
      });
      try {
        return await run();
      } finally {
        spy.mockRestore();
      }
    }

    test("TOTP setup answers 409 and keeps the disable", async () => {
      const before = await stored(ALICE);
      const error = await withDisableRace(() => refusal(() => beginTotpEnrolment(ALICE, { password: ALICE_PASSWORD })));
      expect(error.status).toBe(409);
      expect(error.message).toBe(ACCOUNT_CHANGED);
      const after = await stored(ALICE);
      expect(after.disabled).toBe(true);
      expect(after.sessionVersion).toBe(before.sessionVersion + 1);
      expect(after.totpPending).toBeNull();
    });

    test("TOTP confirmation answers 409 and keeps the disable", async () => {
      const begun = await beginTotpEnrolment(ALICE, { password: ALICE_PASSWORD });
      const before = await stored(ALICE);
      const error = await withDisableRace(() => refusal(() => confirmTotpEnrolment(ALICE, totpCodeFor(begun.secret))));
      expect(error.status).toBe(409);
      expect(error.message).toBe(ACCOUNT_CHANGED);
      const after = await stored(ALICE);
      expect(after).toMatchObject({ disabled: true, totpSecret: null, totpPending: begun.secret });
      expect(after.sessionVersion).toBe(before.sessionVersion + 1);
    });

    test("turning off one's own TOTP answers 409 and keeps the disable", async () => {
      const carol = await fixture.createAccount({
        email: "carol@example.com",
        password: ALICE_PASSWORD,
        role: "user",
        totpSecret: RFC6238_SECRET,
      });
      const error = await withDisableRace(
        () =>
          refusal(() => disableOwnTotp(carol.email, { password: ALICE_PASSWORD, code: totpCodeFor(RFC6238_SECRET) })),
        carol.email,
      );
      expect(error.status).toBe(409);
      expect(error.message).toBe(ACCOUNT_CHANGED);
      const after = await stored(carol.email);
      expect(after).toMatchObject({ disabled: true, totpSecret: RFC6238_SECRET });
      expect(after.sessionVersion).toBe(carol.sessionVersion + 1);
    });

    test("an admin role change answers 409 too", async () => {
      const error = await withDisableRace(() => refusal(() => changeAccount(ADMIN, ALICE, { role: "admin" })));
      expect(error.status).toBe(409);
      expect(error.message).toBe(ACCOUNT_CHANGED);
      expect(await stored(ALICE)).toMatchObject({ disabled: true, role: "user" });
    });
  });

  test("an uncontended write keeps working", async () => {
    const begun = await beginTotpEnrolment(ALICE, { password: ALICE_PASSWORD });
    expect((await stored(ALICE)).totpPending).toBe(begun.secret);
    const changed = await changeAccount(ADMIN, ALICE, { role: "admin" });
    expect(changed.account.role).toBe("admin");
  });

  test("the admin account list carries each account's passkey count", async () => {
    await addPasskeys(ALICE, 2);
    const accounts = await listPublicAccounts();
    const byEmail = new Map(accounts.map((account) => [account.email, account.passkeys]));
    expect(byEmail.get(ALICE)).toBe(2);
    expect(byEmail.get(ADMIN)).toBe(0);
  });

  test("ADMIN_PASSWORD_RESET removes the environment admin's passkeys", async () => {
    await addPasskeys(ADMIN, 1);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      process.env.ADMIN_PASSWORD_RESET = "true";
      await closeStorageProvider();
      await resolveLocalAuthUsers();
      expect(await passkeyCount(ADMIN)).toBe(0);
      expect(auditLines().some((line) => line.action === "reset" && line.route === ADMIN)).toBe(true);
      expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("and has no passkeys");
    } finally {
      warn.mockRestore();
    }
  });

  test("confirmOwner asks for a code only when the account has TOTP, and marks a missing one", async () => {
    // Callers pass whether the account has TOTP, as the passkey services do.
    const alice = await stored(ALICE);
    await confirmOwner(alice, { password: ALICE_PASSWORD }, "passkey_add", alice.totpSecret !== null);

    const carol = await fixture.createAccount({
      email: "carol@example.com",
      password: ALICE_PASSWORD,
      role: "user",
      totpSecret: RFC6238_SECRET,
    });
    const missing = await refusal(() =>
      confirmOwner(carol, { password: ALICE_PASSWORD }, "passkey_add", carol.totpSecret !== null),
    );
    expect(missing.status).toBe(400);
    expect(missing.codeRequired).toBe(true);

    const wrongCode = totpCodeFor(RFC6238_SECRET, Date.now(), 5);
    const wrong = await refusal(() =>
      confirmOwner(carol, { password: ALICE_PASSWORD, code: wrongCode }, "passkey_add", carol.totpSecret !== null),
    );
    expect(wrong.status).toBe(401);
    expect(wrong.codeRequired).toBe(false);
    expect(auditLines().at(-1)).toMatchObject({ action: "passkey_add", reason: "bad_totp", outcome: "failure" });

    await confirmOwner(carol, { password: ALICE_PASSWORD, code: totpCodeFor(RFC6238_SECRET) }, "passkey_add", true);
  });

  test("requireAccountStore gives the reconciled store, and 409 under OIDC", async () => {
    expect(await requireAccountStore()).toBe(await fixture.provider());
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    const error = await refusal(() => requireAccountStore());
    expect(error.status).toBe(409);
  });

  test("requireOwnAccount answers 404 for a session without a row", async () => {
    const own = await requireOwnAccount(ALICE);
    expect(own.current.email).toBe(ALICE);
    expect(own.provider).toBe(await fixture.provider());
    const error = await refusal(() => requireOwnAccount("ghost@example.com"));
    expect(error.status).toBe(404);
    expect(error.message).toBe("This session has no account in the registry.");
  });

  test("the account audit helpers carry the passkey id", () => {
    auditAccountChange("a", "passkey_add", "a", "id-1");
    auditAccountRefusal("a", "passkey_add", "passkey_rejected", "id-1");
    auditAccountChange("a", "passkey_rename", "a");
    const lines = auditLines();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ action: "passkey_add", outcome: "success", passkey: "id-1" });
    expect(lines[1]).toMatchObject({
      action: "passkey_add",
      outcome: "failure",
      reason: "passkey_rejected",
      passkey: "id-1",
    });
    expect(lines[2]).not.toHaveProperty("passkey");
  });
});
