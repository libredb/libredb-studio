/**
 * `kubectl logs`: the pods and containers kubectl would read, one log request per stream, merged by time into one
 * grid of TIME, POD, CONTAINER and LINE.
 *
 * Which pods (kubectl's `polymorphichelpers/logsforobject.go`): a pod name reads that pod; `TYPE/NAME` of a workload
 * or a Service reads its selector's pods and takes the one `GetFirstPod` takes, sorted by `podutils.ByLogging`, unless
 * --all-pods asks for every one; -l reads every pod it selects. Which containers: -c, else every container with
 * --all-containers (init, then regular, then ephemeral), else the `kubectl.kubernetes.io/default-container`
 * annotation when it names one of the pod's containers, else the first container, with kubectl's notice saying so.
 *
 * Bounds: at most 5 streams (kubectl's --max-log-requests default), past which a sentence asks for -c or a narrower
 * selector; each request asks `limitBytes` (1 MiB, or --limit-bytes) and `tailLines` (--tail, else 10 per pod under
 * -l as kubectl reads, else 500 with a warning that kubectl's default is every line). `timestamps=true` is always
 * requested; the RFC 3339 prefix of each line is its TIME and the rest its LINE, with its terminal escape sequences
 * removed. `follow` is never sent. The merged lines are the statement's rows, so streams times the tail past 5,000
 * answer a sentence before any log is read.
 */
import { QueryError } from "@/lib/db/errors";
import { ACCEPT_JSON } from "../client";
import type { IndexedResource } from "../discovery";
import {
  KUBERNETES_LOG_LIMIT_BYTES,
  KUBERNETES_LOG_SELECTOR_TAIL,
  KUBERNETES_LOG_TAIL_DEFAULT,
  KUBERNETES_MAX_LOG_STREAMS,
  KUBERNETES_MAX_STATEMENT_ROWS,
  KUBERNETES_PAGE_SIZE,
  KUBERNETES_TYPE,
} from "../limits";
import { redactResponse } from "../redaction";
import { type KubeTable, parseTable, scanTable } from "../table";
import {
  byCodeUnit,
  inTurn,
  type KubectlContext,
  type KubectlGrid,
  objectOf,
  resolveType,
  stringOf,
  textGrid,
} from "./context";
import type { KubectlStatement } from "./parse";

type LogsStatement = Extract<KubectlStatement, { readonly command: "logs" }>;

type Json = Readonly<Record<string, unknown>>;

const DEFAULT_CONTAINER_ANNOTATION = "kubectl.kubernetes.io/default-container";

const TAIL_WARNING =
  "kubectl reads every line when --tail is absent; Studio read the last 500 lines of each stream. Ask for up to 5,000 with --tail.";

const LINES_CAP_SENTENCE =
  "The log streams answered more than the 5,000 lines one statement shows: lower --tail, name one container with -c, or narrow the selector.";

const READ_SELECTOR_KINDS =
  "a deployment, replica set, stateful set, daemon set, job, replication controller or service";

/** The resources whose pods `logs TYPE/NAME` reads, by group and plural, as `SelectorsForObject` takes them. */
const SELECTOR_RESOURCES: ReadonlySet<string> = new Set([
  "/replicationcontrollers",
  "/services",
  "apps/deployments",
  "apps/replicasets",
  "apps/statefulsets",
  "apps/daemonsets",
  "batch/jobs",
]);

const array = (value: unknown): readonly Json[] =>
  Array.isArray(value) ? value.map((entry) => objectOf(entry) ?? {}) : [];

const millis = (value: unknown): number => {
  const at = typeof value === "string" && value !== "" ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? 0 : at;
};

function readyCondition(pod: Json): Json | undefined {
  return array(objectOf(pod.status)?.conditions).find((condition) => condition.type === "Ready");
}

function isReady(pod: Json): boolean {
  return readyCondition(pod)?.status === "True";
}

