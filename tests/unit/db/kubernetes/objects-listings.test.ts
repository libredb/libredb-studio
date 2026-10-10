import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { kindsForContainerName } from "@/lib/db/providers/platform/kubernetes/kinds";
import {
  countKubernetesObjects,
  describeKubernetesObject,
  describeKubernetesObjects,
  KUBERNETES_SAMPLED_FROM,
  listKubernetesObjects,
  notableStatus,
  objectAddress,
} from "@/lib/db/providers/platform/kubernetes/objects";
import { expectCalls } from "../../../helpers/call-log";
import { fakeCluster, manyRows, testSurface } from "../../../helpers/kubernetes-cluster";
import { discoveryList, resource } from "../../../helpers/kubernetes-discovery";

const PODS = "/api/v1/namespaces/shop/pods";

describe("listKubernetesObjects", () => {
  test("a listed name the request policy refuses fails the folder with a sentence, so no statement splits on it", async () => {
    const roles = "/apis/rbac.authorization.k8s.io/v1/namespaces/shop/roles";
    const { surface } = testSurface(fakeCluster({ lists: { [roles]: [{ name: "reader" }, { name: "ops team" }] } }));
    await expect(listKubernetesObjects(surface, ["shop"], "roles")).rejects.toThrow(
      "The API server listed Roles whose name holds a character Studio never puts in a request path",
    );
  });

  test("names carry their kind; a notable status is set and an ordinary one is not", async () => {
    const { surface } = testSurface(
      fakeCluster({
        lists: {
          [PODS]: [
            { name: "web-1", ready: "1/1", status: "Running" },
            { name: "web-2", ready: "0/1", status: "CrashLoopBackOff" },
            { name: "job-1", ready: "0/1", status: "Completed" },
            { name: "web-3", ready: "1/2", status: "Running" },
          ],
        },
      }),
    );
    expect(await listKubernetesObjects(surface, ["shop"], "pods")).toEqual([
      { path: ["shop", "pod/web-1"], name: "web-1", kind: "pods" },
      { path: ["shop", "pod/web-2"], name: "web-2", kind: "pods", status: "CrashLoopBackOff" },
      { path: ["shop", "pod/job-1"], name: "job-1", kind: "pods" },
      { path: ["shop", "pod/web-3"], name: "web-3", kind: "pods", status: "Running, 1/2 ready" },
    ]);
  });

  test("a cluster-scoped kind is listed under Cluster with no namespace in the path", async () => {
    const { surface, transport } = testSurface(
      fakeCluster({ lists: { "/api/v1/nodes": [{ name: "k3d-0", status: "Ready" }] } }),
    );
    expect(await listKubernetesObjects(surface, ["Cluster"], "nodes")).toEqual([
      { path: ["Cluster", "node/k3d-0"], name: "k3d-0", kind: "nodes" },
    ]);
    expect(transport.calls.at(-1)?.method).toBe("GET /api/v1/nodes?limit=500&includeObject=None");
  });

  test("lists the first 1,000 objects in pages of 500, following continue", async () => {
    const { surface, transport } = testSurface(fakeCluster({ lists: { [PODS]: manyRows("web", 1_500) } }));
    const objects = await listKubernetesObjects(surface, ["shop"], "pods");
    expect(objects).toHaveLength(1_000);
    expect(objects.at(-1)?.name).toBe("web-999");
    expectCalls(transport, [
      "GET /api",
      "GET /apis",
      `GET ${PODS}?limit=500&includeObject=None`,
      `GET ${PODS}?limit=500&continue=500&includeObject=None`,
    ]);
  });

  test("Custom Resources rows are the non-built-in types of the container's scope, with list", async () => {
    const { surface, transport } = testSurface(fakeCluster());
    expect(await listKubernetesObjects(surface, ["shop"], "customresources")).toEqual([
      { path: ["shop", "widgets.probe.libredb.dev"], name: "widgets.probe.libredb.dev", kind: "customresources" },
      { path: ["shop", "pods.metrics.k8s.io"], name: "pods.metrics.k8s.io", kind: "customresources" },
    ]);
    expect(await listKubernetesObjects(surface, ["Cluster"], "customresources")).toEqual([
      { path: ["Cluster", "nodes.metrics.k8s.io"], name: "nodes.metrics.k8s.io", kind: "customresources" },
    ]);
    expect(transport.calls.map((entry) => entry.method)).toEqual(["GET /api", "GET /apis"]);
  });

  test("an inapplicable container and kind pair answers its sentence and sends nothing", async () => {
    const { surface, transport } = testSurface(fakeCluster());
    await expect(listKubernetesObjects(surface, ["Cluster"], "pods")).rejects.toThrow(
      "Pods live in a namespace, not under Cluster.",
    );
    await expect(listKubernetesObjects(surface, ["shop"], "nodes")).rejects.toThrow(
      "Nodes are cluster-scoped: they are listed under Cluster, not in a namespace.",
    );
    await expect(listKubernetesObjects(surface, ["shop"], "widgets")).rejects.toThrow(
      'Kubernetes declares no object kind "widgets"',
    );
    expect(transport.calls).toEqual([]);
  });

  test("a kind the server does not serve answers the not-served sentence", async () => {
    const { surface } = testSurface(fakeCluster({ groups: discoveryList([]) }));
    await expect(listKubernetesObjects(surface, ["shop"], "deployments")).rejects.toThrow(
      "This server does not serve Deployments: discovery lists no deployments.apps.",
    );
  });

  test("a row without a name is refused", async () => {
    const { surface } = testSurface(fakeCluster({ lists: { [PODS]: [{ name: "" }] } }));
    await expect(listKubernetesObjects(surface, ["shop"], "pods")).rejects.toThrow(
      "The API server listed one of the Pods without a name.",
    );
  });
});

