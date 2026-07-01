import { login } from "@/lib/auth";
import { AuthConfigError, getAuthUsers } from "@/lib/local-auth";
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
    // Server is not configured for local login — surface a clear, actionable
    // message on the login screen (503, not a generic 500) so the operator
    // knows exactly what to fix rather than seeing "Invalid email or password".
    if (error instanceof AuthConfigError) {
      logger.error("Local authentication is not configured", error, { route: "POST /api/auth/login" });
      return NextResponse.json(
        {
          success: false,
          message:
            "Login is unavailable: this server has no administrator password configured. " +
            "Set the ADMIN_PASSWORD environment variable and restart the server.",
        },
        { status: 503 },
      );
    }
    return createErrorResponse(error, { route: "POST /api/auth/login" });
  }
}
