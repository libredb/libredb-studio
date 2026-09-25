/**
 * Password hashing for accounts stored on the server.
 *
 * Env-mode login still compares the plaintext `ADMIN_PASSWORD` / `USER_PASSWORD` values
 * (src/lib/auth-compare.ts): those secrets already live in the environment, and hashing them
 * would not move them. A row in the `accounts` table is different. It sits in the same SQLite
 * file or Postgres database as everything else, so the password has to be a real KDF output.
 *
 * scrypt (RFC 7914), via node:crypto, with no added dependency. Parameters, and the rehash rule:
 * N = 16384, r = 8, p = 1, 16-byte salt, 32-byte key. A stored hash whose parameters differ is
 * rewritten with these values after a successful login (`rehashStoredPassword` in
 * src/lib/local-accounts.ts). A failed login never writes.
 *
 * The encoded form is `scrypt$<N>$<r>$<p>$<salt>$<key>`, salt and key in base64url.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

function scrypt(
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) {
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, keylen, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
const SCRYPT_SALT_BYTES = 16;
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

/** Salt used when the stored string is not a hash, so a missing account still pays one scrypt. */
const PLACEHOLDER_SALT = Buffer.alloc(SCRYPT_SALT_BYTES, 7);

let verifications = 0;

/**
 * Test seam, same idea as comparisonCount() in src/lib/auth-compare.ts: the store-mode login
 * path must do one verification whether or not the email exists, and a wall-clock assertion
 * is not how this repository pins that.
 */
export function passwordVerificationCount(): number {
  return verifications;
}

function scryptParams(n: number, r: number, p: number) {
  return { N: n, r, p, maxmem: SCRYPT_MAXMEM };
}

interface ParsedHash {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parseHash(encoded: string): ParsedHash | null {
  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return null;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p) || n < 2 || r < 1 || p < 1) return null;
  const salt = Buffer.from(parts[4], "base64url");
  const hash = Buffer.from(parts[5], "base64url");
  if (salt.length === 0 || hash.length === 0) return null;
  return { n, r, p, salt, hash };
}

/** `cost` defaults to the current N. Tests pass an older N to exercise rehash-on-login. */
export async function hashPassword(password: string, cost: number = SCRYPT_N): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, scryptParams(cost, SCRYPT_R, SCRYPT_P));
  return [
    "scrypt",
    String(cost),
    String(SCRYPT_R),
    String(SCRYPT_P),
    salt.toString("base64url"),
    derived.toString("base64url"),
  ].join("$");
}

export function needsRehash(encoded: string): boolean {
  const parsed = parseHash(encoded);
  if (!parsed) return false;
  return (
    parsed.n !== SCRYPT_N || parsed.r !== SCRYPT_R || parsed.p !== SCRYPT_P || parsed.hash.length !== SCRYPT_KEYLEN
  );
}

/**
 * One scrypt per call, including a stored value that is not a hash: the login route uses that
 * for an email that matches no account, so the missing row cannot be told apart by skipping the KDF.
 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  verifications += 1;
  const parsed = parseHash(encoded);
  try {
    const derived = await scrypt(
      password,
      parsed?.salt ?? PLACEHOLDER_SALT,
      SCRYPT_KEYLEN,
      scryptParams(parsed?.n ?? SCRYPT_N, parsed?.r ?? SCRYPT_R, parsed?.p ?? SCRYPT_P),
    );
    if (!parsed || derived.length !== parsed.hash.length) return false;
    return timingSafeEqual(derived, parsed.hash);
  } catch {
    return false;
  }
}

let placeholder: string | null = null;

/** A real hash of a password that is never a credential, cached after the first unknown-account login. */
export async function placeholderPasswordHash(): Promise<string> {
  if (!placeholder) placeholder = await hashPassword("libredb-dummy-password-never-a-credential");
  return placeholder;
}
