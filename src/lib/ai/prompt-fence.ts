/**
 * The prompt-side fence for the standalone AI surfaces.
 *
 * The agent runtime already wraps every database-derived block before it reaches a
 * prompt (`src/lib/agent/untrusted-content.ts`). The three standalone AI routes —
 * `describe-schema`, `explain` and `query-safety` — did not, so a table name, a
 * column comment or an engine plan written by whoever can write to the database
 * reached the model as if the server had said it. This module is that shared fence,
 * reusing the agent's `fenceUntrustedContent` so the two paths cannot disagree about
 * the marker pair or the neutralisation rule.
 *
 * The fence is a labeling boundary, not a sanitiser: it says where the server
 * stopped talking. Value redaction for the Data Profiler's min/max is a separate
 * concern and lives beside the masking configuration (`src/lib/data-masking.ts`).
 */

import { fenceUntrustedContent } from "@/lib/agent/untrusted-content";

/** The three standalone AI surfaces that reach a model with user/database content. */
export type AiSurface = "describe-schema" | "explain" | "query-safety";

const SURFACE_LABEL: Record<AiSurface, string> = {
  "describe-schema": "schema context",
  explain: "query / plan / schema",
  "query-safety": "query / schema",
};

/**
 * Wraps one database-derived block for a standalone AI prompt. The `surface` names
 * the route, which becomes the operation id and reference so a prompt reader can
 * tell where a block came from without the server's own prose vouching for it.
 */
export function fenceForPrompt(content: string, surface: AiSurface): string {
  return fenceUntrustedContent(content, {
    label: SURFACE_LABEL[surface],
    operationId: `ai.${surface}`,
    reference: surface,
  });
}

/**
 * Serialises and fences an EXPLAIN plan. `JSON.stringify` returns `undefined` for a
 * value it cannot serialise, so the text is normalised to `"null"` rather than
 * letting the fence wrap the word `undefined`, which would read as server prose.
 */
export function fenceExplainPlan(plan: unknown): string {
  const text = JSON.stringify(plan, null, 2) ?? "null";
  return fenceForPrompt(text, "explain");
}
