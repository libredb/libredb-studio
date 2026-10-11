/**
 * The static kind table of the tree: every built-in kind with its API group, resource, singular, scope, Studio group
 * and label, plus the one Custom Resources kind, whose rows are the resource types discovery lists beyond the
 * built-in groups.
 *
 * Pure, and shipped to the browser through the provider's declarations. Discovery never changes this table: a
 * built-in kind the server does not serve keeps its folder and answers a lock.
 *
 * An object's path segment carries its kind (`deployment/web`), so two kinds' objects never collide in one
 * namespace, and a segment whose prefix is not its folder's kind is refused before any URL is built.
 */
import { QueryError } from "@/lib/db/errors";
import type { KindRowAction, ObjectKindSpec } from "@/lib/db/types";
import { KUBERNETES_TYPE } from "./limits";

/** The pseudo-container of the cluster-scoped kinds. Never a namespace: namespace names hold no upper-case letter. */
export const CLUSTER_CONTAINER = "Cluster";
/** The kind whose rows are custom resource types, under every container. */
export const CUSTOM_RESOURCES_KIND = "customresources";

export type KindScope = "Namespaced" | "Cluster";

interface StudioGroup {
  readonly id: string;
  readonly label: string;
}

const WORKLOADS: StudioGroup = { id: "workloads", label: "Workloads" };
const CONFIG: StudioGroup = { id: "config", label: "Config" };
const NETWORK: StudioGroup = { id: "network", label: "Network" };
const STORAGE: StudioGroup = { id: "storage", label: "Storage" };
const ACCESS_CONTROL: StudioGroup = { id: "access-control", label: "Access Control" };

/** One built-in kind: its id is its plural resource. */
export interface BuiltInKind {
  readonly id: string;
  readonly group: string;
  readonly singular: string;
  readonly scope: KindScope;
  readonly studioGroup?: StudioGroup;
  readonly label: string;
  readonly labelPlural: string;
  /**
   * The kind's Table printer writes more than the name in the Name cell, so a listing reads each row's metadata for
   * it. Measured on k3s v1.35.5 with a Table GET of every listable kind here, the Name cell against `metadata.name`:
   * only a StorageClass's differs, its printer appending ` (default)`.
   */
  readonly decoratedName?: true;
}

function kind(
  id: string,
  group: string,
  singular: string,
  scope: KindScope,
  studioGroup: StudioGroup | undefined,
  label: string,
  labelPlural: string,
  options: { readonly decoratedName?: true } = {},
): BuiltInKind {
  return Object.freeze({
    id,
    group,
    singular,
    scope,
    ...(studioGroup === undefined ? {} : { studioGroup }),
    label,
    labelPlural,
    ...options,
  });
}

