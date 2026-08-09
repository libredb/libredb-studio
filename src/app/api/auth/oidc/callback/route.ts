import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { login } from "@/lib/auth";
import { getOIDCConfig, discoverProvider, exchangeCode, decryptState, mapOIDCRole, getPublicOrigin } from "@/lib/oidc";
import { logger } from "@/lib/logger";
import { clientAddress } from "@/lib/api/client-address";
import { emitAuditEvent, type AuditReason } from "@/lib/audit";
import { AuthConfigError } from "@/lib/auth-errors";

const ROUTE = "GET /api/auth/oidc/callback";

/**
 * One event type with a reason enum, not five event types. The reasons reuse the redirect codes
 * the login page already shows the user through ?error=, so the taxonomy an operator reads in the
 * audit trail and the one a user sees on screen are the same taxonomy. It also keeps the admin
 * filter low-cardinality.
 */
function auditFailure(reason: AuditReason, ip: string): void {
  // Isolated from route control flow: a broken audit sink must never decide which failure code
  // the caller is redirected to. Every call site below sits inside the route's outer try, whose
  // catch would otherwise reclassify the ORIGINAL failure (e.g. oidc_state_missing) as oidc_failed
  // if this throw were allowed to propagate.
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

  try {
    const cookieStore = await cookies();
    const stateCookie = cookieStore.get("oidc-state")?.value;

    if (!stateCookie) {
      auditFailure("oidc_state_missing", ip);
      return NextResponse.redirect(`${origin}/login?error=oidc_state_missing`);
    }

    // Decrypt and validate state
    let oidcState;
    try {
      oidcState = await decryptState(stateCookie);
    } catch (decryptError) {
      logger.warn("OIDC state decryption failed", {
        route: ROUTE,
        error: decryptError instanceof Error ? decryptError.message : "Unknown",
      });
      cookieStore.delete("oidc-state");
      auditFailure("oidc_state_invalid", ip);
      return NextResponse.redirect(`${origin}/login?error=oidc_state_invalid`);
    }

    // Exchange code for tokens
    const oidcConfig = getOIDCConfig();
    const config = await discoverProvider(oidcConfig);

    // Reconstruct callback URL with public origin for token exchange
    const internalUrl = new URL(request.url);
    const callbackUrl = new URL(`${internalUrl.pathname}${internalUrl.search}`, origin);

    const claims = await exchangeCode(config, callbackUrl, oidcState.code_verifier, oidcState.state, oidcState.nonce);

    if (!claims) {
      logger.warn("OIDC callback: no claims returned from token exchange", { route: "oidc/callback" });
      auditFailure("oidc_no_claims", ip);
      return NextResponse.redirect(`${origin}/login?error=oidc_no_claims`);
    }

    // Map role from claims
    const role = mapOIDCRole(claims as Record<string, unknown>, oidcConfig.roleClaim, oidcConfig.adminRoles);

    // Create local JWT session (same as password login)
    const username = claims.email || claims.preferred_username || claims.sub || role;
    await login(role, username);

    // Clean up state cookie
    cookieStore.delete("oidc-state");

    // Isolated in its own try/catch, separate from login() above: a real session already exists by
    // this point, so a failure to record it must never turn a successful login into a recorded (or
    // outer-catch-driven) login_failure.
    try {
      emitAuditEvent({
        type: "login_success",
        action: "login",
        target: ROUTE,
        user: String(username),
        result: "success",
        ip,
      });
    } catch (auditError) {
      logger.error("Failed to record OIDC login_success audit event", auditError, { route: ROUTE });
    }

    // Redirect based on role
    return NextResponse.redirect(`${origin}${role === "admin" ? "/admin" : "/"}`);
  } catch (error) {
    logger.error("OIDC callback error", error, { route: ROUTE });
    // Typed, not message substring matching: `error instanceof Error && error.message.includes(
    // "config")` was the bug this replaces. getOIDCConfig()'s own missing-env-vars message never
    // contained the word "config", so the real failure it exists to name was silently reported as
    // oidc_failed instead of oidc_config - proven only by a test whose synthetic error message
    // happened to contain "config", which passed for the wrong reason. AuthConfigError is also
    // what a JWT-configuration failure throws (login() -> signJWT() -> getJwtSecret(), reachable
    // from this same outer try above), so this classification covers both origins of "OIDC is
    // configured but the server's auth secret isn't" with one type check.
    const errorCode = error instanceof AuthConfigError ? "oidc_config" : "oidc_failed";
    auditFailure(errorCode, ip);
    return NextResponse.redirect(`${origin}/login?error=${errorCode}`);
  }
}
