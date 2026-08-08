import { login } from "@/lib/auth";
import { AuthConfigError } from "@/lib/auth-errors";
import { DEMO_ACCOUNT_EMAIL, getDemoRole, isDemoEnabled } from "@/lib/demo-access";
import { NextRequest, NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

/**
 * One-click sign-in for a public demo instance.
 *
 * Gated solely by `DEMO_MODE`, because there is nobody to authenticate — a
 * demo password would be a constant shared between two variables on the same
 * server, not a check. Requiring a real account instead would mean enabling
 * password login on an SSO-only deployment, which is a worse trade.
 */
export async function POST(_request: NextRequest) {
  // 404 rather than 403 so a server without demo access does not advertise that
  // the route exists at all.
  if (!isDemoEnabled()) {
    return NextResponse.json({ success: false, message: "Demo access is not enabled on this server" }, { status: 404 });
  }

  try {
    const role = getDemoRole();
    await login(role, DEMO_ACCOUNT_EMAIL);
    return NextResponse.json({ success: true, role });
  } catch (error) {
    if (error instanceof AuthConfigError) {
      logger.error("Authentication is not configured", error, { route: "POST /api/auth/demo" });
      return NextResponse.json({ success: false, message: error.message }, { status: 503 });
    }
    return createErrorResponse(error, { route: "POST /api/auth/demo" });
  }
}
