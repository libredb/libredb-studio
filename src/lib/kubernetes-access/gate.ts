/**
 * The two decisions the Kubernetes access review makes (docs/SEED_CONNECTIONS.md, "Kubernetes access review").
 *
 * Connections: a connection that names the Kubernetes Secret its credentials come from (`kubernetesSecret`, set in
 * code by a Kubernetes discovery source, never read from a file) is listed and opened only for a session the review
 * allows to `get` that Secret. Its roles are `*`, so the review is its only gate, for admins and users alike. The
 * review's `user` is the signed session's identity provider subject and its `groups` the groups store's record of that
 * subject (groups.ts); a session without a subject, an issuer or a record is denied without a request. With the review
 * off no review can run, so such a connection is shown to the admin role only, the rule platform discovery uses. A
 * connection without `kubernetesSecret` is untouched either way.
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
import type { ManagedConnection } from "@/lib/seed/types";
import { accessReviewAdminDeployment, accessReviewEnabled, accessReviewSignIn } from "./config";
import { accessReviewAllows } from "./decisions";
import { recordedGroups, reviewSubjectProblem } from "./groups";
import type { ResourceAttributes } from "./review";

/** Who asks: the signed session's role, and the identity provider subject and issuer an OIDC sign-in gave it. */
export interface ReviewedPrincipal {
  readonly role: string;
  readonly idpSubject?: string;
  readonly idpIssuer?: string;
}

/** Whether `principal` may list and open `connection`. */
async function mayUse(principal: ReviewedPrincipal, connection: ManagedConnection): Promise<boolean> {
  const secret = connection.kubernetesSecret;
  if (secret === undefined) return true;
  if (!accessReviewEnabled()) return principal.role === "admin";
  const groups = recordedGroups(principal.idpIssuer, principal.idpSubject);
  if (groups === null) return false;
  return accessReviewAllows(
    { user: principal.idpSubject as string, groups },
    { verb: "get", group: "", resource: "secrets", namespace: secret.namespace, name: secret.name },
  );
}

/** The connections `principal` may use, in their order; the reviews of one list run together. */
export async function connectionsUnderAccessReview(
  principal: ReviewedPrincipal,
  connections: ManagedConnection[],
): Promise<ManagedConnection[]> {
  const verdicts = await Promise.all(connections.map((connection) => mayUse(principal, connection)));
  return connections.filter((_, index) => verdicts[index]);
}

/** The connection, when `principal` may use it; null otherwise, as for a connection that does not exist. */
export async function connectionUnderAccessReview(
  principal: ReviewedPrincipal,
  connection: ManagedConnection | null,
): Promise<ManagedConnection | null> {
  return connection !== null && (await mayUse(principal, connection)) ? connection : null;
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
  let deployment: ReturnType<typeof accessReviewAdminDeployment>;
  try {
    deployment = accessReviewAdminDeployment();
  } catch (error) {
    logger.warn("Kubernetes access review: no admin role can be decided, so this sign-in is a user", {
      route: "kubernetes-access",
      problem: (error as Error).message,
    });
    return "user";
  }
  const allowed = await accessReviewAllows(
    { user: subject, groups },
    { verb: "update", group: "apps", resource: "deployments", namespace: deployment.namespace, name: deployment.name },
    { fresh: true },
  );
  return allowed ? "admin" : "user";
}
