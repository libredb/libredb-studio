/**
 * The agent's admission of one Milvus request, next to the descriptor that reads it (`milvusrpc.query.read`).
 *
 * It is the provider's own reader (`readMilvusAgentStatement` in `providers/vector/milvus/metadata-request.ts`), so
 * the agent's tool path and the provider, which reads the same text with the same reader before it sends anything,
 * refuse the same requests with the same sentence: one metadata read, in the console's own grammar with every body
 * key closed. Read here without the connection, a `dbName` is left to the provider, which reads it again in the
 * connection's database. Plus one refusal of the agent's own, 4,096 characters, for the reason the kubectl and
 * MongoDB contracts have one: a model has no reason to send a longer read, and a shorter contract is one it can be
 * told.
 *
 * Not the boundary. The boundary is the provider's closed RPC table and the read-only user the server proves before
 * every agent request; this is what lets the model read why it was refused, before anything is sent.
 */
import { z } from "zod";
import {
  type MilvusAgentRefusalCode,
  readMilvusAgentStatement,
} from "@/lib/db/providers/vector/milvus/metadata-request";

export const MILVUSRPC_AGENT_MAX_STATEMENT_CHARS = 4096;

export type MilvusrpcAdmissionCode = MilvusAgentRefusalCode | "agent-too-large";

export interface MilvusrpcAdmissionRefusal {
  readonly code: MilvusrpcAdmissionCode;
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The request is longer than ${MILVUSRPC_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`;

/** The refusal an agent's Milvus request meets before anything is sent, or null when it is admitted. */
export function admitMilvusrpcStatement(text: string): MilvusrpcAdmissionRefusal | null {
  if (text.length > MILVUSRPC_AGENT_MAX_STATEMENT_CHARS) {
    return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  }
  const reading = readMilvusAgentStatement(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `milvusrpc.query.read` validates: one request, admitted. Strict, so a stray `sql` key is refused. */
export const milvusrpcAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(MILVUSRPC_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitMilvusrpcStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
