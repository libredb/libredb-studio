import { getBasePath } from "@/lib/config/base-path";
import { SignJWT, jwtVerify } from "jose";
import { cookies, headers } from "next/headers";
import { logger } from "@/lib/logger";
import { getJwtSecret } from "@/lib/config/auth-env";
import { storedAccountAllows } from "@/lib/local-accounts";

// getJwtSecret is called per sign/verify rather than at module load, so a
// misconfigured JWT_SECRET surfaces as an AuthConfigError the login route can turn
// into a clear on-screen 503 instead of a misleading "Invalid email or password" —
// and never as a module-level throw, which would crash every importer of auth.ts.
//
// The result is deliberately NOT memoized. The reader is stateless (auth-env.ts), a
// TextEncoder pass is nothing next to the HMAC that follows, and the other consumers
// (oidc.ts, drive-token.ts, storage/encryption.ts) all call it fresh. A module-level
// cache would hold only SUCCESSFUL reads, so any earlier signature in the process
// would answer before the guard ran — silently unobservable in production and, in a
// shared-process test run, the reason the config-guard cases could not fail.

export type Role = "admin" | "user";

export interface UserPayload {
  role: Role;
  username: string;
  /**
   * Set only on sessions for an account in the server store (src/lib/local-accounts.ts), and
   * compared with that account's current value on every request. Env and OIDC sessions omit it.
   */
  sessionVersion?: number;
}

export async function signJWT(payload: UserPayload) {
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("24h")
    .sign(getJwtSecret());
}

export async function verifyJWT(token: string) {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    return payload as unknown as UserPayload;
  } catch (error) {
    if (error instanceof Error) {
      if (error.message.includes("expired")) {
        logger.debug("JWT token expired", { route: "auth" });
      } else {
        logger.warn("JWT verification failed", { route: "auth" });
      }
    }
    return null;
  }
}

export async function getSession() {
  const cookieStore = await cookies();
  const token = cookieStore.get("auth-token")?.value;
  if (!token) return null;
  const session = await verifyJWT(token);
  if (!session) return null;
  // The token is valid for 24 hours whatever happens to the account, so a stored account is read
  // again here: disabled, deleted, demoted or password-reset means this session is over. A registry
  // that cannot be read refuses the session rather than trusting a token it cannot check.
  try {
    return (await storedAccountAllows(session)) ? session : null;
  } catch (error) {
    logger.error("Could not read the account registry, refusing the session", error, { route: "auth" });
    return null;
  }
}

/** Hosts whose traffic never leaves the machine (port is stripped before the check). */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

const COOKIE_SECURE_OFF = new Set(["off", "false", "0"]);
const COOKIE_SECURE_ON = new Set(["on", "true", "1"]);

// Hoisted to module scope on one line: bun's line coverage under-counts the
// continuation lines of a wrapped string, which then reads as uncovered code.
const COOKIE_SECURE_DISABLED_MESSAGE =
  "AUTH_COOKIE_SECURE=false: auth cookies drop the Secure flag and travel in cleartext; keep this to trusted networks";

// Weakening the session cookie deserves a line in the log, but shouldMarkCookieSecure()
// runs on every login, so the notice is latched to fire once per process.
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
function readCookieSecureOverride(): boolean | undefined {
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

function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  // Strip the port, then the brackets of an IPv6 literal ("[::1]:3000" -> "::1").
  const hostname = host
    .replace(/:\d+$/, "")
    .replace(/^\[|\]$/g, "")
    .toLowerCase();
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * Whether an auth cookie should carry the Secure flag.
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
 * still gets Secure, via x-forwarded-proto.
 */
export async function shouldMarkCookieSecure(): Promise<boolean> {
  const override = readCookieSecureOverride();
  if (override === false && process.env.NODE_ENV === "production") {
    warnOnce(COOKIE_SECURE_DISABLED_MESSAGE);
  }
  if (override !== undefined) return override;
  if (process.env.NODE_ENV !== "production") return false;
  try {
    const headerStore = await headers();
    if (!isLoopbackHost(headerStore.get("host"))) return true;
    const forwardedProto = headerStore.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    return forwardedProto === "https";
  } catch {
    // No request scope (headers() throws): keep the stricter default.
    return true;
  }
}

export async function login(role: Role, username?: string, sessionVersion?: number) {
  const token = await signJWT({ role, username: username || role, sessionVersion });
  const cookieStore = await cookies();
  cookieStore.set("auth-token", token, {
    httpOnly: true,
    secure: await shouldMarkCookieSecure(),
    // Must stay "lax" and must NOT be tightened to "strict": the OIDC callback depends on lax's
    // top-level-GET exception to return the oidc-state cookie. The cases lax does not cover -
    // notably a cross-site POST /api/auth/login, where there is no pre-existing cookie to withhold
    // - are covered by the Origin check in src/proxy.ts (src/lib/api/origin-check.ts).
    sameSite: "lax",
    maxAge: 60 * 60 * 24, // 1 day
    path: getBasePath() || "/",
  });
}

export async function logout() {
  const cookieStore = await cookies();
  cookieStore.delete({ name: "auth-token", path: getBasePath() || "/" });
}
