import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  ENVELOPE_VERSION,
  encryptSecret,
  readSecret,
  resetStorageEncryptionKey,
  STORAGE_ENCRYPTION_KEY_MISSING_MESSAGE,
  STORAGE_ENCRYPTION_KEY_TOO_SHORT_MESSAGE,
} from "@/lib/storage/encryption";

/**
 * The envelope's job is narrow: make a stolen database file useless on its own, and never hand a
 * caller something that is not the credential. WHICH fields go through it is Task 3's question.
 */

const MUTATED = ["STORAGE_ENCRYPTION_KEY", "JWT_SECRET", "NODE_ENV"] as const;
const snapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of MUTATED) snapshot[key] = process.env[key];
  process.env.JWT_SECRET = "jwt-secret-used-only-by-this-test-file";
  delete process.env.STORAGE_ENCRYPTION_KEY;
  resetStorageEncryptionKey();
});

afterEach(() => {
  for (const key of MUTATED) {
    const value = snapshot[key];
    if (value === undefined) delete process.env[key];
    else (process.env as Record<string, string>)[key] = value;
  }
  resetStorageEncryptionKey();
});

describe("encryptSecret", () => {
  test("a dump of the ciphertext contains no fragment of the credential", () => {
    const sealed = encryptSecret("correct horse battery staple");

    expect(sealed).not.toContain("correct");
    expect(sealed).not.toContain("staple");
    expect(sealed).not.toContain("horse battery");
  });

  test("produces the three-part versioned envelope the storage contract promises", () => {
    const parts = encryptSecret("hunter2").split(":");

    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(ENVELOPE_VERSION);
    // base64url only, so the ':' separator can never be ambiguous and the value stays JSON-safe.
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(parts[2]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("never repeats an IV, so two equal passwords do not look equal in the store", () => {
    const first = encryptSecret("same-password");
    const second = encryptSecret("same-password");

    expect(first).not.toBe(second);
    expect(first.split(":")[1]).not.toBe(second.split(":")[1]);
  });

  test("round-trips a value carrying every character a password is allowed to contain", () => {
    const nasty = 'p@ss:w/o?rd#=+ "quoted" newline-and-tab: ' + String.fromCharCode(10, 9) + " accented e";

    expect(readSecret(encryptSecret(nasty))).toEqual({ kind: "decrypted", value: nasty });
  });

  test("round-trips an empty string rather than treating it as absent", () => {
    expect(readSecret(encryptSecret(""))).toEqual({ kind: "decrypted", value: "" });
  });
});

describe("readSecret: what a stored value is", () => {
  test("a value written before this feature existed is plaintext, not corruption", () => {
    expect(readSecret("legacy-plaintext-password")).toEqual({
      kind: "plaintext",
      value: "legacy-plaintext-password",
    });
  });

  test("a colon-bearing plaintext that is not a version tag stays plaintext", () => {
    expect(readSecret("host:5432:db")).toEqual({ kind: "plaintext", value: "host:5432:db" });
  });

  test("a connection-string plaintext with many colons and no version-tag prefix stays plaintext", () => {
    const connectionString = "postgresql://u:p@h:5432/db";

    expect(readSecret(connectionString)).toEqual({ kind: "plaintext", value: connectionString });
  });

  // D4: once the first segment matches a version tag (^v\d+$), the value is an envelope CLAIM, and
  // every way that claim can be malformed - including the wrong segment count - is undecryptable,
  // never plaintext. The plan already accepts this exposure for three-segment values (a legitimate
  // password shaped "v1:a:b" is rejected today); a laxer rule for the two-segment case would protect
  // nothing while letting corruption pass straight through as if it were a real password.
  test("a version-tag-shaped value with too few segments is corruption, not plaintext", () => {
    expect(readSecret("v1:only-two-parts")).toEqual({ kind: "undecryptable" });
  });

  test("a version-tag-shaped value with an empty second segment is corruption, not plaintext", () => {
    expect(readSecret("v1:")).toEqual({ kind: "undecryptable" });
  });

  test("a version-tag-shaped value with too many segments is corruption, not plaintext", () => {
    expect(readSecret("v1:a:b:c")).toEqual({ kind: "undecryptable" });
  });

  test("an unrecognised version with the wrong segment count is corruption too, not plaintext", () => {
    expect(readSecret("v2:abc")).toEqual({ kind: "undecryptable" });
  });

  test("an envelope written by a NEWER version is never handed back as if it were the password", () => {
    // The failure this pins: returning the raw string would put "v2:aaaa:bbbb" into a driver's
    // password field on a downgrade, which fails in a way nobody can diagnose.
    expect(readSecret("v2:aaaa:bbbb")).toEqual({ kind: "undecryptable" });
  });

  test("a v1 envelope with a wrong-length IV is corruption, not plaintext", () => {
    expect(readSecret("v1:AAAA:BBBBBBBBBBBBBBBBBBBBBBBB")).toEqual({ kind: "undecryptable" });
  });

  test("a v1 envelope too short to hold an authentication tag is corruption", () => {
    const iv = encryptSecret("x").split(":")[1];

    expect(readSecret(`v1:${iv}:AAAA`)).toEqual({ kind: "undecryptable" });
  });

  test("a truncated ciphertext fails authentication instead of returning a partial credential", () => {
    const sealed = encryptSecret("a-long-enough-password-to-truncate");
    const [version, iv, body] = sealed.split(":");

    expect(readSecret(`${version}:${iv}:${body.slice(0, body.length - 4)}`)).toEqual({
      kind: "undecryptable",
    });
  });

  test("a flipped ciphertext byte is rejected by the tag, not silently returned", () => {
    const sealed = encryptSecret("tamper-me");
    const [version, iv, body] = sealed.split(":");
    const bytes = Buffer.from(body, "base64url");
    bytes[0] ^= 0xff; // a CIPHERTEXT byte: the 16-byte tag occupies the trailing indices
    const flipped = bytes.toString("base64url");

    expect(readSecret(`${version}:${iv}:${flipped}`)).toEqual({ kind: "undecryptable" });
  });

  test("a flipped tag byte is rejected too, not just a flipped ciphertext byte", () => {
    const sealed = encryptSecret("tamper-me");
    const [version, iv, body] = sealed.split(":");
    const bytes = Buffer.from(body, "base64url");
    bytes[bytes.length - 1] ^= 0xff; // a TAG byte: the trailing 16 bytes of the sealed body
    const flipped = bytes.toString("base64url");

    expect(readSecret(`${version}:${iv}:${flipped}`)).toEqual({ kind: "undecryptable" });
  });

  test("a rotated JWT_SECRET makes the value undecryptable, never wrongly decrypted", () => {
    const sealed = encryptSecret("password-under-the-old-secret");

    process.env.JWT_SECRET = "a-completely-different-secret-value-32";
    resetStorageEncryptionKey();

    expect(readSecret(sealed)).toEqual({ kind: "undecryptable" });
  });
});

describe("the key", () => {
  test("an explicit STORAGE_ENCRYPTION_KEY takes over from JWT_SECRET", () => {
    process.env.STORAGE_ENCRYPTION_KEY = "a-dedicated-storage-key-of-enough-length";
    resetStorageEncryptionKey();
    const sealed = encryptSecret("separated");

    delete process.env.STORAGE_ENCRYPTION_KEY;
    resetStorageEncryptionKey();

    // Key separation is the whole point of the variable: falling back to JWT_SECRET here would
    // mean the dedicated key never actually separated anything.
    expect(readSecret(sealed)).toEqual({ kind: "undecryptable" });
  });

  test("the same explicit key reads back what it wrote", () => {
    process.env.STORAGE_ENCRYPTION_KEY = "a-dedicated-storage-key-of-enough-length";
    resetStorageEncryptionKey();
    const sealed = encryptSecret("separated");
    resetStorageEncryptionKey();

    expect(readSecret(sealed)).toEqual({ kind: "decrypted", value: "separated" });
  });

  test("a short STORAGE_ENCRYPTION_KEY is refused rather than quietly stretched", () => {
    process.env.STORAGE_ENCRYPTION_KEY = "too-short";
    resetStorageEncryptionKey();

    expect(() => encryptSecret("x")).toThrow(STORAGE_ENCRYPTION_KEY_TOO_SHORT_MESSAGE);
  });

  test("a missing JWT_SECRET in production refuses to write rather than writing plaintext", () => {
    delete process.env.JWT_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "production";
    resetStorageEncryptionKey();

    expect(() => encryptSecret("x")).toThrow(STORAGE_ENCRYPTION_KEY_MISSING_MESSAGE);
  });

  test("a plaintext read needs no key at all, so a broken key never hides existing data", () => {
    delete process.env.JWT_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "production";
    resetStorageEncryptionKey();

    expect(readSecret("legacy-plaintext")).toEqual({ kind: "plaintext", value: "legacy-plaintext" });
  });

  test("a broken key turns an enveloped read into undecryptable, not into a thrown request", () => {
    const sealed = encryptSecret("x");
    delete process.env.JWT_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "production";
    resetStorageEncryptionKey();

    expect(readSecret(sealed)).toEqual({ kind: "undecryptable" });
  });
});
