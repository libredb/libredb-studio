import type { ExplainFormat } from "@/lib/db/types";
import { getExplainStrategy, resolveExplainPlan } from "@/lib/explain";
import type { AgentChartSpec, QueryResult } from "@/lib/types";

/**
 * One agent artifact, read into a surface this app already has (#329 T11).
 *
 * The rail cites results; it does not render them. What a user asks to SEE is
 * hydrated into the bottom panel's existing grid and explain view, because a run's
 * result is an ordinary result and a second grid inside the rail would be a second
 * thing to keep correct. This module is the whole translation, and it is pure so it
 * can be tested without a browser.
 *
 * Two decisions are deliberate:
 *
 *  - **The surface is chosen from what the RUN RECORDED, never from the shape of the
 *    rows.** A plan comes from `sql.explain.estimate` and nothing else, so a read
 *    whose rows happen to look like a plan is still a read; and the charts surface
 *    comes from an answer the run composed as a chart, so a result nobody said to
 *    chart is shown as a table however chartable its columns look.
 *  - **A plan this connection cannot parse falls back to the grid.** The rows are
 *    real rows either way; showing them beats an explain view with nothing in it.
 *    That happens when the provider declares no `explainFormat` at all, and when the
 *    strategy renders nothing from what the run stored.
 *
 * Nothing here trusts the payload: it crosses HTTP, so every field is checked before
 * it is read, and an unreadable one yields null rather than a half-built view.
 */

/** What the bottom panel is given, plus the provenance the badge names. */
export interface AgentArtifactHydration {
  readonly runId: string;
  readonly correlationId: string;
  /** Registry-resolved operation id — the server's word, shown verbatim. */
  readonly operationId: string;
  /** Which existing surface renders it. */
  readonly surface: "results" | "explain" | "charts";
  readonly result: QueryResult;
  /** Shaped exactly like `QueryTab.explainPlan`, so the explain view needs no new case. */
  readonly explainPlan: { readonly format: ExplainFormat; readonly raw: unknown } | null;
  /**
   * How the run said to draw this result, when it said to draw one at all.
   *
   * Null for every artifact shown from anywhere but an answer, which is what keeps
   * "the surface came from the record" true: nothing here reads the rows to decide
   * that a chart would suit them. The component that draws it validates the columns
   * again before it uses them, because a spec is only as good as the result actually
   * delivered to the browser.
   */
  readonly chartSpec: AgentChartSpec | null;
}

const PLAN_OPERATION_PREFIX = "sql.explain.";

function isQueryResult(value: unknown): value is QueryResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { rows?: unknown; fields?: unknown };
  return Array.isArray(candidate.rows) && Array.isArray(candidate.fields);
}

export function hydrateAgentArtifact(
  payload: unknown,
  explainFormat: ExplainFormat | undefined,
  /**
   * The presentation the run recorded for this artifact, when it recorded one. It
   * comes from the ledger the rail is already reading, not from this payload: the
   * decision is the run's, and the route serves rows and their provenance.
   */
  chartSpec?: AgentChartSpec,
): AgentArtifactHydration | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { runId, correlationId, operationId, result } = payload as Record<string, unknown>;
  if (typeof runId !== "string" || typeof correlationId !== "string" || typeof operationId !== "string") return null;
  if (!isQueryResult(result)) return null;

  // The recorded presentation wins: an answer composed as a chart is a chart of its
  // rows, and there is no plan to render beside it.
  if (chartSpec !== undefined) {
    return { runId, correlationId, operationId, surface: "charts", result, explainPlan: null, chartSpec };
  }

  const strategy = operationId.startsWith(PLAN_OPERATION_PREFIX) ? getExplainStrategy(explainFormat) : null;
  const plan = strategy === null ? null : { format: strategy.format, raw: strategy.extractPlan(result) };
  // Asked of the same resolver the panel renders through: a plan that resolves to
  // nothing there would leave the explain view empty, so it is not sent there.
  const renderable = plan !== null && resolveExplainPlan(plan) !== null;

  return {
    runId,
    correlationId,
    operationId,
    surface: renderable ? "explain" : "results",
    result,
    explainPlan: renderable ? plan : null,
    chartSpec: null,
  };
}
