/**
 * API Error Response Standardization
 * Centralized error-to-HTTP mapping for all API routes
 */

import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { ApiErrorCode } from "./error-codes";
import { databaseErrorBody, internalErrorBody, withWithheldText, type ApiErrorResponse } from "./error-body";
import { type ProviderTextScrub, errorRecord, withheldProviderError } from "@/lib/db/operations/provider-text";
import {
  LLMError,
  LLMAuthError,
  LLMConfigError,
  LLMRateLimitError,
  LLMSafetyError,
  LLMStreamError,
  isContextLengthError,
} from "@/lib/llm/types";
import { RateLimitError } from "@/lib/api/rate-limit";
import { SeedConnectionError } from "@/lib/seed/resolve-connection";
import { VaultError } from "@/lib/seed/vault-client";
import { ConnectionWriteRefused } from "@/lib/storage/types";

// ============================================================================
// Types
// ============================================================================

export type { ApiErrorResponse } from "./error-body";

// ============================================================================
// Error → HTTP Mapping
// ============================================================================

/**
 * The answer and the log line for a thrown value. `scrub` is the calling connection's core scrub, passed by a route
 * once its connection is resolved. Given a scrub, the detection (`withheldProviderError`) runs once over the error,
 * whatever its class, and every branch reads it: an error whose text holds a credential of the connection answers its
 * branch's own status, code, kind, outcome and `retryable` with only its texts replaced by the withheld error's
 * message (`withWithheldText` on a database error's body), and every log line given the error is given the withheld
 * error instead, so no answer or log line built under a scrub carries a credential of that connection. A branch that
 * answers a fixed sentence of Studio's keeps it. Given a scrub, a database error's body also carries the `sqlState`
 * of its error record (`errorRecord`), which the record holds only when the error's text was not withheld, so the body
 * is the record's fields beside its texts; without a scrub no body carries one, because the record's string fields
 * are only built through the scrub. `logged` is true for a failure its caller logged already, a provider package's
 * failure `packageFailureAnswer` answered (src/lib/api/package-errors.ts): no branch then writes its line, so the
 * failure is logged once, and every branch answers the same body.
 */
