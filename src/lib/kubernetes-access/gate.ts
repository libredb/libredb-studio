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
 * Admin: while the review is on, a Studio admin is a person the review allows to `update` Studio's own Deployment,
 * decided once at sign-in. Whoever may update that Deployment can already change Studio's environment, image and
 * mounts, and so read every credential Studio holds, so the rule grants nothing the pod spec does not.
 */
import { logger } from "@/lib/logger";
import type { ManagedConnection } from "@/lib/seed/types";
import { accessReviewAdminDeployment, accessReviewEnabled } from "./config";
import { accessReviewAllows } from "./decisions";
import { recordedGroups } from "./groups";

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

/**
 * The role a verified sign-in gets while the review is on: admin when a fresh review allows `subject`, in `groups`,
 * to `update` Studio's Deployment, and user for a deny, a failure or a missing Deployment setting.
 */
export async function accessReviewRole(subject: string, groups: readonly string[]): Promise<"admin" | "user"> {
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
