/**
 * How an engine reaches the rows, read from an ESTIMATING plan (#330 T3).
 *
 * The query-optimization template's whole claim is that one statement reaches its
 * rows differently from another, so something has to say what "differently" means
 * without being either engine's dialect. This is that something: a small structural
 * reading, derived on the SERVER from a plan the run actually asked for, rather
 * than a description the model supplies about its own work.
 *
 * Three rules, each of which rules something out:
 *
 *  - **No engine text crosses into the summary.** A plan names tables and indexes,
 *    and those names are written by whoever can write to the database — untrusted
 *    input, exactly like a row value (`untrusted-content.ts`). So the summary is
 *    structural, and the statement the model wrote is what names the objects. It
 *    already knows what it asked about.
 *  - **Nothing is invented for an engine that does not report it.** SQLite's
 *    `EXPLAIN QUERY PLAN` carries no cost and no row estimate at all, so both are
 *    absent here. A zero would read as "free"; a guess would read as a measurement.
 *  - **An unverified dialect is `unknown`, not read by another engine's rule.**
 *    A format is read only by its own explain strategy's `agentReading`
 *    (`src/lib/explain/<format>.ts`), which it carries once its reader has been
 *    verified against that engine's grammar. Applying one format's rule to another
 *    engine's grammar would be a claim about a plan nobody has looked at, and the
 *    same fail-closed argument `composed-sql.ts` makes for refusing to compose one.
 *
 * These are ESTIMATES throughout, and that is not a limitation to be worked around:
 * the executing form of EXPLAIN runs the statement, so it is default-denied
 * (`sqlExplainAnalyzeDescriptor`) and no tool reaches it. Whatever renders a
 * comparison owes the reader that sentence.
 */

import type { ExplainFormat } from "@/lib/db/types";
import { getExplainStrategy } from "@/lib/explain";
import type { AgentPlanSummary } from "@/lib/explain/plan-access";

export type { AgentPlanAccess, AgentPlanSummary } from "@/lib/explain/plan-access";

/**
 * Reads an estimating plan into the small structural summary a before/after
 * comparison is made of. Never throws: the upstream extractor is an unchecked cast,
 * so anything an engine or a driver produced has to arrive somewhere.
 *
 * The reading is the format's own (`ExplainStrategy.agentReading`), so this seam names
 * no format and no engine. A format whose strategy carries none, a text plan among
 * them, is `{ access: "unknown" }`: a text plan carries no field this layer can read,
 * and the fail-closed answer is the honest one rather than a guess.
 */
export function summarisePlan(
  format: ExplainFormat | undefined,
  rows: readonly Record<string, unknown>[],
): AgentPlanSummary {
  const reading = getExplainStrategy(format)?.agentReading;
  return reading === undefined ? { access: "unknown" } : reading.summarise(rows);
}
