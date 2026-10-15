/**
 * Opening governed credentials with the loaded keyring (docs/GOVERNANCE.md#sealed-credentials-lsb1).
 *
 * `openGovernedSecret` opens an `lsb1` envelope with the keyring `GOVERNANCE_PRIVATE_KEYS_FILE` loaded and caches what
 * it opened under the SHA-256 of the envelope together with the additional authenticated data it opened under. So a
 * reload that sees the same envelope for the same row skips the cipher, and a cache hit can never stand in for the
 * binding check: the same envelope under another binding is another entry, which has to open on its own.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { CanonicalJsonError } from "@/lib/governance/jcs";
import { resetGovernanceKeyring } from "@/lib/governance/keyring";
import { SealedSecretError, type SecretBinding } from "@/lib/governance/lsb1";
import { OPENED_SECRETS_MAX, openGovernedSecret } from "@/lib/governance/secrets";
import { keyringFileOf, removeKeyringFiles, type TestKey, testKey } from "../../../helpers/governance/keyring-file";
import { sealSecret } from "../../../helpers/governance/lsb1-seal";

const BINDING: SecretBinding = {
  connectionId: "3f6c2a91-0d4e-4b7a-9e15-c8a2f7d64b03",
  level: "read",
  engine: "postgres",
  definition: { host: "db.example.internal", port: 5432, database: "app", ssl: { mode: "verify-full" } },
};

const CREDENTIAL = { user: "reader", password: "example-only-password-in-a-test" };

/** The code of the SealedSecretError `run` throws. */
const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (error instanceof SealedSecretError) return error.code;
    throw error;
  }
  throw new Error("expected the call to throw");
};

let key: TestKey;
let savedFile: string | undefined;
let quiet: ReturnType<typeof spyOn>;

/** Points GOVERNANCE_PRIVATE_KEYS_FILE at a keyring of `keys` that has not been loaded yet. */
function useKeyring(...keys: readonly TestKey[]): void {
  resetGovernanceKeyring();
  process.env.GOVERNANCE_PRIVATE_KEYS_FILE = keyringFileOf(...keys);
}

beforeEach(() => {
  savedFile = process.env.GOVERNANCE_PRIVATE_KEYS_FILE;
  // The keyring logs its kids when it loads; nothing here is about that line.
  quiet = spyOn(console, "info").mockImplementation(() => {});
  key = testKey();
  useKeyring(key);
});

afterEach(() => {
  quiet.mockRestore();
  if (savedFile === undefined) delete process.env.GOVERNANCE_PRIVATE_KEYS_FILE;
  else process.env.GOVERNANCE_PRIVATE_KEYS_FILE = savedFile;
  resetGovernanceKeyring();
});

afterAll(() => {
  removeKeyringFiles();
});

