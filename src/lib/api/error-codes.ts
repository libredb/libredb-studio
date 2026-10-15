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

  /**
   * The request carries no session, or one that no longer verifies (#1420). Distinct from
   * AUTH_ERROR, which is a database refusing its credentials while the Studio session is fine: the
   * browser sends the user to sign in again for this code and only for this code.
   */
  AUTH_REQUIRED: "AUTH_REQUIRED",

  /**
   * The request names, in X-LibreDB-Workspace-Owner, an account other than the signed-in one
   * (409): the tab claimed its browser copy for that account, and the session is now another
   * account's. The browser reloads the tab for this code, so the owner check runs again.
   */
  WORKSPACE_OWNER_MISMATCH: "WORKSPACE_OWNER_MISMATCH",

  /**
   * The operator switched custom connections off (ALLOW_CUSTOM_CONNECTIONS) and the request supplied a
   * connection of its own (403). Distinct from AUTH_ERROR, which the same 403 carries when the role
   * filter refuses a seed: this refusal is the server's policy and no role or credential changes it.
   */
  CUSTOM_CONNECTIONS_DISABLED: "CUSTOM_CONNECTIONS_DISABLED",

  /**
   * Under governance, the snapshot of the governance source cannot be served (503): it is still loading, older
   * than GOVERNANCE_MAX_STALENESS_MS, misconfigured or incompatible (docs/GOVERNANCE.md, freshness and readiness).
   * Distinct from CONNECTION_ERROR, which is a user's database failing: with this code no user database was tried.
   */
  GOVERNANCE_UNAVAILABLE: "GOVERNANCE_UNAVAILABLE",

  /**
   * Under governance, the connection a request names is not one the caller holds a grant on (404): it does not exist,
   * it is granted to someone else, its grant expired, or Studio did not admit the governance source's row. One code
   * for all of them, decided from the caller's own grants alone, so the answer never tells a caller which ids exist.
   */
  CONNECTION_NOT_FOUND: "CONNECTION_NOT_FOUND",

  /**
   * Under governance, the caller's own open transaction was opened under a credential the caller no longer resolves
   * (409): its grant level or the connection's credential changed while it was open, so the request resolves another
   * provider. Studio rolled the transaction back and released its owner record, and the body's `rolledBack` says
   * whether that rollback was confirmed (src/app/api/db/transaction/route.ts).
   */
  TRANSACTION_CREDENTIAL_CHANGED: "TRANSACTION_CREDENTIAL_CHANGED",

  /**
   * Under governance, the control plane set the runtime setting `ai.enabled` to false, and a route of the AI bucket
   * refused the request before any LLM provider was built (403). Distinct from LLM_UNCONFIGURED, which is the
   * environment naming no model: this refusal is the control plane's switch, and no LLM_* variable changes it.
   */
  AI_DISABLED: "AI_DISABLED",

  // Application rate limiting (distinct from LLM_RATE_LIMIT, which is the provider's limit)
  RATE_LIMITED: "RATE_LIMITED",

  // Generic
  INTERNAL_ERROR: "INTERNAL_ERROR",
  NETWORK_ERROR: "NETWORK_ERROR",
} as const;

export type ApiErrorCode = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];