/** When a ready pod became ready; 0 (the zero time) for a pod that is not ready. */
function readyTime(pod: Json): number {
  return isReady(pod) ? millis(readyCondition(pod)?.lastTransitionTime) : 0;
}

function maxRestarts(pod: Json): number {
  return Math.max(
    0,
    ...array(objectOf(pod.status)?.containerStatuses).map((status) => Number(status.restartCount ?? 0)),
  );
}

/** kubectl's `afterOrZero(t1, t2)`: t1 is after t2, or t1 is the zero time while t2 is not. */
function afterOrZero(t1: number, t2: number): boolean {
  if (t1 === 0 || t2 === 0) return t1 === 0;
  return t1 > t2;
}

/** Phases as `ByLogging` ranks them: Running, then Unknown, then Pending; any other phase ranks with Running. */
const PHASE_RANK: Readonly<Record<string, number>> = { Running: 0, Unknown: 1, Pending: 2 };

/**
 * `podutils.ByLogging`'s order: assigned before unassigned, Running before Unknown before Pending, ready before not
 * ready, ready longer before ready shorter, more restarts before fewer, older before newer. Ties keep the server's
 * order, which is the order of names.
 */
export function compareForLogging(a: Json, b: Json): number {
  const aNode = stringOf(objectOf(a.spec)?.nodeName) ?? "";
  const bNode = stringOf(objectOf(b.spec)?.nodeName) ?? "";
  if (aNode !== bNode && (aNode === "" || bNode === "")) return aNode !== "" ? -1 : 1;
  const aPhase = PHASE_RANK[String(objectOf(a.status)?.phase)] ?? 0;
  const bPhase = PHASE_RANK[String(objectOf(b.status)?.phase)] ?? 0;
  if (aPhase !== bPhase) return aPhase - bPhase;
  if (isReady(a) !== isReady(b)) return isReady(a) ? -1 : 1;
  if (isReady(a) && isReady(b) && readyTime(a) !== readyTime(b))
    return afterOrZero(readyTime(b), readyTime(a)) ? -1 : 1;
  if (maxRestarts(a) !== maxRestarts(b)) return maxRestarts(b) - maxRestarts(a);
  const aCreated = millis(objectOf(a.metadata)?.creationTimestamp);
  const bCreated = millis(objectOf(b.metadata)?.creationTimestamp);
  if (aCreated !== bCreated) return afterOrZero(bCreated, aCreated) ? -1 : 1;
  return 0;
}

/** A label selector as the API reads it: `matchLabels` and `matchExpressions`, sorted by key as kubectl writes them. */
export function selectorText(selector: Json): string {
  const terms: { readonly key: string; readonly text: string }[] = [];
  const labels = objectOf(selector.matchLabels) ?? {};
  for (const key of Object.keys(labels)) terms.push({ key, text: `${key}=${String(labels[key])}` });
  for (const expression of array(selector.matchExpressions)) {
    const key = String(expression.key);
    const values = (Array.isArray(expression.values) ? expression.values.map(String) : []).sort(byCodeUnit);
    if (expression.operator === "In") terms.push({ key, text: `${key} in (${values.join(",")})` });
    else if (expression.operator === "NotIn") terms.push({ key, text: `${key} notin (${values.join(",")})` });
    else if (expression.operator === "Exists") terms.push({ key, text: key });
    else if (expression.operator === "DoesNotExist") terms.push({ key, text: `!${key}` });
  }
  return [...terms]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((term) => term.text)
    .join(",");
}

/** The pod selector of a workload or a Service, as `SelectorsForObject` reads it. */
function podSelectorOf(resource: IndexedResource, object: Json, label: string): string {
  const spec = objectOf(object.spec) ?? {};
  const selector = objectOf(spec.selector) ?? {};
  const plain = resource.group === "" ? selector : undefined;
  const text =
    plain !== undefined
      ? Object.keys(plain)
          .sort(byCodeUnit)
          .map((key) => `${key}=${String(plain[key])}`)
          .join(",")
      : selectorText(selector);
  if (text === "")
    throw new QueryError(
      `${label} selects no pods (its selector is empty), so it has no logs to read; name a pod instead.`,
      KUBERNETES_TYPE,
    );
  return text;
}

