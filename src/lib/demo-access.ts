/**
 * Public demo access — a single opt-in switch for showcase instances.
 *
 * A visitor arriving at a public instance has no account and no way to see the
 * product. `DEMO_MODE` opens a one-click session for them. It is deliberately
 * not a credential: there is nobody to authenticate, so a password would be a
 * shared constant between two variables on the same server rather than a check.
 * The gate is the switch, and the switch is off unless an operator turns it on.
 */
import type { Role } from "@/lib/auth";

// Same vocabulary as AUTH_COOKIE_SECURE and AUTH_BOOTSTRAP.
const ENABLED_VALUES = new Set(["on", "true", "1"]);

/** The identity a demo session carries. Not an account — nothing authenticates against it. */
export const DEMO_ACCOUNT_EMAIL = "demo@libredb.org";

/** True when this server offers public demo access. Off unless DEMO_MODE says otherwise. */
export function isDemoEnabled(): boolean {
  const raw = process.env.DEMO_MODE?.trim().toLowerCase();
  return raw !== undefined && ENABLED_VALUES.has(raw);
}

/**
 * The role a demo visitor receives. `user` unless an operator deliberately asks
 * for `admin` — an unrecognized value is not worth failing a boot over, and the
 * safe reading of "I do not understand this" is the lower privilege.
 */
export function getDemoRole(): Role {
  return process.env.DEMO_ROLE?.trim().toLowerCase() === "admin" ? "admin" : "user";
}
