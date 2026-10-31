/**
 * The etcdctl command language's client facet: its copy, its workflow variants and its posture, as data a browser
 * bundle may hold. Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/**
 * Agent mode on etcd: the boundary is the provider's closed table of metadata reads, which holds no write and no read
 * of a key name or a value, and before every command the server must show that authentication is on and that the
 * connection's user holds no root role and only READ permissions. Its answers carry names, counts and sizes only.
 */
function etcdctlReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `metadata only, ${rows} rows and ${seconds} s per command, as an etcd user whose roles grant READ only`,
    title: "Agent mode reads etcd's metadata, as an etcd user whose roles grant READ only",
    body: `Agent mode runs etcd reads it wrote itself, the cluster's status, members, alarms and leases, the count of every key and, for one key a command names, its existence, revisions, version, lease and value size, bounded to ${rows} rows and ${seconds} seconds each and refused past them rather than cut. Key names count as stored values, so it never lists keys, reads a value or watches. Before every command the server must answer that authentication is on and that the connection's user is not root, holds no root role, and holds READ permissions only, read from its own roles, so a user that may write even one key range is refused; a call the roles do not govern, such as granting a lease, is stopped by the reader, which sends none. Studio's reader refuses every other command before anything is sent. Nothing reaches your editor.`,
  };
}

export const ETCDCTL_CLIENT_PACK = Object.freeze({
  /** etcd's words. The noun is COMMAND, etcdctl's own word, and the argument is `statement`. */
  copy: Object.freeze({
    subject: "an etcd cluster",
    noun: "command",
    argument: "statement",
    writes: "every write, and every read of a key name or a value",
    reached: "the cluster",
    defect: "your etcdctl command",
    adviceKeys: Object.freeze([]),
  }),
  /**
   * The etcd variants. Agent mode reads metadata only, so the workflows that need stored values (the data analysis),
   * a plan (query optimization) or a profile (database assessment) are not offered here: their tools could only
   * refuse. What remains reads the cluster's state and named keys' metadata: the investigation, through
   * `run_read_query`, and the operations workflow, which sends no command. No variant auto-executes: no etcd answer is
   * handed to the editor.
   */
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze<AgentToolName[]>(["run_read_query", "compose_report"]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription:
        "a question about the cluster's status, members, alarms, leases or key count, or about the existence, revisions, version, lease or value size of keys the question names, that is answered from what the run establishes",
      objective:
        "Your objective is a question about this etcd cluster's state or about keys it names. Answer it from what you establish.",
      planDeliverable: "inherits",
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>([]),
      verifier: "agent-investigation.1",
    }),
    operations: OPERATIONS_VARIANT,
  }),
  planEstimateOperation: null,
  evidenceEvents: Object.freeze({}),
  shortfallSentences: Object.freeze({}),
  readingRefusalHeadlines: Object.freeze({}),
  requirements: Object.freeze({}),
  posture: Object.freeze({
    reads: etcdctlReadsPosture,
    widened: etcdctlReadsPosture,
    handoverTerms: () =>
      "An etcd answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
  }),
} satisfies AgentLanguageClientPack);