async function readPod(context: KubectlContext, pods: IndexedResource, namespace: string, name: string): Promise<Json> {
  const body = await context.surface.client.json({ op: "get", target: pods, namespace, name }, context.call());
  return objectOf(redactResponse(pods, body)) ?? {};
}

/** Every pod a selector picks in the namespace, in the server's order, at most 5,000. */
async function selectedPods(
  context: KubectlContext,
  pods: IndexedResource,
  namespace: string,
  labelSelector: string,
): Promise<readonly Json[]> {
  const read = async (page: { readonly continueToken?: string; readonly limit: number }): Promise<KubeTable> => {
    const body = await context.surface.client.json(
      {
        op: "list",
        target: pods,
        namespace,
        query: {
          limit: page.limit,
          labelSelector,
          ...(page.continueToken === undefined ? {} : { continue: page.continueToken }),
        },
      },
      { ...context.call(), accept: ACCEPT_JSON },
    );
    return parseTable(redactResponse(pods, body));
  };
  const scan = await scanTable(read, {
    offset: 0,
    limit: KUBERNETES_MAX_STATEMENT_ROWS + 1,
    pageSize: KUBERNETES_PAGE_SIZE,
    // Whole pods are read, so a page of large ones may pass the byte cap.
    halveOnTooLarge: true,
  });
  if (scan.rows.length > KUBERNETES_MAX_STATEMENT_ROWS)
    throw new QueryError(
      "More than 5,000 pods match the selector: narrow it before reading their logs.",
      KUBERNETES_TYPE,
    );
  return scan.rows.map((row) => row.object ?? {});
}

/** The pods the statement reads. */
async function podsOf(context: KubectlContext, statement: LogsStatement, namespace: string): Promise<readonly Json[]> {
  const pods = await resolveType(context, "pods");
  if (statement.target === undefined) return selectedPods(context, pods, namespace, statement.labelSelector as string);
  if (statement.target.type === undefined) return [await readPod(context, pods, namespace, statement.target.name)];
  const resource = await resolveType(context, statement.target.type);
  if (resource.group === "" && resource.resource === "pods")
    return [await readPod(context, pods, namespace, statement.target.name)];
  const label = `${resource.resource}/${statement.target.name}`;
  if (!SELECTOR_RESOURCES.has(`${resource.group}/${resource.resource}`))
    throw new QueryError(
      `kubectl logs reads the pods of ${READ_SELECTOR_KINDS}; ${resource.resource} has none to read.`,
      KUBERNETES_TYPE,
    );
  const owner =
    objectOf(
      redactResponse(
        resource,
        await context.surface.client.json(
          { op: "get", target: resource, namespace, name: statement.target.name },
          context.call(),
        ),
      ),
    ) ?? {};
  const matched = await selectedPods(context, pods, namespace, podSelectorOf(resource, owner, label));
  if (matched.length === 0)
    throw new QueryError(
      `No pod matches the selector of ${label} in the namespace ${namespace}, so there are no logs to read.`,
      KUBERNETES_TYPE,
    );
  const sorted = [...matched].sort(compareForLogging);
  return statement.allPods ? sorted : [sorted[0]];
}

/**
 * kubectl's `AllContainerNames` (`pkg/cmd/util/podcmd/podcmd.go`): the containers, then the ephemeral containers marked
 * `(ephem)`, then the init containers marked `(init)`, joined by a comma and a space.
 */
function allContainerNames(regular: readonly string[], ephemeral: readonly string[], init: readonly string[]): string {
  return [...regular, ...ephemeral.map((name) => `${name} (ephem)`), ...init.map((name) => `${name} (init)`)].join(
    ", ",
  );
}

