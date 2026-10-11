import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { activationRowActionForKind } from "@/lib/db/object-kinds";
import type { ProviderCapabilities } from "@/lib/db/types";
import {
  type BuiltInKind,
  BUILT_IN_API_GROUPS,
  builtInKind,
  CLUSTER_CONTAINER,
  CUSTOM_RESOURCES_KIND,
  KUBERNETES_KIND_TABLE,
  KUBERNETES_OBJECT_KINDS,
  KUBERNETES_ROW_ACTIONS,
  kindsForContainerName,
  objectNameOf,
  objectSegment,
} from "@/lib/db/providers/platform/kubernetes/kinds";
import { parseDiscovery } from "@/lib/db/providers/platform/kubernetes/discovery";
import { CORE_DISCOVERY, GROUPS_DISCOVERY } from "../../../helpers/kubernetes-discovery";

/** The tree's kind table, by Studio group, under a namespace and under Cluster. */
const NAMESPACED: Record<string, readonly string[]> = {
  workloads: [
    "pods",
    "deployments",
    "replicasets",
    "statefulsets",
    "daemonsets",
    "jobs",
    "cronjobs",
    "replicationcontrollers",
  ],
  config: [
    "configmaps",
    "secrets",
    "resourcequotas",
    "limitranges",
    "horizontalpodautoscalers",
    "poddisruptionbudgets",
    "leases",
  ],
  network: ["services", "endpoints", "endpointslices", "ingresses", "networkpolicies"],
  storage: ["persistentvolumeclaims"],
  "access-control": ["serviceaccounts", "roles", "rolebindings"],
  none: ["events"],
};
const CLUSTER: Record<string, readonly string[]> = {
  config: ["priorityclasses", "runtimeclasses", "mutatingwebhookconfigurations", "validatingwebhookconfigurations"],
  network: ["ingressclasses"],
  storage: ["persistentvolumes", "storageclasses"],
  "access-control": ["clusterroles", "clusterrolebindings"],
  none: ["nodes", "namespaces", "customresourcedefinitions"],
};

function byGroup(scope: "Namespaced" | "Cluster"): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const entry of KUBERNETES_KIND_TABLE.filter((candidate) => candidate.scope === scope)) {
    const key = entry.studioGroup?.id ?? "none";
    grouped[key] = [...(grouped[key] ?? []), entry.id];
  }
  return grouped;
}

describe("the kind table", () => {
  test("holds exactly the tree's kinds, in its Studio groups, under each scope", () => {
    expect(byGroup("Namespaced")).toEqual(NAMESPACED as Record<string, string[]>);
    expect(byGroup("Cluster")).toEqual(CLUSTER as Record<string, string[]>);
  });

  test("every built-in kind is served by the group and singular discovery lists for it", () => {
    const index = parseDiscovery(CORE_DISCOVERY, GROUPS_DISCOVERY);
    for (const entry of KUBERNETES_KIND_TABLE) {
      const served = index.resources.find(
        (candidate) => candidate.group === entry.group && candidate.resource === entry.id,
      );
      expect([entry.id, served?.singular, served?.namespaced]).toEqual([
        entry.id,
        entry.singular,
        entry.scope === "Namespaced",
      ]);
      expect(BUILT_IN_API_GROUPS.has(entry.group)).toBe(true);
    }
  });

  test("every kind is config with a YAML source and countIsListing, Custom Resources without a source", () => {
    for (const spec of KUBERNETES_OBJECT_KINDS.filter((candidate) => candidate.id !== CUSTOM_RESOURCES_KIND)) {
      expect([spec.role, spec.hasSource, spec.sourceLanguage, spec.countIsListing, spec.hasColumns]).toEqual([
        "config",
        true,
        "yaml",
        true,
        undefined,
      ]);
    }
    expect(KUBERNETES_OBJECT_KINDS.at(-1)).toEqual({
      id: "customresources",
      role: "config",
      label: "Custom Resource Type",
      labelPlural: "Custom Resources",
      countIsListing: true,
    });
  });

  test("only Namespaces and Secrets withhold their names from machine surfaces", () => {
    expect(KUBERNETES_OBJECT_KINDS.filter((spec) => spec.machineNames === "withheld").map((spec) => spec.id)).toEqual([
      "secrets",
      "namespaces",
    ]);
  });

  test("the Studio groups travel on the declarations; the ungrouped kinds carry none", () => {
    expect(KUBERNETES_OBJECT_KINDS.find((spec) => spec.id === "pods")?.group).toEqual({
      id: "workloads",
      label: "Workloads",
    });
    expect(KUBERNETES_OBJECT_KINDS.find((spec) => spec.id === "nodes")?.group).toBeUndefined();
    expect(builtInKind("deployments")?.labelPlural).toBe("Deployments");
    expect(builtInKind(CUSTOM_RESOURCES_KIND)).toBeUndefined();
  });
});

