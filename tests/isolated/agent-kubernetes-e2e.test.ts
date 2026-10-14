import { afterAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createLocalWorld } from "@workflow/world-local";
import { persistedRunFacts, workflowAvailability } from "@/lib/agent/agent-manifest";
import { forgetHeldSnapshots } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { runInvestigation } from "@/lib/agent/investigation";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import { AgentRunService } from "@/lib/agent/run-service";
import { AgentRunStore } from "@/lib/agent/run-store";
import type { AgentRunEvent, AgentRunWorkflowType } from "@/lib/agent/types";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { KubernetesProvider } from "@/lib/db/providers/platform/kubernetes/index";
import type { QueryResult } from "@/lib/types";
import { fakeCluster } from "../helpers/kubernetes-cluster";
import { kubernetesConnection } from "../helpers/kubernetes-connection";
import { listAnswer, type RouteAnswer, tableAnswer } from "../helpers/kubernetes-console";
import { KUBERNETES_SAMPLE_MARKERS as M } from "../helpers/kubernetes-markers";
import {
  type KubernetesAnswerFn,
  recordingKubernetesTransport,
  statusAnswer,
  testSeams,
} from "../helpers/kubernetes-transport";
import {
  callsTool,
  correlationIdsIn,
  modelOver,
  promptText,
  reportCitingWhatWasOffered,
  reportOnAll,
  type ScriptedTurn,
  scriptedModel,
  type Turn,
} from "./fixtures/agent-scripted-model";

/**
 * One agent run per Kubernetes workflow, each scored by its own verifier, against a fake API server.
 *
 * `driveAgentRun` resolves its model from the environment and its connection from the seed store, and a fake API
 * server replaces neither; it calls `runInvestigation`, so these runs drive `runInvestigation` itself, with a real
 * `KubernetesProvider` behind `acquireProvider`. Nothing between the loop and the server is stubbed: the provider is
 * opened under the read-only profile (`{ readOnly: true }`) and runs whole, its admission, its machine redaction and its
 * two readings included, over the recording transport. Only the API server is synthesized: `fakeCluster` answers
 * discovery, lists and objects, and the lines the usage reading and the workload profile send are answered by exact
 * request line, as the provider's own reading tests answer them.
 *
 * Each run is opened the way the start route opens it: the workflow's availability on `kubernetes`, and the language
 * and verifier `persistedRunFacts` writes to the record, so the verdict each test asserts is the variant's own.
 *
 * The fake server plants the sample data's markers where a real server carries them: the Deployment's env, an
 * annotation on every object, the ConfigMap's data, the Secret's name and its value. The last test reads each of them
 * and holds every model turn of every run in this file to carrying none.
 */

const NAMESPACE = "shop";
const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";
const SECRET_VALUE_BASE64 = Buffer.from(M.secretValue, "utf8").toString("base64");

/** The planted metadata every object the server answers carries. */
const PLANTED_METADATA = {
  annotations: {
    [M.annotationKey]: M.annotationValue,
    [LAST_APPLIED]: JSON.stringify({ stringData: { [M.secretKey]: M.secretValue } }),
  },
};

const METRICS = "GET /apis/metrics.k8s.io/v1beta1/namespaces/shop/pods?limit=500";
const PODS = "GET /api/v1/namespaces/shop/pods?limit=500";
const REPLICA_SETS = "GET /apis/apps/v1/namespaces/shop/replicasets?limit=500";
const JOBS = "GET /apis/batch/v1/namespaces/shop/jobs?limit=500";
const DEPLOYMENTS = "GET /apis/apps/v1/namespaces/shop/deployments?limit=500";
const STATEFUL_SETS = "GET /apis/apps/v1/namespaces/shop/statefulsets?limit=500";
const DAEMON_SETS = "GET /apis/apps/v1/namespaces/shop/daemonsets?limit=500";
const CRON_JOBS = "GET /apis/batch/v1/namespaces/shop/cronjobs?limit=500";
const WARNING_EVENTS = "GET /api/v1/namespaces/shop/events?limit=500&fieldSelector=type%3DWarning";

/** The same line narrowed by the label selector `app=web`, which reaches the metrics and pod lists. */
const selected = (line: string): string => line.replace("?limit=500", "?limit=500&labelSelector=app%3Dweb");

type Json = Record<string, unknown>;

const owner = (kind: string, name: string): Json => ({
  kind,
  name,
  controller: true,
  apiVersion: "v1",
  uid: `uid-${name}`,
});

