import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createCipheriv, createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { accountBinding, connectionBinding, type EnvelopeBinding } from "@/lib/storage/envelope-binding";
import {
  ENVELOPE_VERSION,
  openSecret,
  readStoredSecret,
  resetStorageEncryptionKey,
  sealSecret,
  STORAGE_ENCRYPTION_KEY_MISSING_MESSAGE,
  STORAGE_ENCRYPTION_KEY_TOO_SHORT_MESSAGE,
} from "@/lib/storage/encryption";
import type { SecretFieldRecord } from "@/lib/storage/secret-fields";
import { sealVersionOne } from "../../../helpers/storage-envelope-v1";

/**
 * The envelope's job is narrow: make a stolen database file useless on its own, open a value only in the place it was
 * sealed for, and never hand a caller something that is not the credential. WHICH fields go through it is
 * connection-secrets.ts's question.
 */

const MUTATED = ["STORAGE_ENCRYPTION_KEY", "JWT_SECRET", "NODE_ENV"] as const;
const snapshot: Record<string, string | undefined> = {};

const generated = (): string => randomBytes(32).toString("base64url");

beforeEach(() => {
  for (const key of MUTATED) snapshot[key] = process.env[key];
  process.env.JWT_SECRET = generated();
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

const record = (overrides: Record<string, unknown> = {}): SecretFieldRecord =>
  ({
    id: "c1",
    name: "Orders",
    type: "postgres",
    host: "db.internal",
    port: 5432,
    user: "app",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }) as SecretFieldRecord;

/** The binding every case seals under unless it says otherwise. */
const HERE = (): EnvelopeBinding => connectionBinding("alice", record()).field("password");

/** An envelope sealed by hand from the documented format, with the components of its binding chosen by the caller. */
function sealByHand(plaintext: string, aad: Record<string, unknown>): string {
  const material = process.env.STORAGE_ENCRYPTION_KEY || process.env.JWT_SECRET!;
  const key = Buffer.from(
    hkdfSync(
      "sha256",
      new TextEncoder().encode(material),
      new Uint8Array(0),
      "libredb-studio/storage-encryption/v1",
      32,
    ),
  );
  const keys = Object.keys(aad).sort();
  const text = `{${keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(aad[k])}`).join(",")}}`;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(text, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final(), cipher.getAuthTag()]);
  return `v2:${iv.toString("base64url")}:${body.toString("base64url")}`;
}

/** The documented binding of HERE, component by component. */
function documentedHere(): Record<string, unknown> {
  const identity = '{"host":"db.internal","port":5432,"type":"postgres","user":"app"}';
  return {
    d: createHash("sha256").update(identity, "utf8").digest("base64url"),
    f: "password",
    o: "alice",
    r: "c1",
    s: "v2",
    t: "connections",
  };
}

describe("sealSecret", () => {
  test("a dump of the ciphertext contains no fragment of the credential", () => {
    const secret = `${randomUUID()} ${randomUUID()}`;
    const sealed = sealSecret(secret, HERE());

    for (const fragment of secret.split(/[- ]/)) expect(sealed).not.toContain(fragment);
  });

  test("sealSecret writes the three-part v2 envelope", () => {
    const parts = sealSecret(randomUUID(), HERE()).split(":");

    expect(ENVELOPE_VERSION).toBe("v2");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("v2");
    // base64url only, so the ':' separator can never be ambiguous and the value stays JSON-safe.
    expect(parts[1]).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(parts[2]).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test("never repeats an IV, so two equal passwords do not look equal in the store", () => {
    const secret = randomUUID();
    const first = sealSecret(secret, HERE());
    const second = sealSecret(secret, HERE());

    expect(first).not.toBe(second);
    expect(first.split(":")[1]).not.toBe(second.split(":")[1]);
  });

  test("round-trips a value carrying every character a password is allowed to contain", () => {
    const nasty = `${randomUUID()}:w/o?rd#=+ "quoted" ${String.fromCharCode(10, 9)} accented e`;

    expect(openSecret(sealSecret(nasty, HERE()), HERE())).toEqual({ kind: "v2", value: nasty });
  });

  test("round-trips an empty string rather than treating it as absent", () => {
    expect(openSecret(sealSecret("", HERE()), HERE())).toEqual({ kind: "v2", value: "" });
  });
});

