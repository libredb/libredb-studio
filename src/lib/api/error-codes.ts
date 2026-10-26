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
  /**
   * A database accepted the credential and refused the statement for a privilege that credential lacks (403), such as
   * PostgreSQL's `permission denied for table orders`. Distinct from AUTH_ERROR, which is a database refusing the
   * credential itself: answering a missing grant with that code told the user to re-enter a password that was right.
   */
  PERMISSION_DENIED: "PERMISSION_DENIED",
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

  /**
   * An object search would list more container and kind pairs than `INVENTORY_PAIR_LIMIT` (400,
   * src/app/api/db/objects/search/route.ts), so it was refused before its first listing. The body's `limit` is the
   * bound and `pairs` the count the search would have listed, so a client can narrow `kinds` without reading the
   * sentence. Distinct from the plain `{ error }` 400 a malformed body gets: naming fewer kinds answers this one.
   */
  INVENTORY_PAIR_LIMIT: "INVENTORY_PAIR_LIMIT",

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
   * The server account store (STORAGE_PROVIDER=sqlite or postgres) could not be read during
   * session verification or MCP token check (503). Distinct from AUTH_REQUIRED: the client keeps
   * its session cookie or MCP token and retries (#1942).
   */
  ACCOUNT_STORE_UNAVAILABLE: "ACCOUNT_STORE_UNAVAILABLE",

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
   * A bearer access token could not be verified because the identity provider's discovery document or key set could
   * not be read, or the bearer channel is misconfigured (503, src/lib/oidc-bearer.ts). Not AUTH_REQUIRED: the token
   * may be good, so a client keeps it and retries instead of signing the user out.
   */
  IDENTITY_PROVIDER_UNAVAILABLE: "IDENTITY_PROVIDER_UNAVAILABLE",

  /**
   * A bearer access token verified, but its claims map to no role Studio accepts under OIDC_ROLE_CLAIM,
   * OIDC_ADMIN_ROLES and OIDC_USER_ROLES (403). Not AUTH_REQUIRED: a fresh token for the same account is refused the
   * same way until an administrator changes the account, so a client shows the refusal instead of refreshing.
   */
  BEARER_NO_ROLE: "BEARER_NO_ROLE",

  /**
   * A bearer access token verified, but it carries no subject or no user name Studio can use (403,
   * src/lib/oidc-identity.ts): no email the provider has not marked unverified, and no preferred_username without "@".
   * Like BEARER_NO_ROLE, a fresh token is refused the same way until the account changes.
   */
  BEARER_NO_IDENTITY: "BEARER_NO_IDENTITY",

  /** The caller holds a session, but the route is for admins only (403). */
  ADMIN_REQUIRED: "ADMIN_REQUIRED",

  /**
   * Under governance, with the runtime setting `queryLog.onSinkFailure` at `refuse`, Studio cannot record query events
   * right now (503): its query event sink is backing off after a failed insert, or its queue is at least 90% full. The
   * request was refused before any statement ran (src/lib/query-events/admission.ts). Distinct from
   * GOVERNANCE_UNAVAILABLE, which is the snapshot of the governance source: here the snapshot serves, and only the
   * record of what would run cannot be kept.
   */
  AUDIT_UNAVAILABLE: "AUDIT_UNAVAILABLE",

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
   * The transaction open on the connection belongs to another session (409, src/app/api/db/transaction/route.ts): the
   * caller may not run, commit or roll back a transaction it did not begin.
   */
  TRANSACTION_NOT_OWNED: "TRANSACTION_NOT_OWNED",

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