/** The web Deployment's pod: one container with requests and limits, under its ReplicaSet. */
const WEB_POD: Json = {
  metadata: { name: "web-1", namespace: NAMESPACE, ownerReferences: [owner("ReplicaSet", "web-5d9")] },
  spec: {
    containers: [
      {
        name: "web",
        resources: { requests: { cpu: "500m", memory: "256Mi" }, limits: { cpu: "1", memory: "512Mi" } },
      },
    ],
  },
  status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }], containerStatuses: [] },
};

const WEB_METRICS: Json = {
  metadata: { name: "web-1", namespace: NAMESPACE },
  timestamp: "2026-10-14T09:00:00Z",
  window: "30s",
  containers: [{ name: "web", usage: { cpu: "125m", memory: "64Mi" } }],
};

const WEB_REPLICA_SET: Json = {
  metadata: { name: "web-5d9", namespace: NAMESPACE, ownerReferences: [owner("Deployment", "web")] },
};

const WEB_DEPLOYMENT: Json = {
  metadata: { name: "web", namespace: NAMESPACE },
  spec: { replicas: 1, template: { spec: { containers: [{ name: "web" }] } } },
  status: { readyReplicas: 1 },
};

/** The usage reading's lines over the web Deployment. */
const USAGE_ROUTES: Readonly<Record<string, RouteAnswer>> = {
  [METRICS]: listAnswer([WEB_METRICS]),
  [PODS]: listAnswer([WEB_POD]),
  [REPLICA_SETS]: listAnswer([WEB_REPLICA_SET]),
  [JOBS]: listAnswer([]),
};

/** The workload profile's lines, each answering empty but for those given. */
function profileRoutes(lists: Readonly<Record<string, readonly unknown[]>> = {}): Record<string, RouteAnswer> {
  const lines = [DEPLOYMENTS, STATEFUL_SETS, DAEMON_SETS, JOBS, CRON_JOBS, REPLICA_SETS, PODS, WARNING_EVENTS];
  return Object.fromEntries(lines.map((line) => [line, listAnswer(lists[line] ?? [])]));
}

const WEB_PROFILE = profileRoutes({
  [DEPLOYMENTS]: [WEB_DEPLOYMENT],
  [REPLICA_SETS]: [WEB_REPLICA_SET],
  [PODS]: [WEB_POD],
});

/**
 * The cluster every run reads: the namespaces, the shop namespace's pods, Deployment, ConfigMap and Secret listed by
 * name, and each object answered whole with the planted values on it.
 */
const cluster = fakeCluster({
  lists: {
    "/api/v1/namespaces": [{ name: "default" }, { name: NAMESPACE }],
    "/api/v1/namespaces/shop/pods": [{ name: "web-1", ready: "1/1", status: "Running" }],
    "/apis/apps/v1/namespaces/shop/deployments": [{ name: "web" }],
    "/api/v1/namespaces/shop/configmaps": [{ name: "shop-config" }],
    "/api/v1/namespaces/shop/secrets": [{ name: M.secretName }],
    "/api/v1/namespaces/shop/events": [],
  },
  objects: {
    "/apis/apps/v1/namespaces/shop/deployments/web": {
      kind: "Deployment",
      apiVersion: "apps/v1",
      metadata: { name: "web", namespace: NAMESPACE, ...PLANTED_METADATA },
      spec: {
        replicas: 1,
        template: { spec: { containers: [{ name: "web", env: [{ name: "MARKER_ENV", value: M.envValue }] }] } },
      },
    },
    "/api/v1/namespaces/shop/configmaps/shop-config": {
      kind: "ConfigMap",
      apiVersion: "v1",
      metadata: { name: "shop-config", namespace: NAMESPACE, ...PLANTED_METADATA },
      data: { [M.configMapKey]: M.configMapValue },
    },
    [`/api/v1/namespaces/shop/secrets/${M.secretName}`]: {
      kind: "Secret",
      apiVersion: "v1",
      metadata: { name: M.secretName, namespace: NAMESPACE, ...PLANTED_METADATA },
      type: "Opaque",
      data: { [M.secretKey]: SECRET_VALUE_BASE64 },
      stringData: { [M.secretKey]: M.secretValue },
    },
  },
});

const dataDirs: string[] = [];

/** Every request every run in this file made to its model, for the last test. */
const everyTurn: Turn[] = [];

afterAll(() => {
  for (const dir of dataDirs) fs.rmSync(dir, { recursive: true, force: true });
});

interface Drive {
  readonly turns: readonly Turn[];
  readonly events: readonly AgentRunEvent[];
}

