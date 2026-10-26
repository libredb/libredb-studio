import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import { SignJWT } from "jose";
import { SNOWFLAKE_FIELD_SENTENCES } from "@/lib/db/providers/sql/snowflake/account-host";
import {
  jwtClaim,
  keyPairTokenSource,
  type LoadedKey,
  loadPrivateKey,
  patTokenSource,
  readAccessToken,
  SNOWFLAKE_JWT_LIFETIME_S,
  SNOWFLAKE_JWT_RENEW_AFTER_S,
  SNOWFLAKE_KEY_MAX_BYTES,
  SNOWFLAKE_MAX_PBKDF2_ITERATIONS,
  SNOWFLAKE_MAX_SCRYPT_N,
  SNOWFLAKE_MAX_SCRYPT_P,
  SNOWFLAKE_MAX_SCRYPT_R,
  SNOWFLAKE_RSA_MAX_BITS,
  SNOWFLAKE_RSA_MIN_BITS,
  SNOWFLAKE_KEY_SENTENCES,
  SNOWFLAKE_TOKEN_MAX_CHARS,
  SNOWFLAKE_TOKEN_SENTENCES,
} from "@/lib/db/providers/sql/snowflake/auth";
import { SnowflakeError } from "@/lib/db/providers/sql/snowflake/errors";
import {
  crlfForm,
  derInteger,
  derOctets,
  derOid,
  derSequence,
  KEY_TEST_PASSPHRASE,
  outerOnlyPem,
  pbes2Pbkdf2Outer,
  pbes2Pbkdf2Pem,
  pbes2ScryptOuter,
  pbes2ScryptPem,
  pemOf,
  pkcs1Pem,
  pkcs8Pem,
  rsaKey,
  spaceForm,
  strippedForm,
  wideRsaKey,
} from "../../../helpers/snowflake-keys";
import { pemArmour } from "../../../helpers/pem-armour";

const S = SNOWFLAKE_KEY_SENTENCES;

/** The SnowflakeError a load throws, or a failure naming what it did instead. */
function refusal(pem: unknown, passphrase?: unknown): SnowflakeError {
  try {
    loadPrivateKey(pem, passphrase);
  } catch (error) {
    if (error instanceof SnowflakeError) return error;
    throw error;
  }
  throw new Error("the key loaded");
}

function expectRefused(pem: unknown, passphrase: unknown, sentence: string): void {
  const error = refusal(pem, passphrase);
  expect(error.category).toBe("config");
  expect(error.message).toBe(sentence);
}

let rsa: crypto.KeyObject;
let pkcs8: string;
let encryptedPkcs8: string;
let encryptedPkcs1: string;

beforeAll(() => {
  rsa = rsaKey();
  pkcs8 = pkcs8Pem(rsa);
  encryptedPkcs8 = pbes2Pbkdf2Pem(rsa, KEY_TEST_PASSPHRASE, 2_048);
  encryptedPkcs1 = pkcs1Pem(rsa, KEY_TEST_PASSPHRASE);
});

afterEach(() => {
  mock.restore();
});

test("the key and KDF bounds", () => {
  expect(SNOWFLAKE_KEY_MAX_BYTES).toBe(16_384);
  expect([SNOWFLAKE_RSA_MIN_BITS, SNOWFLAKE_RSA_MAX_BITS]).toEqual([2_048, 4_096]);
  expect(SNOWFLAKE_MAX_PBKDF2_ITERATIONS).toEqual({
    sha1: 500_000,
    sha256: 1_000_000,
    sha384: 200_000,
    sha512: 200_000,
  });
  expect([SNOWFLAKE_MAX_SCRYPT_N, SNOWFLAKE_MAX_SCRYPT_R, SNOWFLAKE_MAX_SCRYPT_P]).toEqual([16_384, 8, 1]);
});

