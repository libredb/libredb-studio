import { login } from "@/lib/auth";
import { AuthConfigError } from "@/lib/auth-errors";
import { getAuthUsers } from "@/lib/local-auth";
import { NextRequest, NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { logger } from "@/lib/logger";

/**
 * One-click sign-in for a public demo instance.
 *
 * This is not an authentication bypass: it resolves `DEMO_EMAIL`/`DEMO_PASSWORD`
 * against the same user table as `POST /api/auth/login` and mints no role of its
 * own, so a demo visitor gets exactly the account the operator configured — and
 * nothing when the pair is absent, which is the default.
 */
export async function POST(_request: NextRequest) {
  const email = process.env.DEMO_EMAIL;
  const password = process.env.DEMO_PASSWORD;

  // Off unless both are set. 404 rather than 403 so a server without a demo
  // account does not advertise that the route exists at all.
  if (!email || !password) {
    return NextResponse.json({ success: false, message: "Demo access is not enabled on this server" }, { status: 404 });
  }

  try {
    const matched = getAuthUsers().find((u) => u.email === email && u.password === password);

    if (!matched) {
      // The visitor pressed a button; they cannot have got this wrong. Report it
      // as the operator error it is instead of "invalid email or password".
      logger.error("Demo access is misconfigured", new Error("DEMO_EMAIL does not match a configured account"), {
        route: "POST /api/auth/demo",
      });
      return NextResponse.json(
        {
          success: false,
          message:
            "Demo access is misconfigured: DEMO_EMAIL and DEMO_PASSWORD do not match a configured account. " +
            "Point them at the ADMIN_EMAIL/ADMIN_PASSWORD or USER_EMAIL/USER_PASSWORD pair and restart the server.",
        },
        { status: 503 },
      );
    }

    await login(matched.role, matched.email);
    return NextResponse.json({ success: true, role: matched.role });
  } catch (error) {
    if (error instanceof AuthConfigError) {
      logger.error("Authentication is not configured", error, { route: "POST /api/auth/demo" });
      return NextResponse.json({ success: false, message: error.message }, { status: 503 });
    }
    return createErrorResponse(error, { route: "POST /api/auth/demo" });
  }
}
