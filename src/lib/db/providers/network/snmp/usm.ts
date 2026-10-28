/**
 * The User-based Security Model (RFC 3414), written here rather than taken from a library.
 *
 * Three operations and nothing else: turning a passphrase into a key the agent will agree with,
 * putting a digest on a message, and encrypting a scoped PDU. `node:crypto` supplies the
 * primitives, as it does for S3's request signing; what this file supplies is the order the RFC
 * puts them in, which is where implementations differ and where a mistake is silent.
 *
 * WHY NONE OF THIS IS ROLLED BY HAND BEYOND THE ORDER. Every hash and cipher below is a named
 * algorithm from `node:crypto`. The only arithmetic in the file is the key expansion the RFC
 * specifies, which is a loop over a megabyte and not a cryptographic invention.
 *
 * WHAT THIS FILE REFUSES TO GUESS. Where the RFC fixes a width, the width is a constant with its
 * clause beside it, and a value of the wrong width is refused rather than padded or truncated.
 * A digest that is quietly the wrong length authenticates nothing, and the failure of that is
 * invisible: the agent simply does not answer, which over UDP looks like every other silence.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac } from "node:crypto";
import { QueryError } from "@/lib/db/errors";

/**
 * What a USM refusal was, as a value rather than as a sentence.
 *
 * Every one of these reaches the user as a `QueryError`, which carries one code for all of them,
 * so without this field the only thing separating "your passphrase is wrong" from "the clock has
 * drifted" is English prose. A sentence serves the person reading it and serves nothing that
 * branches: the dialog cannot offer to rediscover an engine, and a caller cannot retry only the
 * cases worth retrying. The three refusals below send an operator to three different places,
 * which is exactly why they may not arrive as one.
 */
export type UsmFailure =
  | "passphraseTooShort"
  | "engineIdWidth"
  | "saltWidth"
  | "counterRange"
  | "digestWidth"
  | "digestMismatch"
  | "noPrivacyKey"
  | "outsideWindow"
  | "engineRestarted"
  | "bootsCeiling"
  | "builtWrongWidth";

export class UsmError extends QueryError {
  constructor(
    message: string,
    /** Which refusal this is. Callers branch on this; the sentence is for the person. */
    public readonly failure: UsmFailure,
  ) {
    super(message);
    this.name = "UsmError";
    Object.setPrototypeOf(this, UsmError.prototype);
  }
}

/** RFC 3414 section 6.3.1: the passphrase is expanded to exactly one megabyte before hashing. */
const EXPANDED_BYTES = 1048576;
/** RFC 3414 section 11.2: a passphrase is at least eight characters. */
export const MIN_PASSPHRASE = 8;
/**
 * RFC 3414 section 6.3.2 and RFC 7860 section 4.2.2: the digest carried in the message is
 * truncated to twelve octets, whatever the hash's own width.
 */
export const AUTH_PARAM_BYTES = 12;
/** RFC 3826 section 3.1.2.1: the salt is eight octets and the IV is sixteen. */
export const SALT_BYTES = 8;
const AES_IV_BYTES = 16;
/** RFC 3826 section 3.1.2.1: "The first 128 bits of the localized key" are the AES key. */
const AES_KEY_BYTES = 16;

/** The hashes this provider offers, each with the RFC that requires it. */
export const AUTH_HASHES = {
  /** RFC 3414 section 7. Offered because agents still run it; never chosen by default. */
  sha1: "sha1",
  /** RFC 7860 section 4: an implementation MUST support HMAC-SHA-256. */
  sha256: "sha256",
  sha384: "sha384",
  sha512: "sha512",
} as const;
export type AuthHash = keyof typeof AUTH_HASHES;

/**
 * A passphrase into the key the agent derives from the same passphrase (RFC 3414 appendix A.2).
 *
 * The passphrase is repeated until exactly a megabyte has been hashed. That is not a cost
 * anybody chose for its own sake: it is what makes the derivation slow enough to be worth
 * caching and what every agent does, so a shortcut here produces a key no agent agrees with.
 */
export function passphraseToKey(passphrase: string, hash: AuthHash): Buffer {
  const bytes = Buffer.from(passphrase, "utf8");
  if (bytes.length < MIN_PASSPHRASE) {
    throw new UsmError(
      `a passphrase is at least ${MIN_PASSPHRASE} characters (RFC 3414 section 11.2)`,
      "passphraseTooShort",
    );
  }
  const digest = createHash(AUTH_HASHES[hash]);
  const block = Buffer.alloc(64);
  let written = 0;
  let at = 0;
  while (written < EXPANDED_BYTES) {
    for (let i = 0; i < block.length; i += 1) {
      block[i] = bytes[at % bytes.length];
      at += 1;
    }
    const take = Math.min(block.length, EXPANDED_BYTES - written);
    digest.update(take === block.length ? block : block.subarray(0, take));
    written += take;
  }
  return digest.digest();
}

