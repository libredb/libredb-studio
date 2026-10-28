import { getBasePath, withBasePath } from "@/lib/config/base-path";
import { safeReturnPath } from "@/lib/api/session-ended";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { login, shouldMarkCookieSecure } from "@/lib/auth";
import { sessionTtlSeconds } from "@/lib/config/auth-env";
import {
  OIDC_LOGOUT_HINT_COOKIE,
  fitsLogoutHintCookie,
  oidcLogoutHintCookiePath,
  readOidcLogoutHint,
} from "@/lib/config/oidc-logout-hint";
import {
  getOIDCConfig,
  discoverProvider,
  exchangeCode,
  decryptState,
  mapOIDCRole,
  mapOIDCClaimRoles,
  readRoleClaimValues,
  getPublicOrigin,
} from "@/lib/oidc";
import { oidcUsername } from "@/lib/oidc-identity";
import { logger } from "@/lib/logger";
import { clientAddress } from "@/lib/api/client-address";
import { emitAuditEvent, type AuditReason } from "@/lib/audit";
import { AuthConfigError } from "@/lib/auth-errors";
import { governanceEnabled } from "@/lib/governance/config";
import { accessReviewEnabled } from "@/lib/kubernetes-access/config";
import { accessReviewRole } from "@/lib/kubernetes-access/gate";
import { readGroupsClaim, recordGroups } from "@/lib/kubernetes-access/groups";
import { governedIdentityAccepted, governedSignInRevoked } from "@/lib/local-accounts";

const ROUTE = "GET /api/auth/oidc/callback";

// Single-line, module-scoped: bun's line coverage under-counts the continuation lines of a wrapped string.
const GOVERNED_IDENTITY_REFUSED_MESSAGE =
  "OIDC callback: governance needs an ID token with a non-empty sub, issued by the identity provider at OIDC_ISSUER";

/**
 * One event type with a reason enum, not five event types. The reasons reuse the redirect codes
 * the login page already shows the user through ?error=, so the taxonomy an operator reads in the
 * audit trail and the one a user sees on screen are the same taxonomy. It also keeps the admin
 * filter low-cardinality.
 */
