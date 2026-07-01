/**
 * Local authentication provider — resolves the admin (and optional user)
 * accounts from environment variables. This is the counterpart to `oidc.ts`;
 * shared session/JWT concerns live in `auth.ts`.
 */
import type { Role } from "@/lib/auth";

export interface AuthUser {
  email: string;
  password: string;
  role: Role;
}

/**
 * Raised when local authentication cannot be served because the server is
 * missing required config (no ADMIN_PASSWORD). It is a deployment/operator
 * error, not a bad-credentials error — the login route turns it into a clear,
 * actionable 503 so the operator sees WHAT to fix on the login screen instead
 * of a misleading "Invalid email or password".
 */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthConfigError";
  }
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
    throw new AuthConfigError("ADMIN_PASSWORD is not set");
  }

  const users: AuthUser[] = [{ email: adminEmail, password: adminPassword, role: "admin" }];

  const userPassword = process.env.USER_PASSWORD;
  if (userPassword) {
    const userEmail = process.env.USER_EMAIL || "user@libredb.org";
    users.push({ email: userEmail, password: userPassword, role: "user" });
  }

  return users;
}
