import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";

/**
 * Handler-level authentication guard.
 *
 * src/proxy.ts already redirects unauthenticated requests, but middleware is an optimisation,
 * not an authorization boundary: a matcher gap (the matcher exempts any path containing a dot)
 * or a framework-level bypass would expose every route that relies on it alone. Routes that
 * reach a database or an LLM provider verify the session themselves.
 *
 * Returns null when the caller is authenticated, or the 401 response the handler should return.
 *
 * Callers invoke this outside their own try/catch, unlike the inline checks it replaces. That is
 * safe because `getSession()` cannot throw: a missing auth-token cookie makes it return null
 * directly, and otherwise it awaits `verifyJWT()`, whose try block wraps the JWT secret lookup
 * (so a misconfigured `JWT_SECRET` raises `AuthConfigError` there, not outside it) and always
 * degrades to a returned null rather than letting anything escape.
 */
export async function requireSession(): Promise<NextResponse | null> {
  const session = await getSession();

  if (!session) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  return null;
}
