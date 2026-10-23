import { WORKSPACE_OWNER_HEADER, withBasePath } from "@/lib/config/base-path";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { NextRequest, NextResponse } from "next/server";
import { jwtVerify } from "jose";
import { AGENT_DRIVE_HEADER, AGENT_DRIVE_PATH, verifyAgentDriveToken } from "@/lib/agent/drive-token";
import { clientAddress } from "@/lib/api/client-address";
import { checkOrigin } from "@/lib/api/origin-check";
import { consumeRateLimit } from "@/lib/api/rate-limit";
import { emitAuditEvent, MAX_AUDIT_FIELD_LENGTH } from "@/lib/audit";
import { readLaunchConfig } from "@/lib/launch/config";
import { logger } from "@/lib/logger";
import { auditMcpDenial, authenticateMcpRequest } from "@/lib/mcp/bearer";
import { MCP_PATH } from "@/lib/mcp/config";
import { mcpOriginHostRefusal } from "@/lib/mcp/origin-policy";
import { authenticateBearer, type BearerAuthentication } from "@/lib/oidc-bearer";
import { getJwtSecret } from "@/lib/config/auth-env";
import { readOidcAutoRedirect } from "@/lib/config/oidc-auto-redirect";
import { governanceEnabled } from "@/lib/governance/config";
import { withSecurityHeaders } from "@/lib/security/config";
import { RETURN_PATH_PARAM, safeReturnPath, sessionRequiredBody, signInPath } from "@/lib/api/session-ended";

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

const WORKSPACE_OWNER_MISMATCH_BODY = {
  error: "This page's workspace belongs to a different account than the one signed in. Reload the page.",
  code: ApiErrorCode.WORKSPACE_OWNER_MISMATCH,
};

const BEARER_REFUSED = "Invalid access token";

/**
 * A verified access token Studio still refuses, by audit reason: 403 with a code of its own, so a native client shows
 * the refusal instead of refreshing a token that is refused again until an administrator changes the account.
 */
const BEARER_ACCOUNT_REFUSED_BODY = {
  bearer_no_role: {
    error: "This account has no role in Studio. Ask an administrator for access.",
    code: ApiErrorCode.BEARER_NO_ROLE,
  },
  bearer_no_identity: {
    error:
      "The access token carries no user name Studio can use. Ask an administrator to check the account's email and username.",
    code: ApiErrorCode.BEARER_NO_IDENTITY,
  },
} as const;

const IDENTITY_PROVIDER_UNAVAILABLE_BODY = {
  error: "The identity provider could not be reached to verify the access token. Try again.",
  code: ApiErrorCode.IDENTITY_PROVIDER_UNAVAILABLE,
};

/** The sentence POST /api/auth/launch answers while launch sign-in is off. */
const LAUNCH_NOT_ENABLED = "Launch sign-in is not enabled on this server.";

