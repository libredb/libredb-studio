/**
 * The tool sets more than one statement language's variants are built from (#1821).
 *
 * A client-safe leaf with type imports only: each language's client pack (`languages/<id>/client.ts`) reads these at
 * module evaluation, and `agent-manifest.ts` reads the client packs, so holding them in the manifest would close the
 * cycle `agent-manifest -> languages/client -> languages/<id>/client -> agent-manifest`.
 */
import type { AgentVariantRequirement, AgentWorkflowVariant } from "./agent-manifest";
import type { AgentToolName } from "./tools";

/** The read-class four every SQL statement workflow starts from, and every MongoDB one offers whole. */
export const READ_CLASS_TOOLS: readonly AgentToolName[] = Object.freeze<AgentToolName[]>([
  "inspect_schema",
  "run_read_query",
  "inspect_plan",
  "compose_report",
]);

/**
 * The operations workflow, one variant for every language because it sends no statement at all.
 *
 * Its tools are not built on the read-class four. All three of the read-class tools it leaves out,
 * `inspect_schema`, `run_read_query` and `inspect_plan`, reach the database under the `agent-read-only` profile,
 * which the factory grants only to a provider with `queryReadOnly`, and only the engines `AGENT_EXECUTION_ENGINES`
 * (`src/lib/db/compatibility.ts`) names implement it. Offering any of them here would reintroduce, tool by tool, the exact
 * engine restriction this workflow exists to escape: the run would open on an engine with no read-only statement
 * path, be offered a tool, call it, and be answered by an acquisition that refuses the engine. `inspect_schema` was
 * checked rather than assumed: it is answered under that profile too (a composed catalog statement through
 * `provider.queryReadOnly` on a SQL engine, the provider's own inventory on MongoDB), so it is left out.
 *
 * `recommend_change` is here and `compare_plans` is not: a comparison names two `inspect_plan` artifacts this run
 * cannot produce, so offering it would be offering a tool that can only ever refuse.
 */
export const OPERATIONS_VARIANT: AgentWorkflowVariant = Object.freeze({
  tools: Object.freeze<AgentToolName[]>(["inspect_operations", "recommend_change", "compose_report"]),
  narrowedExtras: Object.freeze<AgentToolName[]>([]),
  classifierDescription: "how the database is RUNNING right now: connections, waits, blocking, space and index usage",
  objective:
    "Your objective is how this database is RUNNING right now: what is connected to it, what it is spending its time on, what is blocked, and where its space and its indexes are going.",
  planDeliverable: Object.freeze({ kind: "prose" }),
  canAutoExecute: false,
  requires: Object.freeze<AgentVariantRequirement[]>([]),
  verifier: "agent-operations.2",
});
