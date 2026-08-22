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
 * Memory bound: MAX_ENTRIES_PER_BUCKET (1000) x 5 buckets = 5000 counters total. Each counter is a
 * map entry keyed by up to MAX_KEY_LENGTH (200) UTF-16 characters (~400 bytes) plus a small
 * {count, resetAt, notified} object and Map/object overhead, so the realistic bound is roughly
 * 2.5-3 MB, not a flat "100 bytes per counter" - correct this comment again if either constant
 * changes. Nobody may add a second, unbounded map alongside these.
 *
 * Capacity is partitioned PER BUCKET, not shared across buckets: see pruneIfAtCapacity. A single
 * shared eviction pool would let an attacker flood a cheap, address-keyed bucket (login_client,
 * anon - rotate X-Forwarded-For, each rotation is a free new key) to evict entries out of a
 * different bucket (login_account) map-wide, and eviction resets a counter to zero by design. That
 * would let an attacker who just tripped login_account on a victim's account reset it for free by
 * generating unrelated traffic elsewhere - defeating the one bucket that is immune to header
 * spoofing. Partitioning makes that cross-bucket eviction structurally impossible: traffic in one
 * bucket can only ever evict entries already in that same bucket's own store.
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

/**
 * Per-bucket cap - see the module docstring for why this is partitioned rather than shared.
 * Exported so tests can derive a flood size that is guaranteed to force eviction (cap + 1) instead
 * of hardcoding a number that silently stops proving anything if this constant ever moves.
 */
export const MAX_ENTRIES_PER_BUCKET = 1000;
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
  // reason it exists. Bounded at 20 per 5 minutes and cleared by a successful login. A per-account
  // cap is ALWAYS a denial-of-login handle on a known account, not something a smarter design can
  // remove: whoever trips it locks the real owner out for the rest of the window, renewable
  // indefinitely afterwards at roughly one trip per window. That is the accepted trade for
  // bounding brute force against an operator-set password. The bucket shipped with a 900-second
  // window, which made the lockout longer than the trade justified; 300 seconds keeps the same
  // order-of-magnitude guess ceiling with a smaller blast radius. RATE_LIMIT_LOGIN_ACCOUNT_MAX=0
  // is the documented break-glass for an operator who needs the bucket off entirely - verified
  // in decide() below, a limit of 0 allows every request unconditionally rather than blocking
  // everything. This bucket's own capacity partition is what keeps it immune to eviction pressure
  // from login_client/anon too - see the module docstring.
  login_account: {
    maxVar: "RATE_LIMIT_LOGIN_ACCOUNT_MAX",
    windowVar: "RATE_LIMIT_LOGIN_ACCOUNT_WINDOW_SEC",
    maxDefault: 20,
    windowDefault: 300,
  },
  // Shared by every route that reaches an LLM provider or touches an agent run, so that
  // rotating between them cannot multiply the budget. Stated as a RULE rather than a count,
  // because every count written here has been wrong: a route can join this bucket three ways
  // and each is invisible to a grep for the others. Directly, through
  // guardRoute({ bucket: "ai" }) - the /api/ai/* routes and POST /api/agent/runs.
  // Indirectly, through accessAgentRun, which passes the same bucket for all FOUR per-run
  // handlers: reading a run, cancelling one, streaming one, and fetching an artifact - note
  // that those four live in three route modules, so counting modules under-counts handlers.
  // And by calling consumeRateLimit("ai", ...) with no bucket literal at all, which is what
  // POST /api/agent/drive does.
  //
  // The one exception is GET /api/agent/config, which verifies its session with getSession
  // instead of guardRoute and is charged nothing: it reaches no provider, and a surface that
  // must ask whether the agent exists before rendering cannot be rate-limited by the same
  // budget as the work itself.
  //
  // A slot is not a unit of cost. One spent on POST /api/agent/runs starts a run that then makes
  // many model calls of its own, so this bounds how often LLM work is STARTED, never how much it
  // spends.
  ai: { maxVar: "RATE_LIMIT_AI_MAX", windowVar: "RATE_LIMIT_AI_WINDOW_SEC", maxDefault: 20, windowDefault: 60 },
  // Shared across every route that reaches a database - query, multi-query, transaction,
  // disconnect, cancel, health, maintenance, monitoring, pool-stats, profile, provider-meta,
  // schema, schema/list, schema/relations, schema-snapshot, test-connection, admin/fleet-health,
  // plus the three storage routes (storage, storage/[collection], storage/migrate): TWENTY routes
  // today (grep -rl 'bucket: "query"' src/app/api/ finds eighteen; schema/list and schema/relations
  // reach this bucket indirectly, through schema-route.ts's shared handleSchemaRequest). The same
  // workload reached through a different endpoint must not get a second budget - re-verify and
  // correct this comment again if guardRoute grows a new call site.
  //
  // The storage family joined when AU1 moved it onto the shared 401 (2026-08-22), and that gave it
  // a limiter it never had. It belongs here rather than in a bucket of its own: under
  // STORAGE_PROVIDER=sqlite or postgres these routes read and write a real database, which is what
  // this bucket meters. A bucket of its own would be a fourth configurable pair for a workload
  // that is debounced write-through sync, far under 120 requests a minute in normal use.
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

