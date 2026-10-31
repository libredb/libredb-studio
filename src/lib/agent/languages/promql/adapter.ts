/**
 * What the server does for a PromQL read: the repair ledger's identity of one read, the row-cap advice, and the
 * admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { admitPromqlStatement } from "@/lib/db/operations/promql-admission";
import { readPrometheusAgentStatement } from "@/lib/db/providers/timeseries/prometheus/agent-statement";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/**
 * A PromQL read's identity in the repair ledger: the expression the reader admits, outer whitespace dropped, so
 * ` up ` and `up` are one read and `up` and `up[5m]` are two. Total: an expression the reader refuses is identified by
 * its raw text, so a refused read is still refused the second time.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintPromql(text: string): string {
  const reading = readPrometheusAgentStatement(text);
  const canonical = reading.ok ? `promql:${reading.expression.trim()}` : `promql-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * The sentence for a PromQL read refused past the row budget. A vector answers one row per series and a matrix one per
 * sample, and neither is ever cut, so the advice is fewer series or fewer samples.
 */
export function promqlRowCapAdvice(_statement: string, allowed: string): string {
  return `Ask for at most ${allowed} rows: a vector answers one row per series and a matrix one per sample, so aggregate (sum by (job) (...)), narrow the selector with label matchers, or shorten a range vector or widen a subquery's step, and run it again.`;
}

export const PROMQL_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "promql.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintPromql,
  rowCapAdvice: promqlRowCapAdvice,
  admit: admitPromqlStatement,
  shapeAdvice:
    "The expression's shape falls outside what a bounded PromQL read may be, which is a decision about the contract rather than about a valid PromQL expression; a differently shaped read may still be admitted.",
});
