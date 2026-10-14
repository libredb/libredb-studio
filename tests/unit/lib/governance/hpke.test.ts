/**
 * HPKE as `lsb1` envelopes use it (spec 8.1), checked against the CFRG test vector of its suite.
 *
 * tests/fixtures/governance/hpke-cfrg-x25519-sha256-aes256gcm.json is the one entry of the CFRG file for base mode,
 * DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and AES-256-GCM, checked in with its source and the upstream file's SHA-256
 * so that no test fetches anything. Its keys are the published test keys and authenticate nothing.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  decap,
  keySchedule,
  openBase,
  SealedSecretError,
  x25519PrivateKey,
  x25519PublicKey,
  x25519RawPublicKey,
} from "@/lib/governance/hpke";

const ROOT = path.resolve(import.meta.dir, "../../../..");

interface CfrgEncryption {
  aad: string;
  ct: string;
  nonce: string;
  pt: string;
}

interface CfrgSuite {
  mode: number;
  kem_id: number;
  kdf_id: number;
  aead_id: number;
  info: string;
  skRm: string;
  pkRm: string;
  enc: string;
  shared_secret: string;
  key: string;
  base_nonce: string;
  encryptions: CfrgEncryption[];
}

const FIXTURE = JSON.parse(
  readFileSync(path.join(ROOT, "tests/fixtures/governance/hpke-cfrg-x25519-sha256-aes256gcm.json"), "utf8"),
) as { header: { source: string; sourceSha256: string }; suite: CfrgSuite };
const SUITE = FIXTURE.suite;
const [FIRST] = SUITE.encryptions;

const bytes = (hex: string): Buffer => Buffer.from(hex, "hex");
const recipient = () => x25519PrivateKey(bytes(SUITE.skRm));

/** The arguments that open the first CFRG encryption, for a test to change one of them. */
const firstOpening = () => ({
  recipientPrivateKey: recipient(),
  enc: bytes(SUITE.enc),
  info: bytes(SUITE.info),
  aad: bytes(FIRST.aad),
  ciphertext: bytes(FIRST.ct),
});

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

describe("HPKE base mode with DHKEM(X25519, HKDF-SHA256), HKDF-SHA256 and AES-256-GCM", () => {
  test("the fixture is the CFRG suite of lsb1, with its source URL and the upstream file's SHA-256", () => {
    expect(FIXTURE.header.source).toBe(
      "https://raw.githubusercontent.com/cfrg/draft-irtf-cfrg-hpke/master/test-vectors.json",
    );
    expect(FIXTURE.header.sourceSha256).toBe("61fc662f01996cd06d713dacf5e133167bd309a1f329442d53f1e21a47b3ede6");
    expect([SUITE.mode, SUITE.kem_id, SUITE.kdf_id, SUITE.aead_id]).toEqual([0, 0x20, 0x01, 0x02]);
  });

  test("the key schedule reproduces the CFRG key f50b0609186798729ed0564b36ef2ef8044f1f9d05636874d1f46c819c7a669f and base_nonce 151d9929e2449747889bc923", () => {
    const sharedSecret = decap(bytes(SUITE.enc), recipient());
    expect(sharedSecret.toString("hex")).toBe(SUITE.shared_secret);

    const schedule = keySchedule(sharedSecret, bytes(SUITE.info));
    expect(schedule.key.toString("hex")).toBe("f50b0609186798729ed0564b36ef2ef8044f1f9d05636874d1f46c819c7a669f");
    expect(schedule.baseNonce.toString("hex")).toBe("151d9929e2449747889bc923");
    expect(SUITE.key).toBe(schedule.key.toString("hex"));
    expect(SUITE.base_nonce).toBe(schedule.baseNonce.toString("hex"));
  });

  test("opening the first CFRG encryption with skRm returns its plaintext", () => {
    // The first encryption is sequence 0, whose nonce is the base nonce: the only one a single-shot open uses.
    expect(FIRST.nonce).toBe(SUITE.base_nonce);
    const plaintext = openBase(firstOpening());
    expect(plaintext.toString("hex")).toBe(FIRST.pt);
    expect(plaintext.toString("utf8")).toBe("Beauty is truth, truth beauty");
  });

  test("the raw public key of skRm is pkRm", () => {
    expect(x25519RawPublicKey(recipient()).toString("hex")).toBe(SUITE.pkRm);
  });

  test("a changed ciphertext, tag, additional data or info fails with AUTH_FAILED", () => {
    const flipped = (hex: string, index: number): Buffer => {
      const changed = bytes(hex);
      changed[index] ^= 0x01;
      return changed;
    };
    expect(codeOf(() => openBase({ ...firstOpening(), ciphertext: flipped(FIRST.ct, 0) }))).toBe("AUTH_FAILED");
    expect(codeOf(() => openBase({ ...firstOpening(), ciphertext: flipped(FIRST.ct, FIRST.ct.length / 2 - 1) }))).toBe(
      "AUTH_FAILED",
    );
    expect(codeOf(() => openBase({ ...firstOpening(), aad: flipped(FIRST.aad, 0) }))).toBe("AUTH_FAILED");
    expect(codeOf(() => openBase({ ...firstOpening(), info: flipped(SUITE.info, 0) }))).toBe("AUTH_FAILED");
  });

  test("a ciphertext shorter than the 16-byte tag fails with AUTH_FAILED", () => {
    expect(codeOf(() => openBase({ ...firstOpening(), ciphertext: Buffer.alloc(15) }))).toBe("AUTH_FAILED");
    expect(codeOf(() => openBase({ ...firstOpening(), ciphertext: Buffer.alloc(0) }))).toBe("AUTH_FAILED");
  });

  test("an enc that is a point of small order fails with LOW_ORDER_POINT", () => {
    // u = 0 and u = 1 are two of the small-order points of RFC 7748 section 6.1: either gives an all-zero result.
    const one = Buffer.alloc(32);
    one[0] = 1;
    for (const enc of [Buffer.alloc(32), one]) {
      expect(codeOf(() => decap(enc, recipient()))).toBe("LOW_ORDER_POINT");
      expect(codeOf(() => openBase({ ...firstOpening(), enc }))).toBe("LOW_ORDER_POINT");
    }
  });

  test("an error names its code and nothing else", () => {
    const error = new SealedSecretError("AUTH_FAILED");
    expect(error.name).toBe("SealedSecretError");
    expect(error.message).toBe("The sealed secret did not open: AUTH_FAILED");
  });

  test("a raw key that is not 32 bytes is refused, and an enc of another length is not taken for a low-order point", () => {
    expect(() => x25519PrivateKey(Buffer.alloc(31))).toThrow("An X25519 private key is 32 bytes, not 31");
    expect(() => x25519PrivateKey(Buffer.alloc(33))).toThrow("An X25519 private key is 32 bytes, not 33");
    expect(() => x25519PublicKey(Buffer.alloc(31))).toThrow("An X25519 public key is 32 bytes, not 31");
    expect(() => decap(Buffer.alloc(33), recipient())).toThrow(RangeError);
  });
});