describe("openGovernedSecret", () => {
  test("a cached secret is not returned for the same envelope under a different definition", () => {
    const envelope = sealSecret(key.publicKey, BINDING, CREDENTIAL);
    const opened = openGovernedSecret(envelope, BINDING);
    expect(opened).toEqual(CREDENTIAL);
    // The second open is a cache hit: the very object the first open returned.
    expect(openGovernedSecret(envelope, BINDING)).toBe(opened);

    // The cache key holds the binding, so another definition misses it and opens on its own, which fails.
    const elsewhere: SecretBinding = { ...BINDING, definition: { ...BINDING.definition, host: "elsewhere.example" } };
    const downgraded: SecretBinding = { ...BINDING, definition: { ...BINDING.definition, ssl: { mode: "disable" } } };
    for (const moved of [elsewhere, downgraded]) {
      expect(codeOf(() => openGovernedSecret(envelope, moved))).toBe("AUTH_FAILED");
      // A failure is never cached either: it fails again, and the original binding still hits.
      expect(codeOf(() => openGovernedSecret(envelope, moved))).toBe("AUTH_FAILED");
      expect(openGovernedSecret(envelope, BINDING)).toBe(opened);
    }

    // The definition is bound through its canonical form, so the same definition in another key order is a hit.
    const reordered: SecretBinding = {
      ...BINDING,
      definition: { ssl: { mode: "verify-full" }, database: "app", port: 5432, host: "db.example.internal" },
    };
    expect(openGovernedSecret(envelope, reordered)).toBe(opened);
  });

  test("an opened secret is frozen, so no caller can change what the cache serves the next one", () => {
    const opened = openGovernedSecret(sealSecret(key.publicKey, BINDING, CREDENTIAL), BINDING);
    expect(Object.isFrozen(opened)).toBe(true);
  });

  test("two envelopes of one binding are two entries, each opening to its own credential", () => {
    const writer = { user: "writer", password: "example-only-write-password" };
    const first = sealSecret(key.publicKey, BINDING, CREDENTIAL);
    const second = sealSecret(key.publicKey, BINDING, writer);
    expect(openGovernedSecret(first, BINDING)).toEqual(CREDENTIAL);
    expect(openGovernedSecret(second, BINDING)).toEqual(writer);
    expect(openGovernedSecret(first, BINDING)).toEqual(CREDENTIAL);
  });

  test("the cache belongs to the keyring it opened with: another keyring opens the envelope again", () => {
    const envelope = sealSecret(key.publicKey, BINDING, CREDENTIAL);
    expect(openGovernedSecret(envelope, BINDING)).toEqual(CREDENTIAL);

    // A keyring without the envelope's key never sees what the first keyring opened.
    useKeyring(testKey());
    expect(codeOf(() => openGovernedSecret(envelope, BINDING))).toBe("UNKNOWN_KID");

    // A keyring that holds the key again opens it afresh.
    useKeyring(testKey(), key);
    expect(openGovernedSecret(envelope, BINDING)).toEqual(CREDENTIAL);
  });

  test("a malformed envelope fails with FORMAT and a definition no lsb1 binding admits is the caller's error", () => {
    expect(codeOf(() => openGovernedSecret("lsb1.not-an-envelope", BINDING))).toBe("FORMAT");
    expect(codeOf(() => openGovernedSecret("", BINDING))).toBe("FORMAT");
    const envelope = sealSecret(key.publicKey, BINDING, CREDENTIAL);
    const fractional: SecretBinding = { ...BINDING, definition: { ...BINDING.definition, port: 1.5 } };
    expect(() => openGovernedSecret(envelope, fractional)).toThrow(CanonicalJsonError);
  });

  test("without a keyring to load it fails naming GOVERNANCE_PRIVATE_KEYS_FILE", () => {
    resetGovernanceKeyring();
    delete process.env.GOVERNANCE_PRIVATE_KEYS_FILE;
    const envelope = sealSecret(key.publicKey, BINDING, CREDENTIAL);
    expect(() => openGovernedSecret(envelope, BINDING)).toThrow("GOVERNANCE_PRIVATE_KEYS_FILE is not set");
  });

  test(`the cache keeps the ${OPENED_SECRETS_MAX} secrets used most recently`, () => {
    const bindings: SecretBinding[] = Array.from({ length: OPENED_SECRETS_MAX + 1 }, (_, index) => ({
      ...BINDING,
      connectionId: `connection-${index}`,
    }));
    const envelopes = bindings.map((binding) => sealSecret(key.publicKey, binding, CREDENTIAL));
    const opened = bindings
      .slice(0, OPENED_SECRETS_MAX)
      .map((binding, index) => openGovernedSecret(envelopes[index], binding));

    // Using the first again makes the second the least recently used, so the one past the bound evicts the second.
    expect(openGovernedSecret(envelopes[0], bindings[0])).toBe(opened[0]);
    openGovernedSecret(envelopes[OPENED_SECRETS_MAX], bindings[OPENED_SECRETS_MAX]);

    expect(openGovernedSecret(envelopes[0], bindings[0])).toBe(opened[0]);
    expect(openGovernedSecret(envelopes[2], bindings[2])).toBe(opened[2]);
    const reopened = openGovernedSecret(envelopes[1], bindings[1]);
    expect(reopened).toEqual(CREDENTIAL);
    expect(reopened).not.toBe(opened[1]);
  });
});
