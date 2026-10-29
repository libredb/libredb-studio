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
 * token, the subject, the groups or the object. Two reasons are an operator's to fix and log at error level: a token
 * that may not create a self review (`forbidden`) and a ServiceAccount review on OpenShift (`platform`).
 *
 * A self review (openshift sign-in) is kept per session handle, uid and attributes, so two sessions never share a
 * decision or a request in flight and a handle that comes back for another person inherits none; the token is never
 * part of a key or a value, and the handle and the uid are only hashed into a key. Its `expired` verdict, the API
 * server's 401, is never kept and never logged here: the gate ends the session's record and logs that once. A self
 * review without a session handle or a uid could share a key with another, so it denies without a request unless the
 * decision is fresh.
 *
 * The state lives on `globalThis` under a registered symbol: Next.js bundles each route handler apart, so a module
 * variable would hold one cache per route (src/lib/governance/state.ts does the same).
 */
import { createHash } from "node:crypto";
import { byCodeUnits } from "@/lib/governance/jcs";
import { logger } from "@/lib/logger";
import { accessReviewCacheMs } from "./config";
import {
  type AnyReviewSubject,
  type FailedReview,
  isSelfSubject,
  requestAccessReview,
  type ResourceAttributes,
  type ReviewFailureReason,
  type ReviewOutcome,
} from "./review";

const STORE_KEY = Symbol.for("libredb-studio.kubernetes-access-decisions");
const MAX_DECISIONS = 10_000;
const FAILURE_LOG_INTERVAL_MS = 60_000;
const FAILURE_MESSAGE = "Kubernetes access review failed, so the request it decides is denied";
/** The failures an operator has to fix, logged at error level with the sentence that names the fix. */
const ERROR_MESSAGES: Partial<Record<ReviewFailureReason, string>> = {
  forbidden:
    "Kubernetes access review: the session's token may not create a SelfSubjectAccessReview (HTTP 403), so the request it decides is denied; sign-in should have refused a token without the user:check-access scope",
  platform:
    "Kubernetes access review: this cluster serves config.openshift.io/v1, where a ServiceAccount review cannot assert the cluster's user name for an OIDC subject, so every review is denied; sign in with NEXT_PUBLIC_AUTH_PROVIDER=openshift instead",
};

/** What a decision answers: allowed, denied (a failure included), or expired, a self review's token the API refused. */
export type ReviewVerdict = "allowed" | "denied" | "expired";

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
  readonly inFlight: Map<string, Promise<ReviewVerdict>>;
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
 * One key per user, set of groups and attributes, or per session handle, uid and attributes for a self review, hashed
 * so the map holds no handle, uid, group or object name. The groups are sorted by code unit, so the key never depends
 * on the server's locale.
 */
function decisionKey(subject: AnyReviewSubject, attributes: ResourceAttributes): string {
  const { verb, group, resource, namespace, name } = attributes;
  const who = isSelfSubject(subject)
    ? ["self", subject.sessionHandle, subject.uid]
    : [subject.user, [...new Set(subject.groups)].sort(byCodeUnits)];
  return createHash("sha256")
    .update(JSON.stringify([...who, verb, group, resource, namespace, name]))
    .digest("hex");
}

/** Logs a failure unless its reason was logged within the last minute, which it counts instead. */
function noteFailure(outcome: FailedReview): void {
  const { failures } = store();
  const now = Date.now();
  const last = failures.get(outcome.reason);
  if (last !== undefined && now - last.loggedAt < FAILURE_LOG_INTERVAL_MS) {
    last.heldBack += 1;
    return;
  }
  const status = outcome.status === undefined ? {} : { status: outcome.status };
  const context = { route: "kubernetes-access", reason: outcome.reason, ...status, heldBack: last?.heldBack ?? 0 };
  const severe = ERROR_MESSAGES[outcome.reason];
  if (severe === undefined) logger.warn(FAILURE_MESSAGE, context);
  else logger.error(severe, undefined, context);
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

/** Asks the API once, logging a failure, and turns the outcome into a verdict: a failure denies. */
async function decide(subject: AnyReviewSubject, attributes: ResourceAttributes): Promise<ReviewOutcome> {
  const outcome = await requestAccessReview(subject, attributes);
  if (outcome.kind === "failed") noteFailure(outcome);
  return outcome;
}

const verdictOf = (outcome: ReviewOutcome): ReviewVerdict => (outcome.kind === "failed" ? "denied" : outcome.kind);

/**
 * What the access review answers for `subject` and what `attributes` name: from the cache while an answer is fresh,
 * else from one review shared by every concurrent asker of the same key. `fresh` asks the API whatever is cached and
 * keeps nothing, for a decision taken once, such as the role at sign-in. Only allowed and denied are kept; expired and
 * every failure are not, so the next ask goes out again. Never throws; a failure is denied.
 */
export async function accessReviewVerdict(
  subject: AnyReviewSubject,
  attributes: ResourceAttributes,
  options: { readonly fresh?: boolean } = {},
): Promise<ReviewVerdict> {
  if (options.fresh) return verdictOf(await decide(subject, attributes));
  if (isSelfSubject(subject) && (subject.sessionHandle === "" || subject.uid === "")) {
    noteFailure({ kind: "failed", reason: "config" });
    return "denied";
  }
  let lifetimeMs: number;
  try {
    lifetimeMs = accessReviewCacheMs();
  } catch {
    noteFailure({ kind: "failed", reason: "config" });
    return "denied";
  }
  const { decisions, inFlight } = store();
  const key = decisionKey(subject, attributes);
  const cached = decisions.get(key);
  if (cached !== undefined && cached.expiresAt > Date.now()) return cached.allowed ? "allowed" : "denied";
  const pending = inFlight.get(key);
  if (pending !== undefined) return pending;
  const asked = decide(subject, attributes)
    .then((outcome) => {
      const kept = outcome.kind === "allowed" || outcome.kind === "denied";
      if (kept && lifetimeMs > 0)
        remember(key, { allowed: outcome.kind === "allowed", expiresAt: Date.now() + lifetimeMs });
      return verdictOf(outcome);
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, asked);
  return asked;
}

/** Whether the access review allows `subject` to do what `attributes` name: true only for an allowed verdict. */
export async function accessReviewAllows(
  subject: AnyReviewSubject,
  attributes: ResourceAttributes,
  options: { readonly fresh?: boolean } = {},
): Promise<boolean> {
  return (await accessReviewVerdict(subject, attributes, options)) === "allowed";
}
