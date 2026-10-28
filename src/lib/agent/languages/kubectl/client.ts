/**
 * kubectl's client facet (#1821): its copy, its workflow variants and its posture, as data a browser bundle may hold.
 * Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { DatabaseType } from "@/lib/types";
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import type { AgentArtifactReference } from "../../types";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type {
  AgentEvidenceEventSpecs,
  AgentEvidenceTimelineEntry,
  AgentLanguageClientPack,
  AgentVariantRequirementSpec,
  StatementBudgets,
} from "../pack";

/**
 * The curated cluster readings whose result is EVIDENCE of a kind a verdict asks for, so the drive writes an event of
 * that kind beside the settled step: container usage against requests and limits in one namespace
 * (`inspect_usage`, resource efficiency), and one namespace's workloads, their readiness, restarts, missing resources
 * and probes, and events (`profile_workloads`, cluster health).
 */
export type KubectlEvidenceToolName = "inspect_usage" | "profile_workloads";

/**
 * The reading refusal only the cluster usage reading raises: the cluster serves no metrics.k8s.io, or serves one whose
 * backend does not answer. It is the cluster's fact rather than a failure of the read, so no rewording of the call
 * could change it and it costs no repair attempt. The ledger persists it, so it is a member of the core's
 * `AgentReadingDenyCode` through `AgentPackReadingDenyCode`.
 */
export type KubectlReadingDenyCode = "METRICS_UNAVAILABLE";

/** The verdict shortfalls only the kubectl verifiers report. */
export type KubectlShortfall =
  /**
   * A resource-efficiency run never read usage.
   *
   * The template's own artifact. Whether a container is sized for what it uses can only be said from what it uses,
   * and a run that reported from the cluster's objects alone has described the requests and not measured them.
   */
  | "no-usage-reading"
  /**
   * A resource-efficiency run read usage, and its answer does not rest on that reading: the resources recommendation
   * cites something else, or the report recommends nothing and cites no usage reading.
   *
   * The link between the reading and the conclusion, kept apart from `no-usage-reading` because the run here did
   * the measuring and then answered beside it.
   */
  | "no-usage-evidence"
  /**
   * A resource-efficiency run could not read usage because the cluster serves no usage metrics, and read none.
   *
   * Kept apart from `no-usage-reading` because the cause is the cluster and not the run: metrics.k8s.io is absent or
   * metrics-server does not answer, and the reader is owed that sentence rather than one about the model.
   */
  | "no-usage-metrics"
  /**
   * A cluster-health run never profiled a namespace's workloads.
   *
   * The template's own artifact, as `no-table-profile` is the SQL assessment's: reads the model composed may describe
   * a few objects, and only the profile establishes every workload's state in one place.
   */
  | "no-workload-profile";

/**
 * What the kubectl workflow variants need of an engine beyond its language: a usage reading and a workload profile.
 * Mirrored onto the engines whose provider declares those `agentReadings`, because that declaration reaches server
 * code; `agent-manifest.test.ts` holds each to those providers.
 */
export type KubectlVariantRequirement = "cluster-usage-reading" | "cluster-workload-reading";

/** kubectl's evidence events, as the ledger stores them less their timestamp. */
export type KubectlEvidenceEvent =
  | {
      /**
       * Container usage in one namespace was read against requests and limits, so a report or a resources
       * recommendation can CITE it.
       *
       * Its own kind for the reason `table-profiled` has one: the artifact is this reading's evidence, and the
       * resource-efficiency verdict asks for a usage reading by kind rather than for any read. The namespace and the
       * selector are what the reading covered, recorded so a resumed run is told what it already measured.
       */
      readonly kind: "usage-read";
      readonly artifact: AgentArtifactReference;
      readonly namespace: string;
      readonly selector?: string;
    }
  | {
      /**
       * The cluster serves no usage metrics for this namespace: metrics.k8s.io is absent, or its backend
       * (metrics-server) does not answer.
       *
       * A fact about the cluster, recorded as one, rather than only a refused step: the verdict reads it to say the
       * run could not measure usage and why, which a refusal code alone cannot tell apart from a reading the run
       * chose not to keep.
       */
      readonly kind: "usage-unavailable";
      readonly namespace: string;
    }
  | {
      /**
       * One namespace's workloads were profiled, so a report can CITE the profile.
       *
       * Its own kind for the reason `usage-read` has one: the cluster-health verdict asks for a workload profile by
       * kind rather than for any read. The namespace is what the profile covered, recorded so a resumed run is told
       * what it already profiled.
       */
      readonly kind: "workloads-profiled";
      readonly artifact: AgentArtifactReference;
      readonly namespace: string;
    };

