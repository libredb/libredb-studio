import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { openStoreFixture, type StoreFixture } from "../../helpers/passkey-store-fixture";
import {
  ACCOUNT_CHANGED,
  AccountError,
  type LaunchIdentity,
  changeAccount,
  provisionLaunchAccount,
  requireAccountStore,
  storedAccountAllows,
} from "@/lib/local-accounts";
import { passwordMatchesHash } from "@/lib/password-hash";
import { closeStorageProvider } from "@/lib/storage/factory";
import { AccountWriteConflict } from "@/lib/storage/types";

// A launch signs in only an account a launch created for the same platform identity, creating it or
// moving its role to the token's. It refuses what it must not reach: an account with a password, an
// authenticator or a passkey, one bound to someone else, a disabled account, and the last enabled admin.

const ADMIN = "admin@libredb.org";
const USER = "user@libredb.org";
const MEMBER = "member@example.com";
// A placeholder, not a credential: a realistic literal here is what secret scanners flag.
const PASSWORD = "password-set-by-admin";
const ISSUER = "platform";
const SUBJECT = "platform-user-1";
const encode = (value: string) => Buffer.from(value).toString("base64url");
// What the account a launch creates holds in place of a password hash: the issuer and subject it is bound to.
const BOUND = `launch-identity$${encode(ISSUER)}$${encode(SUBJECT)}`;
const NOT_LINKED =
  "This email belongs to a Studio account that a launch link cannot sign in to. Sign in with that account's password, or ask a Studio admin.";

let log: ReturnType<typeof spyOn<Console, "log">>;

function launch(overrides: Partial<LaunchIdentity> = {}): LaunchIdentity {
  return { email: MEMBER, role: "user", issuer: ISSUER, subject: SUBJECT, ...overrides };
}

function accountEvents(): Record<string, unknown>[] {
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

async function thrown(run: () => Promise<unknown>): Promise<AccountError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AccountError) return error;
    throw error;
  }
  throw new Error("expected an AccountError");
}

async function expectNotLinked(identity: LaunchIdentity): Promise<void> {
  const error = await thrown(() => provisionLaunchAccount(identity));
  expect(error.status).toBe(403);
  expect(error.message).toBe(NOT_LINKED);
}

describe("provisionLaunchAccount without a server store", () => {
  const KEYS = ["NEXT_PUBLIC_AUTH_PROVIDER", "STORAGE_PROVIDER", "STORAGE_POSTGRES_URL"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
  });

  afterEach(async () => {
    await closeStorageProvider();
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test("in OIDC mode refuses before it opens the store, as every account path does", async () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "oidc";
    // A postgres store with no URL fails the moment it is opened, so reaching it would throw something else here.
    process.env.STORAGE_PROVIDER = "postgres";
    delete process.env.STORAGE_POSTGRES_URL;
    const error = await thrown(() => provisionLaunchAccount(launch({ role: "admin" })));
    expect(error.status).toBe(409);
    expect(error.message).toBe("Accounts are managed by the identity provider in OIDC mode.");
  });

  test("with STORAGE_PROVIDER=local answers the token's email and role with no session version", async () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    delete process.env.STORAGE_PROVIDER;
    expect(await provisionLaunchAccount(launch())).toEqual({ role: "user", username: MEMBER });
  });

  test("with STORAGE_PROVIDER=local refuses the environment accounts in any letter case, because they sign in with a password", async () => {
    process.env.NEXT_PUBLIC_AUTH_PROVIDER = "local";
    delete process.env.STORAGE_PROVIDER;
    // tests/setup.ts sets ADMIN_EMAIL to ADMIN, and USER_EMAIL to USER with a USER_PASSWORD, so both sign in with one.
    await expectNotLinked(launch({ email: "Admin@LibreDB.org", role: "admin" }));
    await expectNotLinked(launch({ email: "USER@libredb.org" }));
  });
});

