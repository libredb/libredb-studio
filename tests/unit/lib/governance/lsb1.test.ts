/**
 * Opening `lsb1` envelopes (spec 8.1 to 8.3).
 *
 * An envelope binds its credential to one connection id, level, engine, key id and canonical definition, so a
 * database writer cannot point a stored credential at another host, engine or level. The envelopes here come from
 * the test sealer in tests/helpers/governance/lsb1-seal.ts, because Studio's own code opens and never seals.
 */
import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PLAINTEXT_KEYS, PLAINTEXT_MAX_BYTES } from "@/lib/governance/contract";
import { x25519PrivateKey, x25519RawPublicKey } from "@/lib/governance/hpke";
import { CanonicalJsonError } from "@/lib/governance/jcs";
import {
  bindingAad,
  type Keyring,
  kidOf,
  openSealedSecret,
  SealedSecretError,
  type SecretBinding,
} from "@/lib/governance/lsb1";
import { sealSecret } from "../../../helpers/governance/lsb1-seal";

const ROOT = path.resolve(import.meta.dir, "../../../..");

const CFRG = (
  JSON.parse(
    readFileSync(path.join(ROOT, "tests/fixtures/governance/hpke-cfrg-x25519-sha256-aes256gcm.json"), "utf8"),
  ) as { suite: { skRm: string; pkRm: string; skEm: string; enc: string } }
).suite;

const bytes = (hex: string): Buffer => Buffer.from(hex, "hex");

/** A fresh recipient key pair, its kid, and a keyring that holds it. */
const recipientKey = () => {
  const { privateKey } = generateKeyPairSync("x25519");
  const publicKey = x25519RawPublicKey(privateKey);
  const kid = kidOf(publicKey);
  const keyring: Keyring = new Map([[kid, privateKey]]);
  return { privateKey, publicKey, kid, keyring };
};

const BINDING: SecretBinding = {
  connectionId: "5b0f3c1e-8a4d-4f7e-9c2b-1d6e0a7f3b94",
  level: "read",
  engine: "postgres",
  definition: {
    host: "db.example.internal",
    port: 5432,
    database: "app",
    ssl: { mode: "verify-full", rejectUnauthorized: true },
  },
};

const CREDENTIAL = { user: "reader", password: "hunter2" };

/** The code of the SealedSecretError `run` throws, after checking that its message carries the code and nothing else. */
const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    if (!(error instanceof SealedSecretError)) throw error;
    expect(error.message).toBe(`The sealed secret did not open: ${error.code}`);
    return error.code;
  }
  throw new Error("expected the call to throw");
};

/** `text` with its last character moved one place along the base64url alphabet. */
const nudgeLast = (text: string): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  return text.slice(0, -1) + alphabet[(alphabet.indexOf(text.slice(-1)) + 1) % alphabet.length];
};