/**
 * What the timeline and a resumed run say of each kubectl evidence event. The namespace is spoken in the headline the
 * way a profiled table's name is, because it is the subject of the entry; it is a validated DNS label and the selector
 * is the model's own argument, so neither is cluster content.
 */
type UsageRead = Extract<KubectlEvidenceEvent, { readonly kind: "usage-read" }>;
type UsageUnavailable = Extract<KubectlEvidenceEvent, { readonly kind: "usage-unavailable" }>;
type WorkloadsProfiled = Extract<KubectlEvidenceEvent, { readonly kind: "workloads-profiled" }>;

const KUBECTL_EVIDENCE_EVENTS = Object.freeze({
  "usage-read": Object.freeze({
    citable: true,
    timeline: (event: UsageRead): AgentEvidenceTimelineEntry => ({
      tone: "progress",
      headline: `Read container usage in ${event.namespace}`,
      detail: `${event.artifact.summary.rowCount} container(s), against their requests and limits.`,
      artifactId: event.artifact.correlationId,
    }),
    // Durable and non-terminal like a table profile: a resumed run that was not told would spend a statement
    // measuring what it already measured, and could not cite the reading it holds.
    priorProgress: (event: UsageRead): string =>
      `Container usage in namespace ${event.namespace}${event.selector === undefined ? "" : ` (selector ${event.selector})`} was already read, artifact ${event.artifact.correlationId}. That reading is recorded; read it again only for a different namespace or selector.`,
  }),
  "usage-unavailable": Object.freeze({
    citable: false,
    // `neutral`, for the reason a schema that was not captured is: the run continues without the reading, so
    // `progress` would claim it got somewhere and `refused` would claim the server turned a call back.
    timeline: (): AgentEvidenceTimelineEntry => ({
      tone: "neutral",
      headline: "No usage metrics",
      detail: "This cluster serves no metrics.k8s.io, so usage could not be read: install metrics-server.",
    }),
    priorProgress: (event: UsageUnavailable): string =>
      `Usage could not be read in namespace ${event.namespace}: this cluster serves no usage metrics (metrics.k8s.io), because metrics-server is not installed or not answering. Asking again will not change that.`,
  }),
  "workloads-profiled": Object.freeze({
    citable: true,
    timeline: (event: WorkloadsProfiled): AgentEvidenceTimelineEntry => ({
      tone: "progress",
      headline: `Profiled the workloads of ${event.namespace}`,
      detail: `${event.artifact.summary.rowCount} workload(s).`,
      artifactId: event.artifact.correlationId,
    }),
    // Durable and non-terminal like the usage reading above, and told for the same reason.
    priorProgress: (event: WorkloadsProfiled): string =>
      `The workloads of namespace ${event.namespace} were already profiled, artifact ${event.artifact.correlationId}. That profile is recorded; profile again only a different namespace.`,
  }),
} satisfies AgentEvidenceEventSpecs<KubectlEvidenceEvent>);

/**
 * Agent mode on a cluster: Studio's allowlist and the identity's RBAC bound it, not the engine.
 *
 * The body names BOTH identities the agent may run as, the connection's agent token and its
 * own token, rather than the one in use. That is not hedging: the rail is handed a
 * connection id and a type, never the connection's credential fields, so it cannot know
 * whether an agent token is set. Naming both, and recommending a token bound to `view`, is
 * the most this panel can say truthfully.
 */
function kubectlReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `${rows} rows and ${seconds} s per statement, enforced by Studio's request allowlist`,
    title: "Agent mode reads, under a boundary Studio enforces",
    body: `Agent mode runs kubectl reads it wrote itself, bounded to ${rows} rows and ${seconds} seconds each. Studio's request allowlist admits reads only, checked on the final request before it is sent, and the identity's RBAC decides what is visible: the agent runs on the connection's agent token when one is set, and on the connection's own token otherwise, so give it a token bound to view. Values Studio masks, such as env values, annotation values, ConfigMap data and Secret names and values, never reach the model. Nothing reaches your editor.`,
  };
}

