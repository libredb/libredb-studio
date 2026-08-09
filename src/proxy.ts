import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { clientAddress } from "@/lib/api/client-address";
import { checkOrigin } from "@/lib/api/origin-check";
import { consumeRateLimit } from "@/lib/api/rate-limit";
import { emitAuditEvent, MAX_AUDIT_FIELD_LENGTH } from "@/lib/audit";
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

// The body names the fix. A reverse proxy that rewrites Host without setting x-forwarded-host
// produces a mismatch on every state-changing request including login, and the operator otherwise
// sees a working page that silently refuses every action. This turns a lockout into a diagnosis.
const ORIGIN_MISMATCH_BODY = {
  error:
    "Request origin is not allowed for this deployment. If Studio sits behind a reverse proxy, set ALLOWED_ORIGINS to its public origin.",
  code: "ORIGIN_MISMATCH",
  statusCode: 403,
  retryable: false,
};

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const isStaticAsset = /\.[a-z0-9]+$/i.test(pathname);

  const origin = checkOrigin(request);
  if (!origin.allowed) {
    // The warning and the audit line are metered through the anon bucket so an internet scanner
    // cannot fill a container log volume. The limiter instance the proxy sees is independent of
    // the one the route handlers see - the proxy is a separately compiled entry - and it is used
    // here only to bound log volume, never to reject: the 403 is unconditional.
    const address = clientAddress(request);
    const notice = consumeRateLimit("anon", address);
    if (notice.allowed || notice.tripped) {
      logger.warn("Origin check rejected a request", {
        route: `${request.method} ${pathname}`,
        // Bounded the same as the audit target beside it (MAX_AUDIT_FIELD_LENGTH): observedOrigin
        // is read straight from the request's own Origin/Referer header and is attacker-controlled
        // on every rejected request, unlike expectedHost, which reflects this deployment's own
        // configured host.
        observedOrigin: origin.observedOrigin.slice(0, MAX_AUDIT_FIELD_LENGTH),
        expectedHost: origin.expectedHost,
      });
      // Isolated in its own try/catch: the 403 below is unconditional and already decided: a
      // broken audit sink must never turn it into an unrelated 500.
      try {
        emitAuditEvent({
          type: "permission_denied",
          action: "denied",
          target: `${request.method} ${pathname}`,
          user: "anonymous",
          result: "failure",
          reason: "origin_mismatch",
          ip: address,
        });
      } catch (auditError) {
        logger.error("Failed to record origin_mismatch audit event", auditError, { route: "proxy" });
      }
    }
    return withSecurityHeaders(NextResponse.json(ORIGIN_MISMATCH_BODY, { status: 403 }));
  }

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
