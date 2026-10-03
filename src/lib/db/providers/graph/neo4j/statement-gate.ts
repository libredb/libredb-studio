/**
 * The Neo4j statement gate (Neo4j provider spec 5.4; revision SR10).
 *
 * After the read policy allowed a statement, the server classifies it: `EXPLAIN` plans the statement
 * without running it and answers `summary.queryType`. Only `r` runs, and `s` runs only when the statement
 * calls an allowlisted procedure (`dbms.components` is `s` on 5.26.31), because the policy has already
 * refused every other procedure; `GraphBaseProvider` skips the gate for an allowed SHOW form, whose
 * database forms are `s` too. Any other type, and a plan with no type, refuses: the gate fails closed.
 *
 * `r` is not "no side effect": the server classifies `LOAD CSV` and `TERMINATE TRANSACTIONS` as `r`
 * (captured), so the policy's denied words are what stop them, and the gate is the second check, not the
 * only one.
 *
 * A `CYPHER` prefix stays in front with all its options: the gate sends `CYPHER 5 EXPLAIN <rest>`, the order
 * the captures use, and `CYPHER [5] runtime=slotted EXPLAIN <rest>` when options follow, since 5.26.31 rejects
 * `CYPHER 5 EXPLAIN runtime=slotted ...` (measured 2026-10-03). A failed EXPLAIN is thrown to the caller, which refuses the statement without running it.
 */
import type { GraphQueryType } from "@/lib/db/graph/bolt/client";
import type { CypherToken } from "@/lib/db/graph/cypher/lexer";
import type { GraphStatementGate } from "@/lib/db/graph/graph-base-provider";

const CLASSIFICATIONS: Readonly<Record<Exclude<GraphQueryType, "r">, string>> = {
  rw: "read and write",
  w: "write",
  s: "a schema or administration statement",
};

/** The index of the first token after a leading `CYPHER [n] [option=value ...]` block; 0 when there is none. */
function afterCypherPrefix(tokens: readonly CypherToken[]): number {
  if (!(tokens[0]?.kind === "word" && tokens[0].value === "CYPHER")) return 0;
  let at = tokens[1]?.kind === "number" ? 2 : 1;
  const isValue = (token: CypherToken | undefined) =>
    token?.kind === "word" || token?.kind === "number" || token?.kind === "string";
  while (tokens[at]?.kind === "word" && tokens[at + 1]?.text === "=" && isValue(tokens[at + 2])) at += 3;
  return at;
}

export const neo4jStatementGate: GraphStatementGate = async (client, verdict, options) => {
  const { statement } = verdict;
  const { tokens, text } = statement;
  let explained = `EXPLAIN ${text}`;
  const at = afterCypherPrefix(tokens);
  if (at > 0) {
    // The prefix and the rest, sliced from the statement's own text so nothing is re-spelled. A prefix with
    // nothing after it is sent as it stands, and the server refuses the empty plan.
    const base = tokens[0].start;
    const prefixOptions = at > 1 ? ` ${text.slice(tokens[1].start - base, tokens[at - 1].end - base)}` : "";
    const rest = at < tokens.length ? text.slice(tokens[at].start - base) : "";
    explained = `CYPHER${prefixOptions} EXPLAIN ${rest}`.trimEnd();
  }
  const { queryType } = await client.run(explained, { ...options, maxRows: 0 });
  if (queryType === undefined) {
    return {
      code: "server-classification",
      subject: "unclassified",
      message: "The server did not classify this statement, so it was not run.",
    };
  }
  if (queryType === "r" || (queryType === "s" && verdict.callsProcedure)) return undefined;
  return {
    code: "server-classification",
    subject: queryType,
    message: `The server classifies this statement as ${CLASSIFICATIONS[queryType]}, and a read-only Neo4j connection runs only reads.`,
  };
};
