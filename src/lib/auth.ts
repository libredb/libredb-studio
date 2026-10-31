import { getBasePath } from "@/lib/config/base-path";
import { SignJWT, jwtVerify } from "jose";
import { cookies, headers } from "next/headers";
import { logger } from "@/lib/logger";
import { getJwtSecret, sessionTtlSeconds } from "@/lib/config/auth-env";
import { AUTH_PROVIDER_INVALID_MESSAGE, authProvider, authProviderSetting } from "@/lib/config/auth-provider";
import { accessReviewEnabled } from "@/lib/kubernetes-access/config";
import { reviewedSessionRole } from "@/lib/kubernetes-access/gate";
import {
  ACCESS_REVIEW_RETRY_COOKIE,
  ACCESS_REVIEW_RETRY_MAX_AGE_SECONDS,
  type GroupsRecordCheck,
  groupsRecordCheck,
  sessionRecordCheck,
} from "@/lib/kubernetes-access/session-guard";
import { AuthConfigError } from "@/lib/auth-errors";
import { storedAccountAllows } from "@/lib/local-accounts";
import { authenticateBearer } from "@/lib/oidc-bearer";
import { openShiftRecordCheck } from "@/lib/openshift-auth/session";
import { type CookieScope, SESSION_COOKIE, cookieDeletion, cookieScope } from "@/lib/auth-cookies";
import { studioCookie } from "@/lib/studio-cookie";

export { isLoopbackHost, readCookieSecureOverride, resetCookieSecurityWarning } from "@/lib/auth-cookies";

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
  /**
   * The ID token's `sub`, set only on sessions the OIDC callback mints; password, passkey and
   * launch sessions omit it. A private name, because the registered `sub` already holds the
   * username in MCP tokens (src/lib/mcp/token.ts), and `username` keeps its display meaning.
   */
  idpSubject?: string;
  /** The ID token's `iss`, set together with `idpSubject`. */
  idpIssuer?: string;
  /**
   * Set only on sessions openshift sign-in mints (src/lib/openshift-auth/), where `idpSubject` is the user's uid and
   * `idpIssuer` the OAuth issuer: the random key of the server-side record that holds the user's access token. Never
   * returned by /api/auth/me. A session carrying one reads as signed out in every other mode.
   */
  sessionHandle?: string;
  /**
   * Set only on a session an identity provider's access token stands for (src/lib/oidc-bearer.ts), never signed into
   * a cookie. A route that would write the session cookie or mint a credential from the session reads it.
   */
  channel?: "bearer";
  /**
   * Custom roles extracted from OIDC_ROLE_CLAIM matching OIDC_ROLE_PREFIX. Set only by the
   * OIDC callback and only when non-empty.
   */
  claimRoles?: string[];
}

export async function signJWT(payload: UserPayload, lifetimeSeconds = sessionTtlSeconds()) {
  // One clock reading for both claims, so exp minus iat is exactly the lifetime.
  const issuedAt = Math.floor(Date.now() / 1000);
  return await new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + lifetimeSeconds)
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

export type SessionReading =
  | { readonly kind: "authenticated"; readonly session: UserPayload }
  | { readonly kind: "anonymous" }
  | { readonly kind: "store_unavailable"; readonly error: unknown };

/**
 * The log line of an account check that threw; the session fails closed either way. Under an unknown sign-in mode the
 * check refuses before any registry is read, so the line names the setting instead of reporting a store outage.
 */
function logAccountCheckFailure(error: unknown): void {
  if (error instanceof AuthConfigError && authProviderSetting() === "invalid") {
    logger.error(`Refusing every session: ${AUTH_PROVIDER_INVALID_MESSAGE}`, undefined, { route: "auth" });
    return;
  }
  logger.error("Could not read the account registry, store unavailable", error, { route: "auth" });
}

