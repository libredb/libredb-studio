import { getSession, logout } from "@/lib/auth";
import { buildLogoutUrl, getPublicOrigin } from "@/lib/oidc";
import { NextRequest, NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { clientAddress } from "@/lib/api/client-address";
import { emitAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";

const ROUTE = "POST /api/auth/logout";

export async function POST(request: NextRequest) {
  try {
    // Ordering matters: logout() clears the cookie, so reading the session afterwards would always
    // record "anonymous" and the audit trail would never name who signed out.
    const session = await getSession();

    await logout();

    // No session means no state transition occurred - "anonymous logged out" would be noise, not a
    // fact, and this route has no rate limit, so recording it unconditionally would let an
    // unauthenticated caller flood the audit trail for free.
    if (session) {
      // Isolated in its own try/catch, separate from the mutation above: an audit call must never
      // change the outcome of the thing it is recording. logout() has already succeeded by this
      // point, so a failure to record it (today unrealistic - console.log basically cannot throw -
      // but real the moment the audit sink gains an I/O step) must not turn a successful logout
      // into a 500, and must not retroactively make it look like the logout never happened.
      try {
        emitAuditEvent({
          type: "logout",
          action: "logout",
          target: ROUTE,
          user: session.username,
          result: "success",
          ip: clientAddress(request),
        });
      } catch (auditError) {
        logger.error("Failed to record logout audit event", auditError, { route: ROUTE });
      }
    }

    const authProvider = process.env.NEXT_PUBLIC_AUTH_PROVIDER || "local";
    if (authProvider === "oidc") {
      const origin = getPublicOrigin(request);
      const returnTo = `${origin}/login`;
      const oidcLogoutUrl = buildLogoutUrl(returnTo);

      if (oidcLogoutUrl) {
        return NextResponse.json({ success: true, redirectUrl: oidcLogoutUrl });
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    return createErrorResponse(error, { route: ROUTE });
  }
}
