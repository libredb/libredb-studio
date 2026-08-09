import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { logger } from "@/lib/logger";
import { getJwtSecret } from "@/lib/config/auth-env";
import { withSecurityHeaders } from "@/lib/security/config";

// Lazy-initialized to prevent module-level crash if JWT_SECRET is misconfigured.
// A module-level throw would block ALL requests (including health check).
let _jwtSecret: Uint8Array | null = null;
function jwtSecret(): Uint8Array {
  if (!_jwtSecret) {
    _jwtSecret = getJwtSecret();
  }
  return _jwtSecret;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isStaticAsset = /\.[a-z0-9]+$/i.test(pathname);

  const token = request.cookies.get("auth-token")?.value;

  // If accessing /login with a valid token, redirect authenticated users
  if (pathname.startsWith("/login")) {
    if (token) {
      try {
        const { payload } = await jwtVerify(token, jwtSecret());
        const role = payload.role as string;
        // Redirect authenticated users based on their role
        return withSecurityHeaders(NextResponse.redirect(new URL(role === "admin" ? "/admin" : "/", request.url)));
      } catch {
        // Invalid token, allow access to login page
        logger.debug("Invalid token on login page, allowing access", { route: "proxy" });
        return withSecurityHeaders(NextResponse.next());
      }
    }
    // No token, allow access to login page
    return withSecurityHeaders(NextResponse.next());
  }

  // Allow public routes
  if (
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/_next") ||
    isStaticAsset ||
    pathname === "/favicon.ico" ||
    // Health check endpoint for load balancers (Render, K8s, etc.)
    pathname === "/api/db/health" ||
    // Storage config endpoint (public, returns only mode info)
    pathname === "/api/storage/config"
  ) {
    return withSecurityHeaders(NextResponse.next());
  }

  if (!token) {
    return withSecurityHeaders(NextResponse.redirect(new URL("/login", request.url)));
  }

  try {
    const { payload } = await jwtVerify(token, jwtSecret());
    const role = payload.role as string;

    // RBAC: /admin only for admin
    if (pathname.startsWith("/admin") && role !== "admin") {
      return withSecurityHeaders(NextResponse.redirect(new URL("/", request.url)));
    }

    return withSecurityHeaders(NextResponse.next());
  } catch {
    logger.warn("JWT verification failed, redirecting to login", { route: "proxy" });
    return withSecurityHeaders(NextResponse.redirect(new URL("/login", request.url)));
  }
}

export const config = {
  matcher: [
    /*
     * Match all request paths except for the ones starting with:
     * - api/db/health (health check for load balancers)
     * - api/storage/config (storage mode discovery - public)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - anything containing a dot (static assets under public/, /monaco/vs/*.js)
     *
     * api/auth is deliberately NOT excluded any more: proxy()'s own public-route branch already
     * returns NextResponse.next() for those paths, so the auth semantics are unchanged, but
     * login, logout and the OIDC responses now carry the security headers and are covered by the
     * Origin check. api/db/health and api/storage/config stay excluded: they are load-balancer
     * and bootstrap paths where added latency has no upside.
     *
     * Residual gap, accepted and recorded in docs/BACKLOG.md: paths containing a dot receive no
     * headers. They are not documents, and MIME sniffing on assets Next serves with correct
     * content types is not a live threat.
     */
    "/((?!api/db/health|api/storage/config|_next/static|_next/image|.*\\..*).*)",
  ],
};
