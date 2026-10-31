/**
 * The agent's admission of one Modbus read request, next to the descriptor that reads it (`modbusread.query.read`).
 *
 * It is the provider's own reader (`readModbusAgentStatement` in `providers/industrial/modbus/agent-statement.ts`),
 * so the agent's tool path and the provider, which reads the same text with the same reader before it sends anything,
 * refuse the same requests with the same sentence. The admission has no connection in hand, so it reads a point name's
 * shape alone and the provider reads the names against the connection's register map. Plus one refusal of the agent's
 * own, 4,096 characters, for the reason the kubectl and MongoDB contracts have one: a model has no reason to send a
 * longer read, and a shorter contract is one it can be told.
 *
 * Not the boundary. The boundary is the provider's structural closed table, the five request builders of `pdu.ts`
 * behind the valve that refuses every function code but the four reads and 43/14 before `socket.write`; this is what
 * lets the model read why it was refused, before anything is sent.
 */
import { z } from "zod";
import { readModbusAgentStatement } from "@/lib/db/providers/industrial/modbus/agent-statement";

export const MODBUSREAD_AGENT_MAX_STATEMENT_CHARS = 4096;

export interface ModbusreadAdmissionRefusal {
  readonly code: "request" | "agent-too-large";
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The request is longer than ${MODBUSREAD_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`;

/** The refusal an agent's Modbus request meets before anything is sent, or null when it is admitted. */
export function admitModbusreadStatement(text: string): ModbusreadAdmissionRefusal | null {
  if (text.length > MODBUSREAD_AGENT_MAX_STATEMENT_CHARS) {
    return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  }
  const reading = readModbusAgentStatement(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `modbusread.query.read` validates: one request, admitted. Strict, so a stray `sql` key is refused. */
export const modbusreadAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(MODBUSREAD_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitModbusreadStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
