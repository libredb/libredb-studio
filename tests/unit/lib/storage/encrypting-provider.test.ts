import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { logger } from "@/lib/logger";
import { UNDECRYPTABLE_WARNING_PREFIX, withCredentialEncryption } from "@/lib/storage/encrypting-provider";
import { encryptSecret, resetStorageEncryptionKey } from "@/lib/storage/encryption";
import type { AccountWriteOptions, ServerStorageProvider, StoredAccount } from "@/lib/storage/types";
import { verifyTotp } from "@/lib/totp";
import type { DatabaseConnection } from "@/lib/types";

/** Mechanics: delegation, collection narrowing, and the single warning line. */

function stubProvider(overrides: Partial<ServerStorageProvider> = {}) {
  return {
    initialize: mock(async () => {}),
    isHealthy: mock(async () => true),
    close: mock(async () => {}),
    getAllData: mock(async () => ({})),
    getCollection: mock(async () => null),
    setCollection: mock(async () => {}),
    mergeData: mock(async () => {}),
    ...overrides,
  } as unknown as ServerStorageProvider & Record<string, ReturnType<typeof mock>>;
}

// Valid base32 test secrets, never credentials anywhere.
const TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const TOTP_PENDING = "KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU";

const connection: DatabaseConnection = {
  id: "c1",
  name: "Prod",
  type: "postgres",
  password: "s3cret",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
};

/**
 * `bun run test` runs this file in the same process as every route test under tests/api (see
 * package.json's "test" script), several of which fire an audit/log call that outlives the
 * request and only actually reaches `logger.warn` on a later microtask tick - one that can land
 * inside this file's `spyOn` window regardless of which test happens to be running at the time.
 * Filtering by the module's own message keeps these assertions about OUR warning, not about
 * however much unrelated logging the rest of the suite happens to have in flight.
 */
function ownWarnings(warn: ReturnType<typeof spyOn<typeof logger, "warn">>): string[] {
  return warn.mock.calls.map((call) => call[0]).filter((message) => message.startsWith(UNDECRYPTABLE_WARNING_PREFIX));
}

const snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  snapshot.JWT_SECRET = process.env.JWT_SECRET;
  snapshot.STORAGE_ENCRYPTION_KEY = process.env.STORAGE_ENCRYPTION_KEY;
  process.env.JWT_SECRET = "encrypting-provider-test-jwt-secret-32";
  // An ambient STORAGE_ENCRYPTION_KEY (a developer's local .env.local) takes precedence over
  // JWT_SECRET in inputKeyMaterial(), so the "rotate JWT_SECRET" tests below would silently stop
  // rotating anything - the derived key would never change, and the undecryptable-warning case
  // they exist to exercise would never fire. Match the sibling test's isolation
  // (tests/security/credential-at-rest.test.ts), which snapshots both variables.
  delete process.env.STORAGE_ENCRYPTION_KEY;
  resetStorageEncryptionKey();
});

afterEach(() => {
  if (snapshot.JWT_SECRET === undefined) delete process.env.JWT_SECRET;
  else process.env.JWT_SECRET = snapshot.JWT_SECRET;
  if (snapshot.STORAGE_ENCRYPTION_KEY === undefined) delete process.env.STORAGE_ENCRYPTION_KEY;
  else process.env.STORAGE_ENCRYPTION_KEY = snapshot.STORAGE_ENCRYPTION_KEY;
  resetStorageEncryptionKey();
});

describe("delegation", () => {
  test("initialize, isHealthy and close reach the inner provider unchanged", async () => {
    const inner = stubProvider();
    const provider = withCredentialEncryption(inner);

    await provider.initialize();
    await provider.close();

    expect(await provider.isHealthy()).toBe(true);
    expect(inner.initialize).toHaveBeenCalledTimes(1);
    expect(inner.close).toHaveBeenCalledTimes(1);
  });

  test("a collection that holds no credential is written through byte for byte", async () => {
    const inner = stubProvider();
    await withCredentialEncryption(inner).setCollection("u", "dismissed_seeds", ["seed-1"]);

    expect(inner.setCollection).toHaveBeenCalledWith("u", "dismissed_seeds", ["seed-1"]);
  });

  test("a non-connections read is returned untouched", async () => {
    const inner = stubProvider({ getCollection: mock(async () => ["seed-1"]) as never });

    expect(await withCredentialEncryption(inner).getCollection("u", "dismissed_seeds")).toEqual(["seed-1"]);
  });

  test("a null connections read stays null rather than becoming an empty list", async () => {
    const inner = stubProvider();

    expect(await withCredentialEncryption(inner).getCollection("u", "connections")).toBeNull();
  });

  test("getAllData without a connections key is passed straight back", async () => {
    const inner = stubProvider({ getAllData: mock(async () => ({ history: [] })) as never });

    expect(await withCredentialEncryption(inner).getAllData("u")).toEqual({ history: [] });
  });

  test("mergeData without a connections key is passed straight back", async () => {
    const inner = stubProvider();
    await withCredentialEncryption(inner).mergeData("u", { history: [] });

    expect(inner.mergeData).toHaveBeenCalledWith("u", { history: [] });
  });
});

