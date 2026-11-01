/**
 * The agent's admission of one Sparkplug read request, next to the descriptor that reads it
 * (`sparkplugread.query.read`).
 *
 * It is the provider's own reader (`readSparkplugAgentStatement` in `providers/industrial/sparkplug/agent-statement.ts`),
 * so the agent's tool path and the provider, which reads the same text with the same reader before it sends anything,
 * refuse the same requests with the same sentence. Plus one refusal of the agent's own, 4,096 characters, for the
 * reason the kubectl and MongoDB contracts have one: a model has no reason to send a longer read, and a shorter
 * contract is one it can be told.
 *
 * Not the boundary. The boundary is the provider's structural closed table: an encoder of five packets with no
 * PUBLISH and a CONNECT with no Will; this is what lets the model read why it was refused, before anything is sent.
 */
import { z } from "zod";
import {
  readSparkplugAgentStatement,
  type SparkplugAgentRefusalCode,
} from "@/lib/db/providers/industrial/sparkplug/agent-statement";

export const SPARKPLUGREAD_AGENT_MAX_STATEMENT_CHARS = 4096;

export interface SparkplugreadAdmissionRefusal {
  readonly code: SparkplugAgentRefusalCode | "agent-too-large";
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The request is longer than ${SPARKPLUGREAD_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`;

/** The refusal an agent's Sparkplug request meets before anything is sent, or null when it is admitted. */
export function admitSparkplugreadStatement(text: string): SparkplugreadAdmissionRefusal | null {
  if (text.length > SPARKPLUGREAD_AGENT_MAX_STATEMENT_CHARS) {
    return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  }
  const reading = readSparkplugAgentStatement(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `sparkplugread.query.read` validates: one request, admitted. Strict, so a stray `sql` key is refused. */
export const sparkplugreadAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(SPARKPLUGREAD_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitSparkplugreadStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
