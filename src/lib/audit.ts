import { storage } from "@/lib/storage";

export type AuditEventType =
  | "maintenance"
  | "kill_session"
  | "masking_config"
  | "threshold_config"
  | "connection_test"
  | "query_execution"
  | "managed_connection"
  /**
   * An agent-path operation: one event for the policy decision and, when that
   * decision allowed execution, one for its outcome. Distinct from
   * `query_execution` on purpose — an operator filtering the log needs to
   * separate what a human ran in the editor from what an agent was permitted
   * to run (#328).
   */
  | "agent_operation"
  // Phase 1 auth events
  | "login_success"
  | "login_failure"
  | "logout"
  | "permission_denied"
  | "rate_limit_exceeded";

/**
 * Why a reason is a closed union and never free text: it is the mechanism that makes redaction
 * unnecessary rather than best-effort. No code path can put an Error.message, a driver string or
 * a request header into an audit record, because there is no field that would accept one.
 */
export type AuditReason =
  | "bad_credentials"
  | "malformed_body"
  | "no_session"
  | "insufficient_role"
  | "origin_mismatch"
  | "rate_limited"
  | "oidc_state_missing"
  | "oidc_state_invalid"
  | "oidc_no_claims"
  | "oidc_failed"
  | "oidc_config"
  // Agent execution path (#328). The thirteen `agent_*` codes below mirror
  // `PolicyDenyCode` one-for-one, plus the two outcomes that are not policy
  // denials: an operation that may only ever require approval, and a provider
  // that failed after the decision allowed it. The mirror is not maintained by
  // hand — `DENY_REASONS` in src/lib/db/operations/execution.ts is typed
  // `Record<PolicyDenyCode, AuditReason>`, so a new deny code with no reason
  // here, or a reason renamed here, fails to compile.
  | "agent_unknown_operation"
  | "agent_ambiguous_operation"
  | "agent_malformed_policy_context"
  | "agent_invalid_actor"
  | "agent_target_out_of_scope"
  | "agent_input_validation_failed"
  | "agent_capability_unsupported"
  | "agent_role_forbidden"
  | "agent_mode_forbidden"
  | "agent_risk_exceeds_policy"
  | "agent_concurrency_budget_exceeded"
  | "agent_statement_budget_exceeded"
  | "agent_total_run_budget_exceeded"
  | "agent_approval_required"
  | "agent_execution_failed"
  // The run loop's own wall-clock refusals (#329). They are NOT policy denials and
  // deliberately do not share that vocabulary: they fire before
  // `executeAuditedOperation` is reached, so without these two a run that stopped on
  // its own deadline would leave no trace at all. The mirror is kept honest the same
  // way — `DEADLINE_REASONS` in src/lib/agent/tools.ts is typed
  // `Record<AgentDeadlineDenyCode, AuditReason>`.
  | "agent_run_deadline_exceeded"
  | "agent_insufficient_time_remaining"
  // The agent drive callback (#329 T9) refusing a caller that presented no valid
  // single-purpose credential. Distinct from `no_session` on purpose: this path
  // never wanted a session, so recording one vocabulary for both would make a
  // forged drive token indistinguishable in the trail from an expired login.
  | "no_agent_drive_token";

export interface AuditEvent {
  id: string;
  timestamp: string;
  type: AuditEventType;
  action: string;
  target: string;
  connectionName?: string;
  user: string;
  result: "success" | "failure";
  duration?: number;
  details?: string;
  /**
   * Derived from forwarded headers. It is a HINT, not an identity: X-Forwarded-For is
   * attacker-controlled, and nothing in this product makes an authorization decision from it.
   */
  ip?: string;
  reason?: AuditReason;
  /**
   * Which rate-limit bucket tripped (e.g. "login_client", "login_account"). Only
   * rate_limit_exceeded events set this. Without it, the audit trail cannot tell a broad address
   * flood (login_client) apart from a targeted attack on one account (login_account) - the two
   * call for a different operator response, but would otherwise read identically.
   */
  bucket?: string;
  /**
   * Joins the events of ONE agent execution: the policy decision and, when the
   * decision allowed it, the execution outcome. Server-generated per execution
   * (src/lib/db/operations/execution.ts) and opaque — it identifies an
   * execution, never a session, a user or a token, so it stays safe to log
   * while remaining the key an operator groups by. Only `agent_operation`
   * events set it.
   */
  correlationId?: string;
}

