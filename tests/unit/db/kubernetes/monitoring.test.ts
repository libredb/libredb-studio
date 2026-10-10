import { describe, expect, test } from "bun:test";
import { KUBERNETES_LABELS } from "@/lib/db/providers/platform/kubernetes/labels";
import { kubernetesHealth, kubernetesOverview } from "@/lib/db/providers/platform/kubernetes/monitoring";
import { fakeCluster, manyRows, testSurface } from "../../../helpers/kubernetes-cluster";
import { discoveryList, resource } from "../../../helpers/kubernetes-discovery";

describe("kubernetesHealth", () => {
  test("reads /readyz then /version and reports no figure it cannot measure", async () => {
    const { surface, transport } = testSurface(fakeCluster());
    expect(await kubernetesHealth(surface)).toEqual({
      databaseSize: "N/A",
      cacheHitRatio: "N/A",
      slowQueries: [],
      activeSessions: [],
    });
    expect(transport.calls.map((entry) => entry.method)).toEqual(["GET /readyz", "GET /version"]);
  });

  test("a failing /readyz fails health with its sentence", async () => {
    const { surface } = testSurface(fakeCluster({ readyzStatus: 503 }));
    await expect(kubernetesHealth(surface)).rejects.toThrow(
      "The API server failed to get readyz in the cluster (HTTP 503).",
    );
  });

  test("a namespace-bound identity reads health: /readyz and /version are public", async () => {
    const { surface } = testSurface(fakeCluster({ forbidden: ["/api/v1/namespaces", "/api/v1/nodes"] }), {
      database: "shop",
    });
    await expect(kubernetesHealth(surface)).resolves.toBeDefined();
  });
});

describe("kubernetesOverview", () => {
  test("the version, the namespace count and the node count", async () => {
    const { surface } = testSurface(
      fakeCluster({ lists: { "/api/v1/namespaces": manyRows("ns", 3), "/api/v1/nodes": manyRows("node", 2) } }),
    );
    expect(await kubernetesOverview(surface)).toEqual({
      version: "v1.35.5+k3s1",
      uptime: "N/A",
      maxConnections: 0,
      databaseSize: "2 nodes",
      tableCount: 3,
      indexCount: 0,
    });
  });

  test("past 1,000 nodes the count is a floor, read from the capped walk", async () => {
    const { surface } = testSurface(
      fakeCluster({ lists: { "/api/v1/namespaces": [], "/api/v1/nodes": manyRows("node", 1_001) } }),
    );
    expect((await kubernetesOverview(surface)).databaseSize).toBe("1,000 or more nodes");
  });

  test("past 1,000 namespaces the count is a floor, read one row past the cap", async () => {
    const { surface } = testSurface(
      fakeCluster({ lists: { "/api/v1/namespaces": manyRows("ns", 1_001), "/api/v1/nodes": [] } }),
    );
    expect(await kubernetesOverview(surface)).toMatchObject({
      tableCount: 1_000,
      tableCountSampledFrom: "the first 1,000 namespaces the API listed",
    });
  });

  test("an identity that may list neither namespaces nor nodes gets the Default namespace and a sentence", async () => {
    const { surface } = testSurface(fakeCluster({ forbidden: ["/api/v1/namespaces", "/api/v1/nodes"] }), {
      database: "shop",
    });
    expect(await kubernetesOverview(surface)).toMatchObject({
      databaseSize: "nodes not readable by this identity",
      tableCount: 1,
      tableCountSampledFrom: "the Default namespace alone, because this identity may not list namespaces",
    });
  });

  test("nodes the server does not serve, a version without gitVersion, and an error other than 403", async () => {
    const core = discoveryList([
      { versions: [{ version: "v1", resources: [resource("namespaces", "Namespace", "Cluster")] }] },
    ]);
    const { surface } = testSurface(fakeCluster({ core, version: {}, lists: { "/api/v1/namespaces": [] } }));
    expect(await kubernetesOverview(surface)).toMatchObject({
      version: "N/A",
      databaseSize: "nodes not served",
      tableCount: 0,
    });
    const odd = testSurface(
      fakeCluster({ lists: { "/api/v1/namespaces": [], "/api/v1/nodes": [] }, version: "not an object" }),
    );
    expect((await kubernetesOverview(odd.surface)).version).toBe("N/A");
    const failing = testSurface(fakeCluster({ lists: { "/api/v1/namespaces": [] } }));
    await expect(kubernetesOverview(failing.surface)).rejects.toThrow(
      "The API server found nothing to list nodes in the cluster (404 Not Found).",
    );
  });
});

describe("KUBERNETES_LABELS", () => {
  test("say why the panels a cluster cannot fill are empty", () => {
    expect(KUBERNETES_LABELS.slowQueriesEmptyState).toBe("Kubernetes keeps no query log");
    expect(KUBERNETES_LABELS.sessionsEmptyState).toBe("Kubernetes does not list client sessions");
    expect(KUBERNETES_LABELS.tableStatsCaption).toContain("Kubernetes has no tables");
    expect(KUBERNETES_LABELS.vacuumGlobalDesc).toBe("Studio sends a Kubernetes cluster no maintenance and no write.");
    expect(Object.isFrozen(KUBERNETES_LABELS)).toBe(true);
  });
});
