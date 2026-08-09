import { login } from "@/lib/auth";
import { AuthConfigError } from "@/lib/auth-errors";
import { getAuthUsers } from "@/lib/local-auth";
import { NextRequest, NextResponse } from "next/server";
import { createErrorResponse } from "@/lib/api/errors";
import { clientAddress } from "@/lib/api/client-address";
import {
  consumeRateLimit,
  peekRateLimit,
  RateLimitError,
  resetRateLimit,
  type RateLimitBucket,
} from "@/lib/api/rate-limit";
import { hmacHex, secretsMatch } from "@/lib/auth-compare";
import { emitAuditEvent, MAX_AUDIT_FIELD_LENGTH } from "@/lib/audit";
import { logger } from "@/lib/logger";

const ROUTE = "POST /api/auth/login";

/**
 * Never a valid credential; exists only so the comparison cost is identical whether or not the
 * submitted email matches a configured account. The old `u.email === email && u.password ===
 * password` short-circuited, so an unknown email did zero password work and a known one did some -
 * an enumeration oracle independent of the response body.
 */
const DUMMY_PASSWORD = "libredb-dummy-password-never-a-credential";

type LoginBucket = Extract<RateLimitBucket, "login_client" | "login_account">;

/**
 * Peek, not consume: a legitimate user who logs in repeatedly must not throttle themselves, so
 * only FAILURES spend budget. The trip is audited once per window, on the transition. The bucket
 * is recorded on the event so an operator can tell a broad address flood (login_client) apart
 * from a targeted attack on one account (login_account).
 */
function enforceLoginLimit(bucket: LoginBucket, key: string, actor: string, ip: string): void {
  const decision = peekRateLimit(bucket, key);
  if (decision.allowed) return;

  if (decision.tripped) {
    emitAuditEvent({
      type: "rate_limit_exceeded",
      action: "throttled",
      target: ROUTE,
      user: actor,
      result: "failure",
      reason: "rate_limited",
      ip,
      bucket,
    });
  }
  throw new RateLimitError(decision.retryAfterSeconds);
}

export async function POST(request: NextRequest) {
  const ip = clientAddress(request);

  try {
    const { email, password } = await request.json();

    // Coercion matters: createHmac().update(nonString) throws, which would turn a malformed body
    // into a 500 that differs from the uniform 401 and hands back a distinguishable response.
    const submittedEmail = typeof email === "string" ? email : "";
    const submittedPassword = typeof password === "string" ? password : "";
    // MAX_AUDIT_FIELD_LENGTH, not a locally redeclared copy of the same number: the actor becomes
    // an AuditEvent field either way, so both truncations must move together.
    const actor = submittedEmail.slice(0, MAX_AUDIT_FIELD_LENGTH) || "anonymous";

    const clientKey = ip;
    // Keyed on the SUBMITTED account, hashed, and created whether or not that account exists. If
    // the bucket existed only for real accounts, the 429 would itself become the enumeration
    // oracle. This is the coupling between control 1.2 and control 1.5.
    const accountKey = hmacHex(submittedEmail.toLowerCase());

    enforceLoginLimit("login_client", clientKey, actor, ip);
    enforceLoginLimit("login_account", accountKey, actor, ip);

    const users = getAuthUsers();
    const user = users.find((u) => u.email === submittedEmail);
    const candidate = user?.password ?? DUMMY_PASSWORD;
    const passwordMatches = secretsMatch(submittedPassword, candidate);
    const matched = user && passwordMatches ? user : null;

    if (matched) {
      await login(matched.role, matched.email);
      resetRateLimit("login_client", clientKey);
      resetRateLimit("login_account", accountKey);
      emitAuditEvent({
        type: "login_success",
        action: "login",
        target: ROUTE,
        user: matched.email,
        result: "success",
        ip,
      });
      return NextResponse.json({ success: true, role: matched.role });
    }

    consumeRateLimit("login_client", clientKey);
    consumeRateLimit("login_account", accountKey);
    emitAuditEvent({
      type: "login_failure",
      action: "login",
      target: ROUTE,
      user: actor,
      result: "failure",
      reason: "bad_credentials",
      ip,
    });
    return NextResponse.json({ success: false, message: "Invalid email or password" }, { status: 401 });
  } catch (error) {
    // Server is not configured for authentication (missing ADMIN_PASSWORD, or a
    // missing/too-short JWT_SECRET) — surface the error's actionable message on
    // the login screen as a 503, not a generic 500, so the operator knows exactly
    // what to fix rather than seeing a misleading "Invalid email or password".
    // This and the malformed-body 500 keep their distinct messages on purpose: they depend on
    // server configuration and request well-formedness, never on which email was submitted.
    if (error instanceof AuthConfigError) {
      logger.error("Authentication is not configured", error, { route: ROUTE });
      return NextResponse.json({ success: false, message: error.message }, { status: 503 });
    }
    return createErrorResponse(error, { route: ROUTE });
  }
}
