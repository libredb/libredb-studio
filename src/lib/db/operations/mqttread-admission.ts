/**
 * The agent's admission of one MQTT read request, next to the descriptor that reads it (`mqttread.query.read`).
 *
 * It is the provider's own reader (`readMqttAgentStatement` in `providers/keyvalue/mqtt/agent-statement.ts`), so the
 * agent's tool path and the provider, which reads the same text with the same reader before it sends anything, refuse
 * the same requests with the same sentence. Plus one refusal of the agent's own, 4,096 characters, for the reason the
 * kubectl and MongoDB contracts have one: a model has no reason to send a longer read, and a shorter contract is one it
 * can be told.
 *
 * Not the boundary. The boundary is the provider's structural closed table: an encoder of five packets with no
 * PUBLISH, a CONNECT with no Will, and the valve's check of every outbound byte; this is what lets the model read why
 * it was refused, before anything is sent.
 */
import { z } from "zod";
import { type MqttAgentRefusalCode, readMqttAgentStatement } from "@/lib/db/providers/keyvalue/mqtt/agent-statement";

export const MQTTREAD_AGENT_MAX_STATEMENT_CHARS = 4096;

export interface MqttreadAdmissionRefusal {
  readonly code: MqttAgentRefusalCode | "agent-too-large";
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The request is longer than ${MQTTREAD_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`;

/** The refusal an agent's MQTT request meets before anything is sent, or null when it is admitted. */
export function admitMqttreadStatement(text: string): MqttreadAdmissionRefusal | null {
  if (text.length > MQTTREAD_AGENT_MAX_STATEMENT_CHARS) {
    return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  }
  const reading = readMqttAgentStatement(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `mqttread.query.read` validates: one request, admitted. Strict, so a stray `sql` key is refused. */
export const mqttreadAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(MQTTREAD_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitMqttreadStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
