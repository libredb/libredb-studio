import { NextResponse } from "next/server";
import { readBoundedJson } from "@/lib/api/bounded-json";
import { clientAddress } from "@/lib/api/client-address";
import { createErrorResponse } from "@/lib/api/errors";
import { enforceLoginLimit } from "@/lib/api/login-budget";
import { consumeRateLimit } from "@/lib/api/rate-limit";
import { type AuditEvent, emitAuditEvent } from "@/lib/audit";
import { login } from "@/lib/auth";
import { AuthConfigError } from "@/lib/auth-errors";
import { isRecord } from "@/lib/is-record";
import { AccountError } from "@/lib/local-accounts";
import { logger } from "@/lib/logger";
import { PASSKEY_BODY_MAX_BYTES } from "@/lib/passkey/policy";
import { beginPasskeySignIn, completePasskeySignIn, type PasskeySignIn } from "@/lib/passkey/sign-in";
import { PasskeyRefusal } from "@/lib/passkey/webauthn";

export const dynamic = "force-dynamic";

const ROUTE = "POST /api/auth/passkey/sign-in";

// One body for every refusal, whatever the reason, so the answer names no account or credential.
// It sends the user to the password: the commonest refusal is a passkey removed from Studio, which never succeeds.
const SIGN_IN_FAILED =
  "That passkey could not sign you in. If it was removed from Studio, delete it from your password manager too. Sign in with your password.";
const INVALID_BODY = "Invalid request body";
const TOO_LARGE = "Request body is too large";

const NO_STORE = "no-store";

function answer(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: { "Cache-Control": NO_STORE } });
}

type SignInAudit = Pick<AuditEvent, "type" | "user" | "result" | "reason" | "passkey">;

// Isolated like every emit in the login route: the answer is already decided, and a broken audit sink must not
// turn it into a 500.
function audit(event: SignInAudit, ip: string): void {
  try {
    emitAuditEvent({ ...event, action: "login", target: ROUTE, ip });
  } catch (auditError) {
    logger.error(`Failed to record ${event.type} audit event`, auditError, { route: ROUTE });
  }
}

// A malformed body is a wasted attempt from this address, charged to the passkey budget so a flood of garbage is
// eventually refused.
function malformed(status: 400 | 413, ip: string): NextResponse {
  consumeRateLimit("passkey_client", ip);
  audit({ type: "login_failure", user: "anonymous", result: "failure", reason: "malformed_body" }, ip);
  return answer({ success: false, message: status === 413 ? TOO_LARGE : INVALID_BODY }, status);
}

async function verify(body: unknown, ip: string): Promise<NextResponse> {
  let signIn: PasskeySignIn;
  try {
    signIn = await completePasskeySignIn(body);
  } catch (error) {
    if (!(error instanceof PasskeyRefusal)) throw error;
    // Only passkey_client: a signature cannot be guessed, so charging login_account would only hand whoever
    // holds a credential ID a lockout of its owner, and login_client would lock password sign-in out.
    consumeRateLimit("passkey_client", ip);
    audit(
      {
        type: "login_failure",
        user: error.context.email ?? "anonymous",
        result: "failure",
        reason: error.reason,
        passkey: error.context.passkeyId,
      },
      ip,
    );
    return answer({ success: false, message: SIGN_IN_FAILED }, 401);
  }
  const { account, passkeyId } = signIn;
  // The account row read after the signature verified, so the session carries its current role and version.
  await login(account.role, account.email, account.sessionVersion);
  audit({ type: "login_success", user: account.email, result: "success", passkey: passkeyId }, ip);
  return answer({ success: true, role: account.role });
}

export async function POST(request: Request) {
  const ip = clientAddress(request);
  try {
    // Before the body is read, so an address over its budget is refused before any parsing or verification.
    enforceLoginLimit("passkey_client", ip, "anonymous", ip, ROUTE);
    const read = await readBoundedJson(request, PASSKEY_BODY_MAX_BYTES);
    if (!read.ok) return malformed(read.status, ip);
    const action = isRecord(read.body) ? read.body.action : undefined;
    if (action === "options") return answer({ options: await beginPasskeySignIn() });
    if (action !== "verify") return malformed(400, ip);
    return await verify(read.body, ip);
  } catch (error) {
    // No log line: an anonymous caller could write one per request, and the configuration reader already warns
    // once per process while PASSKEY_ORIGIN is set but unusable.
    if (error instanceof AuthConfigError) return answer({ success: false, message: error.message }, 503);
    if (error instanceof AccountError) return answer({ success: false, message: error.message }, error.status);
    const response = createErrorResponse(error, { route: ROUTE });
    response.headers.set("Cache-Control", NO_STORE);
    return response;
  }
}
