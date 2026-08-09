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
  /**
   * Which rate-limit bucket tripped (e.g. "login_client", "login_account"). Only
   * rate_limit_exceeded events set this. Without it, the audit trail cannot tell a broad address
   * flood (login_client) apart from a targeted attack on one account (login_account) - the two
   * call for a different operator response, but would otherwise read identically.
   */
  bucket?: string;
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
 * Matches `scheme://` followed by the remainder of the value, so a connection string's userinfo
 * can be collapsed before the value reaches either destination. `rest` runs to the end of the
 * string (not bounded to "before the next `/`"): a password containing `/`, `?` or `#` is an
 * ordinary shape, and a boundary based on those characters cannot tell `postgres://user:pa/ss@host
 * /db` (a slash INSIDE the password) apart from `https://example.com/user@example/profile` (an
 * `@` INSIDE the path) — they are structurally identical. There is no syntax-only fix for that.
 *
 * The fix is to stop trying to parse a URI out of this value at all. An audit field is not a URI
 * field: nobody downstream needs the full string back, only the scheme and which host it named.
 * sanitizeAuditField below finds the LAST `@` in `rest` and keeps only what follows it, discarding
 * everything between the scheme and that point regardless of what characters it contained. This is
 * deliberately over-eager — a value shaped like case 6 above gets its path mangled even though it
 * carried no credential — and that trade is correct here: mangling a harmless URL costs an
 * operator nothing, while leaking a password costs them everything. Do not "fix" this by trying to
 * distinguish password characters from path characters; that parser cannot be written correctly.
 */
const URI_CREDENTIAL_PATTERN = /([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([\s\S]*)$/;

/**
 * The one gate every free-text field passes through before it can reach either destination: strip
 * any URI-shaped credential, then bound the length. Order matters — redacting first means a value
 * long enough to be truncated never has its credential cut in half and left partially exposed.
 */
function sanitizeAuditField(value: string): string {
  const withoutCredentials = value.replace(URI_CREDENTIAL_PATTERN, (_match, scheme: string, rest: string) => {
    const lastAt = rest.lastIndexOf("@");
    // No `@` at all: no userinfo was ever present, so there is nothing to hide.
    if (lastAt === -1) {
      return `${scheme}://${rest}`;
    }
    const host = rest.slice(lastAt + 1);
    // No recoverable host (e.g. a dangling "user:pass@" with nothing after it): degrade to the
    // marker alone rather than emitting a "scheme://[REDACTED]@" that promises a host it can't
    // name.
    return host.length === 0 ? CREDENTIAL_REDACTION : `${scheme}://${CREDENTIAL_REDACTION}@${host}`;
  });
  return withoutCredentials.slice(0, MAX_AUDIT_FIELD_LENGTH);
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
 * `POST /api/db/maintenance`, for one) and hands it to `emitAuditEvent` unchecked. A value that is
 * neither a string nor `duration`'s legitimate number is coerced to a bounded string through the
 * same sanitizer a real string would have gone through, rather than passed on verbatim: an object
 * reaching either destination as-is would be unbounded and would break the fixed-shape
 * `libredb.audit.v1` contract `toAuditLine` promises downstream parsers.
 *
 * Exported on its own, separately from emitAuditEvent: sanitization and stdout emission are two
 * different privileges. `POST /api/admin/audit` accepts a fully client-supplied body with none of
 * its fields validated at runtime, so it must never gain the authority to write to the stdout
 * channel the design treats as authoritative — it calls this function directly and pushes to the
 * buffer itself. `emitAuditEvent` below is a policy built on top of this boundary, for callers
 * whose event content is decided by trusted route logic rather than by the request body.
 */
export function sanitizeAuditInput(event: Omit<AuditEvent, "id" | "timestamp">): Omit<AuditEvent, "id" | "timestamp"> {
  const sanitized: Omit<AuditEvent, "id" | "timestamp"> = { ...event };
  // A second, dynamically-keyed view of the SAME object (not a copy, no cast): every property of
  // an AuditEvent is a valid Record<string, unknown> value, so this assignment needs no assertion,
  // and mutating through it mutates `sanitized` because both names refer to one object.
  const mutable: Record<string, unknown> = sanitized;
  for (const key of Object.keys(mutable)) {
    const value = mutable[key];
    if (typeof value === "string") {
      mutable[key] = sanitizeAuditField(value);
    } else if (value !== undefined && typeof value !== "number") {
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
