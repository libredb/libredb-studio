/**
 * RFC 6238 TOTP verification for the local auth provider.
 *
 * Scope: verification only. Secrets are provisioned by the operator through
 * `ADMIN_TOTP_SECRET` / `USER_TOTP_SECRET` (src/lib/local-auth.ts), matching how every other
 * local-provider credential is configured — so there is no enrolment flow to store, no QR code
 * to mint and no new writable state on disk. That last point is the deciding one: the chart and
 * the Docker image both run happily on a read-only filesystem, and an MFA control that silently
 * degraded when the data dir was not writable would be worse than no MFA at all.
 *
 * SHA-1 is not a mistake here and must not be "upgraded": RFC 6238 §1.2 names HMAC-SHA-1 as the
 * default, and it is the only algorithm Google Authenticator, Authy, 1Password and the rest
 * interoperate on for a bare `otpauth://totp` URI. The construction's security rests on HMAC,
 * which does not depend on the collision resistance SHA-1 lost.
 *
 * No dependency: HOTP is a truncated HMAC and base32 is a 32-character alphabet. Pulling in an
 * OTP library to avoid this much arithmetic would add a supply-chain surface to the one code
 * path in this app that exists specifically to raise the cost of a compromise.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** Digits in an accepted code. Six is what authenticator apps emit for a bare otpauth URI. */
const TOTP_DIGITS = 6;

/** Seconds each code is valid for. RFC 6238's default, and the only value apps assume. */
export const TOTP_PERIOD_SECONDS = 30;

/**
 * Steps of clock skew accepted either side of the current one, so one back and one forward.
 * RFC 6238 §5.2 permits "at most one time step" for exactly the two cases this covers: a user who
 * starts typing at second 29, and a server whose clock trails the phone's. Widening it multiplies
 * the codes valid at any instant, which is why it is a constant and not an env var.
 */
const TOTP_WINDOW_STEPS = 1;

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Smallest shared secret that may be configured, in decoded bytes. RFC 4226 R6 makes 128 bits a
 * MUST and RFC 6238 inherits it.
 *
 * `decodeBase32` only rejects a secret with no whole byte in it, which is a far lower bar than the
 * RFC's: `AA` decodes to one byte and, without this, is a working second factor worth 8 bits — one
 * observed code narrows it to a single candidate. That failure is invisible, because every screen
 * and every doc still says the account has MFA. Enforced by the caller that reads the operator's
 * value (src/lib/local-auth.ts) rather than by verifyTotp, so it surfaces once as a configuration
 * error naming the variable instead of as a rejected code on every login.
 */
export const TOTP_MIN_SECRET_BYTES = 16;

/** Matches a submitted code once its whitespace has been stripped. */
const CODE_PATTERN = new RegExp(`^\\d{${TOTP_DIGITS}}$`);

/**
 * Decode an RFC 4648 base32 secret, or `null` if it is not one.
 *
 * Lenient about presentation and strict about content: authenticator apps and password managers
 * print secrets in lowercase, in space- or hyphen-separated groups, and with or without `=`
 * padding, so all of that is normalized away. Anything left outside the alphabet is a typo in the
 * operator's environment, and the caller turns that into a config error the operator can read
 * rather than a login that silently rejects every correct code.
 */
