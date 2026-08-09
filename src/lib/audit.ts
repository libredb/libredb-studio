import { storage } from "@/lib/storage";

export type AuditEventType =
  | "maintenance"
  | "kill_session"
  | "masking_config"
  | "threshold_config"
  | "connection_test"
  | "query_execution"
  | "managed_connection"
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
  | "no_session"
  | "insufficient_role"
  | "origin_mismatch"
  | "rate_limited"
  | "oidc_state_missing"
  | "oidc_state_invalid"
  | "oidc_no_claims"
  | "oidc_failed"
  | "oidc_config";

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
 */
const MAX_AUDIT_FIELD_LENGTH = 254;
/** The address derivation's "no usable signal" placeholder; never recorded as if it were one. */
const UNKNOWN_ADDRESS = "unknown";
/** Redaction marker for a URI's userinfo segment. Never a value real credentials could equal. */
const CREDENTIAL_REDACTION = "[REDACTED]";
/**
 * Matches `scheme://userinfo@` so a connection string's `user:password` (or a bare token used as
 * userinfo) can be replaced before the value reaches either destination. The host and everything
 * after `@` is left intact — an operator needs to know which host, not the password.
 *
 * Per RFC 3986, userinfo ends at the LAST `@` before the host, not the first: a password like
 * `p@ssw0rd` is an ordinary shape, not a contrived one. The character class deliberately does NOT
 * exclude `@` (only `/` and whitespace, which the host/path/end always are): a greedy `+` run
 * against a bounded authority string can only stop where the engine's backtracking finds a
 * trailing literal `@`, and backtracking searches from the longest match down, so it lands on the
 * rightmost `@` still inside that run — the one immediately before the host — rather than the
 * first one it happens to see. Excluding `/` and whitespace from the class is what keeps the match
 * from crossing into the path or across a value with no scheme at all.
 */
const URI_CREDENTIAL_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*):\/\/[^/\s]+@/g;

/**
 * The one gate every free-text field passes through before it can reach either destination: strip
 * any URI-shaped credential, then bound the length. Order matters — redacting first means a value
 * long enough to be truncated never has its credential cut in half and left partially exposed.
 */
function sanitizeAuditField(value: string): string {
  const withoutCredentials = value.replace(URI_CREDENTIAL_PATTERN, `$1://${CREDENTIAL_REDACTION}@`);
  return withoutCredentials.slice(0, MAX_AUDIT_FIELD_LENGTH);
}

/**
 * The single sanitization boundary, applied once to the caller-supplied event before it reaches
 * either the ring buffer (push) or the stdout line (toAuditLine) — both destinations consume this
 * result, so there is exactly one rule to keep correct instead of one per destination. Sweeps
 * every own key of the event and sanitizes any string value found there, unconditionally: this is
 * deliberately not a per-field allowlist of calls to sanitizeAuditField, so a field added to
 * AuditEvent later is covered by construction. Opting a field OUT would require deleting code from
 * this sweep; there is no opt-in step to forget.
 */
function sanitizeAuditInput(event: Omit<AuditEvent, "id" | "timestamp">): Omit<AuditEvent, "id" | "timestamp"> {
  const sanitized: Omit<AuditEvent, "id" | "timestamp"> = { ...event };
  // A second, dynamically-keyed view of the SAME object (not a copy, no cast): every property of
  // an AuditEvent is a valid Record<string, unknown> value, so this assignment needs no assertion,
  // and mutating through it mutates `sanitized` because both names refer to one object.
  const mutable: Record<string, unknown> = sanitized;
  for (const key of Object.keys(mutable)) {
    const value = mutable[key];
    if (typeof value === "string") {
      mutable[key] = sanitizeAuditField(value);
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
