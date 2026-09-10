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
import { emitAuditEvent, MAX_AUDIT_FIELD_LENGTH, type AuditReason } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { claimTotpStep, verifyTotp } from "@/lib/totp";

const ROUTE = "POST /api/auth/login";

/**
 * Never a valid credential; exists only so the comparison cost is identical whether or not the
 * submitted email matches a configured account. The old `u.email === email && u.password ===
 * password` short-circuited, so an unknown email did zero password work and a known one did some -
 * an enumeration oracle independent of the response body.
 */
const DUMMY_PASSWORD = "libredb-dummy-password-never-a-credential";

// Single-line and module-scoped, matching the auth messages in local-auth.ts and auth-env.ts:
// bun's line coverage under-counts the continuation lines of a wrapped string.
const MFA_REQUIRED_MESSAGE = "Enter the 6-digit code from your authenticator app";
const MFA_INVALID_MESSAGE = "Invalid authentication code";

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
    // Isolated for the same reason as the two emits in POST below: the 429 is already decided
    // (the throw below fires regardless), and a broken audit sink must not turn it into a 500.
    try {
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
    } catch (auditError) {
      logger.error("Failed to record rate_limit_exceeded audit event", auditError, { route: ROUTE });
    }
  }
  throw new RateLimitError(decision.retryAfterSeconds);
}

