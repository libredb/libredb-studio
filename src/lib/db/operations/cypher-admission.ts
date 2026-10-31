/**
 * The agent's admission of one Cypher statement, next to the descriptor that reads it (`cypher.query.read`).
 *
 * It is the provider's own reader (`readNeo4jAgentStatement` in `providers/graph/neo4j/agent-statement.ts`), so the
 * agent's tool path and the provider, which reads the same text with the same reader before it sends anything, refuse
 * the same statements with the same sentence: the editor's read policy, then no carriage return and no comment. Plus
 * one refusal of the agent's own, 4,096 characters, for the reason the kubectl and MongoDB contracts have one: a model
 * has no reason to send a longer read, and a shorter contract is one it can be told.
 *
 * Not the boundary. The boundary is the user, proved read-only before every agent statement; this is what lets the
 * model read why it was refused, before anything is sent.
 */
import { z } from "zod";
import { type Neo4jAgentRefusalCode, readNeo4jAgentStatement } from "@/lib/db/providers/graph/neo4j/agent-statement";

export const CYPHER_AGENT_MAX_STATEMENT_CHARS = 4096;

export type CypherAdmissionCode = Neo4jAgentRefusalCode | "agent-too-large";

export interface CypherAdmissionRefusal {
  readonly code: CypherAdmissionCode;
  readonly message: string;
}

const TOO_LARGE_SENTENCE = `The statement is longer than ${CYPHER_AGENT_MAX_STATEMENT_CHARS} characters, the most an agent read takes: shorten it. Nothing was sent.`;

/** The refusal an agent's Cypher statement meets before anything is sent, or null when it is admitted. */
export function admitCypherStatement(text: string): CypherAdmissionRefusal | null {
  if (text.length > CYPHER_AGENT_MAX_STATEMENT_CHARS) return { code: "agent-too-large", message: TOO_LARGE_SENTENCE };
  const reading = readNeo4jAgentStatement(text);
  return reading.ok ? null : { code: reading.code, message: reading.message };
}

/** The input `cypher.query.read` validates: one statement, admitted. Strict, so a stray `sql` key is refused. */
export const cypherAgentReadInput = z
  .strictObject({ statement: z.string().min(1).max(CYPHER_AGENT_MAX_STATEMENT_CHARS) })
  .superRefine((value, context) => {
    const refusal = admitCypherStatement(value.statement);
    if (refusal !== null) context.addIssue({ code: "custom", path: ["statement"], message: refusal.message });
  });