/**
 * One agent-mode run of `workflowType` on a Kubernetes connection, opened as the start route opens it and driven by
 * `turns` through `runInvestigation`, against a provider opened read-only over the fake server, whose usage and
 * profile lines `served` answers by exact request line.
 */
async function drive(
  workflowType: AgentRunWorkflowType,
  turns: readonly ScriptedTurn[],
  served: Readonly<Record<string, RouteAnswer>> = {},
): Promise<Drive> {
  // A cold process per run: a run on a connection an earlier run read is grounded on that reading instead.
  forgetHeldSnapshots();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-kubernetes-e2e-"));
  dataDirs.push(dataDir);
  const connection = kubernetesConnection({ id: "conn_k8s", database: NAMESPACE });
  const answer: KubernetesAnswerFn = (request, line) => {
    const routed = served[line];
    if (routed !== undefined) return typeof routed === "function" ? routed(request) : routed;
    // A describe reads its object as a Table first, and its events as a plain list where the tree reads a Table.
    if (line === `GET /api/v1/namespaces/shop/secrets/${M.secretName}?includeObject=None`) {
      return tableAnswer(
        [{ name: "Name" }, { name: "Type" }, { name: "Data", type: "integer" }],
        [{ cells: [M.secretName, "Opaque", 1] }],
      );
    }
    const url = new URL(request.url);
    if (url.pathname.endsWith("/events") && url.searchParams.get("fieldSelector")?.startsWith("involvedObject.")) {
      return listAnswer([]);
    }
    return cluster(request, line);
  };
  const provider = new KubernetesProvider(
    connection,
    { queryTimeout: 30_000 },
    // A sleep that never ends: the machine read races its statement time against it, and the test seams' immediate
    // sleep would expire every read before it was sent.
    { ...testSeams(recordingKubernetesTransport(answer)), sleep: () => new Promise<void>(() => {}) },
    { readOnly: true },
  );
  await provider.connect();

  const store = new AgentRunStore({ world: createLocalWorld({ dataDir, recoverActiveRuns: false }) });
  const tracker = new ExecutionBudgetTracker();
  const artifacts = new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 });
  const service = new AgentRunService({ store, resources: { tracker, artifacts } });
  const availability = workflowAvailability("agent", workflowType, "kubernetes");
  if (!availability.open) throw new Error(`${workflowType} does not open on kubernetes`);
  const run = await service.start({
    mode: "agent",
    workflowType,
    ...persistedRunFacts("agent", workflowType, availability),
    actor: { sessionId: "sess_1", role: "user" },
    connectionId: connection.id,
    objective: "How are the workloads in shop doing?",
  });
  const script = scriptedModel(...turns);

  await runInvestigation(run.runId, {
    service,
    model: await modelOver(script.fetch),
    resources: {
      connection,
      capabilities: provider.getCapabilities(),
      labels: provider.getLabels(),
      registry: createCanonicalOperationRegistry(),
      scope: createTargetScope(connection.id),
      tracker,
      artifacts,
      deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS[workflowType].runDeadlineMs, () => 10_000),
      repairs: new AgentRepairLedger(),
      acquireProvider: async () => provider,
    },
  });
  await provider.disconnect();
  everyTurn.push(...script.turns);

  const view = await store.read(run.runId);
  if (!view) throw new Error(`run ${run.runId} has no ledger`);
  expect(view.record.statementLanguage).toBe("kubectl");
  return { turns: script.turns, events: view.record.events };
}

/** The run's settled verdict. */
function verdictOf(events: readonly AgentRunEvent[]) {
  const finished = events.find((event) => event.kind === "run-finished");
  if (finished?.kind !== "run-finished") throw new Error("the run did not finish");
  return finished.goalVerdict;
}

/** The correlation id of the latest artifact the transcript holds, taken from it as a model would take it. */
function latestArtifact(turn: Turn): string {
  const latest = correlationIdsIn(turn.transcript).at(-1);
  if (latest === undefined)
    throw new Error(`no artifact reference in the transcript: ${turn.transcript.slice(0, 400)}`);
  return latest;
}

/** `present_answer` on the latest artifact, as a table. */
const presentsLatestAsTable: ScriptedTurn = (turn) =>
  callsTool("present_answer", { artifact: latestArtifact(turn), presentation: { kind: "table" } }, "call_answer")(turn);