export function decodeBase32(secret: string): Buffer | null {
  const normalized = secret.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (!normalized) return null;

  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const character of normalized) {
    const value = BASE32_ALPHABET.indexOf(character);
    if (value === -1) return null;
    accumulator = (accumulator << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  // Fewer than eight bits of payload is not a short secret, it is no secret at all: a single
  // base32 character carries no whole byte, so the HMAC key would be empty.
  if (bytes.length === 0) return null;
  return Buffer.from(bytes);
}

/** RFC 4226 HOTP: dynamic truncation of HMAC-SHA-1 over the big-endian counter. */
function hotp(key: Buffer, counter: number): string {
  const counterBytes = Buffer.alloc(8);
  counterBytes.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", key).update(counterBytes).digest();
  // The low nibble of the last byte picks the 4-byte window; the high bit is masked off so the
  // value reads as a positive 31-bit integer on every platform (RFC 4226 §5.4).
  const offset = digest[digest.length - 1] & 0x0f;
  const truncated = digest.readUInt32BE(offset) & 0x7fffffff;
  return (truncated % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, "0");
}

/**
 * Constant-time code comparison.
 *
 * Both operands are exactly TOTP_DIGITS ASCII digits — `hotp` pads and the caller's regex rejects
 * anything else — so timingSafeEqual's equal-length precondition holds without the length guard
 * that would itself be an oracle (see the note in src/lib/auth-compare.ts).
 *
 * Deliberately NOT routed through `secretsMatch`: that function's counter is what the
 * login-enumeration test asserts its "exactly one comparison per attempt" property on, and a
 * second factor checked afterwards would make that count depend on whether the password matched.
 */
function codesMatch(expected: string, submitted: string): boolean {
  return timingSafeEqual(Buffer.from(expected, "ascii"), Buffer.from(submitted, "ascii"));
}

/**
 * Verify a submitted code against a base32 secret.
 *
 * Returns the time step the code belongs to rather than a boolean, because the caller needs that
 * step to spend it through `claimTotpStep`. A boolean would leave the caller unable to tell two
 * uses of one code apart, which is precisely what RFC 6238 §5.2 requires it to prevent.
 */
export function verifyTotp(secret: string, code: string, now: number = Date.now()): number | null {
  const key = decodeBase32(secret);
  if (!key) return null;

  // People paste "287 082" out of a password manager; the digit check applies to what is left.
  const submitted = code.replace(/\s/g, "");
  if (!CODE_PATTERN.test(submitted)) return null;

  const currentStep = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);
  for (let offset = -TOTP_WINDOW_STEPS; offset <= TOTP_WINDOW_STEPS; offset++) {
    const step = currentStep + offset;
    // The look-back offset runs off the bottom of the counter inside the first time step, and
    // writeBigUInt64BE throws on a negative. Unreachable on a correct clock, but a container
    // that starts before NTP has set the time reports epoch zero, and a login must not 500.
    if (step < 0) continue;
    if (codesMatch(hotp(key, step), submitted)) return step;
  }
  return null;
}

/**
 * Spent (account, step) pairs, so one code cannot be used twice inside its acceptance window —
 * RFC 6238 §5.2. Without this, a code lifted by a shoulder-surf, a phishing proxy or a logged
 * request body stays usable for up to 90 seconds, which is long enough to matter.
 *
 * In-process, like the login rate limiter in src/lib/api/rate-limit.ts, and for its reasons: the
 * chart defaults to one replica, and a shared store would make an availability dependency out of
 * a control that must never be the reason an operator cannot log in. Across replicas each process
 * enforces its own view, which narrows the replay window rather than closing it — the same
 * trade-off, and the same limit, the rate limiter already documents.
 */
const spentSteps = new Map<string, number>();

/**
 * A ceiling on the map, not a defence against one.
 *
 * Nothing an attacker sends can grow this: claimTotpStep is reached only after a code verifies
 * against a configured account, and the local provider defines at most two of those, so pruning
 * by expiry alone holds the map at a handful of entries. The cap exists for the shape this module
 * would take if accounts ever became data rather than environment. Eviction fails OPEN (an
 * evicted pair becomes replayable) because a replay guard must never be the reason a legitimate
 * login is refused.
 */
const MAX_SPENT_ENTRIES = 4096;

/** Test seam: drops all spent-step state so each case observes a fresh process. */
export function clearTotpReplayState(): void {
  spentSteps.clear();
}

/**
 * Claim a time step for an account. Returns `false` when that exact code has already been
 * accepted and is therefore a replay.
 *
 * `accountKey` must already be non-reversible — the login route passes the same `hmacHex` value
 * it keys the per-account rate limiter on — so no email address reaches this long-lived state.
 */
export function claimTotpStep(accountKey: string, step: number, now: number = Date.now()): boolean {
  // An entry is useless once the step it names can no longer be accepted by verifyTotp, so its
  // expiry is the end of the last window that would still admit it.
  const expiresAt = (step + TOTP_WINDOW_STEPS + 1) * TOTP_PERIOD_SECONDS * 1000;
  for (const [entryKey, entryExpiry] of spentSteps) {
    if (entryExpiry <= now) spentSteps.delete(entryKey);
  }
  // Pruning by expiry alone is usually enough; the cap only bites under a flood of distinct keys.
  // Evicting the oldest insertion is sound here because Map preserves insertion order and every
  // entry has the same lifetime, so the oldest inserted is also the nearest to expiring.
  while (spentSteps.size >= MAX_SPENT_ENTRIES) {
    spentSteps.delete(spentSteps.keys().next().value as string);
  }

  const key = `${accountKey}:${step}`;
  if (spentSteps.has(key)) return false;
  spentSteps.set(key, expiresAt);
  return true;
}
