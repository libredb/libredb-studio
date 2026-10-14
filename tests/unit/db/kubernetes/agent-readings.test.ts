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
  readWorkloadProfile,
  WORKLOAD_PROFILE_FIELDS,
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

const DEPLOYMENTS = "GET /apis/apps/v1/namespaces/shop/deployments?limit=500";
const STATEFUL_SETS = "GET /apis/apps/v1/namespaces/shop/statefulsets?limit=500";
const DAEMON_SETS = "GET /apis/apps/v1/namespaces/shop/daemonsets?limit=500";
const CRON_JOBS = "GET /apis/batch/v1/namespaces/shop/cronjobs?limit=500";
const WARNING_EVENTS = "GET /api/v1/namespaces/shop/events?limit=500&fieldSelector=type%3DWarning";

/** Every list the workload profile reads, in the order it reads them. */
const PROFILE_LINES = [DEPLOYMENTS, STATEFUL_SETS, DAEMON_SETS, JOBS, CRON_JOBS, REPLICA_SETS, PODS, WARNING_EVENTS];

/** Each list the profile reads answering empty, but for those given. */
function profileRoutes(lists: Readonly<Record<string, readonly unknown[]>> = {}): Record<string, RouteAnswer> {
  return Object.fromEntries(PROFILE_LINES.map((line) => [line, listAnswer(lists[line] ?? [])]));
}

/** A controller with the pod template's containers. */
function controller(name: string, spec: Json, status: Json, containers: readonly Json[] = [{ name: "app" }]): Json {
  return {
    metadata: { name, namespace: "shop" },
    spec: { ...spec, template: { spec: { containers } } },
    status,
  };
}

/** A pod with its phase, Ready condition and container statuses. */
function livePod(
  name: string,
  owners: readonly Json[],
  state: { readonly ready?: boolean; readonly phase?: string; readonly statuses?: readonly Json[] } = {},
  containers: readonly Json[] = [{ name: "app" }],
): Json {
  return {
    ...pod(name, containers, owners),
    status: {
      phase: state.phase ?? "Running",
      conditions: [{ type: "Ready", status: state.ready === false ? "False" : "True" }],
      containerStatuses: state.statuses ?? [],
    },
  };
}

function warning(kind: string, name: string, reason: string, count?: number): Json {
  return {
    metadata: { name: `${name}.${reason}`, namespace: "shop" },
    type: "Warning",
    involvedObject: { kind, name, namespace: "shop" },
    reason,
    ...(count === undefined ? {} : { count }),
  };
}

const WEB_REPLICA_SET = named("web-5d9", [owner("Deployment", "web")]);

/** The profile row with nothing to report, for `toEqual` against the fields a test does not vary. */
const QUIET = {
  lastSchedule: null,
  podsNotReady: 0,
  restarts: 0,
  lastTerminationReason: null,
  lastTerminationAt: null,
  withoutRequests: 1,
  withoutLimits: 1,
  withoutReadinessProbe: 1,
  withoutLivenessProbe: 1,
  warningEvents: null,
};

async function profiled(answer: KubernetesAnswerFn) {
  const { context, transport } = machineContext(answer);
  const reading = await readWorkloadProfile(context, { namespace: "shop" });
  if (reading.kind !== "rows") throw new Error(`expected rows, got ${reading.kind}`);
  return { result: reading.result, transport };
}

