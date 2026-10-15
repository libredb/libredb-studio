/**
 * HPKE (RFC 9180) as `lsb1` envelopes use it (docs/GOVERNANCE.md#sealed-credentials-lsb1): base mode with
 * DHKEM(X25519, HKDF-SHA256) `0x0020`, HKDF-SHA256 `0x0001` and AES-256-GCM `0x0002`, single shot and without a PSK.
 *
 * It uses `node:crypto` alone (X25519 `diffieHellman`, HMAC-SHA256 for HKDF and the AES-256-GCM decipher), so it runs
 * the same on Node, which serves Studio's image, and on Bun, which runs its tests; Bun has no ChaCha20-Poly1305, which
 * is why the AEAD is AES-256-GCM. tests/unit/lib/governance/hpke.test.ts checks it byte for byte against the CFRG test
 * vector of this suite.
 *
 * Studio only opens: a control plane seals to Studio's public key, and only Studio holds the private keys. So this
 * module has Decap and a single-shot open at sequence 0, and nothing that encrypts or makes a key. The test sealer in
 * tests/helpers/governance/lsb1-seal.ts builds the other half on the key schedule exported here.
 */
import {
  createDecipheriv,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  type KeyObject,
} from "node:crypto";
import type { ENVELOPE_CODES } from "./contract";

/** Why a sealed secret did not open (docs/GOVERNANCE.md#sealed-credentials-lsb1). */
export type EnvelopeCode = (typeof ENVELOPE_CODES)[number];

/**
 * Why a sealed secret did not open. The message is the code and nothing else, so no key material, envelope text or
 * plaintext reaches a log through it.
 */
export class SealedSecretError extends Error {
  constructor(readonly code: EnvelopeCode) {
    super(`The sealed secret did not open: ${code}`);
    this.name = "SealedSecretError";
  }
}

/** I2OSP(value, 2) of RFC 9180: the two-byte big-endian encoding. */
function twoBytes(value: number): Buffer {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
}

const KEM_ID = 0x0020;
const KDF_ID = 0x0001;
const AEAD_ID = 0x0002;
const MODE_BASE = 0x00;

/** Nsecret, Nenc, Npk and Nsk of DHKEM(X25519, HKDF-SHA256). */
const X25519_BYTES = 32;
/** Nh of HKDF-SHA256. */
const HASH_BYTES = 32;
/** Nk, Nn and Nt of AES-256-GCM. */
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const EMPTY = Buffer.alloc(0);
const VERSION_LABEL = Buffer.from("HPKE-v1", "utf8");
const KEM_SUITE_ID = Buffer.concat([Buffer.from("KEM", "utf8"), twoBytes(KEM_ID)]);
const HPKE_SUITE_ID = Buffer.concat([
  Buffer.from("HPKE", "utf8"),
  twoBytes(KEM_ID),
  twoBytes(KDF_ID),
  twoBytes(AEAD_ID),
]);

/** The DER that wraps a raw X25519 key as PKCS #8 and as SubjectPublicKeyInfo (RFC 8410), so node:crypto imports it. */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

/** An X25519 private key from its raw 32 bytes, the form a keyring file holds (docs/GOVERNANCE.md#keyring). */
export function x25519PrivateKey(raw: Uint8Array): KeyObject {
  if (raw.length !== X25519_BYTES) {
    throw new RangeError(`An X25519 private key is ${X25519_BYTES} bytes, not ${raw.length}`);
  }
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, raw]), format: "der", type: "pkcs8" });
}

/** An X25519 public key from its raw 32 bytes, the form of an `enc` and of a control plane's sealing key. */
export function x25519PublicKey(raw: Uint8Array): KeyObject {
  if (raw.length !== X25519_BYTES) {
    throw new RangeError(`An X25519 public key is ${X25519_BYTES} bytes, not ${raw.length}`);
  }
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });
}

/** The raw 32 bytes of the public key that belongs to an X25519 private key. */
export function x25519RawPublicKey(privateKey: KeyObject): Buffer {
  return createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(SPKI_PREFIX.length);
}

/** LabeledExtract of RFC 9180 section 4: HKDF-Extract of `"HPKE-v1" || suite_id || label || ikm` under `salt`. */
function labeledExtract(suiteId: Buffer, salt: Uint8Array, label: string, ikm: Uint8Array): Buffer {
  return createHmac("sha256", salt).update(VERSION_LABEL).update(suiteId).update(label, "utf8").update(ikm).digest();
}

/**
 * LabeledExpand of RFC 9180 section 4: HKDF-Expand (RFC 5869) of `prk` to `length` bytes, with the info
 * `I2OSP(length, 2) || "HPKE-v1" || suite_id || label || info`.
 */
