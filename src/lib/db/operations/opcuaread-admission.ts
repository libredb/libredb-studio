/**
 * The agent's admission of one OPC UA read request, next to the descriptor that reads it (`opcuaread.query.read`).
 *
 * It is the provider's own reader (`readOpcuaAgentStatement` in `providers/industrial/opcua/agent-statement.ts`), so
 * the agent's tool path and the provider, which reads the same text with the same reader before it sends anything,
 * refuse the same requests with the same sentence. Plus one refusal of the agent's own, 4,096 characters, for the
 * reason the kubectl and MongoDB contracts have one: a model has no reason to send a longer read, and a shorter
 * contract is one it can be told.
 *
 * Not the boundary. The boundary is the provider's structural closed seam, `OpcuaReadOnlyClient`, which holds eight
 * read services and nothing that writes, calls a method or subscribes; this is what lets the model read why it was
 * refused, before anything is sent.
 */
import { z } from "zod";
import { readOpcuaAgentStatement } from "@/lib/db/providers/industrial/opcua/agent-statement";

export const OPCUAREAD_AGENT_MAX_STATEMENT_CHARS = 4096;

export interface OpcuareadAdmissionRefusal {
  readonly code: "request" | "withheld" | "agent-too-large";
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The request is longer than ${OPCUAREAD_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`;

/** The refusal an agent's OPC UA request meets before anything is sent, or null when it is admitted. */
export function admitOpcuareadStatement(text: string): OpcuareadAdmissionRefusal | null {
  if (text.length > OPCUAREAD_AGENT_MAX_STATEMENT_CHARS) {
    return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  }
  const reading = readOpcuaAgentStatement(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `opcuaread.query.read` validates: one request, admitted. Strict, so a stray `sql` key is refused. */
export const opcuareadAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(OPCUAREAD_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitOpcuareadStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