/** What the /launch page answers instead of loading: plain text, never cached. */
function launchPageAnswer(text: string, status: number): NextResponse {
  return new NextResponse(text, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** The account a workspace owner header names, or null when it is not a valid encoding. */
function decodedOwner(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export async function proxy(request: NextRequest) {
  // NextURL removes the configured basePath before exposing pathname; Next also
  // prefixes config.matcher at build time. Keep authorization checks app-relative.
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

  // The MCP endpoint (#246). Matched before the cookie is read, so the session cookie is never
  // consulted on this path: an MCP client authenticates with a scoped bearer token of its own,
  // and a browser cannot attach one on its own. The exact match keeps /api/mcp/token, which mints
  // those tokens for a signed-in user, on the ordinary session path below. The route verifies all
  // of this again: middleware is an optimisation, not the authorization boundary.
  if (pathname === MCP_PATH) {
    return withSecurityHeaders(await mcpGate(request));
  }

  const token = request.cookies.get("auth-token")?.value;

  // If accessing /login with a valid token, redirect authenticated users
  if (pathname.startsWith("/login")) {
    if (token) {
      try {
        const { payload } = await jwtVerify(token, jwtSecret());
        const role = payload.role as string;
        // Redirect authenticated users to the page the sign-in link names (`next`, judged as the
        // sign-in form judges it), else to their role's landing page
        const returnPath = safeReturnPath(request.nextUrl.searchParams.get(RETURN_PATH_PARAM));
        const landing = returnPath ?? (role === "admin" ? "/admin" : "/");
        return withSecurityHeaders(NextResponse.redirect(new URL(withBasePath(landing), request.url)));
      } catch {
        // Invalid token, allow access to login page
        logger.debug("Invalid token on login page, allowing access", { route: "proxy" });
      }
    }
    // No valid token: the identity provider when OIDC_AUTO_REDIRECT asks for it, else the login page
    return withSecurityHeaders(oidcAutoRedirect(request) ?? NextResponse.next());
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

  // Under governance, under OIDC, or with a broken launch configuration, no launch can sign anyone in
  // (docs/LAUNCH.md), so the page answers what POST /api/auth/launch answers instead of loading a form that can
  // only fail. Governance mode has no launch sign-in at all, so it answers 404 before the launch configuration is
  // read, as if launch sign-in did not exist. Kept above the public list, which tests/api/proxy.test.ts pins
  // literal by literal. This answer leaves the token in the address bar and the history entry, which is harmless:
  // the fragment never reaches a server, the token is unspent and refused here while this answer holds, it
  // expires a minute after minting, and its audience names only this Studio.
  if (pathname === "/launch") {
    if (governanceEnabled()) return withSecurityHeaders(launchPageAnswer(LAUNCH_NOT_ENABLED, 404));
    const launch = readLaunchConfig();
    if (launch.state === "misconfigured") return withSecurityHeaders(launchPageAnswer(launch.problem, 503));
  }

  // A public route that answers from the session when a request offers one decides its Bearer header here, as every
  // other API route does below, so a client reads a refused token, a refused account and an unreachable provider apart
  // there too. The other public routes never read the header, so an expired token cannot stop a sign-in.
  if (sessionReadingPublicRoute(request.method, pathname)) {
    const bearer = await apiBearer(request, pathname);
    if (bearer !== null) return withSecurityHeaders(bearerAnswer(request, pathname, bearer));
  }

  // Allow public routes
  if (
    pathname.startsWith("/api/auth") ||
    pathname.startsWith("/_next") ||
    isStaticAsset ||
    pathname === "/favicon.ico" ||
    // Health check endpoints for load balancers (Render, K8s, etc.). Three paths, because
    // an operator reaches for whichever one their platform's form defaults to, and a health
    // path that answers with a redirect to the login screen reads as healthy to any check
    // that follows redirects (#909).
    pathname === "/health" ||
    pathname === "/api/health" ||
    pathname === "/api/db/health" ||
    // Readiness (docs/GOVERNANCE.md#freshness-and-readiness): an orchestrator's probe carries no session, and the route
    // reads only the in-process governance state.
    pathname === "/api/ready" ||
    // Storage config endpoint (public, returns only mode info)
    pathname === "/api/storage/config" ||
    // The launch page (docs/LAUNCH.md) creates the session, so it cannot require one; it shows only a status
    // line until POST /api/auth/launch has verified the token its fragment carries.
    pathname === "/launch"
  ) {
    return withSecurityHeaders(NextResponse.next());
  }

  // An API call may carry an identity provider's access token instead of the cookie (src/lib/oidc-bearer.ts). While
  // the channel is on, a Bearer header decides alone, even next to a valid cookie; off, or with another scheme, it is
  // ignored as it always was. A page never takes one.
  const bearer = await apiBearer(request, pathname);
  if (bearer !== null) return withSecurityHeaders(bearerAnswer(request, pathname, bearer));

  if (!token) {
    return withSecurityHeaders(signInRequired(request, pathname, "Authentication required"));
  }

  try {
    const { payload } = await jwtVerify(token, jwtSecret());
    const role = payload.role as string;

    const ownerMismatch = workspaceOwnerMismatch(request, payload.username);
    if (ownerMismatch !== null) return withSecurityHeaders(ownerMismatch);

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
      return withSecurityHeaders(NextResponse.redirect(new URL(withBasePath("/"), request.url)));
    }

    return withSecurityHeaders(NextResponse.next());
  } catch {
    logger.warn("JWT verification failed, refusing the session", { route: "proxy" });
    return withSecurityHeaders(signInRequired(request, pathname, "Session expired. Sign in again."));
  }
}

/**
 * A tab that claimed the browser copy names that account on every request (docs/STORAGE.md). One that names a different
 * account than the session's is answered here, before any route runs, and the tab reloads to claim the copy again. A
 * request without the header (MCP, the agent drive callback, an external client, local mode) is not checked.
 */
function workspaceOwnerMismatch(request: NextRequest, username: unknown): NextResponse | null {
  const claimed = request.headers.get(WORKSPACE_OWNER_HEADER);
  if (claimed === null || decodedOwner(claimed) === username) return null;
  return NextResponse.json(WORKSPACE_OWNER_MISMATCH_BODY, { status: 409 });
}

function isApiPath(pathname: string): boolean {
  return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * The public routes that read the session (getSession) when there is one: who is signed in, the sign-out record, and
 * the detailed health check of a connection. The liveness GET of /api/db/health reads none.
 */
function sessionReadingPublicRoute(method: string, pathname: string): boolean {
  return (
    pathname === "/api/auth/me" ||
    pathname === "/api/auth/logout" ||
    (method === "POST" && pathname === "/api/db/health")
  );
}

type TakenBearer = Exclude<BearerAuthentication, { kind: "absent" }>;

/** What the bearer channel says of an API call, or null for a page or a call it leaves to the cookie. */
async function apiBearer(request: NextRequest, pathname: string): Promise<TakenBearer | null> {
  if (!isApiPath(pathname)) return null;
  const bearer = await authenticateBearer(request.headers.get("authorization"));
  return bearer.kind === "absent" ? null : bearer;
}

/**
 * The answer to an API call whose Bearer header the channel took. A refused token is 401 with the bearer challenge and
 * never a redirect, a verified token whose account Studio refuses is 403, both audited and metered as the Origin
 * refusal is; a fault is the provider's or the configuration's, 503, logged
 * and not audited, so neither the client nor an operator reads it as a bad token. The route verifies the token again.
 */
function bearerAnswer(request: NextRequest, pathname: string, bearer: TakenBearer): NextResponse {
  if (bearer.kind === "authenticated") {
    return workspaceOwnerMismatch(request, bearer.session.username) ?? NextResponse.next();
  }
  if (bearer.kind === "fault") {
    logger.error("Could not verify a bearer access token", bearer.error, { route: "proxy" });
    return NextResponse.json(IDENTITY_PROVIDER_UNAVAILABLE_BODY, { status: 503 });
  }
  const address = clientAddress(request);
  const notice = consumeRateLimit("anon", address);
  if (notice.allowed || notice.tripped) {
    try {
      emitAuditEvent({
        type: "permission_denied",
        action: "denied",
        target: `${request.method} ${pathname}`.slice(0, MAX_AUDIT_FIELD_LENGTH),
        user: "anonymous",
        result: "failure",
        reason: bearer.reason,
        ip: address,
      });
    } catch (auditError) {
      logger.error("Failed to record a bearer refusal audit event", auditError, { route: "proxy" });
    }
  }
  if (bearer.reason !== "bearer_token_invalid") {
    return NextResponse.json(BEARER_ACCOUNT_REFUSED_BODY[bearer.reason], { status: 403 });
  }
  return NextResponse.json(sessionRequiredBody(BEARER_REFUSED), {
    status: 401,
    headers: { "WWW-Authenticate": 'Bearer error="invalid_token"' },
  });
}

/**
 * The redirect a signed-out GET /login takes straight to the identity provider (OIDC_AUTO_REDIRECT,
 * docs/OIDC.md), or null to render the login page. It carries `next` only when safeReturnPath
 * accepts it, and it is skipped whenever `error` is present: every OIDC failure lands on
 * /login?error=..., so a failing provider shows its error instead of looping.
 */
function oidcAutoRedirect(request: NextRequest): NextResponse | null {
  if (request.method !== "GET" || process.env.NEXT_PUBLIC_AUTH_PROVIDER !== "oidc") return null;
  const { searchParams } = request.nextUrl;
  if (searchParams.has("error") || !readOidcAutoRedirect()) return null;
  const returnPath = safeReturnPath(searchParams.get(RETURN_PATH_PARAM));
  const query = returnPath === null ? "" : `?${new URLSearchParams({ [RETURN_PATH_PARAM]: returnPath })}`;
  return NextResponse.redirect(new URL(withBasePath(`/api/auth/oidc/login${query}`), request.url));
}

/**
 * A page goes to the sign-in screen; an API call is answered 401 JSON instead (#1420). An API
 * caller is a fetch, not a tab: it followed the redirect to /login, received the sign-in page's
 * HTML, and every client caller then failed to parse it ("Unexpected token '<'") with nothing
 * sending the user to sign in. The JSON carries the AUTH_REQUIRED code the browser keys on.
 *
 * A page keeps its address as the sign-in page's `next`, so a link such as `/?connection=<id>`
 * opens what it named once the user has signed in. It is app-relative, because `nextUrl` has
 * already removed the base path and withBasePath adds it once here. The bare root carries none,
 * and sign-in then lands on the role's own page as before.
 */
function signInRequired(request: NextRequest, pathname: string, error: string): NextResponse {
  if (isApiPath(pathname)) {
    return NextResponse.json(sessionRequiredBody(error), { status: 401 });
  }
  const { search } = request.nextUrl;
  const target = pathname === "/" && search === "" ? "/login" : signInPath(`${pathname}${search}`);
  return NextResponse.redirect(new URL(withBasePath(target), request.url));
}

/**
 * Origin on every method, Host on a loopback bind, then the bearer, each refusal audited by the
 * helper the route uses too. A request that passes continues to the route, as the drive path does.
 */
async function mcpGate(request: NextRequest): Promise<NextResponse> {
  const refusal = mcpOriginHostRefusal(request);
  if (refusal !== null) {
    auditMcpDenial(request, refusal.reason);
    return asNextResponse(refusal.response);
  }
  const authentication = await authenticateMcpRequest(request);
  if (authentication.kind === "denied") auditMcpDenial(request, authentication.reason);
  if (authentication.kind !== "authenticated") return asNextResponse(authentication.response);
  return NextResponse.next();
}

/** withSecurityHeaders takes a NextResponse, and the SDK's helpers answer a plain Response. */
function asNextResponse(response: Response): NextResponse {
  return new NextResponse(response.body, { status: response.status, headers: response.headers });
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
    // The dot exclusion above is for static assets, and an API path is never one: this entry puts
    // an API path with a dot back under the Origin check and the security headers. An email in
    // /api/admin/accounts/<email> is the case that needs it. proxy() may still take such a path for
    // a static asset and skip its login redirect; the route's own session check is the boundary.
    "/api/(.*\\..*)",
    // The catch-all requires a slash after basePath. Next compiles this explicit
    // root matcher to also cover the bare mount path (for example /tools/libredb).
    "/",
  ],
};