const MAX_EVENTS = 1000;

/**
 * Declared at module scope, not inline in `filter`'s signature: a type literal inside a function
 * body is inside that function's coverage span, and bun reports never-executed functions as a
 * coarse zero-hit block that includes type-only lines as if they were statements. A module-scope
 * declaration is erased before any function span exists, so it can never appear as a phantom
 * uncovered line the way an inline literal did.
 */
interface AuditFilterOptions {
  type?: AuditEventType;
  result?: "success" | "failure";
  connectionName?: string;
  since?: string;
}

export class AuditRingBuffer {
  private events: AuditEvent[] = [];
  private maxSize: number;

  constructor(maxSize = MAX_EVENTS) {
    this.maxSize = maxSize;
  }

  push(event: Omit<AuditEvent, "id" | "timestamp">) {
    const fullEvent: AuditEvent = {
      ...event,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
    };
    this.events.push(fullEvent);
    if (this.events.length > this.maxSize) {
      this.events = this.events.slice(-this.maxSize);
    }
    return fullEvent;
  }

  getAll(): AuditEvent[] {
    return [...this.events];
  }

  getRecent(count: number): AuditEvent[] {
    return this.events.slice(-count);
  }

  filter(opts: AuditFilterOptions): AuditEvent[] {
    return this.events.filter((e) => {
      if (opts.type && e.type !== opts.type) return false;
      if (opts.result && e.result !== opts.result) return false;
      if (opts.connectionName && e.connectionName !== opts.connectionName) return false;
      if (opts.since && e.timestamp < opts.since) return false;
      return true;
    });
  }

  clear() {
    this.events = [];
  }

  get size() {
    return this.events.length;
  }

  toJSON(): AuditEvent[] {
    return this.events;
  }

  loadFrom(events: AuditEvent[]) {
    this.events = events.slice(-this.maxSize);
  }
}

// Global server-side instance
let _serverBuffer: AuditRingBuffer | null = null;

export function getServerAuditBuffer(): AuditRingBuffer {
  if (!_serverBuffer) {
    _serverBuffer = new AuditRingBuffer();
  }
  return _serverBuffer;
}

const AUDIT_SCHEMA = "libredb.audit.v1";
/**
 * RFC 5321's maximum address length: enough for any real account, bounded against a 10 KB one.
 * One rule for every free-text field, wherever it is stored — the ring buffer or the stdout line —
 * not a fresh number per field or per destination.
 *
 * Exported so any call site that pre-truncates a value before it becomes an AuditEvent field (the
 * login route's actor, for one) imports this constant instead of redeclaring its own copy of 254 -
 * two independent constants with the same value today are one unnoticed edit away from drifting.
 */