describe("the key sentences", () => {
  test("each ends with Nothing was sent, and the empty one is the field's", () => {
    expect(S.keyEmpty).toBe(SNOWFLAKE_FIELD_SENTENCES.keyEmpty);
    expect(S).toMatchObject({
      tooLarge: "The private key is larger than Studio accepts (16 KiB). Nothing was sent.",
      publicKey:
        "This is the public key. Paste the private key; the public key is what you register on the Snowflake user. Nothing was sent.",
      notPem: "The private key is not a PEM key. Paste the key's contents, starting with -----BEGIN. Nothing was sent.",
      kdfCost:
        "This key's encryption is set to cost more work than Studio allows. Re-encrypt it with openssl pkcs8 -topk8 -v2 aes-256-cbc. Nothing was sent.",
      needsPassphrase: "This key is encrypted; enter its passphrase. Nothing was sent.",
      wrongPassphrase: "The passphrase does not open this key. Nothing was sent.",
      unreadable: "Studio could not read this private key. Nothing was sent.",
      short: "Snowflake needs an RSA key of at least 2048 bits. Nothing was sent.",
    });
    expect(S.long(8192)).toBe("Studio accepts RSA keys up to 4096 bits; this key is 8192 bits. Nothing was sent.");
    expect(S.notRsa("ec")).toBe("Studio signs with RSA keys only; this is an EC key. Nothing was sent.");
    expect(S.notRsa("ed25519")).toContain("this is an Ed25519 key.");
    expect(S.notRsa("ed448")).toContain("this is an Ed448 key.");
    expect(S.notRsa("dsa")).toContain("this is a DSA key.");
    expect(S.notRsa("x25519")).toContain("this is a x25519 key.");
    expect(S.notRsa(undefined)).toContain("this is an unknown key.");
  });

  test("the empty key field (4.1)", () => {
    expectRefused(undefined, undefined, S.keyEmpty);
    expectRefused("", undefined, S.keyEmpty);
    expectRefused(42, undefined, S.keyEmpty);
  });
});

describe("SR6 size", () => {
  test("a 17 KiB paste is refused before any parse", () => {
    const createPrivateKey = spyOn(crypto, "createPrivateKey");
    const paste = `${pemArmour("BEGIN")}\n${"A".repeat(17 * 1024)}\n${pemArmour("END")}\n`;
    expectRefused(paste, undefined, S.tooLarge);
    expect(createPrivateKey).not.toHaveBeenCalled();
  });

  test("the bound counts UTF-8 bytes", () => {
    expect(SNOWFLAKE_KEY_MAX_BYTES).toBe(16_384);
    expectRefused("é".repeat(8_193), undefined, S.tooLarge);
    expectRefused("é".repeat(8_192), undefined, S.notPem);
  });
});

describe("SR7 type and modulus", () => {
  test("the unencrypted 16384-bit key passes the size cap and is refused by its length", () => {
    const wide = pkcs8Pem(wideRsaKey(16_384));
    expect(Buffer.byteLength(wide)).toBeLessThanOrEqual(SNOWFLAKE_KEY_MAX_BYTES);
    expectRefused(wide, undefined, S.long(16_384));
  });

  test("a 1024-bit key is short", () => {
    expectRefused(pkcs8Pem(rsaKey(1_024)), undefined, S.short);
  });

  test("a 4096-bit key loads", () => {
    expect(loadPrivateKey(pkcs8Pem(rsaKey(4_096)), undefined).key.asymmetricKeyDetails?.modulusLength).toBe(4_096);
  });

  test("an EC P-256 and an Ed25519 key name their type", () => {
    const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    expectRefused(ec.export({ type: "pkcs8", format: "pem" }), undefined, S.notRsa("ec"));
    const ed = crypto.generateKeyPairSync("ed25519").privateKey;
    expectRefused(ed.export({ type: "pkcs8", format: "pem" }), undefined, S.notRsa("ed25519"));
  });

  test("a public key is refused by name", () => {
    const publicKey = crypto.createPublicKey(rsa);
    expectRefused(publicKey.export({ type: "spki", format: "pem" }), undefined, S.publicKey);
    expectRefused(publicKey.export({ type: "pkcs1", format: "pem" }), undefined, S.publicKey);
  });
});

