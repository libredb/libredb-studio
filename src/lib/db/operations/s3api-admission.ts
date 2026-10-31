/**
 * The agent's admission of one S3 command, next to the descriptor that reads it (`s3api.query.read`).
 *
 * It is the provider's own reader (`readS3AgentStatement` in `providers/objectstore/s3/agent-statement.ts`), so the
 * agent's tool path and the provider, which reads the same text with the same reader and the connection's pinned bucket
 * before it sends anything, refuse the same commands with the same sentence. Plus one refusal of the agent's own, 4,096
 * characters, for the reason the kubectl and MongoDB contracts have one: a model has no reason to send a longer read,
 * and a shorter contract is one it can be told.
 *
 * Not the boundary. The boundary is the provider's structural closed table, an agent client that holds six GET and HEAD
 * reads of bucket and named-object metadata alone; this is what lets the model read why it was refused, before anything
 * is sent.
 */
import { z } from "zod";
import { readS3AgentStatement, type S3AgentRefusalCode } from "@/lib/db/providers/objectstore/s3/agent-statement";

export const S3API_AGENT_MAX_STATEMENT_CHARS = 4096;

export type S3apiAdmissionCode = S3AgentRefusalCode | "agent-too-large";

export interface S3apiAdmissionRefusal {
  readonly code: S3apiAdmissionCode;
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The command is longer than ${S3API_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`;

/** The refusal an agent's S3 command meets before anything is sent, or null when it is admitted. */
export function admitS3apiStatement(text: string): S3apiAdmissionRefusal | null {
  if (text.length > S3API_AGENT_MAX_STATEMENT_CHARS) {
    return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  }
  const reading = readS3AgentStatement(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `s3api.query.read` validates: one command, admitted. Strict, so a stray `sql` key is refused. */
export const s3apiAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(S3API_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitS3apiStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
