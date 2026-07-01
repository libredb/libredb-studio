/**
 * Local authentication provider — resolves the admin (and optional user)
 * accounts from environment variables. This is the counterpart to `oidc.ts`;
 * shared session/JWT concerns live in `auth.ts`.
 */
import type { Role } from "@/lib/auth";
import { AuthConfigError } from "@/lib/auth-errors";

export interface AuthUser {
  email: string;
  password: string;
  role: Role;
}

// Single-line and module-scoped so bun's line coverage credits it cleanly (it
// under-counts continuation lines of multi-line string concatenation).
const ADMIN_PASSWORD_MISSING_MESSAGE =
  "Login is unavailable: this server has no administrator password configured. Set the ADMIN_PASSWORD environment variable and restart the server.";

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

  const users: AuthUser[] = [{ email: adminEmail, password: adminPassword, role: "admin" }];

  const userPassword = process.env.USER_PASSWORD;
  if (userPassword) {
    const userEmail = process.env.USER_EMAIL || "user@libredb.org";
    users.push({ email: userEmail, password: userPassword, role: "user" });
  }

  return users;
}
