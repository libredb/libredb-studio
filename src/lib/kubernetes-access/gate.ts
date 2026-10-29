/**
 * The two decisions the Kubernetes access review makes (docs/SEED_CONNECTIONS.md, "Kubernetes access review").
 *
 * Connections: a connection that names the Kubernetes Secret its credentials come from (`kubernetesSecret`, set in
 * code by a Kubernetes discovery source, never read from a file) is listed and opened only for a session the review
 * allows to `get` that Secret. While the review is on, the seed listing sets every such connection apart
 * (`pendingReview` of src/lib/seed/index.ts) carrying KUBERNETES_REVIEWED_ROLE, which the role filter refuses whatever
 * the caller holds, so this gate is the only way one is listed or opened, for admins and users alike. The review's
 * `user` is the signed session's identity provider subject and its `groups` the groups store's record of that subject
 * (groups.ts); a session without a subject, an issuer or a record is denied without a request. In openshift sign-in
 * mode the review is a self review with the session's own token instead (src/lib/openshift-auth/token-store.ts), read
 * from its live record before every decision, cached or not, so no decision outlives its record; a session without a
 * key or a live record is denied without a request, and the groups store is never read. A 401 ends the record, logs
 * once, and denies the rest of that list without a request; the session signs in again from its next request. Any
 * exception while deciding a row denies the row and is logged by the error's name only. The dispatcher
 * (src/lib/governance/visible.ts) hands the gate those connections and, while the review is on, any other row that
 * names a Secret, so it denies, without a request, a connection without `kubernetesSecret` (a defect: a projection
 * lost the marker) and every connection while the review is off (the listing sets none apart then, and lists them to
 * the admin role only through the role filter, the rule platform discovery uses). Both functions return the very
 * connection objects they were handed, never a copy, because the dispatcher keeps the rows they allow by identity.
 *
 * Sign-in: while the review is on, a verified sign-in may use this Studio only when its subject can be asserted at
 * all and a fresh review of `KUBERNETES_ACCESS_REVIEW_SIGN_IN` allows it, by default `list` on Rancher's NavLinks at
 * cluster scope, which every role a cluster grants allows and a Rancher user without a role in the cluster does not.
 *
 * Admin: a Studio admin is a person the review allows to `update` Studio's own Deployment, decided once at sign-in.
 * Whoever may update that Deployment can already change Studio's environment, image and mounts, and so read every
 * credential Studio holds, so the rule grants nothing the pod spec does not.
 */
import { logger } from "@/lib/logger";
import {
  endOpenShiftSession,
  type OpenShiftSessionKey,
  openShiftBearerToken,
  openShiftSessionKey,
} from "@/lib/openshift-auth/token-store";
import type { ManagedConnection } from "@/lib/seed/types";
import { accessReviewAdminTarget, accessReviewEnabled, accessReviewSignIn, selfReviewMode } from "./config";
import { accessReviewAllows, accessReviewVerdict, type ReviewVerdict } from "./decisions";
import { recordedGroups, reviewSubjectProblem } from "./groups";
import type { ResourceAttributes } from "./review";

/**
 * The most reviews one list keeps in flight. A list asks about every reviewed connection it holds, as many as a
 * discovery source exports, and a review the API server answers late denies, so they are not all sent at once.
 */
const MAX_REVIEWS_IN_FLIGHT = 16;

const EXPIRED_MESSAGE =
  "Kubernetes access review: the API server refused a session's token (HTTP 401), so that session signs in again";
const UNDECIDED_MESSAGE = "Kubernetes access review: a review could not be decided, so it is denied";

/**
 * Who asks: the signed session's role, the identity provider subject and issuer a sign-in gave it, and, from openshift
 * sign-in, its user name and the handle of its token record.
 */
export interface ReviewedPrincipal {
  readonly role: string;
  readonly username?: string;
  readonly idpSubject?: string;
  readonly idpIssuer?: string;
  readonly sessionHandle?: string;
}

/** What the reviews of one list share: set once a review meets a dead token, so the rest of the list sends none. */
interface ListReview {
  expired: boolean;
}

/** The key and token of `session`'s live record, or null when it has no key or no live record. */
function liveRecord(session: ReviewedPrincipal): { readonly key: OpenShiftSessionKey; readonly token: string } | null {
  const key = openShiftSessionKey(session);
  const token = key === null ? null : openShiftBearerToken(key);
  return key === null || token === null ? null : { key, token };
}

