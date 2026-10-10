import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { readKubernetesSource } from "@/lib/db/providers/platform/kubernetes/source";
import { fakeCluster, testSurface } from "../../../helpers/kubernetes-cluster";
import { discoveryList } from "../../../helpers/kubernetes-discovery";

const DEPLOYMENT = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "web", namespace: "shop", labels: { app: "web" }, managedFields: [{ manager: "kubectl" }] },
  spec: { replicas: 2 },
};
const SECRET = {
  apiVersion: "v1",
  kind: "Secret",
  metadata: {
    name: "db",
    namespace: "shop",
    annotations: { "kubectl.kubernetes.io/last-applied-configuration": '{"data":{"password":"bWFya2Vy"}}' },
  },
  type: "Opaque",
  data: { password: "bWFya2Vy" },
};

describe("readKubernetesSource", () => {
  test("one GET as JSON, written as YAML without managedFields", async () => {
    const { surface, transport } = testSurface(
      fakeCluster({ objects: { "/apis/apps/v1/namespaces/shop/deployments/web": DEPLOYMENT } }),
    );
    const document = await readKubernetesSource(surface, ["shop", "deployment/web"], "deployments");
    expect(document.path).toEqual(["shop", "deployment/web"]);
    const [part] = document.parts;
    expect(part).toMatchObject({ id: "yaml", label: "YAML", language: "yaml", form: "complete", origin: "rendered" });
    const text = (part as { readonly text: string }).text;
    expect(parse(text)).toEqual({
      ...DEPLOYMENT,
      metadata: { name: "web", namespace: "shop", labels: { app: "web" } },
    });
    expect(transport.calls.at(-1)?.method).toBe("GET /apis/apps/v1/namespaces/shop/deployments/web");
    expect(transport.requests.at(-1)?.headers).toEqual({ accept: "application/json" });
  });

  test("a Secret's view has no value and no last-applied annotation, and is marked partial", async () => {
    const { surface } = testSurface(fakeCluster({ objects: { "/api/v1/namespaces/shop/secrets/db": SECRET } }));
    const document = await readKubernetesSource(surface, ["shop", "secret/db"], "secrets");
    const part = document.parts[0] as { readonly text: string; readonly form: string };
    expect(part.form).toBe("partial");
    expect(part.text).not.toContain("bWFya2Vy");
    expect(part.text).not.toContain("last-applied-configuration");
    expect(parse(part.text)).toEqual({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "db", namespace: "shop", annotations: {} },
      type: "Opaque",
    });
  });

  test("a cluster-scoped object is read with no namespace, and a caller's bound marks the cut", async () => {
    const { surface, transport } = testSurface(
      fakeCluster({
        objects: {
          "/apis/rbac.authorization.k8s.io/v1/clusterroles/system:aggregate-to-view": {
            kind: "ClusterRole",
            rules: [],
          },
        },
      }),
    );
    const document = await readKubernetesSource(
      surface,
      ["Cluster", "clusterrole/system:aggregate-to-view"],
      "clusterroles",
      5,
    );
    expect(transport.calls.at(-1)?.method).toBe(
      "GET /apis/rbac.authorization.k8s.io/v1/clusterroles/system:aggregate-to-view",
    );
    expect(document.parts[0]).toMatchObject({ text: "kind:", truncated: { limit: 5 } });
  });

  test("a kind the server does not serve, a missing object and a wrong prefix answer their sentences", async () => {
    const unserved = testSurface(fakeCluster({ groups: discoveryList([]) }));
    await expect(readKubernetesSource(unserved.surface, ["shop", "deployment/web"], "deployments")).rejects.toThrow(
      "This server does not serve Deployments",
    );
    const missing = testSurface(fakeCluster());
    await expect(readKubernetesSource(missing.surface, ["shop", "pod/gone"], "pods")).rejects.toThrow(
      "pod/gone was not found in the namespace shop (404 Not Found).",
    );
    const clusterMissing = testSurface(fakeCluster());
    await expect(readKubernetesSource(clusterMissing.surface, ["Cluster", "node/gone"], "nodes")).rejects.toThrow(
      "node/gone was not found in the cluster (404 Not Found).",
    );
    const refused = testSurface(fakeCluster({ forbidden: ["/api/v1/namespaces/shop/secrets/db"] }));
    await expect(readKubernetesSource(refused.surface, ["shop", "secret/db"], "secrets")).rejects.toThrow(
      "(403 Forbidden)",
    );
    await expect(readKubernetesSource(missing.surface, ["shop", "pod/web"], "deployments")).rejects.toThrow(
      "addressed as deployment/<name>",
    );
  });
});
