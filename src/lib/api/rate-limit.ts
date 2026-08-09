/**
 * In-process fixed-window rate limiting.
 *
 * THIS IS A PER-PROCESS LIMITER BY DESIGN. Do not replace it with a distributed one, and do not
 * present it anywhere as one. The Helm chart defaults to replicaCount: 1 with autoscaling and the
 * PDB off (charts/libredb-studio/values.yaml:19), the Dockerfile runs a single `node server.js`,
 * and the storage abstraction (src/lib/storage/types.ts) is a per-user blob store whose
 * read-modify-write cycle is unsuitable for counters. Where the counters are per process, the
 * limits are per replica; multi-replica operators are directed to enforce at the ingress, and
 * that is documented in .env.example and charts/libredb-studio/README.md rather than implemented.
 * Do not add a dependency (e.g. Redis) to fix this - it is a deliberate scope boundary, not an
 * oversight waiting to be corrected.
 *
 * There are no timers here. A setInterval would hold the event loop open and leak one per process;
 * entries expire lazily on access instead.
 *
 * Memory bound: MAX_ENTRIES counters of roughly 100 bytes is under 1 MB. Nobody may add a second,
 * unbounded map alongside this one.
 */

export type RateLimitBucket = "login_client" | "login_account" | "ai" | "query" | "anon";

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  /** True only on the request that crossed the limit. Audit emits on the transition. */
  tripped: boolean;
}

export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(`Too many requests. Try again in ${retryAfterSeconds} seconds.`);
    this.name = "RateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface BucketSpec {
  maxVar: string;
  windowVar: string;
  maxDefault: number;
  windowDefault: number;
}

interface Counter {
  count: number;
  resetAt: number;
  /** Latched once the first rejection has been reported, so audit sees one line per window. */
  notified: boolean;
}

const MAX_ENTRIES = 5000;
const MAX_KEY_LENGTH = 200;
const MAX_LIMIT = 1_000_000;
const MAX_WINDOW_SECONDS = 86_400;

const BUCKETS: Record<RateLimitBucket, BucketSpec> = {
  // Failed logins per client key. The sixth within the window returns 429.
  login_client: {
    maxVar: "RATE_LIMIT_LOGIN_MAX",
    windowVar: "RATE_LIMIT_LOGIN_WINDOW_SEC",
    maxDefault: 5,
    windowDefault: 300,
  },
  // Failed logins per submitted account. Immune to X-Forwarded-For spoofing, which is the whole
  // reason it exists. Bounded at 10 per 15 minutes and cleared by a successful login, because an
  // uncleared per-account cap is a denial-of-login handle on a known user.
  login_account: {
    maxVar: "RATE_LIMIT_LOGIN_ACCOUNT_MAX",
    windowVar: "RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SEC",
    maxDefault: 10,
    windowDefault: 900,
  },
  // Shared across all eight AI routes: rotating routes must not multiply the budget.
  ai: { maxVar: "RATE_LIMIT_AI_MAX", windowVar: "RATE_LIMIT_AI_WINDOW_SEC", maxDefault: 20, windowDefault: 60 },
  // Shared across query, multi-query, transaction and disconnect, for the same reason: the same
  // statement sent through multi-query must not get a second budget.
  query: {
    maxVar: "RATE_LIMIT_QUERY_MAX",
    windowVar: "RATE_LIMIT_QUERY_WINDOW_SEC",
    maxDefault: 120,
    windowDefault: 60,
  },
  // Bounds permission_denied audit volume from unauthenticated probes. Without it an internet
  // scanner can fill a container log volume.
  anon: { maxVar: "RATE_LIMIT_ANON_MAX", windowVar: "RATE_LIMIT_ANON_WINDOW_SEC", maxDefault: 5, windowDefault: 300 },
};

const counters = new Map<string, Counter>();