export async function POST(request: NextRequest) {
  const ip = clientAddress(request);
  const clientKey = ip;

  try {
    // Checked before the body is parsed: the client bucket's key is the address, which needs no
    // body to compute. Doing this first means an address that already tripped the bucket is
    // refused before this route ever attempts to parse anything - including a malformed body,
    // which the catch below cannot reach for the same reason it cannot be enforced afterwards.
    enforceLoginLimit("login_client", clientKey, "anonymous", ip);

    let email: unknown;
    let password: unknown;
    let totp: unknown;
    try {
      ({ email, password, totp } = await request.json());
    } catch {
      // A malformed body is a client error, not a server error, and - like a wrong password - is
      // a wasted attempt from this address: consume the client bucket so a caller who floods this
      // public, unauthenticated route with unparseable bodies is eventually refused (429) rather
      // than logged forever at error level, one unbounded line per request. The account bucket
      // cannot be touched here - its key comes from the body this just failed to read - which is
      // why it stays where it is below, after extraction, unlike the client bucket above.
      consumeRateLimit("login_client", clientKey);
      // Isolated for the same reason as every other emit in this route: the 400 below is already
      // decided, and a broken audit sink must not turn it into an unrelated 500.
      try {
        emitAuditEvent({
          type: "login_failure",
          action: "login",
          target: ROUTE,
          user: "anonymous",
          result: "failure",
          reason: "malformed_body",
          ip,
        });
      } catch (auditError) {
        logger.error("Failed to record login_failure audit event", auditError, { route: ROUTE });
      }
      return NextResponse.json({ success: false, message: "Invalid request body" }, { status: 400 });
    }

    // Coercion matters: createHmac().update(nonString) throws, which would turn a well-formed but
    // oddly-typed body into a 500 that differs from the uniform 401 and hands back a
    // distinguishable response.
    const submittedEmail = typeof email === "string" ? email : "";
    const submittedPassword = typeof password === "string" ? password : "";
    // Same coercion, same reason: a non-string `totp` must read as "no code supplied", never
    // reach verifyTotp's string methods and become a 500 that stands out from the uniform 401.
    const submittedTotp = typeof totp === "string" ? totp.trim() : "";
    // MAX_AUDIT_FIELD_LENGTH, not a locally redeclared copy of the same number: the actor becomes
    // an AuditEvent field either way, so both truncations must move together.
    const actor = submittedEmail.slice(0, MAX_AUDIT_FIELD_LENGTH) || "anonymous";

    // Keyed on the SUBMITTED account, hashed, and created whether or not that account exists. If
    // the bucket existed only for real accounts, the 429 would itself become the enumeration
    // oracle. This is the coupling between control 1.2 and control 1.5.
    const accountKey = hmacHex(submittedEmail.toLowerCase());

    enforceLoginLimit("login_account", accountKey, actor, ip);

    const users = getAuthUsers();
    const user = users.find((u) => u.email === submittedEmail);
    const candidate = user?.password ?? DUMMY_PASSWORD;
    const passwordMatches = secretsMatch(submittedPassword, candidate);
    const matched = user && passwordMatches ? user : null;

    // Second factor. Reached only once the password already matched, so answering "code required"
    // here is not the account-enumeration oracle the uniform 401 below exists to prevent: an
    // unknown email and a known email with a wrong password both still take that path, and a
    // caller who can reach this branch necessarily holds a working password for the account -
    // without MFA configured, that same request would simply have logged them in.
    if (matched?.totpSecret) {
      const step = submittedTotp ? verifyTotp(matched.totpSecret, submittedTotp) : null;
      // claimTotpStep is what makes an accepted code single-use (RFC 6238 §5.2). A replayed code
      // verifies but fails to claim, and lands here as an ordinary bad code.
      const accepted = step !== null && claimTotpStep(accountKey, step);

      if (!accepted) {
        const reason: AuditReason = submittedTotp ? "bad_totp" : "mfa_required";
        // A wrong code is a failed attempt and is charged for: it is the only thing between an
        // attacker holding a stolen password and a session, so guessing has to be bounded. Not
        // having supplied one yet is NOT a failed attempt - it is the first half of a
        // two-request flow, and charging it would spend the whole five-failure client budget on
        // five ordinary logins.
        if (reason === "bad_totp") {
          consumeRateLimit("login_client", clientKey);
          consumeRateLimit("login_account", accountKey);
        }
        // Isolated like every other emit in this route: the 401 below is already decided, and a
        // broken audit sink must not turn it into an unrelated 500. The mfa_required branch is
        // uncharged and therefore unbounded in volume for whoever holds the password - the same
        // property login_success already has, since a successful login resets both buckets.
        try {
          emitAuditEvent({
            type: "login_failure",
            action: "login",
            target: ROUTE,
            user: matched.email,
            result: "failure",
            reason,
            ip,
          });
        } catch (auditError) {
          logger.error("Failed to record login_failure audit event", auditError, { route: ROUTE });
        }
        // `mfaRequired` tells the client to render the code field. It carries no information the
        // caller did not already supply the password to learn (see the note above this block).
        return NextResponse.json(
          {
            success: false,
            mfaRequired: true,
            message: reason === "bad_totp" ? MFA_INVALID_MESSAGE : MFA_REQUIRED_MESSAGE,
          },
          { status: 401 },
        );
      }
    }

    if (matched) {
      await login(matched.role, matched.email);
      resetRateLimit("login_client", clientKey);
      resetRateLimit("login_account", accountKey);
      // Isolated in its own try/catch, separate from login() above, matching logout and the OIDC
      // callback: a real session has already been created by this point, so a failure to record
      // it must never turn a successful login into a 500 for a user who is in fact logged in.
      try {
        emitAuditEvent({
          type: "login_success",
          action: "login",
          target: ROUTE,
          user: matched.email,
          result: "success",
          ip,
        });
      } catch (auditError) {
        logger.error("Failed to record login_success audit event", auditError, { route: ROUTE });
      }
      return NextResponse.json({ success: true, role: matched.role });
    }

    consumeRateLimit("login_client", clientKey);
    consumeRateLimit("login_account", accountKey);
    // Isolated for the same reason as the success path above: the 401 below is already decided
    // and must not become a 500 because the audit sink itself failed.
    try {
      emitAuditEvent({
        type: "login_failure",
        action: "login",
        target: ROUTE,
        user: actor,
        result: "failure",
        reason: "bad_credentials",
        ip,
      });
    } catch (auditError) {
      logger.error("Failed to record login_failure audit event", auditError, { route: ROUTE });
    }
    return NextResponse.json({ success: false, message: "Invalid email or password" }, { status: 401 });
  } catch (error) {
    // Server is not configured for authentication (missing ADMIN_PASSWORD, or a
    // missing/too-short JWT_SECRET) — surface the error's actionable message on
    // the login screen as a 503, not a generic 500, so the operator knows exactly
    // what to fix rather than seeing a misleading "Invalid email or password".
    // This, the malformed-body 400 above, and the 401 below all keep distinct messages on
    // purpose: they depend on server configuration and request well-formedness, never on which
    // email was submitted.
    if (error instanceof AuthConfigError) {
      logger.error("Authentication is not configured", error, { route: ROUTE });
      return NextResponse.json({ success: false, message: error.message }, { status: 503 });
    }
    return createErrorResponse(error, { route: ROUTE });
  }
}
