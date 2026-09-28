/**
 * The passkey storage contract, written once for both engines.
 *
 * Framework-neutral on purpose: plain async functions over a store factory, asserting with
 * node:assert/strict only, so tests/unit/lib/storage/providers/sqlite-passkeys.test.ts runs each
 * case under bun:test and tests/live/passkey-store-postgres.ts runs the identical list against a
 * real PostgreSQL without the test runner. Every case opens its own store, creates its own
 * accounts under random emails, never assumes an empty table and deletes its accounts again.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import {
  AccountWriteConflict,
  PasskeyRegistrationConflict,
  type PasskeyRegistrationConflictReason,
  type PasskeyRegistrationWrite,
  PasskeyRemovalConflict,
  type PasskeyRemovalConflictReason,
  PasskeySignInConflict,
  type PasskeySignInConflictReason,
  type PasskeySignInWrite,
  type ServerStorageProvider,
  type SpentChallenge,
  type StoredAccount,
  type StoredPasskey,
} from "@/lib/storage/types";

export interface ContractStore {
  provider: ServerStorageProvider;
  close(): Promise<void>;
  /**
   * Delete an account row the way a writer outside Studio can, without the foreign-key cascade,
   * so its passkey rows stay behind: SQLite with `PRAGMA foreign_keys = OFF`, PostgreSQL with
   * `session_replication_role = replica`. Without it the case deletes through the provider.
   */
  orphanAccount?(email: string): Promise<void>;
}

export interface ContractCase {
  name: string;
  run(open: () => Promise<ContractStore>): Promise<void>;
}

function iso(offsetSeconds = 0): string {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString();
}

function token(bytes = 16): string {
  return randomBytes(bytes).toString("base64url");
}

function makeChallenge(expiresAt = iso(600)): SpentChallenge {
  return { hash: randomBytes(32).toString("hex"), expiresAt };
}

// Ceremonies in the contract purge only rows that expired well before now, as the services do.
const purgeNow = () => iso(-600);

interface Ctx {
  provider: ServerStorageProvider;
  /** Insert a fresh account under a random email; it is deleted again when the case ends. */
  account(overrides?: Partial<StoredAccount>): Promise<StoredAccount>;
  passkey(email: string, overrides?: Partial<StoredPasskey>): StoredPasskey;
  /** Register a passkey with sensible defaults for every field the case does not name. */
  register(
    email: string,
    overrides?: Partial<Omit<PasskeyRegistrationWrite, "passkey">> & { passkey?: Partial<StoredPasskey> },
  ): Promise<StoredPasskey>;
  registration(
    email: string,
    overrides?: Partial<Omit<PasskeyRegistrationWrite, "passkey">> & { passkey?: Partial<StoredPasskey> },
  ): PasskeyRegistrationWrite;
  /** A sign-in write for the passkey, expecting its account as `account()` creates it unless overridden. */
  signIn(passkey: StoredPasskey, signCount: number, overrides?: Partial<PasskeySignInWrite>): PasskeySignInWrite;
  handle(email: string): string;
  reread(email: string): Promise<StoredAccount>;
  /** Remove the account row, leaving its passkey rows behind where the engine allows it. */
  orphan(email: string): Promise<void>;
}