/**
 * A clamped integer from the environment. One helper rather than a branch per variable, so the
 * coverage cost of eleven configurable numbers is one small tested function.
 * A value of 0 for a *_MAX means unlimited; the caller decides what 0 means for its own variable.
 * Unlike the boolean flags in src/lib/security/config.ts, an out-of-range number here silently
 * falls back rather than warning: these are budget knobs, not a security posture toggle, and this
 * function backs eleven of them plus TRUSTED_PROXY_HOPS - warning here would either fire on every
 * request or need its own per-variable latch for a case that isn't a security-relevant mistake.
 */
export function parsePositiveInt(value: string | undefined, fallback: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(parsed, max);
}

function limitFor(bucket: RateLimitBucket): { max: number; windowSeconds: number } {
  const spec = BUCKETS[bucket];
  return {
    max: parsePositiveInt(process.env[spec.maxVar], spec.maxDefault, MAX_LIMIT),
    // A window of 0 would make every request its own window, which reads as "configured a limit"
    // while enforcing nothing. One second is the smallest honest answer.
    windowSeconds: Math.max(1, parsePositiveInt(process.env[spec.windowVar], spec.windowDefault, MAX_WINDOW_SECONDS)),
  };
}

function entryKey(bucket: RateLimitBucket, key: string): string {
  return `${bucket}|${key}`.slice(0, MAX_KEY_LENGTH);
}

/**
 * Amortized O(1), worst case one pass over MAX_ENTRIES. Eviction fails OPEN - an evicted
 * attacker key restarts at zero - because a counter must never become an availability control.
 * That is also why the cap is generous.
 */
function pruneIfOverCapacity(now: number): void {
  if (counters.size <= MAX_ENTRIES) return;
  for (const [id, entry] of counters) {
    if (now >= entry.resetAt) counters.delete(id);
  }
  // Map iterates in insertion order, so this drops the oldest keys first.
  for (const id of counters.keys()) {
    if (counters.size <= MAX_ENTRIES) break;
    counters.delete(id);
  }
}

function decide(bucket: RateLimitBucket, key: string, consume: boolean): RateLimitDecision {
  const limit = limitFor(bucket);
  if (limit.max === 0) return { allowed: true, retryAfterSeconds: 0, tripped: false };

  const now = Date.now();
  const id = entryKey(bucket, key);
  const existing = counters.get(id);
  const live = existing !== undefined && now < existing.resetAt;
  const entry: Counter = live
    ? (existing as Counter)
    : { count: 0, resetAt: now + limit.windowSeconds * 1000, notified: false };

  if (!live) {
    counters.set(id, entry);
    pruneIfOverCapacity(now);
  }

  // resetAt is always strictly greater than now on both paths, so this is never below 1.
  const retryAfterSeconds = Math.ceil((entry.resetAt - now) / 1000);

  if (entry.count >= limit.max) {
    const tripped = !entry.notified;
    entry.notified = true;
    return { allowed: false, retryAfterSeconds, tripped };
  }

  if (consume) entry.count += 1;
  return { allowed: true, retryAfterSeconds, tripped: false };
}

/** Spends one unit of the bucket's budget when the budget allows it. */
export function consumeRateLimit(bucket: RateLimitBucket, key: string): RateLimitDecision {
  return decide(bucket, key, true);
}

/**
 * Reads the bucket without spending budget. It still latches the one-time trip notice, so a
 * rejection observed only through peek is audited exactly once.
 */
export function peekRateLimit(bucket: RateLimitBucket, key: string): RateLimitDecision {
  return decide(bucket, key, false);
}

/** Clears one key. A successful login calls this on both of its keys. */
export function resetRateLimit(bucket: RateLimitBucket, key: string): void {
  counters.delete(entryKey(bucket, key));
}

/**
 * Test seam. `bun run test` runs tests/unit, tests/api, tests/integration and tests/security in a
 * single process, so this module's state is shared across every file in that run; any test file
 * that exercises a rate-limited route calls this in beforeEach.
 */
export function clearRateLimitState(): void {
  counters.clear();
}
