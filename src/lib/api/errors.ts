/**
 * API Error Response Standardization
 * Centralized error-to-HTTP mapping for all API routes
 */

import { NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import { ApiErrorCode } from "./error-codes";
import { databaseErrorBody, internalErrorBody, type ApiErrorResponse } from "./error-body";
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

// ============================================================================
// Types
// ============================================================================

export type { ApiErrorCode } from "./error-codes";

export type { ApiErrorResponse } from "./error-body";

// ============================================================================
// Error → HTTP Mapping
// ============================================================================

export function createErrorResponse(error: unknown, context?: { route?: string }): NextResponse<ApiErrorResponse> {
  const route = context?.route;

  // --- Seed Connection Error ---
  if (error instanceof SeedConnectionError) {
    logger.warn("Seed connection error", { route, statusCode: error.statusCode });
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
      { error: error.message, ...(code ? { code } : {}), statusCode: error.statusCode },
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
    logger.warn("Vault reference error", { route });
    return NextResponse.json(
      { error: error.message, code: ApiErrorCode.CONFIG_ERROR, statusCode: 400 },
      { status: 400 },
    );
  }

  // --- DB: every DatabaseError class, answered by the Next-free error body ---
  const answer = databaseErrorBody(error);
  if (answer !== null) {
    const { level, message, context: logContext } = answer.log;
    if (level === "error") logger.error(message, error, { route, ...logContext });
    else logger[level](message, { route, ...logContext });
    return NextResponse.json(answer.body, { status: answer.body.statusCode });
  }

  // --- LLM: Safety ---
  if (error instanceof LLMSafetyError) {
    logger.warn("LLM safety filter triggered", { route, provider: error.provider });
    return NextResponse.json(
      { error: "The prompt was blocked by safety filters.", code: ApiErrorCode.LLM_SAFETY, statusCode: 400 },
      { status: 400 },
    );
  }

  // --- LLM: Auth ---
  if (error instanceof LLMAuthError) {
    logger.warn("LLM auth error", { route, provider: error.provider });
    return NextResponse.json(
      { error: "Invalid API key. Please check your configuration.", code: ApiErrorCode.LLM_AUTH, statusCode: 401 },
      { status: 401 },
    );
  }

  // --- LLM: Rate Limit ---
  if (error instanceof LLMRateLimitError) {
    logger.warn("LLM rate limit", { route, provider: error.provider });
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
    logger.warn("LLM config error", { route, provider: error.provider });
    // Missing credentials may be intentional; a malformed model, URL or provider is still a setup error.
    const code = error.reason === "missing_credentials" ? ApiErrorCode.LLM_UNCONFIGURED : ApiErrorCode.LLM_CONFIG;
    return NextResponse.json({ error: error.message, code, statusCode: 503 }, { status: 503 });
  }

  // --- LLM: Stream ---
  if (error instanceof LLMStreamError) {
    logger.error("LLM stream error", error, { route, provider: error.provider });
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
      { error: error.message, code: ApiErrorCode.LLM_STREAM, statusCode: 502, retryable: true },
      { status: 502 },
    );
  }

  // --- LLM: generic LLMError (base class catch-all) ---
  if (error instanceof LLMError) {
    const status = error.statusCode ?? 500;
    logger.error("LLM error", error, { route, provider: error.provider });
    return NextResponse.json({ error: error.message, code: ApiErrorCode.LLM_ERROR, statusCode: status }, { status });
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
  logger.error("Unhandled error", error, { route });
  return NextResponse.json(internalErrorBody(error), { status: 500 });
}
