import { withBasePath } from "@/lib/config/base-path";
import { logger } from "@/lib/logger";

/**
 * OIDC_LOGOUT_HINT: whether the OIDC callback keeps the raw ID token in a cookie that only the logout route receives,
 * so the provider's end-session request can carry `id_token_hint` (docs/OIDC.md). Off by default: an installer turns
 * it on only after verifying it against the identity provider it ships.
 */
const LOGOUT_HINT_ON = new Set(["true", "1", "on", "yes"]);
const LOGOUT_HINT_OFF = new Set(["false", "0", "off", "no"]);

export const OIDC_LOGOUT_HINT_COOKIE = "oidc-logout-hint";

/**
 * The largest ID token kept, in bytes. A browser drops a cookie whose name, value and attributes exceed 4096 bytes,
 * so a larger token is not written at all rather than written and silently lost.
 */
const OIDC_LOGOUT_HINT_MAX_BYTES = 3800;

/** True when OIDC_LOGOUT_HINT is on; unset, empty, an off spelling or an unrecognised value leaves it off. */
export function readOidcLogoutHint(): boolean {
  const raw = process.env.OIDC_LOGOUT_HINT;
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return false;
  if (LOGOUT_HINT_ON.has(normalized)) return true;
  if (!LOGOUT_HINT_OFF.has(normalized)) {
    logger.warn(`Unrecognized OIDC_LOGOUT_HINT value "${raw}"; leaving it off (use "true" to turn it on)`, {
      route: "oidc",
    });
  }
  return false;
}

/** The hint cookie's path: only POST <BASE_PATH>/api/auth/logout receives it. */
export function oidcLogoutHintCookiePath(): string {
  return withBasePath("/api/auth/logout");
}

/** Whether an ID token is small enough to keep in the hint cookie. */
export function fitsLogoutHintCookie(idToken: string): boolean {
  return Buffer.byteLength(idToken, "utf8") <= OIDC_LOGOUT_HINT_MAX_BYTES;
}
