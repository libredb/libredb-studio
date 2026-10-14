/**
 * `cluster.usage.read`: one row per container joined from metrics.k8s.io PodMetrics and the core pod list, with the
 * workload above each pod, numbers in millicores and bytes and the ratios over the requests. A cluster without
 * metrics, or with an aggregated metrics API whose backend is down, answers metrics-unavailable; past 500 rows the
 * reading is refused rather than truncated.
 */
import { describe, expect, test } from "bun:test";
import type { KubectlContext } from "@/lib/db/providers/platform/kubernetes/console/context";
import {
  CLUSTER_READING_MAX_ROWS,
  CLUSTER_USAGE_FIELDS,
  readClusterUsage,
} from "@/lib/db/providers/platform/kubernetes/agent-readings";
import { KubernetesProvider } from "@/lib/db/providers/platform/kubernetes/index";
import { MACHINE_PROFILE_SENTENCE } from "@/lib/db/providers/platform/kubernetes/machine-read";
import { fakeCluster } from "../../../helpers/kubernetes-cluster";
import { kubernetesConnection } from "../../../helpers/kubernetes-connection";
import { consoleContext, listAnswer, type RouteAnswer, routes, sentLines } from "../../../helpers/kubernetes-console";
import { discoveryList, GROUPS_DISCOVERY, resource } from "../../../helpers/kubernetes-discovery";
import {
  jsonAnswer,
  type KubernetesAnswerFn,
  recordingKubernetesTransport,
  statusAnswer,
  testSeams,
} from "../../../helpers/kubernetes-transport";

const METRICS = "GET /apis/metrics.k8s.io/v1beta1/namespaces/shop/pods?limit=500";
const PODS = "GET /api/v1/namespaces/shop/pods?limit=500";
const REPLICA_SETS = "GET /apis/apps/v1/namespaces/shop/replicasets?limit=500";
const JOBS = "GET /apis/batch/v1/namespaces/shop/jobs?limit=500";

type Json = Record<string, unknown>;

/** The groups discovery serves, without those named. */
function groupsWithout(...names: readonly string[]): Json {
  const items = GROUPS_DISCOVERY.items as readonly { readonly metadata: { readonly name?: string } }[];
  return { ...GROUPS_DISCOVERY, items: items.filter((item) => !names.includes(item.metadata.name ?? "")) };
}

const owner = (kind: string, name: string) => ({ kind, name, controller: true, apiVersion: "v1", uid: `uid-${name}` });

function pod(name: string, containers: readonly Json[], owners: readonly Json[] = []): Json {
  return {
    metadata: { name, namespace: "shop", ...(owners.length === 0 ? {} : { ownerReferences: owners }) },
    spec: { containers },
  };
}

function podMetrics(name: string, usages: readonly [string, string, string][]): Json {
  return {
    metadata: { name, namespace: "shop" },
    timestamp: "2026-10-10T11:59:30Z",
    window: "30s",
    containers: usages.map(([container, cpu, memory]) => ({ name: container, usage: { cpu, memory } })),
  };
}

const named = (name: string, owners: readonly Json[] = []): Json => ({
  metadata: { name, namespace: "shop", ...(owners.length === 0 ? {} : { ownerReferences: owners }) },
});

const WEB_POD = pod(
  "web-1",
  [
    {
      name: "web",
      resources: { requests: { cpu: "500m", memory: "256Mi" }, limits: { cpu: "1", memory: "512Mi" } },
    },
    { name: "sidecar" },
  ],
  [owner("ReplicaSet", "web-5d9")],
);

const WEB_ROUTES: Readonly<Record<string, RouteAnswer>> = {
  [METRICS]: listAnswer([
    podMetrics("web-1", [
      ["web", "125m", "64Mi"],
      ["sidecar", "5m", "10Mi"],
    ]),
  ]),
  [PODS]: listAnswer([WEB_POD]),
  [REPLICA_SETS]: listAnswer([named("web-5d9", [owner("Deployment", "web")])]),
  [JOBS]: listAnswer([]),
};

/** A machine context over the console harness: the reading runs where `withMachineContext` puts it. */
function machineContext(answer: KubernetesAnswerFn) {
  const { context, transport } = consoleContext(answer);
  const machine: KubectlContext = { ...context, machine: { maxRows: 200, maxBytes: 262_144 } };
  return { context: machine, transport };
}