export const KUBECTL_CLIENT_PACK = Object.freeze({
  copy: Object.freeze({
    subject: "a Kubernetes cluster",
    noun: "statement",
    argument: "statement",
    writes: "writes, exec, port-forward, proxy and watches",
    reached: "the cluster",
    defect: "your kubectl statement",
    adviceKeys: Object.freeze(["get", "top", "logs", "events"]),
  }),
  variants: Object.freeze({
    /**
     * Reads alone: there is no catalog composer and no plan on a cluster, so `inspect_schema` and `inspect_plan`
     * could only refuse. What the run establishes, it establishes with `run_read_query`, and it is judged by the
     * same bar as an SQL investigation, so the verifier is the SQL one and a plan of it asks for what that one does.
     */
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription: "a question about the cluster that is answered from what the run establishes",
      objective: "Your objective is a question about this Kubernetes cluster. Answer it from what you establish.",
      planDeliverable: "inherits",
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>([]),
      verifier: "agent-investigation.1",
    }),
    /**
     * Resource efficiency: the cluster's optimization is not a slow statement but a container sized for what it does
     * not use, so the run reads usage against requests and limits and may recommend new ones.
     *
     * `inspect_usage` and `recommend_change` are kept on a narrowed run because the verdict accepts either a resources
     * recommendation citing a usage reading or a report citing one, and both need the reading first. It requires the
     * usage reading of the engine, without which every tool the verdict asks for could only refuse.
     */
    "query-optimization": Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "inspect_usage", "recommend_change", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>(["inspect_usage", "recommend_change"]),
      classifierDescription:
        "which workloads are over- or under-provisioned: the CPU and memory their containers use against their requests and limits",
      objective:
        "Your objective is resource efficiency: which containers use far less, or far more, CPU and memory than they request, and what requests and limits would fit what they use.",
      planDeliverable: Object.freeze({
        kind: "statement",
        noun: "the kubectl read that measures usage against requests",
      }),
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>(["cluster-usage-reading"]),
      verifier: "agent-query-optimization-kubectl.1",
    }),
    /**
     * Cluster health: the cluster's assessment is not the state of its data but the state of its workloads, so the
     * run profiles a namespace and grades what it finds.
     *
     * `profile_workloads` is kept on a narrowed run because the verdict asks for a profile, and nothing else the run
     * can do establishes one. It requires the workload reading of the engine, without which that tool could only
     * refuse.
     */
    "database-assessment": Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "profile_workloads", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>(["profile_workloads"]),
      classifierDescription:
        "the health of a namespace's workloads: replicas not ready, restarts, missing requests, limits or probes, warning events",
      objective:
        "Your objective is the health of this cluster's workloads in a namespace: what is not ready, what restarts, what runs without requests, limits or probes, and what the Warning events say.",
      planDeliverable: Object.freeze({
        kind: "statement",
        noun: "the kubectl read that establishes each workload's state",
      }),
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>(["cluster-workload-reading"]),
      verifier: "agent-database-assessment-kubectl.1",
    }),
    operations: OPERATIONS_VARIANT,
    /**
     * A read presented as the answer, the SQL analysis without its profile: a cluster has no table to count.
     *
     * It is judged by the SQL analysis verdict, so `present_answer` is kept on a narrowed run for the same reason. It
     * never auto-executes: the hand-over replays the answer's statement in the user's editor, and a kubectl answer is
     * never run on the editor's terms.
     */
    "data-analysis": Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "present_answer", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>(["present_answer"]),
      classifierDescription: "a question about the cluster whose answer is a result the user wants to see",
      objective:
        "Your objective is a question about this cluster's objects. Establish the answer from what you read and produce something to show for it.",
      planDeliverable: "inherits",
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>([]),
      verifier: "agent-data-analysis.1",
    }),
  }),
  planEstimateOperation: null,
  evidenceEvents: KUBECTL_EVIDENCE_EVENTS,
  shortfallSentences: Object.freeze({
    "no-usage-reading": "No usage was read, so how the containers use their requests was never established.",
    "no-usage-evidence": "The report rests on no usage reading of this run.",
    "no-usage-metrics": "This cluster serves no usage metrics: install metrics-server to measure usage.",
    "no-workload-profile": "No workloads were profiled, so the namespace's health was never established.",
  } satisfies Record<KubectlShortfall, string>),
  readingRefusalHeadlines: Object.freeze({
    METRICS_UNAVAILABLE: "This cluster serves no usage metrics",
  } satisfies Record<KubectlReadingDenyCode, string>),
  requirements: Object.freeze({
    "cluster-usage-reading": Object.freeze({
      engines: Object.freeze<DatabaseType[]>(["kubernetes"]),
      sentence:
        "This engine serves no usage reading, so this workflow's tools could only refuse. The operations workflow runs here, and plan mode drafts here.",
    }),
    "cluster-workload-reading": Object.freeze({
      engines: Object.freeze<DatabaseType[]>(["kubernetes"]),
      sentence:
        "This engine serves no workload profile, so this workflow's tools could only refuse. The operations workflow runs here, and plan mode drafts here.",
    }),
  } satisfies Record<KubectlVariantRequirement, AgentVariantRequirementSpec>),
  posture: Object.freeze({
    reads: kubectlReadsPosture,
    widened: kubectlReadsPosture,
    handoverTerms: () =>
      "A kubectl answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
  }),
} satisfies AgentLanguageClientPack);
