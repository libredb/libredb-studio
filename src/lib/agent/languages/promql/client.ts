/**
 * The PromQL language's client facet: its copy, its workflow variants and its posture, as data a browser bundle may
 * hold. Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/**
 * Agent mode on Prometheus: the boundary is the provider's structural closed table, a transport that builds requests
 * only to its own read paths, whose one POST is the instant query, and PromQL has no construct that writes. Its answers
 * carry the server's samples and labels; the body names what is withheld before anything counts it.
 */
function promqlReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `${rows} rows and ${seconds} s per read, over a transport whose only POST is the instant query`,
    title: "Agent mode reads Prometheus with PromQL, and never writes",
    body: `Agent mode runs PromQL reads it wrote itself, each one expression evaluated as an instant query at the server's now, the way the console runs it, and answers the samples and labels as the console renders them: a vector one row per series, a matrix one row per sample, bounded to ${rows} rows and ${seconds} seconds each, the server's time-out set from that budget, and refused past them rather than cut. Its inventory names the metrics and their label names, the rule groups and rules, and the scrape pools and targets. Withheld are the server's command-line flags, which carry paths, addresses and local configuration, and every URL's userinfo, query string and fragment in a target, rule or alert answer and in the labels of a PromQL answer, where a scrape token or a password can sit; a target, and an instance label, is named by its address without userinfo. A label value a read rewrites so that it no longer reads as a URL or an address is answered as the read wrote it. Studio's transport builds requests to its own read endpoints only, so no admin, remote-write, OTLP or lifecycle call can be sent. Nothing reaches your editor.`,
  };
}

/** Plan mode on Prometheus: the shared sentence names one schema read, and the grounding here is several read endpoints. */
function promqlPlanPosture(): AgentPosture {
  return {
    tone: "safe",
    headline: "Executes nothing it drafts",
    qualifier: "the server's read endpoints ground it, and no PromQL it drafted is evaluated",
    title: "Plan mode drafts, and never runs what it drafted",
    body: "Plan mode never sends the PromQL it wrote. It is grounded on the server's own read endpoints, the metric names of the last hour and their label names, the rule groups and rules, and the scrape pools and targets, and that grounding is where the inventory in Run details came from. Studio reads the series' label sets to learn their label names and keeps the names alone; a target is named by its address without userinfo, and the server's flags are not read.",
  };
}

export const PROMQL_CLIENT_PACK = Object.freeze({
  /** Prometheus's words. The noun is EXPRESSION, PromQL's own word, and the argument is `statement`. */
  copy: Object.freeze({
    subject: "a Prometheus server",
    noun: "expression",
    argument: "statement",
    writes: "every admin, remote-write, OTLP and lifecycle endpoint, and the server's flags",
    reached: "the server",
    defect: "your PromQL expression",
    adviceKeys: Object.freeze([]),
  }),
  /**
   * The PromQL variants. The server composes no plan an agent can be shown before it runs and Studio no catalog read
   * for it, so the workflows judged on one of those (query optimization, database assessment) are not offered here:
   * their tools could only refuse. What remains reads: the investigation and the analysis, each through
   * `run_read_query`, grounded in the inventory captured before the first turn, and the operations workflow, which
   * sends no statement. No variant auto-executes: no Prometheus answer is handed to the editor.
   */
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription:
        "a question about what this Prometheus server monitors, such as which targets are up, a service's request or error rate, or an alert's state, that is answered from what the run establishes",
      objective:
        "Your objective is a question about what this Prometheus server monitors. Answer it from what you establish.",
      planDeliverable: "inherits",
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>([]),
      verifier: "agent-investigation.1",
    }),
    operations: OPERATIONS_VARIANT,
    "data-analysis": Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "present_answer", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>(["present_answer"]),
      classifierDescription: "a question about the stored metrics whose answer is a result the user wants to see",
      objective:
        "Your objective is a question about the metrics in this Prometheus server. Establish the answer from the series you read and produce something to show for it.",
      planDeliverable: Object.freeze({ kind: "statement", noun: "the PromQL expression that produces the answer" }),
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>([]),
      verifier: "agent-data-analysis.1",
    }),
  }),
  planEstimateOperation: null,
  evidenceEvents: Object.freeze({}),
  shortfallSentences: Object.freeze({}),
  readingRefusalHeadlines: Object.freeze({}),
  requirements: Object.freeze({}),
  posture: Object.freeze({
    reads: promqlReadsPosture,
    widened: promqlReadsPosture,
    handoverTerms: () =>
      "A Prometheus answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
    plan: promqlPlanPosture,
  }),
} satisfies AgentLanguageClientPack);
