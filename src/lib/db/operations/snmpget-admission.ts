/**
 * The agent's admission of one SNMP command, next to the descriptor that reads it (`snmpget.query.read`).
 *
 * It is the provider's own reader (`readSnmpAgentStatement` in `providers/network/snmp/agent-statement.ts`), so the
 * agent's tool path and the provider, which reads the same text with the same reader before it sends anything, refuse
 * the same commands with the same sentence. Plus one refusal of the agent's own, 4,096 characters, for the reason the
 * kubectl and MongoDB contracts have one: a model has no reason to send a longer read, and a shorter contract is one it
 * can be told.
 *
 * Not the boundary. The boundary is the provider's structural closed table, an agent client that holds Get, GetNext
 * and GetBulk alone behind the valve that refuses every other PDU; this is what lets the model read why it was
 * refused, before anything is sent.
 */
import { z } from "zod";
import { readSnmpAgentStatement, type SnmpAgentRefusalCode } from "@/lib/db/providers/network/snmp/agent-statement";

export const SNMPGET_AGENT_MAX_STATEMENT_CHARS = 4096;

export type SnmpgetAdmissionCode = SnmpAgentRefusalCode | "agent-too-large";

export interface SnmpgetAdmissionRefusal {
  readonly code: SnmpgetAdmissionCode;
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The command is longer than ${SNMPGET_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`;

/** The refusal an agent's SNMP command meets before anything is sent, or null when it is admitted. */
export function admitSnmpgetStatement(text: string): SnmpgetAdmissionRefusal | null {
  if (text.length > SNMPGET_AGENT_MAX_STATEMENT_CHARS) {
    return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  }
  const reading = readSnmpAgentStatement(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `snmpget.query.read` validates: one command, admitted. Strict, so a stray `sql` key is refused. */
export const snmpgetAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(SNMPGET_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitSnmpgetStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
