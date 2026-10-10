import { describe, expect, test } from "bun:test";
import { AuthenticationError, DatabaseConfigError, QueryError } from "@/lib/db/errors";
import { VERSION_FLOOR_SENTENCE } from "@/lib/db/providers/platform/kubernetes/discovery";
import { KUBERNETES_CONSOLE_PENDING, KubernetesProvider } from "@/lib/db/providers/platform/kubernetes/index";
import { KUBERNETES_OBJECT_KINDS, KUBERNETES_ROW_ACTIONS } from "@/lib/db/providers/platform/kubernetes/kinds";
import { KUBERNETES_LABELS } from "@/lib/db/providers/platform/kubernetes/labels";
import type { DatabaseConnection } from "@/lib/types";
import { fakeCluster, type FakeClusterOptions } from "../../../helpers/kubernetes-cluster";
import { kubernetesConnection } from "../../../helpers/kubernetes-connection";
import { discoveryList, resource } from "../../../helpers/kubernetes-discovery";
import {
  type KubernetesAnswerFn,
  recordingKubernetesTransport,
  statusAnswer,
  testSeams,
} from "../../../helpers/kubernetes-transport";

function providerWith(answer: KubernetesAnswerFn, overrides?: Partial<DatabaseConnection>) {
  const transport = recordingKubernetesTransport(answer);
  const provider = new KubernetesProvider(
    kubernetesConnection(overrides),
    { queryTimeout: 30_000 },
    testSeams(transport),
  );
  return { provider, transport };
}

const SHOP: FakeClusterOptions = {
  lists: {
    "/api/v1/namespaces": [{ name: "default" }, { name: "shop" }],
    "/api/v1/namespaces/shop/pods": [{ name: "web-1", ready: "1/1", status: "Running" }],
  },
  objects: { "/api/v1/namespaces/shop/pods/web-1": { kind: "Pod", metadata: { name: "web-1", namespace: "shop" } } },
};

describe("declarations", () => {
  const { provider, transport } = providerWith(fakeCluster());
  const capabilities = provider.getCapabilities();

  test("a read-only kubectl console, one namespace level, the declared kinds and row actions", () => {
    expect(capabilities).toMatchObject({
      queryLanguage: "json",
      queryDialect: "kubectl",
      supportsExplain: false,
      supportsCreateTable: false,
      supportsInlineRowEdit: false,
      supportsTestDataGeneration: false,
      supportsTransactions: false,
      enforcesReadOnly: true,
      supportsMaintenance: false,
      maintenanceOperations: [],
      supportsConnectionString: false,
      defaultPort: 6443,
      containerLevels: [{ id: "schema", label: "Namespace", labelPlural: "Namespaces" }],
      containerPathShapes: "exact",
      containersNameKinds: true,
      agentWalkScope: { mode: "session-default", alsoWalk: [["Cluster"]] },
    });
    expect(capabilities.objectKinds).toBe(KUBERNETES_OBJECT_KINDS);
    expect(capabilities.rowActions).toBe(KUBERNETES_ROW_ACTIONS);
  });

  test("no explain format, no column profiling surface, no agent statement execution", () => {
    expect(capabilities.explainFormat).toBeUndefined();
    expect((provider as { queryReadOnly?: unknown }).queryReadOnly).toBeUndefined();
  });

  test("the labels, as a copy", () => {
    expect(provider.getLabels()).toEqual(KUBERNETES_LABELS);
    expect(provider.getLabels()).not.toBe(KUBERNETES_LABELS);
  });

  test("building a provider sends nothing", () => {
    expect(transport.calls).toEqual([]);
    expect(transport.built).toEqual([]);
  });
});

describe("connect", () => {
  test("reads discovery, the namespace list and the six reviews, then answers its warnings", async () => {
    const { provider, transport } = providerWith(
      fakeCluster({ ...SHOP, allows: (attributes) => attributes.verb === "*" }),
    );
    await provider.connect();
    expect(provider.isConnected()).toBe(true);
    const lines = transport.calls.map((entry) => entry.method);
    expect(lines.slice(0, 2)).toEqual(["GET /api", "GET /apis"]);
    expect(lines.filter((line) => line.startsWith("POST"))).toHaveLength(6);
    expect(provider.connectWarnings()).toHaveLength(1);
    expect(provider.connectWarnings()[0].message).toContain("do anything to every resource (* on *)");
  });

  test("a rejected token fails connect with the 401 sentence after one request, and closes the transport", async () => {
    const { provider, transport } = providerWith(() => statusAnswer(401, "Unauthorized"));
    await expect(provider.connect()).rejects.toBeInstanceOf(AuthenticationError);
    expect(transport.calls.map((entry) => entry.method)).toEqual(["GET /api"]);
    expect(provider.isConnected()).toBe(false);
    expect(transport.closed()).toBe(1);
  });

  test("a 1.27 cluster is refused with the sentence naming the floor, after discovery alone", async () => {
    const groups = discoveryList(
      [
        {
          name: "authentication.k8s.io",
          versions: [
            {
              version: "v1beta1",
              resources: [resource("selfsubjectreviews", "SelfSubjectReview", "Cluster", { verbs: ["create"] })],
            },
          ],
        },
      ],
      "apidiscovery.k8s.io/v2beta1",
    );
    const { provider, transport } = providerWith(fakeCluster({ groups }));
    await expect(provider.connect()).rejects.toThrow(VERSION_FLOOR_SENTENCE);
    expect(transport.calls.map((entry) => entry.method)).toEqual(["GET /api", "GET /apis"]);
    expect(provider.isConnected()).toBe(false);
    expect(transport.closed()).toBe(1);
  });

  test("a refused connection is refused before any transport is built", async () => {
    const { provider, transport } = providerWith(fakeCluster(), { user: "admin" });
    await expect(provider.connect()).rejects.toBeInstanceOf(DatabaseConfigError);
    expect(transport.built).toEqual([]);
  });

  test("connecting again closes the first session; disconnect closes the second and clears the warnings", async () => {
    const { provider, transport } = providerWith(fakeCluster({ ...SHOP, allows: () => true }));
    await provider.connect();
    await provider.connect();
    expect(transport.closed()).toBe(1);
    await provider.disconnect();
    expect(transport.closed()).toBe(2);
    expect(provider.connectWarnings()).toEqual([]);
    await provider.disconnect();
    expect(transport.closed()).toBe(2);
  });
});