export async function readSession(): Promise<SessionReading> {
  // A Bearer header decides alone while the channel is on, even next to a valid cookie, and with it on or off the
  // cookie is never touched here. Absent, the cookie decides as it always did.
  const headerList = await headers();
  const authHeader = headerList.get("authorization");
  const bearer = await authenticateBearer(authHeader);
  if (bearer.kind === "fault") {
    logger.error("Could not verify a bearer access token; refusing", bearer.error, { route: "auth" });
    return { kind: "anonymous" };
  }
  if (bearer.kind === "denied") return { kind: "anonymous" };
  if (bearer.kind === "authenticated") {
    // Under governance the access token's subject, issuer and own iat meet the same rule as a cookie session's.
    try {
      const allowed = await storedAccountAllows(bearer.session);
      return allowed ? { kind: "authenticated", session: bearer.session } : { kind: "anonymous" };
    } catch (error) {
      logAccountCheckFailure(error);
      return { kind: "store_unavailable", error };
    }
  }

  const cookieStore = await cookies();
  const token = cookieStore.get((await sessionCookie()).name)?.value;
  if (!token) return { kind: "anonymous" };
  const session = await verifyJWT(token);
  if (!session) return { kind: "anonymous" };
  // The token is valid for 24 hours whatever happens to the account, so a stored account is read
  // again here: disabled, deleted, demoted or password-reset means this session is over. A registry
  // that cannot be read reports an outage (store_unavailable) rather than refusing a valid session
  // or clearing its cookie (#1942).
  let allowed: boolean;
  try {
    allowed = await storedAccountAllows(session);
  } catch (error) {
    logAccountCheckFailure(error);
    return { kind: "store_unavailable", error };
  }
  const served = allowed ? await sessionWithRecord(cookieStore, session) : null;
  if (served !== null) return { kind: "authenticated", session: served };
  // The proxy verifies only the signature, so a refused cookie would keep sending /login back to
  // the editor. Clearing it here, on the route's response, lets the next navigation reach login.
  await logout();
  return { kind: "anonymous" };
}

/**
 * The session a verified cookie stands for once the server-side record it needs in this mode is checked, or null when
 * it is refused, settling the retry marker.
 */
async function sessionWithRecord(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
  session: UserPayload & { iat?: number },
): Promise<UserPayload | null> {
  const marker = cookieStore.get((await retryMarkerCookie()).name)?.value;
  if (authProvider() === "openshift") return openShiftSessionWithRole(cookieStore, session, marker);
  // A session openshift sign-in minted reads as signed out in every other mode: no marker, the cookie cleared.
  if (session.sessionHandle !== undefined) return null;
  if (!accessReviewEnabled()) return session;
  // With the Kubernetes access review on, no review runs without the groups record of the session's subject, which
  // only this process's memory holds: a session that lost it signs in again, and one without a subject has none
  // (src/lib/kubernetes-access/session-guard.ts).
  const kept = await settleRecordCheck(cookieStore, groupsRecordCheck(session, marker), GROUPS_RECORD_MISS_MESSAGE);
  return kept ? session : null;
}

/**
 * openshift mode: signed in only while the token record under the session's handle is live and bound to its uid, name
 * and issuer (src/lib/openshift-auth/session.ts); a session of another mode has no handle, and the groups check never
 * runs here. A live session then runs with the role the access review gives this request
 * (src/lib/kubernetes-access/gate.ts, `reviewedSessionRole`): an admin session keeps admin only while its own token
 * may update Studio's Deployment or LibreDBStudio resource, and is signed out when the API server refuses the token.
 * The retry marker is settled only once that role is known, and a refused token settles it from the marker this
 * request carried, so a session minted after the marker that meets a refused token trips the loop guard instead of
 * arming the marker again.
 */
async function openShiftSessionWithRole(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
  session: UserPayload & { iat?: number },
  marker: string | undefined,
): Promise<UserPayload | null> {
  const check = openShiftRecordCheck(session, marker);
  if (check.kind === "refused") {
    await settleRecordCheck(cookieStore, check, OPENSHIFT_RECORD_MISS_MESSAGE);
    return null;
  }
  const role = await reviewedSessionRole(session);
  if (role === "expired") {
    await settleRecordCheck(
      cookieStore,
      sessionRecordCheck("missing", session.iat, marker),
      OPENSHIFT_RECORD_MISS_MESSAGE,
    );
    return null;
  }
  await settleRecordCheck(cookieStore, check, OPENSHIFT_RECORD_MISS_MESSAGE);
  return role === session.role ? session : { ...session, role };
}

const GROUPS_RECORD_MISS_MESSAGE = "Kubernetes access review: the session has no groups record, so it signs in again";
const OPENSHIFT_RECORD_MISS_MESSAGE = "OpenShift sign-in: the session has no live token record, so it signs in again";

