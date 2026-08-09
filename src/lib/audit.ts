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
/** RFC 5321's maximum address length: enough for any real account, bounded against a 10 KB one. */
const MAX_ACTOR_LENGTH = 254;
/** The address derivation's "no usable signal" placeholder; never recorded as if it were one. */
const UNKNOWN_ADDRESS = "unknown";

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
    ...(event.duration !== undefined ? { duration_ms: event.duration } : {}),
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
  const stored = getServerAuditBuffer().push({ ...event, user: event.user.slice(0, MAX_ACTOR_LENGTH) });
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
