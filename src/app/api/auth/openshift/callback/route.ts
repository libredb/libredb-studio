/**
 * GET /api/auth/openshift/callback: the end of openshift sign-in (NEXT_PUBLIC_AUTH_PROVIDER=openshift).
 *
 * Outside the mode, and on any path but the exact callback (the OAuth server also delivers codes to longer paths under
 * it), the 404 of an unknown path, with no cookie read and no call made. In the mode: the signed state cookie, the
 * consent answer, the state value, the OAuth metadata, the code exchange (whose granted scope must be exactly the pin
 * before the token is used for anything), users/~, the sign-in role; then the record of a session this browser's
 * verified cookie still names is ended, the new token is stored under a new random handle and the session cookie is
 * minted with one lifetime for both (the session lifetime capped by the token's expiry). Every outcome after the state
 * cookie was read deletes it; every refusal lands on the login page with its code; every answer is `no-store`. Nothing
 * the cluster said, no token and no error object is logged or shown.
 */

import { cookies } from "next/headers";
import type { NextResponse } from "next/server";
import { clientAddress } from "@/lib/api/client-address";
import { safeReturnPath } from "@/lib/api/session-ended";
import { login, verifiedSessionCookie } from "@/lib/auth";
import { AuthConfigError } from "@/lib/auth-errors";
import { authProviderSetting } from "@/lib/config/auth-provider";
import { withBasePath } from "@/lib/config/base-path";
import { logger } from "@/lib/logger";
import { OPENSHIFT_CALLBACK_PATH, openShiftPublicUrl } from "@/lib/openshift-auth/config";
import { type ExchangeOutcome, exchangeOpenShiftCode } from "@/lib/openshift-auth/flow";
import { type IdentityReading, readOpenShiftIdentity } from "@/lib/openshift-auth/identity";
import { readOpenShiftMetadata } from "@/lib/openshift-auth/metadata";
import { type OpenShiftSignInCode, openShiftLoginPageLocation } from "@/lib/openshift-auth/redirect";
import {
  auditSignInFailure,
  auditSignInSuccess,
  metadataFailureCode,
  notFound,
  redirectNoStore,
} from "@/lib/openshift-auth/responses";
import { openShiftSignInRole } from "@/lib/openshift-auth/role";
import { newSessionHandle, openShiftSessionLifetimeSeconds } from "@/lib/openshift-auth/session";
import {
  decryptOpenShiftState,
  OPENSHIFT_STATE_COOKIE,
  type OpenShiftState,
  openShiftStateCookiePath,
} from "@/lib/openshift-auth/state";
import { endOpenShiftSession, storeOpenShiftSession } from "@/lib/openshift-auth/token-store";

const ROUTE = "GET /api/auth/openshift/callback";

/** Where the sign-in ends: a refusal code (with the user name once users/~ answered), or the page to land on. */
type SignInResult = { readonly code: OpenShiftSignInCode; readonly user?: string } | { readonly location: string };

function exchangeFailureCode(outcome: Exclude<ExchangeOutcome, { kind: "token" }>): OpenShiftSignInCode {
  if (outcome.kind === "scope") {
    logger.warn("OpenShift sign-in: the granted scope is not the one asked for, so the token is not used", {
      route: ROUTE,
      step: "token",
      granted: outcome.granted,
    });
    return "openshift_scope";
  }
  if (outcome.reason === "config") {
    logger.error("OpenShift sign-in: the client secret file cannot be read", undefined, {
      route: ROUTE,
      step: "token",
    });
    return "openshift_config";
  }
  logger.warn("OpenShift sign-in: the token request failed", { route: ROUTE, step: "token", reason: outcome.reason });
  return outcome.reason === "unreachable" ? "openshift_unreachable" : "openshift_failed";
}

function identityFailureCode(reading: Exclude<IdentityReading, { kind: "ok" }>): OpenShiftSignInCode {
  const fields = { route: ROUTE, step: "user" };
  switch (reading.kind) {
    case "external-oidc":
      logger.warn("OpenShift sign-in: the cluster serves no users/~, so it signs in through external OIDC", fields);
      return "openshift_external_oidc";
    case "unreachable":
      logger.warn("OpenShift sign-in: the API server did not answer users/~", {
        ...fields,
        reason: reading.reason,
        status: reading.status,
      });
      return "openshift_unreachable";
    case "no-uid":
      logger.warn("OpenShift sign-in: users/~ gave no usable uid or name", fields);
      return "openshift_no_uid";
    case "failed":
      // A 403 after the scope was accepted means the cluster refuses user:info to this client: a configuration fault.
      if (reading.status === 403)
        logger.error("OpenShift sign-in: users/~ answered 403", undefined, { ...fields, status: 403 });
      else logger.warn("OpenShift sign-in: users/~ refused the token", { ...fields, status: reading.status });
      return "openshift_failed";
  }
}

