/**
 * Shared authentication error types. Kept in a dependency-free leaf module (like
 * `@/lib/db/errors`) so both the shared auth layer (`auth.ts`) and the local
 * provider (`local-auth.ts`) can throw it without creating a circular
 * provider <-> shared dependency.
 */

/**
 * Raised when authentication cannot be served because the server is misconfigured
 * (e.g. no ADMIN_PASSWORD, or a missing/too-short JWT_SECRET). This is a
 * deployment/operator error, not a bad-credentials error.
 *
 * Its `message` is written to be shown directly to the operator on the login
 * screen, so the login route turns it into a clear, actionable 503 instead of a
 * misleading "Invalid email or password".
 */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
}
