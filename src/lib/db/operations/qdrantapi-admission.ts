/**
 * The agent's admission of one Qdrant request, next to the descriptor that reads it (`qdrantapi.query.read`).
 *
 * It is the provider's own reader (`readQdrantAgentStatement` in `providers/vector/qdrant/metadata-request.ts`), so
 * the agent's tool path and the provider, which reads the same text with the same reader before it sends anything,
 * refuse the same requests with the same sentence: one metadata read or bare point count, in the console's own
 * grammar with every body key closed. Plus one refusal of the agent's own, 4,096 characters, for the reason the
 * kubectl and MongoDB contracts have one: a model has no reason to send a longer read, and a shorter contract is one
 * it can be told.
 *
 * Not the boundary. The boundary is the provider's closed route table and the read-only key the server proves before
 * every agent request; this is what lets the model read why it was refused, before anything is sent.
 */
import { z } from "zod";
import {
  type QdrantAgentRefusalCode,
  readQdrantAgentStatement,
} from "@/lib/db/providers/vector/qdrant/metadata-request";

export const QDRANTAPI_AGENT_MAX_STATEMENT_CHARS = 4096;

export type QdrantapiAdmissionCode = QdrantAgentRefusalCode | "agent-too-large";

export interface QdrantapiAdmissionRefusal {
  readonly code: QdrantapiAdmissionCode;
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The request is longer than ${QDRANTAPI_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`;

/** The refusal an agent's Qdrant request meets before anything is sent, or null when it is admitted. */
export function admitQdrantapiStatement(text: string): QdrantapiAdmissionRefusal | null {
  if (text.length > QDRANTAPI_AGENT_MAX_STATEMENT_CHARS) {
    return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  }
  const reading = readQdrantAgentStatement(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `qdrantapi.query.read` validates: one request, admitted. Strict, so a stray `sql` key is refused. */
export const qdrantapiAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(QDRANTAPI_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitQdrantapiStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
