import { withBasePath } from "@/lib/config/base-path";
import { authProvider } from "@/lib/config/auth-provider";
import { getSession, logout } from "@/lib/auth";
import { OIDC_LOGOUT_HINT_COOKIE, oidcLogoutHintCookiePath, readOidcLogoutHint } from "@/lib/config/oidc-logout-hint";
import { buildLogoutUrl, getPublicOrigin } from "@/lib/oidc";
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";
import { decodeJwt } from "jose";
import { createErrorResponse } from "@/lib/api/errors";
import { clientAddress } from "@/lib/api/client-address";
import { emitAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { endOpenShiftSession } from "@/lib/openshift-auth/token-store";

const ROUTE = "POST /api/auth/logout";

/**
 * The ID token kept by the OIDC callback (OIDC_LOGOUT_HINT), when its `sub` is the session's identity provider
 * subject. A hint for anyone else is never sent: the provider would end that user's session. The token is only
 * decoded, not verified: it decides nothing here beyond which session the provider is asked to end.
 */
function hintForSession(hint: string | undefined, idpSubject: string | undefined): string | undefined {
  if (hint === undefined || idpSubject === undefined) return undefined;
  try {
    return decodeJwt(hint).sub === idpSubject ? hint : undefined;
  } catch (error) {
    logger.warn("The OIDC logout hint cookie is not a JWT; logging out without it", {
      route: ROUTE,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/**
 * The logout line. Isolated in its own try/catch, separate from the mutation before it: an audit call must never change
 * the outcome of the thing it is recording, so a failure to record it must not turn a successful logout into a 500,
 * and must not retroactively make it look like the logout never happened.
 */
function recordLogout(request: NextRequest, username: string): void {
  try {
    emitAuditEvent({
      type: "logout",
      action: "logout",
      target: ROUTE,
      user: username,
      result: "success",
      ip: clientAddress(request),
    });
  } catch (auditError) {
    logger.error("Failed to record logout audit event", auditError, { route: ROUTE });
  }
}

export async function POST(request: NextRequest) {
  try {
    // Ordering matters: logout() clears the cookie, so reading the session afterwards would always
    // record "anonymous" and the audit trail would never name who signed out.
    const session = await getSession();

    // An access token's session (src/lib/oidc-bearer.ts) has no cookie to clear and no Studio state to end: the native
    // client discards its tokens and ends its provider session itself. Any cookie on the request belongs to another
    // session and is left alone.
    if (session?.channel === "bearer") {
      recordLogout(request, session.username);
      return NextResponse.json({ success: true });
    }

    // An openshift session's token record ends here, at once, and nothing is sent: the scoped token cannot delete its
    // own useroauthaccesstoken, and the cluster's OAuth server keeps no session Studio could end.
    if (session?.sessionHandle !== undefined) endOpenShiftSession(session.sessionHandle);
    await logout();

    // Read once and deleted with the path it was set with, whatever happens to it below, so a hint never outlives
    // the session it was kept for.
    const cookieStore = await cookies();
    const hint = cookieStore.get(OIDC_LOGOUT_HINT_COOKIE)?.value;
    if (hint !== undefined) cookieStore.delete({ name: OIDC_LOGOUT_HINT_COOKIE, path: oidcLogoutHintCookiePath() });

    // No session means no state transition occurred - "anonymous logged out" would be noise, not a
    // fact, and this route has no rate limit, so recording it unconditionally would let an
    // unauthenticated caller flood the audit trail for free.
    if (session) recordLogout(request, session.username);

    if (authProvider() === "oidc") {
      const origin = getPublicOrigin(request);
      const returnTo = `${origin}${withBasePath("/login")}`;
      const idTokenHint = readOidcLogoutHint() ? hintForSession(hint, session?.idpSubject) : undefined;
      const oidcLogoutUrl = await buildLogoutUrl(returnTo, idTokenHint);

      if (oidcLogoutUrl) {
        return NextResponse.json({ success: true, redirectUrl: oidcLogoutUrl });
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return createErrorResponse(error, { route: ROUTE });
  }
}
