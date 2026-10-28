/**
 * MongoDB's client facet (#1821): its copy, its workflow variants, its plan operation and its posture, as data a
 * browser bundle may hold. Client-safe: it reads only the leaf `workflow-tool-sets.ts`.
 */
import type { AgentVariantRequirement } from "../../agent-manifest";
import type { AgentPosture } from "../../posture";
import type { AgentToolName } from "../../tools";
import { OPERATIONS_VARIANT, READ_CLASS_TOOLS } from "../../workflow-tool-sets";
import type { AgentLanguageClientPack, StatementBudgets } from "../pack";

/**
 * Agent mode on MongoDB: the boundary is a user the server holds to read privileges on this
 * one database, which the profile reads and tests before the first model turn of a run that
 * sends commands, with the fence in front of the engine.
 *
 * The qualifier names the same numbers the SQL arm does, because the budgets are the same
 * budgets; what differs is who holds them, and the body says so in the engine's own terms:
 * `maxTimeMS` and the privilege read, not a read-only transaction, because MongoDB has none
 * to name. It says "per command" because that is what the language calls one unit.
 */
function mongoReadsPosture(bounds: StatementBudgets): AgentPosture {
  const rows = bounds.maxResultRows;
  const seconds = bounds.statementTimeoutMs / 1000;
  return {
    tone: "reads",
    headline: "Reads only",
    qualifier: `${rows} rows and ${seconds} s per command, enforced by the server`,
    title: "Agent mode reads, under a boundary the server enforces",
    body: `Agent mode runs commands it wrote itself, bounded to ${rows} rows and ${seconds} seconds each: maxTimeMS is the server's own deadline, and Studio ends a command the server does not. On the server, find and aggregate stop one row past the budget. Before the first model turn of a run that sends commands, the server must report that this connection's user holds only read privileges on this database and must refuse a write from it: a user that can write, a server without authentication, or a server that is not MongoDB ends that run there. The fence refuses writes, write stages, server-side JavaScript and diagnostic stages before the engine is reached. Nothing reaches your editor.`,
  };
}

