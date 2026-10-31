/**
 * The agent's admission of one NETCONF request, next to the descriptor that reads it (`netconfrpc.query.read`).
 *
 * It is the provider's own reader (`readNetconfAgentStatement` in `providers/network/netconf/agent-statement.ts`), so
 * the agent's tool path and the provider, which reads the same text with the same reader before it sends anything,
 * refuse the same requests with the same sentence. Plus one refusal of the agent's own, 4,096 characters, for the
 * reason the kubectl and MongoDB contracts have one: a model has no reason to send a longer read, and a shorter
 * contract is one it can be told.
 *
 * Not the boundary. The boundary is the provider's structural closed table, an agent client whose requests are the
 * reads of the one request builder, which holds no write; this is what lets the model read why it was refused, before
 * anything is sent.
 */
import { z } from "zod";
import {
  readNetconfAgentStatement,
  type NetconfAgentRefusalCode,
} from "@/lib/db/providers/network/netconf/agent-statement";

export const NETCONFRPC_AGENT_MAX_STATEMENT_CHARS = 4096;

export type NetconfrpcAdmissionCode = NetconfAgentRefusalCode | "agent-too-large";

export interface NetconfrpcAdmissionRefusal {
  readonly code: NetconfrpcAdmissionCode;
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The request is longer than ${NETCONFRPC_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`;

/** The refusal an agent's NETCONF request meets before anything is sent, or null when it is admitted. */
export function admitNetconfrpcStatement(text: string): NetconfrpcAdmissionRefusal | null {
  if (text.length > NETCONFRPC_AGENT_MAX_STATEMENT_CHARS) {
    return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  }
  const reading = readNetconfAgentStatement(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `netconfrpc.query.read` validates: one request, admitted. Strict, so a stray `sql` key is refused. */
export const netconfrpcAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(NETCONFRPC_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitNetconfrpcStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
