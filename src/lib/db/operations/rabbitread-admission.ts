/**
 * The agent's admission of one RabbitMQ read request, next to the descriptor that reads it (`rabbitread.query.read`).
 *
 * It is the provider's own reader (`readRabbitMQAgentStatement` in `providers/stream/rabbitmq/agent-statement.ts`), so
 * the agent's tool path and the provider, which reads the same text with the same reader before it sends anything,
 * refuse the same requests with the same sentence: one read request of the editor's own shape. Plus one refusal of the
 * agent's own, 4,096 characters, for the reason the kubectl and MongoDB contracts have one: a model has no reason to
 * send a longer read, and a shorter contract is one it can be told.
 *
 * Not the boundary. The boundary is the provider's structural closed table (an AMQP client that encodes no take,
 * publish, purge or declare, the stream-only type check before any frame and the `x-stream-offset` 406 backstop); this
 * is what lets the model read why it was refused, before anything is sent.
 */
import { z } from "zod";
import {
  type RabbitMQAgentRefusalCode,
  readRabbitMQAgentStatement,
} from "@/lib/db/providers/stream/rabbitmq/agent-statement";

export const RABBITREAD_AGENT_MAX_STATEMENT_CHARS = 4096;

export type RabbitreadAdmissionCode = RabbitMQAgentRefusalCode | "agent-too-large";

export interface RabbitreadAdmissionRefusal {
  readonly code: RabbitreadAdmissionCode;
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The read request is longer than ${RABBITREAD_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`;

/** The refusal an agent's RabbitMQ read request meets before anything is sent, or null when it is admitted. */
export function admitRabbitreadStatement(text: string): RabbitreadAdmissionRefusal | null {
  if (text.length > RABBITREAD_AGENT_MAX_STATEMENT_CHARS) {
    return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  }
  const reading = readRabbitMQAgentStatement(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `rabbitread.query.read` validates: one read request, admitted. Strict, so a stray `sql` key is refused. */
export const rabbitreadAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(RABBITREAD_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitRabbitreadStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
