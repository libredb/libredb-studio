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
 */
export async function requireSession(): Promise<NextResponse | null> {
  const session = await getSession();

  if (!session) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 });
  }

  return null;
}
