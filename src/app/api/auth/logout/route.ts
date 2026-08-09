import { getSession, logout } from "@/lib/auth";
import { buildLogoutUrl, getPublicOrigin } from "@/lib/oidc";
import { NextRequest, NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { clientAddress } from "@/lib/api/client-address";
import { emitAuditEvent } from "@/lib/audit";

const ROUTE = "POST /api/auth/logout";

export async function POST(request: NextRequest) {
  try {
    // Ordering matters: logout() clears the cookie, so reading the session afterwards would always
    // record "anonymous" and the audit trail would never name who signed out.
    const session = await getSession();

    await logout();

    emitAuditEvent({
      type: "logout",
      action: "logout",
      target: ROUTE,
      user: session?.username ?? "anonymous",
      result: "success",
      ip: clientAddress(request),
    });

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
