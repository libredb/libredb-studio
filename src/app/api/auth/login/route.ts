import { login } from "@/lib/auth";
import { AuthConfigError } from "@/lib/auth-errors";
import { getAuthUsers } from "@/lib/local-auth";
import { NextRequest, NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

export async function POST(request: NextRequest) {
  try {
    const { email, password } = await request.json();
    const users = getAuthUsers();

    const matched = users.find((u) => u.email === email && u.password === password);

    if (matched) {
      await login(matched.role, matched.email);
      return NextResponse.json({ success: true, role: matched.role });
    }

    logger.warn("Failed login attempt", { route: "POST /api/auth/login", email });
    return NextResponse.json({ success: false, message: "Invalid email or password" }, { status: 401 });
  } catch (error) {
    // Server is not configured for authentication (missing ADMIN_PASSWORD, or a
    // missing/too-short JWT_SECRET) — surface the error's actionable message on
    // the login screen as a 503, not a generic 500, so the operator knows exactly
    // what to fix rather than seeing a misleading "Invalid email or password".
    if (error instanceof AuthConfigError) {
      logger.error("Authentication is not configured", error, { route: "POST /api/auth/login" });
      return NextResponse.json({ success: false, message: error.message }, { status: 503 });
    }
    return createErrorResponse(error, { route: "POST /api/auth/login" });
  }
}
