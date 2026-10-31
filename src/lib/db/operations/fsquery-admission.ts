/**
 * The agent's admission of one Firestore statement, next to the descriptor that reads it (`fsquery.query.read`).
 *
 * It is the provider's own reader (`readFirestoreAgentStatement` in `providers/document/firestore/agent-statement.ts`),
 * so the agent's tool path and the provider, which reads the same text with the same reader before it sends anything,
 * refuse the same statements with the same sentence. Plus one refusal of the agent's own, 4,096 characters, for the
 * reason the kubectl and MongoDB contracts have one: a model has no reason to send a longer read, and a shorter
 * contract is one it can be told.
 *
 * Not the boundary. The boundary is the provider's structural closed table, an agent client that holds three kinds of
 * metadata request alone over a request table that admits reads only; this is what lets the model read why it was
 * refused, before anything is sent.
 */
import { z } from "zod";
import {
  type FirestoreAgentRefusalCode,
  readFirestoreAgentStatement,
} from "@/lib/db/providers/document/firestore/agent-statement";

export const FSQUERY_AGENT_MAX_STATEMENT_CHARS = 4096;

export type FsqueryAdmissionCode = FirestoreAgentRefusalCode | "agent-too-large";

export interface FsqueryAdmissionRefusal {
  readonly code: FsqueryAdmissionCode;
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The statement is longer than ${FSQUERY_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`;

/** The refusal an agent's Firestore statement meets before anything is sent, or null when it is admitted. */
export function admitFsqueryStatement(text: string): FsqueryAdmissionRefusal | null {
  if (text.length > FSQUERY_AGENT_MAX_STATEMENT_CHARS) {
    return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  }
  const reading = readFirestoreAgentStatement(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `fsquery.query.read` validates: one statement, admitted. Strict, so a stray `sql` key is refused. */
export const fsqueryAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(FSQUERY_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitFsqueryStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
