import { clientAddress } from "@/lib/api/client-address";
import { consumeRateLimit, peekRateLimit, RateLimitError, type RateLimitBucket } from "@/lib/api/rate-limit";
import { emitAuditEvent } from "@/lib/audit";
import { hmacHex } from "@/lib/auth-compare";
import { AccountError } from "@/lib/local-accounts";
import { logger } from "@/lib/logger";

type LoginBucket = Extract<RateLimitBucket, "login_client" | "login_account" | "passkey_client">;

/**
 * Peek, not consume: a legitimate user who logs in repeatedly must not throttle themselves, so
 * only FAILURES spend budget. The trip is audited once per window, on the transition, with the
 * calling route (login, TOTP or passkey sign-in) as its target. The bucket is recorded on the
 * event so an operator can tell a broad address flood (login_client) apart from a targeted attack
 * on one account (login_account) or a passkey retry storm (passkey_client).
 */
export function enforceLoginLimit(bucket: LoginBucket, key: string, actor: string, ip: string, route: string): void {
  const decision = peekRateLimit(bucket, key);
  if (decision.allowed) return;

  if (decision.tripped) {
    // Isolated because the 429 is already decided (the throw below fires regardless), and a
    // broken audit sink must not turn it into a 500.
    try {
      emitAuditEvent({
        type: "rate_limit_exceeded",
        action: "throttled",
        target: route,
        user: actor,
        result: "failure",
        reason: "rate_limited",
        ip,
        bucket,
      });
    } catch (auditError) {
      logger.error("Failed to record rate_limit_exceeded audit event", auditError, { route });
    }
  }
  throw new RateLimitError(decision.retryAfterSeconds);
}

/**
 * For routes that check the current password or code of a signed-in owner (TOTP setup and
 * removal, passkey registration and removal), which makes each a guessing surface. It spends the
 * login route's two budgets, keyed the same way, so the guesses a caller gets are the same
 * whichever route they use.
 */
export async function withLoginBudget<T>(request: Request, email: string, run: () => Promise<T>): Promise<T> {
  const budgets = [
    { bucket: "login_client", key: clientAddress(request) },
    { bucket: "login_account", key: hmacHex(email.toLowerCase()) },
  ] as const;
  for (const { bucket, key } of budgets) {
    const decision = peekRateLimit(bucket, key);
    if (!decision.allowed) throw new RateLimitError(decision.retryAfterSeconds);
  }
  try {
    return await run();
  } catch (error) {
    if (error instanceof AccountError && error.status === 401) {
      for (const { bucket, key } of budgets) consumeRateLimit(bucket, key);
    }
    throw error;
  }
}
