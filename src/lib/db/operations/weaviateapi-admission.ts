/**
 * The agent's admission of one Weaviate request, next to the descriptor that reads it (`weaviateapi.query.read`).
 *
 * It is the provider's own reader (`readWeaviateAgentStatement` in `providers/vector/weaviate/metadata-request.ts`), so
 * the agent's tool path and the provider, which reads the same text with the same reader before it sends anything,
 * refuse the same requests with the same sentence: one metadata read or bare aggregate count, in the console's own
 * grammar with every body key closed. Plus one refusal of the agent's own, 4,096 characters, for the reason the
 * kubectl and MongoDB contracts have one: a model has no reason to send a longer read, and a shorter contract is one
 * it can be told.
 *
 * Not the boundary. The boundary is the provider's closed operation table and the viewer the server proves before
 * every agent request; this is what lets the model read why it was refused, before anything is sent.
 */
import { z } from "zod";
import {
  readWeaviateAgentStatement,
  type WeaviateAgentRefusalCode,
} from "@/lib/db/providers/vector/weaviate/metadata-request";

export const WEAVIATEAPI_AGENT_MAX_STATEMENT_CHARS = 4096;

export type WeaviateapiAdmissionCode = WeaviateAgentRefusalCode | "agent-too-large";

export interface WeaviateapiAdmissionRefusal {
  readonly code: WeaviateapiAdmissionCode;
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The request is longer than ${WEAVIATEAPI_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`;

/** The refusal an agent's Weaviate request meets before anything is sent, or null when it is admitted. */
export function admitWeaviateapiStatement(text: string): WeaviateapiAdmissionRefusal | null {
  if (text.length > WEAVIATEAPI_AGENT_MAX_STATEMENT_CHARS) {
    return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  }
  const reading = readWeaviateAgentStatement(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `weaviateapi.query.read` validates: one request, admitted. Strict, so a stray `sql` key is refused. */
export const weaviateapiAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(WEAVIATEAPI_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitWeaviateapiStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
