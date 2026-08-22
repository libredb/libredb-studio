import { NextResponse } from "next/server";
import { getSession, type UserPayload } from "@/lib/auth";
import { clientAddress } from "@/lib/api/client-address";
import { createErrorResponse } from "@/lib/api/errors";
import { consumeRateLimit, RateLimitError } from "@/lib/api/rate-limit";
import { emitAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/logger";

/**
 * The single guard for routes that reach a database or an LLM provider: session check, rate limit
 * and permission_denied auditing behind one seam.
 *
 * src/proxy.ts already redirects unauthenticated requests, but middleware is an optimisation, not
 * an authorization boundary: a matcher gap (the matcher exempts any path containing a dot) or a
 * framework-level bypass would expose every route that relies on it alone. Routes that reach a
 * database or an LLM provider verify the session themselves.
 *
 * Callers invoke this outside their own try/catch. That is safe because getSession() cannot throw:
 * a missing auth-token cookie makes it return null directly, and otherwise it awaits verifyJWT(),
 * whose try block wraps the JWT secret lookup and always degrades to a returned null.
 *
 * The result is a discriminated union rather than the typed-error convention used elsewhere in
 * src/lib/api/errors.ts, because the success path must also return the session. The 429 body it
 * produces still comes from createErrorResponse, so Retry-After is constructed in one place.
 */
export type GuardResult = { response: NextResponse } | { session: UserPayload };

export async function guardRoute(opts: {
  /** "POST /api/ai/explain" - recorded verbatim in the audit trail. */
  route: string;
  bucket: "ai" | "query";
  request: Request;
}): Promise<GuardResult> {
  const ip = clientAddress(opts.request);
  const session = await getSession();

  if (!session) {
    // The denial is unconditional; only the audit line is metered. An internet scanner would
    // otherwise fill a container log volume with one line per probe.
    const notice = consumeRateLimit("anon", ip);
    if (notice.allowed || notice.tripped) {
      // Isolated in its own try/catch: the 401 below is already decided, and a broken audit sink
      // must never turn a denial this route already made into an unrelated 500.
      try {
        emitAuditEvent({
          type: "permission_denied",
          action: "denied",
          target: opts.route,
          user: "anonymous",
          result: "failure",
          reason: "no_session",
          ip,
        });
      } catch (auditError) {
        logger.error("Failed to record permission_denied audit event", auditError, { route: opts.route });
      }
    }
    return { response: NextResponse.json({ error: "Authentication required" }, { status: 401 }) };
  }

  // Keyed on username, the JWT payload's only stable identity field. role is available but is
  // deliberately unused: there is no admin/user budget tiering in Phase 1, because two tiers would
  // double the test matrix against the 100 percent coverage gate for no measured need.
  const decision = consumeRateLimit(opts.bucket, session.username);
  if (!decision.allowed) {
    if (decision.tripped) {
      // Isolated for the same reason as the no_session branch above: the 429 below is already
      // decided regardless of whether this line succeeds.
      try {
        emitAuditEvent({
          type: "rate_limit_exceeded",
          action: "throttled",
          target: opts.route,
          user: session.username,
          result: "failure",
          reason: "rate_limited",
          ip,
          bucket: opts.bucket,
        });
      } catch (auditError) {
        logger.error("Failed to record rate_limit_exceeded audit event", auditError, { route: opts.route });
      }
    }
    return {
      response: createErrorResponse(new RateLimitError(decision.retryAfterSeconds), { route: opts.route }),
    };
  }

  return { session };
}

/**
 * The audit line for a ROLE denial: an authenticated caller that holds a session but not the role
 * an endpoint requires. `guardRoute` above cannot record it, because the routes that need it check
 * the role inside their own handler after their own `getSession()`.
 *
 * METERED, on the same `anon` bucket and for the same reason the `no_session` line above is: the
 * denial is unconditional, only its record is bounded. Holding a signed non-admin token bounds how
 * many IDENTITIES can reach this branch, not how many requests each one makes - a single session,
 * stolen or not, can poll an admin route in a loop, and every line would both fill a container log
 * volume and evict real events from the 1000-entry ring the admin UI reads. Keyed on the username
 * rather than the address so one account cannot buy more lines by rotating `X-Forwarded-For`.
 *
 * Isolated in its own try/catch for the same reason guardRoute isolates its emits: the 403 is
 * already decided, and a broken audit sink must never turn a denial into an unrelated 500.
 */
export function auditRoleDenial(opts: { route: string; user: string; request: Request }): void {
  const notice = consumeRateLimit("anon", opts.user);
  if (!notice.allowed && !notice.tripped) return;
  try {
    emitAuditEvent({
      type: "permission_denied",
      action: "denied",
      target: opts.route,
      user: opts.user,
      result: "failure",
      reason: "insufficient_role",
      ip: clientAddress(opts.request),
    });
  } catch (auditError) {
    logger.error("Failed to record permission_denied audit event", auditError, { route: opts.route });
  }
}
