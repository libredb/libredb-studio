/**
 * The agent's admission of one MongoDB command, next to the descriptor that reads it (`mongo.query.read`).
 *
 * It is the command reader (`readMongoCommand` in `providers/document/mongodb/envelope.ts`), so the agent's tool path
 * and the provider, which reads the same text with the same reader, refuse the same commands with the same sentence,
 * plus one refusal of the agent's own: 4,096 characters, a deliberately narrow contract for the reason the kubectl
 * fence's is, because a model has no reason to send a longer read and a shorter contract is one it can be told. It
 * binds the text a model writes; a statement Studio composes is read by the same reader under its own contract.
 *
 * Not the boundary. The boundary is the connection's user, whose privileges the provider reads and whose server must
 * refuse a write at open (`agent-boundary.ts`); this is what lets the model read the reason it was refused, before
 * anything is sent.
 */
import { z } from "zod";
import { type MongoCommandRefusalCode, readMongoCommand } from "@/lib/db/providers/document/mongodb/envelope";

export const MONGO_AGENT_MAX_STATEMENT_CHARS = 4096;

export type MongoAdmissionCode = MongoCommandRefusalCode | "agent-too-large";

export interface MongoAdmissionRefusal {
  readonly code: MongoAdmissionCode;
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The statement is longer than ${MONGO_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: narrow the filter or the pipeline. Nothing was sent.`;

/**
 * The refusal an agent's MongoDB statement meets before anything is sent, or null when it is admitted.
 *
 * Every message names what to change, because a refusal that carries nothing is a loop the ledger has already
 * recorded (`tools.ts`): the sentence is the half a model can act on.
 */
export function admitMongoStatement(text: string): MongoAdmissionRefusal | null {
  if (text.length > MONGO_AGENT_MAX_STATEMENT_CHARS) return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  const reading = readMongoCommand(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `mongo.query.read` validates: one command, admitted. Strict, so a stray `sql` key is refused. */
export const mongoAgentReadInput = z
  .strictObject({ command: z.string().min(1).max(MONGO_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitMongoStatement(value.command);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["command"], message: refusal.message });
  });
