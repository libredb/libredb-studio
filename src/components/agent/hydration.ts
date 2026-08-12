import type { ExplainFormat } from "@/lib/db/types";
import { getExplainStrategy, resolveExplainPlan } from "@/lib/explain";
import type { QueryResult } from "@/lib/types";

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
 *  - **The surface is chosen from the OPERATION, never from the shape of the rows.**
 *    A plan comes from `sql.explain.estimate` and nothing else, so a read whose rows
 *    happen to look like a plan is still a read.
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
  readonly surface: "results" | "explain";
  readonly result: QueryResult;
  /** Shaped exactly like `QueryTab.explainPlan`, so the explain view needs no new case. */
  readonly explainPlan: { readonly format: ExplainFormat; readonly raw: unknown } | null;
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
): AgentArtifactHydration | null {
  if (typeof payload !== "object" || payload === null) return null;
  const { runId, correlationId, operationId, result } = payload as Record<string, unknown>;
  if (typeof runId !== "string" || typeof correlationId !== "string" || typeof operationId !== "string") return null;
  if (!isQueryResult(result)) return null;

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
  };
}