describe("containers and kinds", () => {
  test("Cluster holds the cluster-scoped kinds, a namespace the namespaced ones, both Custom Resources", () => {
    const cluster = kindsForContainerName(CLUSTER_CONTAINER);
    const namespace = kindsForContainerName("shop");
    expect(cluster).toContain("nodes");
    expect(cluster).not.toContain("pods");
    expect(namespace).toContain("pods");
    expect(namespace).not.toContain("nodes");
    expect(cluster.at(-1)).toBe(CUSTOM_RESOURCES_KIND);
    expect(namespace.at(-1)).toBe(CUSTOM_RESOURCES_KIND);
    expect(cluster.length + namespace.length).toBe(KUBERNETES_KIND_TABLE.length + 2);
  });

  test("storageclasses is the one built-in kind whose Table printer decorates the Name cell", () => {
    // Measured on k3s v1.35.5: a Table GET with includeObject=Metadata of every listable built-in kind, the Name cell
    // against metadata.name; only a StorageClass's differs ("local-path (default)").
    expect(KUBERNETES_KIND_TABLE.filter((entry) => entry.decoratedName === true).map((entry) => entry.id)).toEqual([
      "storageclasses",
    ]);
  });

  test("a namespace named cluster is a namespace", () => {
    expect(kindsForContainerName("cluster")).toContain("pods");
  });
});

describe("row actions", () => {
  test("Describe on every built-in kind, Logs on pods, List on custom resource types", () => {
    expect(KUBERNETES_ROW_ACTIONS.map((action) => [action.id, action.label])).toEqual([
      ["describe", "Describe"],
      ["logs", "Logs"],
      ["list", "List"],
    ]);
    expect(KUBERNETES_ROW_ACTIONS[0].kinds).toEqual(KUBERNETES_KIND_TABLE.map((entry) => entry.id));
    expect(KUBERNETES_ROW_ACTIONS[1].kinds).toEqual(["pods"]);
    expect(KUBERNETES_ROW_ACTIONS[2].kinds).toEqual(["customresources"]);
  });

  test("exactly one action activates a row, Logs, and only on pods", () => {
    const activating = KUBERNETES_ROW_ACTIONS.filter((action) => action.activates === true);
    expect(activating.map((action) => [action.id, action.kinds])).toEqual([["logs", ["pods"]]]);
    const capabilities = { rowActions: KUBERNETES_ROW_ACTIONS } as unknown as ProviderCapabilities;
    expect(activationRowActionForKind(capabilities, "pods")?.id).toBe("logs");
    for (const kind of ["deployments", "nodes", CUSTOM_RESOURCES_KIND])
      expect(activationRowActionForKind(capabilities, kind)).toBeUndefined();
  });
});

describe("object segments", () => {
  const deployments = builtInKind("deployments") as BuiltInKind;
  test("carry the singular kind, and give the name back", () => {
    expect(objectSegment(deployments, "web")).toBe("deployment/web");
    expect(objectNameOf(deployments, "deployment/web")).toBe("web");
  });
  test("a prefix of another kind, a bare name and an empty name are refused before any URL", () => {
    for (const segment of ["pod/web", "web", "deployment/"]) {
      expect(() => objectNameOf(deployments, segment)).toThrow(QueryError);
    }
    expect(() => objectNameOf(deployments, "pod/web")).toThrow(
      "A Deployment object is addressed as deployment/<name>; this path names another kind, so nothing was sent.",
    );
  });
});