/**
 * The key localised to one agent (RFC 3414 appendix A.2.1 step 2).
 *
 * Localisation is why a passphrase that is correct for one agent is useless against another:
 * the engine's own identity is hashed into the key. It is also why the engine ID has to be
 * pinned rather than taken from whatever answered.
 */
export function localizeKey(passphraseKey: Buffer, engineId: Buffer, hash: AuthHash): Buffer {
  if (engineId.length < 5 || engineId.length > 32) {
    throw new UsmError(
      `this connection read a ${engineId.length} octet engine identity, and a key can only be localised to one of 5 to 32 octets (RFC 3411 section 5)`,
      "engineIdWidth",
    );
  }
  return createHash(AUTH_HASHES[hash])
    .update(Buffer.concat([passphraseKey, engineId, passphraseKey]))
    .digest();
}

/** Both steps at once, which is how a connection uses it. */
export function localizedKey(passphrase: string, engineId: Buffer, hash: AuthHash): Buffer {
  return localizeKey(passphraseToKey(passphrase, hash), engineId, hash);
}

/**
 * The digest that goes into `msgAuthenticationParameters` (RFC 3414 section 6.3.2).
 *
 * The whole message is hashed with that field already present and filled with zeros, which is
 * why the caller passes the message as it will be sent rather than the message so far: the
 * digest covers its own placeholder.
 */
export function authenticate(messageWithZeroedDigest: Buffer, localizedAuthKey: Buffer, hash: AuthHash): Buffer {
  return createHmac(AUTH_HASHES[hash], localizedAuthKey)
    .update(messageWithZeroedDigest)
    .digest()
    .subarray(0, AUTH_PARAM_BYTES);
}

/** Constant time, because a digest check that leaks timing is a digest check that leaks. */
export function digestMatches(expected: Buffer, actual: Buffer): boolean {
  if (expected.length !== actual.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i += 1) difference |= expected[i] ^ actual[i];
  return difference === 0;
}

/**
 * The AES initialisation vector (RFC 3826 section 3.1.2.1).
 *
 * Boots and time come from the authoritative engine and the salt is the sender's. Writing the
 * two counters big-endian in four octets each is the whole of it, and getting the order wrong
 * produces a message the agent silently discards.
 */
export function aesIv(engineBoots: number, engineTime: number, salt: Buffer): Buffer {
  if (salt.length !== SALT_BYTES)
    throw new UsmError(`the privacy salt is ${SALT_BYTES} octets, this one is ${salt.length}`, "saltWidth");
  if (!Number.isInteger(engineBoots) || engineBoots < 0 || engineBoots > 0xffffffff) {
    throw new UsmError(`engineBoots is a 32 bit unsigned value, this one is ${engineBoots}`, "counterRange");
  }
  if (!Number.isInteger(engineTime) || engineTime < 0 || engineTime > 0xffffffff) {
    throw new UsmError(`engineTime is a 32 bit unsigned value, this one is ${engineTime}`, "counterRange");
  }
  const iv = Buffer.alloc(AES_IV_BYTES);
  iv.writeUInt32BE(engineBoots, 0);
  iv.writeUInt32BE(engineTime, 4);
  salt.copy(iv, 8);
  return iv;
}

/**
 * AES-128 in CFB mode, as RFC 3826 specifies, over the scoped PDU and nothing else.
 *
 * The key is the first 16 octets of a localized key, which is a whole digest of one of
 * `AUTH_HASHES` (20 octets at the shortest, SHA-1), so it is never short.
 */
export function encryptScopedPdu(scopedPdu: Buffer, localizedPrivKey: Buffer, iv: Buffer): Buffer {
  const key = localizedPrivKey.subarray(0, AES_KEY_BYTES);
  const cipher = createCipheriv("aes-128-cfb", key, iv);
  return Buffer.concat([cipher.update(scopedPdu), cipher.final()]);
}

export function decryptScopedPdu(ciphertext: Buffer, localizedPrivKey: Buffer, iv: Buffer): Buffer {
  const key = localizedPrivKey.subarray(0, AES_KEY_BYTES);
  const decipher = createDecipheriv("aes-128-cfb", key, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