/** Ends the record a verified session cookie of this browser names, so a copy of the replaced cookie stops working. */
async function endReplacedSession(): Promise<void> {
  const replaced = await verifiedSessionCookie();
  if (replaced?.sessionHandle !== undefined) endOpenShiftSession(replaced.sessionHandle);
}

async function completeSignIn(request: Request, stateCookie: string, ip: string): Promise<SignInResult> {
  let state: OpenShiftState;
  try {
    state = await decryptOpenShiftState(stateCookie);
  } catch (error) {
    if (error instanceof AuthConfigError) throw error;
    return { code: "openshift_state_invalid" };
  }
  const params = new URL(request.url).searchParams;
  const error = params.get("error");
  if (error === "access_denied") return { code: "openshift_denied" };
  if (error !== null || !params.get("code")) return { code: "openshift_failed" };
  if (params.get("state") !== state.state) return { code: "openshift_state_invalid" };

  const metadata = await readOpenShiftMetadata();
  if (metadata.kind !== "ok") return { code: metadataFailureCode(ROUTE, metadata) };
  const exchange = await exchangeOpenShiftCode(metadata.metadata, params, state);
  if (exchange.kind !== "token") return { code: exchangeFailureCode(exchange) };
  const identity = await readOpenShiftIdentity(exchange.accessToken);
  if (identity.kind !== "ok") return { code: identityFailureCode(identity) };
  const { name, uid } = identity.identity;
  const role = await openShiftSignInRole(identity.identity, exchange.accessToken);
  if (role === null) return { code: "openshift_no_access", user: name };

  await endReplacedSession();
  const handle = newSessionHandle();
  const lifetime = openShiftSessionLifetimeSeconds(exchange.expiresIn);
  const issuer = metadata.metadata.issuer;
  storeOpenShiftSession(handle, {
    token: exchange.accessToken,
    uid,
    name,
    issuer,
    expiresAtMs: Date.now() + lifetime * 1000,
  });
  try {
    await login(role, name, undefined, { subject: uid, issuer, sessionHandle: handle }, undefined, lifetime);
  } catch (loginError) {
    endOpenShiftSession(handle);
    const config = loginError instanceof AuthConfigError;
    logger.error("OpenShift sign-in: the session could not be minted", undefined, {
      route: ROUTE,
      reason: config ? "config" : "failed",
    });
    return { code: config ? "openshift_config" : "openshift_failed", user: name };
  }
  auditSignInSuccess(ROUTE, name, ip);
  // Back to the page the session ended on, checked again although the cookie is signed; otherwise by role.
  const landing = safeReturnPath(state.return_to) ?? (role === "admin" ? "/admin" : "/");
  return { location: `${openShiftPublicUrl().origin}${withBasePath(landing)}` };
}

/**
 * The callback's own path and nothing longer. Next removes the base path from the request URL before a route handler
 * runs, so the callback arrives without it; the prefixed form is the same path and is accepted too.
 */
function isCallbackPath(pathname: string): boolean {
  return pathname === OPENSHIFT_CALLBACK_PATH || pathname === withBasePath(OPENSHIFT_CALLBACK_PATH);
}

export async function GET(request: Request): Promise<NextResponse> {
  if (authProviderSetting() !== "openshift") return notFound();
  if (!isCallbackPath(new URL(request.url).pathname)) return notFound();
  const ip = clientAddress(request);
  let result: SignInResult;
  try {
    const cookieStore = await cookies();
    const stateCookie = cookieStore.get(OPENSHIFT_STATE_COOKIE)?.value;
    if (stateCookie === undefined) {
      result = { code: "openshift_state_missing" };
    } else {
      try {
        result = await completeSignIn(request, stateCookie, ip);
      } finally {
        cookieStore.delete({ name: OPENSHIFT_STATE_COOKIE, path: openShiftStateCookiePath() });
      }
    }
  } catch (error) {
    // Reduced to its class: an error object never reaches the log.
    const config = error instanceof AuthConfigError;
    logger.error("OpenShift sign-in failed", undefined, { route: ROUTE, reason: config ? "config" : "failed" });
    result = { code: config ? "openshift_config" : "openshift_failed" };
  }
  if ("location" in result) return redirectNoStore(result.location);
  auditSignInFailure(ROUTE, result.code, ip, result.user);
  return redirectNoStore(openShiftLoginPageLocation(result.code));
}
