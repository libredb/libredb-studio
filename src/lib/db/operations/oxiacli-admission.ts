/**
 * The agent's admission of one Oxia command, next to the descriptor that reads it (`oxiacli.query.read`).
 *
 * It is the provider's own reader (`readOxiaAgentStatement` in `providers/keyvalue/oxia/agent-statement.ts`), so the
 * agent's tool path and the provider, which reads the same text with the same reader before it sends anything, refuse
 * the same commands with the same sentence: one metadata read of the closed table, on one line. Plus one refusal of the
 * agent's own, 4,096 characters, for the reason the kubectl and MongoDB contracts have one: a model has no reason to
 * send a longer read, and a shorter contract is one it can be told.
 *
 * Not the boundary. The boundary is the provider's closed table over a stub that holds only reads; this is what lets
 * the model read why it was refused, before anything is sent.
 */
import { z } from "zod";
import { type OxiaAgentRefusalCode, readOxiaAgentStatement } from "@/lib/db/providers/keyvalue/oxia/agent-statement";

export const OXIACLI_AGENT_MAX_STATEMENT_CHARS = 4096;

export type OxiacliAdmissionCode = OxiaAgentRefusalCode | "agent-too-large";

export interface OxiacliAdmissionRefusal {
  readonly code: OxiacliAdmissionCode;
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The command is longer than ${OXIACLI_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`;

/** The refusal an agent's Oxia command meets before anything is sent, or null when it is admitted. */
export function admitOxiacliStatement(text: string): OxiacliAdmissionRefusal | null {
  if (text.length > OXIACLI_AGENT_MAX_STATEMENT_CHARS) {
    return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  }
  const reading = readOxiaAgentStatement(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `oxiacli.query.read` validates: one command, admitted. Strict, so a stray `sql` key is refused. */
export const oxiacliAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(OXIACLI_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitOxiacliStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
