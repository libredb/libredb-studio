/**
 * openGauss's two authentication handshakes (issue #815).
 *
 * openGauss answers on the PostgreSQL wire and numbers its authentication
 * requests differently at exactly two places: request 10 is SHA256 where
 * PostgreSQL's 10 starts SASL, and request 11 is MD5_SHA256 where PostgreSQL's
 * 11 continues it. `pg` reads 10 as a SASL start, finds no mechanism list it
 * knows, and gives up with "SASL: Only mechanism(s) SCRAM-SHA-256 are
 * supported" before a single query is sent. This module carries both handshakes
 * as pure functions - parsing, key derivation, response construction - so the
 * transport in `opengauss-socket.ts` stays a frame filter and everything here
 * is unit-testable against frames measured on `opengauss/opengauss:5.0.0`.
 *
 * The wire layouts, as measured on 5.0.0 with `password_encryption_type = 2`
 * (the default), and cross-checked against the server's own verification code:
 *
 *   R, code 10: [code i32][int i32][salt 64 ascii][token 8 ascii][tail]
 *     The tail is a 64-character server signature on 5.0.0; a 4-byte iteration
 *     count is accepted when a server sends one, and anything else means the
 *     default iteration count. The int between the code and the salt is not
 *     needed to answer - 5.0.0 sends 2, the value of its own
 *     `password_encryption_type` - and is skipped rather than interpreted.
 *
 *   R, code 11: [code i32][salt 64 ascii][md5Salt 4 binary]
 *
 * The SHA256 derivation, confirmed against the server two ways - the reply is
 * accepted, and the server's signature over the token matches the one
 * `deriveSha256Keys` computes from the password alone:
 *
 *   k          = PBKDF2-HMAC-SHA1(password, hexDecoded(salt), iterations, 32)
 *   serverKey  = HMAC-SHA256(k, "Sever Key")   <- the protocol's own literal
 *   clientKey  = HMAC-SHA256(k, "Client Key")
 *   storedKey  = SHA256(clientKey)
 *   proof      = clientKey XOR HMAC-SHA256(storedKey, hexDecoded(token))
 *
 * and the reply is the 64-character lowercase hex of the proof.
 *
 * A `pg_authid.rolpassword` row stores those values verbatim and then appends
 * an encoded iteration count, and the byte order is what the MD5_SHA256
 * composition below is built from:
 *
 *   "sha256" + salt + serverKey + storedKey + encode_iteration(iterations)
 *
 * verified by rebuilding the row from the password on 5.0.0. MD5_SHA256 has
 * two formulations in that version and they do not agree:
 *
 * - The client's (`fe-auth.cpp`, `AUTH_REQ_MD5_SHA256`) is the stored row minus
 *   its `sha256` prefix and minus that suffix - the hex fields alone:
 *
 *     composite = salt + serverKey + storedKey        (hex strings, as stored)
 *     reply     = "md5" + MD5(latin1(composite) + md5Salt)
 *
 * - The server's check (`crypt.cpp`, the `uaMD5` arm with a SHA256-stored
 *   password) is `pg_md5_encrypt(shadow_pass + SHA256_LENGTH, md5Salt, 4)`.
 *   `shadow_pass` is the whole stored row, suffix included, so the input it
 *   hashes is 203 characters where the client's is 192.
 *
 * On 5.0.0 the two cannot meet: the suffix is not on the wire - the request
 * carries no iteration count - and a client following `fe-auth.cpp`, libpq's
 * own `gsql` included, is rejected with 28P01 (measured through a byte proxy
 * against the live server). What IS accepted, also measured, is the
 * server-side reading with the suffix reconstructed from the default
 * iteration count:
 *
 *   composite = salt + serverKey + storedKey + encode_iteration(iterations)
 *   reply     = "md5" + MD5(latin1(composite) + md5Salt)
 */
import { createHash, createHmac, pbkdf2Sync, timingSafeEqual } from "node:crypto";

/** openGauss authentication request codes, as it defines them. */
export const OPENGAUSS_AUTH_SHA256 = 10;
export const OPENGAUSS_AUTH_MD5_SHA256 = 11;

/**
 * The iteration count used when the server sends none. 5.0.0's default
 * `password_encryption_type = 2` stores keys derived with 10000, and the
 * request carries no count of its own.
 */
export const OPENGAUSS_DEFAULT_ITERATIONS = 10000;

/** One hex-encoded field on the wire: a salt or a derived key. */
const HEX_FIELD_LENGTH = 64;
/** The token is 8 hex characters. */
const TOKEN_LENGTH = 8;
const KEY_LENGTH = 32;
/** Where the salt starts in a code-10 payload: after the code and the int. */
const SHA256_SALT_OFFSET = 8;
const SHA256_TOKEN_OFFSET = SHA256_SALT_OFFSET + HEX_FIELD_LENGTH;
/** Where the salt starts in a code-11 payload: straight after the code. */
const MD5_SHA256_SALT_OFFSET = 4;
const MD5_SALT_LENGTH = 4;