describe("SR8 the KDF ceiling, read before decryption", () => {
  test.each([
    ["PBKDF2 at 2,000,000 iterations", () => pbes2Pbkdf2Outer(2_000_000)],
    ["PBKDF2 at 500,001 iterations with SHA-1 omitted", () => pbes2Pbkdf2Outer(500_001, null)],
    ["PBKDF2 at 500,001 iterations with SHA-1", () => pbes2Pbkdf2Outer(500_001, "sha1")],
    ["PBKDF2 at 1,000,001 iterations with SHA-256", () => pbes2Pbkdf2Outer(1_000_001, "sha256")],
    ["PBKDF2 at 200,001 iterations with SHA-384", () => pbes2Pbkdf2Outer(200_001, "sha384")],
    ["PBKDF2 at 200,001 iterations with SHA-512", () => pbes2Pbkdf2Outer(200_001, "sha512")],
    ["scrypt N 65,536", () => pbes2ScryptOuter(65_536, 8, 1)],
    ["scrypt r 16 at N 16,384", () => pbes2ScryptOuter(16_384, 16, 1)],
    ["scrypt p 2 at N 16,384", () => pbes2ScryptOuter(16_384, 8, 2)],
    [
      "PBKDF2 at 2,000,000 iterations armoured as PRIVATE KEY",
      () => pbes2Pbkdf2Outer(2_000_000).replace(/ENCRYPTED PRIVATE KEY/g, "PRIVATE KEY"),
    ],
    [
      "scrypt p 2 armoured as PRIVATE KEY",
      () => pbes2ScryptOuter(16_384, 8, 2).replace(/ENCRYPTED PRIVATE KEY/g, "PRIVATE KEY"),
    ],
  ])("%s: the cost sentence, with nothing derived or decrypted", (_name, build) => {
    const pem = build();
    const spies = [spyOn(crypto, "createPrivateKey"), spyOn(crypto, "pbkdf2Sync"), spyOn(crypto, "scryptSync")];
    expectRefused(pem, KEY_TEST_PASSPHRASE, S.kdfCost);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  test.each([
    ["PBES1 (openssl pkcs8 -topk8 -v1 PBE-SHA1-3DES writes PKCS#12's 1.2.840.113549.1.12.1.3)", "1.2.840.113549.1.5.3"],
    ["PKCS#12 PBE", "1.2.840.113549.1.12.1.3"],
  ])("%s: the scheme sentence, not the cost one, with nothing derived (SF-026)", (_name, algorithm) => {
    const spies = [spyOn(crypto, "createPrivateKey"), spyOn(crypto, "pbkdf2Sync"), spyOn(crypto, "scryptSync")];
    // A low count, so the refusal is the scheme's whatever its cost.
    const pem = outerOnlyPem(algorithm, derSequence(derOctets(crypto.randomBytes(8)), derInteger(2_048)));
    expectRefused(pem, KEY_TEST_PASSPHRASE, S.scheme);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  /** A PBES2 structure around random bytes, the KDF and cipher given whole. */
  const pbes2With = (kdf: Buffer, cipher: Buffer) => outerOnlyPem("1.2.840.113549.1.5.13", derSequence(kdf, cipher));
  const aes256 = derSequence(derOid("2.16.840.1.101.3.4.1.42"), derOctets(crypto.randomBytes(16)));
  const pbkdf2 = (...params: Buffer[]) =>
    derSequence(derOid("1.2.840.113549.1.5.12"), derSequence(derOctets(crypto.randomBytes(16)), ...params));

  test.each([
    ["another KDF", () => pbes2With(derSequence(derOid("1.2.3.4"), derSequence()), aes256)],
    ["another cipher", () => pbes2With(pbkdf2(derInteger(2_048)), derSequence(derOid("1.2.840.113549.3.7")))],
    ["another PRF", () => pbes2With(pbkdf2(derInteger(2_048), derSequence(derOid("1.2.840.113549.2.5"))), aes256)],
    [
      "a PBKDF2 salt from another source",
      () =>
        pbes2With(
          derSequence(derOid("1.2.840.113549.1.5.12"), derSequence(derSequence(derOid("1.2.3")), derInteger(2_048))),
          aes256,
        ),
    ],
  ])("%s: the scheme sentence", (_name, build) => {
    const pem = build();
    const createPrivateKey = spyOn(crypto, "createPrivateKey");
    expectRefused(pem, KEY_TEST_PASSPHRASE, S.scheme);
    expect(createPrivateKey).not.toHaveBeenCalled();
  });

  test("a key length in the PBKDF2 parameters is read past", () => {
    const pem = pbes2With(pbkdf2(derInteger(2_000_000), derInteger(32)), aes256);
    expectRefused(pem, KEY_TEST_PASSPHRASE, S.kdfCost);
    const under = pbes2With(pbkdf2(derInteger(2_048), derInteger(32)), aes256);
    // Under the ceiling the reader passes it on, and the random payload does not decrypt: its padding fails, or in
    // about one case of 256 the padding holds and the decoder refuses the plaintext; both read as the wrong passphrase.
    const createPrivateKey = spyOn(crypto, "createPrivateKey");
    expect(sentenceName(refusal(under, KEY_TEST_PASSPHRASE).message)).toBe("wrongPassphrase");
    expect(createPrivateKey).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["the default SHA-1, omitted", null],
    ["SHA-1", "sha1"],
    ["SHA-256", "sha256"],
  ] as const)("PBKDF2 at 2,048 iterations with %s loads", (_name, prf) => {
    const loaded = loadPrivateKey(pbes2Pbkdf2Pem(rsa, KEY_TEST_PASSPHRASE, 2_048, prf), KEY_TEST_PASSPHRASE);
    expect(loaded.key.asymmetricKeyType).toBe("rsa");
  });

  test.each([
    ["SHA-384", "sha384"],
    ["SHA-512", "sha512"],
  ] as const)("PBKDF2 at 2,048 iterations with %s passes the ceiling", (_name, prf) => {
    const pem = pbes2Pbkdf2Pem(rsa, KEY_TEST_PASSPHRASE, 2_048, prf);
    const createPrivateKey = spyOn(crypto, "createPrivateKey");
    // Bun's BoringSSL has no SHA-384 or SHA-512 PRF for PBES2; key-runtimes.test.ts proves the key loads on Node.
    expectRefused(pem, KEY_TEST_PASSPHRASE, S.unreadable);
    expect(createPrivateKey).toHaveBeenCalledTimes(1);
  });

  test("scrypt N 16,384 passes the ceiling", () => {
    const pem = pbes2ScryptPem(rsa, KEY_TEST_PASSPHRASE, 16_384, 8, 1);
    const createPrivateKey = spyOn(crypto, "createPrivateKey");
    // Bun's BoringSSL refuses scrypt PBES2; key-runtimes.test.ts proves the key loads on Node.
    expectRefused(pem, KEY_TEST_PASSPHRASE, S.unreadable);
    expect(createPrivateKey).toHaveBeenCalledTimes(1);
  });

  test("a block of another kind is named by its label (SF-026)", () => {
    for (const label of ["CERTIFICATE", "TRUSTED CERTIFICATE", "X509 CERTIFICATE"]) {
      expectRefused(pemOf(label, crypto.randomBytes(300)), undefined, S.certificate);
    }
    const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    expectRefused(ec.export({ type: "sec1", format: "pem" }), undefined, S.notRsa("ec"));
    expectRefused(pemOf("DSA PRIVATE KEY", crypto.randomBytes(300)), undefined, S.notRsa("dsa"));
    expectRefused(pemOf("OPENSSH PRIVATE KEY", crypto.randomBytes(300)), undefined, S.otherBlock);
  });

  test("a key cut before its END line is the truncated sentence, whatever the body holds (SF-026)", () => {
    expectRefused(pkcs8.slice(0, Math.floor(pkcs8.length / 2)), undefined, S.truncated);
    expectRefused(pkcs8.split("-----END")[0], undefined, S.truncated);
  });

  test("a truncated DER could not be read", () => {
    const body = pkcs8.split("\n").slice(1, -2).join("");
    expectRefused(pemOf("PRIVATE KEY", Buffer.from(body.slice(0, body.length / 2), "base64")), undefined, S.unreadable);
    const encryptedBody = encryptedPkcs8.split("\n").slice(1, -2).join("");
    const half = Buffer.from(encryptedBody, "base64").subarray(0, 40);
    expectRefused(pemOf("ENCRYPTED PRIVATE KEY", half), KEY_TEST_PASSPHRASE, S.unreadable);
  });

  test("an encrypted DER under an unencrypted label is decided from the DER", () => {
    const relabelled = encryptedPkcs8.replace(/ENCRYPTED PRIVATE KEY/g, "PRIVATE KEY");
    expect(loadPrivateKey(relabelled, KEY_TEST_PASSPHRASE).key.asymmetricKeyType).toBe("rsa");
    expectRefused(relabelled, undefined, S.needsPassphrase);
    const createPrivateKey = spyOn(crypto, "createPrivateKey");
    expectRefused(
      encryptedPkcs8.replace(/ENCRYPTED PRIVATE KEY/g, "RSA PRIVATE KEY"),
      KEY_TEST_PASSPHRASE,
      S.unreadable,
    );
    expectRefused(
      pemOf("PRIVATE KEY", Buffer.from([0x30, 0x80, 0x02, 0x01, 0x00, 0x00, 0x00])),
      undefined,
      S.unreadable,
    );
    expect(createPrivateKey).not.toHaveBeenCalled();
  });

  test.each([
    ["an indefinite length", Buffer.from([0x30, 0x80, 0x00, 0x00])],
    ["a length longer than the input", Buffer.from([0x30, 0x10, 0x30, 0x00])],
    ["a length of five bytes", Buffer.from([0x30, 0x85, 0x00, 0x00, 0x00, 0x00, 0x01, 0x00])],
    ["a high tag number", Buffer.from([0x30, 0x03, 0x1f, 0x01, 0x00])],
    [
      "trailing bytes",
      Buffer.concat([
        derSequence(derSequence(derOid("1.2.840.113549.1.5.13")), derOctets(Buffer.from([1]))),
        Buffer.from([0]),
      ]),
    ],
    ["an OCTET STRING outside", derOctets(Buffer.from([1, 2, 3]))],
    ["a cut OID", Buffer.from([0x30, 0x07, 0x30, 0x03, 0x06, 0x01, 0x81, 0x04, 0x00])],
    ["an empty OID", Buffer.from([0x30, 0x06, 0x30, 0x02, 0x06, 0x00, 0x04, 0x00])],
    ["a missing data part", derSequence(derSequence(derOid("1.2.840.113549.1.5.13")))],
    [
      "an empty PBKDF2 iteration count",
      derSequence(
        derSequence(
          derOid("1.2.840.113549.1.5.13"),
          derSequence(
            derSequence(
              derOid("1.2.840.113549.1.5.12"),
              derSequence(derOctets(Buffer.alloc(8)), Buffer.from([0x02, 0x00])),
            ),
            derSequence(derOid("2.16.840.1.101.3.4.1.42"), derOctets(Buffer.alloc(16))),
          ),
        ),
        derOctets(Buffer.alloc(32)),
      ),
    ],
  ])("a DER with %s could not be read", (_name, der) => {
    const createPrivateKey = spyOn(crypto, "createPrivateKey");
    expectRefused(pemOf("ENCRYPTED PRIVATE KEY", der), KEY_TEST_PASSPHRASE, S.unreadable);
    expect(createPrivateKey).not.toHaveBeenCalled();
  });

  test("a deep nesting is refused without recursion", () => {
    let der = derOctets(Buffer.alloc(1));
    for (let depth = 0; depth < 500; depth++) der = derSequence(der);
    expectRefused(pemOf("ENCRYPTED PRIVATE KEY", der), KEY_TEST_PASSPHRASE, S.unreadable);
  });
});

/** The name of a key sentence, for a case where two outcomes are both right. */
function sentenceName(message: string): string | undefined {
  return Object.entries(S).find(([, value]) => value === message)?.[0];
}

describe("SR11 no path, and every pasted form", () => {
  test("a path is not a PEM key, and no file is read", () => {
    const readFileSync = spyOn(fs, "readFileSync");
    expectRefused("/etc/passwd", undefined, S.notPem);
    expect(readFileSync).not.toHaveBeenCalled();
  });

  test.each([
    ["the space form of PKCS#8", () => spaceForm(pkcs8), undefined],
    ["the stripped form of PKCS#8", () => strippedForm(pkcs8), undefined],
    ["the CRLF form with a trailing blank line", () => crlfForm(pkcs8), undefined],
    ["the space form of an encrypted PKCS#8", () => spaceForm(encryptedPkcs8), KEY_TEST_PASSPHRASE],
    ["the space form of a legacy encrypted PKCS#1", () => spaceForm(encryptedPkcs1), KEY_TEST_PASSPHRASE],
    ["the stripped form of a legacy encrypted PKCS#1", () => strippedForm(encryptedPkcs1), KEY_TEST_PASSPHRASE],
    ["the CRLF form of a legacy encrypted PKCS#1", () => crlfForm(encryptedPkcs1), KEY_TEST_PASSPHRASE],
    ["an unencrypted PKCS#1", () => pkcs1Pem(rsa), undefined],
    ["text around the block", () => `key for svc:\n${pkcs8}\nthanks`, undefined],
  ])("%s loads", (_name, build, passphrase) => {
    const loaded = loadPrivateKey(build(), passphrase);
    expect(loaded.fingerprint.text).toBe(loadPrivateKey(pkcs8, undefined).fingerprint.text);
  });

  test.each([
    ["two PEM blocks in one paste", () => `${pemOf("CERTIFICATE", crypto.randomBytes(64))}${pkcs8}`],
    ["two key blocks", () => `${pkcs8}${pkcs8}`],
  ])("%s is the one-block sentence", (_name, build) => {
    expectRefused(build(), undefined, S.manyBlocks);
  });

  test.each([
    ["an END before its BEGIN", () => `${pemArmour("END")}\n${pemArmour("BEGIN")}\n`],
    ["labels that do not match", () => pkcs8.replace("END PRIVATE KEY", "END RSA PRIVATE KEY")],
    ["a body that is not base64", () => pkcs8.replace(/\n[A-Za-z0-9+/]{10}/, "\n!!!!!!!!!!")],
    ["an empty body", () => `${pemArmour("BEGIN")}\n${pemArmour("END")}\n`],
    ["a header the form does not have", () => pkcs8.replace("-----\n", "-----\nComment: x\n")],
  ])("%s could not be read: the armour is there, the block is broken", (_name, build) => {
    expectRefused(build(), undefined, S.unreadable);
  });
});

describe("the passphrase", () => {
  test.each([
    ["an encrypted PKCS#8", () => encryptedPkcs8],
    ["a legacy encrypted PKCS#1", () => encryptedPkcs1],
  ])("%s with no passphrase, an empty one or a wrong one", (_name, build) => {
    expectRefused(build(), undefined, S.needsPassphrase);
    expectRefused(build(), "", S.needsPassphrase);
    expectRefused(build(), 7, S.needsPassphrase);
    expectRefused(build(), "not-the-passphrase", S.wrongPassphrase);
    expect(loadPrivateKey(build(), KEY_TEST_PASSPHRASE).key.asymmetricKeyType).toBe("rsa");
  });

  test.each([
    ["a missing-passphrase code", "ERR_MISSING_PASSPHRASE", KEY_TEST_PASSPHRASE, "needsPassphrase"],
    ["a wrong-passphrase code with no passphrase", "ERR_OSSL_BAD_DECRYPT", undefined, "unreadable"],
    ["a wrong-passphrase code with a passphrase", "ERR_OSSL_EVP_BAD_DECRYPT", "p", "wrongPassphrase"],
    ["another code", "ERR_OSSL_X", "p", "unreadable"],
    ["no code", undefined, "p", "unreadable"],
  ])("the runtime's %s maps by the table, never its message", (_name, code, passphrase, name) => {
    spyOn(crypto, "createPrivateKey").mockImplementation(() => {
      throw Object.assign(new Error("runtime text SECRET"), code === undefined ? {} : { code });
    });
    const error = refusal(pkcs8, passphrase);
    expect(sentenceName(error.message)).toBe(name);
    expect(error.message).not.toContain("SECRET");
  });

  // A wrong passphrase whose decryption happens to end in valid padding reaches the decoder, which refuses the bytes
  // with its own code: OpenSSL 3, OpenSSL 4 and Bun's BoringSSL spell it differently.
  test.each([
    ["OpenSSL 4's ASN.1 wrong-tag code", "ERR_OSSL_ASN1_WRONG_TAG"],
    ["OpenSSL 4's ASN.1 header-too-long code", "ERR_OSSL_ASN1_HEADER_TOO_LONG"],
    ["OpenSSL 4's ASN.1 too-long code", "ERR_OSSL_ASN1_TOO_LONG"],
    ["OpenSSL 4's ASN.1 sequence-not-constructed code", "ERR_OSSL_ASN1_SEQUENCE_NOT_CONSTRUCTED"],
    ["Node's decoder code", "ERR_OSSL_UNSUPPORTED"],
    ["Bun's decoder code", "ERR_OSSL_EVP_DECODE_ERROR"],
  ])("%s reads as the wrong passphrase on an encrypted key given one, and as unreadable otherwise", (_name, code) => {
    spyOn(crypto, "createPrivateKey").mockImplementation(() => {
      throw Object.assign(new Error("runtime text SECRET"), { code });
    });
    expect(sentenceName(refusal(encryptedPkcs8, "p").message)).toBe("wrongPassphrase");
    expect(sentenceName(refusal(encryptedPkcs1, "p").message)).toBe("wrongPassphrase");
    expect(sentenceName(refusal(pkcs8, "p").message)).toBe("unreadable");
    expect(sentenceName(refusal(encryptedPkcs8, undefined).message)).toBe("needsPassphrase");
  });

  test("a thrown non-object maps to the unreadable sentence", () => {
    spyOn(crypto, "createPrivateKey").mockImplementation(() => {
      throw "text";
    });
    expect(refusal(pkcs8, undefined).message).toBe(S.unreadable);
  });
});

describe("SR9 the result and the fingerprint", () => {
  /** Every string reachable from a value through own properties, KeyObject internals aside. */
  function strings(value: unknown, seen = new Set<unknown>()): string[] {
    if (typeof value === "string") return [value];
    if (value === null || typeof value !== "object" || seen.has(value)) return [];
    seen.add(value);
    return Reflect.ownKeys(value).flatMap((key) => strings((value as Record<PropertyKey, unknown>)[key], seen));
  }

  test("the result is exactly the key and the fingerprint, and holds no PEM text or passphrase", () => {
    const loaded: LoadedKey = loadPrivateKey(encryptedPkcs8, KEY_TEST_PASSPHRASE);
    expect(Object.keys(loaded).sort()).toEqual(["fingerprint", "key"]);
    expect(Object.keys(loaded.fingerprint).sort()).toEqual(["hex8", "publicKeyBody", "text"]);
    const body = encryptedPkcs8.split("\n").slice(1, -2).join("");
    const plainBody = pkcs8.split("\n").slice(1, -2).join("");
    for (const text of strings(loaded)) {
      expect(text).not.toContain(KEY_TEST_PASSPHRASE);
      for (const line of encryptedPkcs8.split("\n").filter((l) => l.length === 64)) {
        expect(text).not.toContain(line);
      }
      expect(text).not.toContain(body);
      expect(text).not.toContain(plainBody);
    }
  });

  test("the fingerprint is SHA-256 over the SPKI DER", () => {
    const loaded = loadPrivateKey(pkcs8, undefined);
    const spki = crypto.createPublicKey(rsa).export({ type: "spki", format: "der" });
    const digest = crypto.createHash("sha256").update(spki);
    const bytes = digest.digest();
    expect(loaded.fingerprint.text).toBe(`SHA256:${bytes.toString("base64")}`);
    expect(loaded.fingerprint.hex8).toBe(bytes.toString("hex").slice(0, 8));
    expect(loaded.fingerprint.publicKeyBody).toBe(spki.toString("base64"));
    expect(loaded.key.type).toBe("private");
  });
});

describe("keyPairTokenSource (SR21)", () => {
  const part = (token: string, index: number) =>
    JSON.parse(Buffer.from(token.split(".")[index], "base64url").toString());
  const claims = (token: string) => part(token, 1);
  let loaded: LoadedKey;
  beforeAll(() => {
    loaded = loadPrivateKey(pkcs8, undefined);
  });

  test("the constants", () => {
    expect(SNOWFLAKE_JWT_LIFETIME_S).toBe(900);
    expect(SNOWFLAKE_JWT_RENEW_AFTER_S).toBe(600);
  });

  test("the claim is the account and the login name upper-cased", () => {
    expect(jwtClaim("myorg-my_account", "studio_svc")).toEqual({ account: "MYORG-MY_ACCOUNT", user: "STUDIO_SVC" });
  });

  test("claims, header, integer seconds and a 900 s lifetime", async () => {
    const clock = Date.UTC(2026, 9, 12, 6, 0, 0) + 999;
    const source = keyPairTokenSource(loaded, jwtClaim("myorg-my_account", "studio_svc"), () => clock);
    expect(source.tokenType).toBe("KEYPAIR_JWT");
    const token = await source.token();
    expect(part(token, 0)).toEqual({ alg: "RS256", typ: "JWT" });
    const c = claims(token);
    expect(Object.keys(c).sort()).toEqual(["exp", "iat", "iss", "sub"]);
    expect(c.sub).toBe("MYORG-MY_ACCOUNT.STUDIO_SVC");
    expect(c.iss).toBe(`MYORG-MY_ACCOUNT.STUDIO_SVC.${loaded.fingerprint.text}`);
    expect(Number.isInteger(c.iat) && Number.isInteger(c.exp)).toBe(true);
    expect(c.exp - c.iat).toBe(900);
    expect(c.iat).toBe(Math.floor(clock / 1000));
    const publicKey = crypto.createPublicKey(loaded.key);
    const [header, payload, signature] = token.split(".");
    const verified = crypto.verify(
      "sha256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
    expect(verified).toBe(true);
  });

  test("9 min 59 s reuses the token, 10 min 1 s signs a new one", async () => {
    let clock = 1_800_000_000_000;
    const source = keyPairTokenSource(loaded, jwtClaim("a", "u"), () => clock);
    const first = await source.token();
    clock += 599_000;
    expect(await source.token()).toBe(first);
    clock += 2_000;
    const second = await source.token();
    expect(second).not.toBe(first);
    expect(claims(second).iat - claims(first).iat).toBe(601);
  });

  test("exactly 600 s after iat signs a new one", async () => {
    let clock = 1_800_000_000_000;
    const source = keyPairTokenSource(loaded, jwtClaim("a", "u"), () => clock);
    const first = await source.token();
    clock += 600_000;
    expect(claims(await source.token()).iat - claims(first).iat).toBe(600);
  });

  test("idle from 1 min to 25 min signs nothing until the next request, which signs one", async () => {
    let clock = 1_800_000_000_000;
    const sign = spyOn(SignJWT.prototype, "sign");
    const source = keyPairTokenSource(loaded, jwtClaim("a", "u"), () => clock);
    const first = await source.token();
    clock += 60_000;
    expect(await source.token()).toBe(first);
    expect(sign).toHaveBeenCalledTimes(1);
    clock += 24 * 60_000;
    expect(sign).toHaveBeenCalledTimes(1);
    const next = await source.token();
    expect(next).not.toBe(first);
    expect(sign).toHaveBeenCalledTimes(2);
    expect(await source.token()).toBe(next);
    expect(sign).toHaveBeenCalledTimes(2);
  });

  test("twenty concurrent first requests share one signature", async () => {
    const sign = spyOn(SignJWT.prototype, "sign");
    const source = keyPairTokenSource(loaded, jwtClaim("a", "u"), () => 1_800_000_000_000);
    const tokens = await Promise.all(Array.from({ length: 20 }, () => source.token()));
    expect(new Set(tokens).size).toBe(1);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  test("a clock that goes back reuses the token", async () => {
    let clock = 1_800_000_000_000;
    const sign = spyOn(SignJWT.prototype, "sign");
    const source = keyPairTokenSource(loaded, jwtClaim("a", "u"), () => clock);
    const first = await source.token();
    clock -= 3_600_000;
    expect(await source.token()).toBe(first);
    expect(sign).toHaveBeenCalledTimes(1);
  });

  test("a failed signing is not kept: the next request signs again", async () => {
    const sign = spyOn(SignJWT.prototype, "sign").mockImplementationOnce(() => Promise.reject(new Error("no")));
    const source = keyPairTokenSource(loaded, jwtClaim("a", "u"), () => 1_800_000_000_000);
    const both = await Promise.allSettled([source.token(), source.token()]);
    expect(both.map(({ status }) => status)).toEqual(["rejected", "rejected"]);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(claims(await source.token()).sub).toBe("A.U");
    expect(sign).toHaveBeenCalledTimes(2);
  });

  test("a PAT is its own bearer", async () => {
    const source = patTokenSource("pat-x");
    expect(source.tokenType).toBe("PROGRAMMATIC_ACCESS_TOKEN");
    expect(await source.token()).toBe("pat-x");
  });
});

describe("readAccessToken: the token's intake (SF-015)", () => {
  const refusal = (token: string): unknown => {
    try {
      readAccessToken(token);
    } catch (error) {
      return error;
    }
    return null;
  };

  for (const [label, raw] of [
    ["a trailing line feed", "pat-abc\n"],
    ["CR LF around it", "\r\npat-abc\r\n"],
    ["spaces and a tab around it", "  \tpat-abc \t"],
    ["a Bearer prefix, as a curl example writes it", "Bearer pat-abc"],
    ["a lower-case bearer prefix with spaces around", "  bearer   pat-abc \n"],
  ] as const) {
    test(`${label} comes off, and the token is sent`, () => {
      expect(readAccessToken(raw)).toBe("pat-abc");
    });
  }

  test(`a token of ${SNOWFLAKE_TOKEN_MAX_CHARS} characters is read, one longer is refused`, () => {
    expect(readAccessToken("a".repeat(SNOWFLAKE_TOKEN_MAX_CHARS))).toHaveLength(SNOWFLAKE_TOKEN_MAX_CHARS);
    const error = refusal("a".repeat(SNOWFLAKE_TOKEN_MAX_CHARS + 1));
    expect(error).toBeInstanceOf(SnowflakeError);
    expect((error as SnowflakeError).category).toBe("config");
    expect((error as SnowflakeError).message).toBe(SNOWFLAKE_TOKEN_SENTENCES.tooLong);
  });

  for (const [label, raw] of [
    ["a non-Latin-1 letter", "abc\u00e9\u4e2d"],
    ["a line break inside", "pat-\nabc"],
    ["a space inside", "pat abc"],
    ["a control character", "pat\u0001abc"],
  ] as const) {
    test(`${label} is refused as characters a token cannot have`, () => {
      expect((refusal(raw) as SnowflakeError).message).toBe(SNOWFLAKE_TOKEN_SENTENCES.badCharacters);
    });
  }

  test("a value that is only whitespace or a bare prefix is the empty-token refusal", () => {
    expect((refusal(" \r\n ") as SnowflakeError).message).toBe(SNOWFLAKE_FIELD_SENTENCES.tokenEmpty);
    expect((refusal("Bearer  \n") as SnowflakeError).message).toBe(SNOWFLAKE_FIELD_SENTENCES.tokenEmpty);
  });
});

describe("readAccessToken: a key-pair JWT is not an access token (SF-006)", () => {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
  const jwtWith = (payload: unknown): string => `${part({ alg: "RS256", typ: "JWT" })}.${part(payload)}.c2ln`;

  test("a JWT Studio itself signs for a key pair is refused before any socket", async () => {
    const { privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const source = keyPairTokenSource(loadPrivateKey(pem, undefined), jwtClaim("acme", "studio_svc"), () => 0);
    const jwt = await source.token();
    let error: unknown;
    try {
      readAccessToken(jwt);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(SnowflakeError);
    expect((error as SnowflakeError).category).toBe("config");
    expect((error as SnowflakeError).message).toBe(SNOWFLAKE_TOKEN_SENTENCES.keyPairJwt);
  });

  test("an iss with a key fingerprint is the only mark read", () => {
    expect(() => readAccessToken(jwtWith({ iss: "ACME.STUDIO_SVC.SHA256:abc=", sub: "ACME.STUDIO_SVC" }))).toThrow(
      SNOWFLAKE_TOKEN_SENTENCES.keyPairJwt,
    );
  });

  for (const [label, token] of [
    ["a PAT shaped as a JWT, its iss with no fingerprint", jwtWith({ p: "x", iss: "ab:1234", exp: 1 })],
    ["an opaque token", "opaque-access-token"],
    ["three parts whose middle one is not JSON", "a.!!!.c"],
    ["a payload that is not an object", jwtWith(null)],
    ["a payload whose iss is not text", jwtWith({ iss: 7 })],
    ["four parts", `${jwtWith({ iss: "A.U.SHA256:x" })}.d`],
  ] as const) {
    test(`${label} is returned unchanged`, () => {
      expect(readAccessToken(token)).toBe(token);
    });
  }
});