describe("readWorkloadProfile", () => {
  test("a Deployment's pods are found through their ReplicaSet, and its desired and ready are its own", async () => {
    const { result, transport } = await profiled(
      routes(
        profileRoutes({
          [DEPLOYMENTS]: [controller("web", { replicas: 3 }, { readyReplicas: 2 })],
          [REPLICA_SETS]: [WEB_REPLICA_SET],
          [PODS]: [
            livePod("web-1", [owner("ReplicaSet", "web-5d9")]),
            livePod("web-2", [owner("ReplicaSet", "web-5d9")], { ready: false }),
          ],
        }),
      ),
    );
    expect(sentLines(transport)).toEqual(PROFILE_LINES);
    expect(result.fields).toEqual([...WORKLOAD_PROFILE_FIELDS]);
    // One pod not Ready, and one of the three desired has no pod at all.
    expect(result.rows).toEqual([{ kind: "Deployment", name: "web", desired: 3, ready: 2, ...QUIET, podsNotReady: 2 }]);
    expect(result.rowCount).toBe(1);
  });

  test("a Deployment with replicas above zero and no pods is a row, all its pods missing", async () => {
    const { result } = await profiled(
      routes(
        profileRoutes({
          [DEPLOYMENTS]: [controller("api", { replicas: 2 }, {}), controller("idle", { replicas: 0 }, {})],
          [STATEFUL_SETS]: [controller("db", {}, {})],
        }),
      ),
    );
    expect(result.rows).toEqual([
      { kind: "Deployment", name: "api", desired: 2, ready: 0, ...QUIET, podsNotReady: 2 },
      { kind: "Deployment", name: "idle", desired: 0, ready: 0, ...QUIET },
      // A StatefulSet without `spec.replicas` wants the API server's default of one.
      { kind: "StatefulSet", name: "db", desired: 1, ready: 0, ...QUIET, podsNotReady: 1 },
    ]);
  });

  test("DaemonSet desired and ready scheduled; Job completions and succeeded; CronJob active and last schedule", async () => {
    const { result } = await profiled(
      routes(
        profileRoutes({
          [DAEMON_SETS]: [controller("agent", {}, { desiredNumberScheduled: 3, numberReady: 2 })],
          [JOBS]: [controller("migrate", { completions: 5 }, { succeeded: 4 }), controller("once", {}, {})],
          [CRON_JOBS]: [
            {
              metadata: { name: "report", namespace: "shop" },
              spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: "run" }] } } } } },
              status: {
                active: [{ name: "report-28" }, { name: "report-29" }],
                lastScheduleTime: "2026-10-10T11:00:00Z",
              },
            },
            { metadata: { name: "nightly", namespace: "shop" }, spec: {}, status: {} },
          ],
        }),
      ),
    );
    expect(result.rows).toEqual([
      {
        kind: "CronJob",
        name: "nightly",
        desired: 0,
        ready: null,
        ...QUIET,
        withoutRequests: 0,
        withoutLimits: 0,
        withoutReadinessProbe: 0,
        withoutLivenessProbe: 0,
      },
      { kind: "CronJob", name: "report", desired: 2, ready: null, ...QUIET, lastSchedule: "2026-10-10T11:00:00Z" },
      // A DaemonSet with no pods is not missing any: its desired count is what the scheduler placed.
      { kind: "DaemonSet", name: "agent", desired: 3, ready: 2, ...QUIET },
      { kind: "Job", name: "migrate", desired: 5, ready: 4, ...QUIET },
      { kind: "Job", name: "once", desired: 1, ready: 0, ...QUIET },
    ]);
  });

  test("a Job's pods count under the Job, and the Job under its CronJob's active count", async () => {
    const { result } = await profiled(
      routes(
        profileRoutes({
          [JOBS]: [
            {
              ...controller("report-28", {}, {}),
              metadata: { name: "report-28", ownerReferences: [owner("CronJob", "report")] },
            },
            {
              ...controller("report-27", {}, { succeeded: 1 }),
              metadata: { name: "report-27", ownerReferences: [owner("CronJob", "report")] },
            },
          ],
          [CRON_JOBS]: [
            {
              metadata: { name: "report", namespace: "shop" },
              spec: { jobTemplate: { spec: { template: { spec: { containers: [{ name: "run" }] } } } } },
              status: { active: [{ name: "report-28" }] },
            },
          ],
          [PODS]: [
            livePod("report-28-x", [owner("Job", "report-28")], { ready: false }),
            // A pod that ran to completion is not Ready, and is not a pod that should be.
            livePod("report-27-x", [owner("Job", "report-27")], { ready: false, phase: "Succeeded" }),
          ],
        }),
      ),
    );
    expect(result.rows).toEqual([
      { kind: "CronJob", name: "report", desired: 1, ready: null, ...QUIET },
      { kind: "Job", name: "report-27", desired: 1, ready: 1, ...QUIET },
      { kind: "Job", name: "report-28", desired: 1, ready: 0, ...QUIET, podsNotReady: 1 },
    ]);
  });

  test("restarts are cumulative, with the latest termination's reason and time", async () => {
    const terminated = (restartCount: number, reason: string, finishedAt: string) => ({
      name: "app",
      restartCount,
      lastState: { terminated: { reason, finishedAt } },
    });
    const { result } = await profiled(
      routes(
        profileRoutes({
          [DEPLOYMENTS]: [controller("web", { replicas: 2 }, { readyReplicas: 2 })],
          [STATEFUL_SETS]: [controller("db", { replicas: 1 }, { readyReplicas: 1 })],
          [REPLICA_SETS]: [WEB_REPLICA_SET],
          [PODS]: [
            livePod("web-1", [owner("ReplicaSet", "web-5d9")], {
              statuses: [
                terminated(2, "OOMKilled", "2026-10-10T11:00:00Z"),
                terminated(1, "Error", "2026-10-10T11:30:00Z"),
              ],
            }),
            livePod("web-2", [owner("ReplicaSet", "web-5d9")], {
              statuses: [terminated(4, "Completed", "2026-10-10T10:00:00Z"), { name: "side", lastState: {} }],
            }),
            livePod("db-0", [owner("StatefulSet", "db")], {
              statuses: [{ name: "app", restartCount: 0, lastState: {} }],
            }),
          ],
        }),
      ),
    );
    expect(result.rows).toEqual([
      {
        kind: "Deployment",
        name: "web",
        desired: 2,
        ready: 2,
        ...QUIET,
        restarts: 7,
        lastTerminationReason: "Error",
        lastTerminationAt: "2026-10-10T11:30:00Z",
      },
      { kind: "StatefulSet", name: "db", desired: 1, ready: 1, ...QUIET },
    ]);
  });

  test("containers without requests, limits, readiness or liveness probes are counted from the template", async () => {
    const containers = [
      {
        name: "full",
        resources: { requests: { cpu: "100m" }, limits: { cpu: "1" } },
        readinessProbe: { httpGet: { path: "/ready", port: 8080 } },
        livenessProbe: { httpGet: { path: "/live", port: 8080 } },
      },
      { name: "empty", resources: { requests: {}, limits: {} }, readinessProbe: { tcpSocket: { port: 5432 } } },
      { name: "bare" },
    ];
    const { result } = await profiled(
      routes(profileRoutes({ [DEPLOYMENTS]: [controller("web", { replicas: 0 }, {}, containers)] })),
    );
    expect(result.rows).toEqual([
      {
        kind: "Deployment",
        name: "web",
        desired: 0,
        ready: 0,
        ...QUIET,
        withoutRequests: 2,
        withoutLimits: 2,
        withoutReadinessProbe: 1,
        withoutLivenessProbe: 2,
      },
    ]);
  });

  test("Warning events are counted by reason against the workload their object belongs to", async () => {
    const { result } = await profiled(
      routes(
        profileRoutes({
          [DEPLOYMENTS]: [
            controller("web", { replicas: 1 }, { readyReplicas: 1 }),
            controller("api", { replicas: 0 }, {}),
          ],
          [JOBS]: [controller("migrate", {}, {})],
          [REPLICA_SETS]: [WEB_REPLICA_SET, named("orphan-1")],
          [PODS]: [livePod("web-1", [owner("ReplicaSet", "web-5d9")])],
          [WARNING_EVENTS]: [
            warning("Pod", "web-1", "BackOff", 3),
            warning("ReplicaSet", "web-5d9", "FailedCreate"),
            warning("Deployment", "web", "ProgressDeadlineExceeded", 1),
            warning("Pod", "web-1", "Unhealthy", 2),
            warning("Job", "migrate", "BackoffLimitExceeded"),
            // A pod that is gone, and a ReplicaSet no Deployment owns, belong to no workload listed.
            warning("Pod", "web-0", "BackOff", 9),
            warning("ReplicaSet", "orphan-1", "FailedCreate"),
          ],
        }),
      ),
    );
    expect(result.rows.map((row) => [row.kind, row.name, row.warningEvents])).toEqual([
      ["Deployment", "api", null],
      ["Deployment", "web", "BackOff=3, FailedCreate=1, ProgressDeadlineExceeded=1, Unhealthy=2"],
      ["Job", "migrate", "BackoffLimitExceeded=1"],
    ]);
  });

  test("a bare Pod is its own row", async () => {
    const { result } = await profiled(
      routes(
        profileRoutes({
          [PODS]: [
            livePod("debug", [], {}, [{ name: "shell", livenessProbe: { exec: { command: ["true"] } } }]),
            livePod("probe", [], { ready: false, statuses: [{ name: "app", restartCount: 1 }] }),
          ],
          [WARNING_EVENTS]: [warning("Pod", "probe", "Failed")],
        }),
      ),
    );
    expect(result.rows).toEqual([
      { kind: "Pod", name: "debug", desired: 1, ready: 1, ...QUIET, withoutLivenessProbe: 0 },
      {
        kind: "Pod",
        name: "probe",
        desired: 1,
        ready: 0,
        ...QUIET,
        podsNotReady: 1,
        restarts: 1,
        warningEvents: "Failed=1",
      },
    ]);
  });

  test("an empty namespace answers zero rows", async () => {
    const { context } = machineContext(routes(profileRoutes()));
    expect(await readWorkloadProfile(context, { namespace: "shop" })).toEqual({
      kind: "rows",
      result: { rows: [], fields: [...WORKLOAD_PROFILE_FIELDS], rowCount: 0, executionTime: 0 },
    });
  });

  test("a resource discovery does not serve is read as an empty list, and never requested", async () => {
    const { result, transport } = await profiled(
      routes({
        "GET /apis": jsonAnswer(groupsWithout("apps", "batch")),
        ...profileRoutes({ [PODS]: [livePod("debug", [])] }),
      }),
    );
    expect(sentLines(transport)).toEqual([PODS, WARNING_EVENTS]);
    expect(result.rows.map((row) => [row.kind, row.name])).toEqual([["Pod", "debug"]]);
  });

  test("more than 500 workloads, or a component list past one statement's read, answers over-ceiling", async () => {
    const many = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => controller(`${prefix}-${index}`, { replicas: 0 }, {}));
    const wide = machineContext(
      routes(profileRoutes({ [DEPLOYMENTS]: many("web", 300), [STATEFUL_SETS]: many("db", 201) })),
    );
    expect(CLUSTER_READING_MAX_ROWS).toBe(500);
    expect(await readWorkloadProfile(wide.context, { namespace: "shop" })).toEqual({ kind: "over-ceiling" });

    // Exactly 500 workloads is within the ceiling.
    const full = machineContext(
      routes(profileRoutes({ [DEPLOYMENTS]: many("web", 300), [STATEFUL_SETS]: many("db", 200) })),
    );
    expect((await readWorkloadProfile(full.context, { namespace: "shop" })).kind).toBe("rows");

    // A ReplicaSet list that never ends is past one statement's read of 5,000.
    const replicaSetPath = "GET /apis/apps/v1/namespaces/shop/replicasets?";
    const base = routes(profileRoutes());
    const endless: KubernetesAnswerFn = (request, line) => {
      if (!line.startsWith(replicaSetPath)) return base(request, line);
      const limit = Number(/limit=(\d+)/.exec(line)?.[1]);
      const page = Number(/continue=(\d+)/.exec(line)?.[1] ?? "0");
      return listAnswer(
        Array.from({ length: limit }, (_, index) => named(`rs-${page}-${index}`)),
        { continue: String(page + 1) },
      );
    };
    const long = machineContext(endless);
    expect(await readWorkloadProfile(long.context, { namespace: "shop" })).toEqual({ kind: "over-ceiling" });
    // Ten pages of 500, the last still naming a continue token, and the read stops there.
    expect(sentLines(long.transport).filter((line) => line.startsWith(replicaSetPath))).toHaveLength(10);
  });
});

