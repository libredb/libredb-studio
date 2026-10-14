/**
 * The curated readings the agent's cluster workflows take instead of composing kubectl: container usage against
 * requests and limits, and a namespace's workload profile. Each is one audited call, one statement charge, and has its
 * own row ceiling of 500, refused past it; each runs in the machine context, so it is bounded by the statement budget
 * and every body is redacted in machine mode.
 *
 * Usage is read from metrics.k8s.io PodMetrics and joined to the core pod list by pod and container name, so a
 * container metrics-server has not sampled yet still has its row, with null usage. The workload above a pod is read
 * through its controller: ReplicaSet to Deployment, Job to CronJob, as `kubectl get` names the owner.
 *
 * The workload profile lists the controllers independently of their pods, so a controller whose pods are all missing
 * is still a row, then the pods and the Warning events, and attributes each to its workload.
 */
import { QueryError } from "@/lib/db/errors";
import type {
  ClusterUsageInput,
  ClusterUsageReading,
  QueryResult,
  WorkloadProfileInput,
  WorkloadProfileReading,
} from "@/lib/db/types";
import { ACCEPT_JSON } from "./client";
import { byCodeUnit, inTurn, type KubectlContext, objectOf, stringOf } from "./console/context";
import { milliValue, parseQuantity, wholeValue } from "./console/top";
import { findResource, type IndexedResource } from "./discovery";
import { KubernetesRequestError } from "./errors";
import { KUBERNETES_MAX_STATEMENT_ROWS, KUBERNETES_PAGE_SIZE, KUBERNETES_TYPE } from "./limits";
import { redactResponse } from "./redaction";
import { parseTable, scanTable } from "./table";

export const CLUSTER_READING_MAX_ROWS = 500;

export const CLUSTER_USAGE_FIELDS = [
  "namespace",
  "ownerKind",
  "ownerName",
  "pod",
  "container",
  "cpuMillicores",
  "memoryBytes",
  "cpuRequestMillicores",
  "cpuLimitMillicores",
  "memoryRequestBytes",
  "memoryLimitBytes",
  "cpuRequestRatio",
  "memoryRequestRatio",
  "window",
  "timestamp",
] as const;

export const WORKLOAD_PROFILE_FIELDS = [
  "kind",
  "name",
  "desired",
  "ready",
  "lastSchedule",
  "podsNotReady",
  "restarts",
  "lastTerminationReason",
  "lastTerminationAt",
  "withoutRequests",
  "withoutLimits",
  "withoutReadinessProbe",
  "withoutLivenessProbe",
  "warningEvents",
] as const;

type Json = Readonly<Record<string, unknown>>;

interface Listed {
  readonly items: readonly Json[];
  readonly more: boolean;
}

interface Owner {
  readonly kind: string;
  readonly name: string;
}

const NOTHING_LISTED: Listed = { items: [], more: false };

/** One namespace's list of a resource, redacted in machine mode, read up to `limit` items. */
async function listed(
  context: KubectlContext,
  target: IndexedResource,
  namespace: string,
  limit: number,
  query: { readonly labelSelector?: string; readonly fieldSelector?: string } = {},
): Promise<Listed> {
  const scan = await scanTable(
    async (page) =>
      parseTable(
        redactResponse(
          target,
          await context.surface.client.json(
            {
              op: "list",
              target,
              namespace,
              query: {
                limit: page.limit,
                ...query,
                ...(page.continueToken === undefined ? {} : { continue: page.continueToken }),
              },
            },
            { ...context.call(), accept: ACCEPT_JSON },
          ),
          "machine",
        ),
      ),
    { offset: 0, limit, pageSize: KUBERNETES_PAGE_SIZE },
  );
  return { items: scan.rows.map((row) => row.object ?? {}), more: scan.more };
}

const array = (value: unknown): readonly Json[] =>
  Array.isArray(value) ? value.map((entry) => objectOf(entry) ?? {}) : [];

const nameOf = (object: Json): string => stringOf(objectOf(object.metadata)?.name) ?? "";

/** A quantity in millicores, or null where it is absent or not a quantity. */
function millicores(text: unknown): number | null {
  const parsed = typeof text === "string" ? parseQuantity(text) : undefined;
  return parsed === undefined ? null : Number(milliValue(parsed));
}

/** A quantity in bytes, or null where it is absent or not a quantity. */
function bytes(text: unknown): number | null {
  const parsed = typeof text === "string" ? parseQuantity(text) : undefined;
  return parsed === undefined ? null : Number(wholeValue(parsed));
}

/** Usage over request, to three places; null where either is absent or the request is zero. */
function ratio(usage: number | null, request: number | null): number | null {
  return usage === null || request === null || request === 0 ? null : Math.round((usage / request) * 1000) / 1000;
}

