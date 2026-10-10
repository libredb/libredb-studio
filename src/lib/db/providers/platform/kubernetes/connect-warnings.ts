/**
 * The warnings `connect()` computes for Test Connection: the credential warning, from six SelfSubjectAccessReviews of
 * rights a read-only browser never needs, the namespace notice, and the count of discovery entries left out.
 *
 * Each review names its right by `resourceAttributes`, never by a `pods/exec` string as the resource or a name, which
 * the server would read as a resource of that name. The Secret list is asked twice, in the session namespace and at
 * cluster scope, because a namespaced grant and a cluster grant are different rights.
 */
import type { QueryWarning } from "@/lib/types";
import type { ResourceIndex } from "./discovery";
import { KubernetesRequestError } from "./errors";
import { type KubernetesSurface, listNamespaces } from "./objects";

/** The notice for a cluster with more namespaces than the tree lists. */
export const NAMESPACE_CAP_NOTICE =
  "This cluster lists more than 1,000 namespaces, so the tree shows the first 1,000; list the ones to show in the connection's Namespaces field.";

/** One right the credential warning asks about, and how a sentence names it when it is held. */
interface CheckedRight {
  readonly attributes: (namespace: string) => Readonly<Record<string, string>>;
  readonly words: (namespace: string) => string;
}

export const CHECKED_RIGHTS: readonly CheckedRight[] = Object.freeze([
  {
    attributes: (namespace: string) => ({ verb: "create", resource: "pods", subresource: "exec", namespace }),
    words: (namespace: string) => `run commands in pods (create pods/exec in the namespace ${namespace})`,
  },
  {
    attributes: (namespace: string) => ({ verb: "get", resource: "pods", subresource: "exec", namespace }),
    words: (namespace: string) =>
      `open exec sessions on clusters before 1.35 (get pods/exec in the namespace ${namespace})`,
  },
  {
    attributes: () => ({ verb: "get", resource: "nodes", subresource: "proxy" }),
    words: () => "reach every node's kubelet API (get nodes/proxy)",
  },
  {
    attributes: () => ({ verb: "*", group: "*", resource: "*" }),
    words: () => "do anything to every resource (* on *)",
  },
  {
    attributes: (namespace: string) => ({ verb: "list", resource: "secrets", namespace }),
    words: (namespace: string) => `read every Secret value in the namespace ${namespace} (list secrets)`,
  },
  {
    attributes: () => ({ verb: "list", resource: "secrets" }),
    words: () => "read every Secret value in the cluster (list secrets)",
  },
]);

/** The request body of one review. */
export function accessReviewBody(attributes: Readonly<Record<string, string>>): Readonly<Record<string, unknown>> {
  return {
    apiVersion: "authorization.k8s.io/v1",
    kind: "SelfSubjectAccessReview",
    spec: { resourceAttributes: attributes },
  };
}

function allowed(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const status = (body as { readonly status?: unknown }).status;
  return typeof status === "object" && status !== null && (status as { readonly allowed?: unknown }).allowed === true;
}

/** The credential warning, or none when the identity holds none of the six rights. */
async function credentialWarning(surface: KubernetesSurface): Promise<QueryWarning[]> {
  const namespace = surface.endpoint.defaultNamespace;
  let answers: unknown[];
  try {
    answers = await Promise.all(
      CHECKED_RIGHTS.map((right) =>
        surface.client.json(
          { op: "review", review: "selfsubjectaccessreviews", body: accessReviewBody(right.attributes(namespace)) },
          surface.call(),
        ),
      ),
    );
  } catch (error) {
    if (!(error instanceof KubernetesRequestError)) throw error;
    return [{ message: `Studio could not check which rights this identity holds: ${error.message}` }];
  }
  const held = CHECKED_RIGHTS.filter((_right, index) => allowed(answers[index])).map((right) => right.words(namespace));
  if (held.length === 0) return [];
  return [
    {
      message: `This connection's identity may ${held.join("; ")}. Studio stays read-only and never uses these rights, but a token bound to view or studio-reader is safer.`,
    },
  ];
}

/** Every warning `connect()` hands to Test Connection, in this order: credential, namespace, discovery. */
export async function kubernetesConnectWarnings(
  surface: KubernetesSurface,
  index: ResourceIndex,
): Promise<QueryWarning[]> {
  const [credential, namespaces] = await Promise.all([credentialWarning(surface), listNamespaces(surface)]);
  const warnings = [...credential];
  if (namespaces.forbidden)
    warnings.push({
      message: `This identity may not list namespaces, so the tree shows the Default namespace (${surface.endpoint.defaultNamespace}) alone; list the others in the connection's Namespaces field.`,
    });
  if (namespaces.capped === true) warnings.push({ message: NAMESPACE_CAP_NOTICE });
  if (index.dropped > 0)
    warnings.push({
      message: `Discovery listed ${index.dropped} ${index.dropped === 1 ? "entry" : "entries"} Studio could not read as a resource type; ${index.dropped === 1 ? "it is" : "they are"} left out of the console and the Custom Resources folder.`,
    });
  return warnings;
}