describe("the provider's readClusterUsage", () => {
  const BUDGET = { statementTimeoutMs: 10_000, maxResultRows: 200, maxResultBytes: 262_144 };

  function providerWith(readOnly: boolean, served: Readonly<Record<string, RouteAnswer>> = WEB_ROUTES) {
    const cluster = fakeCluster({ lists: { "/api/v1/namespaces": [{ name: "default" }, { name: "shop" }] } });
    const usage = routes(served);
    const answer: KubernetesAnswerFn = (request, line) =>
      line in served ? usage(request, line) : cluster(request, line);
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
    expect(editor.provider.getCapabilities().agentReadings).toEqual(["usage", "workloads"]);

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

  test("readWorkloadProfile refuses unless opened under the read-only profile, and reads in the machine context", async () => {
    const served = profileRoutes({
      [DEPLOYMENTS]: [controller("web", { replicas: 1 }, { readyReplicas: 1 })],
      [REPLICA_SETS]: [WEB_REPLICA_SET],
      [PODS]: [livePod("web-1", [owner("ReplicaSet", "web-5d9")])],
    });
    const editor = providerWith(false, served);
    await editor.provider.connect();
    const before = editor.transport.calls.length;
    await expect(editor.provider.readWorkloadProfile({ namespace: "shop" }, BUDGET)).rejects.toThrow(
      MACHINE_PROFILE_SENTENCE,
    );
    expect(editor.transport.calls).toHaveLength(before);

    const agent = providerWith(true, served);
    await agent.provider.connect();
    const reading = await agent.provider.readWorkloadProfile({ namespace: "shop" }, BUDGET);
    if (reading.kind !== "rows") throw new Error(`expected rows, got ${reading.kind}`);
    expect(reading.result.rows.map((row) => [row.kind, row.name, row.ready])).toEqual([["Deployment", "web", 1]]);
  });
});
