/**
 * Single source of truth for reading JWT_SECRET from the environment.
 *
 * Consolidates the three readers that previously drifted apart (auth.ts,
 * proxy.ts, oidc.ts) into one module with the strictest semantics:
 * - missing in production -> AuthConfigError (login route maps it to a clear 503)
 * - missing outside production -> well-known development fallback (with warning)
 * - present but shorter than JWT_SECRET_MIN_LENGTH -> AuthConfigError
 *
 * The reader is stateless and reads the environment on every call; consumers
 * that want memoization keep their own lazy cache so a module-level throw can
 * never take down unrelated imports.
 */

import { AuthConfigError } from "@/lib/auth-errors";
import { authProviderSetting } from "@/lib/config/auth-provider";

/**
 * Minimum accepted JWT_SECRET length. Single source of truth: the boot preflight
 * (auth-preflight.ts) and the bootstrap file reader (auth-bootstrap.ts) enforce
 * the same number, so a secret that passes startup can never fail at login.
 */
export const JWT_SECRET_MIN_LENGTH = 32;

// Single-line messages, hoisted to module scope: bun's line coverage under-counts
// the continuation lines of multi-line string concatenation, which would show as
// uncovered "new code" in SonarCloud even though the throw is exercised by tests.
export const JWT_SECRET_MISSING_MESSAGE = `Login is unavailable: the server's JWT_SECRET is not configured. Set JWT_SECRET (at least ${JWT_SECRET_MIN_LENGTH} characters) and restart the server.`;
export const JWT_SECRET_TOO_SHORT_MESSAGE = `Login is unavailable: the server's JWT_SECRET is too short; it must be at least ${JWT_SECRET_MIN_LENGTH} characters. Update JWT_SECRET and restart the server.`;

/** Exported for the guard that checks the development fallback meets the enforced minimum. */
export const DEV_FALLBACK_SECRET = "development-fallback-secret-32ch";

export interface JwtSecretOptions {
  /**
   * Allow the development fallback secret when JWT_SECRET is missing outside
   * production (default true). Set to false for uses that must never fall back
   * to a well-known secret (e.g. OIDC state encryption): a missing secret then
   * throws in every environment.
   */
  allowDevFallback?: boolean;
  /** Error message used when JWT_SECRET is missing and no fallback applies. */
  missingMessage?: string;
}

/**
 * Read and validate JWT_SECRET, returning it encoded for `jose`.
 *
 * Throws AuthConfigError lazily (at call time, not module load), so callers can
 * surface misconfiguration as a clear operator-facing error at login/verify time
 * instead of crashing every module that imports them.
 */
export function getJwtSecret(options: JwtSecretOptions = {}): Uint8Array {
  const { allowDevFallback = true, missingMessage = JWT_SECRET_MISSING_MESSAGE } = options;
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    if (process.env.NODE_ENV === "production" || !allowDevFallback) {
      throw new AuthConfigError(missingMessage);
    }
    // Development fallback - only for local development
    console.warn("JWT_SECRET not set, using development fallback. Set JWT_SECRET in production!");
    return new TextEncoder().encode(DEV_FALLBACK_SECRET);
  }

  if (secret.length < JWT_SECRET_MIN_LENGTH) {
    throw new AuthConfigError(JWT_SECRET_TOO_SHORT_MESSAGE);
  }

  return new TextEncoder().encode(secret);
}

/**
 * A signing key derived from JWT_SECRET for one purpose: HMAC-SHA256(secret, label).
 *
 * A token signed with it can neither pass as a session nor be minted from one, because the session key is the raw
 * secret. Web Crypto, so it runs in the proxy and in a route alike; derived on every call, because a cached key
 * would outlive a rotated secret. `options` are passed to `getJwtSecret`.
 */
export async function derivedSigningKey(label: string, options: JwtSecretOptions = {}): Promise<Uint8Array> {
  // Copied into its own buffer: `BufferSource` requires an `ArrayBuffer`, and a Uint8Array's backing store is typed
  // as possibly shared.
  const raw = getJwtSecret(options).slice().buffer as ArrayBuffer;
  const base = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", base, new TextEncoder().encode(label)));
}

/** Session lifetime bounds and default, in seconds. The default is the fixed 24 hours sessions had before it was configurable. */
export const SESSION_TTL_MIN_SECONDS = 300;
export const SESSION_TTL_MAX_SECONDS = 86400;
export const SESSION_TTL_DEFAULT_SECONDS = 86400;
/**
 * The default under NEXT_PUBLIC_AUTH_PROVIDER=openshift, 8 hours: the cluster's OAuth server asks for the password on
 * every sign-in, and every gated request is reviewed with the user's own token, so a shorter session buys nothing.
 */
export const SESSION_TTL_OPENSHIFT_DEFAULT_SECONDS = 28800;

const SESSION_TTL_INVALID_MESSAGE = `AUTH_SESSION_TTL_SECONDS must be a whole number of seconds from ${SESSION_TTL_MIN_SECONDS} to ${SESSION_TTL_MAX_SECONDS}.`;

/**
 * The session lifetime in seconds: the JWT's expiry and the auth-token cookie's Max-Age.
 *
 * Reads AUTH_SESSION_TTL_SECONDS on every call; unset or blank keeps the 24-hour default, or 8 hours in openshift
 * sign-in mode (where the access token's expiry also caps a session, src/lib/openshift-auth/session.ts). A set value that is not a
 * plain integer inside the range throws AuthConfigError rather than falling back, and the boot preflight
 * (auth-preflight.ts) stops a standalone start on the same value before any login reaches here.
 */
export function sessionTtlSeconds(): number {
  const raw = process.env.AUTH_SESSION_TTL_SECONDS?.trim();
  if (!raw) {
    return authProviderSetting() === "openshift" ? SESSION_TTL_OPENSHIFT_DEFAULT_SECONDS : SESSION_TTL_DEFAULT_SECONDS;
  }
  const seconds = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!(seconds >= SESSION_TTL_MIN_SECONDS && seconds <= SESSION_TTL_MAX_SECONDS)) {
    throw new AuthConfigError(SESSION_TTL_INVALID_MESSAGE);
  }
  return seconds;
}