/**
 * One Map per bucket, never one shared Map. This is the partition itself: pruneIfAtCapacity only
 * ever receives the store for the bucket being written to, so it can only evict entries that
 * already live in that same store.
 */
const bucketStores: Record<RateLimitBucket, Map<string, Counter>> = {
  login_client: new Map(),
  login_account: new Map(),
  ai: new Map(),
  query: new Map(),
  anon: new Map(),
};

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

/** Bounds the key alone (no bucket prefix needed - each bucket already has its own store). */
function truncatedKey(key: string): string {
  return key.slice(0, MAX_KEY_LENGTH);
}

/**
 * Takes the target bucket's own store, and only that store - never the full bucketStores map -
 * which is what makes eviction pressure in one bucket unable to reach another bucket's counters
 * (module docstring). Eviction fails OPEN - an evicted attacker key restarts at zero - because a
 * counter must never become an availability control. That is also why the cap is generous.
 *
 * CALLED BEFORE THE NEW KEY IS INSERTED, on purpose, whenever the store is already at capacity -
 * ensuring there is room for one more entry. This is load-bearing, not a style choice: a Counter
 * always starts at count 0, and 0 is the smallest a count can ever be, so if the entry about to be
 * created were itself a candidate for "lowest count", it would always win and evict itself. That
 * was this function's actual bug in an earlier version of this file: pruning ran AFTER insert, the
 * newly-inserted entry was always the unique minimum, and it always evicted itself - meaning any
 * entry that had ever reached count >= 1 became permanently immune to eviction. A bucket seeded
 * with MAX_ENTRIES_PER_BUCKET disposable decoys, each hit exactly once and audit-silent because
 * none of them trip, would then protect a REAL target forever: the target's own entry could never
 * be created, because every attempt to create it would trigger a prune that evicted the
 * just-created entry rather than a decoy. Pruning before insert removes the entry from candidacy
 * entirely, so the decoys - sitting at the bucket's actual lowest count - become the cheapest
 * victims instead.
 *
 * Two phases, in order:
 * 1. Reclaim expired entries first. They cost nothing to discard (their window is already over)
 *    and this alone is often enough, so it runs before the more expensive phase below.
 * 2. If still at capacity, evict the EXISTING entry with the LOWEST count, not the oldest by
 *    insertion. Ties (e.g. a flood of same-count decoys) resolve to the earliest inserted, because
 *    Map iteration order is insertion order and only a STRICTLY lower count replaces the running
 *    minimum - so a homogeneous flood behaves like a sliding window, always giving up its oldest
 *    member, never a genuinely different one.
 *
 * Why lowest-count and not oldest-first: an eviction policy should discard the entry doing the
 * LEAST work. A high count means that entry is actively limiting somebody; a count of one is a
 * stranger who knocked once and costs nothing to forget. Oldest-first throws away exactly the
 * wrong entry, because a determined attacker's target - the one closest to tripping - is, by
 * construction, the entry that has been sitting in the map the longest: it was created first and
 * has been accumulating count ever since. That made oldest-first eviction a bypass for the one
 * bucket (login_account) whose key is fully attacker-chosen (hmacHex of the submitted email):
 * burn a target's budget, then flood the bucket with ~1000 disposable single-guess accounts to
 * evict the target's entry and buy a fresh budget for the price of the flood.
 *
 * Lowest-count eviction (excluding the entry being inserted) does not require an attacker to push
 * decoys PAST a target's count - only to TIE it. Ties resolve to the earliest inserted (phase 2
 * above), and a real target predates every decoy raised to catch up with it, so once every OTHER
 * entry in the bucket reaches the target's own count, the target - being the earliest member of
 * that tied group - is what loses the tie-break, not a decoy. A long-established entry can lose to
 * a newer one that has merely caught up, never overtaken it. This is a known, accepted property of
 * this policy, not an oversight: the alternative tie-break (favour evicting the newest) was
 * considered and rejected, because the two earlier changes to this function's eviction rule each
 * introduced a worse flaw than the one they fixed, and the cost below is a real deterrent on its
 * own without touching the policy a third time.
 *
 * What this DOES cost the attacker: tying a target sitting at count N costs roughly
 * (MAX_ENTRIES_PER_BUCKET - 1) x N decoy requests, NOT a flat MAX_ENTRIES_PER_BUCKET - 1 - each of
 * the ~999 decoys must itself be raised from 0 to N, not merely inserted once, before the tie-break
 * can fire. At login_account's current default (20), a target one guess from tripping (N=20 -
 * decide() checks entry.count >= limit.max BEFORE incrementing, so the entry sits at count 20, not
 * 19, with one guess left in its budget) costs on the order of 999 x 20 - about twenty thousand
 * decoy requests to buy back that one guess, not "about a thousand". It is still a real, linear
 * cost multiplier over simply guessing (linear in both the bucket size and how deep the target
 * already is), and it is NOT audit-visible: catching up to a target's count never requires a decoy
 * to reach its OWN max, so no decoy bucket trips and no rate_limit_exceeded event fires. Do not
 * describe this as self-defeating or as leaving an audit trail; it does neither. (This residual
 * belongs in docs/BACKLOG.md - not added here.)
 *
 * Complexity note: this function runs once per request for a key with no live entry, before that
 * entry is created, so it is never asked to make room for more than one new arrival at a time - a
 * single full-store scan for the minimum is enough; no loop is needed.
 */
