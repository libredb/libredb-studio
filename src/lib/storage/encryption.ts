import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { getJwtSecret, JWT_SECRET_MIN_LENGTH } from "@/lib/config/auth-env";
import type { CredentialEnvelopeState } from "./types";
import { BINDING_FORMAT, bindingAad, type EnvelopeBinding } from "./envelope-binding";
import { isEnvelopeClaim } from "./envelope-claim";

/**
 * Credential encryption at rest for the SERVER-SIDE store (STORAGE_PROVIDER=sqlite|postgres).
 *
 * What this buys and what it does not: a leaked database file or dump is useless ON ITS OWN,
 * because the key is never written into the store itself. It is NOT a vault - anyone who can read
 * the process environment can read the credentials, and the browser's localStorage copy stays
 * plaintext by deliberate product decision (that is what lets Studio work without a master
 * password, and it is why the XSS controls carry the weight they do).
 *
 * A stolen BACKUP OR VOLUME SNAPSHOT is a narrower claim than a stolen database file, and for
 * STORAGE_PROVIDER=sqlite with no STORAGE_ENCRYPTION_KEY set it does not hold: the fallback key is
 * derived from JWT_SECRET, which the first-run bootstrap persists in auth-bootstrap.json
 * (src/lib/auth-bootstrap.ts) beside the SQLite file - both resolve through the same
 * src/lib/data-dir.ts:getDataDir(), and the Helm chart mounts that one directory as a single
 * /app/data volume. A snapshot of it carries the ciphertext and the key that opens it side by
 * side. Set STORAGE_ENCRYPTION_KEY from outside that volume (a Kubernetes Secret, an environment
 * variable supplied by the orchestrator) to close this gap; see docs/STORAGE.md. postgres
 * deployments do not share this exposure by default, because the key material lives in the app's
 * own filesystem, a volume separate from the database being backed up.
 *
 * Key derivation:
 *   STORAGE_ENCRYPTION_KEY, when set -> HKDF-SHA256 -> 32 bytes
 *   otherwise                        -> JWT_SECRET  -> HKDF-SHA256 -> 32 bytes
 *
 * Deriving from JWT_SECRET is what keeps the zero-config promise every distribution channel
 * depends on: no new mandatory variable, and the auth bootstrap (`bootstrapAuth` in src/lib/auth-bootstrap.ts)
 * already generates and persists a JWT_SECRET on first run, so even an operator who configured
 * nothing has a stable key across restarts. The cost, documented in docs/STORAGE.md, is that
 * rotating JWT_SECRET invalidates every stored credential.
 *
 * The salt is empty and the domain separation is carried entirely by `info`, which is the
 * canonical single-purpose HKDF shape; RFC 5869 section 3.1 explicitly permits an absent salt. The
 * info string names v1 because it names the key, not the envelope: version 2 envelopes use the same
 * key, and differ in what each one is bound to (./envelope-binding.ts).
 *
 * Envelope formats:
 *   v2  `v2:<iv>:<ciphertext+tag>`, bound by additional authenticated data to the owner, record,
 *       field and identity fields it was sealed for (./envelope-binding.ts). Every seal writes v2.
 *   v1  `v1:<iv>:<ciphertext+tag>`, the previous format, bound to nothing. Read, never written, and
 *       only while the store accepts it: the operator re-seal (./reseal.ts) retires it.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
/** 96 bits: the IV length GCM is specified for, and the only one that needs no rehashing. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The version tag every seal writes. */
export const ENVELOPE_VERSION = BINDING_FORMAT;
/** The previous format: opened without additional data, and only by `openSecret`. */
const PREVIOUS_VERSION = "v1";
const HKDF_INFO = "libredb-studio/storage-encryption/v1";
const HKDF_SALT = new Uint8Array(0);