export function createErrorResponse(
  error: unknown,
  context?: { route?: string; scrub?: ProviderTextScrub; logged?: boolean },
): NextResponse<ApiErrorResponse> {
  const route = context?.route;
  /** Whether this failure gets its branch's log line: not when its caller logged it already. */
  const logs = context?.logged !== true;
  const withheld = context?.scrub === undefined ? null : withheldProviderError(context.scrub, error);
  /** The error's own text for an answer, or the withheld error's message when the detection found a credential. */
  const answered = (text: string): string => withheld?.message ?? text;

  // --- Seed Connection Error ---
  if (error instanceof SeedConnectionError) {
    if (logs) logger.warn("Seed connection error", { route, statusCode: error.statusCode });
    // A refusal that names its own code keeps it (the custom-connections switch); every other one
    // takes the code its status implies, as before.
    const code =
      error.code ??
      (error.statusCode === 403 || error.statusCode === 401
        ? ApiErrorCode.AUTH_ERROR
        : error.statusCode === 400
          ? ApiErrorCode.CONFIG_ERROR
          : undefined);
    return NextResponse.json(
      { error: answered(error.message), ...(code ? { code } : {}), statusCode: error.statusCode },
      { status: error.statusCode },
    );
  }

  // --- Seed Connection: Vault reference ---
  // Every way a `${vault:...}` reference fails is an operator configuration fault: an
  // unset VAULT_ADDR, a v1-shaped path, a key that is not in the secret, a policy that
  // does not grant the path, or a Vault this deployment cannot reach. None of those is
  // the product failing, so it takes the same class as DatabaseConfigError rather than
  // the generic 500, and the message - which names the variable or the path - is what
  // an operator reads to fix it.
  if (error instanceof VaultError) {
    if (logs) logger.warn("Vault reference error", { route });
    return NextResponse.json(
      { error: answered(error.message), code: ApiErrorCode.CONFIG_ERROR, statusCode: 400 },
      { status: 400 },
    );
  }

  // --- Storage: a connections list a write refused ---
  // The client sent a connection that cannot be sealed for its place (a secret that is not text, or a record with no
  // binding). The message names the list index and the field path, never a value, and nothing was written.
  if (error instanceof ConnectionWriteRefused) {
    if (logs) logger.warn("Connection write refused", { route });
    return NextResponse.json({ error: answered(error.message), statusCode: 400 }, { status: 400 });
  }

  // --- DB: every DatabaseError class, answered by the Next-free error body ---
  const answer = databaseErrorBody(error);
  if (answer !== null) {
    const { level, message, context: logContext } = answer.log;
    if (logs && level === "error") logger.error(message, withheld ?? error, { route, ...logContext });
    else if (logs) logger[level](message, { route, ...logContext });
    const texts = withheld === null ? answer.body : withWithheldText(answer.body, withheld.message);
    const sqlState = context?.scrub === undefined ? undefined : errorRecord(context.scrub, error).sqlState;
    const body = sqlState === undefined ? texts : { ...texts, sqlState };
    return NextResponse.json(body, { status: body.statusCode });
  }

  // --- LLM: Safety ---
  if (error instanceof LLMSafetyError) {
    if (logs) logger.warn("LLM safety filter triggered", { route, provider: error.provider });
    return NextResponse.json(
      { error: "The prompt was blocked by safety filters.", code: ApiErrorCode.LLM_SAFETY, statusCode: 400 },
      { status: 400 },
    );
  }

  // --- LLM: Auth ---
  if (error instanceof LLMAuthError) {
    if (logs) logger.warn("LLM auth error", { route, provider: error.provider });
    return NextResponse.json(
      { error: "Invalid API key. Please check your configuration.", code: ApiErrorCode.LLM_AUTH, statusCode: 401 },
      { status: 401 },
    );
  }

  // --- LLM: Rate Limit ---
  if (error instanceof LLMRateLimitError) {
    if (logs) logger.warn("LLM rate limit", { route, provider: error.provider });
    return NextResponse.json(
      {
        error: "AI usage limit reached. Please try again later or check your billing status.",
        code: ApiErrorCode.LLM_RATE_LIMIT,
        statusCode: 429,
        retryable: true,
      },
      { status: 429 },
    );
  }

  // --- LLM: Config ---
  if (error instanceof LLMConfigError) {
    if (logs) logger.warn("LLM config error", { route, provider: error.provider });
    // Missing credentials may be intentional; a malformed model, URL or provider is still a setup error.
    const code = error.reason === "missing_credentials" ? ApiErrorCode.LLM_UNCONFIGURED : ApiErrorCode.LLM_CONFIG;
    return NextResponse.json({ error: answered(error.message), code, statusCode: 503 }, { status: 503 });
  }

  // --- LLM: Stream ---
  if (error instanceof LLMStreamError) {
    if (logs) logger.error("LLM stream error", withheld ?? error, { route, provider: error.provider });
    if (isContextLengthError(error)) {
      return NextResponse.json(
        {
          error: "The request is too large for the configured model's context.",
          code: ApiErrorCode.LLM_STREAM,
          statusCode: 502,
          retryable: false,
        },
        { status: 502 },
      );
    }
    return NextResponse.json(
      { error: answered(error.message), code: ApiErrorCode.LLM_STREAM, statusCode: 502, retryable: true },
      { status: 502 },
    );
  }

  // --- LLM: generic LLMError (base class catch-all) ---
  if (error instanceof LLMError) {
    const status = error.statusCode ?? 500;
    if (logs) logger.error("LLM error", withheld ?? error, { route, provider: error.provider });
    return NextResponse.json(
      { error: answered(error.message), code: ApiErrorCode.LLM_ERROR, statusCode: status },
      { status },
    );
  }

  // --- Application rate limit ---
  // Mirrors the LLMRateLimitError mapping above: same shape, same retryable: true, distinct code.
  // No RateLimit-Limit / RateLimit-Remaining headers on success responses - on the login route
  // they would tell an attacker exactly how to pace.
  //
  // Deliberately no logger.warn here, unlike the branches above: this runs on EVERY rejected
  // request once a bucket trips, not just the first, while the caller's rate_limit_exceeded audit
  // event is intentionally latched to that first trip (guardRoute checks decision.tripped before
  // emitting). A logger.warn on every 429 would let a hammering client fill container logs with
  // one line per rejection regardless of that latch - defeating the bounded-log-volume design the
  // rest of this phase is built around, through this one incidental call site.
  if (error instanceof RateLimitError) {
    return NextResponse.json(
      {
        error: error.message,
        code: ApiErrorCode.RATE_LIMITED,
        statusCode: 429,
        retryable: true,
      },
      { status: 429, headers: { "Retry-After": String(error.retryAfterSeconds) } },
    );
  }

  // --- Generic Error ---
  if (logs) logger.error("Unhandled error", withheld ?? error, { route });
  const body = internalErrorBody(error);
  return NextResponse.json(withheld === null ? body : withWithheldText(body, withheld.message), { status: 500 });
}