export const MAX_AUDIT_FIELD_LENGTH = 254;
/** The address derivation's "no usable signal" placeholder; never recorded as if it were one. */
const UNKNOWN_ADDRESS = "unknown";
/** Redaction marker for a URI's userinfo segment. Never a value real credentials could equal. */
const CREDENTIAL_REDACTION = "[REDACTED]";
/**
 * Where a connection string's userinfo can be collapsed before the value reaches either
 * destination. Once the `scheme://` boundary is found, everything to the end of the string is in
 * play (not bounded to "before the next `/`"): a password containing `/`, `?` or `#` is an
 * ordinary shape, and a boundary based on those characters cannot tell `postgres://user:pa/ss@host
 * /db` (a slash INSIDE the password) apart from `https://example.com/user@example/profile` (an
 * `@` INSIDE the path) — they are structurally identical. There is no syntax-only fix for that.
 *
 * The fix is to stop trying to parse a URI out of this value at all. An audit field is not a URI
 * field: nobody downstream needs the full string back, only the scheme and which host it named.
 * redactUriCredentials below finds the LAST `@` after the delimiter and keeps only what follows
 * it, discarding everything between the scheme and that point regardless of what characters it
 * contained. This is deliberately over-eager — a value shaped like case 6 above gets its path
 * mangled even though it carried no credential — and that trade is correct here: mangling a
 * harmless URL costs an operator nothing, while leaking a password costs them everything. Do not
 * "fix" this by trying to distinguish password characters from path characters; that parser cannot
 * be written correctly.
 *
 * Previously implemented as a single backtracking regex,
 * `/([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([\s\S]*)$/` applied via `String.replace`. CodeQL flagged that as
 * js/polynomial-redos (alert #112): the pattern is unanchored, so `.replace` retries the whole
 * scheme-quantifier backtrack at every one of a long value's ~n starting positions before giving
 * up, which is O(n^2) on an attacker-controlled field with no length bound applied before this
 * runs (the bound below is applied AFTER redaction, deliberately - see sanitizeAuditField). Every
 * field this module processes is free text from a request body or a header value, so "attacker
 * controls the length and content" is the normal case, not an edge case.
 *
 * Rewritten below as `indexOf`/`lastIndexOf` plus one bounded scan per candidate delimiter. Why
 * this stays O(value.length) even adversarially: `:` and `/` are not URI-scheme characters, so a
 * scheme-character run can never span a "://" delimiter it failed to match against. Each loop
 * iteration's backward-then-forward scan is therefore confined to the segment strictly between the
 * previous rejected delimiter and the current one - those segments never overlap - so their
 * lengths sum to at most value.length across every iteration, however many "://" occurrences the
 * value contains. (An anchored regex, `/^([a-zA-Z]...)/`, would also kill the O(n^2) blowup, but
 * only by matching solely at index 0 - silently DROPPING redaction for a credential that arrives
 * with any prefix, e.g. an error message wrapping a connection string. That is a coverage
 * regression in a control whose entire job is to never miss a credential, so it was rejected.)
 */
function isSchemeChar(ch: string): boolean {
  return (
    (ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "+" ||
    ch === "." ||
    ch === "-"
  );
}

function isLetter(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z");
}

function redactUriCredentials(value: string): string {
  let searchFrom = 0;
  for (;;) {
    const delimiter = value.indexOf("://", searchFrom);
    if (delimiter === -1) return value;

    // Walk backward over the maximal run of scheme characters immediately before the delimiter,
    // then forward to the first letter within that run: RFC 3986 requires a scheme to START with
    // a letter, but the greedy backward walk may have overrun into a non-letter prefix (e.g. the
    // "1" in "1://postgres://user:pass@host/db" - see the two tests pinning this loop).
    let runStart = delimiter;
    while (runStart > 0 && isSchemeChar(value[runStart - 1])) runStart--;
    let schemeStart = runStart;
    while (schemeStart < delimiter && !isLetter(value[schemeStart])) schemeStart++;

    if (schemeStart < delimiter) {
      const scheme = value.slice(schemeStart, delimiter);
      const rest = value.slice(delimiter + 3);
      const lastAt = rest.lastIndexOf("@");
      // No `@` at all: no userinfo was ever present, so there is nothing to hide.
      if (lastAt === -1) return value;
      const host = rest.slice(lastAt + 1);
      // No recoverable host (e.g. a dangling "user:pass@" with nothing after it): degrade to the
      // marker alone rather than emitting a "scheme://[REDACTED]@" that promises a host it can't
      // name.
      const redacted = host.length === 0 ? CREDENTIAL_REDACTION : `${scheme}://${CREDENTIAL_REDACTION}@${host}`;
      return value.slice(0, schemeStart) + redacted;
    }

    // No letter anywhere in the run immediately before this delimiter: not a valid scheme. Keep
    // looking - a value can legitimately contain more than one "://" (see the same two tests).
    searchFrom = delimiter + 3;
  }
}

/**
 * The one gate every free-text field passes through before it can reach either destination: strip
 * any URI-shaped credential, then bound the length. Order matters — redacting first means a value
 * long enough to be truncated never has its credential cut in half and left partially exposed.
 */
function sanitizeAuditField(value: string): string {
  return redactUriCredentials(value).slice(0, MAX_AUDIT_FIELD_LENGTH);
}

/**
 * `sanitizeAuditInput`'s fallback for a value that is present, not the one legitimate non-string
 * field (`duration`, a number), and not already a string: turns it into a string so the sweep
 * below has something to bound and redact, instead of leaving the original value - object, array,
 * boolean, bigint - to reach a destination whose contract promises a string. JSON.stringify covers
 * every shape that can actually arrive from a JSON request body; the catch exists only for the
 * inputs JSON.stringify itself refuses (a circular reference, a BigInt), which a hand-built
 * AuditEvent could construct even though `JSON.parse` output never does.
 */
function coerceToString(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unserializable]";
  }
}