/**
 * The base string openGauss's `encode_iteration` offsets digit by digit
 * (`user.cpp`). Every stored SHA256 password this version writes ends with its
 * encoding; the default iteration count appears in it as `"ecdfecefade"`.
 */
const ITERATION_ENCODING_BASE = "ecdfdcefade";

/**
 * The 11-character encoding of an iteration count, as appended to a stored
 * `sha256` password: each decimal digit of the count, least significant
 * first, is added to the character of the base string at the same position.
 * `encode_iteration(10000)` is `"ecdfecefade"`, the suffix the server's
 * MD5_SHA256 check hashes and the fe-auth formula omits - see the header.
 */
export function encodeIteration(count: number): string {
  if (!Number.isInteger(count) || count < 0) {
    throw new RangeError(`iteration count must be a non-negative integer, got ${count}`);
  }
  let remaining = count;
  let encoded = "";
  for (let i = 0; i < ITERATION_ENCODING_BASE.length; i++) {
    // Past the count's last digit the offset is zero, so the loop simply
    // continues over the base string - the same thing the C loop does.
    const digit = remaining % 10;
    remaining = Math.floor(remaining / 10);
    encoded += String.fromCharCode(ITERATION_ENCODING_BASE.charCodeAt(i)! + digit);
  }
  return encoded;
}

export interface Sha256AuthRequest {
  readonly kind: "sha256";
  /** The 64-character hex salt, as sent. */
  readonly salt: string;
  /** The 8-character hex token the proof is bound to. */
  readonly token: string;
  /** The server's signature over the token when the frame carries one. */
  readonly serverSignature: string | null;
  readonly iterations: number;
}

export interface Md5Sha256AuthRequest {
  readonly kind: "md5_sha256";
  /** The 64-character hex salt, as sent. */
  readonly salt: string;
  /** The 4 raw bytes salted into the MD5 last. */
  readonly md5Salt: Buffer;
  readonly iterations: number;
}

export type OpenGaussAuthRequest = Sha256AuthRequest | Md5Sha256AuthRequest;

export interface Sha256DerivedKeys {
  readonly serverKey: Buffer;
  readonly clientKey: Buffer;
  readonly storedKey: Buffer;
}

function isHexRun(payload: Buffer, start: number, length: number): boolean {
  if (payload.length < start + length) return false;
  for (let i = start; i < start + length; i++) {
    const byte = payload[i]!;
    const digit = byte >= 0x30 && byte <= 0x39;
    const lower = byte >= 0x61 && byte <= 0x66;
    const upper = byte >= 0x41 && byte <= 0x46;
    if (!digit && !lower && !upper) return false;
  }
  return true;
}

/**
 * Reads an openGauss handshake request out of an `R` frame's payload, or
 * `null` when the payload is not one.
 *
 * The check is shape-based on purpose: a REAL SASL start lists mechanisms as
 * NUL-terminated strings ("SCRAM-SHA-256" and friends), which is not a run of
 * hex, so an engine answering PostgreSQL's own handshake passes through to the
 * driver instead of being answered here. Both layouts were measured on
 * `opengauss/opengauss:5.0.0`; see the module header.
 */
export function parseOpenGaussAuthRequest(payload: Buffer): OpenGaussAuthRequest | null {
  if (payload.length < 8) return null;
  const code = payload.readInt32BE(0);

  if (code === OPENGAUSS_AUTH_SHA256) {
    if (!isHexRun(payload, SHA256_SALT_OFFSET, HEX_FIELD_LENGTH)) return null;
    if (!isHexRun(payload, SHA256_TOKEN_OFFSET, TOKEN_LENGTH)) return null;
    const tail = payload.subarray(SHA256_TOKEN_OFFSET + TOKEN_LENGTH);
    return {
      kind: "sha256",
      salt: payload.subarray(SHA256_SALT_OFFSET, SHA256_TOKEN_OFFSET).toString("latin1"),
      token: payload.subarray(SHA256_TOKEN_OFFSET, SHA256_TOKEN_OFFSET + TOKEN_LENGTH).toString("latin1"),
      serverSignature: tail.length === HEX_FIELD_LENGTH ? tail.toString("latin1") : null,
      iterations: tail.length === 4 ? tail.readInt32BE(0) : OPENGAUSS_DEFAULT_ITERATIONS,
    };
  }

  if (code === OPENGAUSS_AUTH_MD5_SHA256) {
    if (payload.length !== MD5_SHA256_SALT_OFFSET + HEX_FIELD_LENGTH + MD5_SALT_LENGTH) return null;
    if (!isHexRun(payload, MD5_SHA256_SALT_OFFSET, HEX_FIELD_LENGTH)) return null;
    const md5SaltStart = MD5_SHA256_SALT_OFFSET + HEX_FIELD_LENGTH;
    return {
      kind: "md5_sha256",
      salt: payload.subarray(MD5_SHA256_SALT_OFFSET, md5SaltStart).toString("latin1"),
      md5Salt: Buffer.from(payload.subarray(md5SaltStart, md5SaltStart + MD5_SALT_LENGTH)),
      iterations: OPENGAUSS_DEFAULT_ITERATIONS,
    };
  }

  return null;
}

