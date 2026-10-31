/**
 * The agent's admission of one etcdctl command, next to the descriptor that reads it (`etcdctl.query.read`).
 *
 * It is the provider's own reader (`readEtcdAgentStatement` in `providers/keyvalue/etcd/agent-statement.ts`), so the
 * agent's tool path and the provider, which reads the same text with the same reader before it sends anything, refuse
 * the same commands with the same sentence: one metadata read of the closed table, on one line. Plus one refusal of the
 * agent's own, 4,096 characters, for the reason the kubectl and MongoDB contracts have one: a model has no reason to
 * send a longer read, and a shorter contract is one it can be told.
 *
 * Not the boundary. The boundary is the provider's closed table and the READ-only etcd user the server proves before
 * every agent command; this is what lets the model read why it was refused, before anything is sent.
 */
import { z } from "zod";
import { type EtcdAgentRefusalCode, readEtcdAgentStatement } from "@/lib/db/providers/keyvalue/etcd/agent-statement";

export const ETCDCTL_AGENT_MAX_STATEMENT_CHARS = 4096;

export type EtcdctlAdmissionCode = EtcdAgentRefusalCode | "agent-too-large";

export interface EtcdctlAdmissionRefusal {
  readonly code: EtcdctlAdmissionCode;
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The command is longer than ${ETCDCTL_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`;

/** The refusal an agent's etcdctl command meets before anything is sent, or null when it is admitted. */
export function admitEtcdctlStatement(text: string): EtcdctlAdmissionRefusal | null {
  if (text.length > ETCDCTL_AGENT_MAX_STATEMENT_CHARS) {
    return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  }
  const reading = readEtcdAgentStatement(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `etcdctl.query.read` validates: one command, admitted. Strict, so a stray `sql` key is refused. */
export const etcdctlAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(ETCDCTL_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitEtcdctlStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