/**
 * The single sanitization boundary, applied once to a caller-supplied event before it reaches
 * either the ring buffer (push) or the stdout line (toAuditLine) — both destinations consume this
 * result, so there is exactly one rule to keep correct instead of one per destination. Sweeps
 * every own key of the event and sanitizes any string value found there, unconditionally: this is
 * deliberately not a per-field allowlist of calls to sanitizeAuditField, so a field added to
 * AuditEvent later is covered by construction. Opting a field OUT would require deleting code from
 * this sweep; there is no opt-in step to forget.
 *
 * The allowlist selects KEYS, not TYPES: every AuditEvent field but `duration` is typed as a
 * string, but TypeScript cannot enforce that at runtime against a route that destructures a field
 * straight out of an untyped `await request.json()` body (`target` in
 * `POST /api/db/maintenance`, for one) and hands it to `emitAuditEvent` unchecked. The exemption
 * below is therefore keyed on the field NAME (`key === "duration"`), not merely on the runtime
 * value happening to be a number - a number arriving in any other field (say, `target`) is not
 * `duration`'s legitimate number and is coerced like any other non-string. A value that is
 * neither a string nor `duration`'s own number is coerced to a bounded string through the same
 * sanitizer a real string would have gone through, rather than passed on verbatim: an object
 * reaching either destination as-is would be unbounded and would break the fixed-shape
 * `libredb.audit.v1` contract `toAuditLine` promises downstream parsers.
 *
 * Exported on its own, separately from emitAuditEvent: sanitization and stdout emission are two
 * different privileges. `POST /api/admin/audit` accepts a fully client-supplied body with none of
 * its fields validated at runtime, so it must never gain the authority to write to the stdout
 * channel the design treats as authoritative — it calls this function directly and pushes to the
 * buffer itself. `emitAuditEvent` below is a policy built on top of this boundary, for callers
 * whose event content is decided by trusted route logic rather than by the request body.
 *
 * DANGEROUS_KEYS guards the dynamic `mutable[key] = ...` write below against CodeQL's
 * js/remote-property-injection (alerts #113/#114): `key` is drawn from `Object.keys()` of an
 * object built by spreading that same admin-audit request body. Empirically, this is not currently
 * exploitable - object-spread (`{ ...event }` in that route, `{ ...event, ... }` in
 * AuditRingBuffer.push below) uses CreateDataPropertyOrThrow, which defines "__proto__" as an
 * ordinary own data property rather than invoking Object.prototype's accessor, so a later
 * `mutable["__proto__"] = ...` here only overwrites that shadow property, never the real
 * prototype. But that safety depends on both call sites staying spread-based forever; it is not a
 * property of this function. A three-name skip list costs nothing and removes the dependency.
 */
