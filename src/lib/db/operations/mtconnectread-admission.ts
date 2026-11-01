/**
 * The agent's admission of one MTConnect request line, next to the descriptor that reads it (`mtconnectread.query.read`).
 *
 * It is the provider's own reader (`readMtconnectAgentStatement` in `providers/industrial/mtconnect/agent-statement.ts`),
 * so the agent's tool path and the provider, which reads the same text with the same reader before it sends anything,
 * refuse the same requests with the same sentence. Plus one refusal of the agent's own, 4,096 characters, for the
 * reason the kubectl and MongoDB contracts have one: a model has no reason to send a longer read, and a shorter
 * contract is one it can be told.
 *
 * Not the boundary. The boundary is the provider's structural closed route table: nine routes, every one a GET, sent
 * by a client with no method argument and no body parameter; this is what lets the model read why it was refused,
 * before anything is sent.
 */
import { z } from "zod";
import { readMtconnectAgentStatement } from "@/lib/db/providers/industrial/mtconnect/agent-statement";

export const MTCONNECTREAD_AGENT_MAX_STATEMENT_CHARS = 4096;

export interface MtconnectreadAdmissionRefusal {
  readonly code: "request" | "agent-too-large";
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The request is longer than ${MTCONNECTREAD_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`;

/** The refusal an agent's MTConnect request meets before anything is sent, or null when it is admitted. */
export function admitMtconnectreadStatement(text: string): MtconnectreadAdmissionRefusal | null {
  if (text.length > MTCONNECTREAD_AGENT_MAX_STATEMENT_CHARS) {
    return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  }
  const reading = readMtconnectAgentStatement(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `mtconnectread.query.read` validates: one request, admitted. Strict, so a stray `sql` key is refused. */
export const mtconnectreadAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(MTCONNECTREAD_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitMtconnectreadStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
