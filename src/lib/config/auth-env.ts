/**
 * Single source of truth for reading JWT_SECRET from the environment.
 *
 * Consolidates the three readers that previously drifted apart (auth.ts,
 * proxy.ts, oidc.ts) into one module with the strictest semantics:
 * - missing in production -> AuthConfigError (login route maps it to a clear 503)
 * - missing outside production -> well-known development fallback (with warning)
 * - present but shorter than 32 characters -> AuthConfigError
 *
 * The reader is stateless and reads the environment on every call; consumers
 * that want memoization keep their own lazy cache so a module-level throw can
 * never take down unrelated imports.
 */

import { AuthConfigError } from "@/lib/auth-errors";

// Single-line messages, hoisted to module scope: bun's line coverage under-counts
// the continuation lines of multi-line string concatenation, which would show as
// uncovered "new code" in SonarCloud even though the throw is exercised by tests.
export const JWT_SECRET_MISSING_MESSAGE =
  "Login is unavailable: the server's JWT_SECRET is not configured. Set JWT_SECRET (at least 32 characters) and restart the server.";
export const JWT_SECRET_TOO_SHORT_MESSAGE =
  "Login is unavailable: the server's JWT_SECRET is too short; it must be at least 32 characters. Update JWT_SECRET and restart the server.";

/**
 * Minimum accepted JWT_SECRET length. Single source of truth: the boot preflight
 * (auth-preflight.ts) and the bootstrap file reader (auth-bootstrap.ts) enforce
 * the same number, so a secret that passes startup can never fail at login.
 */
export const JWT_SECRET_MIN_LENGTH = 32;

const DEV_FALLBACK_SECRET = "development-fallback-secret-32ch";

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
