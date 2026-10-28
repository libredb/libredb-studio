/**
 * The access review's decisions, as the gates ask for them: cached, one request in flight per key, and a deny for
 * anything that is not an answer.
 *
 * An allowed or denied answer is kept for `KUBERNETES_ACCESS_REVIEW_CACHE_SECONDS` (30 by default, at most 60), per
 * user, groups as a set and resource attributes, so a role removed in Kubernetes is refused at the latest that long
 * after its RoleBinding is gone. A failure is never kept: it denies this request, and the next one asks again. A
 * cache lifetime that cannot be read denies too, without a request, because no answer can be judged fresh.
 *
 * Failures are logged at most once a minute per reason, with how many were held back since the last line, because an
 * API server that is down fails every review of every list refresh. A line names the reason and a status, never the
 * token, the subject, the groups or the object.
 *
 * The state lives on `globalThis` under a registered symbol: Next.js bundles each route handler apart, so a module
 * variable would hold one cache per route (src/lib/governance/state.ts does the same).
 */
import { createHash } from "node:crypto";
import { byCodeUnits } from "@/lib/governance/jcs";
import { logger } from "@/lib/logger";
import { accessReviewCacheMs } from "./config";
import {
  requestAccessReview,
  type ResourceAttributes,
  type ReviewFailureReason,
  type ReviewOutcome,
  type ReviewSubject,
} from "./review";

const STORE_KEY = Symbol.for("libredb-studio.kubernetes-access-decisions");
const MAX_DECISIONS = 10_000;
const FAILURE_LOG_INTERVAL_MS = 60_000;
const FAILURE_MESSAGE = "Kubernetes access review failed, so the request it decides is denied";

interface Decision {
  readonly allowed: boolean;
  readonly expiresAt: number;
}

interface FailureLog {
  readonly loggedAt: number;
  heldBack: number;
}

interface DecisionStore {
  readonly limit: number;
  readonly decisions: Map<string, Decision>;
  readonly inFlight: Map<string, Promise<boolean>>;
  readonly failures: Map<ReviewFailureReason, FailureLog>;
}

type StoreHolder = { [STORE_KEY]?: DecisionStore };

function newStore(limit: number): DecisionStore {
  return { limit, decisions: new Map(), inFlight: new Map(), failures: new Map() };
}

function store(): DecisionStore {
  const holder = globalThis as StoreHolder;
  holder[STORE_KEY] ??= newStore(MAX_DECISIONS);
  return holder[STORE_KEY];
}

/** Test seam: forgets every decision and every logged failure, as a new process would, with an optional size limit. */
export function resetAccessReviewDecisions(limit = MAX_DECISIONS): void {
  (globalThis as StoreHolder)[STORE_KEY] = newStore(limit);
}

/**
 * One key per user, set of groups and attributes, hashed so the map holds no group or object name. The groups are
 * sorted by code unit, so the key never depends on the server's locale.
 */
function decisionKey(subject: ReviewSubject, attributes: ResourceAttributes): string {
  const groups = [...new Set(subject.groups)].sort(byCodeUnits);
  const { verb, group, resource, namespace, name } = attributes;
  return createHash("sha256")
    .update(JSON.stringify([subject.user, groups, verb, group, resource, namespace, name]))
    .digest("hex");
}

/** Logs a failure unless its reason was logged within the last minute, which it counts instead. */
function noteFailure(outcome: Extract<ReviewOutcome, { kind: "failed" }>): void {
  const { failures } = store();
  const now = Date.now();
  const last = failures.get(outcome.reason);
  if (last !== undefined && now - last.loggedAt < FAILURE_LOG_INTERVAL_MS) {
    last.heldBack += 1;
    return;
  }
  const status = outcome.status === undefined ? {} : { status: outcome.status };
  logger.warn(FAILURE_MESSAGE, {
    route: "kubernetes-access",
    reason: outcome.reason,
    ...status,
    heldBack: last?.heldBack ?? 0,
  });
  failures.set(outcome.reason, { loggedAt: now, heldBack: 0 });
}

/** Keeps a decision, dropping expired ones first and then the oldest, so the map stays within its limit. */
function remember(key: string, decision: Decision): void {
  const { decisions, limit } = store();
  decisions.delete(key);
  if (decisions.size >= limit) {
    const now = Date.now();
    for (const [stored, kept] of decisions) if (kept.expiresAt <= now) decisions.delete(stored);
  }
  while (decisions.size >= limit) decisions.delete(decisions.keys().next().value as string);
  decisions.set(key, decision);
}

/** Asks the API once, logging a failure; true only for an allowed answer. */
async function decide(subject: ReviewSubject, attributes: ResourceAttributes): Promise<ReviewOutcome> {
  const outcome = await requestAccessReview(subject, attributes);
  if (outcome.kind === "failed") noteFailure(outcome);
  return outcome;
}

/**
 * Whether the access review allows `subject` to do what `attributes` name: from the cache while an answer is fresh,
 * else from one review shared by every concurrent asker of the same key. `fresh` asks the API whatever is cached and
 * keeps nothing, for a decision taken once, such as the admin role at sign-in. Never throws; false for a failure.
 */
export async function accessReviewAllows(
  subject: ReviewSubject,
  attributes: ResourceAttributes,
  options: { readonly fresh?: boolean } = {},
): Promise<boolean> {
  if (options.fresh) return (await decide(subject, attributes)).kind === "allowed";
  let lifetimeMs: number;
  try {
    lifetimeMs = accessReviewCacheMs();
  } catch {
    noteFailure({ kind: "failed", reason: "config" });
    return false;
  }
  const { decisions, inFlight } = store();
  const key = decisionKey(subject, attributes);
  const cached = decisions.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.allowed;
  const pending = inFlight.get(key);
  if (pending !== undefined) return pending;
  const asked = decide(subject, attributes)
    .then((outcome) => {
      if (outcome.kind === "failed") return false;
      const allowed = outcome.kind === "allowed";
      if (lifetimeMs > 0) remember(key, { allowed, expiresAt: Date.now() + lifetimeMs });
      return allowed;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, asked);
  return asked;
}