// Single-line messages, hoisted to module scope: bun's line coverage under-counts the continuation
// lines of a wrapped string literal, which then reads as uncovered code. Same reason as
// src/lib/config/auth-env.ts.
export const STORAGE_ENCRYPTION_KEY_TOO_SHORT_MESSAGE = `STORAGE_ENCRYPTION_KEY is too short; it must be at least ${JWT_SECRET_MIN_LENGTH} characters. Update it and restart the server.`;
export const STORAGE_ENCRYPTION_KEY_MISSING_MESSAGE = `Server storage cannot encrypt credentials: neither STORAGE_ENCRYPTION_KEY nor JWT_SECRET is configured. Set one (at least ${JWT_SECRET_MIN_LENGTH} characters) and restart the server.`;

/**
 * Derived once per process. A key is on the write path of every storage push, so re-deriving per
 * call would put an HKDF on a hot path for no benefit: neither source variable can change without
 * a restart in any deployment this product ships to.
 */
let cachedKey: Buffer | null = null;

/** Test seam: clears the derived key so each case observes a fresh process. */
export function resetStorageEncryptionKey(): void {
  cachedKey = null;
}

function inputKeyMaterial(): Uint8Array {
  const explicit = process.env.STORAGE_ENCRYPTION_KEY;
  if (explicit) {
    // The same floor as JWT_SECRET, from the same constant: an operator who sets a dedicated key
    // must not end up with weaker material than the fallback they were trying to improve on.
    if (explicit.length < JWT_SECRET_MIN_LENGTH) {
      throw new Error(STORAGE_ENCRYPTION_KEY_TOO_SHORT_MESSAGE);
    }
    return new TextEncoder().encode(explicit);
  }
  // allowDevFallback stays at its default (true): forcing it off would break
  // STORAGE_PROVIDER=sqlite under `bun dev` with no JWT_SECRET, which is exactly the zero-config
  // path this control must not break. In production the fallback does not apply and this throws.
  return getJwtSecret({ missingMessage: STORAGE_ENCRYPTION_KEY_MISSING_MESSAGE });
}

function encryptionKey(): Buffer {
  if (!cachedKey) {
    cachedKey = Buffer.from(hkdfSync("sha256", inputKeyMaterial(), HKDF_SALT, HKDF_INFO, KEY_BYTES));
  }
  return cachedKey;
}

/**
 * Derives the key now, and throws by name when no usable key material exists. An open turns a missing key into
 * `unopenable` like any other key that does not open a value (`openBody`), which suits a read; the re-seal (./reseal.ts)
 * calls this first instead, because a run that took every value for unopenable would retire version 1 over values the
 * right key still opens.
 */
export function requireStorageEncryptionKey(): void {
  encryptionKey();
}

/**
 * Seals a credential into `v2:<iv>:<ciphertext>`, bound to `binding`.
 *
 * The GCM authentication tag is appended to the ciphertext segment rather than given a fourth
 * segment: the stored shape is a fixed contract and has three parts. Dropping the tag instead
 * would turn this into unauthenticated encryption, where a flipped byte yields a different,
 * silently wrong password rather than a detected failure.
 *
 * Throws when no usable key material exists. That is deliberate and fails CLOSED: a write that
 * could not encrypt must not fall back to writing the credential in the clear. The caller is
 * PUT /api/storage/connections, whose 500 the sync hook reports as syncError without blocking the
 * UI (docs/STORAGE.md, "Graceful Degradation").
 */
export function sealSecret(plaintext: string, binding: EnvelopeBinding): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  cipher.setAAD(bindingAad(binding));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const sealed = Buffer.concat([body, cipher.getAuthTag()]);
  return `${ENVELOPE_VERSION}:${iv.toString("base64url")}:${sealed.toString("base64url")}`;
}

/**
 * What a stored value is, under the binding of the place it was read from:
 *
 * - `plaintext`   no version tag at all (`isEnvelopeClaim` is false): a value from before
 *                 encryption, or one a writer outside Studio put there
 * - `v1`          a version 1 envelope this key opens; it is bound to nothing
 * - `v2`          a version 2 envelope this key opens under `binding`
 * - `unopenable`  every other envelope claim: the wrong number of segments, an unrecognised
 *                 version, a malformed IV or body, a body that fails authentication, or a v2 value
 *                 sealed for another place. The value is NEVER returned in this case: handing back
 *                 the raw envelope would put "v2:abc:def" into a driver's password field, a
 *                 connection failure with no diagnosable cause.
 *
 * Whether a `plaintext` or `v1` value may be used is the store's decision (`readStoredSecret`).
 */