/** A resources recommendation for the web container, citing the latest artifact. */
const recommendsSmallerRequests: ScriptedTurn = (turn) =>
  callsTool(
    "recommend_change",
    {
      change: "resources",
      namespace: NAMESPACE,
      ownerKind: "Deployment",
      ownerName: "web",
      container: "web",
      current: { requests: { cpu: "500m", memory: "256Mi" }, limits: { cpu: "1", memory: "512Mi" } },
      proposed: { requests: { cpu: "150m", memory: "128Mi" }, limits: { cpu: "500m", memory: "256Mi" } },
      rationale: "The web container uses a quarter of the CPU and memory it requests.",
      evidence: [{ source: "artifact", correlationId: latestArtifact(turn) }],
    },
    "call_recommend",
  )(turn);

/** The operations each run settled, in order. */
const completed = (events: readonly AgentRunEvent[]): string[] =>
  events.flatMap((event) => (event.kind === "tool-completed" ? [event.artifact.operationId] : []));

describe("agent runs on a Kubernetes connection, scored by their own verifiers", () => {
  test("investigation: get pods, then a report citing it, answers", async () => {
    const run = await drive("investigation", [
      callsTool("run_read_query", { statement: "get pods" }, "call_pods"),
      reportOnAll("One pod, web-1, runs in shop and is ready."),
    ]);

    expect(completed(run.events)).toEqual(["kubectl.query.read"]);
    expect(promptText(run.turns[1] as Turn)).toContain("web-1");
    expect(verdictOf(run.events)).toMatchObject({ outcome: "answered", verifier: "agent-investigation.1" });
  });

  test("data-analysis: get pods, present_answer as a table, a report citing it, answers", async () => {
    const run = await drive("data-analysis", [
      callsTool("run_read_query", { statement: "get pods" }, "call_pods"),
      presentsLatestAsTable,
      reportOnAll("One pod, web-1, runs in shop and is ready."),
    ]);

    const answer = run.events.find((event) => event.kind === "answer-composed");
    expect(answer).toMatchObject({ kind: "answer-composed", sql: "get pods", presentation: { kind: "table" } });
    expect(verdictOf(run.events)).toMatchObject({ outcome: "answered", verifier: "agent-data-analysis.1" });
  });

  test("resource efficiency: inspect_usage, a resources recommendation citing it, a report, answers", async () => {
    const run = await drive(
      "query-optimization",
      [
        callsTool("inspect_usage", { namespace: NAMESPACE }, "call_usage"),
        recommendsSmallerRequests,
        reportOnAll("The web container requests four times the CPU and memory it uses."),
      ],
      USAGE_ROUTES,
    );

    expect(run.events.filter((event) => event.kind === "usage-read")).toHaveLength(1);
    expect(run.events.find((event) => event.kind === "recommendation")).toMatchObject({ change: "resources" });
    expect(verdictOf(run.events)).toMatchObject({
      outcome: "answered",
      verifier: "agent-query-optimization-kubectl.1",
    });
  });

  test("resource efficiency, nothing to change: inspect_usage, a report citing it, answers", async () => {
    const run = await drive(
      "query-optimization",
      [
        callsTool("inspect_usage", { namespace: NAMESPACE }, "call_usage"),
        reportOnAll("The web container is sized to what it uses, so nothing needs to change."),
      ],
      USAGE_ROUTES,
    );

    expect(run.events.some((event) => event.kind === "recommendation")).toBe(false);
    expect(verdictOf(run.events)).toMatchObject({
      outcome: "answered",
      verifier: "agent-query-optimization-kubectl.1",
    });
  });

  test("resource efficiency without metrics-server: usage-unavailable, a report, unanswered no-usage-metrics", async () => {
    // metrics.k8s.io registered in discovery, its backend down: the aggregated API answers 503.
    const run = await drive(
      "query-optimization",
      [
        callsTool("inspect_usage", { namespace: NAMESPACE }, "call_usage"),
        reportCitingWhatWasOffered("This cluster serves no usage metrics."),
      ],
      { ...USAGE_ROUTES, [METRICS]: statusAnswer(503, "ServiceUnavailable") },
    );

    expect(run.events.filter((event) => event.kind === "usage-unavailable")).toEqual([
      expect.objectContaining({ kind: "usage-unavailable", namespace: NAMESPACE }),
    ]);
    expect(promptText(run.turns[1] as Turn)).toContain("metrics-server");
    expect(verdictOf(run.events)).toMatchObject({
      outcome: "unanswered",
      verifier: "agent-query-optimization-kubectl.1",
      unmet: ["no-usage-metrics"],
    });
  });

  test("cluster health: profile_workloads, a report citing it, answers", async () => {
    const run = await drive(
      "database-assessment",
      [
        callsTool("profile_workloads", { namespace: NAMESPACE }, "call_profile"),
        reportOnAll("Deployment web has its one pod ready."),
      ],
      WEB_PROFILE,
    );

    expect(run.events.filter((event) => event.kind === "workloads-profiled")).toHaveLength(1);
    expect(promptText(run.turns[1] as Turn)).toContain("web");
    expect(verdictOf(run.events)).toMatchObject({
      outcome: "answered",
      verifier: "agent-database-assessment-kubectl.1",
    });
  });

  test("cluster health on an empty namespace: an empty profile cited answers", async () => {
    const run = await drive(
      "database-assessment",
      [
        callsTool("profile_workloads", { namespace: NAMESPACE }, "call_profile"),
        reportOnAll("The shop namespace holds no workloads."),
      ],
      profileRoutes(),
    );

    const profile = run.events.find((event) => event.kind === "workloads-profiled");
    expect(profile).toMatchObject({ artifact: { summary: { rowCount: 0 } } });
    expect(verdictOf(run.events)).toMatchObject({
      outcome: "answered",
      verifier: "agent-database-assessment-kubectl.1",
    });
  });

  test("a namespace above the usage ceiling is refused, and the run is told to narrow", async () => {
    // One pod of 501 containers: one row past the 500-row ceiling. The selector app=web reads the web pod alone.
    const crowded: Json = {
      metadata: { name: "crowded-1", namespace: NAMESPACE },
      spec: { containers: Array.from({ length: 501 }, (_, index) => ({ name: `c${index}` })) },
    };
    const run = await drive(
      "query-optimization",
      [
        callsTool("inspect_usage", { namespace: NAMESPACE }, "call_usage"),
        callsTool("inspect_usage", { namespace: NAMESPACE, selector: "app=web" }, "call_usage_2"),
        reportOnAll("The web container requests four times the CPU and memory it uses."),
      ],
      {
        ...USAGE_ROUTES,
        [PODS]: listAnswer([crowded, WEB_POD]),
        [selected(METRICS)]: listAnswer([WEB_METRICS]),
        [selected(PODS)]: listAnswer([WEB_POD]),
      },
    );

    expect(promptText(run.turns[1] as Turn)).toContain(
      "That reading holds more than 500 rows, the most it may carry, so none of it was kept. Ask again narrowed by a label selector, or for a smaller namespace.",
    );
    const reads = run.events.filter((event) => event.kind === "usage-read");
    expect(reads).toEqual([expect.objectContaining({ namespace: NAMESPACE, selector: "app=web" })]);
    expect(verdictOf(run.events)).toMatchObject({
      outcome: "answered",
      verifier: "agent-query-optimization-kubectl.1",
    });
  });

  test("no planted value reaches any model turn in any of these runs", async () => {
    const run = await drive("investigation", [
      callsTool("run_read_query", { statement: "get deploy web -o yaml" }, "call_deploy"),
      callsTool("run_read_query", { statement: "get secrets" }, "call_secrets"),
      callsTool("run_read_query", { statement: `describe secret ${M.secretName}` }, "call_describe"),
      callsTool("run_read_query", { statement: "get configmap shop-config -o yaml" }, "call_config"),
      reportOnAll("Deployment web reads its configuration from shop-config, and shop holds one Secret."),
    ]);

    // The control: every read settled and reached the model, and what it masked reached it as the mask.
    expect(completed(run.events)).toEqual([
      "kubectl.query.read",
      "kubectl.query.read",
      "kubectl.query.read",
      "kubectl.query.read",
    ]);
    const last = promptText(run.turns.at(-1) as Turn);
    expect(last).toContain("shop-config");
    expect(last).toContain("MARKER_ENV");
    expect(last).toContain("<redacted>");
    expect(verdictOf(run.events)).toMatchObject({ outcome: "answered", verifier: "agent-investigation.1" });

    // Every run of this file, this one included. The model's own messages are left out: the scripted model wrote the
    // Secret's name into its own describe, which no answer of the server handed it.
    expect(everyTurn.length).toBeGreaterThanOrEqual(run.turns.length);
    const planted = [M.envValue, M.annotationValue, M.configMapValue, M.secretName, M.secretValue, SECRET_VALUE_BASE64];
    for (const [index, turn] of everyTurn.entries()) {
      const handed = JSON.stringify(
        ((turn.body.messages ?? []) as { role?: string }[]).filter((message) => message.role !== "assistant"),
      );
      for (const value of planted) {
        expect({ turn: index, holds: handed.includes(value), value }).toEqual({
          turn: index,
          holds: false,
          value,
        });
      }
    }
  });
});
