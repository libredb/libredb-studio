import { logger } from "@/lib/logger";

/**
 * OIDC_AUTO_REDIRECT: whether GET /login under NEXT_PUBLIC_AUTH_PROVIDER=oidc sends a signed-out
 * visitor straight to the identity provider instead of showing the single sign-on button
 * (docs/OIDC.md). src/proxy.ts reads it on every /login request, so this module must import
 * nothing from openid-client or src/lib/oidc.ts.
 */
const AUTO_REDIRECT_ON = new Set(["true", "1", "on", "yes"]);
const AUTO_REDIRECT_OFF = new Set(["false", "0", "off", "no"]);

// The proxy reads the flag on every /login request, so a typo is reported once per process.
let warned = false;

/** Test seam: clears the warn-once latch so each case observes a fresh process. */
export function resetOidcAutoRedirectWarning(): void {
  warned = false;
}

/** True when OIDC_AUTO_REDIRECT is on; unset, empty, an off spelling or an unrecognised value leaves it off. */
export function readOidcAutoRedirect(): boolean {
  const raw = process.env.OIDC_AUTO_REDIRECT;
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return false;
  if (AUTO_REDIRECT_ON.has(normalized)) return true;
  if (!AUTO_REDIRECT_OFF.has(normalized) && !warned) {
    warned = true;
    logger.warn(`Unrecognized OIDC_AUTO_REDIRECT value "${raw}"; leaving it off (use "true" to turn it on)`, {
      route: "proxy",
    });
  }
  return false;
}