function contractCase(name: string, body: (ctx: Ctx) => Promise<void>): ContractCase {
  return {
    name,
    async run(open) {
      const store = await open();
      const { provider } = store;
      const emails: string[] = [];
      const handles = new Map<string, string>();
      const passkey = (email: string, overrides: Partial<StoredPasskey> = {}): StoredPasskey => ({
        id: randomUUID(),
        credentialId: token(32),
        accountEmail: email,
        publicKey: token(77),
        signCount: 0,
        transports: ["internal", "hybrid"],
        backupEligible: true,
        backupState: false,
        rpId: "studio.example.com",
        name: "Passkey",
        createdAt: iso(),
        lastUsedAt: null,
        ...overrides,
      });
      const handle = (email: string): string => {
        let value = handles.get(email);
        if (!value) {
          value = token(64);
          handles.set(email, value);
        }
        return value;
      };
      const registration: Ctx["registration"] = (email, overrides = {}) => {
        const { passkey: passkeyOverrides, ...rest } = overrides;
        return {
          passkey: passkey(email, passkeyOverrides),
          userHandle: handle(email),
          expectedSessionVersion: 0,
          maxPasskeys: 20,
          challenge: makeChallenge(),
          purgeSpentBefore: purgeNow(),
          ...rest,
        };
      };
      const ctx: Ctx = {
        provider,
        async account(overrides = {}) {
          const now = iso();
          const account: StoredAccount = {
            email: `contract-${randomUUID()}@example.com`,
            passwordHash: "scrypt$contract",
            role: "user",
            totpSecret: null,
            totpPending: null,
            disabled: false,
            sessionVersion: 0,
            createdAt: now,
            updatedAt: now,
            ...overrides,
          };
          await provider.insertAccount(account);
          if (!emails.includes(account.email)) emails.push(account.email);
          return account;
        },
        passkey,
        registration,
        async register(email, overrides) {
          const write = registration(email, overrides);
          await provider.insertPasskey(write);
          return write.passkey;
        },
        signIn: (passkey, signCount, overrides = {}) => ({
          id: passkey.id,
          email: passkey.accountEmail,
          expectedSessionVersion: 0,
          expectedRole: "user",
          signCount,
          backupState: false,
          usedAt: iso(),
          challenge: makeChallenge(),
          purgeSpentBefore: purgeNow(),
          ...overrides,
        }),
        handle,
        async reread(email) {
          const account = await provider.getAccount(email);
          assert.ok(account, `account ${email} is gone`);
          return account;
        },
        orphan: (email) => (store.orphanAccount ? store.orphanAccount(email) : provider.deleteAccount(email)),
      };
      try {
        await body(ctx);
      } finally {
        try {
          await Promise.all(emails.map((email) => provider.deleteAccount(email)));
        } finally {
          await store.close();
        }
      }
    },
  };
}

async function refusedRegistration(promise: Promise<unknown>, reason: PasskeyRegistrationConflictReason) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PasskeyRegistrationConflict, `expected PasskeyRegistrationConflict, got ${error}`);
    assert.equal(error.reason, reason);
    return true;
  });
}

async function refusedSignIn(promise: Promise<unknown>, reason: PasskeySignInConflictReason) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PasskeySignInConflict, `expected PasskeySignInConflict, got ${error}`);
    assert.equal(error.reason, reason);
    return true;
  });
}

async function refusedRemoval(promise: Promise<unknown>, reason: PasskeyRemovalConflictReason) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof PasskeyRemovalConflict, `expected PasskeyRemovalConflict, got ${error}`);
    assert.equal(error.reason, reason);
    return true;
  });
}

async function refusedAccountWrite(promise: Promise<unknown>) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof AccountWriteConflict, `expected AccountWriteConflict, got ${error}`);
    return true;
  });
}

async function stored(provider: ServerStorageProvider, email: string, id: string): Promise<StoredPasskey> {
  const found = (await provider.listPasskeys(email)).find((passkey) => passkey.id === id);
  assert.ok(found, `passkey ${id} is gone`);
  return found;
}

const ids = (passkeys: StoredPasskey[]) => passkeys.map((passkey) => passkey.id);