/**
 * The containers of one pod the statement reads, and what kubectl prints to stderr while it chooses them.
 *
 * The notices follow `logsForObjectWithClient` in kubectl's `pkg/polymorphichelpers/logsforobject.go`, read at
 * kubernetes/kubectl commit 89b48c420f2fbbad20a982f1e96817aef81f3d88: when no container is named, an annotation naming
 * none of the pod's containers prints `Default container name "X" not found in pod NAME`; then, when the annotation
 * chose none, the first container is taken, and if the pod has more than one container, or any init or ephemeral
 * container, `Defaulted container "X" out of: ...` is printed, unless --all-pods reads every pod.
 */
function containersOf(
  statement: LogsStatement,
  pod: Json,
): { readonly containers: readonly string[]; readonly notices: readonly string[] } {
  const spec = objectOf(pod.spec) ?? {};
  const names = (key: string): string[] => array(spec[key]).map((container) => String(container.name));
  const regular = names("containers");
  const init = names("initContainers");
  const ephemeral = names("ephemeralContainers");
  const every = [...init, ...regular, ...ephemeral];
  const podName = String(objectOf(pod.metadata)?.name);
  if (statement.container !== undefined) {
    if (!every.includes(statement.container))
      throw new QueryError(`The container named by -c is not a container of pod ${podName}.`, KUBERNETES_TYPE);
    return { containers: [statement.container], notices: [] };
  }
  if (statement.allContainers) return { containers: every, notices: [] };
  const annotated = stringOf(objectOf(objectOf(pod.metadata)?.annotations)?.[DEFAULT_CONTAINER_ANNOTATION]);
  if (annotated !== undefined && every.includes(annotated)) return { containers: [annotated], notices: [] };
  if (regular.length === 0) throw new QueryError(`Pod ${podName} lists no container.`, KUBERNETES_TYPE);
  const notices: string[] = [];
  if (annotated !== undefined && annotated !== "")
    notices.push(`Default container name ${JSON.stringify(annotated)} not found in pod ${podName}`);
  if (!statement.allPods && every.length > 1)
    notices.push(
      `Defaulted container ${JSON.stringify(regular[0])} out of: ${allContainerNames(regular, ephemeral, init)}`,
    );
  return { containers: [regular[0]], notices };
}