describe("countKubernetesObjects", () => {
  test("counts every kind of the container from the capped walk, exactly up to 1,000", async () => {
    const { surface } = testSurface(
      fakeCluster({
        lists: { [PODS]: manyRows("web", 1_000), "/api/v1/namespaces/shop/configmaps": [{ name: "app" }] },
        forbidden: ["/api/v1/namespaces/shop/secrets"],
      }),
    );
    const counts = await countKubernetesObjects(surface, ["shop"]);
    expect(Object.keys(counts)).toEqual([...kindsForContainerName("shop")]);
    expect(counts.pods).toEqual({ count: 1_000 });
    expect(counts.configmaps).toEqual({ count: 1 });
    expect(counts.secrets).toEqual({
      unavailable: "This connection's identity may not list secrets in the namespace shop (403 Forbidden).",
    });
    expect(counts.customresources).toEqual({ count: 2 });
    // Every other kind answers the fake's 404 Status, a lock with its sentence rather than a lost inventory.
    expect(counts.services).toEqual({
      unavailable: "The API server found nothing to list services in the namespace shop (404 Not Found).",
    });
  });

  test("past 1,000 the count is the sampled floor, read one row past the cap", async () => {
    const { surface, transport } = testSurface(fakeCluster({ lists: { [PODS]: manyRows("web", 1_001) } }));
    const counts = await countKubernetesObjects(surface, ["shop"]);
    expect(counts.pods).toEqual({ count: 1_000, sampledFrom: KUBERNETES_SAMPLED_FROM });
    expect(
      transport.calls.filter((entry) => entry.method.startsWith(`GET ${PODS}`)).map((entry) => entry.method),
    ).toEqual([
      `GET ${PODS}?limit=500&includeObject=None`,
      `GET ${PODS}?limit=500&continue=500&includeObject=None`,
      `GET ${PODS}?limit=1&continue=1000&includeObject=None`,
    ]);
  });

  test("the kinds are counted at most four lists at a time, the connection's sockets", async () => {
    const answer = fakeCluster({ lists: { [PODS]: manyRows("web", 3) } });
    let inFlight = 0;
    let most = 0;
    const { surface } = testSurface(async (request, line) => {
      if (!line.includes("?limit=")) return answer(request, line);
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return answer(request, line);
    });
    const counts = await countKubernetesObjects(surface, ["shop"]);
    expect(most).toBe(4);
    expect(Object.keys(counts)).toEqual([...kindsForContainerName("shop")]);
    expect(counts.pods).toEqual({ count: 3 });
  });

  test("a kind discovery does not list, or lists without list, answers unavailable with no request", async () => {
    const groups = discoveryList([
      {
        name: "rbac.authorization.k8s.io",
        versions: [
          { version: "v1", resources: [resource("clusterroles", "ClusterRole", "Cluster", { verbs: ["get"] })] },
        ],
      },
    ]);
    const { surface, transport } = testSurface(fakeCluster({ groups }));
    const counts = await countKubernetesObjects(surface, ["Cluster"]);
    expect(counts.clusterroles).toEqual({
      unavailable:
        "This server does not serve Cluster Roles: discovery lists no clusterroles.rbac.authorization.k8s.io.",
    });
    expect(transport.calls.some((entry) => entry.method.includes("clusterroles"))).toBe(false);
  });

  test("a transport failure is raised, not turned into a lock", async () => {
    let discovery = 0;
    const { surface } = testSurface((request, line) => {
      if (line === "GET /api" || line === "GET /apis") {
        discovery += 1;
        return fakeCluster()(request, line);
      }
      throw new QueryError("connection reset");
    });
    await expect(countKubernetesObjects(surface, ["shop"])).rejects.toThrow("connection reset");
    expect(discovery).toBe(2);
  });
});