describe("openSealedSecret", () => {
  test("an envelope sealed for one binding opens only under that binding and fails AUTH_FAILED under any other", () => {
    const { privateKey, publicKey, kid, keyring } = recipientKey();
    const envelope = sealSecret(publicKey, BINDING, CREDENTIAL);
    expect(envelope).toMatch(/^lsb1\.([0-9a-f]{16})\.([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{22,})$/);
    expect(envelope.split(".")[1]).toBe(kid);
    expect(openSealedSecret(keyring, envelope, BINDING)).toEqual(CREDENTIAL);

    // The definition is bound through its canonical form, so the order its keys arrive in does not matter.
    const reordered: SecretBinding = {
      ...BINDING,
      definition: {
        ssl: { rejectUnauthorized: true, mode: "verify-full" },
        database: "app",
        port: 5432,
        host: "db.example.internal",
      },
    };
    expect(openSealedSecret(keyring, envelope, reordered)).toEqual(CREDENTIAL);

    const others: SecretBinding[] = [
      { ...BINDING, connectionId: "0c9e2d4b-7f1a-4b3c-8d5e-6a2f9e1b7c30" },
      { ...BINDING, level: "write" },
      { ...BINDING, engine: "mysql" },
      { ...BINDING, definition: { ...BINDING.definition, host: "elsewhere.example" } },
      { ...BINDING, definition: { ...BINDING.definition, port: 5433 } },
      { ...BINDING, definition: { ...BINDING.definition, ssl: { mode: "disable" } } },
      { ...BINDING, definition: { ...BINDING.definition, schema: "public" } },
    ];
    for (const other of others) expect(codeOf(() => openSealedSecret(keyring, envelope, other))).toBe("AUTH_FAILED");

    // Another private key under the same kid is a key the envelope was not sealed to.
    const stranger = generateKeyPairSync("x25519").privateKey;
    expect(codeOf(() => openSealedSecret(new Map([[kid, stranger]]), envelope, BINDING))).toBe("AUTH_FAILED");
    expect(openSealedSecret(new Map([[kid, privateKey]]), envelope, BINDING)).toEqual(CREDENTIAL);
  });

  test("an all-zero enc fails with LOW_ORDER_POINT", () => {
    const { kid, keyring } = recipientKey();
    const zeros = Buffer.alloc(32).toString("base64url");
    expect(codeOf(() => openSealedSecret(keyring, `lsb1.${kid}.${zeros}.${zeros}`, BINDING))).toBe("LOW_ORDER_POINT");
  });

  test("src/lib/governance/lsb1.ts exports no sealing function", async () => {
    const lsb1 = await import("@/lib/governance/lsb1");
    expect(Object.keys(lsb1).sort()).toEqual(["SealedSecretError", "bindingAad", "kidOf", "openSealedSecret"]);
    // Neither module that opens envelopes can make one: no cipher besides the AES-GCM decipher, and no key generation.
    for (const file of ["src/lib/governance/lsb1.ts", "src/lib/governance/hpke.ts"]) {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      expect({ file, seals: /createCipheriv|generateKeyPair|\.encrypt\(|\bseal[A-Z(]/.test(source) }).toEqual({
        file,
        seals: false,
      });
    }
  });

  test("an envelope that does not have the lsb1 format fails with FORMAT", () => {
    const { publicKey, kid, keyring } = recipientKey();
    const envelope = sealSecret(publicKey, BINDING, CREDENTIAL);
    const [, , enc, ciphertext] = envelope.split(".");
    const malformed = [
      "",
      envelope.replace(/^lsb1/, "lsb2"),
      `LSB1.${kid}.${enc}.${ciphertext}`,
      `lsb1.${"A".repeat(16)}.${enc}.${ciphertext}`,
      `lsb1.${kid.slice(1)}.${enc}.${ciphertext}`,
      `lsb1.${kid}.${enc.slice(1)}.${ciphertext}`,
      `lsb1.${kid}.${enc}A.${ciphertext}`,
      `lsb1.${kid}.${enc}.${ciphertext.slice(0, 21)}`,
      `lsb1.${kid}.${enc}=.${ciphertext}`,
      `lsb1.${kid}.${enc}.${ciphertext}+`,
      `${envelope}.${ciphertext}`,
      ` ${envelope}`,
      `${envelope}\n`,
      // The pattern admits these, but neither is the one base64url encoding of any bytes: 43 characters carry 258
      // bits for 256, and 25 characters a dangling 6.
      `lsb1.${kid}.${nudgeLast(enc)}.${ciphertext}`,
      `lsb1.${kid}.${enc}.${"A".repeat(25)}`,
    ];
    // 32 bytes leave the last of 43 characters 4 bits and two zero bits, so it is every fourth symbol of the alphabet.
    expect(enc).toMatch(/[AEIMQUYcgkosw048]$/);
    for (const text of malformed)
      expect({ text, code: codeOf(() => openSealedSecret(keyring, text, BINDING)) }).toEqual({ text, code: "FORMAT" });
  });

  test("an envelope for a kid outside the keyring fails with UNKNOWN_KID", () => {
    const sealedTo = recipientKey();
    const envelope = sealSecret(sealedTo.publicKey, BINDING, CREDENTIAL);
    expect(codeOf(() => openSealedSecret(recipientKey().keyring, envelope, BINDING))).toBe("UNKNOWN_KID");
    expect(codeOf(() => openSealedSecret(new Map(), envelope, BINDING))).toBe("UNKNOWN_KID");
    expect(openSealedSecret(sealedTo.keyring, envelope, BINDING)).toEqual(CREDENTIAL);
  });

  test("a flipped bit anywhere in the ciphertext or tag fails with AUTH_FAILED", () => {
    const { publicKey, kid, keyring } = recipientKey();
    const [, , enc, ciphertext] = sealSecret(publicKey, BINDING, CREDENTIAL).split(".");
    const sealed = Buffer.from(ciphertext, "base64url");
    for (const index of [0, sealed.length - 17, sealed.length - 16, sealed.length - 1]) {
      const changed = Buffer.from(sealed);
      changed[index] ^= 0x80;
      const envelope = `lsb1.${kid}.${enc}.${changed.toString("base64url")}`;
      expect(codeOf(() => openSealedSecret(keyring, envelope, BINDING))).toBe("AUTH_FAILED");
    }
  });

  test("a plaintext that is not a JSON object of string credential keys within 65536 bytes fails with PLAINTEXT_INVALID", () => {
    const { publicKey, keyring } = recipientKey();
    const open = (secret: Readonly<Record<string, unknown>> | Uint8Array) =>
      openSealedSecret(keyring, sealSecret(publicKey, BINDING, secret), BINDING);

    // `{"user":""}` is 11 bytes, so these hold 65536 and 65537 bytes; U+00E9 is two bytes in UTF-8.
    const exactly = { user: "a".repeat(PLAINTEXT_MAX_BYTES - 11) };
    const invalid: (Readonly<Record<string, unknown>> | Uint8Array)[] = [
      // Not UTF-8 inside an admitted value: a lenient decoder would open it as U+FFFD.
      Buffer.concat([Buffer.from('{"user":"'), Buffer.from([0xff]), Buffer.from('"}')]),
      Buffer.from("user=reader"),
      // A UTF-8 byte order mark before `{}`: JSON text has none, and the decoder keeps it rather than strip it.
      Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]),
      Buffer.from("[]"),
      Buffer.from('"reader"'),
      Buffer.from("null"),
      Buffer.from("42"),
      { user: 42 },
      { user: null },
      { user: ["reader"] },
      { ssl: { clientKey: "x" } },
      { user: "reader", host: "db.example.internal" },
      JSON.parse('{"__proto__":"x"}'),
      { user: "a".repeat(PLAINTEXT_MAX_BYTES - 11 + 1) },
      { user: String.fromCodePoint(0xe9).repeat((PLAINTEXT_MAX_BYTES - 11 + 1) / 2) },
    ];
    for (const secret of invalid) expect(codeOf(() => open(secret))).toBe("PLAINTEXT_INVALID");

    const everyKey = Object.fromEntries(PLAINTEXT_KEYS.map((key) => [key, `${key} value`]));
    expect(open(everyKey)).toEqual(everyKey);
    expect(open({})).toEqual({});
    expect(open(exactly)).toEqual(exactly);
    expect(open(Buffer.from(' { "user" : "reader" } '))).toEqual({ user: "reader" });
  });

  test("the test sealer's Encap is the CFRG one: sealing with skEm to pkRm carries its enc, and skRm opens it", () => {
    const envelope = sealSecret(bytes(CFRG.pkRm), BINDING, CREDENTIAL, bytes(CFRG.skEm));
    const [, kid, enc] = envelope.split(".");
    expect(kid).toBe("69df8d73e7407153");
    expect(Buffer.from(enc, "base64url").toString("hex")).toBe(CFRG.enc);
    // A fixed ephemeral key makes the envelope deterministic; without one, every seal draws a fresh key.
    expect(sealSecret(bytes(CFRG.pkRm), BINDING, CREDENTIAL, bytes(CFRG.skEm))).toBe(envelope);
    expect(sealSecret(bytes(CFRG.pkRm), BINDING, CREDENTIAL)).not.toBe(envelope);
    expect(openSealedSecret(new Map([[kid, x25519PrivateKey(bytes(CFRG.skRm))]]), envelope, BINDING)).toEqual(
      CREDENTIAL,
    );
  });
});

describe("kidOf", () => {
  test("is the lowercase hex of the first 8 bytes of the SHA-256 of the raw 32-byte public key", () => {
    expect(kidOf(bytes(CFRG.pkRm))).toBe("69df8d73e7407153");
  });

  test("refuses a public key that is not 32 bytes", () => {
    expect(() => kidOf(Buffer.alloc(31))).toThrow("An X25519 public key is 32 bytes, not 31");
    expect(() => kidOf(Buffer.alloc(33))).toThrow("An X25519 public key is 32 bytes, not 33");
  });
});

describe("bindingAad", () => {
  test("is the UTF-8 of the JCS object {c, d, e, k, l, s}, with d the base64url SHA-256 of the canonical definition", () => {
    // The canary binding of spec 8.4: d is base64url(SHA-256("{}")).
    const canary: SecretBinding = { connectionId: "canary", level: "read", engine: "canary", definition: {} };
    expect(bindingAad(canary, "0123456789abcdef").toString("utf8")).toBe(
      '{"c":"canary","d":"RBNvo1WzZ4oRRq0W9-hknpT7T8If536DEMBg9hyq_4o","e":"canary","k":"0123456789abcdef","l":"read","s":"lsb1"}',
    );
    // d hashes {"database":"app","host":"db.example.internal","port":5432,"ssl":{"mode":"verify-full","rejectUnauthorized":true}}.
    expect(bindingAad({ ...BINDING, level: "write" }, "fedcba9876543210").toString("utf8")).toBe(
      '{"c":"5b0f3c1e-8a4d-4f7e-9c2b-1d6e0a7f3b94","d":"Ybpz8oMfyie-eKckDY2H1ZGdBkeAiZvDRbjY8XQ9ets","e":"postgres","k":"fedcba9876543210","l":"write","s":"lsb1"}',
    );
  });

  test("a definition outside the values of spec 8.2 is the caller's error, not the envelope's", () => {
    // Rows are admitted before their envelopes are opened (spec 7.7), so this is a fault in Studio and stays loud.
    const { publicKey, keyring } = recipientKey();
    const envelope = sealSecret(publicKey, BINDING, CREDENTIAL);
    const fractional: SecretBinding = { ...BINDING, definition: { ...BINDING.definition, port: 1.5 } };
    expect(() => bindingAad(fractional, "0123456789abcdef")).toThrow(CanonicalJsonError);
    expect(() => openSealedSecret(keyring, envelope, fractional)).toThrow(CanonicalJsonError);
  });
});