function pruneIfAtCapacity(store: Map<string, Counter>, now: number): void {
  if (store.size < MAX_ENTRIES_PER_BUCKET) return;
  for (const [id, entry] of store) {
    if (now >= entry.resetAt) store.delete(id);
  }
  if (store.size < MAX_ENTRIES_PER_BUCKET) return;

  // Seeded with entries[0] rather than left to reduce()'s no-initial-value form (SonarCloud
  // typescript:S6959): behaviourally identical when non-empty - the seed compares against itself
  // as a no-op on the first iteration - but reduce() with no initial value throws on an empty
  // array, and Sonar's static analysis cannot see that the two size checks above already rule
  // that out here. Explicit is also correct if a future refactor ever loses one of those guards.
  const entries = [...store];
  const [victimId] = entries.reduce(
    (min, candidate) => (candidate[1].count < min[1].count ? candidate : min),
    entries[0],
  );
  store.delete(victimId);
}

function decide(bucket: RateLimitBucket, key: string, consume: boolean): RateLimitDecision {
  const limit = limitFor(bucket);
  if (limit.max === 0) return { allowed: true, retryAfterSeconds: 0, tripped: false };

  const store = bucketStores[bucket];
  const now = Date.now();
  const id = truncatedKey(key);
  const existing = store.get(id);
  const live = existing !== undefined && now < existing.resetAt;

  // Make room BEFORE creating the new entry, while it is still just a key with no Counter of its
  // own - see pruneIfAtCapacity's doc comment for why the ordering itself is the fix.
  if (!live) pruneIfAtCapacity(store, now);

  const entry: Counter = live
    ? (existing as Counter)
    : { count: 0, resetAt: now + limit.windowSeconds * 1000, notified: false };

  if (!live) store.set(id, entry);

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
  bucketStores[bucket].delete(truncatedKey(key));
}

/**
 * Test seam. `bun run test` runs tests/unit, tests/api, tests/integration and tests/security in a
 * single process, so this module's state is shared across every file in that run; any test file
 * that exercises a rate-limited route calls this in beforeEach.
 */
export function clearRateLimitState(): void {
  for (const store of Object.values(bucketStores)) store.clear();
}
