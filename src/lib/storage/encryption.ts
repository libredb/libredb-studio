import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { getJwtSecret, JWT_SECRET_MIN_LENGTH } from "@/lib/config/auth-env";

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
 * depends on: no new mandatory variable, and the auth bootstrap (src/lib/auth-bootstrap.ts:199)
 * already generates and persists a JWT_SECRET on first run, so even an operator who configured
 * nothing has a stable key across restarts. The cost, documented in docs/STORAGE.md, is that
 * rotating JWT_SECRET invalidates every stored credential.
 *
 * The salt is empty and the domain separation is carried entirely by `info`, which is the
 * canonical single-purpose HKDF shape; RFC 5869 section 3.1 explicitly permits an absent salt.
 */

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
/** 96 bits: the IV length GCM is specified for, and the only one that needs no rehashing. */
const IV_BYTES = 12;
const TAG_BYTES = 16;

export const ENVELOPE_VERSION = "v1";
/** Any `vN` tag, so a value written by a future version is recognised as an envelope, not as text. */
const VERSION_TAG = /^v\d+$/;
const HKDF_INFO = "libredb-studio/storage-encryption/v1";
const HKDF_SALT = new Uint8Array(0);

// Single-line messages, hoisted to module scope: bun's line coverage under-counts the continuation
// lines of a wrapped string literal, which then reads as uncovered code. Same reason as
// src/lib/config/auth-env.ts:20.
export const STORAGE_ENCRYPTION_KEY_TOO_SHORT_MESSAGE =
  "STORAGE_ENCRYPTION_KEY is too short; it must be at least 32 characters. Update it and restart the server.";
export const STORAGE_ENCRYPTION_KEY_MISSING_MESSAGE =
  "Server storage cannot encrypt credentials: neither STORAGE_ENCRYPTION_KEY nor JWT_SECRET is configured. Set one (at least 32 characters) and restart the server.";

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
 * Seals a credential into `v1:<iv>:<ciphertext>`.
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
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const sealed = Buffer.concat([body, cipher.getAuthTag()]);
  return `${ENVELOPE_VERSION}:${iv.toString("base64url")}:${sealed.toString("base64url")}`;
}

export type SecretReadResult =
  | { kind: "plaintext"; value: string }
  | { kind: "decrypted"; value: string }
  | { kind: "undecryptable" };

/**
 * Classifies a stored value. Three outcomes, not two, and the third is the important one:
 *
 * - `plaintext`     the value's first segment does not look like a version tag at all - this
 *                   predates the feature (lazy migration; the next write envelopes it)
 * - `decrypted`     a v1 envelope this key opens
 * - `undecryptable` anything whose first segment DOES look like a version tag but is not a valid,
 *                   openable v1 envelope: the wrong number of segments, an unrecognised version, a
 *                   malformed IV or body, or a body that fails authentication. The value is NEVER
 *                   returned in this case. Handing back the raw envelope would put "v1:abc:def"
 *                   into a driver's password field, producing a connection failure with no
 *                   diagnosable cause.
 *
 * D4 governs the boundary between the first and third outcomes: once `parts[0]` matches `^v\d+$`,
 * the value is treated as an envelope CLAIM, and every way that claim can be malformed resolves to
 * `undecryptable` - never to plaintext, even for a two-segment value. The plan already accepts this
 * exposure for three-segment values (a legitimate password shaped "v1:a:b" is rejected today
 * because it decodes to garbage and fails authentication); treating the two-segment case as
 * plaintext instead would protect nothing while opening a hole that corruption - a truncated or
 * partially written envelope - passes straight through as if it were a real password. The accepted
 * cost, per D3: an existing plaintext password shaped exactly `^v\d+:` (for example "v1:x") becomes
 * permanently unreadable once this ships, surfacing as an empty field the user retypes rather than
 * as a deleted record.
 */
export function readSecret(stored: string): SecretReadResult {
  const parts = stored.split(":");
  if (!VERSION_TAG.test(parts[0])) {
    return { kind: "plaintext", value: stored };
  }
  if (parts.length !== 3 || parts[0] !== ENVELOPE_VERSION) {
    return { kind: "undecryptable" };
  }
  const iv = Buffer.from(parts[1], "base64url");
  const sealed = Buffer.from(parts[2], "base64url");
  if (iv.length !== IV_BYTES || sealed.length < TAG_BYTES) {
    return { kind: "undecryptable" };
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, encryptionKey(), iv);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    const opened = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_BYTES)), decipher.final()]);
    return { kind: "decrypted", value: opened.toString("utf8") };
  } catch {
    // A wrong key, a rotated secret, a truncated or tampered value, or missing key material all
    // land here. Reads never throw: see docs/STORAGE.md - an unreadable password must not take the
    // user's query history, saved queries and charts down with it.
    return { kind: "undecryptable" };
  }
}
