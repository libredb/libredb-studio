import { beforeAll, describe, expect, test } from "bun:test";
import { captureContextSnapshot, packContextForTask, packOperationsInventory } from "@/lib/agent/context-snapshot";
import { AgentRunDeadline } from "@/lib/agent/deadline";
import { AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { AgentRepairLedger } from "@/lib/agent/repair-ledger";
import type { AgentToolContext } from "@/lib/agent/tools";
import type { AgentContextSnapshot } from "@/lib/agent/types";
import type { NodeResponse } from "@/lib/db/http/node-transport";
import { ExecutionArtifactStore } from "@/lib/db/operations/artifacts";
import { ExecutionBudgetTracker } from "@/lib/db/operations/budgets";
import { createCanonicalOperationRegistry } from "@/lib/db/operations/descriptors";
import { createTargetScope } from "@/lib/db/operations/policy";
import { KubernetesProvider } from "@/lib/db/providers/platform/kubernetes/index";
import { KUBERNETES_KIND_TABLE } from "@/lib/db/providers/platform/kubernetes/kinds";
import type { QueryResult } from "@/lib/db/types";
import { fakeCluster } from "../../../helpers/kubernetes-cluster";
import { kubernetesConnection } from "../../../helpers/kubernetes-connection";
import { KUBERNETES_SAMPLE_MARKERS as M } from "../../../helpers/kubernetes-markers";
import { jsonAnswer, recordingKubernetesTransport, testSeams } from "../../../helpers/kubernetes-transport";

/**
 * No value, label, annotation, env value, Secret name, ConfigMap key or Secret key of a Kubernetes cluster reaches a
 * machine surface: the agent's grounding walk, the task packer, the operations packer, or the snapshot they are built
 * from. Labels and annotations are absent key and value alike.
 *
 * The fake API server plants every marker of docker/kubernetes/sample.yaml where a real server would carry it: on
 * every listed row's metadata (a server answering `includeObject=Metadata` sends it whether or not it was asked for),
 * in every object a GET answers, a Secret's data and its last-applied annotation, a ConfigMap's data and a Deployment's
 * env. The positive controls prove the walk read the namespace: a ConfigMap and a Deployment are named, and the
 * Secrets are counted.
 */

const NAMESPACE = "shop";
const LAST_APPLIED = "kubectl.kubernetes.io/last-applied-configuration";
const SECRET_VALUE_BASE64 = Buffer.from(M.secretValue, "utf8").toString("base64");

/** The planted metadata every row and object carries. */
const PLANTED_METADATA = {
  labels: { [M.labelKey]: M.labelValue },
  annotations: {
    [M.annotationKey]: M.annotationValue,
    [LAST_APPLIED]: JSON.stringify({ stringData: { [M.secretKey]: M.secretValue } }),
  },
};

/** The collection path of a built-in kind, as the provider asks for it. */
function collection(group: string, id: string, namespaced: boolean): string {
  const version = group === "autoscaling" ? "v2" : "v1";
  const root = group === "" ? "/api/v1" : `/apis/${group}/${version}`;
  return namespaced ? `${root}/namespaces/${NAMESPACE}/${id}` : `${root}/${id}`;
}

/** The one object of each kind, named as the sample data names it where it does. */
function objectName(id: string, singular: string): string {
  if (id === "secrets") return M.secretName;
  if (id === "configmaps") return "shop-config";
  if (id === "deployments") return "web";
  return `${singular}-1`;
}

const lists = new Map<string, { readonly name: string; readonly kind: string }>();
const objects = new Map<string, unknown>();
for (const entry of KUBERNETES_KIND_TABLE) {
  const namespaced = entry.scope === "Namespaced";
  const path = collection(entry.group, entry.id, namespaced);
  const name = objectName(entry.id, entry.singular);
  const kind = entry.label.replaceAll(" ", "");
  lists.set(path, { name, kind });
  objects.set(`${path}/${name}`, {
    kind,
    metadata: { name, ...(namespaced ? { namespace: NAMESPACE } : {}), ...PLANTED_METADATA },
    ...(entry.id === "secrets"
      ? { data: { [M.secretKey]: SECRET_VALUE_BASE64 }, stringData: { [M.secretKey]: M.secretValue } }
      : {}),
    ...(entry.id === "configmaps" ? { data: { [M.configMapKey]: M.configMapValue } } : {}),
    ...(entry.id === "deployments"
      ? {
          spec: {
            template: { spec: { containers: [{ name: "web", env: [{ name: "MARKER_ENV", value: M.envValue }] }] } },
          },
        }
      : {}),
  });
}

/** A Table page of one row whose object carries the planted metadata and, for a Secret, its data. */
function tablePage(name: string, kind: string): NodeResponse {
  return jsonAnswer({
    kind: "Table",
    apiVersion: "meta.k8s.io/v1",
    metadata: { resourceVersion: "100" },
    columnDefinitions: [
      { name: "Name", type: "string", format: "name", priority: 0 },
      { name: "Age", type: "string", format: "", priority: 0 },
    ],
    rows: [
      {
        cells: [name, "5m"],
        object: {
          kind: "PartialObjectMetadata",
          metadata: { name, ...PLANTED_METADATA },
          ...(kind === "Secret" ? { data: { [M.secretKey]: SECRET_VALUE_BASE64 } } : {}),
        },
      },
    ],
  });
}

/** A namespace the walk does not read: its name stays off every machine surface, as the namespace count says. */
const UNREAD_NAMESPACE = "tenant-unread-marker";

const fallback = fakeCluster({
  lists: { "/api/v1/namespaces": [{ name: "default" }, { name: NAMESPACE }, { name: UNREAD_NAMESPACE }] },
});

function plantedServer(request: Parameters<typeof fallback>[0], line: string): NodeResponse | Promise<NodeResponse> {
  const path = new URL(request.url).pathname;
  const list = lists.get(path);
  if (list !== undefined && path !== "/api/v1/namespaces") return tablePage(list.name, list.kind);
  const object = objects.get(path);
  if (object !== undefined) return jsonAnswer(object);
  return fallback(request, line);
}

async function capture(): Promise<AgentContextSnapshot> {
  const transport = recordingKubernetesTransport(plantedServer);
  const connection = kubernetesConnection({ database: NAMESPACE });
  const provider = new KubernetesProvider(connection, { queryTimeout: 30_000 }, testSeams(transport));
  await provider.connect();
  const clock = () => 1_000;
  const context: AgentToolContext = {
    runId: "run-k8s",
    modelId: "unmeasured-model-for-tests",
    mode: "planning",
    workflowType: "investigation",
    actor: { sessionId: "session-1", role: "user" },
    connection,
    capabilities: provider.getCapabilities(),
    labels: provider.getLabels(),
    registry: createCanonicalOperationRegistry(),
    scope: createTargetScope(connection.id),
    tracker: new ExecutionBudgetTracker(),
    artifacts: new ExecutionArtifactStore<QueryResult>({ ttlMs: 60_000, maxArtifacts: 16 }),
    deadline: new AgentRunDeadline(AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets.maxTotalRunMs * 2, clock),
    repairs: new AgentRepairLedger(),
    acquireProvider: async () => provider,
    clock,
  };
  const captured = await captureContextSnapshot(context);
  await provider.disconnect();
  if (captured.kind !== "captured") throw new Error(`expected a snapshot, got ${captured.kind}`);
  return captured.snapshot;
}

const FORBIDDEN = [
  ["a Secret value", M.secretValue],
  ["a Secret value in base64", SECRET_VALUE_BASE64],
  ["a Secret name", M.secretName],
  ["a ConfigMap value", M.configMapValue],
  ["an env value", M.envValue],
  ["a label value", M.labelValue],
  ["an annotation value", M.annotationValue],
  ["a ConfigMap key", M.configMapKey],
  ["a Secret key", M.secretKey],
  ["a label key", M.labelKey],
  ["an annotation key", M.annotationKey],
  ["the name of a namespace the walk did not read", UNREAD_NAMESPACE],
] as const;

const SURFACES = ["snapshot", "the task packer", "the operations packer"] as const;
let surfaces: Record<(typeof SURFACES)[number], string>;

beforeAll(async () => {
  const snapshot = await capture();
  surfaces = {
    snapshot: JSON.stringify(snapshot),
    "the task packer": packContextForTask(
      snapshot,
      `Which deployments run in shop, and is there a ${UNREAD_NAMESPACE}?`,
    ),
    "the operations packer": packOperationsInventory(snapshot),
  };
});

describe("the Kubernetes machine surfaces", () => {
  test("the walk read the session's namespace: a ConfigMap and a Deployment by name, the Secrets as a count", () => {
    expect(surfaces["the task packer"]).toContain("shop-config");
    expect(surfaces["the task packer"]).toMatch(/\bweb\b/);
    expect(surfaces["the task packer"]).toContain("withheld");
  });

  describe.each([...SURFACES])("%s", (surface) => {
    test.each(FORBIDDEN)("holds no trace of %s", (_what, marker) => {
      expect(surfaces[surface]).not.toContain(marker);
    });
  });
});
