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
import { endOpenShiftSession, openShiftBearerToken, openShiftSessionKey } from "@/lib/openshift-auth/token-store";
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

/**
 * The self review's verdict for `session`, with the token of its live record read first, or null when the session has
 * no key or no live record. An expired verdict ends the record, logged once per record.
 */
async function selfReviewVerdict(
  session: ReviewedPrincipal,
  attributes: ResourceAttributes,
): Promise<ReviewVerdict | null> {
  const key = openShiftSessionKey(session);
  const token = key === null ? null : openShiftBearerToken(key);
  if (key === null || token === null) return null;
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
      const verdict = await selfReviewVerdict(principal, attributes);
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

/** The sign-in review, or null with a warning naming the setting when it cannot be read. */
function signInAttributes(): ResourceAttributes | null {
  try {
    return accessReviewSignIn();
  } catch (error) {
    logger.warn("Kubernetes access review: the sign-in review cannot be read, so no one can sign in", {
      route: "kubernetes-access",
      problem: (error as Error).message,
    });
    return null;
  }
}

/**
 * The role a verified sign-in gets while the review is on, or null when it may not sign in at all: a subject no
 * review may assert (logged with the reason, never the subject), or one a fresh sign-in review does not allow, a
 * failure or an unreadable setting included. Otherwise admin when a fresh review allows `subject`, in `groups`, to
 * `update` Studio's Deployment, and user for a deny, a failure or a missing Deployment setting.
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
  const attributes = signInAttributes();
  if (attributes === null) return null;
  if (!(await accessReviewAllows({ user: subject, groups }, attributes, { fresh: true }))) return null;
  return accessReviewRole(subject, groups);
}

/**
 * The admin decision: admin when a fresh review allows `subject`, in `groups`, to `update` Studio's Deployment, and
 * user for a deny, a failure or a missing Deployment setting.
 */
async function accessReviewRole(subject: string, groups: readonly string[]): Promise<"admin" | "user"> {
  let target: ResourceAttributes;
  try {
    target = accessReviewAdminTarget();
  } catch (error) {
    logger.warn("Kubernetes access review: no admin role can be decided, so this sign-in is a user", {
      route: "kubernetes-access",
      problem: (error as Error).message,
    });
    return "user";
  }
  const allowed = await accessReviewAllows({ user: subject, groups }, target, { fresh: true });
  return allowed ? "admin" : "user";
}
