/**
 * Studio's cookie scope: whether a cookie carries the Secure flag, and the name and path it takes from that.
 *
 * Whenever a cookie is Secure its name carries the `__Host-` prefix, so a browser accepts it only with Secure, at
 * Path=/ and without a Domain, which makes it host-only. With the flag off (plain HTTP) a browser refuses a `__Host-`
 * name, so the name and path stay as they were. Readers accept only the name of the current mode, and a delete in
 * Secure mode carries Secure, which a browser requires before it removes a `__Host-` cookie.
 *
 * This file imports nothing request-scoped, so src/proxy.ts reads the same name from its own request headers that the
 * route handlers read through `headers()` (src/lib/studio-cookie.ts, `studioCookie`).
 */
import { getBasePath } from "@/lib/config/base-path";
import { logger } from "@/lib/logger";

/** The session cookie's base name. */
export const SESSION_COOKIE = "auth-token";

/** The OIDC sign-in state cookie's base name: the PKCE verifier, state, nonce and return path, between login and callback. */
export const OIDC_STATE_COOKIE = "oidc-state";

export const HOST_COOKIE_PREFIX = "__Host-";

/** Hosts whose traffic never leaves the machine (port is stripped before the check). */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const COOKIE_SECURE_OFF = new Set(["off", "false", "0"]);
const COOKIE_SECURE_ON = new Set(["on", "true", "1"]);

// Hoisted to module scope on one line: bun's line coverage under-counts the
// continuation lines of a wrapped string, which then reads as uncovered code.
const COOKIE_SECURE_DISABLED_MESSAGE =
  "AUTH_COOKIE_SECURE=false: auth cookies drop the Secure flag and travel in cleartext; keep this to trusted networks";

// Weakening the session cookie deserves a line in the log, but the decision
// runs on every request, so the notice is latched to fire once per module
// copy: the proxy holds its own, so a process can print it twice.
let cookieSecurityWarned = false;

/** Test seam: clears the warn-once latch so each case observes a fresh process. */
export function resetCookieSecurityWarning(): void {
  cookieSecurityWarned = false;
}

function warnOnce(message: string): void {
  if (cookieSecurityWarned) return;
  cookieSecurityWarned = true;
  logger.warn(message, { route: "auth" });
}

/**
 * The operator's explicit AUTH_COOKIE_SECURE answer, or undefined to let the
 * environment decide. Spellings follow AUTH_BOOTSTRAP ("off"/"false"/"0" and
 * "on"/"true"/"1", trimmed, case-insensitive); anything else warns and falls
 * through to the default, so a typo never silently flips the security posture.
 */
export function readCookieSecureOverride(): boolean | undefined {
  const raw = process.env.AUTH_COOKIE_SECURE;
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) return undefined;
  if (COOKIE_SECURE_OFF.has(normalized)) return false;
  if (COOKIE_SECURE_ON.has(normalized)) return true;
  // Single-line message: bun's line coverage under-counts the continuation
  // lines of a wrapped call, which then reads as uncovered new code.
  warnOnce(`Unrecognized AUTH_COOKIE_SECURE value "${raw}"; keeping the default (use "false" for plain HTTP)`);
  return undefined;
}

export function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  // Strip the port, then the brackets of an IPv6 literal ("[::1]:3000" -> "::1").
  const hostname = host
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/** The two request headers the decision reads; undefined stands for no request scope. */
export interface CookieRequestView {
  readonly host: string | null;
  readonly forwardedProto: string | null;
}

/**
 * Whether a Studio cookie carries the Secure flag, and so a `__Host-` name.
 *
 * AUTH_COOKIE_SECURE wins whenever it is set. It is needed when the browser's
 * own connection is plain http on a host that is not loopback - a LAN or
 * home-server deployment such as umbrelOS (getumbrel/umbrel-apps#5847), where
 * the browser rejects the Secure cookie and login silently loops. Only the
 * operator can state that: no request-scoped signal proves it, and
 * x-forwarded-proto is attacker-supplied, so trusting it to *drop* the flag
 * would be a downgrade vector. Note that TLS terminated at an ingress does not
 * need this - the browser still speaks https, so it accepts a Secure cookie.
 *
 * Otherwise: Secure in production, with one exception: a request that arrived on
 * a loopback host over plain http. Marking that cookie Secure protects nothing
 * (the traffic never leaves the machine) and actively breaks the desktop shell,
 * because libsoup - the cookie store behind WebKitGTK - discards a Secure cookie
 * delivered over http instead of ignoring the flag the way Chromium does on
 * localhost (issue #232). A proxy that terminated TLS and forwarded to loopback
 * still gets Secure, via x-forwarded-proto. Without a request scope the stricter
 * default holds.
 */
export function secureCookieDecision(request: CookieRequestView | undefined): boolean {
  const override = readCookieSecureOverride();
  if (override === false && process.env.NODE_ENV === "production") {
    warnOnce(COOKIE_SECURE_DISABLED_MESSAGE);
  }
  if (override !== undefined) return override;
  if (process.env.NODE_ENV !== "production") return false;
  if (request === undefined || !isLoopbackHost(request.host)) return true;
  const forwardedProto = request.forwardedProto?.split(",")[0]?.trim().toLowerCase();
  return forwardedProto === "https";
}

/** The name, path and Secure flag one cookie is set, read and deleted with in this request's mode. */
export interface CookieScope {
  readonly name: string;
  readonly path: string;
  readonly secure: boolean;
}

/**
 * The base path's segments joined by dots (`/tools/libredb` gives `.tools.libredb`), or nothing without one. A
 * `__Host-` cookie is always at Path=/, so two Studios on one host under different base paths would otherwise share
 * one name; every character a base path admits (src/lib/config/base-path.ts) is valid in a cookie name.
 */
export function basePathSuffix(): string {
  const segments = getBasePath().split("/").filter(Boolean);
  return segments.length === 0 ? "" : `.${segments.join(".")}`;
}

/** Secure: `__Host-<base name><base path suffix>` at Path=/; plain: the base name at its plain path. */
export function cookieScope(baseName: string, plainPath: string, secure: boolean): CookieScope {
  if (!secure) return { name: baseName, path: plainPath, secure: false };
  return { name: `${HOST_COOKIE_PREFIX}${baseName}${basePathSuffix()}`, path: "/", secure: true };
}

/**
 * The delete of a scoped cookie. Next's delete writes Secure only when it is passed, and a browser ignores a delete of
 * a `__Host-` cookie that lacks it, so Secure mode passes it; plain mode is the name and path alone.
 */
export function cookieDeletion(scope: CookieScope): { name: string; path: string; secure?: true } {
  return scope.secure ? { name: scope.name, path: scope.path, secure: true } : { name: scope.name, path: scope.path };
}
