/**
 * Local authentication provider — resolves the admin (and optional user)
 * accounts from environment variables. This is the counterpart to `oidc.ts`;
 * shared session/JWT concerns live in `auth.ts`.
 */
import type { Role } from "@/lib/auth";
import { AuthConfigError } from "@/lib/auth-errors";
import { decodeBase32, TOTP_MIN_SECRET_BYTES } from "@/lib/totp";

export interface AuthUser {
  email: string;
  password: string;
  role: Role;
  /**
   * Base32 TOTP secret for this account, when the operator configured one. Absent means the
   * account authenticates with its password alone — MFA is opt-in per account, so an admin can
   * be protected while an automation-owned lower-privilege account is not.
   */
  totpSecret?: string;
}

// Single-line and module-scoped so bun's line coverage credits it cleanly (it
// under-counts continuation lines of multi-line string concatenation).
const ADMIN_PASSWORD_MISSING_MESSAGE =
  "Login is unavailable: this server has no administrator password configured. Set the ADMIN_PASSWORD environment variable and restart the server.";

// Second half of the invalid-secret message; the variable name is prefixed at the throw site.
const TOTP_SECRET_INVALID_HINT =
  "is not a valid base32 secret. Copy the secret exactly as your authenticator app shows it (letters A-Z and digits 2-7 only) and restart the server.";

// Same shape, for a secret that decodes cleanly but carries too little entropy to be a factor.
const TOTP_SECRET_SHORT_HINT = `is too short: RFC 4226 requires a shared secret of at least ${TOTP_MIN_SECRET_BYTES * 8} bits. Generate one with "openssl rand 20 | base32" and restart the server.`;

/**
 * Read one account's TOTP secret, rejecting a secret that could never protect anything.
 *
 * Two ways a configured value is wrong, and both have to be fatal rather than ignored. A
 * malformed secret would refuse every correct code the operator's phone produces; a secret below
 * the RFC's minimum would accept them all while being worth almost nothing. Neither is
 * diagnosable from an "Invalid email or password" screen, and silently dropping the factor in
 * either case would leave a deployment that believes it has MFA and does not. So both become an
 * AuthConfigError and the login route renders the message as a 503 naming the variable.
 *
 * @throws {AuthConfigError} when the variable is not base32, or decodes below the RFC minimum.
 */
function readTotpSecret(variable: string): string | undefined {
  const raw = process.env[variable]?.trim();
  // Unset and empty are the same answer — no second factor — so an operator can disable MFA by
  // blanking the variable rather than having to unset it, which some orchestrators cannot do.
  if (!raw) return undefined;
  const decoded = decodeBase32(raw);
  if (!decoded) throw new AuthConfigError(`Login is unavailable: ${variable} ${TOTP_SECRET_INVALID_HINT}`);
  // Measured on the decoded bytes, never on the pasted string: spaces, hyphens and `=` padding are
  // presentation that decodeBase32 strips, so a grouped short secret must not read as long enough.
  if (decoded.length < TOTP_MIN_SECRET_BYTES)
    throw new AuthConfigError(`Login is unavailable: ${variable} ${TOTP_SECRET_SHORT_HINT}`);
  return raw;
}

/**
 * Build the list of accounts that can authenticate against the local provider.
 * ADMIN_PASSWORD is required; the lower-privilege user account is optional and
 * exists only when USER_PASSWORD is set. We never invent a default password —
 * a baked-in default would be a publicly known credential on every deployment.
 *
 * @throws {AuthConfigError} when ADMIN_PASSWORD is not configured.
 */
export function getAuthUsers(): AuthUser[] {
  const adminEmail = process.env.ADMIN_EMAIL || "admin@libredb.org";
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminPassword) {
    throw new AuthConfigError(ADMIN_PASSWORD_MISSING_MESSAGE);
  }

  const users: AuthUser[] = [
    { email: adminEmail, password: adminPassword, role: "admin", totpSecret: readTotpSecret("ADMIN_TOTP_SECRET") },
  ];

  // USER_TOTP_SECRET is read only when the account it protects exists. Set without USER_PASSWORD
  // it is inert rather than a hole: with no password there is no user account to log into at all.
  const userPassword = process.env.USER_PASSWORD;
  if (userPassword) {
    const userEmail = process.env.USER_EMAIL || "user@libredb.org";
    users.push({
      email: userEmail,
      password: userPassword,
      role: "user",
      totpSecret: readTotpSecret("USER_TOTP_SECRET"),
    });
  }

  return users;
}