/**
 * Applies a record check to the retry marker: a kept session clears a marker an earlier miss left and answers true; a
 * refused one sets the marker the check asks for, logs the miss and answers false, so the caller clears its cookie.
 */
async function settleRecordCheck(
  cookieStore: Awaited<ReturnType<typeof cookies>>,
  check: GroupsRecordCheck,
  missMessage: string,
): Promise<boolean> {
  const marker = await retryMarkerCookie();
  if (check.kind === "kept") {
    if (check.clearMarker) cookieStore.delete(cookieDeletion(marker));
    return true;
  }
  if (check.marker !== null) {
    cookieStore.set(marker.name, check.marker, {
      httpOnly: true,
      secure: marker.secure,
      sameSite: "lax",
      maxAge: ACCESS_REVIEW_RETRY_MAX_AGE_SECONDS,
      path: marker.path,
    });
  }
  logger.info(missMessage, { route: "auth", loop: check.marker === "loop" });
  return false;
}

/**
 * The session the request's own cookie carries, verified by its signature alone: no account registry, governance or
 * record check. Only the OpenShift callback uses it, to end the token record a replaced cookie names, so a copy of
 * that cookie stops working; it is never a route's session check, which is readSession.
 */
export async function verifiedSessionCookie(): Promise<UserPayload | null> {
  const token = (await cookies()).get((await sessionCookie()).name)?.value;
  return token === undefined ? null : verifyJWT(token);
}

export async function getSession(): Promise<UserPayload | null> {
  const reading = await readSession();
  return reading.kind === "authenticated" ? reading.session : null;
}

function sessionCookie(): Promise<CookieScope> {
  return studioCookie(SESSION_COOKIE, getBasePath() || "/");
}

/**
 * In Secure mode, deletes the plain-named session cookie a browser upgraded from plain names may still hold. It is
 * never read in that mode, but it is still a signed session: a rollback, or AUTH_COOKIE_SECURE=false, within its
 * Max-Age would read it again, so sign-in and sign-out delete it. Plain mode has nothing to delete beside its own.
 */
function deletePlainSessionCookie(cookieStore: Awaited<ReturnType<typeof cookies>>, scope: CookieScope): void {
  if (!scope.secure) return;
  cookieStore.delete(cookieDeletion(cookieScope(SESSION_COOKIE, getBasePath() || "/", false)));
}

/** The access review's retry marker (src/lib/kubernetes-access/session-guard.ts), scoped like the session cookie. */
function retryMarkerCookie(): Promise<CookieScope> {
  return studioCookie(ACCESS_REVIEW_RETRY_COOKIE, getBasePath() || "/");
}

export async function login(
  role: Role,
  username?: string,
  sessionVersion?: number,
  identity?: { subject: string; issuer: string; sessionHandle?: string },
  claimRoles?: string[],
  lifetimeSeconds?: number,
) {
  // Only the OIDC and OpenShift callbacks pass an identity, so every other sign-in signs exactly the claims it did
  // before; only the OpenShift callback passes a session handle and a lifetime (the token's expiry caps it).
  const idp = identity ? { idpSubject: identity.subject, idpIssuer: identity.issuer } : {};
  const handle = identity?.sessionHandle === undefined ? {} : { sessionHandle: identity.sessionHandle };
  const claims = claimRoles && claimRoles.length > 0 ? { claimRoles } : {};
  const lifetime = lifetimeSeconds ?? sessionTtlSeconds();
  const token = await signJWT(
    { role, username: username || role, sessionVersion, ...idp, ...handle, ...claims },
    lifetime,
  );
  const cookieStore = await cookies();
  const scope = await sessionCookie();
  cookieStore.set(scope.name, token, {
    httpOnly: true,
    secure: scope.secure,
    // Must stay "lax" and must NOT be tightened to "strict": the OIDC callback depends on lax's
    // top-level-GET exception to return the oidc-state cookie. The cases lax does not cover -
    // notably a cross-site POST /api/auth/login, where there is no pre-existing cookie to withhold
    // - are covered by the Origin check in src/proxy.ts (src/lib/api/origin-check.ts).
    sameSite: "lax",
    maxAge: lifetime,
    path: scope.path,
  });
  deletePlainSessionCookie(cookieStore, scope);
}

export async function logout() {
  const cookieStore = await cookies();
  const scope = await sessionCookie();
  cookieStore.delete(cookieDeletion(scope));
  deletePlainSessionCookie(cookieStore, scope);
}
