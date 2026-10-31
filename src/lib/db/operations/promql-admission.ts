/**
 * The agent's admission of one PromQL read, next to the descriptor that reads it (`promql.query.read`).
 *
 * It is the provider's own reader (`readPrometheusAgentStatement` in
 * `providers/timeseries/prometheus/agent-statement.ts`), so the agent's tool path and the provider, which reads the
 * same text with the same reader before it sends anything, refuse the same reads with the same sentence. Plus one
 * refusal of the agent's own, 4,096 characters, for the reason the kubectl and MongoDB contracts have one: a model has
 * no reason to send a longer read, and a shorter contract is one it can be told.
 *
 * Not the boundary. The boundary is the provider's structural closed table: its transport builds requests only to its
 * own read paths, the one POST being the instant query, and PromQL has no construct that writes; this is what lets the
 * model read why it was refused, before anything is sent.
 */
import { z } from "zod";
import { readPrometheusAgentStatement } from "@/lib/db/providers/timeseries/prometheus/agent-statement";

export const PROMQL_AGENT_MAX_STATEMENT_CHARS = 4096;

export interface PromqlAdmissionRefusal {
  readonly code: "statement" | "agent-too-large";
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The expression is longer than ${PROMQL_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`;

/** The refusal an agent's PromQL read meets before anything is sent, or null when it is admitted. */
export function admitPromqlStatement(text: string): PromqlAdmissionRefusal | null {
  if (text.length > PROMQL_AGENT_MAX_STATEMENT_CHARS) return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  const reading = readPrometheusAgentStatement(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `promql.query.read` validates: one expression, admitted. Strict, so a stray `sql` key is refused. */
export const promqlAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(PROMQL_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitPromqlStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
