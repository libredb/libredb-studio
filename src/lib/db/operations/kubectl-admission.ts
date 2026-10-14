/**
 * The agent's admission of one kubectl line, next to the descriptor that reads it (`kubectl.query.read`).
 *
 * It is the console's own reader (`readKubectlRun`), so the agent and the editor refuse the same lines with the same
 * sentence, plus two refusals of the agent's own. 4,096 characters is a deliberately narrower contract than the
 * console's 65,536 bytes: a model has no reason to send a longer read, and a shorter contract is one it can be told.
 * The paging clause is refused because a paged read lets a model walk past the row cap one page at a time; the
 * model narrows instead.
 *
 * Not the boundary. The boundary is the request allowlist on the final method and path, and RBAC; this is what lets
 * the model read the reason it was refused.
 */
import { z } from "zod";
import {
  AGENT_PAGING_SENTENCE,
  type KubectlRunRefusalCode,
  readKubectlRun,
} from "@/lib/db/providers/platform/kubernetes/console/paging";

export const KUBECTL_AGENT_MAX_STATEMENT_CHARS = 4096;

export type KubectlAdmissionCode = KubectlRunRefusalCode | "agent-too-large" | "agent-paging";

export interface KubectlAdmissionRefusal {
  readonly code: KubectlAdmissionCode;
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The statement is longer than ${KUBECTL_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: narrow it. Nothing was sent.`;

/** The refusal an agent's kubectl line meets before anything is sent, or null when the line is admitted. */
export function admitKubectlStatement(text: string): KubectlAdmissionRefusal | null {
  if (text.length > KUBECTL_AGENT_MAX_STATEMENT_CHARS) return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  const run = readKubectlRun(text);
  // A paging line under a statement that cannot page is the console's refusal, and its sentence points at the list
  // form of a get, which invites the model to rewrite the read as one. No agent read is paged, so it reads the
  // agent's sentence whatever the statement above the line.
  if (!run.ok && run.code === "paging-clause") return { code: "agent-paging", message: AGENT_PAGING_SENTENCE };
  if (!run.ok) return { code: run.code, message: run.message };
  if (run.page !== undefined) return { code: "agent-paging", message: AGENT_PAGING_SENTENCE };
  return null;
}

/** The input `kubectl.query.read` validates: one statement, admitted. Strict, so a stray `sql` key is refused. */
export const kubectlAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(KUBECTL_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitKubectlStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
