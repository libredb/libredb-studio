import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Constant-time credential comparison.
 *
 * crypto.timingSafeEqual requires two ArrayBufferViews of EQUAL byte length and throws otherwise.
 * Attacker guesses and real passwords almost never share a length, so calling it on raw strings
 * throws on nearly every wrong guess - and the obvious guard, `if (a.length !== b.length) return
 * false`, reintroduces exactly the length oracle this control exists to remove. Comparing
 * fixed-length digests makes both operands 32 bytes regardless of input, so one timingSafeEqual
 * call always runs on equal-length buffers.
 *
 * HMAC with a per-process random key rather than a bare digest, so the digests are unpredictable
 * to an attacker who can submit inputs. The key is a lazy module-level singleton, matching the
 * _jwtSecret pattern in src/proxy.ts:14-20. Unlike that one, the memo here is load-bearing rather
 * than an optimization: the key is generated, not read, so re-deriving it per call would make two
 * digests of the same input differ.
 *
 * node:crypto is unconditionally available: no route declares an edge runtime and production runs
 * `node server.js`.
 */

let _key: Buffer | null = null;

function key(): Buffer {
  if (!_key) _key = randomBytes(32);
  return _key;
}

/** Fixed-length (32-byte) digest of an arbitrary-length secret, keyed per process. */
function digest(value: string): Buffer {
  return createHmac("sha256", key()).update(value, "utf8").digest();
}

let comparisons = 0;

/**
 * Test seam: how many constant-time comparisons this process has performed.
 *
 * The enumeration test asserts that exactly one comparison happens per login attempt whether or
 * not the submitted email matched. It cannot use mock.module to count them: `bun run test` runs
 * tests/unit, tests/api, tests/integration and tests/security in one process, and a module mock
 * there is process-wide. A monotonic counter read as a before/after delta is deterministic and
 * leaks nothing. This follows resetCookieSecurityWarning() in src/lib/auth.ts:73.
 */
export function comparisonCount(): number {
  return comparisons;
}

/** Constant-time equality over two arbitrary-length strings. */
export function secretsMatch(a: string, b: string): boolean {
  comparisons += 1;
  return timingSafeEqual(digest(a), digest(b));
}

/**
 * A stable, non-reversible bucket key for an account identifier. Used for the per-account login
 * limiter, so that raw email addresses stay out of long-lived limiter state and so that an
 * attacker who spoofs X-Forwarded-For is still capped per account.
 */
export function hmacHex(value: string): string {
  return digest(value).toString("hex");
}
