/**
 * What the server does for a Cypher read: the repair ledger's identity of one read, the row-cap advice in the
 * statement's own words, and the admission pre-check. It reaches `node:crypto`, so it is server only.
 */
import { createHash } from "node:crypto";
import { admitCypherStatement } from "@/lib/db/operations/cypher-admission";
import { CYPHER_KEYWORDS, type CypherToken } from "@/lib/db/graph/cypher/lexer";
import { readNeo4jAgentStatement } from "@/lib/db/providers/graph/neo4j/agent-statement";
import type { AgentLanguageServerAdapter } from "../pack";
import { canonicalText } from "../shared";

/** A token as the identity reads it: a keyword folded, every other word as written, anything else by its value. */
function identityOf(token: CypherToken): readonly [string, string] {
  if (token.kind !== "word") return [token.kind, token.value];
  return [token.kind, CYPHER_KEYWORDS.has(token.value) ? token.value : token.text];
}

/**
 * A Cypher read's identity in the repair ledger: its significant tokens, whitespace dropped and keywords folded, so
 * `MATCH (n) RETURN n` and `match (n)  return n` are one read, and `RETURN 1` and `RETURN 2` are two, as are
 * `(n:Person)` and `(n:person)`, since a label is case-sensitive. Total: a statement
 * the agent's reader refuses is identified by its raw text, so a refused statement is still refused the second time.
 *
 * Exported for its tests; the adapter below is its production reader.
 */
export function fingerprintCypher(text: string): string {
  const reading = readNeo4jAgentStatement(text);
  const canonical = reading.ok
    ? `cypher:${JSON.stringify(reading.verdict.statement.tokens.map(identityOf))}`
    : `cypher-raw:${text}`;
  return createHash("sha256").update(canonical).digest("hex");
}

/** The sentence for a Cypher read refused past the row budget. Exported for its tests, like the fingerprint. */
export function cypherRowCapAdvice(_statement: string, allowed: string): string {
  return `Ask for at most ${allowed} rows: narrow the MATCH with a WHERE, aggregate with count() or collect(), or bound it with LIMIT, and run it again.`;
}

export const CYPHER_ADAPTER: AgentLanguageServerAdapter = Object.freeze({
  readOperation: "cypher.query.read",
  canonicalize: canonicalText,
  fingerprint: fingerprintCypher,
  rowCapAdvice: cypherRowCapAdvice,
  admit: admitCypherStatement,
  shapeAdvice:
    "The statement's shape falls outside what a bounded read-only read may be, which is a decision about the contract rather than about a valid Cypher statement; a differently shaped read may still be admitted.",
});