/**
 * The terminal escape sequences of a log line: CSI (`ESC [`, parameter bytes, intermediate bytes, a final byte), OSC
 * (`ESC ]` up to BEL or `ESC \`), nF sequences (intermediate bytes, then a final byte, such as the `ESC ( B` that
 * `tput sgr0` writes), and every other two-byte `ESC` sequence. Each alternative starts at an ESC and its
 * runs are character classes that hold no ESC, so a match attempt stops at the next ESC and the scan stays linear in
 * the line's length; an unfinished sequence matches nothing and stays.
 *
 * It is built from a string that takes ESC and BEL from `String.fromCharCode`: the two control characters are the
 * point of the pattern, and a regex literal could only spell them as control escapes, which the linters flag as a
 * likely mistake.
 */
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const TERMINAL_ESCAPE = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|[ -/]+[0-~]|[0-Z\\\\^-~])`,
  "g",
);

/**
 * A log line without its terminal escape sequences. kubectl writes the bytes to a terminal, which draws the colors;
 * the grid cannot, so the sequences would show as a box glyph and `[1;34m`. Every other character, tabs included,
 * stays as the server sent it.
 */
export function stripTerminalEscapes(line: string): string {
  return line.replace(TERMINAL_ESCAPE, "");
}

/**
 * One log line's time and text: the RFC 3339 prefix `timestamps=true` writes, and the rest. Only a full
 * `HH:MM:SS[.fraction]` time is a prefix, so every time it accepts is one `timeKey` reads.
 */
export function splitTimestamp(line: string): { readonly time: string | null; readonly text: string } {
  const match =
    /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})) ([\s\S]*)$/.exec(
      line,
    );
  return match === null ? { time: null, text: line } : { time: match[1], text: match[2] };
}

/** A time as a key that sorts in time order, its fraction padded to nanoseconds. */
function timeKey(time: string | null): string {
  if (time === null) return "";
  // The kubelet writes UTC with up to nine fraction digits and drops trailing zeros, so the fraction is padded.
  const match = /^(.*T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.([0-9]+))?(.*)$/.exec(time) as RegExpExecArray;
  return `${match[1]}.${(match[2] ?? "").padEnd(9, "0")}${match[3]}`;
}

export async function readLogs(context: KubectlContext, statement: LogsStatement): Promise<KubectlGrid> {
  const namespace = statement.namespace ?? context.surface.endpoint.defaultNamespace;
  const pods = await podsOf(context, statement, namespace);
  const chosen = pods.map((pod) => ({
    pod: String(objectOf(pod.metadata)?.name),
    choice: containersOf(statement, pod),
  }));
  const streams = chosen.flatMap((entry) =>
    entry.choice.containers.map((container) => ({ pod: entry.pod, container })),
  );
  // Pods that default alike print the same sentence; it is said once.
  const notices = [...new Set(chosen.flatMap((entry) => entry.choice.notices))];
  if (streams.length > KUBERNETES_MAX_LOG_STREAMS)
    throw new QueryError(
      `This statement would read ${streams.length} log streams, more than the 5 Studio reads at once: name one container with -c, or narrow the selector.`,
      KUBERNETES_TYPE,
    );
  const tail =
    statement.tail ?? (statement.target === undefined ? KUBERNETES_LOG_SELECTOR_TAIL : KUBERNETES_LOG_TAIL_DEFAULT);
  // The merged lines are the statement's rows, so their bound holds before any log is read.
  if (streams.length * tail > KUBERNETES_MAX_STATEMENT_ROWS)
    throw new QueryError(
      `This statement would read up to ${(streams.length * tail).toLocaleString("en-US")} lines across ${streams.length} log streams, more than the 5,000 one statement shows: lower --tail, name one container with -c, or narrow the selector. No log was read.`,
      KUBERNETES_TYPE,
    );
  let read = 0;
  const lines = await inTurn(streams, async (stream) => {
    const answer = await context.surface.client.send(
      {
        op: "logs",
        namespace,
        pod: stream.pod,
        query: {
          container: stream.container,
          tailLines: tail,
          limitBytes: statement.limitBytes ?? KUBERNETES_LOG_LIMIT_BYTES,
          ...(statement.sinceSeconds === undefined ? {} : { sinceSeconds: statement.sinceSeconds }),
          ...(statement.sinceTime === undefined ? {} : { sinceTime: statement.sinceTime }),
          ...(statement.previous ? { previous: true } : {}),
          timestamps: true,
        },
      },
      // The log endpoint answers text/plain but refuses an Accept of text/plain with a 406, so the JSON Accept stays.
      context.call(),
    );
    const text = answer.text.endsWith("\n") ? answer.text.slice(0, -1) : answer.text;
    if (text === "") return [];
    const split = text.split("\n");
    // A server may answer more lines than tailLines asks for; the statement's bound holds all the same.
    read += split.length;
    if (read > KUBERNETES_MAX_STATEMENT_ROWS) throw new QueryError(LINES_CAP_SENTENCE, KUBERNETES_TYPE);
    return split.map((line) => {
      const parts = splitTimestamp(line);
      return { pod: stream.pod, container: stream.container, time: parts.time, text: stripTerminalEscapes(parts.text) };
    });
  });
  // A stable sort: lines of one time keep their stream's order.
  const merged = lines
    .flat()
    .sort((a, b) => (timeKey(a.time) < timeKey(b.time) ? -1 : timeKey(a.time) > timeKey(b.time) ? 1 : 0));
  const grid = textGrid(
    ["TIME", "POD", "CONTAINER", "LINE"],
    merged.map((line) => [line.time, line.pod, line.container, line.text]),
  );
  const warned = statement.tail === undefined && statement.target !== undefined;
  const warnings = [...notices, ...(warned ? [TAIL_WARNING] : [])].map((message) => ({ message }));
  return warnings.length === 0 ? grid : { ...grid, warnings };
}