function auditFailure(reason: AuditReason, ip: string, user = "anonymous"): void {
  // Isolated from route control flow: a broken audit sink must never decide which failure code
  // the caller is redirected to. Every call site below sits inside the route's outer try, whose
  // catch would otherwise reclassify the ORIGINAL failure (e.g. oidc_state_missing) as oidc_failed
  // if this throw were allowed to propagate.
  try {
    emitAuditEvent({
      type: "login_failure",
      action: "login",
      target: ROUTE,
      user,
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
      return NextResponse.redirect(`${origin}${withBasePath("/login")}?error=oidc_state_missing`);
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
      cookieStore.delete({ name: "oidc-state", path: getBasePath() || "/" });
      auditFailure("oidc_state_invalid", ip);
      return NextResponse.redirect(`${origin}${withBasePath("/login")}?error=oidc_state_invalid`);
    }

    // Exchange code for tokens
    const oidcConfig = getOIDCConfig();
    const config = await discoverProvider(oidcConfig);

    // Reconstruct callback URL with public origin for token exchange
    const internalUrl = new URL(request.url);
    const callbackUrl = new URL(`${internalUrl.pathname}${internalUrl.search}`, origin);

    const exchange = await exchangeCode(config, callbackUrl, oidcState.code_verifier, oidcState.state, oidcState.nonce);

    // The session's identity is the ID token's sub and iss. openid-client has already checked both; they are checked
    // again here because the claim set reaches this route through a cast.
    if (!exchange || typeof exchange.claims.sub !== "string" || typeof exchange.claims.iss !== "string") {
      logger.warn("OIDC callback: the ID token claims lack a string sub or iss", { route: "oidc/callback" });
      auditFailure("oidc_no_claims", ip);
      return NextResponse.redirect(`${origin}${withBasePath("/login")}?error=oidc_no_claims`);
    }
    const { claims, idToken } = exchange;

    // Under governance every request refuses a session without a subject or from an issuer other than OIDC_ISSUER
    // (docs/GOVERNANCE.md), so none is minted here: OIDC_AUTO_REDIRECT would answer each refusal with the next sign-in,
    // in a loop. The provider's answer is a configuration problem, and the login page says so.
    if (governanceEnabled() && !governedIdentityAccepted(claims.sub, claims.iss)) {
      logger.warn(GOVERNED_IDENTITY_REFUSED_MESSAGE, { route: "oidc/callback" });
      // The exchange consumed the state, so its cookie is deleted as after a sign-in.
      cookieStore.delete({ name: "oidc-state", path: getBasePath() || "/" });
      auditFailure("oidc_config", ip);
      return NextResponse.redirect(`${origin}${withBasePath("/login")}?error=oidc_config`);
    }

    const identity = oidcUsername(claims as Record<string, unknown>) ?? claims.sub;

    // With the Kubernetes access review on (docs/SEED_CONNECTIONS.md), the ID token's groups are what every review of
    // this subject asserts, so a claim the store cannot hold refuses the sign-in, and the role claim is not read at
    // all: admin comes only from a review of update on Studio's own Deployment, decided here, once per sign-in.
    const reviewed = accessReviewEnabled();
    const groupsReading = reviewed
      ? readGroupsClaim(claims as Record<string, unknown>)
      : { ok: true as const, groups: [] };
    if (!groupsReading.ok) {
      logger.warn("OIDC callback: the groups claim cannot be used for the Kubernetes access review", {
        route: "oidc/callback",
        problem: groupsReading.problem,
      });
      cookieStore.delete({ name: "oidc-state", path: getBasePath() || "/" });
      auditFailure("oidc_groups_refused", ip, String(identity));
      return NextResponse.redirect(`${origin}${withBasePath("/login")}?error=oidc_groups_refused`);
    }

    // Map role from claims
    const claimValues = reviewed ? [] : readRoleClaimValues(claims as Record<string, unknown>, oidcConfig.roleClaim);
    const role = reviewed
      ? await accessReviewRole(claims.sub, groupsReading.groups)
      : mapOIDCRole(
          claims as Record<string, unknown>,
          oidcConfig.roleClaim,
          oidcConfig.adminRoles,
          oidcConfig.userRoles,
        );

    if (role === null) {
      // The account holds none of OIDC_ADMIN_ROLES or OIDC_USER_ROLES, so it gets no session. The
      // exchange consumed the state, so its cookie is deleted as after a sign-in. The provider
      // authenticated the account, so the record names it the way login_success does.
      cookieStore.delete({ name: "oidc-state", path: getBasePath() || "/" });
      auditFailure("oidc_no_role", ip, String(identity));
      return NextResponse.redirect(`${origin}${withBasePath("/login")}?error=oidc_no_role`);
    }

    // Custom claim roles: extracted only when OIDC_ROLE_PREFIX is configured. Over the 20-role or
    // 64-char limit, refuse the session with oidc_role_overflow.
    const { roles: claimRoles, overflow } = oidcConfig.rolePrefix
      ? mapOIDCClaimRoles(claimValues, oidcConfig.rolePrefix)
      : { roles: [], overflow: false };

    if (overflow) {
      cookieStore.delete({ name: "oidc-state", path: getBasePath() || "/" });
      auditFailure("oidc_role_overflow", ip, String(identity));
      return NextResponse.redirect(`${origin}${withBasePath("/login")}?error=oidc_role_overflow`);
    }

    // Under governance every request refuses a session issued at or before its subject's revoked_before
    // (docs/GOVERNANCE.md#sign-in), so a revocation dated at or after this second would refuse the session minted here,
    // and OIDC_AUTO_REDIRECT would answer each refusal with the next silent sign-in. None is minted, and the login page,
    // which always renders with an error, says an administrator ended the account's sessions.
    if (governanceEnabled() && governedSignInRevoked(claims.sub)) {
      cookieStore.delete({ name: "oidc-state", path: getBasePath() || "/" });
      auditFailure("oidc_session_revoked", ip, String(identity));
      return NextResponse.redirect(`${origin}${withBasePath("/login")}?error=oidc_session_revoked`);
    }

    // The groups record serves every request of the session minted below, so it is written first.
    if (reviewed) recordGroups(claims.iss, claims.sub, groupsReading.groups);

    // Create local JWT session (same as password login). `username` keeps its display meaning, and the provider's
    // subject and issuer travel as the session's idpSubject and idpIssuer.
    const username = identity || role;
    await login(
      role,
      username,
      undefined,
      { subject: claims.sub, issuer: claims.iss },
      claimRoles.length > 0 ? claimRoles : undefined,
    );

    // Clean up state cookie
    cookieStore.delete({ name: "oidc-state", path: getBasePath() || "/" });

    // OIDC_LOGOUT_HINT: keep the raw ID token where only the logout route receives it, for the provider's
    // end-session request. A token too large for a cookie is not kept, and one kept by an earlier sign-in is removed so
    // logout never sends a hint for another session.
    if (readOidcLogoutHint()) {
      if (fitsLogoutHintCookie(idToken)) {
        cookieStore.set(OIDC_LOGOUT_HINT_COOKIE, idToken, {
          httpOnly: true,
          secure: await shouldMarkCookieSecure(),
          sameSite: "lax",
          maxAge: sessionTtlSeconds(),
          path: oidcLogoutHintCookiePath(),
        });
      } else {
        cookieStore.delete({ name: OIDC_LOGOUT_HINT_COOKIE, path: oidcLogoutHintCookiePath() });
      }
    }

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

    // Back to the page the session ended on (#1420), checked again although the cookie is signed;
    // otherwise by role.
    const landing = safeReturnPath(oidcState.return_to) ?? (role === "admin" ? "/admin" : "/");
    return NextResponse.redirect(`${origin}${withBasePath(landing)}`);
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
    return NextResponse.redirect(`${origin}${withBasePath("/login")}?error=${errorCode}`);
  }
}
