/**
 * The agent's admission of one Redis command, next to the descriptor that reads it (`rediscli.query.read`).
 *
 * It is the provider's own reader (`readRedisAgentStatement` in `providers/keyvalue/redis-agent-statement.ts`), so the
 * agent's tool path and the provider, which reads the same text with the same reader before it sends anything, refuse
 * the same commands with the same sentence: one metadata read of the closed table, on one line. Plus one refusal of the
 * agent's own, 4,096 characters, for the reason the kubectl and MongoDB contracts have one: a model has no reason to
 * send a longer read, and a shorter contract is one it can be told.
 *
 * Not the boundary. The boundary is the provider's closed command table and the read-only ACL user the server proves
 * before every agent command; this is what lets the model read why it was refused, before anything is sent.
 */
import { z } from "zod";
import { type RedisAgentRefusalCode, readRedisAgentStatement } from "@/lib/db/providers/keyvalue/redis-agent-statement";

export const REDISCLI_AGENT_MAX_STATEMENT_CHARS = 4096;

export type RediscliAdmissionCode = RedisAgentRefusalCode | "agent-too-large";

export interface RediscliAdmissionRefusal {
  readonly code: RediscliAdmissionCode;
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The command is longer than ${REDISCLI_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`;

/** The refusal an agent's Redis command meets before anything is sent, or null when it is admitted. */
export function admitRediscliStatement(text: string): RediscliAdmissionRefusal | null {
  if (text.length > REDISCLI_AGENT_MAX_STATEMENT_CHARS) {
    return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  }
  const reading = readRedisAgentStatement(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `rediscli.query.read` validates: one command, admitted. Strict, so a stray `sql` key is refused. */
export const rediscliAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(REDISCLI_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitRediscliStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