describe("notableStatus", () => {
  const columns = [{ name: "Ready", type: "string", format: "", priority: 0 }];
  test("a Ready count short of its total without a Status, and nothing when it is whole or absent", () => {
    expect(notableStatus({ columns }, { cells: ["2/3"] })).toBe("2/3 ready");
    expect(notableStatus({ columns }, { cells: ["3/3"] })).toBeUndefined();
    expect(notableStatus({ columns }, { cells: [7] })).toBeUndefined();
    expect(notableStatus({ columns: [] }, { cells: [] })).toBeUndefined();
  });
});

describe("object addresses and descriptions", () => {
  test("a path carries its container and its kind's segment", () => {
    expect(objectAddress(["shop", "pod/web-1"], "pods")).toMatchObject({ container: "shop", name: "web-1" });
  });
  test("a wrong depth, a wrong prefix and a custom resource type are refused", () => {
    expect(() => objectAddress(["shop"], "pods")).toThrow(
      'A Kubernetes "pods" path is [container, <kind>/<name>], received ["shop"]',
    );
    expect(() => objectAddress(["shop", "deployment/web"], "pods")).toThrow("addressed as pod/<name>");
    expect(() => objectAddress(["shop", "widgets.probe.libredb.dev"], "customresources")).toThrow(
      "A custom resource type has no source: list its objects with the List action.",
    );
  });
  test("describe answers no columns for every kind, after the path check", () => {
    expect(describeKubernetesObject(["shop", "pod/web-1"], "pods")).toEqual({
      path: ["shop", "pod/web-1"],
      columns: [],
      indexes: [],
      foreignKeys: [],
    });
    expect(describeKubernetesObject(["shop", "widgets.probe.libredb.dev"], "customresources").columns).toEqual([]);
    expect(() => describeKubernetesObject(["shop"], "customresources")).toThrow("[container, <plural>.<group>]");
    expect(describeKubernetesObjects(["shop"], "pods")).toEqual({ details: [] });
    expect(() => describeKubernetesObjects(["Cluster"], "pods")).toThrow(QueryError);
  });
});

describe("a type the server stopped serving", () => {
  test("a text/plain 404 on a listing reads discovery again once, then answers kubectl's sentence", async () => {
    const { surface, transport } = testSurface((request, line) =>
      line.startsWith(`GET ${PODS}`)
        ? { status: 404, contentType: "text/plain; charset=utf-8", retryAfter: null, text: "404 page not found" }
        : fakeCluster()(request, line),
    );
    await expect(listKubernetesObjects(surface, ["shop"], "pods")).rejects.toThrow(
      'the server doesn\'t have a resource type "pods"',
    );
    expect(transport.calls.map((entry) => entry.method)).toEqual([
      "GET /api",
      "GET /apis",
      `GET ${PODS}?limit=500&includeObject=None`,
      "GET /api",
      "GET /apis",
      `GET ${PODS}?limit=500&includeObject=None`,
    ]);
  });
});