describe("the binding", () => {
  test("the envelope follows the documented format", () => {
    const secret = randomUUID();

    expect(openSecret(sealByHand(secret, documentedHere()), HERE())).toEqual({ kind: "v2", value: secret });
  });

  test("a v2 value opens only under the binding it was sealed for", () => {
    const secret = randomUUID();
    const changes: Record<string, unknown> = {
      d: createHash("sha256").update("{}", "utf8").digest("base64url"),
      f: "sshTunnel.password",
      o: "bob",
      r: "c2",
      s: "v3",
      t: "accounts",
    };
    const outcomes = Object.fromEntries(
      Object.entries(changes).map(([component, value]) => [
        component,
        openSecret(sealByHand(secret, { ...documentedHere(), [component]: value }), HERE()).kind,
      ]),
    );

    expect(outcomes).toEqual({
      d: "unopenable",
      f: "unopenable",
      o: "unopenable",
      r: "unopenable",
      s: "unopenable",
      t: "unopenable",
    });
  });

  test("a value sealed through the module opens only under the same binding", () => {
    const sealed = sealSecret(randomUUID(), HERE());
    const elsewhere: Record<string, EnvelopeBinding> = {
      identity: connectionBinding("alice", record({ host: "elsewhere.internal" })).field("password"),
      field: connectionBinding("alice", record()).field("sshTunnel.password"),
      owner: connectionBinding("bob", record()).field("password"),
      record: connectionBinding("alice", record({ id: "c2" })).field("password"),
      table: accountBinding("alice").field("totpSecret"),
    };

    expect(
      Object.fromEntries(Object.entries(elsewhere).map(([name, b]) => [name, openSecret(sealed, b).kind])),
    ).toEqual({
      identity: "unopenable",
      field: "unopenable",
      owner: "unopenable",
      record: "unopenable",
      table: "unopenable",
    });
  });

  test("a v1 envelope relabelled v2, or a v2 envelope relabelled v1, does not open", () => {
    const versionOne = sealVersionOne(randomUUID());
    const versionTwo = sealSecret(randomUUID(), HERE());

    expect(openSecret(versionOne.replace(/^v1:/, "v2:"), HERE())).toEqual({ kind: "unopenable" });
    expect(openSecret(versionTwo.replace(/^v2:/, "v1:"), HERE())).toEqual({ kind: "unopenable" });
  });

  test("a v1 envelope sealed by the previous version still opens", () => {
    const secret = randomUUID();

    expect(openSecret(sealVersionOne(secret), HERE())).toEqual({ kind: "v1", value: secret });
  });
});

describe("openSecret: what a stored value is", () => {
  test("a value written before encryption existed is plaintext, not corruption", () => {
    const legacy = randomUUID();

    expect(openSecret(legacy, HERE())).toEqual({ kind: "plaintext", value: legacy });
  });

  test("a colon-bearing plaintext that is not a version tag stays plaintext", () => {
    expect(openSecret("host:5432:db", HERE())).toEqual({ kind: "plaintext", value: "host:5432:db" });
    const connectionString = `postgresql://u:${randomUUID()}@h:5432/db`;
    expect(openSecret(connectionString, HERE())).toEqual({ kind: "plaintext", value: connectionString });
  });

  // D4 (src/lib/storage/envelope-claim.ts): once the first segment matches a version tag (^v\d+$), the value is an
  // envelope CLAIM, and every way that claim can be malformed - including the wrong segment count - is unopenable,
  // never plaintext.
  test("every malformed envelope claim is unopenable, never plaintext", () => {
    const iv = randomBytes(12).toString("base64url");
    for (const claim of [
      "v1:only-two-parts",
      "v1:",
      "v1:a:b:c",
      "v2:abc",
      "v2:aaaa:bbbb",
      "v9:aaaa:bbbb",
      "v1:AAAA:BBBBBBBBBBBBBBBBBBBBBBBB",
      `v1:${iv}:AAAA`,
      `v2:${iv}:AAAA`,
    ]) {
      expect({ claim, read: openSecret(claim, HERE()) }).toEqual({ claim, read: { kind: "unopenable" } });
    }
  });

  test("a truncated ciphertext fails authentication instead of returning a partial credential", () => {
    const [version, iv, body] = sealSecret(`${randomUUID()}${randomUUID()}`, HERE()).split(":");

    expect(openSecret(`${version}:${iv}:${body.slice(0, body.length - 4)}`, HERE())).toEqual({ kind: "unopenable" });
  });

  test("a flipped ciphertext or tag byte is rejected by the tag, not silently returned", () => {
    for (const index of [0, -1]) {
      const [version, iv, body] = sealSecret(randomUUID(), HERE()).split(":");
      const bytes = Buffer.from(body, "base64url");
      bytes[index < 0 ? bytes.length - 1 : index] ^= 0xff;

      expect(openSecret(`${version}:${iv}:${bytes.toString("base64url")}`, HERE())).toEqual({ kind: "unopenable" });
    }
  });

  test("a rotated JWT_SECRET makes the value unopenable, never wrongly opened", () => {
    const sealed = sealSecret(randomUUID(), HERE());

    process.env.JWT_SECRET = generated();
    resetStorageEncryptionKey();

    expect(openSecret(sealed, HERE())).toEqual({ kind: "unopenable" });
  });
});

