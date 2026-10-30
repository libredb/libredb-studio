/**
 * What one Neo4j agent statement may be, read before anything is sent.
 *
 * The editor's read policy (`checkCypherRead` over `NEO4J_POLICY_PROFILE`), then two refusals of the agent's own:
 *
 * - no carriage return: 5.26.31 ends a `//` comment at a lone carriage return as well as at a line feed (captured in
 *   `tests/fixtures/neo4j/5.26.31/agent-boundary/agent/fence-line-comment-lone-cr.json`), so a reader that runs the
 *   comment on to the line feed would read less than the server runs. The graph lexer already ends the comment there;
 *   refusing the character keeps the agent's text out of that question altogether;
 * - no comment, anywhere: a statement with no comment cannot hide a clause from one reader that another reads, and a
 *   model has no reason to send one. The captures show `//` running on past U+2028 and U+0085 and a block comment
 *   closing at its first star-slash, nested or not; with comments refused, neither reading reaches the server.
 *
 * Not the boundary. The boundary is the principal, proved before every agent statement (`agent-boundary.ts`); this is
 * what lets the model read why it was refused before anything is sent.
 */
import { lexCypher } from "@/lib/db/graph/cypher/lexer";
import { type CypherReadVerdict, type CypherRefusalCode, checkCypherRead } from "@/lib/db/graph/cypher/read-policy";
import { NEO4J_POLICY_PROFILE } from "./profile";

export type Neo4jAgentRefusalCode = "agent-carriage-return" | "agent-comment" | CypherRefusalCode;

export type Neo4jAgentReading =
  | { readonly ok: true; readonly verdict: Extract<CypherReadVerdict, { allowed: true }> }
  | { readonly ok: false; readonly code: Neo4jAgentRefusalCode; readonly message: string };

const NOTHING_SENT = "Nothing was sent.";

/** One agent statement, read; a refusal carries the sentence the model reads. */
export function readNeo4jAgentStatement(text: string): Neo4jAgentReading {
  if (text.includes("\r")) {
    return {
      ok: false,
      code: "agent-carriage-return",
      message: `An agent statement has no carriage return: Neo4j ends a // comment at one, so the text could read as another statement than the one written. Write it on one line or with line feeds. ${NOTHING_SENT}`,
    };
  }
  const verdict = checkCypherRead(text, NEO4J_POLICY_PROFILE);
  if (!verdict.allowed) {
    return { ok: false, code: verdict.refusal.code, message: `${verdict.refusal.message} ${NOTHING_SENT}` };
  }
  // The policy has lexed the text whole, so this lex cannot fail.
  if (lexCypher(text).some((token) => token.kind === "comment")) {
    return {
      ok: false,
      code: "agent-comment",
      message: `An agent statement has no comment: remove it and send the statement alone. ${NOTHING_SENT}`,
    };
  }
  return { ok: true, verdict };
}
