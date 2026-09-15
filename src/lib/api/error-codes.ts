/**
 * API Error Codes
 * Single source of truth for all error codes used across server and client
 */

export const ApiErrorCode = {
  // Database errors
  QUERY_CANCELLED: "QUERY_CANCELLED",
  QUERY_ERROR: "QUERY_ERROR",
  CONFIG_ERROR: "CONFIG_ERROR",
  AUTH_ERROR: "AUTH_ERROR",
  TIMEOUT_ERROR: "TIMEOUT_ERROR",
  CONNECTION_ERROR: "CONNECTION_ERROR",
  POOL_EXHAUSTED: "POOL_EXHAUSTED",
  DATABASE_ERROR: "DATABASE_ERROR",
  /**
   * A submitted object edit plan is not one this server will execute (#789 Phase 3).
   *
   * The ONE code this phase adds, and it is here because the client's response to it is specific
   * and not a rendered sentence: the preview is rebuilt from a fresh read and the user re-confirms.
   * A bare `{ error }` would force the browser to match on the message text to tell this apart from
   * every other 400 the apply route answers, which is the string matching a code vocabulary exists
   * to remove.
   *
   * Two other candidates were considered and DROPPED rather than forgotten. "Not editable" is the
   * same 400 `{ error }` that `requireSourceReader` already answers for an unreadable kind, and the
   * client does the same thing with both: show it. "Too large" is carried by the 413 status itself,
   * and a code restating a status is a second vocabulary for one fact.
   */
  EDIT_PLAN_INVALID: "EDIT_PLAN_INVALID",

  // LLM errors
  LLM_SAFETY: "LLM_SAFETY",
  LLM_AUTH: "LLM_AUTH",
  LLM_RATE_LIMIT: "LLM_RATE_LIMIT",
  LLM_CONFIG: "LLM_CONFIG",
  LLM_UNCONFIGURED: "LLM_UNCONFIGURED",
  LLM_STREAM: "LLM_STREAM",
  LLM_ERROR: "LLM_ERROR",

  // Application rate limiting (distinct from LLM_RATE_LIMIT, which is the provider's limit)
  RATE_LIMITED: "RATE_LIMITED",

  // Generic
  INTERNAL_ERROR: "INTERNAL_ERROR",
  NETWORK_ERROR: "NETWORK_ERROR",
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];
