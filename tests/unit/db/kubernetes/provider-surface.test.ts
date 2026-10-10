/**
 * The shared object-surface conformance for the Kubernetes provider, against a fake API server that holds one object
 * of every namespaced built-in kind in the namespace `shop`. It runs the per-container invariant: `countObjects`
 * answers every kind applicable to the container and no other.
 */
import { describe, test } from "bun:test";
import { KubernetesProvider } from "@/lib/db/providers/platform/kubernetes/index";
import { KUBERNETES_KIND_TABLE } from "@/lib/db/providers/platform/kubernetes/kinds";
import { assertObjectSurface } from "../../../helpers/object-surface-conformance";
import { fakeCluster, type FakeRow } from "../../../helpers/kubernetes-cluster";
import { kubernetesConnection } from "../../../helpers/kubernetes-connection";
import { recordingKubernetesTransport, testSeams } from "../../../helpers/kubernetes-transport";

const NAMESPACED = KUBERNETES_KIND_TABLE.filter((entry) => entry.scope === "Namespaced");

/** The collection path of a namespaced kind in `shop`. */
function collection(group: string, id: string): string {
  const version = group === "autoscaling" ? "v2" : "v1";
  return group === "" ? `/api/v1/namespaces/shop/${id}` : `/apis/${group}/${version}/namespaces/shop/${id}`;
}

const lists: Record<string, readonly FakeRow[]> = { "/api/v1/namespaces": [{ name: "default" }, { name: "shop" }] };
const objects: Record<string, unknown> = {};
for (const entry of NAMESPACED) {
  const name = entry.id === "pods" ? "web-1" : `${entry.singular}-1`;
  lists[collection(entry.group, entry.id)] = [
    { name, ...(entry.id === "pods" ? { ready: "1/1", status: "Running" } : {}) },
  ];
  objects[`${collection(entry.group, entry.id)}/${name}`] = {
    kind: entry.label.replaceAll(" ", ""),
    metadata: { name, namespace: "shop" },
  };
}

describe("the Kubernetes object surface", () => {
  test("conforms in the namespace shop", async () => {
    const transport = recordingKubernetesTransport(fakeCluster({ lists, objects }));
    const provider = new KubernetesProvider(
      kubernetesConnection({ database: "shop" }),
      { queryTimeout: 30_000 },
      testSeams(transport),
    );
    await provider.connect();
    await assertObjectSurface(provider, {
      containers: [["Cluster"], ["default"], ["shop"]],
      container: ["shop"],
      kinds: { ...Object.fromEntries(NAMESPACED.map((entry) => [entry.id, 1])), customresources: 2 },
      sampleObject: { path: ["shop", "pod/web-1"], kind: "pods" },
      absentSource: { path: ["shop", "pod/does-not-exist"], kind: "pods" },
      noColumnKinds: true,
    });
  });
});