describe("provisionLaunchAccount in the server store", () => {
  let fixture: StoreFixture;

  beforeEach(async () => {
    fixture = await openStoreFixture();
    log = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(async () => {
    log.mockRestore();
    await fixture.close();
  });

  test("seeds an empty registry from the environment before it creates the launched account", async () => {
    await provisionLaunchAccount(launch());
    const emails = (await (await fixture.provider()).listAccounts()).map((account) => account.email).sort();
    expect(emails).toEqual([ADMIN, MEMBER, USER].sort());
  });

  test("creates a new email bound to the platform identity, with the token's role, no password and a session the registry accepts", async () => {
    const launched = await provisionLaunchAccount(launch());
    const row = await (await fixture.provider()).getAccount(MEMBER);
    if (!row) throw new Error("the launched account was not created");
    expect(row.role).toBe("user");
    expect(row.disabled).toBe(false);
    expect(row.totpSecret).toBeNull();
    expect(row.passwordHash).toBe(BOUND);
    // Not a scrypt encoding, so no password matches it, the stored text itself included.
    expect(await passwordMatchesHash("", row.passwordHash)).toBe(false);
    expect(await passwordMatchesHash(BOUND, row.passwordHash)).toBe(false);
    expect(launched).toEqual({ role: "user", username: MEMBER, sessionVersion: row.sessionVersion });
    expect(await storedAccountAllows(launched)).toBe(true);
    expect(accountEvents()).toContainEqual(
      expect.objectContaining({ action: "create", actor: "launch", route: MEMBER, outcome: "success" }),
    );
  });

  test("signs the bound account in again, matched without regard to case, and adds no account", async () => {
    const first = await provisionLaunchAccount(launch());
    log.mockClear();
    expect(await provisionLaunchAccount(launch({ email: "Member@Example.COM" }))).toEqual(first);
    const provider = await fixture.provider();
    // The store keys accounts by the exact email, so a case-sensitive lookup would have inserted a second row.
    expect(await provider.getAccount("Member@Example.COM")).toBeNull();
    expect((await provider.listAccounts()).map((account) => account.email).sort()).toEqual(
      [ADMIN, MEMBER, USER].sort(),
    );
    expect(accountEvents()).toEqual([]);
  });

  test("refuses an account that signs in with a password, the environment admin included, and changes nothing", async () => {
    await requireAccountStore();
    const provider = await fixture.provider();
    const before = await provider.listAccounts();
    await expectNotLinked(launch({ email: USER }));
    await expectNotLinked(launch({ email: "ADMIN@libredb.org", role: "admin" }));
    expect(await provider.listAccounts()).toEqual(before);
    expect(accountEvents()).toEqual([]);
  });

  test("refuses the ADMIN_EMAIL address even while its row is missing, and creates nothing", async () => {
    await fixture.createAccount({ email: USER, password: PASSWORD, role: "admin" });
    const error = await thrown(() => provisionLaunchAccount(launch({ email: "Admin@LibreDB.org", role: "admin" })));
    expect(error.status).toBe(403);
    expect(error.message).toBe(NOT_LINKED);
    expect((await (await fixture.provider()).listAccounts()).map((account) => account.email)).toEqual([USER]);
  });

  test("refuses an account a launch created for another platform identity", async () => {
    await provisionLaunchAccount(launch());
    expect((await thrown(() => provisionLaunchAccount(launch({ subject: "platform-user-2" })))).status).toBe(403);
    expect((await thrown(() => provisionLaunchAccount(launch({ issuer: "another-platform" })))).status).toBe(403);
    expect((await (await fixture.provider()).getAccount(MEMBER))?.passwordHash).toBe(BOUND);
  });

  test("refuses a bound account that holds a passkey or an authenticator, so a launch never stands in for a second factor", async () => {
    await provisionLaunchAccount(launch());
    const provider = await fixture.provider();
    const passkeys = spyOn(provider, "countPasskeys").mockImplementation(async () => new Map([[MEMBER, 1]]));
    try {
      expect((await thrown(() => provisionLaunchAccount(launch()))).status).toBe(403);
    } finally {
      passkeys.mockRestore();
    }
    const current = await provider.getAccount(MEMBER);
    if (!current) throw new Error("the launched account is missing");
    // Built rather than written out, so no literal here reads as a credential to a secret scanner.
    await provider.updateAccount(
      { ...current, totpSecret: "A".repeat(32), updatedAt: new Date().toISOString() },
      { expected: current },
    );
    expect((await thrown(() => provisionLaunchAccount(launch()))).status).toBe(403);
  });

  test("an admin who sets a password on a launched account ends launch sign-in for it", async () => {
    await provisionLaunchAccount(launch());
    await changeAccount(ADMIN, MEMBER, { password: PASSWORD });
    const error = await thrown(() => provisionLaunchAccount(launch()));
    expect(error.status).toBe(403);
    expect(error.message).toBe(NOT_LINKED);
  });

  test("moves a bound account to the token's role, which ends the sessions it had", async () => {
    const before = await provisionLaunchAccount(launch());
    const version = before.sessionVersion as number;
    log.mockClear();
    const launched = await provisionLaunchAccount(launch({ role: "admin" }));
    const after = await (await fixture.provider()).getAccount(MEMBER);
    expect(after?.role).toBe("admin");
    expect(after?.sessionVersion).toBe(version + 1);
    expect(launched).toEqual({ role: "admin", username: MEMBER, sessionVersion: version + 1 });
    expect(await storedAccountAllows(before)).toBe(false);
    expect(accountEvents()).toContainEqual(expect.objectContaining({ action: "role", actor: "launch", route: MEMBER }));
  });

  test("demotes a bound admin while another enabled admin remains", async () => {
    await provisionLaunchAccount(launch({ role: "admin" }));
    expect((await provisionLaunchAccount(launch())).role).toBe("user");
  });

  test("refuses to demote the last enabled admin and leaves it unchanged", async () => {
    await provisionLaunchAccount(launch({ role: "admin" }));
    const provider = await fixture.provider();
    const admin = await provider.getAccount(ADMIN);
    if (!admin) throw new Error("the seeded admin is missing");
    await provider.updateAccount(
      { ...admin, disabled: true, sessionVersion: admin.sessionVersion + 1, updatedAt: new Date().toISOString() },
      { expected: admin },
    );
    const before = await provider.getAccount(MEMBER);
    const error = await thrown(() => provisionLaunchAccount(launch()));
    expect(error.status).toBe(409);
    expect(error.message).toBe(
      "Studio did not make this account a user, because it is the last enabled admin. Ask a Studio admin to make another account an admin first.",
    );
    expect(await provider.getAccount(MEMBER)).toEqual(before);
  });

  test("refuses a disabled bound account and never revives it", async () => {
    await provisionLaunchAccount(launch());
    const provider = await fixture.provider();
    const current = await provider.getAccount(MEMBER);
    if (!current) throw new Error("the launched account is missing");
    await provider.updateAccount(
      { ...current, disabled: true, sessionVersion: current.sessionVersion + 1, updatedAt: new Date().toISOString() },
      { expected: current },
    );
    const error = await thrown(() => provisionLaunchAccount(launch({ role: "admin" })));
    expect(error.status).toBe(401);
    expect(error.message).toBe("This account is disabled in Studio. Ask a Studio admin to enable it.");
    expect((await provider.getAccount(MEMBER))?.disabled).toBe(true);
    expect((await provider.getAccount(MEMBER))?.role).toBe("user");
  });

  test("checks the identity binding before the disabled flag, so only the bound person learns the account is disabled", async () => {
    await provisionLaunchAccount(launch());
    const provider = await fixture.provider();
    const current = await provider.getAccount(MEMBER);
    if (!current) throw new Error("the launched account is missing");
    await provider.updateAccount(
      { ...current, disabled: true, sessionVersion: current.sessionVersion + 1, updatedAt: new Date().toISOString() },
      { expected: current },
    );
    await expectNotLinked(launch({ subject: "platform-user-2" }));
    await expectNotLinked(launch({ issuer: "another-platform", subject: "platform-user-2" }));
    expect((await provider.getAccount(MEMBER))?.disabled).toBe(true);
  });

  test("answers 409 when the account changed between the read and the role write", async () => {
    await provisionLaunchAccount(launch());
    const provider = await fixture.provider();
    const update = spyOn(provider, "updateAccount").mockImplementation(async () => {
      throw new AccountWriteConflict();
    });
    try {
      const error = await thrown(() => provisionLaunchAccount(launch({ role: "admin" })));
      expect(error.status).toBe(409);
      expect(error.message).toBe(ACCOUNT_CHANGED);
    } finally {
      update.mockRestore();
    }
  });

  test("a launch that loses the race to create the same email signs in as the row the winner wrote", async () => {
    await requireAccountStore();
    const provider = await fixture.provider();
    const insert = provider.insertAccount.bind(provider);
    const spy = spyOn(provider, "insertAccount").mockImplementationOnce(async (account) => {
      await insert(account);
      throw Object.assign(new Error("UNIQUE constraint failed: accounts.email"), {
        code: "SQLITE_CONSTRAINT_PRIMARYKEY",
      });
    });
    try {
      const launched = await provisionLaunchAccount(launch());
      const row = await provider.getAccount(MEMBER);
      expect(launched).toEqual({ role: "user", username: MEMBER, sessionVersion: row?.sessionVersion });
    } finally {
      spy.mockRestore();
    }
  });

  test("an insert failure that left no row, or that is not a unique violation, propagates", async () => {
    await requireAccountStore();
    const provider = await fixture.provider();
    const spy = spyOn(provider, "insertAccount");
    try {
      spy.mockImplementationOnce(async () => {
        throw Object.assign(new Error("UNIQUE constraint failed: accounts.email"), {
          code: "SQLITE_CONSTRAINT_PRIMARYKEY",
        });
      });
      await expect(provisionLaunchAccount(launch())).rejects.toThrow("UNIQUE constraint failed");
      spy.mockImplementationOnce(async () => {
        throw new Error("disk I/O error");
      });
      await expect(provisionLaunchAccount(launch())).rejects.toThrow("disk I/O error");
      expect(await provider.getAccount(MEMBER)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});
