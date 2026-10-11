import { describe, expect, test } from "bun:test";
import { QueryError } from "@/lib/db/errors";
import { UNAUTHORIZED_SENTENCE } from "@/lib/db/providers/platform/kubernetes/errors";
import { kindsForContainerName } from "@/lib/db/providers/platform/kubernetes/kinds";
import {
  containerName,
  listKubernetesContainers,
  listNamespaces,
} from "@/lib/db/providers/platform/kubernetes/objects";
import { expectCalls } from "../../../helpers/call-log";
import { fakeCluster, manyRows, testSurface } from "../../../helpers/kubernetes-cluster";
import { discoveryList, GROUPS_DISCOVERY, resource } from "../../../helpers/kubernetes-discovery";
import { statusAnswer } from "../../../helpers/kubernetes-transport";

const NAMESPACES = [{ name: "default" }, { name: "kube-system" }, { name: "shop" }];

describe("listKubernetesContainers", () => {
  test("Cluster first, then every namespace, each with its kinds, the default namespace the session's", async () => {
    const { surface } = testSurface(fakeCluster({ lists: { "/api/v1/namespaces": NAMESPACES } }), { database: "shop" });
    const containers = await listKubernetesContainers(surface);
    expect(containers.map((container) => [container.path, container.isSessionDefault === true])).toEqual([
      [["Cluster"], false],
      [["default"], false],
      [["kube-system"], false],
      [["shop"], true],
    ]);
    expect(containers[0].kinds).toEqual(kindsForContainerName("Cluster"));
    expect(containers[3].kinds).toEqual(kindsForContainerName("shop"));
  });

  test("reads the namespaces one row past the 1,000 cap and lists the first 1,000", async () => {
    const { surface, transport } = testSurface(fakeCluster({ lists: { "/api/v1/namespaces": manyRows("ns", 1_200) } }));
    const containers = await listKubernetesContainers(surface);
    expect(containers).toHaveLength(1_001);
    expect(containers.at(-1)?.name).toBe("ns-999");
    expectCalls(transport, [
      "GET /api",
      "GET /apis",
      "GET /api/v1/namespaces?limit=500&includeObject=None",
      "GET /api/v1/namespaces?limit=500&continue=500&includeObject=None",
      "GET /api/v1/namespaces?limit=1&continue=1000&includeObject=None",
    ]);
    expect((await listNamespaces(surface)).capped).toBe(true);
    const exact = testSurface(fakeCluster({ lists: { "/api/v1/namespaces": manyRows("ns", 1_000) } }));
    expect(await listNamespaces(exact.surface)).toEqual({
      names: manyRows("ns", 1_000).map((row) => row.name),
      forbidden: false,
    });
  });

  test("a capped list that sorts past the Default namespace keeps it as the 1,000th once the API shows it exists", async () => {
    // The API lists namespaces in name order, as ns-0000 to ns-1199 sort.
    const padded = Array.from({ length: 1_200 }, (_unused, index) => ({
      name: `ns-${String(index).padStart(4, "0")}`,
    }));
    const lists = { "/api/v1/namespaces": padded };
    const objects = { "/api/v1/namespaces/ns-1100": { kind: "Namespace", metadata: { name: "ns-1100" } } };
    const { surface, transport } = testSurface(fakeCluster({ lists, objects }), { database: "ns-1100" });
    const listed = await listNamespaces(surface);
    expect(listed.capped).toBe(true);
    expect(listed.names).toHaveLength(1_000);
    expect(listed.names.slice(-2)).toEqual(["ns-0998", "ns-1100"]);
    expect(transport.calls.at(-1)?.method).toBe("GET /api/v1/namespaces/ns-1100");
    const containers = await listKubernetesContainers(surface);
    expect(containers.filter((container) => container.isSessionDefault).map((container) => container.name)).toEqual([
      "ns-1100",
    ]);
  });

  test("a capped list keeps a Default namespace it read without asking again, and drops one the API does not show", async () => {
    const padded = Array.from({ length: 1_200 }, (_unused, index) => ({
      name: `ns-${String(index).padStart(4, "0")}`,
    }));
    const lists = { "/api/v1/namespaces": padded };
    const first1000 = padded.slice(0, 1_000).map((row) => row.name);
    const read = testSurface(fakeCluster({ lists }), { database: "ns-1000" });
    expect((await listNamespaces(read.surface)).names.slice(-2)).toEqual(["ns-0998", "ns-1000"]);
    expect(read.transport.calls.some((call) => call.method.startsWith("GET /api/v1/namespaces/"))).toBe(false);
    for (const database of ["ns-0005", "a-missing"]) {
      const other = testSurface(fakeCluster({ lists }), { database });
      expect((await listNamespaces(other.surface)).names).toEqual(first1000);
      expect(other.transport.calls.some((call) => call.method.startsWith("GET /api/v1/namespaces/"))).toBe(false);
    }
    const missing = testSurface(fakeCluster({ lists }), { database: "zz-missing" });
    expect((await listNamespaces(missing.surface)).names).toEqual(first1000);
    expect(missing.transport.calls.at(-1)?.method).toBe("GET /api/v1/namespaces/zz-missing");
    const hidden = testSurface(fakeCluster({ lists, forbidden: ["/api/v1/namespaces/zz-hidden"] }), {
      database: "zz-hidden",
    });
    expect((await listNamespaces(hidden.surface)).names).toEqual(first1000);
  });

  test("a capped list rethrows any other failure of the Default namespace's read", async () => {
    const padded = Array.from({ length: 1_200 }, (_unused, index) => ({
      name: `ns-${String(index).padStart(4, "0")}`,
    }));
    const cluster = fakeCluster({ lists: { "/api/v1/namespaces": padded } });
    const { surface } = testSurface(
      (request, line) =>
        line === "GET /api/v1/namespaces/zz-broken" ? statusAnswer(500, "InternalError") : cluster(request, line),
      { database: "zz-broken" },
    );
    await expect(listNamespaces(surface)).rejects.toThrow();
  });

  test("with the Namespaces field, no namespace list call is made", async () => {
    const { surface, transport } = testSurface(fakeCluster(), { namespaces: "shop web", database: "web" });
    const containers = await listKubernetesContainers(surface);
    expect(containers.map((container) => container.name)).toEqual(["Cluster", "shop", "web"]);
    expect(containers[2].isSessionDefault).toBe(true);
    expect(transport.calls).toEqual([]);
  });

  test("a 403 on the namespace list answers the Default namespace alone, once, and reports it", async () => {
    const { surface, transport } = testSurface(fakeCluster({ forbidden: ["/api/v1/namespaces"] }), {
      database: "shop",
    });
    expect((await listKubernetesContainers(surface)).map((container) => container.name)).toEqual(["Cluster", "shop"]);
    expect(await listNamespaces(surface)).toEqual({ names: ["shop"], forbidden: true });
    expect(transport.calls.filter((entry) => entry.method.startsWith("GET /api/v1/namespaces"))).toHaveLength(2);
  });

  test("on OpenShift a 403 on namespaces falls back to the projects the identity may list", async () => {
    const groups = {
      ...GROUPS_DISCOVERY,
      items: [
        ...(GROUPS_DISCOVERY.items as unknown[]),
        ...(discoveryList([
          {
            name: "project.openshift.io",
            versions: [
              { version: "v1", resources: [resource("projects", "Project", "Cluster", { verbs: ["get", "list"] })] },
            ],
          },
        ]).items as unknown[]),
      ],
    };
    const { surface } = testSurface(
      fakeCluster({
        groups,
        forbidden: ["/api/v1/namespaces"],
        lists: { "/apis/project.openshift.io/v1/projects": [{ name: "team-a" }, { name: "team-b" }] },
      }),
      { database: "team-a" },
    );
    expect(await listNamespaces(surface)).toEqual({ names: ["team-a", "team-b"], forbidden: false });
  });

  test("a listed namespace name that is not a DNS-1123 label fails the namespace list with a sentence", async () => {
    for (const odd of ["Cluster", "a/b"]) {
      const { surface } = testSurface(
        fakeCluster({ lists: { "/api/v1/namespaces": [{ name: "shop" }, { name: odd }] } }),
      );
      await expect(listKubernetesContainers(surface)).rejects.toThrow(
        "The API server listed a namespace whose name is not a DNS-1123 label, which no namespace can have, so Studio does not list the namespaces; list the ones to show in the connection's Namespaces field.",
      );
    }
  });

  test("a 401 on the namespace list answers the expiry sentence after one request, never the Default namespace", async () => {
    const cluster = fakeCluster();
    const { surface, transport } = testSurface(
      (request, line) =>
        line.startsWith("GET /api/v1/namespaces?") ? statusAnswer(401, "Unauthorized") : cluster(request, line),
      { database: "shop" },
    );
    await expect(listKubernetesContainers(surface)).rejects.toThrow(UNAUTHORIZED_SENTENCE);
    expect(transport.calls.filter((entry) => entry.method.startsWith("GET /api/v1/namespaces"))).toHaveLength(1);
  });

  test("an error other than 403 is raised, not hidden", async () => {
    const { surface } = testSurface(() => {
      throw new QueryError("down");
    });
    await expect(listKubernetesContainers(surface)).rejects.toThrow("down");
  });

  test("a container has no child containers", async () => {
    const { surface } = testSurface(fakeCluster());
    expect(await listKubernetesContainers(surface, ["shop"])).toEqual([]);
  });
});

describe("containerName", () => {
  test("Cluster and a namespace pass; a namespace named cluster is a namespace", () => {
    expect(containerName(["Cluster"])).toBe("Cluster");
    expect(containerName(["cluster"])).toBe("cluster");
  });
  test("a path of another depth, or a name that is neither, is refused", () => {
    expect(() => containerName([])).toThrow("A Kubernetes container path is [namespace], received []");
    expect(() => containerName(["a", "b"])).toThrow(QueryError);
    expect(() => containerName(["Shop"])).toThrow('received "Shop"');
  });
});
