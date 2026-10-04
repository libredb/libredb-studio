import { ApiErrorCode } from "@/lib/api/error-codes";

/**
 * The one answer an API route gives a request that has no session, or whose session no longer
 * verifies (#1420). The code, not the status, is what the browser keys on: 401 is also how a route
 * reports a wrong DATABASE password (AUTH_ERROR) or a rejected model key (LLM_AUTH), and sending
 * the user to sign in for either would be wrong. The proxy and every route-level session check
 * answer with this body, so the client has one thing to recognise: appFetch in
 * src/lib/config/base-path.ts.
 */
export function sessionRequiredBody(error: string) {
  return { error, code: ApiErrorCode.AUTH_REQUIRED };
}

/** The query parameter /login reads its return path from. */
export const RETURN_PATH_PARAM = "next";

/**
 * In UTF-8 bytes, not characters: the path rides in the signed OIDC state cookie, and a value of
 * multi-byte characters under a character cap could still push that cookie past the browser's
 * 4 KB limit, which drops it and fails the sign-in.
 */
const MAX_RETURN_PATH_BYTES = 1024;
// oxlint-disable-next-line no-control-regex -- control characters are exactly what a return path may not hold
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const PROBE_ORIGIN = "https://studio.invalid";

/**
 * A return path is only ever an app-relative path, judged on the path it RESOLVES to rather than
 * the string as written: `/..//evil.example` and `/%2e%2e//evil.example` are written with one
 * leading slash and resolve to `//evil.example`, which a browser reads as another host. So the
 * value is parsed first, must stay on this origin, must not resolve to a path starting `//`, and
 * must not be the sign-in page itself; the normalized form is what is returned. No backslash, no
 * control character. Anything else is dropped rather than repaired, and the caller falls back to
 * its default landing page, so a crafted sign-in link cannot turn into an open redirect.
 */
export function safeReturnPath(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !value.startsWith("/")) return null;
  if (new TextEncoder().encode(value).length > MAX_RETURN_PATH_BYTES) return null;
  if (value.includes("\\") || CONTROL_CHARACTER.test(value)) return null;
  const url = new URL(value, PROBE_ORIGIN);
  if (url.origin !== PROBE_ORIGIN || url.pathname.startsWith("//")) return null;
  if (url.pathname === "/login" || url.pathname.startsWith("/login/")) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** sessionStorage key of the last session-ended redirect, read by claimSignInRedirect. */
const LAST_SIGN_IN_REDIRECT_KEY = "libredb.signInRedirectAt";
const SIGN_IN_REDIRECT_COOLDOWN_MS = 10_000;

/**
 * Whether this tab may go to the sign-in page now, recording it when it may. One redirect per ten
 * seconds: a session the server refuses while the token still verifies (the account registry could
 * not be read, so the cookie is not cleared) is sent from /login straight back by the proxy, and
 * would answer 401 again, round and round. The second refusal inside the window stays on the page
 * as an error instead. Without sessionStorage there is no guard, and the redirect always goes.
 */
export function claimSignInRedirect(now = Date.now()): boolean {
  try {
    const last = Number(window.sessionStorage.getItem(LAST_SIGN_IN_REDIRECT_KEY));
    if (last > 0 && now - last >= 0 && now - last < SIGN_IN_REDIRECT_COOLDOWN_MS) return false;
    window.sessionStorage.setItem(LAST_SIGN_IN_REDIRECT_KEY, String(now));
  } catch {
    // Storage blocked (private mode, sandboxed frame): redirect without the guard.
  }
  return true;
}

/** The app-relative sign-in path that returns to `returnPath` afterwards, when it is a safe one. */
export function signInPath(returnPath: string): string {
  const safe = safeReturnPath(returnPath);
  return safe === null ? "/login" : `/login?${RETURN_PATH_PARAM}=${encodeURIComponent(safe)}`;
}