describe("the console", () => {
  test("a statement is refused before any request until the console lands", async () => {
    const { provider, transport } = providerWith(fakeCluster(SHOP));
    await provider.connect();
    const before = transport.calls.length;
    await expect(provider.query("kubectl get pods")).rejects.toThrow(KUBERNETES_CONSOLE_PENDING);
    await expect(provider.query("get pods", ["x"])).rejects.toBeInstanceOf(DatabaseConfigError);
    expect(transport.calls).toHaveLength(before);
  });

  test("a statement on a provider that is not connected is refused", async () => {
    const { provider } = providerWith(fakeCluster());
    await expect(provider.query("get pods")).rejects.toThrow("Provider is not connected");
  });
});

describe("the tree", () => {
  test("containers, counts, listings, descriptions and the YAML view go through the session", async () => {
    const { provider } = providerWith(fakeCluster(SHOP), { database: "shop" });
    await provider.connect();
    expect((await provider.listContainers()).map((container) => container.name)).toEqual([
      "Cluster",
      "default",
      "shop",
    ]);
    expect((await provider.countObjects(["shop"])).pods).toEqual({ count: 1 });
    expect(await provider.listObjects(["shop"], "pods")).toEqual([
      { path: ["shop", "pod/web-1"], name: "web-1", kind: "pods" },
    ]);
    expect((await provider.describeObject(["shop", "pod/web-1"], "pods")).columns).toEqual([]);
    expect(await provider.describeObjects(["shop"], "pods")).toEqual({ details: [] });
    const document = await provider.readObjectSource(["shop", "pod/web-1"], "pods");
    expect(document.parts[0]).toMatchObject({ language: "yaml" });
  });

  test("a tree read before connect is refused", async () => {
    const { provider } = providerWith(fakeCluster(SHOP));
    await expect(provider.listContainers()).rejects.toThrow("Provider is not connected");
  });
});

describe("monitoring", () => {
  test("health connects if needed, without the connect reads, and keeps the session", async () => {
    const { provider, transport } = providerWith(fakeCluster(SHOP));
    await provider.getHealth();
    expect(transport.calls.map((entry) => entry.method)).toEqual(["GET /readyz", "GET /version"]);
    expect(provider.isConnected()).toBe(true);
    await provider.getHealth();
    expect(transport.built).toHaveLength(1);
  });

  test("a failing health check closes the session it opened", async () => {
    const { provider, transport } = providerWith(fakeCluster({ readyzStatus: 500 }));
    await expect(provider.getHealth()).rejects.toThrow("(HTTP 500)");
    expect(provider.isConnected()).toBe(false);
    expect(transport.closed()).toBe(1);
  });

  test("a failing health check on a connected session keeps it", async () => {
    let ready = true;
    const answer = fakeCluster(SHOP);
    const { provider, transport } = providerWith((request, line) =>
      line === "GET /readyz" && !ready ? statusAnswer(503, "ServiceUnavailable") : answer(request, line),
    );
    await provider.connect();
    ready = false;
    await expect(provider.getHealth()).rejects.toThrow("(HTTP 503, reason ServiceUnavailable)");
    expect(provider.isConnected()).toBe(true);
    expect(transport.closed()).toBe(0);
  });

  test("the overview reads through the session; every other getter is empty; maintenance is refused", async () => {
    const { provider } = providerWith(
      fakeCluster({ ...SHOP, lists: { ...SHOP.lists, "/api/v1/nodes": [{ name: "n1" }] } }),
    );
    await provider.connect();
    expect(await provider.getOverview()).toMatchObject({
      version: "v1.35.5+k3s1",
      tableCount: 2,
      databaseSize: "1 node",
    });
    expect(await provider.getPerformanceMetrics()).toEqual({});
    expect(await provider.getSlowQueries()).toEqual([]);
    expect(await provider.getActiveSessions()).toEqual([]);
    expect(await provider.getTableStats()).toEqual([]);
    expect(await provider.getIndexStats()).toEqual([]);
    expect(await provider.getStorageStats()).toEqual([]);
    await expect(provider.runMaintenance()).rejects.toThrow(QueryError);
  });
});
