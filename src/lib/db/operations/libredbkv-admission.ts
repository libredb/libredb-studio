/**
 * The agent's admission of one LibreDB read command, next to the descriptor that reads it (`libredbkv.query.read`).
 *
 * It is the provider's own reader (`readLibreDBReadCommand` in `providers/embedded/libredb-command.ts`), so the agent's
 * tool path and the provider, which reads the same text with the same reader before it opens anything, refuse the
 * same commands with the same sentence: one `get`, `prefix` or `range` on one line, with `put` and `delete` refused by
 * name. Plus one refusal of the agent's own, 4,096 characters, for the reason the kubectl and MongoDB contracts have
 * one: a model has no reason to send a longer read, and a shorter contract is one it can be told.
 *
 * Not the boundary. The boundary is the handle: each agent statement opens the file through the read-only file adapter,
 * which cannot write; this is what lets the model read why it was refused, before anything is opened.
 */
import { z } from "zod";
import { type LibreDBReadRefusalCode, readLibreDBReadCommand } from "@/lib/db/providers/embedded/libredb-command";

export const LIBREDBKV_AGENT_MAX_STATEMENT_CHARS = 4096;

export type LibredbkvAdmissionCode = LibreDBReadRefusalCode | "agent-too-large";

export interface LibredbkvAdmissionRefusal {
  readonly code: LibredbkvAdmissionCode;
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The statement is longer than ${LIBREDBKV_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten the key or the prefix. Nothing was sent.`;

/** The refusal an agent's LibreDB command meets before anything is opened, or null when it is admitted. */
export function admitLibredbkvStatement(text: string): LibredbkvAdmissionRefusal | null {
  if (text.length > LIBREDBKV_AGENT_MAX_STATEMENT_CHARS) {
    return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  }
  const reading = readLibreDBReadCommand(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `libredbkv.query.read` validates: one command, admitted. Strict, so a stray `sql` key is refused. */
export const libredbkvAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(LIBREDBKV_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitLibredbkvStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
