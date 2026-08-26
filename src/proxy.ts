import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { AGENT_DRIVE_HEADER, AGENT_DRIVE_PATH, verifyAgentDriveToken } from "@/lib/agent/drive-token";
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
      // Every field here is bounded to MAX_AUDIT_FIELD_LENGTH, not just observedOrigin: the anon
      // bucket above caps how often this line can be written, but a bound on request COUNT does
      // not bound the SIZE of each line. `route` is built from `pathname`, an attacker-controlled
      // URL path; `expectedHost` is `origin.expectedHost`, which reflects the Host (or a trusted
      // x-forwarded-host) header, not something this deployment controls independently of the
      // request - both can be made arbitrarily large by the same caller this metering exists to
      // bound. Leaving either unbounded would defeat the log-volume protection this branch is
      // named for, just via line SIZE instead of line COUNT.
      logger.warn("Origin check rejected a request", {
        route: `${request.method} ${pathname}`.slice(0, MAX_AUDIT_FIELD_LENGTH),
        observedOrigin: origin.observedOrigin.slice(0, MAX_AUDIT_FIELD_LENGTH),
        expectedHost: origin.expectedHost.slice(0, MAX_AUDIT_FIELD_LENGTH),
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

  // The agent runtime's drive callback (#329). It is deliberately NOT on the public list
  // below: an exemption is path-shaped, so anything that can reach the port would get in.
  // The caller presents a single-purpose, short-lived credential instead, minted by this
  // server, naming one run and granting nothing else - so this branch can only ever ADMIT
  // a request that already proved it holds one, never widen what an unauthenticated caller
  // may reach. Without one the request falls through to the ordinary session handling
  // below, and the route re-verifies the credential itself: middleware is an optimisation,
  // not the authorization boundary (see src/lib/api/require-session.ts).
  if (pathname === AGENT_DRIVE_PATH && (await verifyAgentDriveToken(request.headers.get(AGENT_DRIVE_HEADER)))) {
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
      // METERED through the anon bucket, exactly as the origin_mismatch line above is. Holding a
      // token this server signed bounds how many IDENTITIES reach this branch, not how many
      // requests each one makes: one session, stolen or not, can poll /admin in a loop, and every
      // line would both fill a container log volume and evict real events from the 1000-entry ring
      // the admin UI reads. Keyed on the username, not the address, so rotating `X-Forwarded-For`
      // buys no extra lines. The REDIRECT stays unconditional; only its record is bounded.
      const username = (payload.username as string) || "unknown";
      const notice = consumeRateLimit("anon", username);
      // Isolated in its own try/catch for the same reason as every other emit here - the redirect
      // is already decided.
      if (notice.allowed || notice.tripped) {
        try {
          emitAuditEvent({
            type: "permission_denied",
            action: "denied",
            target: `${request.method} ${pathname}`,
            user: username,
            result: "failure",
            reason: "insufficient_role",
            ip: clientAddress(request),
          });
        } catch (auditError) {
          logger.error("Failed to record insufficient_role audit event", auditError, { route: "proxy" });
        }
      }
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
     * - api/storage/config (storage mode discovery - public, GET only)
     * - _next/static (static files)
     * - _next/image (image optimization files)
     * - anything containing a dot (static assets under public/, /monaco/vs/*.js)
     *
     * api/auth is deliberately NOT excluded any more: proxy()'s own public-route branch already
     * returns NextResponse.next() for those paths, so the auth semantics are unchanged, but
     * login, logout and the OIDC responses now carry the security headers and are covered by the
     * Origin check. api/storage/config stays excluded: it is a bootstrap path with no
     * state-changing method at all, so there is no CSRF surface to protect and no upside to the
     * added latency.
     *
     * api/db/health is NOT excluded, unlike Phase 1's first cut: this path also backs
     * `POST /api/db/health` (a session-gated, provider-reaching "detailed health check" for a
     * specific connection - see src/app/api/db/health/route.ts), and excluding the whole path from
     * the matcher meant that POST bypassed the Origin check along with every other proxy()
     * protection, precisely the CSRF gap this phase exists to close. Running proxy() for this path
     * costs GET /api/db/health nothing observable: checkOrigin() exempts GET by method, and the
     * "Allow public routes" branch below still matches this pathname and returns
     * NextResponse.next() before any auth redirect, so load-balancer probes see no behaviour
     * change.
     *
     * Paths containing a dot get no headers FROM HERE, by design: header delivery and auth
     * redirection are two concerns that happen to share this one matcher, and the dot exclusion
     * is about the redirect. `headers()` in next.config.ts delivers the two headers that are
     * meaningful on a subresource (X-Content-Type-Options, X-Frame-Options) to those paths; see
     * the rationale block there for what it excludes and why a build-time header set must not
     * carry the CSP or HSTS.
     */
    "/((?!api/storage/config|_next/static|_next/image|.*\\..*).*)",
  ],
};