/**
 * The workload a pod runs under: its controller, lifted one level where the index knows the controller's own
 * (ReplicaSet to Deployment, Job to CronJob). A pod with no owner is its own workload.
 */
function controllerOf(object: Json, owners: ReadonlyMap<string, Owner>): Owner {
  const references = array(objectOf(object.metadata)?.ownerReferences);
  const controller = references.find((reference) => reference.controller === true) ?? references[0];
  if (controller === undefined) return { kind: stringOf(object.kind) ?? "Pod", name: nameOf(object) };
  const kind = stringOf(controller.kind) ?? "";
  const name = stringOf(controller.name) ?? "";
  return owners.get(`${kind}/${name}`) ?? { kind, name };
}

/**
 * ReplicaSet and Job names mapped to the controller above them, for `controllerOf`. List items carry no `kind`, so
 * each list comes with the kind it was read as.
 */
function ownerIndex(
  entries: readonly { readonly kind: string; readonly items: readonly Json[] }[],
): Map<string, Owner> {
  const index = new Map<string, Owner>();
  for (const { kind, items } of entries) {
    for (const item of items) {
      const above = array(objectOf(item.metadata)?.ownerReferences).find((reference) => reference.controller === true);
      if (above !== undefined)
        index.set(`${kind}/${nameOf(item)}`, { kind: String(above.kind), name: String(above.name) });
    }
  }
  return index;
}

/**
 * Container usage in one namespace against each container's requests and limits, one row per container of every
 * pod listed. A cluster without metrics.k8s.io answers `metrics-unavailable` before any request; so does one whose
 * aggregated metrics API answers 503 (its backend is down) or 404 (unregistered since discovery was read).
 */
export async function readClusterUsage(
  context: KubectlContext,
  input: ClusterUsageInput,
): Promise<ClusterUsageReading> {
  const index = await context.surface.discovery.get();
  const metrics = findResource(index, "metrics.k8s.io", "pods");
  if (metrics === undefined) return { kind: "metrics-unavailable" };
  const pods = findResource(index, "", "pods");
  if (pods === undefined) throw new QueryError("This server does not serve core pods.", KUBERNETES_TYPE);
  const selector = input.selector === undefined ? {} : { labelSelector: input.selector };
  let podMetrics: Listed;
  try {
    podMetrics = await listed(context, metrics, input.namespace, CLUSTER_READING_MAX_ROWS + 1, selector);
  } catch (error) {
    if (error instanceof KubernetesRequestError && (error.status === 503 || error.status === 404))
      return { kind: "metrics-unavailable" };
    throw error;
  }
  const podList = await listed(context, pods, input.namespace, CLUSTER_READING_MAX_ROWS + 1, selector);
  // The owners are read whole, not by the selector: a ReplicaSet's own labels need not match its pods'.
  const owning = await inTurn(
    [findResource(index, "apps", "replicasets"), findResource(index, "batch", "jobs")],
    async (target) =>
      target === undefined ? NOTHING_LISTED : listed(context, target, input.namespace, KUBERNETES_MAX_STATEMENT_ROWS),
  );
  if (podMetrics.more || podList.more || owning.some((list) => list.more)) return { kind: "over-ceiling" };
  const owners = ownerIndex([
    { kind: "ReplicaSet", items: owning[0].items },
    { kind: "Job", items: owning[1].items },
  ]);
  const usageByPod = new Map(podMetrics.items.map((item) => [nameOf(item), item]));
  const rows: Record<string, unknown>[] = [];
  for (const pod of podList.items) {
    const podName = nameOf(pod);
    const sample = usageByPod.get(podName);
    const used = new Map(
      array(sample?.containers).map((container) => [stringOf(container.name) ?? "", objectOf(container.usage) ?? {}]),
    );
    const owner = controllerOf({ ...pod, kind: "Pod" }, owners);
    for (const container of array(objectOf(pod.spec)?.containers)) {
      const name = stringOf(container.name) ?? "";
      const resources = objectOf(container.resources) ?? {};
      const requests = objectOf(resources.requests) ?? {};
      const limits = objectOf(resources.limits) ?? {};
      const usage = used.get(name) ?? {};
      const cpu = millicores(usage.cpu);
      const memory = bytes(usage.memory);
      const cpuRequest = millicores(requests.cpu);
      const memoryRequest = bytes(requests.memory);
      rows.push({
        namespace: input.namespace,
        ownerKind: owner.kind,
        ownerName: owner.name,
        pod: podName,
        container: name,
        cpuMillicores: cpu,
        memoryBytes: memory,
        cpuRequestMillicores: cpuRequest,
        cpuLimitMillicores: millicores(limits.cpu),
        memoryRequestBytes: memoryRequest,
        memoryLimitBytes: bytes(limits.memory),
        cpuRequestRatio: ratio(cpu, cpuRequest),
        memoryRequestRatio: ratio(memory, memoryRequest),
        window: stringOf(sample?.window) ?? null,
        timestamp: stringOf(sample?.timestamp) ?? null,
      });
    }
  }
  if (rows.length > CLUSTER_READING_MAX_ROWS) return { kind: "over-ceiling" };
  const result: QueryResult = { rows, fields: [...CLUSTER_USAGE_FIELDS], rowCount: rows.length, executionTime: 0 };
  return { kind: "rows", result };
}