describe("readClusterUsage", () => {
  test("one row per container, joined by namespace, pod and container, numbers and ratios", async () => {
    const { context, transport } = machineContext(routes(WEB_ROUTES));
    const reading = await readClusterUsage(context, { namespace: "shop" });
    expect(sentLines(transport)).toEqual([METRICS, PODS, REPLICA_SETS, JOBS]);
    if (reading.kind !== "rows") throw new Error(`expected rows, got ${reading.kind}`);
    expect(reading.result.fields).toEqual([...CLUSTER_USAGE_FIELDS]);
    expect(reading.result.rowCount).toBe(2);
    expect(reading.result.rows).toEqual([
      {
        namespace: "shop",
        ownerKind: "Deployment",
        ownerName: "web",
        pod: "web-1",
        container: "web",
        cpuMillicores: 125,
        memoryBytes: 67_108_864,
        cpuRequestMillicores: 500,
        cpuLimitMillicores: 1000,
        memoryRequestBytes: 268_435_456,
        memoryLimitBytes: 536_870_912,
        cpuRequestRatio: 0.25,
        memoryRequestRatio: 0.25,
        window: "30s",
        timestamp: "2026-10-10T11:59:30Z",
      },
      {
        namespace: "shop",
        ownerKind: "Deployment",
        ownerName: "web",
        pod: "web-1",
        container: "sidecar",
        cpuMillicores: 5,
        memoryBytes: 10_485_760,
        cpuRequestMillicores: null,
        cpuLimitMillicores: null,
        memoryRequestBytes: null,
        memoryLimitBytes: null,
        cpuRequestRatio: null,
        memoryRequestRatio: null,
        window: "30s",
        timestamp: "2026-10-10T11:59:30Z",
      },
    ]);
  });

  test("a Job's pod reads under its CronJob, a bare pod under itself, and a pod without metrics reads null usage", async () => {
    const { context } = machineContext(
      routes({
        [METRICS]: listAnswer([podMetrics("report-1", [["run", "2m", "1Mi"]])]),
        [PODS]: listAnswer([
          pod("report-1", [{ name: "run", resources: { requests: { cpu: "0" } } }], [owner("Job", "report-28")]),
          pod("debug", [{ name: "shell" }]),
        ]),
        [REPLICA_SETS]: listAnswer([]),
        [JOBS]: listAnswer([named("report-28", [owner("CronJob", "report")])]),
      }),
    );
    const reading = await readClusterUsage(context, { namespace: "shop" });
    if (reading.kind !== "rows") throw new Error(`expected rows, got ${reading.kind}`);
    expect(reading.result.rows).toMatchObject([
      { ownerKind: "CronJob", ownerName: "report", pod: "report-1", cpuMillicores: 2, cpuRequestRatio: null },
      {
        ownerKind: "Pod",
        ownerName: "debug",
        pod: "debug",
        container: "shell",
        cpuMillicores: null,
        memoryBytes: null,
        window: null,
        timestamp: null,
      },
    ]);
  });

  test("where discovery serves no ReplicaSets or Jobs, a pod reads under the owner it names", async () => {
    const { context, transport } = machineContext(
      routes({
        "GET /apis": jsonAnswer(groupsWithout("apps", "batch")),
        [METRICS]: WEB_ROUTES[METRICS],
        [PODS]: WEB_ROUTES[PODS],
      }),
    );
    const reading = await readClusterUsage(context, { namespace: "shop" });
    expect(sentLines(transport)).toEqual([METRICS, PODS]);
    if (reading.kind !== "rows") throw new Error(`expected rows, got ${reading.kind}`);
    expect(reading.result.rows[0]).toMatchObject({ ownerKind: "ReplicaSet", ownerName: "web-5d9" });
  });

  test("a cluster without metrics.k8s.io answers metrics-unavailable and sends no metrics request", async () => {
    const { context, transport } = machineContext(
      routes({ "GET /apis": jsonAnswer(groupsWithout("metrics.k8s.io")), ...WEB_ROUTES }),
    );
    expect(await readClusterUsage(context, { namespace: "shop" })).toEqual({ kind: "metrics-unavailable" });
    expect(sentLines(transport)).toEqual([]);
  });

  test.each([
    ["answering 503", statusAnswer(503, "ServiceUnavailable")],
    ["unregistered since discovery, answering 404", statusAnswer(404, "NotFound")],
  ])("metrics.k8s.io registered but %s answers metrics-unavailable", async (_label, answer) => {
    const { context, transport } = machineContext(routes({ ...WEB_ROUTES, [METRICS]: answer }));
    expect(await readClusterUsage(context, { namespace: "shop" })).toEqual({ kind: "metrics-unavailable" });
    expect(sentLines(transport)).toEqual([METRICS]);
  });

  test("any other metrics failure is raised as the request's own error", async () => {
    const { context } = machineContext(routes({ ...WEB_ROUTES, [METRICS]: statusAnswer(403, "Forbidden") }));
    await expect(readClusterUsage(context, { namespace: "shop" })).rejects.toThrow("(403 Forbidden)");
  });

  test("a server that serves no core pods is refused in a sentence", async () => {
    const withoutPods = discoveryList([
      { versions: [{ version: "v1", resources: [resource("namespaces", "Namespace", "Cluster")] }] },
    ]);
    const { context } = machineContext(routes({ "GET /api": jsonAnswer(withoutPods), ...WEB_ROUTES }));
    await expect(readClusterUsage(context, { namespace: "shop" })).rejects.toThrow(
      "This server does not serve core pods.",
    );
  });

  test("an empty namespace answers zero rows", async () => {
    const { context } = machineContext(
      routes({
        [METRICS]: listAnswer([]),
        [PODS]: listAnswer([]),
        [REPLICA_SETS]: listAnswer([]),
        [JOBS]: listAnswer([]),
      }),
    );
    expect(await readClusterUsage(context, { namespace: "shop" })).toEqual({
      kind: "rows",
      result: { rows: [], fields: [...CLUSTER_USAGE_FIELDS], rowCount: 0, executionTime: 0 },
    });
  });

  test("more than 500 containers answers over-ceiling", async () => {
    const containers = Array.from({ length: 251 }, (_, index) => ({ name: `c${index}` }));
    const { context } = machineContext(
      routes({
        ...WEB_ROUTES,
        [PODS]: listAnswer([pod("a", containers), pod("b", containers)]),
      }),
    );
    expect(CLUSTER_READING_MAX_ROWS).toBe(500);
    expect(await readClusterUsage(context, { namespace: "shop" })).toEqual({ kind: "over-ceiling" });
  });

  test("a pod list past the ceiling answers over-ceiling without reading on", async () => {
    const { context, transport } = machineContext(
      routes({
        ...WEB_ROUTES,
        [PODS]: listAnswer(
          Array.from({ length: 500 }, (_, index) => pod(`p${index}`, [{ name: "c" }])),
          { continue: "next" },
        ),
        "GET /api/v1/namespaces/shop/pods?limit=1&continue=next": listAnswer([pod("p500", [{ name: "c" }])], {
          continue: "more",
        }),
      }),
    );
    expect(await readClusterUsage(context, { namespace: "shop" })).toEqual({ kind: "over-ceiling" });
    expect(sentLines(transport)).toEqual([
      METRICS,
      PODS,
      "GET /api/v1/namespaces/shop/pods?limit=1&continue=next",
      REPLICA_SETS,
      JOBS,
    ]);
  });

  test("a label selector reaches both list requests", async () => {
    const selected = (line: string) => line.replace("?limit=500", "?limit=500&labelSelector=app%3Dweb");
    const { context, transport } = machineContext(
      routes({
        [selected(METRICS)]: WEB_ROUTES[METRICS],
        [selected(PODS)]: WEB_ROUTES[PODS],
        [REPLICA_SETS]: WEB_ROUTES[REPLICA_SETS],
        [JOBS]: WEB_ROUTES[JOBS],
      }),
    );
    const reading = await readClusterUsage(context, { namespace: "shop", selector: "app=web" });
    expect(reading.kind).toBe("rows");
    expect(sentLines(transport)).toEqual([selected(METRICS), selected(PODS), REPLICA_SETS, JOBS]);
  });
});

