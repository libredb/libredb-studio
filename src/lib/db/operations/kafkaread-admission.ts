/**
 * The agent's admission of one Kafka read request, next to the descriptor that reads it (`kafkaread.query.read`).
 *
 * It is the provider's own reader (`readKafkaAgentStatement` in `providers/stream/kafka/agent-statement.ts`), so the
 * agent's tool path and the provider, which reads the same text with the same reader before it sends anything, refuse
 * the same requests with the same sentence. Plus one refusal of the agent's own, 4,096 characters, for the reason the
 * kubectl and MongoDB contracts have one: a model has no reason to send a longer read, and a shorter contract is one it
 * can be told.
 *
 * Not the boundary. The boundary is the provider's structural closed table, an agent client that holds the Metadata
 * and ListOffsets reads alone; this is what lets the model read why it was refused, before anything is sent.
 */
import { z } from "zod";
import { type KafkaAgentRefusalCode, readKafkaAgentStatement } from "@/lib/db/providers/stream/kafka/agent-statement";

export const KAFKAREAD_AGENT_MAX_STATEMENT_CHARS = 4096;

export type KafkareadAdmissionCode = KafkaAgentRefusalCode | "agent-too-large";

export interface KafkareadAdmissionRefusal {
  readonly code: KafkareadAdmissionCode;
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The read request is longer than ${KAFKAREAD_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`;

/** The refusal an agent's Kafka read request meets before anything is sent, or null when it is admitted. */
export function admitKafkareadStatement(text: string): KafkareadAdmissionRefusal | null {
  if (text.length > KAFKAREAD_AGENT_MAX_STATEMENT_CHARS) {
    return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  }
  const reading = readKafkaAgentStatement(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `kafkaread.query.read` validates: one read request, admitted. Strict, so a stray `sql` key is refused. */
export const kafkareadAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(KAFKAREAD_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitKafkareadStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
