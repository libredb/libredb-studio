import { NextResponse } from "next/server";
import { readBoundedJson } from "@/lib/api/bounded-json";
import { clientAddress } from "@/lib/api/client-address";
import { createErrorResponse } from "@/lib/api/errors";
import { enforceLoginLimit } from "@/lib/api/login-budget";
import { consumeRateLimit, resetRateLimit } from "@/lib/api/rate-limit";
import { type AuditEvent, type AuditReason, emitAuditEvent } from "@/lib/audit";
import { getSession, login } from "@/lib/auth";
import { AuthConfigError } from "@/lib/auth-errors";
import { isRecord } from "@/lib/is-record";
import { readLaunchConfig } from "@/lib/launch/config";
import { type LaunchClaims, LaunchTokenError, verifyLaunchToken } from "@/lib/launch/verify";
import { AccountError, provisionLaunchAccount, sameEmail } from "@/lib/local-accounts";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const ROUTE = "POST /api/auth/launch";

/** A platform's launch token is a few hundred bytes; a body near this limit carries no launch token. */
const LAUNCH_BODY_MAX_BYTES = 8192;

const NOT_ENABLED = "Launch sign-in is not enabled on this server.";
const INVALID_BODY = "Invalid request body";
const TOO_LARGE = "Request body is too large";

const NO_STORE = "no-store";

function answer(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": NO_STORE } });
}

type LaunchAudit = Pick<AuditEvent, "type" | "user" | "result" | "reason">;

// Isolated like every emit in the login route: the answer is already decided, and a broken audit sink must not
// turn it into a 500.
function audit(event: LaunchAudit, ip: string): void {
  try {
    emitAuditEvent({ ...event, action: "login", target: ROUTE, ip });
  } catch (auditError) {
    logger.error(`Failed to record ${event.type} audit event`, auditError, { route: ROUTE });
  }
}

// Every refusal is a wasted attempt from this address and spends the password login's client budget, so a
// caller flooding this public route is refused with 429 before a body is read, as a password guesser is.
function refuse(
  status: number,
  message: string,
  user: string,
  reason: AuditReason,
  ip: string,
  details: Record<string, string> = {},
): NextResponse {
  consumeRateLimit("login_client", ip);
  audit({ type: "login_failure", user, result: "failure", reason }, ip);
  return answer({ success: false, message, ...details }, status);
}

/** Where the launch page sends the new session: the requested seeded connection, or the editor. */
function redirectFor(claims: LaunchClaims): string {
  return claims.conn === undefined ? "/" : `/?connection=${encodeURIComponent(`seed:${claims.conn}`)}`;
}

function sessionConflict(current: string, incoming: string): string {
  return `This browser is already signed in to Studio as ${current}, and this launch link is for ${incoming}. Sign out, then open Studio again from the platform to continue as ${incoming}.`;
}

/** Which audit reason a refusal from provisionLaunchAccount carries, by its status. */
function accountRefusal(status: number): AuditReason {
  if (status === 401) return "launch_account_disabled";
  if (status === 403) return "launch_identity_mismatch";
  return "account_refused";
}

/**
 * Exchanges a platform launch token for a session (docs/LAUNCH.md). The /launch page posts the token
 * here from the URL fragment, so the token never appears in an access log, and the route is public
 * because it creates the session.
 */
export async function POST(request: Request) {
  const ip = clientAddress(request);
  const config = readLaunchConfig();
  // Off answers as if the route did not exist, before any budget is checked or any body read, so a
  // deployment that never configured launch sign-in behaves exactly as before. Misconfigured includes
  // NEXT_PUBLIC_AUTH_PROVIDER=oidc, where no launch may sign anyone in (src/lib/launch/config.ts).
  if (config.state === "off") return answer({ success: false, message: NOT_ENABLED }, 404);
  if (config.state === "misconfigured") return answer({ success: false, message: config.problem }, 503);
  let claims: LaunchClaims | null = null;
  try {
    enforceLoginLimit("login_client", ip, "anonymous", ip, ROUTE);
    const read = await readBoundedJson(request, LAUNCH_BODY_MAX_BYTES);
    if (!read.ok) {
      return refuse(read.status, read.status === 413 ? TOO_LARGE : INVALID_BODY, "anonymous", "malformed_body", ip);
    }
    const token = isRecord(read.body) ? read.body.token : undefined;
    if (typeof token !== "string" || token === "") return refuse(400, INVALID_BODY, "anonymous", "malformed_body", ip);
    claims = await verifyLaunchToken(token, config);
    // A launch never replaces a session for another account (docs/LAUNCH.md): a link someone else sent must
    // not swap this browser into their account, where what the person saves would land. The token is spent
    // all the same, so continuing as the other account takes a sign-out and a fresh launch. Checked before
    // provisioning, so a refused swap creates no account and changes no role.
    const current = await getSession();
    if (current && !sameEmail(current.username, claims.email)) {
      return refuse(409, sessionConflict(current.username, claims.email), claims.email, "launch_session_conflict", ip, {
        signedInAs: current.username,
        launchFor: claims.email,
      });
    }
    // The verifier matched the token's iss to config.issuer, so the configured value is the token's.
    const account = await provisionLaunchAccount({
      email: claims.email,
      role: claims.role,
      issuer: config.issuer,
      subject: claims.sub,
    });
    await login(account.role, account.username, account.sessionVersion);
    // A session clears this address's failures, as a password sign-in does. The per-account budget is
    // never touched here: a launch is not a password guess, so it neither spends nor clears one.
    resetRateLimit("login_client", ip);
    audit({ type: "login_success", user: account.username, result: "success" }, ip);
    return answer({ success: true, redirect: redirectFor(claims) });
  } catch (error) {
    // A refused token names no one: its claims are not an identity until the token verified. A full replay
    // memory refuses a token that did verify, for this server's sake rather than the token's, so it is a 503.
    if (error instanceof LaunchTokenError) {
      const status = error.reason === "launch_capacity_exceeded" ? 503 : 401;
      return refuse(status, error.message, "anonymous", error.reason, ip);
    }
    // Only provisioning throws AccountError, after the token verified. 401 is a disabled account, 403 one a
    // launch cannot sign in to; the rest is a role change the store refused or one that crossed another write
    // to the account.
    if (error instanceof AccountError) {
      return refuse(error.status, error.message, claims?.email ?? "anonymous", accountRefusal(error.status), ip);
    }
    // A valid token met a server that cannot sign sessions (JWT_SECRET) or seed its registry
    // (ADMIN_PASSWORD): the operator's problem, named as the login route names it.
    if (error instanceof AuthConfigError) {
      logger.error("Authentication is not configured", error, { route: ROUTE });
      return answer({ success: false, message: error.message }, 503);
    }
    const response = createErrorResponse(error, { route: ROUTE });
    response.headers.set("Cache-Control", NO_STORE);
    return response;
  }
}