describe("readStoredSecret", () => {
  test("readStoredSecret opens a v1 and an unsealed value while v1 is accepted and refuses both by name once it is retired", () => {
    const secret = randomUUID();
    const versionOne = sealVersionOne(secret);

    expect(readStoredSecret(versionOne, HERE(), "v1-accepted")).toEqual({ kind: "opened", value: secret });
    expect(readStoredSecret(secret, HERE(), "v1-accepted")).toEqual({ kind: "opened", value: secret });
    expect(readStoredSecret(versionOne, HERE(), "v1-retired")).toEqual({ kind: "refused", reason: "retired" });
    expect(readStoredSecret(secret, HERE(), "v1-retired")).toEqual({ kind: "refused", reason: "retired" });
  });

  test("a v2 value opens in either state", () => {
    const secret = randomUUID();
    const sealed = sealSecret(secret, HERE());

    expect(readStoredSecret(sealed, HERE(), "v1-accepted")).toEqual({ kind: "opened", value: secret });
    expect(readStoredSecret(sealed, HERE(), "v1-retired")).toEqual({ kind: "opened", value: secret });
  });

  test("readStoredSecret omits a value that does not open, and never returns it", () => {
    const sealed = sealSecret(randomUUID(), HERE());
    const elsewhere = connectionBinding("bob", record()).field("password");

    for (const state of ["v1-accepted", "v1-retired"] as const) {
      expect(readStoredSecret(sealed, elsewhere, state)).toEqual({ kind: "refused", reason: "unopenable" });
      expect(readStoredSecret("v2:aaaa:bbbb", HERE(), state)).toEqual({ kind: "refused", reason: "unopenable" });
    }
  });
});

describe("the key", () => {
  test("an explicit STORAGE_ENCRYPTION_KEY takes over from JWT_SECRET", () => {
    process.env.STORAGE_ENCRYPTION_KEY = generated();
    resetStorageEncryptionKey();
    const sealed = sealSecret(randomUUID(), HERE());

    delete process.env.STORAGE_ENCRYPTION_KEY;
    resetStorageEncryptionKey();

    // Key separation is the whole point of the variable: falling back to JWT_SECRET here would
    // mean the dedicated key never actually separated anything.
    expect(openSecret(sealed, HERE())).toEqual({ kind: "unopenable" });
  });

  test("the same explicit key reads back what it wrote", () => {
    process.env.STORAGE_ENCRYPTION_KEY = generated();
    resetStorageEncryptionKey();
    const secret = randomUUID();
    const sealed = sealSecret(secret, HERE());
    resetStorageEncryptionKey();

    expect(openSecret(sealed, HERE())).toEqual({ kind: "v2", value: secret });
  });

  test("a short STORAGE_ENCRYPTION_KEY is refused rather than quietly stretched", () => {
    process.env.STORAGE_ENCRYPTION_KEY = generated().slice(0, 8);
    resetStorageEncryptionKey();

    expect(() => sealSecret("x", HERE())).toThrow(STORAGE_ENCRYPTION_KEY_TOO_SHORT_MESSAGE);
  });

  test("a missing JWT_SECRET in production refuses to write rather than writing plaintext", () => {
    delete process.env.JWT_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "production";
    resetStorageEncryptionKey();

    expect(() => sealSecret("x", HERE())).toThrow(STORAGE_ENCRYPTION_KEY_MISSING_MESSAGE);
  });

  test("a plaintext read needs no key at all, so a broken key never hides existing data", () => {
    delete process.env.JWT_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "production";
    resetStorageEncryptionKey();
    const legacy = randomUUID();

    expect(openSecret(legacy, HERE())).toEqual({ kind: "plaintext", value: legacy });
  });

  test("a broken key turns an enveloped read into unopenable, not into a thrown request", () => {
    const sealed = sealSecret(randomUUID(), HERE());
    const versionOne = sealVersionOne(randomUUID());
    delete process.env.JWT_SECRET;
    (process.env as Record<string, string>).NODE_ENV = "production";
    resetStorageEncryptionKey();

    expect(openSecret(sealed, HERE())).toEqual({ kind: "unopenable" });
    expect(openSecret(versionOne, HERE())).toEqual({ kind: "unopenable" });
  });
});