interface Workload {
  readonly kind: string;
  readonly name: string;
  readonly desired: number | null;
  readonly ready: number | null;
  readonly lastSchedule: string | null;
  /** The pod spec its containers come from: the template of a controller, the spec of a bare Pod. */
  readonly podSpec: Json;
}

/** The controller kinds a workload profile lists, in the order it reads them, each with the kind it is read as. */
const WORKLOAD_KINDS = [
  { group: "apps", resource: "deployments", kind: "Deployment" },
  { group: "apps", resource: "statefulsets", kind: "StatefulSet" },
  { group: "apps", resource: "daemonsets", kind: "DaemonSet" },
  { group: "batch", resource: "jobs", kind: "Job" },
  { group: "batch", resource: "cronjobs", kind: "CronJob" },
] as const;

/** The kinds whose desired count is a replica count, so a desired pod with no pod at all is a pod not Ready. */
const REPLICA_KINDS: ReadonlySet<string> = new Set(["Deployment", "StatefulSet"]);

const number = (value: unknown, fallback: number): number => (typeof value === "number" ? value : fallback);

/** A controller as a workload, desired and ready in its kind's own terms. */
function workloadOf(kind: string, object: Json): Workload {
  const spec = objectOf(object.spec) ?? {};
  const status = objectOf(object.status) ?? {};
  const template = objectOf(objectOf(spec.template)?.spec) ?? {};
  switch (kind) {
    case "DaemonSet":
      return {
        kind,
        name: nameOf(object),
        desired: number(status.desiredNumberScheduled, 0),
        ready: number(status.numberReady, 0),
        lastSchedule: null,
        podSpec: template,
      };
    case "Job":
      return {
        kind,
        name: nameOf(object),
        desired: number(spec.completions, 1),
        ready: number(status.succeeded, 0),
        lastSchedule: null,
        podSpec: template,
      };
    case "CronJob": {
      const jobTemplate = objectOf(objectOf(objectOf(spec.jobTemplate)?.spec)?.template) ?? {};
      return {
        kind,
        name: nameOf(object),
        desired: array(status.active).length,
        ready: null,
        lastSchedule: stringOf(status.lastScheduleTime) ?? null,
        podSpec: objectOf(jobTemplate.spec) ?? {},
      };
    }
    default:
      return {
        kind,
        name: nameOf(object),
        desired: number(spec.replicas, 1),
        ready: number(status.readyReplicas, 0),
        lastSchedule: null,
        podSpec: template,
      };
  }
}

const isReady = (pod: Json): boolean =>
  array(objectOf(pod.status)?.conditions).some(
    (condition) => condition.type === "Ready" && condition.status === "True",
  );

/** A pod that ran to completion is not Ready, and is not one that should be. */
const hasSucceeded = (pod: Json): boolean => objectOf(pod.status)?.phase === "Succeeded";

const isEmpty = (value: unknown): boolean => Object.keys(objectOf(value) ?? {}).length === 0;

/** How many of `containers` match, as a row's count. */
const counted = (containers: readonly Json[], missing: (container: Json) => boolean): number =>
  containers.filter(missing).length;

/** Warning events by reason, as `BackOff=3, FailedScheduling=1`, each event weighing its own repeat `count`. */
function warningSummary(reasons: ReadonlyMap<string, number> | undefined): string | null {
  if (reasons === undefined) return null;
  return [...reasons.keys()]
    .sort(byCodeUnit)
    .map((reason) => `${reason}=${reasons.get(reason)}`)
    .join(", ");
}