describe("the provider's readClusterUsage", () => {
  const BUDGET = { statementTimeoutMs: 10_000, maxResultRows: 200, maxResultBytes: 262_144 };

  function providerWith(readOnly: boolean) {
    const cluster = fakeCluster({ lists: { "/api/v1/namespaces": [{ name: "default" }, { name: "shop" }] } });
    const usage = routes(WEB_ROUTES);
    const answer: KubernetesAnswerFn = (request, line) =>
      line in WEB_ROUTES ? usage(request, line) : cluster(request, line);
    const transport = recordingKubernetesTransport(answer);
    const provider = new KubernetesProvider(
      kubernetesConnection({ database: "shop" }),
      { queryTimeout: 30_000 },
      { ...testSeams(transport), sleep: () => new Promise<void>(() => {}) },
      { readOnly },
    );
    return { provider, transport };
  }

  test("refuses unless opened under the read-only profile, and is declared by agentReadings", async () => {
    const editor = providerWith(false);
    await editor.provider.connect();
    const before = editor.transport.calls.length;
    await expect(editor.provider.readClusterUsage({ namespace: "shop" }, BUDGET)).rejects.toThrow(
      MACHINE_PROFILE_SENTENCE,
    );
    expect(editor.transport.calls).toHaveLength(before);
    expect(editor.provider.getCapabilities().agentReadings).toEqual(["usage"]);

    const agent = providerWith(true);
    await agent.provider.connect();
    const reading = await agent.provider.readClusterUsage({ namespace: "shop" }, BUDGET);
    if (reading.kind !== "rows") throw new Error(`expected rows, got ${reading.kind}`);
    expect(reading.result.rows.map((row) => [row.ownerKind, row.ownerName, row.container])).toEqual([
      ["Deployment", "web", "web"],
      ["Deployment", "web", "sidecar"],
    ]);
  });

  test("refuses on a provider that is not connected", async () => {
    const { provider } = providerWith(true);
    await expect(provider.readClusterUsage({ namespace: "shop" }, BUDGET)).rejects.toThrow("Provider is not connected");
  });
});