export const MONGO_CLIENT_PACK = Object.freeze({
  /**
   * MongoDB's words. The noun is COMMAND because that is what MongoDB calls what the envelope carries, and the
   * argument is `command` because the model writes it as a JSON object rather than as text. The server turns it into
   * text once, in the order the model wrote it (the language adapter's `canonicalize` in
   * `languages/mongo/adapter.ts`), so the fence, the provider, the ledger and the repair identity read one text, and a
   * sort or an embedded-document match runs in the order it was written.
   */
  copy: Object.freeze({
    subject: "a MongoDB database",
    noun: "command",
    argument: "command",
    writes: "writes and pipeline stages that write",
    reached: "the database",
    defect: "your MongoDB command",
    adviceKeys: Object.freeze(["find", "aggregate", "count", "distinct"]),
  }),
  /**
   * The MongoDB variants (issue #1614). Every statement workflow is offered the read-class four whole, as the SQL
   * variants are, because the engine answers each of them: the catalog from the provider's own inventory, the plan
   * from the `explain` command at `queryPlanner` verbosity, and the read through the command envelope. So no tool
   * here can only refuse. That differs from kubectl's deliberate narrowing, which exists because a cluster has
   * neither a catalog nor a plan.
   *
   * `requires` is empty by a different argument than kubectl's: there, the requirements gate cluster readings only
   * that engine family has. Here the language is the gate: the server code chooses each tool's arm by the language,
   * so an engine holds this variant's tools by holding the language, and a later engine reusing the `mongo` id
   * holds the same arms.
   *
   * No variant here auto-executes; `data-analysis` says why.
   */
  variants: Object.freeze({
    investigation: Object.freeze({
      tools: Object.freeze([...READ_CLASS_TOOLS]),
      narrowedExtras: Object.freeze<AgentToolName[]>([]),
      classifierDescription: "a question about the database that is answered from what the run establishes",
      objective: "Your objective is a question about this MongoDB database. Answer it from what you establish.",
      planDeliverable: "inherits",
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>([]),
      verifier: "agent-investigation.1",
    }),
    /**
     * The optimization template without `compare_plans`, and that absence is a refusal to overclaim rather than a
     * gap: a comparison's whole value is the structural access reading (`plan-summary.ts`), which reads only the
     * plan formats it was verified against and every other one as `unknown` by design, so a mongo comparison would
     * state that two plans differ in a way nobody has read. Its bar is `agent-query-optimization-mongo.1`: an index
     * recommendation grounded in an inspected plan, as `agent-query-optimization.3`'s other arm, or a report citing a
     * plan that already reaches its documents through an index and recommending nothing. `inspect_plan` here
     * runs the `explain` command at `queryPlanner` verbosity, which returns the plan and no result rows, although
     * with several candidate plans the server runs each for a bounded trial: the estimate the SQL engines take from
     * `EXPLAIN`, in this engine's own word.
     */
    "query-optimization": Object.freeze({
      tools: Object.freeze<AgentToolName[]>([
        "inspect_schema",
        "run_read_query",
        "inspect_plan",
        "recommend_change",
        "compose_report",
      ]),
      narrowedExtras: Object.freeze<AgentToolName[]>(["recommend_change"]),
      classifierDescription: "a specific command that is too slow, and how the engine reaches its documents",
      objective:
        "Your objective is a command that is too slow. What matters is HOW the engine reaches its documents, and what change would make it reach them differently.",
      planDeliverable: Object.freeze({ kind: "statement", noun: "the rewritten command" }),
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>([]),
      verifier: "agent-query-optimization-mongo.1",
    }),
    /** The assessment template's own tool, on top of the read-class four: the profile counts through aggregation. */
    "database-assessment": Object.freeze({
      tools: Object.freeze<AgentToolName[]>([...READ_CLASS_TOOLS, "profile_table"]),
      narrowedExtras: Object.freeze<AgentToolName[]>(["profile_table"]),
      classifierDescription: "the state of the data itself: where it is incomplete, inconsistent or surprising",
      objective:
        "Your objective is the state of this MongoDB database itself: where its documents are incomplete, inconsistent or surprising.",
      planDeliverable: Object.freeze({ kind: "statement", noun: "the command that measures the quality concern" }),
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>([]),
      verifier: "agent-database-assessment.1",
    }),
    operations: OPERATIONS_VARIANT,
    /**
     * The analysis template, with the auto-execute hand-over not offered, as on a cluster. The gate that would run
     * the answer in the editor weighs the answer's own plan by a reading of the engine's explain format
     * (`planRefusal` in `auto-execute.ts`). No `ExplainFormat` names a MongoDB plan and no explain strategy carries
     * an `agentReading` of one, so every ticked run would be declined, and the hand-over's replay of a MongoDB command has never
     * been verified end to end either. A setting that can only ever be declined is a consent it cannot honour, so the
     * route refuses it and the rail raises no consent step. What would turn it on is one change, recorded as
     * `docs/BACKLOG.md` B118: a MongoDB plan reading, its rule in the gate and a verified replay, together.
     */
    "data-analysis": Object.freeze({
      tools: Object.freeze<AgentToolName[]>([...READ_CLASS_TOOLS, "profile_table", "present_answer"]),
      narrowedExtras: Object.freeze<AgentToolName[]>(["present_answer"]),
      classifierDescription: "a question about the data whose answer is a result the user wants to see",
      objective:
        "Your objective is a question about the data in this MongoDB database. Establish the answer from the data and produce something to show for it.",
      planDeliverable: Object.freeze({ kind: "statement", noun: "the command that produces the answer" }),
      canAutoExecute: false,
      requires: Object.freeze<AgentVariantRequirement[]>([]),
      verifier: "agent-data-analysis.1",
    }),
  }),
  planEstimateOperation: "mongo.plan.estimate",
  evidenceEvents: Object.freeze({}),
  posture: Object.freeze({
    reads: mongoReadsPosture,
    widened: mongoReadsPosture,
    handoverTerms: () =>
      "A MongoDB answer is never run in your editor: the hand-over is not offered on this engine, so the run produces its answer on its own read-only path only.",
  }),
} satisfies AgentLanguageClientPack);