/**
 * The three stored-derived keys, from the password and the request's salt.
 *
 * "Sever Key" above is not a typo transcribed here - it is the literal the
 * protocol derives with, in openGauss's `crypt.cpp` and its client alike. The
 * server-signature check in the unit tests is what keeps it honest.
 */
export function deriveSha256Keys(password: string, saltHex: string, iterations: number): Sha256DerivedKeys {
  const key = pbkdf2Sync(password, Buffer.from(saltHex, "hex"), iterations, KEY_LENGTH, "sha1");
  const serverKey = createHmac("sha256", key).update("Sever Key").digest();
  const clientKey = createHmac("sha256", key).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  return { serverKey, clientKey, storedKey };
}

/**
 * The password response to a request 10: `clientKey XOR HMAC(storedKey, token)`,
 * as 64-character hex. Measured accepted by openGauss 5.0.0; see the header.
 */
export function sha256Password(password: string, request: Sha256AuthRequest): string {
  const { clientKey, storedKey } = deriveSha256Keys(password, request.salt, request.iterations);
  const signature = createHmac("sha256", storedKey).update(Buffer.from(request.token, "hex")).digest();
  const proof = Buffer.alloc(KEY_LENGTH);
  for (let i = 0; i < KEY_LENGTH; i++) proof[i] = clientKey[i]! ^ signature[i]!;
  return proof.toString("hex");
}

/**
 * Whether the signature the server sent over the token matches the one the
 * password derives. Each side can only produce it from its own copy of the
 * server key, so a match is the server proving it stored this password -
 * recorded by the tests rather than used at runtime, because a mismatch there
 * is indistinguishable from a wrong password the server is about to answer
 * anyway.
 */
export function verifySha256ServerSignature(password: string, request: Sha256AuthRequest): boolean {
  if (request.serverSignature === null) return false;
  const { serverKey } = deriveSha256Keys(password, request.salt, request.iterations);
  const expected = Buffer.from(
    createHmac("sha256", serverKey).update(Buffer.from(request.token, "hex")).digest("hex"),
    "latin1",
  );
  const given = Buffer.from(request.serverSignature, "latin1");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

/**
 * The password response to a request 11: `"md5" + MD5(composite + md5Salt)`,
 * where `composite` is the stored row minus its `sha256` prefix - the salt,
 * the server key, the stored key and the encoded iteration suffix, each as the
 * hex string it is stored as. The suffix is what the server's own check hashes
 * and what `fe-auth.cpp`'s formula leaves out; with it the reply is accepted by
 * the live 5.0.0 server, without it both this reply and `gsql`'s are rejected.
 * See the module header for the two quotations and the measurements.
 */
export function md5Sha256Password(password: string, request: Md5Sha256AuthRequest): string {
  const { serverKey, storedKey } = deriveSha256Keys(password, request.salt, request.iterations);
  const composite = `${request.salt}${serverKey.toString("hex")}${storedKey.toString("hex")}${encodeIteration(request.iterations)}`;
  const digest = createHash("md5").update(Buffer.from(composite, "latin1")).update(request.md5Salt).digest("hex");
  return `md5${digest}`;
}

/** A complete `PasswordMessage` frame: `p`, the length, the payload and a NUL. */
export function passwordMessageFrame(response: string): Buffer {
  const payload = Buffer.from(response, "utf8");
  const frame = Buffer.alloc(1 + 4 + payload.length + 1);
  frame.writeUInt8(0x70, 0); // "p"
  frame.writeInt32BE(4 + payload.length + 1, 1);
  payload.copy(frame, 5);
  frame[frame.length - 1] = 0;
  return frame;
}

/**
 * The one decision the transport makes for every `R` frame: the response to
 * send for an openGauss handshake request, or `null` when the frame is not
 * one and must be forwarded to the driver untouched.
 */
export function openGaussAuthResponse(payload: Buffer, password: string): string | null {
  const request = parseOpenGaussAuthRequest(payload);
  if (request === null) return null;
  return request.kind === "sha256" ? sha256Password(password, request) : md5Sha256Password(password, request);
}