describe("the warning", () => {
  test("names the count and the recovery action exactly once per read", async () => {
    const sealed = encryptSecret("s3cret");
    const inner = stubProvider({
      getAllData: mock(async () => ({
        connections: [
          { ...connection, password: sealed },
          { ...connection, id: "c2", password: sealed },
        ],
      })) as never,
    });

    process.env.JWT_SECRET = "a-different-secret-that-cannot-open-it";
    resetStorageEncryptionKey();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await withCredentialEncryption(inner).getAllData("u");

      const calls = ownWarnings(warn);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(UNDECRYPTABLE_WARNING_PREFIX);
      expect(calls[0]).toContain("2 field(s)");
      expect(calls[0]).toContain("BEFORE the app writes again");
    } finally {
      warn.mockRestore();
    }
  });

  test("stays silent when everything opened, so the line means something when it appears", async () => {
    const inner = stubProvider({
      getAllData: mock(async () => ({ connections: [{ ...connection, password: encryptSecret("s3cret") }] })) as never,
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await withCredentialEncryption(inner).getAllData("u");

      expect(ownWarnings(warn)).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  test("also fires on the single-collection read path, not only on getAllData", async () => {
    const sealed = encryptSecret("s3cret");
    const inner = stubProvider({ getCollection: mock(async () => [{ ...connection, password: sealed }]) as never });

    process.env.JWT_SECRET = "a-different-secret-that-cannot-open-it";
    resetStorageEncryptionKey();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await withCredentialEncryption(inner).getCollection("u", "connections");

      expect(ownWarnings(warn)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("account rows pass through, except the second-factor secrets, which are sealed at rest", async () => {
    const account = {
      email: "ada@example.com",
      passwordHash: "scrypt$hash",
      role: "admin" as const,
      totpSecret: TOTP_SECRET,
      totpPending: TOTP_PENDING,
      disabled: false,
      sessionVersion: 7,
      createdAt: "t",
      updatedAt: "t",
    };
    const stored: StoredAccount[] = [];
    const insertAccount = mock(async (row: StoredAccount) => {
      stored.push(row);
    });
    const updateAccount = mock(async (row: StoredAccount, _options?: AccountWriteOptions) => {
      stored.push(row);
    });
    const deleteAccount = mock(async () => {});
    const inner = stubProvider({
      insertAccount,
      updateAccount,
      deleteAccount,
      listAccounts: mock(async () => stored),
      getAccount: mock(async () => stored[0] ?? null),
    } as never);
    const wrapped = withCredentialEncryption(inner);

    await wrapped.insertAccount(account);
    await wrapped.updateAccount({ ...account, totpPending: null }, { keepEnabledAdmin: true });
    await wrapped.deleteAccount(account.email, { keepEnabledAdmin: true });

    // What reached the store: no plaintext secret, everything else as given.
    expect(JSON.stringify(stored)).not.toContain(TOTP_SECRET);
    expect(JSON.stringify(stored)).not.toContain(TOTP_PENDING);
    expect(stored[0].totpSecret).toStartWith("v1:");
    expect(stored[0].totpPending).toStartWith("v1:");
    expect(stored[1].totpPending).toBeNull();
    expect({ ...stored[0], totpSecret: null, totpPending: null }).toEqual({
      ...account,
      totpSecret: null,
      totpPending: null,
    });
    expect(updateAccount.mock.calls[0][1]).toEqual({ keepEnabledAdmin: true });
    expect(deleteAccount).toHaveBeenCalledWith(account.email, { keepEnabledAdmin: true });

    // What a caller reads back: the secrets open again.
    expect(await wrapped.getAccount(account.email)).toEqual(account);
    expect((await wrapped.listAccounts()).map((row) => row.totpSecret)).toEqual([TOTP_SECRET, TOTP_SECRET]);
  });

  test("a stored factor the key cannot open reads as an unusable secret, never as no factor", async () => {
    const sealed = encryptSecret(TOTP_SECRET);
    const row = {
      email: "ada@example.com",
      passwordHash: "scrypt$hash",
      role: "user" as const,
      totpSecret: sealed,
      totpPending: null,
      disabled: false,
      sessionVersion: 1,
      createdAt: "t",
      updatedAt: "t",
    };
    const inner = stubProvider({ getAccount: mock(async () => row), listAccounts: mock(async () => [row]) } as never);

    process.env.JWT_SECRET = "a-different-secret-that-cannot-open-it";
    resetStorageEncryptionKey();
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const read = await withCredentialEncryption(inner).getAccount(row.email);
      // Still a factor, so login keeps asking for a code, and no code opens it.
      expect(read?.totpSecret).not.toBeNull();
      expect(verifyTotp(read?.totpSecret ?? "", "000000")).toBeNull();
      expect((await withCredentialEncryption(inner).listAccounts())[0].totpSecret).toBe(read?.totpSecret ?? "");
      expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toContain("ada@example.com");
    } finally {
      error.mockRestore();
    }
  });

  test("a factor stored before sealing existed is read as it is and sealed at the next write", async () => {
    const row = {
      email: "ada@example.com",
      passwordHash: "scrypt$hash",
      role: "user" as const,
      totpSecret: TOTP_SECRET,
      totpPending: null,
      disabled: false,
      sessionVersion: 1,
      createdAt: "t",
      updatedAt: "t",
    };
    const inner = stubProvider({ getAccount: mock(async () => row) } as never);
    expect((await withCredentialEncryption(inner).getAccount(row.email))?.totpSecret).toBe(TOTP_SECRET);
  });
});