export type StoredSecret =
  | { kind: "plaintext"; value: string }
  | { kind: "v1"; value: string }
  | { kind: "v2"; value: string }
  | { kind: "unopenable" };

/** Opens one envelope body; null when it does not authenticate under this key and `aad`. */
function openBody(iv64: string, body64: string, aad: Uint8Array | null): string | null {
  const iv = Buffer.from(iv64, "base64url");
  const sealed = Buffer.from(body64, "base64url");
  if (iv.length !== IV_BYTES || sealed.length < TAG_BYTES) return null;
  try {
    const decipher = createDecipheriv(ALGORITHM, encryptionKey(), iv);
    if (aad) decipher.setAAD(aad);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    const opened = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
    return opened.toString("utf8");
  } catch {
    // A wrong key, a rotated secret, a truncated or tampered value, another binding, or missing
    // key material all land here. Opening never throws: see docs/STORAGE.md - an unreadable
    // password must not take the user's query history, saved queries and charts down with it.
    return null;
  }
}

/**
 * Classifies and opens a stored value (see `StoredSecret`). The D4 shape rule
 * (src/lib/storage/envelope-claim.ts) decides plaintext from envelope; a version 1 body is opened
 * without additional data, a version 2 body only under `binding`.
 */
export function openSecret(stored: string, binding: EnvelopeBinding): StoredSecret {
  if (!isEnvelopeClaim(stored)) return { kind: "plaintext", value: stored };
  const parts = stored.split(":");
  if (parts.length !== 3) return { kind: "unopenable" };
  if (parts[0] === ENVELOPE_VERSION) {
    const value = openBody(parts[1], parts[2], bindingAad(binding));
    return value === null ? { kind: "unopenable" } : { kind: "v2", value };
  }
  if (parts[0] === PREVIOUS_VERSION) {
    const value = openBody(parts[1], parts[2], null);
    return value === null ? { kind: "unopenable" } : { kind: "v1", value };
  }
  return { kind: "unopenable" };
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/**
 * Whether `stored` is a well-formed version 1 envelope: `v1`, a base64url IV of 12 bytes and a base64url body of at least
 * the 16-byte tag, the shape `openSecret` opens, whether or not the key in use opens it. Such a value that does not open
 * was sealed under another key; the re-seal refuses to retire version 1 over it (./reseal.ts).
 */
export function isVersionOneEnvelope(stored: string): boolean {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== PREVIOUS_VERSION) return false;
  const [, iv64, body64] = parts;
  if (!BASE64URL.test(iv64) || !BASE64URL.test(body64)) return false;
  return Buffer.from(iv64, "base64url").length === IV_BYTES && Buffer.from(body64, "base64url").length >= TAG_BYTES;
}

/** Why a stored value was not handed back: it does not open here, or it is version 1 or unsealed after retirement. */
export type RefusalReason = "unopenable" | "retired";

export type StoredSecretRead = { kind: "opened"; value: string } | { kind: "refused"; reason: RefusalReason };

/**
 * The read rule of the store: a v2 value opens under its binding; a v1 value and an unsealed one
 * open while the store's state is `v1-accepted` and are refused as `retired` once it is
 * `v1-retired`; everything else is refused as `unopenable`.
 */
export function readStoredSecret(
  stored: string,
  binding: EnvelopeBinding,
  state: CredentialEnvelopeState,
): StoredSecretRead {
  return storedSecretRead(openSecret(stored, binding), state);
}

/** The read rule of `readStoredSecret`, for a value `openSecret` already opened. */
export function storedSecretRead(read: StoredSecret, state: CredentialEnvelopeState): StoredSecretRead {
  if (read.kind === "unopenable") return { kind: "refused", reason: "unopenable" };
  if (read.kind === "v2" || state === "v1-accepted") return { kind: "opened", value: read.value };
  return { kind: "refused", reason: "retired" };
}
