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
 * A version prefix stays in front: the gate sends `CYPHER 5 EXPLAIN <rest>`, the order the captures use.
 * A failed EXPLAIN is thrown to the caller, which refuses the statement without running it.
 */
import type { GraphQueryType } from "@/lib/db/graph/bolt/client";
import type { GraphStatementGate } from "@/lib/db/graph/graph-base-provider";

const CLASSIFICATIONS: Readonly<Record<Exclude<GraphQueryType, "r">, string>> = {
  rw: "read and write",
  w: "write",
  s: "a schema or administration statement",
};

export const neo4jStatementGate: GraphStatementGate = async (client, verdict, options) => {
  const { statement } = verdict;
  let explained = `EXPLAIN ${statement.text}`;
  if (statement.cypherVersion !== undefined) {
    // The tokens after `CYPHER <n>`, sliced from the statement's own text so nothing is re-spelled. A
    // prefix with nothing after it is sent as it stands, and the server refuses the empty plan.
    const restStart = statement.tokens[2]?.start;
    const rest = restStart === undefined ? "" : statement.text.slice(restStart - statement.tokens[0].start);
    explained = `CYPHER ${statement.cypherVersion} EXPLAIN ${rest}`.trimEnd();
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
