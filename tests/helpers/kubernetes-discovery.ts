/**
 * Synthesized aggregated discovery documents (`apidiscovery.k8s.io/v2`) for the Kubernetes tests: the core group and
 * the groups every built-in kind of the tree needs, plus one custom resource type, `widgets.probe.libredb.dev`, with
 * the short name `wd`. Shaped as a 1.35 server answers, trimmed to the fields the provider reads.
 */
type Scope = "Namespaced" | "Cluster";

export interface DiscoveryResource {
  readonly resource: string;
  readonly kind: string;
  readonly scope: Scope;
  readonly singular?: string;
  readonly shortNames?: readonly string[];
  readonly categories?: readonly string[];
  readonly verbs?: readonly string[];
}

const READ = ["get", "list", "watch"];

export function resource(
  resource: string,
  kind: string,
  scope: Scope,
  extra: Omit<DiscoveryResource, "resource" | "kind" | "scope"> = {},
): Record<string, unknown> {
  return {
    resource,
    responseKind: { group: "", version: "", kind },
    scope,
    singularResource: extra.singular ?? kind.toLowerCase(),
    verbs: extra.verbs ?? READ,
    ...(extra.shortNames === undefined ? {} : { shortNames: extra.shortNames }),
    ...(extra.categories === undefined ? {} : { categories: extra.categories }),
  };
}

export function discoveryList(
  groups: readonly {
    readonly name?: string;
    readonly versions: readonly {
      readonly version: string;
      readonly freshness?: string;
      readonly resources: readonly unknown[];
    }[];
  }[],
  apiVersion = "apidiscovery.k8s.io/v2",
): Record<string, unknown> {
  return {
    kind: "APIGroupDiscoveryList",
    apiVersion,
    metadata: {},
    items: groups.map((group) => ({
      metadata: group.name === undefined ? {} : { name: group.name },
      versions: group.versions.map((version) => ({
        version: version.version,
        resources: version.resources,
        freshness: version.freshness ?? "Current",
      })),
    })),
  };
}

export const CORE_DISCOVERY = discoveryList([
  {
    versions: [
      {
        version: "v1",
        resources: [
          resource("pods", "Pod", "Namespaced", { shortNames: ["po"], categories: ["all"] }),
          resource("services", "Service", "Namespaced", { shortNames: ["svc"], categories: ["all"] }),
          resource("configmaps", "ConfigMap", "Namespaced", { shortNames: ["cm"] }),
          resource("secrets", "Secret", "Namespaced"),
          resource("events", "Event", "Namespaced", { shortNames: ["ev"] }),
          resource("endpoints", "Endpoints", "Namespaced", { singular: "endpoints", shortNames: ["ep"] }),
          resource("persistentvolumeclaims", "PersistentVolumeClaim", "Namespaced", { shortNames: ["pvc"] }),
          resource("serviceaccounts", "ServiceAccount", "Namespaced", { shortNames: ["sa"] }),
          resource("resourcequotas", "ResourceQuota", "Namespaced", { shortNames: ["quota"] }),
          resource("limitranges", "LimitRange", "Namespaced", { shortNames: ["limits"] }),
          resource("replicationcontrollers", "ReplicationController", "Namespaced", {
            shortNames: ["rc"],
            categories: ["all"],
          }),
          resource("podtemplates", "PodTemplate", "Namespaced"),
          resource("nodes", "Node", "Cluster", { shortNames: ["no"] }),
          resource("namespaces", "Namespace", "Cluster", { shortNames: ["ns"] }),
          resource("persistentvolumes", "PersistentVolume", "Cluster", { shortNames: ["pv"] }),
        ],
      },
    ],
  },
]);