export const KUBERNETES_KIND_TABLE: readonly BuiltInKind[] = Object.freeze([
  kind("pods", "", "pod", "Namespaced", WORKLOADS, "Pod", "Pods"),
  kind("deployments", "apps", "deployment", "Namespaced", WORKLOADS, "Deployment", "Deployments"),
  kind("replicasets", "apps", "replicaset", "Namespaced", WORKLOADS, "Replica Set", "Replica Sets"),
  kind("statefulsets", "apps", "statefulset", "Namespaced", WORKLOADS, "Stateful Set", "Stateful Sets"),
  kind("daemonsets", "apps", "daemonset", "Namespaced", WORKLOADS, "Daemon Set", "Daemon Sets"),
  kind("jobs", "batch", "job", "Namespaced", WORKLOADS, "Job", "Jobs"),
  kind("cronjobs", "batch", "cronjob", "Namespaced", WORKLOADS, "Cron Job", "Cron Jobs"),
  kind(
    "replicationcontrollers",
    "",
    "replicationcontroller",
    "Namespaced",
    WORKLOADS,
    "Replication Controller",
    "Replication Controllers",
  ),
  kind("configmaps", "", "configmap", "Namespaced", CONFIG, "Config Map", "Config Maps"),
  kind("secrets", "", "secret", "Namespaced", CONFIG, "Secret", "Secrets"),
  kind("resourcequotas", "", "resourcequota", "Namespaced", CONFIG, "Resource Quota", "Resource Quotas"),
  kind("limitranges", "", "limitrange", "Namespaced", CONFIG, "Limit Range", "Limit Ranges"),
  kind(
    "horizontalpodautoscalers",
    "autoscaling",
    "horizontalpodautoscaler",
    "Namespaced",
    CONFIG,
    "Horizontal Pod Autoscaler",
    "Horizontal Pod Autoscalers",
  ),
  kind(
    "poddisruptionbudgets",
    "policy",
    "poddisruptionbudget",
    "Namespaced",
    CONFIG,
    "Pod Disruption Budget",
    "Pod Disruption Budgets",
  ),
  kind("leases", "coordination.k8s.io", "lease", "Namespaced", CONFIG, "Lease", "Leases"),
  kind("services", "", "service", "Namespaced", NETWORK, "Service", "Services"),
  kind("endpoints", "", "endpoints", "Namespaced", NETWORK, "Endpoints", "Endpoints"),
  kind(
    "endpointslices",
    "discovery.k8s.io",
    "endpointslice",
    "Namespaced",
    NETWORK,
    "Endpoint Slice",
    "Endpoint Slices",
  ),
  kind("ingresses", "networking.k8s.io", "ingress", "Namespaced", NETWORK, "Ingress", "Ingresses"),
  kind(
    "networkpolicies",
    "networking.k8s.io",
    "networkpolicy",
    "Namespaced",
    NETWORK,
    "Network Policy",
    "Network Policies",
  ),
  kind(
    "persistentvolumeclaims",
    "",
    "persistentvolumeclaim",
    "Namespaced",
    STORAGE,
    "Persistent Volume Claim",
    "Persistent Volume Claims",
  ),
  kind("serviceaccounts", "", "serviceaccount", "Namespaced", ACCESS_CONTROL, "Service Account", "Service Accounts"),
  kind("roles", "rbac.authorization.k8s.io", "role", "Namespaced", ACCESS_CONTROL, "Role", "Roles"),
  kind(
    "rolebindings",
    "rbac.authorization.k8s.io",
    "rolebinding",
    "Namespaced",
    ACCESS_CONTROL,
    "Role Binding",
    "Role Bindings",
  ),
  kind("events", "", "event", "Namespaced", undefined, "Event", "Events"),
  kind(
    "priorityclasses",
    "scheduling.k8s.io",
    "priorityclass",
    "Cluster",
    CONFIG,
    "Priority Class",
    "Priority Classes",
  ),
  kind("runtimeclasses", "node.k8s.io", "runtimeclass", "Cluster", CONFIG, "Runtime Class", "Runtime Classes"),
  kind(
    "mutatingwebhookconfigurations",
    "admissionregistration.k8s.io",
    "mutatingwebhookconfiguration",
    "Cluster",
    CONFIG,
    "Mutating Webhook Configuration",
    "Mutating Webhook Configurations",
  ),
  kind(
    "validatingwebhookconfigurations",
    "admissionregistration.k8s.io",
    "validatingwebhookconfiguration",
    "Cluster",
    CONFIG,
    "Validating Webhook Configuration",
    "Validating Webhook Configurations",
  ),
  kind("ingressclasses", "networking.k8s.io", "ingressclass", "Cluster", NETWORK, "Ingress Class", "Ingress Classes"),
  kind("persistentvolumes", "", "persistentvolume", "Cluster", STORAGE, "Persistent Volume", "Persistent Volumes"),
  kind("storageclasses", "storage.k8s.io", "storageclass", "Cluster", STORAGE, "Storage Class", "Storage Classes", {
    decoratedName: true,
  }),
  kind(
    "clusterroles",
    "rbac.authorization.k8s.io",
    "clusterrole",
    "Cluster",
    ACCESS_CONTROL,
    "Cluster Role",
    "Cluster Roles",
  ),
  kind(
    "clusterrolebindings",
    "rbac.authorization.k8s.io",
    "clusterrolebinding",
    "Cluster",
    ACCESS_CONTROL,
    "Cluster Role Binding",
    "Cluster Role Bindings",
  ),
  kind("nodes", "", "node", "Cluster", undefined, "Node", "Nodes"),
  kind("namespaces", "", "namespace", "Cluster", undefined, "Namespace", "Namespaces"),
  kind(
    "customresourcedefinitions",
    "apiextensions.k8s.io",
    "customresourcedefinition",
    "Cluster",
    undefined,
    "Custom Resource Definition",
    "Custom Resource Definitions",
  ),
]);

/**
 * The API groups Kubernetes itself serves. A resource discovery lists in any other group is a custom resource type
 * (a CRD, or an aggregated API such as OpenShift's routes or metrics.k8s.io) and a row of the Custom Resources kind.
 */
