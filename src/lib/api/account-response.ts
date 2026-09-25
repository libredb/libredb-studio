import { NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { AuthConfigError } from "@/lib/auth-errors";
import { AccountError } from "@/lib/local-accounts";

/** Map an account-registry failure onto the response the route returns. */
export function accountFailureResponse(error: unknown, route: string): NextResponse {
  if (error instanceof AccountError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  if (error instanceof AuthConfigError) {
    return NextResponse.json({ error: error.message }, { status: 503 });
  }
  return createErrorResponse(error, { route });
}