export const GROUPS_DISCOVERY = discoveryList([
  {
    name: "apps",
    versions: [
      {
        version: "v1",
        resources: [
          resource("deployments", "Deployment", "Namespaced", { shortNames: ["deploy"], categories: ["all"] }),
          resource("replicasets", "ReplicaSet", "Namespaced", { shortNames: ["rs"], categories: ["all"] }),
          resource("statefulsets", "StatefulSet", "Namespaced", { shortNames: ["sts"], categories: ["all"] }),
          resource("daemonsets", "DaemonSet", "Namespaced", { shortNames: ["ds"], categories: ["all"] }),
          resource("controllerrevisions", "ControllerRevision", "Namespaced"),
        ],
      },
    ],
  },
  {
    name: "batch",
    versions: [
      {
        version: "v1",
        resources: [
          resource("jobs", "Job", "Namespaced", { categories: ["all"] }),
          resource("cronjobs", "CronJob", "Namespaced", { shortNames: ["cj"], categories: ["all"] }),
        ],
      },
    ],
  },
  {
    name: "autoscaling",
    versions: [
      {
        version: "v2",
        resources: [
          resource("horizontalpodautoscalers", "HorizontalPodAutoscaler", "Namespaced", { shortNames: ["hpa"] }),
        ],
      },
      {
        version: "v1",
        resources: [
          resource("horizontalpodautoscalers", "HorizontalPodAutoscaler", "Namespaced", { shortNames: ["hpa"] }),
        ],
      },
    ],
  },
  {
    name: "policy",
    versions: [
      {
        version: "v1",
        resources: [resource("poddisruptionbudgets", "PodDisruptionBudget", "Namespaced", { shortNames: ["pdb"] })],
      },
    ],
  },
  {
    name: "coordination.k8s.io",
    versions: [{ version: "v1", resources: [resource("leases", "Lease", "Namespaced")] }],
  },
  {
    name: "discovery.k8s.io",
    versions: [{ version: "v1", resources: [resource("endpointslices", "EndpointSlice", "Namespaced")] }],
  },
  {
    name: "networking.k8s.io",
    versions: [
      {
        version: "v1",
        resources: [
          resource("ingresses", "Ingress", "Namespaced", { shortNames: ["ing"] }),
          resource("networkpolicies", "NetworkPolicy", "Namespaced", { shortNames: ["netpol"] }),
          resource("ingressclasses", "IngressClass", "Cluster"),
        ],
      },
    ],
  },
  {
    name: "rbac.authorization.k8s.io",
    versions: [
      {
        version: "v1",
        resources: [
          resource("roles", "Role", "Namespaced"),
          resource("rolebindings", "RoleBinding", "Namespaced"),
          resource("clusterroles", "ClusterRole", "Cluster", { verbs: ["get", "list"] }),
          resource("clusterrolebindings", "ClusterRoleBinding", "Cluster"),
        ],
      },
    ],
  },
  {
    name: "storage.k8s.io",
    versions: [
      { version: "v1", resources: [resource("storageclasses", "StorageClass", "Cluster", { shortNames: ["sc"] })] },
    ],
  },
  {
    name: "scheduling.k8s.io",
    versions: [
      { version: "v1", resources: [resource("priorityclasses", "PriorityClass", "Cluster", { shortNames: ["pc"] })] },
    ],
  },
  {
    name: "node.k8s.io",
    versions: [{ version: "v1", resources: [resource("runtimeclasses", "RuntimeClass", "Cluster")] }],
  },
  {
    name: "admissionregistration.k8s.io",
    versions: [
      {
        version: "v1",
        resources: [
          resource("mutatingwebhookconfigurations", "MutatingWebhookConfiguration", "Cluster"),
          resource("validatingwebhookconfigurations", "ValidatingWebhookConfiguration", "Cluster"),
        ],
      },
    ],
  },
  {
    name: "apiextensions.k8s.io",
    versions: [
      {
        version: "v1",
        resources: [
          resource("customresourcedefinitions", "CustomResourceDefinition", "Cluster", { shortNames: ["crd", "crds"] }),
        ],
      },
    ],
  },
  {
    name: "probe.libredb.dev",
    versions: [
      {
        version: "v1",
        resources: [resource("widgets", "Widget", "Namespaced", { shortNames: ["wd"], categories: ["all"] })],
      },
    ],
  },
  {
    name: "authentication.k8s.io",
    versions: [
      {
        version: "v1",
        resources: [
          resource("selfsubjectreviews", "SelfSubjectReview", "Cluster", { verbs: ["create"] }),
          resource("tokenreviews", "TokenReview", "Cluster", { verbs: ["create"] }),
        ],
      },
    ],
  },
  {
    name: "metrics.k8s.io",
    versions: [
      {
        version: "v1beta1",
        resources: [
          resource("pods", "PodMetrics", "Namespaced", { verbs: ["get", "list"] }),
          resource("nodes", "NodeMetrics", "Cluster", { verbs: ["get", "list"] }),
        ],
      },
    ],
  },
]);
