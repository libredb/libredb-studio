/**
 * The agent's admission of one InfluxQL statement, next to the descriptor that reads it (`influxql.query.read`).
 *
 * It is the provider's own reader (`readInfluxqlAgentStatement` in
 * `providers/timeseries/influxdb/influxql-agent-statement.ts`), so the agent's tool path and the provider, which reads
 * the same text with the same reader before it sends anything, refuse the same statements with the same sentence: one
 * SELECT, SHOW of the catalog or EXPLAIN of a SELECT, with no comment and no carriage return, and the editor's read
 * policy under it. Plus one refusal of the agent's own, 4,096 characters, for the reason the kubectl and MongoDB
 * contracts have one: a model has no reason to send a longer read, and a shorter contract is one it can be told.
 *
 * Not the boundary. The boundary is the principal, proved read-only before every agent statement; this is what lets
 * the model read why it was refused, before anything is sent.
 */
import { z } from "zod";
import {
  type InfluxqlAgentRefusalCode,
  readInfluxqlAgentStatement,
} from "@/lib/db/providers/timeseries/influxdb/influxql-agent-statement";

export const INFLUXQL_AGENT_MAX_STATEMENT_CHARS = 4096;

export type InfluxqlAdmissionCode = InfluxqlAgentRefusalCode | "agent-too-large";

export interface InfluxqlAdmissionRefusal {
  readonly code: InfluxqlAdmissionCode;
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The statement is longer than ${INFLUXQL_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`;

/** The refusal an agent's InfluxQL statement meets before anything is sent, or null when it is admitted. */
export function admitInfluxqlStatement(text: string): InfluxqlAdmissionRefusal | null {
  if (text.length > INFLUXQL_AGENT_MAX_STATEMENT_CHARS) return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  const reading = readInfluxqlAgentStatement(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `influxql.query.read` validates: one statement, admitted. Strict, so a stray `sql` key is refused. */
export const influxqlAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(INFLUXQL_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitInfluxqlStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
