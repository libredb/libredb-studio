import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { logger } from "@/lib/logger";
import {
  RETIRED_IN_STORE_WARNING,
  UNDECRYPTABLE_WARNING_PREFIX,
  V1_ACCEPTED_WARNING,
  withCredentialEncryption,
} from "@/lib/storage/encrypting-provider";
import { VERSION_TWO_NOT_RECORDED } from "@/lib/storage/envelope-settings";
import { resetStorageEncryptionKey, sealSecret } from "@/lib/storage/encryption";
import { accountBinding, connectionBinding } from "@/lib/storage/envelope-binding";
import {
  type AccountUpdateOptions,
  PasskeySignInConflict,
  type ServerStorageProvider,
  type StoredAccount,
} from "@/lib/storage/types";
import { verifyTotp } from "@/lib/totp";
import type { DatabaseConnection } from "@/lib/types";
import { MemoryStorageProvider } from "../../../helpers/memory-storage-provider";
import { sealVersionOne } from "../../../helpers/storage-envelope-v1";

/** Mechanics: delegation, collection narrowing, the envelope state, and the single warning line. */

function stubProvider(overrides: Partial<ServerStorageProvider> = {}) {
  return {
    initialize: mock(async () => {}),
    readEnvelopeState: mock(async () => "v1-retired"),
    rewriteStoredCredentials: mock(async () => ({ kind: "already-retired" })),
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

/** The decorator over `inner`, initialized, as getStorageProvider hands it out. */
async function ready(inner: ServerStorageProvider): Promise<ServerStorageProvider> {
  const provider = withCredentialEncryption(inner);
  await provider.initialize();
  return provider;
}

/** `connection`'s password sealed for the place `owner` stores it, as the store holds it. */
function sealedFor(owner: string, record: DatabaseConnection, secret: string): string {
  return sealSecret(secret, connectionBinding(owner, record).field("password"));
}

const snapshot: Record<string, string | undefined> = {};

/** The envelope settings initialize reads; each case starts with neither set. */
const SETTINGS = ["STORAGE_ENCRYPTION_REQUIRE_V2", "STORAGE_ENCRYPTION_RESEAL"] as const;

beforeEach(() => {
  snapshot.JWT_SECRET = process.env.JWT_SECRET;
  snapshot.STORAGE_ENCRYPTION_KEY = process.env.STORAGE_ENCRYPTION_KEY;
  for (const key of SETTINGS) {
    snapshot[key] = process.env[key];
    delete process.env[key];
  }
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
  for (const key of SETTINGS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
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

    expect(await (await ready(inner)).getCollection("u", "dismissed_seeds")).toEqual(["seed-1"]);
  });

  test("a null connections read stays null rather than becoming an empty list", async () => {
    const inner = stubProvider();

    expect(await (await ready(inner)).getCollection("u", "connections")).toBeNull();
  });

  test("getAllData without a connections key is passed straight back", async () => {
    const inner = stubProvider({ getAllData: mock(async () => ({ history: [] })) as never });

    expect(await (await ready(inner)).getAllData("u")).toEqual({ history: [] });
  });

  test("mergeData without a connections key is passed straight back", async () => {
    const inner = stubProvider();
    await withCredentialEncryption(inner).mergeData("u", { history: [] });

    expect(inner.mergeData).toHaveBeenCalledWith("u", { history: [] });
  });
});

// FND-1: a stored connection may carry a type no provider has, or none. Sealing and opening never read the type, so
// such a record round-trips like any other: its type unchanged, an absent type still absent.
describe("a connection whose type names no provider", () => {
  test("a connection whose type names no provider is sealed and opened like any other", async () => {
    const unknown = { ...connection, id: "u1", type: "acmefoo" } as unknown as DatabaseConnection;
    const untyped: Record<string, unknown> = { ...connection, id: "n1" };
    delete untyped.type;
    const inner = stubProvider();
    const provider = withCredentialEncryption(inner);

    await provider.setCollection("u", "connections", [unknown, untyped as unknown as DatabaseConnection]);
    const setCollection = inner.setCollection as unknown as ReturnType<typeof mock>;
    const written = (setCollection.mock.calls[0] as unknown[])[2] as Record<string, unknown>[];
    expect(written.map((record) => record.type)).toEqual(["acmefoo", undefined]);
    expect("type" in written[1]).toBe(false);
    expect(written[0].password).not.toBe("s3cret");

    const reader = await ready(stubProvider({ getCollection: mock(async () => written) as never }));
    const opened = (await reader.getCollection("u", "connections")) as unknown;
    expect(JSON.parse(JSON.stringify(opened))).toEqual(JSON.parse(JSON.stringify([unknown, untyped])));
  });
});

describe("passkeys", () => {
  test("passes a sign-in conflict through unchanged", async () => {
    const conflict = new PasskeySignInConflict("account_changed");
    const recordPasskeySignIn = mock(async () => {
      throw conflict;
    });
    const wrapped = withCredentialEncryption(stubProvider({ recordPasskeySignIn } as never));

    await expect(wrapped.recordPasskeySignIn({ id: "pk-1" } as never)).rejects.toBe(conflict);
  });

  test("passes every passkey method through unchanged", async () => {
    // Nothing passkey-related is sealed: a public key, a user handle and a name are not secrets.
    const results = {
      listPasskeys: [{ id: "pk-1" }],
      countPasskeys: new Map([["ada@example.com", 1]]),
      getPasskeyUserHandle: "handle",
      findPasskey: { passkey: { id: "pk-1" }, userHandle: "handle" },
      insertPasskey: undefined,
      recordPasskeySignIn: undefined,
      renamePasskey: true,
      deletePasskey: undefined,
    };
    const mocks = Object.fromEntries(Object.entries(results).map(([name, value]) => [name, mock(async () => value)]));
    const updateAccount = mock(async () => 3);
    const wrapped = withCredentialEncryption(stubProvider({ ...mocks, updateAccount } as never));
    const registration = { passkey: { id: "pk-1" }, userHandle: "handle" } as never;
    const signIn = {
      id: "pk-1",
      email: "ada@example.com",
      expectedSessionVersion: 3,
      expectedRole: "user",
      signCount: 2,
    } as never;
    const removal = { email: "ada@example.com", id: "pk-1" } as never;

    expect(await wrapped.listPasskeys("ada@example.com")).toBe(results.listPasskeys as never);
    expect(await wrapped.countPasskeys()).toBe(results.countPasskeys);
    expect(await wrapped.getPasskeyUserHandle("ada@example.com")).toBe("handle");
    expect(await wrapped.findPasskey("cred-1")).toBe(results.findPasskey as never);
    expect(await wrapped.insertPasskey(registration)).toBeUndefined();
    expect(await wrapped.recordPasskeySignIn(signIn)).toBeUndefined();
    expect(await wrapped.renamePasskey("ada@example.com", "pk-1", "Laptop")).toBe(true);
    expect(await wrapped.deletePasskey(removal)).toBeUndefined();

    expect(mocks.listPasskeys).toHaveBeenCalledWith("ada@example.com");
    expect(mocks.countPasskeys).toHaveBeenCalledWith();
    expect(mocks.getPasskeyUserHandle).toHaveBeenCalledWith("ada@example.com");
    expect(mocks.findPasskey).toHaveBeenCalledWith("cred-1");
    expect(mocks.insertPasskey).toHaveBeenCalledWith(registration);
    expect(mocks.recordPasskeySignIn).toHaveBeenCalledWith(signIn);
    expect(mocks.renamePasskey).toHaveBeenCalledWith("ada@example.com", "pk-1", "Laptop");
    expect(mocks.deletePasskey).toHaveBeenCalledWith(removal);

    const account = {
      email: "ada@example.com",
      passwordHash: "scrypt$hash",
      role: "user" as const,
      totpSecret: null,
      totpPending: null,
      disabled: false,
      sessionVersion: 1,
      createdAt: "t",
      updatedAt: "t",
    };
    const options = { expected: { sessionVersion: 1, updatedAt: "t" }, clearPasskeys: true };
    expect(await wrapped.updateAccount({ ...account, sessionVersion: 2 }, options)).toBe(3);
    expect(updateAccount).toHaveBeenCalledWith({ ...account, sessionVersion: 2 }, options);
  });
});

describe("the envelope state", () => {
  test("initialize reads the store's envelope state once, and a store that still accepts v1 says so once", async () => {
    const inner = stubProvider({
      readEnvelopeState: mock(async () => "v1-accepted"),
      getAccount: mock(async () => null),
    } as never);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const provider = await ready(inner);
      await provider.getAllData("u");
      await provider.getCollection("u", "connections");
      await provider.getAccount("ada@example.com");

      expect(inner.readEnvelopeState).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.filter((call) => call[0] === V1_ACCEPTED_WARNING)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("the version 1 warning names the whole order: back up, re-seal, then keep STORAGE_ENCRYPTION_REQUIRE_V2 set", () => {
    const order = ["back up the store", "STORAGE_ENCRYPTION_RESEAL=true", "STORAGE_ENCRYPTION_REQUIRE_V2=true"];
    const at = order.map((step) => V1_ACCEPTED_WARNING.indexOf(step));
    expect(at.every((index) => index >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(V1_ACCEPTED_WARNING).toContain("remove STORAGE_ENCRYPTION_RESEAL and keep STORAGE_ENCRYPTION_REQUIRE_V2");
  });

  test("a store that retired v1 says once, at initialize, that the retirement is recorded only in the store", async () => {
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const provider = await ready(stubProvider({ getAccount: mock(async () => null) } as never));
      await provider.getAllData("u");
      await provider.getAccount("ada@example.com");

      const calls = warn.mock.calls.map((call) => call[0]);
      expect(calls.filter((line) => line === V1_ACCEPTED_WARNING)).toHaveLength(0);
      expect(calls.filter((line) => line === RETIRED_IN_STORE_WARNING)).toHaveLength(1);
      expect(RETIRED_IN_STORE_WARNING).toContain("recorded only in the store");
      expect(RETIRED_IN_STORE_WARNING).toContain("STORAGE_ENCRYPTION_REQUIRE_V2=true");
    } finally {
      warn.mockRestore();
    }
  });

  test("with STORAGE_ENCRYPTION_REQUIRE_V2 set and the store retired, initialize says nothing and v1 and unsealed values are refused as retired", async () => {
    process.env.STORAGE_ENCRYPTION_REQUIRE_V2 = "true";
    const store = new MemoryStorageProvider();
    store.marker = "v2";
    store.putRow(
      "u",
      "connections",
      JSON.stringify([
        { ...connection, id: "c1", password: sealVersionOne(randomUUID()) },
        { ...connection, id: "c2", password: randomUUID() },
      ]),
    );
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const provider = await ready(store);
      const initWarnings = warn.mock.calls.map((call) => call[0]);
      const read = (await provider.getCollection("u", "connections")) ?? [];

      expect(initWarnings).toEqual([]);
      expect(read.map((record) => "password" in record)).toEqual([false, false]);
      expect(ownWarnings(warn)[0]).toContain("c1 password (retired), c2 password (retired)");
    } finally {
      warn.mockRestore();
    }
  });

  test("with STORAGE_ENCRYPTION_REQUIRE_V2 set, v1 and unsealed values are refused as retired with no marker in the store while a re-seal is asked for", async () => {
    process.env.STORAGE_ENCRYPTION_REQUIRE_V2 = "on";
    process.env.STORAGE_ENCRYPTION_RESEAL = "true";
    const store = new MemoryStorageProvider();
    const secret = randomUUID();
    store.putRow("u", "connections", JSON.stringify([{ ...connection, password: sealVersionOne(secret) }]));
    store.accounts.set("ada@example.com", {
      email: "ada@example.com",
      passwordHash: "scrypt$hash",
      role: "user",
      totpSecret: randomUUID(),
      totpPending: null,
      disabled: false,
      sessionVersion: 0,
      createdAt: "t",
      updatedAt: "t",
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const provider = await ready(store);
      const read = (await provider.getCollection("u", "connections")) ?? [];
      const ada = await provider.getAccount("ada@example.com");

      expect(store.marker).toBeUndefined();
      expect("password" in read[0]).toBe(false);
      expect(ownWarnings(warn)[0]).toContain("c1 password (retired)");
      expect(ada?.totpSecret).toBe("!unopenable");
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
  });

  test("with STORAGE_ENCRYPTION_REQUIRE_V2 set and no re-seal asked for, a store with no marker fails initialize by name", async () => {
    process.env.STORAGE_ENCRYPTION_REQUIRE_V2 = "1";
    const inner = stubProvider({ readEnvelopeState: mock(async () => "v1-accepted") as never });
    const provider = withCredentialEncryption(inner);

    await expect(provider.initialize()).rejects.toThrow(VERSION_TWO_NOT_RECORDED);
    await expect(provider.getAllData("u")).rejects.toThrow("before initialize");
  });

  test("an invalid STORAGE_ENCRYPTION_REQUIRE_V2 fails initialize by name before the store is opened", async () => {
    process.env.STORAGE_ENCRYPTION_REQUIRE_V2 = "yes";
    const inner = stubProvider();

    await expect(withCredentialEncryption(inner).initialize()).rejects.toThrow(
      'STORAGE_ENCRYPTION_REQUIRE_V2 is invalid: got "yes"',
    );
    expect(inner.initialize).not.toHaveBeenCalled();
  });

  test("a read before initialize is refused", async () => {
    const provider = withCredentialEncryption(stubProvider({ getAccount: mock(async () => null) } as never));

    await expect(provider.getAllData("u")).rejects.toThrow("before initialize");
    await expect(provider.getCollection("u", "connections")).rejects.toThrow("before initialize");
    await expect(provider.getAccount("ada@example.com")).rejects.toThrow("before initialize");
    await expect(provider.listAccounts()).rejects.toThrow("before initialize");
  });

  test("an initialize whose state read fails fails by name", async () => {
    const refusal = new Error("Unknown credential envelope marker v9");
    const inner = stubProvider({
      readEnvelopeState: mock(async () => {
        throw refusal;
      }) as never,
    });

    await expect(withCredentialEncryption(inner).initialize()).rejects.toBe(refusal);
  });

  test("readEnvelopeState is the inner store's answer", async () => {
    const inner = stubProvider({ readEnvelopeState: mock(async () => "v1-accepted") as never });
    const provider = await ready(inner);

    expect(await provider.readEnvelopeState()).toBe("v1-accepted");
    expect(inner.readEnvelopeState).toHaveBeenCalledTimes(2);
  });

  test("rewriteStoredCredentials reaches the inner store, and from then on this process reads v1 as retired", async () => {
    const store = new MemoryStorageProvider();
    const legacy = { ...connection, password: sealVersionOne(randomUUID()) };
    store.putRow("u", "connections", JSON.stringify([legacy]));
    const provider = await ready(store);
    expect(((await provider.getCollection("u", "connections")) ?? [])[0].password).toBeDefined();

    const rewrite = { connections: () => null, factors: () => null, beforeRetire: () => {} };
    const result = await provider.rewriteStoredCredentials(rewrite, "pre-reseal-x");

    expect(result).toEqual({ kind: "rewritten", backup: "memory:pre-reseal-x" });
    expect(store.backups.map(({ label }) => label)).toEqual(["pre-reseal-x"]);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const read = (await provider.getCollection("u", "connections")) ?? [];
      expect("password" in read[0]).toBe(false);
      expect(ownWarnings(warn)[0]).toContain("c1 password (retired)");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the binding through the decorator", () => {
  test("an identity field edited through setCollection re-seals the value, which opens for the new record", async () => {
    const store = new MemoryStorageProvider();
    store.marker = "v2";
    const provider = await ready(store);
    const secret = randomUUID();
    await provider.setCollection("u", "connections", [{ ...connection, password: secret }]);
    const [read] = (await provider.getCollection("u", "connections")) ?? [];
    const sealedBefore = JSON.parse(store.row("u", "connections") ?? "[]")[0].password;

    await provider.setCollection("u", "connections", [{ ...read, host: "replica.internal" }]);

    const sealedAfter = JSON.parse(store.row("u", "connections") ?? "[]")[0].password;
    expect(sealedAfter).not.toBe(sealedBefore);
    expect(sealedAfter).toStartWith("v2:");
    expect(((await provider.getCollection("u", "connections")) ?? [])[0].password).toBe(secret);
  });

  test("re-saving an unchanged record keeps a v2 value byte for byte", async () => {
    const store = new MemoryStorageProvider();
    const provider = await ready(store);
    await provider.setCollection("u", "connections", [{ ...connection, password: randomUUID() }]);
    const before = store.row("u", "connections");

    // The record exactly as the store holds it, sealed value included: nothing about it changed, so nothing is sealed.
    await provider.setCollection("u", "connections", JSON.parse(before ?? "[]"));

    expect(store.row("u", "connections")).toBe(before);
  });

  test("mergeData seals for the owner of the row it writes", async () => {
    const store = new MemoryStorageProvider();
    const provider = await ready(store);
    const secret = randomUUID();

    await provider.mergeData("alice", { connections: [{ ...connection, password: secret }], history: [] });

    const stored = JSON.parse(store.row("alice", "connections") ?? "[]")[0].password;
    expect(stored).toStartWith("v2:");
    expect(stored).not.toBe(sealedFor("bob", connection, secret));
    expect(((await provider.getCollection("alice", "connections")) ?? [])[0].password).toBe(secret);
    store.putRow("bob", "connections", store.row("alice", "connections") ?? "");
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      expect("password" in ((await provider.getCollection("bob", "connections")) ?? [])[0]).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  test("a read names every omitted value with its connection, field and reason in one line", async () => {
    const store = new MemoryStorageProvider();
    store.marker = "v2";
    const envelope = sealedFor("u", connection, randomUUID());
    store.putRow(
      "u",
      "connections",
      JSON.stringify([
        { ...connection, id: "c2", password: envelope },
        {
          ...connection,
          id: "c3",
          password: sealVersionOne(randomUUID()),
          agentUser: "ro",
          agentPassword: randomUUID(),
        },
      ]),
    );
    const provider = await ready(store);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await provider.getAllData("u");

      const calls = ownWarnings(warn);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain("3 field(s) were omitted");
      expect(calls[0]).toContain("c2 password (unopenable), c3 password (retired), c3 agentPassword (retired)");
      expect(calls[0]).toContain("BEFORE the app writes again");
      expect(calls[0]).toContain("STORAGE_ENCRYPTION_RESEAL");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the warning", () => {
  test("gives the cause and the remedy of each reason present: retired, mixed, not-text and unbindable", async () => {
    const store = new MemoryStorageProvider();
    store.marker = "v2";
    let deep: unknown = "x";
    for (let level = 0; level < 100; level++) deep = { inner: deep };
    const envelope = sealedFor("u", connection, randomUUID());
    store.putRow(
      "u",
      "connections",
      JSON.stringify([
        null,
        { ...connection, password: envelope, connectionString: randomUUID(), apiKeyId: 7 },
        { ...connection, id: "c2", host: deep, password: randomUUID() },
        { ...connection, id: "c3", password: sealVersionOne(randomUUID()) },
      ]),
    );
    const provider = await ready(store);
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const data = await provider.getAllData("u");

      expect(data.connections?.[0]).toBeNull();
      const calls = ownWarnings(warn);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(
        "c1 apiKeyId (not-text), c1 connectionString (mixed), c2 password (unbindable), c3 password (retired)",
      );
      expect(calls[0]).toContain(
        "deleting the store's storage_meta row credential_envelope with every server stopped and re-sealing under the key that sealed it",
      );
      expect(calls[0]).toContain("A value marked mixed is a version 1 or unsealed value");
      expect(calls[0]).toContain("A value marked not-text is a number, a boolean, a list or an object");
      expect(calls[0]).toContain("A value marked unbindable belongs to a connection");
      expect(calls[0]).not.toContain("BEFORE the app writes again");
    } finally {
      warn.mockRestore();
    }
  });

  test("names each loss and the recovery action exactly once per read", async () => {
    const sealed = sealedFor("u", connection, randomUUID());
    const inner = stubProvider({
      getAllData: mock(async () => ({
        connections: [
          { ...connection, password: sealed },
          { ...connection, id: 7, password: sealed },
        ],
      })) as never,
    });
    const provider = await ready(inner);

    process.env.JWT_SECRET = randomBytes(32).toString("base64url");
    resetStorageEncryptionKey();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await provider.getAllData("u");

      const calls = ownWarnings(warn);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toContain(UNDECRYPTABLE_WARNING_PREFIX);
      expect(calls[0]).toContain("2 field(s)");
      expect(calls[0]).toContain("c1 password (unopenable), 7 password (unopenable)");
      expect(calls[0]).toContain("BEFORE the app writes again");
      expect(calls[0]).not.toContain("STORAGE_ENCRYPTION_RESEAL");
    } finally {
      warn.mockRestore();
    }
  });

  test("stays silent when everything opened, so the line means something when it appears", async () => {
    const inner = stubProvider({
      getAllData: mock(async () => ({
        connections: [{ ...connection, password: sealedFor("u", connection, randomUUID()) }],
      })) as never,
    });
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await (await ready(inner)).getAllData("u");

      expect(ownWarnings(warn)).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  test("also fires on the single-collection read path, not only on getAllData", async () => {
    const sealed = sealedFor("u", connection, randomUUID());
    const inner = stubProvider({ getCollection: mock(async () => [{ ...connection, password: sealed }]) as never });
    const provider = await ready(inner);

    process.env.JWT_SECRET = randomBytes(32).toString("base64url");
    resetStorageEncryptionKey();
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await provider.getCollection("u", "connections");

      expect(ownWarnings(warn)).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("account factors", () => {
  const account = (overrides: Partial<StoredAccount> = {}): StoredAccount => ({
    email: "ada@example.com",
    passwordHash: "scrypt$hash",
    role: "admin" as const,
    totpSecret: TOTP_SECRET,
    totpPending: TOTP_PENDING,
    disabled: false,
    sessionVersion: 7,
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  });

  test("account rows pass through, except the second-factor secrets, which are sealed at rest", async () => {
    const stored: StoredAccount[] = [];
    const insertAccount = mock(async (row: StoredAccount) => {
      stored.push(row);
    });
    const updateAccount = mock(async (row: StoredAccount, _options: AccountUpdateOptions) => {
      stored.push(row);
      return 0;
    });
    const deleteAccount = mock(async () => {});
    const inner = stubProvider({
      insertAccount,
      updateAccount,
      deleteAccount,
      listAccounts: mock(async () => stored),
      getAccount: mock(async () => stored[0] ?? null),
    } as never);
    const wrapped = await ready(inner);
    const row = account();

    await wrapped.insertAccount(row);
    await wrapped.updateAccount({ ...row, totpPending: null }, { expected: row, keepEnabledAdmin: true });
    await wrapped.deleteAccount(row.email, { keepEnabledAdmin: true });

    // What reached the store: no plaintext secret, everything else as given.
    expect(JSON.stringify(stored)).not.toContain(TOTP_SECRET);
    expect(JSON.stringify(stored)).not.toContain(TOTP_PENDING);
    expect(stored[0].totpSecret).toStartWith("v2:");
    expect(stored[0].totpPending).toStartWith("v2:");
    expect(stored[1].totpPending).toBeNull();
    expect({ ...stored[0], totpSecret: null, totpPending: null }).toEqual({
      ...row,
      totpSecret: null,
      totpPending: null,
    });
    expect(updateAccount.mock.calls[0][1]).toEqual({ expected: row, keepEnabledAdmin: true });
    expect(deleteAccount).toHaveBeenCalledWith(row.email, { keepEnabledAdmin: true });

    // What a caller reads back: the secrets open again.
    expect(await wrapped.getAccount(row.email)).toEqual(row);
    expect((await wrapped.listAccounts()).map((read) => read.totpSecret)).toEqual([TOTP_SECRET, TOTP_SECRET]);
  });

  test("a stored factor the key cannot open reads as an unusable secret, never as no factor", async () => {
    const row = account({
      totpSecret: sealSecret(TOTP_SECRET, accountBinding("ada@example.com").field("totpSecret")),
      totpPending: null,
    });
    const inner = stubProvider({ getAccount: mock(async () => row), listAccounts: mock(async () => [row]) } as never);
    const provider = await ready(inner);

    process.env.JWT_SECRET = randomBytes(32).toString("base64url");
    resetStorageEncryptionKey();
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const read = await provider.getAccount(row.email);
      // Still a factor, so login keeps asking for a code, and no code opens it.
      expect(read?.totpSecret).not.toBeNull();
      expect(verifyTotp(read?.totpSecret ?? "", "000000")).toBeNull();
      expect((await provider.listAccounts())[0].totpSecret).toBe(read?.totpSecret ?? "");
      expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toContain("ada@example.com");
    } finally {
      error.mockRestore();
    }
  });

  test("a factor moved to another account reads as unusable and is named", async () => {
    const store = new MemoryStorageProvider();
    const provider = await ready(store);
    await provider.insertAccount(account());
    await provider.insertAccount(account({ email: "bob@example.com", totpSecret: null, totpPending: null }));
    const ada = store.accounts.get("ada@example.com")!;
    store.accounts.set("bob@example.com", { ...store.accounts.get("bob@example.com")!, totpSecret: ada.totpSecret });
    store.accounts.set("ada@example.com", { ...ada, totpSecret: ada.totpPending, totpPending: ada.totpSecret });

    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const bob = await provider.getAccount("bob@example.com");
      const swapped = await provider.getAccount("ada@example.com");

      expect(bob?.totpSecret).toBe("!unopenable");
      expect([swapped?.totpSecret, swapped?.totpPending]).toEqual(["!unopenable", "!unopenable"]);
      const lines = error.mock.calls.map((call) => String(call[0]));
      expect(lines.some((line) => line.includes("bob@example.com") && line.includes("unopenable"))).toBe(true);
    } finally {
      error.mockRestore();
    }
  });

  test("a v1 factor opens while v1 is accepted and reads as unusable once it is retired", async () => {
    const row = account({ totpSecret: sealVersionOne(TOTP_SECRET), totpPending: TOTP_PENDING });
    const accepted = await ready(
      stubProvider({
        getAccount: mock(async () => row),
        readEnvelopeState: mock(async () => "v1-accepted"),
      } as never),
    );
    const retired = await ready(stubProvider({ getAccount: mock(async () => row) } as never));

    expect(await accepted.getAccount(row.email)).toEqual({ ...row, totpSecret: TOTP_SECRET });
    const error = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const read = await retired.getAccount(row.email);
      expect([read?.totpSecret, read?.totpPending]).toEqual(["!unopenable", "!unopenable"]);
      expect(error.mock.calls.map((call) => String(call[0])).join("\n")).toContain("(retired)");
    } finally {
      error.mockRestore();
    }
  });

  test("a factor stored before sealing existed is read as it is while v1 is accepted", async () => {
    const row = account({ totpPending: null });
    const inner = stubProvider({
      getAccount: mock(async () => row),
      readEnvelopeState: mock(async () => "v1-accepted"),
    } as never);
    expect((await (await ready(inner)).getAccount(row.email))?.totpSecret).toBe(TOTP_SECRET);
  });
});