export const PASSKEY_STORE_CONTRACT: readonly ContractCase[] = [
  contractCase("insertPasskey binds the user handle once and stores the credential", async (c) => {
    const { email } = await c.account();
    assert.equal(await c.provider.getPasskeyUserHandle(email), null);

    const first = await c.register(email, { passkey: { signCount: 3, backupState: true, name: "Laptop" } });
    const second = await c.register(email);

    assert.equal(await c.provider.getPasskeyUserHandle(email), c.handle(email));
    assert.deepEqual(await c.provider.findPasskey(first.credentialId), { passkey: first, userHandle: c.handle(email) });
    assert.deepEqual(new Set(ids(await c.provider.listPasskeys(email))), new Set([first.id, second.id]));
  }),

  contractCase(
    "a second registration with a different user handle for the same account is a user_handle_changed conflict and writes nothing",
    async (c) => {
      const { email } = await c.account();
      const first = await c.register(email);
      const losing = c.registration(email, { userHandle: token(64) });

      await refusedRegistration(c.provider.insertPasskey(losing), "user_handle_changed");

      assert.equal(await c.provider.getPasskeyUserHandle(email), c.handle(email));
      assert.deepEqual(ids(await c.provider.listPasskeys(email)), [first.id]);
      // The refused write did not spend its challenge either.
      await c.register(email, { challenge: losing.challenge });
    },
  ),

  contractCase(
    "a credential ID registered to any account is a credential_registered conflict and writes nothing for the second account",
    async (c) => {
      const owner = await c.account();
      const other = await c.account();
      const taken = await c.register(owner.email);
      const losing = c.registration(other.email, { passkey: { credentialId: taken.credentialId } });

      await refusedRegistration(c.provider.insertPasskey(losing), "credential_registered");

      assert.deepEqual(await c.provider.listPasskeys(other.email), []);
      assert.equal(await c.provider.getPasskeyUserHandle(other.email), null);
      assert.equal((await c.provider.findPasskey(taken.credentialId))?.passkey.accountEmail, owner.email);
      await c.register(other.email, { challenge: losing.challenge });
    },
  ),

  contractCase("a spent challenge is a challenge_spent conflict and writes nothing", async (c) => {
    const { email } = await c.account();
    const challenge = makeChallenge();
    const first = await c.register(email, { challenge });

    await refusedRegistration(c.provider.insertPasskey(c.registration(email, { challenge })), "challenge_spent");

    assert.deepEqual(ids(await c.provider.listPasskeys(email)), [first.id]);
  }),

  contractCase("an account that no longer exists is an account_missing conflict", async (c) => {
    const email = `contract-${randomUUID()}@example.com`;

    await refusedRegistration(c.provider.insertPasskey(c.registration(email)), "account_missing");

    assert.equal(await c.provider.getPasskeyUserHandle(email), null);
    assert.deepEqual(await c.provider.listPasskeys(email), []);
  }),

  contractCase(
    "a registration whose session version moved is a session_changed conflict and writes nothing",
    async (c) => {
      const { email } = await c.account({ sessionVersion: 4 });
      const losing = c.registration(email, { expectedSessionVersion: 3 });

      await refusedRegistration(c.provider.insertPasskey(losing), "session_changed");

      assert.deepEqual(await c.provider.listPasskeys(email), []);
      assert.equal(await c.provider.getPasskeyUserHandle(email), null);
      await c.register(email, { expectedSessionVersion: 4, challenge: losing.challenge });
    },
  ),

  contractCase(
    "the passkey past maxPasskeys is a passkey_limit conflict, and the one at the limit is accepted",
    async (c) => {
      const { email } = await c.account();
      await c.register(email, { maxPasskeys: 2 });
      await c.register(email, { maxPasskeys: 2 });

      await refusedRegistration(c.provider.insertPasskey(c.registration(email, { maxPasskeys: 2 })), "passkey_limit");

      assert.equal((await c.provider.listPasskeys(email)).length, 2);
    },
  ),

  contractCase("recordPasskeySignIn advances the counter, backup state and last use once per challenge", async (c) => {
    const { email } = await c.account();
    const passkey = await c.register(email);
    const usedAt = iso();
    const write = c.signIn(passkey, 5, { backupState: true, usedAt });

    await c.provider.recordPasskeySignIn(write);
    await refusedSignIn(c.provider.recordPasskeySignIn({ ...write, signCount: 6 }), "challenge_spent");

    const after = await stored(c.provider, email, passkey.id);
    assert.equal(after.signCount, 5);
    assert.equal(after.backupState, true);
    assert.equal(after.lastUsedAt, usedAt);
  }),

  contractCase(
    "a counter that does not increase is a counter_not_increased conflict, and 0 then 0 is accepted",
    async (c) => {
      const { email } = await c.account();
      const counted = await c.register(email, { passkey: { signCount: 10 } });
      const zero = await c.register(email);

      const same = c.signIn(counted, 10);
      await refusedSignIn(c.provider.recordPasskeySignIn(same), "counter_not_increased");
      await refusedSignIn(c.provider.recordPasskeySignIn(c.signIn(counted, 9)), "counter_not_increased");
      assert.equal((await stored(c.provider, email, counted.id)).signCount, 10);
      assert.equal((await stored(c.provider, email, counted.id)).lastUsedAt, null);
      // The refusal rolled the spent challenge back.
      await c.provider.recordPasskeySignIn({ ...same, signCount: 11 });

      await c.provider.recordPasskeySignIn(c.signIn(zero, 0));
      await c.provider.recordPasskeySignIn(c.signIn(zero, 0));
      assert.equal((await stored(c.provider, email, zero.id)).signCount, 0);
    },
  ),

  contractCase("a counter above 2^31 is stored and compared", async (c) => {
    const { email } = await c.account();
    const passkey = await c.register(email);

    await c.provider.recordPasskeySignIn(c.signIn(passkey, 3000000000));
    await c.provider.recordPasskeySignIn(c.signIn(passkey, 3000000001));
    await refusedSignIn(c.provider.recordPasskeySignIn(c.signIn(passkey, 3000000001)), "counter_not_increased");

    assert.equal((await stored(c.provider, email, passkey.id)).signCount, 3000000001);
  }),

  contractCase("a deleted credential is a credential_missing conflict", async (c) => {
    const account = await c.account();
    const passkey = await c.register(account.email);
    await c.provider.deletePasskey({
      email: account.email,
      id: passkey.id,
      expectedSessionVersion: 0,
      nextSessionVersion: 1,
      updatedAt: iso(),
    });

    // The removal moved the session version, so the write expects the moved one and only the credential is gone.
    await refusedSignIn(
      c.provider.recordPasskeySignIn(c.signIn(passkey, 1, { expectedSessionVersion: 1 })),
      "credential_missing",
    );
  }),

  contractCase("a sign-in for the account as the caller read it succeeds", async (c) => {
    const { email } = await c.account({ role: "admin", sessionVersion: 7 });
    const passkey = await c.register(email, { expectedSessionVersion: 7 });

    await c.provider.recordPasskeySignIn(c.signIn(passkey, 1, { expectedSessionVersion: 7, expectedRole: "admin" }));

    assert.equal((await stored(c.provider, email, passkey.id)).signCount, 1);
  }),

  contractCase(
    "a sign-in whose account was disabled is an account_changed conflict and writes nothing, the challenge included",
    async (c) => {
      const { email } = await c.account();
      const passkey = await c.register(email);
      const read = await c.reread(email);
      // The version is left alone, so only the disabled flag can refuse the write.
      const disabled = { ...read, disabled: true, updatedAt: iso(1) };
      await c.provider.updateAccount(disabled, { expected: read });
      const write = c.signIn(passkey, 1);

      await refusedSignIn(c.provider.recordPasskeySignIn(write), "account_changed");

      const after = await stored(c.provider, email, passkey.id);
      assert.equal(after.signCount, 0);
      assert.equal(after.lastUsedAt, null);
      await c.provider.updateAccount({ ...disabled, disabled: false, updatedAt: iso(2) }, { expected: disabled });
      await c.provider.recordPasskeySignIn(write);
    },
  ),

  contractCase(
    "a sign-in whose session version or role moved is an account_changed conflict and writes nothing, the challenge included",
    async (c) => {
      const { email } = await c.account({ sessionVersion: 4 });
      const passkey = await c.register(email, { expectedSessionVersion: 4 });
      const stale = c.signIn(passkey, 1, { expectedSessionVersion: 3 });
      const promoted = c.signIn(passkey, 1, { expectedSessionVersion: 4, expectedRole: "admin" });

      await refusedSignIn(c.provider.recordPasskeySignIn(stale), "account_changed");
      await refusedSignIn(c.provider.recordPasskeySignIn(promoted), "account_changed");

      const after = await stored(c.provider, email, passkey.id);
      assert.equal(after.signCount, 0);
      assert.equal(after.lastUsedAt, null);
      await c.provider.recordPasskeySignIn({ ...stale, expectedSessionVersion: 4 });
      await c.provider.recordPasskeySignIn({ ...promoted, expectedRole: "user", signCount: 2 });
    },
  ),

  contractCase(
    "a sign-in whose account was deleted is an account_changed conflict and leaves the challenge unspent",
    async (c) => {
      const { email } = await c.account();
      const passkey = await c.register(email);
      const write = c.signIn(passkey, 1);
      await c.orphan(email);

      await refusedSignIn(c.provider.recordPasskeySignIn(write), "account_changed");

      const other = await c.account();
      const next = await c.register(other.email);
      await c.provider.recordPasskeySignIn(c.signIn(next, 1, { challenge: write.challenge }));
    },
  ),

  contractCase("a spent challenge is kept until purgeSpentBefore passes its expiry, then purged", async (c) => {
    const { email } = await c.account();
    const passkey = await c.register(email);
    const expiresAt = iso(-7200);
    const before = iso(-7201);
    const after = iso(-7199);
    const challenge = makeChallenge(expiresAt);
    await c.provider.recordPasskeySignIn(c.signIn(passkey, 0, { challenge, purgeSpentBefore: before }));

    await refusedSignIn(
      c.provider.recordPasskeySignIn(c.signIn(passkey, 0, { challenge, purgeSpentBefore: before })),
      "challenge_spent",
    );
    await c.provider.recordPasskeySignIn(c.signIn(passkey, 0, { challenge, purgeSpentBefore: after }));
  }),

  contractCase(
    "deletePasskey removes one passkey and moves the session version only while it is the caller's",
    async (c) => {
      const { email } = await c.account({ sessionVersion: 2 });
      const removed = await c.register(email, { expectedSessionVersion: 2 });
      const kept = await c.register(email, { expectedSessionVersion: 2 });
      const updatedAt = iso(1);

      await c.provider.deletePasskey({
        email,
        id: removed.id,
        expectedSessionVersion: 2,
        nextSessionVersion: 3,
        updatedAt,
      });
      assert.deepEqual(ids(await c.provider.listPasskeys(email)), [kept.id]);
      const moved = await c.reread(email);
      assert.equal(moved.sessionVersion, 3);
      assert.equal(moved.updatedAt, updatedAt);

      await refusedRemoval(
        c.provider.deletePasskey({ email, id: kept.id, expectedSessionVersion: 2, nextSessionVersion: 3, updatedAt }),
        "session_changed",
      );
      assert.deepEqual(ids(await c.provider.listPasskeys(email)), [kept.id]);

      await refusedRemoval(
        c.provider.deletePasskey({
          email,
          id: randomUUID(),
          expectedSessionVersion: 3,
          nextSessionVersion: 4,
          updatedAt: iso(2),
        }),
        "credential_missing",
      );
      assert.deepEqual(await c.reread(email), moved);
    },
  ),

  contractCase("updateAccount applies only while the stored version matches what the caller read", async (c) => {
    const { email } = await c.account();
    const read = await c.reread(email);
    const first = { ...read, role: "admin" as const, sessionVersion: read.sessionVersion + 1, updatedAt: iso(1) };

    assert.equal(await c.provider.updateAccount(first, { expected: read }), 0);
    assert.deepEqual(await c.reread(email), first);

    await refusedAccountWrite(
      c.provider.updateAccount({ ...read, passwordHash: "scrypt$stale", updatedAt: iso(2) }, { expected: read }),
    );
    assert.deepEqual(await c.reread(email), first);

    // A passkey removal moves the version; a write that read the row before it cannot lower it again.
    const beforeRemoval = await c.reread(email);
    const passkey = await c.register(email, { expectedSessionVersion: beforeRemoval.sessionVersion });
    await c.provider.deletePasskey({
      email,
      id: passkey.id,
      expectedSessionVersion: beforeRemoval.sessionVersion,
      nextSessionVersion: beforeRemoval.sessionVersion + 1,
      updatedAt: iso(3),
    });
    await refusedAccountWrite(
      c.provider.updateAccount(
        { ...beforeRemoval, totpPending: "pending", updatedAt: iso(4) },
        { expected: beforeRemoval },
      ),
    );
    const final = await c.reread(email);
    assert.equal(final.sessionVersion, beforeRemoval.sessionVersion + 1);
    assert.equal(final.totpPending, null);
  }),

  contractCase(
    "updateAccount with clearPasskeys removes every passkey of that account and nothing else, and resolves to the count",
    async (c) => {
      const cleared = await c.account();
      const other = await c.account();
      await c.register(cleared.email);
      await c.register(cleared.email);
      const kept = await c.register(other.email);
      const read = await c.reread(cleared.email);
      const next = { ...read, sessionVersion: read.sessionVersion + 1, updatedAt: iso(1) };

      assert.equal(await c.provider.updateAccount(next, { expected: read, clearPasskeys: true }), 2);

      assert.deepEqual(await c.provider.listPasskeys(cleared.email), []);
      assert.deepEqual(await c.reread(cleared.email), next);
      // The handle is never reassigned while the account exists.
      assert.equal(await c.provider.getPasskeyUserHandle(cleared.email), c.handle(cleared.email));
      assert.deepEqual(ids(await c.provider.listPasskeys(other.email)), [kept.id]);
    },
  ),

  contractCase(
    "updateAccount without clearPasskeys keeps every passkey through a role change, a password change and a disable",
    async (c) => {
      const { email } = await c.account({ role: "admin" });
      const kept = new Set([(await c.register(email)).id, (await c.register(email)).id]);
      // One write after the other, each with the row as the one before it left it.
      const apply = async (change: Partial<StoredAccount>, step: number) => {
        const read = await c.reread(email);
        const next = { ...read, ...change, sessionVersion: read.sessionVersion + 1, updatedAt: iso(step) };
        assert.equal(await c.provider.updateAccount(next, { expected: read }), 0);
        assert.deepEqual(await c.reread(email), next);
        assert.deepEqual(new Set(ids(await c.provider.listPasskeys(email))), kept);
        assert.equal(await c.provider.getPasskeyUserHandle(email), c.handle(email));
      };

      await apply({ role: "user" }, 1);
      await apply({ passwordHash: "scrypt$changed" }, 2);
      await apply({ disabled: true }, 3);
    },
  ),

  contractCase("deleteAccount removes the account's passkeys and user handle through the foreign keys", async (c) => {
    const { email } = await c.account();
    const passkey = await c.register(email);

    await c.provider.deleteAccount(email);

    assert.deepEqual(await c.provider.listPasskeys(email), []);
    assert.equal(await c.provider.getPasskeyUserHandle(email), null);
    assert.equal(await c.provider.findPasskey(passkey.credentialId), null);
    assert.equal((await c.provider.countPasskeys()).has(email), false);
  }),

  contractCase("an account created under a reused email inherits no passkey of the old one", async (c) => {
    const { email } = await c.account();
    const passkey = await c.register(email);

    await c.orphan(email);
    await c.account({ email });

    assert.deepEqual(await c.provider.listPasskeys(email), []);
    assert.equal(await c.provider.getPasskeyUserHandle(email), null);
    assert.equal(await c.provider.findPasskey(passkey.credentialId), null);
  }),

  contractCase("renamePasskey changes only the named passkey of that account", async (c) => {
    const owner = await c.account();
    const other = await c.account();
    const renamed = await c.register(owner.email);
    const untouched = await c.register(owner.email);
    const foreign = await c.register(other.email);

    assert.equal(await c.provider.renamePasskey(owner.email, renamed.id, "Work laptop"), true);
    assert.equal(await c.provider.renamePasskey(other.email, untouched.id, "Stolen"), false);
    assert.equal(await c.provider.renamePasskey(owner.email, randomUUID(), "Nothing"), false);

    assert.equal((await stored(c.provider, owner.email, renamed.id)).name, "Work laptop");
    assert.deepEqual(await stored(c.provider, owner.email, untouched.id), untouched);
    assert.deepEqual(await stored(c.provider, other.email, foreign.id), foreign);
  }),

  contractCase(
    "countPasskeys counts per account, and listPasskeys lists oldest first with findPasskey returning the owner's handle",
    async (c) => {
      const two = await c.account();
      const one = await c.account();
      const none = await c.account();
      const newer = await c.register(two.email, { passkey: { createdAt: "2026-01-02T00:00:00.000Z" } });
      const older = await c.register(two.email, { passkey: { createdAt: "2026-01-01T00:00:00.000Z" } });
      await c.register(one.email);

      const counts = await c.provider.countPasskeys();
      assert.equal(counts.get(two.email), 2);
      assert.equal(counts.get(one.email), 1);
      assert.equal(counts.has(none.email), false);
      assert.deepEqual(await c.provider.listPasskeys(two.email), [older, newer]);
      assert.deepEqual(await c.provider.findPasskey(newer.credentialId), {
        passkey: newer,
        userHandle: c.handle(two.email),
      });
      assert.equal(await c.provider.findPasskey(token(32)), null);
    },
  ),

  contractCase("an owner removal and an admin clear on one account both finish without a driver error", async (c) => {
    const { email } = await c.account();
    const removed = await c.register(email);
    await c.register(email);
    const read = await c.reread(email);

    const results = await Promise.allSettled([
      c.provider.deletePasskey({
        email,
        id: removed.id,
        expectedSessionVersion: read.sessionVersion,
        nextSessionVersion: read.sessionVersion + 1,
        updatedAt: iso(1),
      }),
      c.provider.updateAccount(
        { ...read, sessionVersion: read.sessionVersion + 1, updatedAt: iso(2) },
        { expected: read, clearPasskeys: true },
      ),
    ]);

    for (const result of results) {
      if (result.status === "rejected") {
        assert.ok(
          result.reason instanceof PasskeyRemovalConflict || result.reason instanceof AccountWriteConflict,
          `unexpected rejection: ${result.reason}`,
        );
      }
    }
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal((await c.reread(email)).sessionVersion, read.sessionVersion + 1);
  }),

  contractCase("two sign-ins racing on one credential never lower the counter", async (c) => {
    const { email } = await c.account();
    const passkey = await c.register(email, { passkey: { signCount: 5 } });

    const results = await Promise.allSettled([
      c.provider.recordPasskeySignIn(c.signIn(passkey, 6)),
      c.provider.recordPasskeySignIn(c.signIn(passkey, 7)),
    ]);

    for (const result of results) {
      if (result.status === "rejected") {
        assert.ok(
          result.reason instanceof PasskeySignInConflict && result.reason.reason === "counter_not_increased",
          `unexpected rejection: ${result.reason}`,
        );
      }
    }
    assert.equal((await stored(c.provider, email, passkey.id)).signCount, 7);
  }),

  contractCase("two ceremonies purging the same expired rows both finish", async (c) => {
    const { email } = await c.account();
    const first = await c.register(email);
    const second = await c.register(email);
    const expired = [makeChallenge(iso(-7200)), makeChallenge(iso(-7100)), makeChallenge(iso(-7000))];
    await Promise.all(
      expired.map((challenge) =>
        c.provider.recordPasskeySignIn(c.signIn(first, 0, { challenge, purgeSpentBefore: iso(-86400) })),
      ),
    );

    const results = await Promise.allSettled([
      c.provider.recordPasskeySignIn(c.signIn(first, 0, { purgeSpentBefore: iso(-600) })),
      c.provider.recordPasskeySignIn(c.signIn(second, 0, { purgeSpentBefore: iso(-600) })),
    ]);

    assert.deepEqual(
      results.map((result) => result.status),
      ["fulfilled", "fulfilled"],
    );
    // The purge really removed them: each hash can be spent again.
    await Promise.all(
      expired.map((challenge) =>
        c.provider.recordPasskeySignIn(c.signIn(second, 0, { challenge, purgeSpentBefore: iso(-86400) })),
      ),
    );
  }),
];
