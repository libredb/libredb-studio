import { describe, expect, test } from "bun:test";
import {
  AuthenticationError,
  ConnectionError,
  DatabaseConfigError,
  QueryCancelledError,
  QueryError,
} from "@/lib/db/errors";
import { VERSION_FLOOR_SENTENCE } from "@/lib/db/providers/platform/kubernetes/discovery";
import { KUBERNETES_MAX_EMPTY_PAGES } from "@/lib/db/providers/platform/kubernetes/limits";
import { EMPTY_PAGES_SENTENCE } from "@/lib/db/providers/platform/kubernetes/table";
import { KUBERNETES_CLOSED_WHILE_OPENING, KubernetesProvider } from "@/lib/db/providers/platform/kubernetes/index";
import { KUBERNETES_OBJECT_KINDS, KUBERNETES_ROW_ACTIONS } from "@/lib/db/providers/platform/kubernetes/kinds";
import { KUBERNETES_LABELS } from "@/lib/db/providers/platform/kubernetes/labels";
import type { DatabaseConnection } from "@/lib/types";
import { fakeCluster, type FakeClusterOptions, manyRows } from "../../../helpers/kubernetes-cluster";
import { kubernetesConnection } from "../../../helpers/kubernetes-connection";
import { discoveryList, resource } from "../../../helpers/kubernetes-discovery";
import {
  jsonAnswer,
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

/** Holds every request whose line is `line` until `release()`; `reached` settles when the first one arrives. */
function gate(answer: KubernetesAnswerFn, line: string) {
  let release = (): void => {};
  let arrived = (): void => {};
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const gated: KubernetesAnswerFn = async (request, requestLine) => {
    if (requestLine === line) {
      arrived();
      await opened;
    }
    return answer(request, requestLine);
  };
  return { gated, reached, release: () => release() };
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

describe("a session being opened", () => {
  test("disconnect during connect aborts it: connect rejects, nothing more is sent and the provider stays closed", async () => {
    const held = gate(fakeCluster(SHOP), "GET /apis");
    const { provider, transport } = providerWith(held.gated);
    const connecting = provider.connect();
    await held.reached;
    await provider.disconnect();
    expect(transport.closed()).toBe(1);
    const sent = transport.calls.length;
    held.release();
    await expect(connecting).rejects.toThrow(KUBERNETES_CLOSED_WHILE_OPENING);
    await expect(connecting).rejects.toBeInstanceOf(ConnectionError);
    expect(transport.calls).toHaveLength(sent);
    expect(provider.isConnected()).toBe(false);
    expect(transport.closed()).toBe(1);
    await expect(provider.listContainers()).rejects.toThrow("Provider is not connected");
  });

  test("disconnect while connect reads its warnings aborts it too, and keeps no warning", async () => {
    const held = gate(
      fakeCluster({ ...SHOP, allows: () => true }),
      "GET /api/v1/namespaces?limit=500&includeObject=None",
    );
    const { provider, transport } = providerWith(held.gated);
    const connecting = provider.connect();
    await held.reached;
    await provider.disconnect();
    held.release();
    await expect(connecting).rejects.toThrow(KUBERNETES_CLOSED_WHILE_OPENING);
    expect(provider.isConnected()).toBe(false);
    expect(provider.connectWarnings()).toEqual([]);
    expect(transport.closed()).toBe(1);
  });

  test("a second connect aborts the first one still opening, and only the second session is kept", async () => {
    const held = gate(fakeCluster(SHOP), "GET /apis");
    const { provider, transport } = providerWith(held.gated);
    const first = provider.connect();
    await held.reached;
    const second = provider.connect();
    held.release();
    await expect(first).rejects.toThrow(KUBERNETES_CLOSED_WHILE_OPENING);
    await second;
    expect(provider.isConnected()).toBe(true);
    expect(transport.built).toHaveLength(2);
    expect(transport.closed()).toBe(1);
    await provider.disconnect();
    expect(transport.closed()).toBe(2);
  });

  test("a connect while health opens a session aborts the health one, which is closed and not kept", async () => {
    const held = gate(fakeCluster(SHOP), "GET /readyz");
    const { provider, transport } = providerWith(held.gated);
    const health = provider.getHealth();
    await held.reached;
    await provider.connect();
    held.release();
    await expect(health).rejects.toThrow(KUBERNETES_CLOSED_WHILE_OPENING);
    expect(provider.isConnected()).toBe(true);
    expect(transport.built).toHaveLength(2);
    expect(transport.closed()).toBe(1);
    expect((await provider.listContainers()).map((container) => container.name)).toEqual([
      "Cluster",
      "default",
      "shop",
    ]);
  });
});

describe("health while a session is being opened", () => {
  test("health answering while connect opens: connect keeps its session and closes the one health kept", async () => {
    const held = gate(fakeCluster(SHOP), "GET /apis");
    const { provider, transport } = providerWith(held.gated);
    const connecting = provider.connect();
    await held.reached;
    await provider.getHealth();
    held.release();
    await connecting;
    expect(provider.isConnected()).toBe(true);
    expect(transport.built).toHaveLength(2);
    expect(transport.closed()).toBe(1);
    await provider.disconnect();
    expect(transport.closed()).toBe(2);
  });

  test("health answering after connect kept a session closes its own and keeps connect's", async () => {
    const health = gate(fakeCluster(SHOP), "GET /readyz");
    const discovery = gate(health.gated, "GET /apis");
    const { provider, transport } = providerWith(discovery.gated);
    const connecting = provider.connect();
    await discovery.reached;
    const checking = provider.getHealth();
    await health.reached;
    discovery.release();
    await connecting;
    health.release();
    await checking;
    expect(provider.isConnected()).toBe(true);
    expect(transport.built).toHaveLength(2);
    expect(transport.closed()).toBe(1);
    await provider.disconnect();
    expect(transport.closed()).toBe(2);
  });

  test("two health checks opening at once keep one session and close the other", async () => {
    const held = gate(fakeCluster(SHOP), "GET /readyz");
    const { provider, transport } = providerWith(held.gated);
    const first = provider.getHealth();
    const second = provider.getHealth();
    await held.reached;
    held.release();
    await Promise.all([first, second]);
    expect(provider.isConnected()).toBe(true);
    expect(transport.built).toHaveLength(2);
    expect(transport.closed()).toBe(1);
    await provider.disconnect();
    expect(transport.closed()).toBe(2);
  });
});

describe("the namespace walk Test Connection runs", () => {
  test("a server answering empty pages with a fresh continue token is stopped, and connect answers", async () => {
    let lists = 0;
    const answer = fakeCluster(SHOP);
    const { provider, transport } = providerWith((request, line) => {
      if (!line.startsWith("GET /api/v1/namespaces?")) return answer(request, line);
      lists += 1;
      return jsonAnswer({ kind: "Table", columnDefinitions: [], rows: [], metadata: { continue: `t${lists}` } });
    });
    await expect(provider.connect()).rejects.toThrow(EMPTY_PAGES_SENTENCE);
    expect(lists).toBe(KUBERNETES_MAX_EMPTY_PAGES);
    expect(provider.isConnected()).toBe(false);
    expect(transport.closed()).toBe(1);
  });
});

describe("the console", () => {
  test("pages the list form of a get, and pages it through the prepared statement", async () => {
    const { provider } = providerWith(fakeCluster(SHOP), { database: "shop" });
    expect(provider.getCapabilities()).toMatchObject({
      supportsResultPagination: true,
      supportsExternalQueryLimiting: true,
    });
    await provider.connect();
    const prepared = provider.prepareQuery("kubectl get pods", { limit: 50, offset: 0 });
    expect(prepared).toEqual({
      query: "kubectl get pods\n# libredb:page offset=0 limit=50",
      wasLimited: true,
      limit: 50,
      offset: 0,
    });
    const result = await provider.query(prepared.query);
    expect(result).toMatchObject({ fields: ["Name", "Ready", "Status", "Age"], rowCount: 1, executionTime: 0 });
    expect(result.rows[0]).toMatchObject({ Name: "web-1", Status: "Running" });
    expect(result.pagination).toBeUndefined();
    expect(provider.prepareQuery("kubectl describe pod web-1", { limit: 50, offset: 50 })).toEqual({
      query: "kubectl describe pod web-1",
      wasLimited: false,
      limit: 50,
      offset: 0,
    });
  });

  test("an unpaged list past 5,000 rows says the provider bounded it", async () => {
    const lists = { ...SHOP.lists, "/api/v1/namespaces/shop/pods": manyRows("p", 5_001) };
    const { provider } = providerWith(fakeCluster({ lists }), { database: "shop" });
    await provider.connect();
    const result = await provider.query("get pods");
    expect(result.rowCount).toBe(5_000);
    expect(result.pagination).toEqual({
      limit: 5_000,
      offset: 0,
      hasMore: true,
      totalReturned: 5_000,
      wasLimited: true,
    });
    expect(result.warnings?.[0].message).toContain("more than 5,000 objects");
  });

  test("a refused statement and parameters send nothing", async () => {
    const { provider, transport } = providerWith(fakeCluster(SHOP));
    await provider.connect();
    const before = transport.calls.length;
    await expect(provider.query("kubectl delete pod web-1")).rejects.toThrow("it is not read-only");
    await expect(provider.query("get pods", ["x"])).rejects.toBeInstanceOf(DatabaseConfigError);
    expect(transport.calls).toHaveLength(before);
  });

  test("a statement on a provider that is not connected is refused", async () => {
    const { provider } = providerWith(fakeCluster());
    await expect(provider.query("get pods")).rejects.toThrow("Provider is not connected");
  });

  test("a cancel stops the run and answers the cancel sentence; an unknown id answers false", async () => {
    const answer = fakeCluster(SHOP);
    let started: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const { provider } = providerWith(
      (request, line) => {
        if (!line.startsWith("GET /api/v1/namespaces/shop/pods?")) return answer(request, line);
        started();
        return new Promise((_resolve, reject) => {
          request.signal.addEventListener("abort", () => reject(new Error("socket destroyed")), { once: true });
        });
      },
      { database: "shop" },
    );
    await provider.connect();
    const running = provider.query("get pods", undefined, "run-1");
    await waiting;
    expect(await provider.cancelQuery("run-1")).toBe(true);
    await expect(running).rejects.toBeInstanceOf(QueryCancelledError);
    expect(await provider.cancelQuery("run-1")).toBe(false);
  });

  test("a failure that is not a cancel passes as it was raised", async () => {
    const { provider } = providerWith(fakeCluster({ ...SHOP, forbidden: ["/api/v1/namespaces/shop/pods"] }), {
      database: "shop",
    });
    await provider.connect();
    await expect(provider.query("get pods", undefined, "run-2")).rejects.toThrow(
      "This connection's identity may not list pods in the namespace shop (403 Forbidden).",
    );
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