export const BUILT_IN_API_GROUPS: ReadonlySet<string> = new Set([
  "",
  "apps",
  "batch",
  "autoscaling",
  "policy",
  "admission.k8s.io",
  "admissionregistration.k8s.io",
  "apiextensions.k8s.io",
  "apiregistration.k8s.io",
  "authentication.k8s.io",
  "authorization.k8s.io",
  "certificates.k8s.io",
  "coordination.k8s.io",
  "discovery.k8s.io",
  "events.k8s.io",
  "flowcontrol.apiserver.k8s.io",
  "imagepolicy.k8s.io",
  "internal.apiserver.k8s.io",
  "networking.k8s.io",
  "node.k8s.io",
  "rbac.authorization.k8s.io",
  "resource.k8s.io",
  "scheduling.k8s.io",
  "storage.k8s.io",
  "storagemigration.k8s.io",
]);

const BY_ID: ReadonlyMap<string, BuiltInKind> = new Map(KUBERNETES_KIND_TABLE.map((entry) => [entry.id, entry]));

export function builtInKind(id: string): BuiltInKind | undefined {
  return BY_ID.get(id);
}

/** The declared kinds: every built-in kind as `config` with a YAML source, then Custom Resources, which has none. */
export const KUBERNETES_OBJECT_KINDS: readonly ObjectKindSpec[] = Object.freeze([
  ...KUBERNETES_KIND_TABLE.map(
    (entry): ObjectKindSpec =>
      Object.freeze({
        id: entry.id,
        role: "config",
        label: entry.label,
        labelPlural: entry.labelPlural,
        hasSource: true,
        sourceLanguage: "yaml",
        // A kind a least-privilege identity may be refused: one 403 answers `unavailable` without a listing.
        countIsListing: true,
        ...(entry.studioGroup === undefined ? {} : { group: entry.studioGroup }),
        // Secret names reach the user, never a machine surface. So do namespace names: the `Cluster` walk lists every
        // namespace, and plan mode is told only how many namespaces it did not read.
        ...(entry.id === "secrets" || entry.id === "namespaces" ? { machineNames: "withheld" as const } : {}),
      }),
  ),
  Object.freeze({
    id: CUSTOM_RESOURCES_KIND,
    role: "config",
    label: "Custom Resource Type",
    labelPlural: "Custom Resources",
    countIsListing: true,
  }),
]);

/** The kinds a container holds: the cluster-scoped ones under `Cluster`, the namespaced ones under a namespace. */
export function kindsForContainerName(container: string): readonly string[] {
  const scope: KindScope = container === CLUSTER_CONTAINER ? "Cluster" : "Namespaced";
  return [
    ...KUBERNETES_KIND_TABLE.filter((entry) => entry.scope === scope).map((entry) => entry.id),
    CUSTOM_RESOURCES_KIND,
  ];
}

/**
 * The declared row actions: Describe on every built-in kind, Logs on pods, List on a custom resource type.
 *
 * Logs `activates`: a click, Enter or Space on a pod row runs it for the last 50 lines, the way a click on a table
 * previews 50 rows, since a pod's recent log is what a reader usually wants from it; its YAML stays on the row menu
 * as View Source. Every other kind keeps its YAML on click.
 */
export const KUBERNETES_ROW_ACTIONS: readonly KindRowAction[] = Object.freeze([
  Object.freeze({
    id: "describe",
    label: "Describe",
    kinds: Object.freeze(KUBERNETES_KIND_TABLE.map((entry) => entry.id)),
  }),
  Object.freeze({ id: "logs", label: "Logs", kinds: Object.freeze(["pods"]), activates: true as const }),
  Object.freeze({ id: "list", label: "List", kinds: Object.freeze([CUSTOM_RESOURCES_KIND]) }),
]);

/** `deployment/web`: the path segment of a built-in object. */
export function objectSegment(entry: BuiltInKind, name: string): string {
  return `${entry.singular}/${name}`;
}

/** The object name a segment carries; refused when its prefix is not the folder's kind. */
export function objectNameOf(entry: BuiltInKind, segment: string): string {
  const prefix = `${entry.singular}/`;
  if (!segment.startsWith(prefix) || segment.length === prefix.length)
    throw new QueryError(
      `A ${entry.label} object is addressed as ${entry.singular}/<name>; this path names another kind, so nothing was sent.`,
      KUBERNETES_TYPE,
    );
  return segment.slice(prefix.length);
}
