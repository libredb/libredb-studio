import { describe, expect, test } from "bun:test";
import { parseDiscovery } from "@/lib/db/providers/platform/kubernetes/discovery";
import { type Resolution, resolveResource } from "@/lib/db/providers/platform/kubernetes/resolve";
import { CORE_DISCOVERY, discoveryList, GROUPS_DISCOVERY, resource } from "../../../helpers/kubernetes-discovery";

const INDEX = parseDiscovery(CORE_DISCOVERY, GROUPS_DISCOVERY);

function named(resolution: Resolution): string {
  if (resolution.kind === "resource")
    return `${resolution.resource.group}/${resolution.resource.version}/${resolution.resource.resource}`;
  if (resolution.kind === "category")
    return `category:${resolution.resources.map((entry) => entry.resource).join(",")}`;
  return "unknown";
}

describe("resolveResource, as kubectl resolves", () => {
  test.each([
    ["pods", "/v1/pods"],
    ["pod", "/v1/pods"],
    ["Pod", "/v1/pods"],
    ["PODS", "/v1/pods"],
    ["po", "/v1/pods"],
    ["pod.v1.", "/v1/pods"],
    ["deploy", "apps/v1/deployments"],
    ["deploy.apps", "apps/v1/deployments"],
    ["Deployment.apps", "apps/v1/deployments"],
    ["statefulset.v1.apps", "apps/v1/statefulsets"],
    ["deployments.v1.apps", "apps/v1/deployments"],
    ["wd", "probe.libredb.dev/v1/widgets"],
    ["Widget", "probe.libredb.dev/v1/widgets"],
    ["WIDGETS", "probe.libredb.dev/v1/widgets"],
    ["widgets.probe.libredb.dev", "probe.libredb.dev/v1/widgets"],
    ["hpa", "autoscaling/v2/horizontalpodautoscalers"],
    ["ep", "/v1/endpoints"],
    ["endpoints", "/v1/endpoints"],
  ])("%s resolves to %s", (text, expected) => {
    expect(named(resolveResource(INDEX, text))).toBe(expected);
  });

  test.each(["PO", "Deploy", "WD", "ALL", "podz", "", "pods.apps", "deploy.v2.apps"])("%s does not resolve", (text) => {
    expect(resolveResource(INDEX, text)).toEqual({ kind: "unknown" });
  });

  test("a core resource wins over a group's resource of the same plural, by discovery order", () => {
    expect(named(resolveResource(INDEX, "pods"))).toBe("/v1/pods");
    expect(named(resolveResource(INDEX, "pods.metrics.k8s.io"))).toBe("metrics.k8s.io/v1beta1/pods");
  });

  test("an exact plural beats a short name", () => {
    const groups = discoveryList([
      {
        name: "x.example",
        versions: [{ version: "v1", resources: [resource("sa", "Sa", "Namespaced", { singular: "sa" })] }],
      },
    ]);
    const index = parseDiscovery(CORE_DISCOVERY, groups);
    expect(named(resolveResource(index, "sa"))).toBe("x.example/v1/sa");
    expect(named(resolveResource(INDEX, "sa"))).toBe("/v1/serviceaccounts");
  });

  test("a category, compared with case, answers every resource that declares it", () => {
    expect(named(resolveResource(INDEX, "all"))).toBe(
      "category:pods,services,replicationcontrollers,deployments,replicasets,statefulsets,daemonsets,jobs,cronjobs,widgets",
    );
  });
});
