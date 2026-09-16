import { getBasePath, withBasePath } from "@/lib/config/base-path";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getOIDCConfig, discoverProvider, generateAuthUrl, encryptState, getPublicOrigin } from "@/lib/oidc";
import { shouldMarkCookieSecure } from "@/lib/auth";
import { logger } from "@/lib/logger";
import { clientAddress } from "@/lib/api/client-address";
import { emitAuditEvent, type AuditReason } from "@/lib/audit";
import { AuthConfigError } from "@/lib/auth-errors";

const ROUTE = "GET /api/auth/oidc/login";

/** Same shape and isolation as the callback route's auditFailure: a broken audit sink must never change the redirect. */
function auditFailure(reason: AuditReason, ip: string): void {
  try {
    emitAuditEvent({
      type: "login_failure",
      action: "login",
      target: ROUTE,
      user: "anonymous",
      result: "failure",
      reason,
      ip,
    });
  } catch (auditError) {
    logger.error("Failed to record OIDC login_failure audit event", auditError, { route: ROUTE });
  }
}

export async function GET(request: Request) {
  const origin = getPublicOrigin(request);
  const ip = clientAddress(request);

  // Set once discovery has answered, so the catch below can tell a failure on the way to the
  // provider from a failure after it answered. A boolean rather than a nested try so the redirect
  // is still built in exactly one place.
  let discovered = false;
  try {
    const oidcConfig = getOIDCConfig();
    const config = await discoverProvider(oidcConfig);
    discovered = true;

    const redirectUri = `${origin}${withBasePath("/api/auth/oidc/callback")}`;

    const { url, state } = await generateAuthUrl(config, redirectUri, oidcConfig.scope);

    // Store PKCE state in signed cookie. The Secure flag follows the same rule
    // as the session cookie: a state cookie the browser drops takes the PKCE
    // verifier with it, and the callback fails on a missing state.
    const stateCookie = await encryptState(state);
    const cookieStore = await cookies();
    cookieStore.set("oidc-state", stateCookie, {
      httpOnly: true,
      secure: await shouldMarkCookieSecure(),
      sameSite: "lax",
      maxAge: 300, // 5 minutes
      path: getBasePath() || "/",
    });

    return NextResponse.redirect(url.toString());
  } catch (error) {
    logger.error("OIDC login error", error, { route: ROUTE });
    // Classified by type first, as the callback route does: AuthConfigError is the operator's
    // problem (missing OIDC_* variables, a non-https issuer, an unusable JWT secret) wherever it
    // was thrown, and trying again cannot fix it. Anything else is placed by where it happened.
    // Before discovery answered, it is the provider that did not: an issuer that does not
    // resolve, a TLS failure, a response that is not JSON or names a different issuer. After it
    // answered - a document that parses but lacks an endpoint, PKCE, the state cookie, the cookie
    // store - it is the callback route's generic oidc_failed, for which "try again" is the right
    // advice.
    const errorCode = error instanceof AuthConfigError ? "oidc_config" : discovered ? "oidc_failed" : "oidc_discovery";
    auditFailure(errorCode, ip);
    return NextResponse.redirect(`${origin}${withBasePath("/login")}?error=${errorCode}`);
  }
}