/** The self review's verdict with a live record's token; an expired verdict ends the record, logged once per record. */
async function selfReviewVerdict(
  record: { readonly key: OpenShiftSessionKey; readonly token: string },
  attributes: ResourceAttributes,
): Promise<ReviewVerdict> {
  const { key, token } = record;
  const verdict = await accessReviewVerdict({ sessionHandle: key.sessionHandle, token }, attributes);
  if (verdict === "expired" && endOpenShiftSession(key.sessionHandle)) {
    logger.info(EXPIRED_MESSAGE, { route: "kubernetes-access" });
  }
  return verdict;
}

/** Logs an exception that kept a review from being decided, by the error's name only: a message may quote a value. */
function logUndecided(error: unknown): void {
  const kind = error instanceof Error ? error.name : typeof error;
  logger.error(UNDECIDED_MESSAGE, undefined, { route: "kubernetes-access", kind });
}

/** Whether `principal` may list and open `connection`. Never throws: an exception denies. */
async function mayUse(principal: ReviewedPrincipal, connection: ManagedConnection, list: ListReview): Promise<boolean> {
  const secret = connection.kubernetesSecret;
  if (secret === undefined || list.expired) return false;
  try {
    if (!accessReviewEnabled()) return false;
    const attributes = { verb: "get", group: "", resource: "secrets", namespace: secret.namespace, name: secret.name };
    if (selfReviewMode()) {
      const record = liveRecord(principal);
      if (record === null) return false;
      const verdict = await selfReviewVerdict(record, attributes);
      if (verdict === "expired") list.expired = true;
      return verdict === "allowed";
    }
    const groups = recordedGroups(principal.idpIssuer, principal.idpSubject);
    if (groups === null) return false;
    return await accessReviewAllows({ user: principal.idpSubject as string, groups }, attributes);
  } catch (error) {
    logUndecided(error);
    return false;
  }
}

/**
 * The connections `principal` may use, in their order; the reviews of one list run together, at most
 * MAX_REVIEWS_IN_FLIGHT at a time.
 */
export async function connectionsUnderAccessReview(
  principal: ReviewedPrincipal,
  connections: ManagedConnection[],
): Promise<ManagedConnection[]> {
  const verdicts: boolean[] = [];
  const list: ListReview = { expired: false };
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < connections.length) {
      const index = next;
      next += 1;
      // oxlint-disable-next-line no-await-in-loop -- each worker holds one review in flight at a time, which is the bound.
      verdicts[index] = await mayUse(principal, connections[index], list);
    }
  };
  await Promise.all(Array.from({ length: Math.min(MAX_REVIEWS_IN_FLIGHT, connections.length) }, worker));
  return connections.filter((_, index) => verdicts[index]);
}

/** The connection, when `principal` may use it; null otherwise, as for a connection that does not exist. */
export async function connectionUnderAccessReview(
  principal: ReviewedPrincipal,
  connection: ManagedConnection | null,
): Promise<ManagedConnection | null> {
  return connection !== null && (await mayUse(principal, connection, { expired: false })) ? connection : null;
}

/**
 * The sign-in review's attributes, null when this mode runs none (openshift with KUBERNETES_ACCESS_REVIEW_SIGN_IN
 * unset), or undefined with a warning naming the setting when it cannot be read.
 */
function signInAttributes(): ResourceAttributes | null | undefined {
  try {
    return accessReviewSignIn();
  } catch (error) {
    logger.warn("Kubernetes access review: the sign-in review cannot be read, so no one can sign in", {
      route: "kubernetes-access",
      problem: (error as Error).message,
    });
    return undefined;
  }
}

/** The admin target, or null with a warning naming the setting when it cannot be read. */
function signInAdminTarget(): ResourceAttributes | null {
  try {
    return accessReviewAdminTarget();
  } catch (error) {
    logger.warn("Kubernetes access review: no admin role can be decided, so this sign-in is a user", {
      route: "kubernetes-access",
      problem: (error as Error).message,
    });
    return null;
  }
}

const TARGET_WARNED_AT = Symbol.for("libredb-studio.kubernetes-access-admin-target-warned");
const TARGET_WARNING_INTERVAL_MS = 60_000;

/**
 * The admin target for a request of an admin session, or null when it cannot be read, with a warning naming the
 * setting at most once a minute, because every request of every admin session asks.
 */