function labeledExpand(suiteId: Buffer, prk: Uint8Array, label: string, info: Uint8Array, length: number): Buffer {
  const labeledInfo = Buffer.concat([twoBytes(length), VERSION_LABEL, suiteId, Buffer.from(label, "utf8"), info]);
  const blocks: Buffer[] = [];
  let previous = EMPTY;
  for (let counter = 1; counter <= Math.ceil(length / HASH_BYTES); counter++) {
    previous = createHmac("sha256", prk).update(previous).update(labeledInfo).update(Buffer.of(counter)).digest();
    blocks.push(previous);
  }
  return Buffer.concat(blocks).subarray(0, length);
}

/** The Diffie-Hellman result, or null when the runtime refuses to compute one. */
function diffieHellmanOrNull(privateKey: KeyObject, publicKey: KeyObject): Buffer | null {
  try {
    return diffieHellman({ privateKey, publicKey });
  } catch {
    return null;
  }
}

/**
 * DH(skR, pkE) of DHKEM(X25519). RFC 9180 section 7.1.4 makes the recipient refuse an all-zero result, which a public
 * key of small order gives: OpenSSL and BoringSSL refuse it themselves, each with an error of its own, so a refused
 * result and an all-zero one are both LOW_ORDER_POINT.
 */
function x25519(privateKey: KeyObject, publicKey: Uint8Array): Buffer {
  const shared = diffieHellmanOrNull(privateKey, x25519PublicKey(publicKey));
  if (shared === null || shared.every((byte) => byte === 0)) throw new SealedSecretError("LOW_ORDER_POINT");
  return shared;
}

/** ExtractAndExpand of DHKEM(X25519, HKDF-SHA256): the KEM shared secret from a DH result and `enc || pkR`. */
export function extractAndExpand(dh: Uint8Array, kemContext: Uint8Array): Buffer {
  const eaePrk = labeledExtract(KEM_SUITE_ID, EMPTY, "eae_prk", dh);
  return labeledExpand(KEM_SUITE_ID, eaePrk, "shared_secret", kemContext, X25519_BYTES);
}

/** Decap of DHKEM(X25519, HKDF-SHA256): the shared secret the holder of `recipientPrivateKey` derives from `enc`. */
export function decap(enc: Uint8Array, recipientPrivateKey: KeyObject): Buffer {
  const dh = x25519(recipientPrivateKey, enc);
  return extractAndExpand(dh, Buffer.concat([enc, x25519RawPublicKey(recipientPrivateKey)]));
}

/** What the key schedule gives a single-shot open: the AEAD key, and the base nonce that is the nonce of sequence 0. */
export interface ScheduledKeys {
  readonly key: Buffer;
  readonly baseNonce: Buffer;
}

/** KeySchedule of RFC 9180 section 5.1 in base mode, whose PSK and PSK id are empty. */
export function keySchedule(sharedSecret: Uint8Array, info: Uint8Array): ScheduledKeys {
  const pskIdHash = labeledExtract(HPKE_SUITE_ID, EMPTY, "psk_id_hash", EMPTY);
  const infoHash = labeledExtract(HPKE_SUITE_ID, EMPTY, "info_hash", info);
  const context = Buffer.concat([Buffer.of(MODE_BASE), pskIdHash, infoHash]);
  const secret = labeledExtract(HPKE_SUITE_ID, sharedSecret, "secret", EMPTY);
  return {
    key: labeledExpand(HPKE_SUITE_ID, secret, "key", context, KEY_BYTES),
    baseNonce: labeledExpand(HPKE_SUITE_ID, secret, "base_nonce", context, NONCE_BYTES),
  };
}

/** The inputs of a single-shot open. */
export interface BaseOpening {
  readonly recipientPrivateKey: KeyObject;
  readonly enc: Uint8Array;
  readonly info: Uint8Array;
  readonly aad: Uint8Array;
  /** The AES-256-GCM ciphertext followed by its 16-byte tag. */
  readonly ciphertext: Uint8Array;
}

/**
 * Single-shot open in base mode: Decap, the key schedule, and AES-256-GCM at sequence 0, whose nonce is the base
 * nonce. A ciphertext that does not authenticate under that key, nonce and `aad` fails with AUTH_FAILED.
 */
export function openBase(opening: BaseOpening): Buffer {
  const { key, baseNonce } = keySchedule(decap(opening.enc, opening.recipientPrivateKey), opening.info);
  const { aad, ciphertext } = opening;
  if (ciphertext.length < TAG_BYTES) throw new SealedSecretError("AUTH_FAILED");
  const decipher = createDecipheriv("aes-256-gcm", key, baseNonce, { authTagLength: TAG_BYTES });
  decipher.setAAD(aad);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - TAG_BYTES));
  const body = decipher.update(ciphertext.subarray(0, ciphertext.length - TAG_BYTES));
  try {
    return Buffer.concat([body, decipher.final()]);
  } catch {
    // GCM decrypts before it authenticates, so an envelope moved to another row yields its real plaintext here.
    body.fill(0);
    throw new SealedSecretError("AUTH_FAILED");
  }
}