/** One workload's row: its own counts, and what its pods, its template and its events say. */
function workloadRow(
  workload: Workload,
  pods: readonly Json[],
  warnings: ReadonlyMap<string, number> | undefined,
): Record<string, unknown> {
  const missing = REPLICA_KINDS.has(workload.kind) ? Math.max(0, (workload.desired ?? 0) - pods.length) : 0;
  const statuses = pods.flatMap((pod) => array(objectOf(pod.status)?.containerStatuses));
  let restarts = 0;
  let last: { readonly reason: string | null; readonly at: string } | undefined;
  for (const status of statuses) {
    restarts += number(status.restartCount, 0);
    const terminated = objectOf(objectOf(status.lastState)?.terminated);
    const at = stringOf(terminated?.finishedAt);
    if (at !== undefined && (last === undefined || at > last.at))
      last = { reason: stringOf(terminated?.reason) ?? null, at };
  }
  const containers = array(workload.podSpec.containers);
  return {
    kind: workload.kind,
    name: workload.name,
    desired: workload.desired,
    ready: workload.ready,
    lastSchedule: workload.lastSchedule,
    podsNotReady: pods.filter((pod) => !hasSucceeded(pod) && !isReady(pod)).length + missing,
    restarts,
    lastTerminationReason: last?.reason ?? null,
    lastTerminationAt: last?.at ?? null,
    withoutRequests: counted(containers, (container) => isEmpty(objectOf(container.resources)?.requests)),
    withoutLimits: counted(containers, (container) => isEmpty(objectOf(container.resources)?.limits)),
    withoutReadinessProbe: counted(containers, (container) => container.readinessProbe === undefined),
    withoutLivenessProbe: counted(containers, (container) => container.livenessProbe === undefined),
    warningEvents: warningSummary(warnings),
  };
}

const keyOf = (owner: Owner): string => `${owner.kind}/${owner.name}`;

/**
 * The workload profile of one namespace: one row per controller, Deployment, StatefulSet, DaemonSet, Job and CronJob,
 * listed whether or not it has pods, and one per pod no controller owns. A pod counts under its controller, a
 * ReplicaSet's lifted to its Deployment; a Job's pods count under the Job, and the CronJob's row reads its own active
 * Jobs. A list discovery does not serve is empty; a list past one statement's read, or more than 500 workloads,
 * answers `over-ceiling`.
 */
export async function readWorkloadProfile(
  context: KubectlContext,
  input: WorkloadProfileInput,
): Promise<WorkloadProfileReading> {
  const index = await context.surface.discovery.get();
  const lists = await inTurn(
    [
      ...WORKLOAD_KINDS.map(({ group, resource }) => ({ target: findResource(index, group, resource), query: {} })),
      { target: findResource(index, "apps", "replicasets"), query: {} },
      { target: findResource(index, "", "pods"), query: {} },
      { target: findResource(index, "", "events"), query: { fieldSelector: "type=Warning" } },
    ],
    async ({ target, query }) =>
      target === undefined
        ? NOTHING_LISTED
        : listed(context, target, input.namespace, KUBERNETES_MAX_STATEMENT_ROWS, query),
  );
  if (lists.some((list) => list.more)) return { kind: "over-ceiling" };
  const [replicaSets, pods, events] = lists.slice(WORKLOAD_KINDS.length).map((list) => list.items);
  const owners = ownerIndex([{ kind: "ReplicaSet", items: replicaSets }]);
  const workloads = WORKLOAD_KINDS.flatMap(({ kind }, at) => lists[at].items.map((item) => workloadOf(kind, item)));
  const podsOf = new Map<string, Json[]>(workloads.map((workload) => [keyOf(workload), []]));
  const podOwners = new Map<string, Owner>();
  for (const pod of pods) {
    const owner = controllerOf({ ...pod, kind: "Pod" }, owners);
    podOwners.set(nameOf(pod), owner);
    if (owner.kind === "Pod") {
      workloads.push({
        kind: "Pod",
        name: owner.name,
        desired: 1,
        ready: isReady(pod) ? 1 : 0,
        lastSchedule: null,
        podSpec: objectOf(pod.spec) ?? {},
      });
      podsOf.set(keyOf(owner), [pod]);
    } else podsOf.get(keyOf(owner))?.push(pod);
  }
  if (workloads.length > CLUSTER_READING_MAX_ROWS) return { kind: "over-ceiling" };
  const warnings = new Map<string, Map<string, number>>();
  for (const event of events) {
    const involved = objectOf(event.involvedObject) ?? {};
    const object: Owner = { kind: stringOf(involved.kind) ?? "", name: stringOf(involved.name) ?? "" };
    const workload =
      object.kind === "Pod"
        ? podOwners.get(object.name)
        : object.kind === "ReplicaSet"
          ? owners.get(keyOf(object))
          : object;
    if (workload === undefined || !podsOf.has(keyOf(workload))) continue;
    const reasons = warnings.get(keyOf(workload)) ?? new Map<string, number>();
    const reason = stringOf(event.reason) ?? "";
    reasons.set(reason, (reasons.get(reason) ?? 0) + Math.max(1, number(event.count, 1)));
    warnings.set(keyOf(workload), reasons);
  }
  const rows = workloads
    .toSorted((a, b) => byCodeUnit(a.kind, b.kind) || byCodeUnit(a.name, b.name))
    .map((workload) => workloadRow(workload, podsOf.get(keyOf(workload)) ?? [], warnings.get(keyOf(workload))));
  const result: QueryResult = { rows, fields: [...WORKLOAD_PROFILE_FIELDS], rowCount: rows.length, executionTime: 0 };
  return { kind: "rows", result };
}