function requestAdminTarget(): ResourceAttributes | null {
  try {
    return accessReviewAdminTarget();
  } catch (error) {
    const holder = globalThis as { [TARGET_WARNED_AT]?: number };
    const now = Date.now();
    if (now - (holder[TARGET_WARNED_AT] ?? Number.NEGATIVE_INFINITY) >= TARGET_WARNING_INTERVAL_MS) {
      holder[TARGET_WARNED_AT] = now;
      logger.warn("Kubernetes access review: no admin role can be decided, so the request runs as a user", {
        route: "kubernetes-access",
        problem: (error as Error).message,
      });
    }
    return null;
  }
}

/**
 * The role a verified sign-in gets while the review is on, or null when it may not sign in at all: a subject no
 * review may assert (logged with the reason, never the subject), or one a fresh sign-in review does not allow, a
 * failure or an unreadable setting included. Otherwise admin when a fresh review allows `subject`, in `groups`, to
 * `update` Studio's Deployment or LibreDBStudio resource, and user for a deny, a failure or a missing admin setting.
 */
export async function accessReviewSignInRole(
  subject: string,
  groups: readonly string[],
): Promise<"admin" | "user" | null> {
  const problem = reviewSubjectProblem(subject);
  if (problem !== null) {
    logger.warn("Kubernetes access review: this sign-in is refused before any review", {
      route: "kubernetes-access",
      problem,
    });
    return null;
  }
  // OIDC mode always has a sign-in review; none, or one that cannot be read, refuses.
  const attributes = signInAttributes();
  if (!attributes) return null;
  if (!(await accessReviewAllows({ user: subject, groups }, attributes, { fresh: true }))) return null;
  const target = signInAdminTarget();
  if (target === null) return "user";
  return (await accessReviewAllows({ user: subject, groups }, target, { fresh: true })) ? "admin" : "user";
}

/**
 * openshift sign-in: the role a fresh session gets, or null when the optional sign-in review refuses it. Every review
 * here is fresh, made with the new access token alone and kept nowhere, so nothing at sign-in is cached:
 * 1. A sign-in review that cannot be read refuses, as for OIDC: nobody signs in on a broken setting.
 * 2. With KUBERNETES_ACCESS_REVIEW_SIGN_IN set, anything but an allowed verdict refuses, a failure or a dead token
 *    included; unset, there is no sign-in review.
 * 3. An admin target that cannot be read makes a user.
 * 4. Admin when the review allows `update` on the admin target; user for a deny, a failure or a dead token, so an API
 *    outage neither locks everyone out nor makes anyone admin.
 */
export async function selfReviewSignInRole(accessToken: string): Promise<"admin" | "user" | null> {
  const subject = { sessionHandle: "", token: accessToken };
  const signIn = signInAttributes();
  if (signIn === undefined) return null;
  if (signIn !== null && (await accessReviewVerdict(subject, signIn, { fresh: true })) !== "allowed") return null;
  const target = signInAdminTarget();
  if (target === null) return "user";
  return (await accessReviewVerdict(subject, target, { fresh: true })) === "allowed" ? "admin" : "user";
}

/** The session fields the openshift role check reads. */
export interface ReviewedSession {
  readonly role: string;
  readonly username?: string;
  readonly idpSubject?: string;
  readonly idpIssuer?: string;
  readonly sessionHandle?: string;
}

/**
 * openshift mode, every request: the role the request runs with, or `expired` when the session must sign in again.
 * Admin is checked again through the decision cache on every request of an admin session, so a removed right demotes
 * it within the cache lifetime:
 * 1. A role other than admin is user, without a request: a user session is never promoted mid-session.
 * 2. A session with no key or no live token record is expired.
 * 3. An admin target that cannot be read is user, warned at most once a minute.
 * 4. Admin while the review allows `update` on the admin target; user for a deny or a failure; expired, with the
 *    record ended and one line logged, when the API server refuses the token.
 * 5. Any exception is user, logged by the error's name.
 */
export async function reviewedSessionRole(session: ReviewedSession): Promise<"admin" | "user" | "expired"> {
  if (session.role !== "admin") return "user";
  try {
    const record = liveRecord(session);
    if (record === null) return "expired";
    const target = requestAdminTarget();
    if (target === null) return "user";
    const verdict = await selfReviewVerdict(record, target);
    if (verdict === "expired") return "expired";
    return verdict === "allowed" ? "admin" : "user";
  } catch (error) {
    logUndecided(error);
    return "user";
  }
}