const DANGEROUS_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function sanitizeAuditInput(event: Omit<AuditEvent, "id" | "timestamp">): Omit<AuditEvent, "id" | "timestamp"> {
  const sanitized: Omit<AuditEvent, "id" | "timestamp"> = { ...event };
  // A second, dynamically-keyed view of the SAME object (not a copy, no cast): every property of
  // an AuditEvent is a valid Record<string, unknown> value, so this assignment needs no assertion,
  // and mutating through it mutates `sanitized` because both names refer to one object.
  const mutable: Record<string, unknown> = sanitized;
  for (const key of Object.keys(mutable)) {
    if (DANGEROUS_KEYS.has(key)) continue;
    const value = mutable[key];
    if (typeof value === "string") {
      mutable[key] = sanitizeAuditField(value);
    } else if (value !== undefined && !(key === "duration" && typeof value === "number")) {
      mutable[key] = sanitizeAuditField(coerceToString(value));
    }
  }
  return sanitized;
}

/**
 * The stdout record. Built as an explicit allowlist, never as a spread of a wider object, so that
 * a field added to AuditEvent later cannot silently start being logged.
 */
interface AuditLogLine {
  schema: string;
  ts: string;
  id: string;
  event: AuditEventType;
  action: string;
  outcome: "success" | "failure";
  actor: string;
  route: string;
  reason?: AuditReason;
  ip?: string;
  connection?: string;
  duration_ms?: number;
  bucket?: string;
  correlation_id?: string;
}

function toAuditLine(event: AuditEvent): AuditLogLine {
  return {
    schema: AUDIT_SCHEMA,
    ts: event.timestamp,
    id: event.id,
    event: event.type,
    action: event.action,
    outcome: event.result,
    actor: event.user,
    route: event.target,
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.ip && event.ip !== UNKNOWN_ADDRESS ? { ip: event.ip } : {}),
    ...(event.connectionName ? { connection: event.connectionName } : {}),
    ...(event.bucket ? { bucket: event.bucket } : {}),
    ...(event.correlationId ? { correlation_id: event.correlationId } : {}),
    // Number.isFinite excludes NaN and +/-Infinity: JSON.stringify(NaN) silently produces `null`,
    // which would flip duration_ms from a number to null for that one line in a contract parsers
    // depend on. Omitting it entirely keeps the field's type stable instead.
    ...(event.duration !== undefined && Number.isFinite(event.duration) ? { duration_ms: event.duration } : {}),
  };
}

/**
 * The single entry point for an audit event. It does exactly two things:
 *
 * 1. Pushes to the ring buffer the admin UI reads. That buffer is per process and holds 1000
 *    events, oldest dropped. It is a CONVENIENCE VIEW, not the durable record - an event emitted
 *    from proxy() may land in a different instance than the admin API reads, because the proxy is
 *    a separately compiled entry and instance sharing is unverified.
 * 2. Writes one JSON line to stdout. This is the authoritative channel: it works identically in
 *    all 27 distribution channels with no dependency, and it is what a log pipeline consumes.
 *
 * The line is NOT gated by LOG_LEVEL. Audit emission is unconditional; logger.ts remains the
 * human-readable channel and is not repurposed.
 *
 * What must never be recorded here: passwords or any credential material, JWTs, cookies or
 * Authorization values, OIDC tokens, code or code_verifier or raw claims, connection strings,
 * hosts or SSH keys, SQL text, LLM prompts or responses, request bodies, raw Error.message or
 * stack traces, and arbitrary request headers. src/lib/data-masking.ts is not reusable here: it
 * masks result-grid cell values by column-name pattern and has no bearing on log strings.
 */
export function emitAuditEvent(event: Omit<AuditEvent, "id" | "timestamp">): AuditEvent {
  const stored = getServerAuditBuffer().push(sanitizeAuditInput(event));
  // JSON.stringify escapes newlines and control characters, so an attacker-controlled actor
  // cannot forge a second log line. This is why the audit channel does not reuse logger.ts.
  console.log(JSON.stringify(toAuditLine(stored)));
  return stored;
}

// Client-side localStorage persistence — delegates to storage module
export function loadAuditFromStorage(): AuditEvent[] {
  return storage.getAuditLog();
}

export function saveAuditToStorage(events: AuditEvent[]) {
  storage.saveAuditLog(events);
}
