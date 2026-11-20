import { getExplainStrategy, type ExplainMode } from "@/lib/explain";
import type { ExplainFormat, ProviderCapabilities } from "@/lib/db/types";
import type { DatabaseType } from "@/lib/types";
import { countCodeStatements } from "@/lib/sql/statement-splitter";
import { hasLoneCarriageReturnInLineComment, hasUnterminatedSpan } from "@/lib/sql/spans";
import { readsSqlText, resolveSqlGrammar } from "@/lib/sql/grammar";

/*
 * THE EXPLAIN ASK, READ ONE WAY BY BOTH ROUTES THAT RUN IT.
 *
 * `POST /api/db/query` plans a statement on a pooled session; `POST /api/db/transaction` plans it on the session an
 * open transaction holds (D16: the Explain button with BEGIN on ran outside the transaction, so a table the
 * transaction created was "relation does not exist" to it). Both read the ask, refuse a text of more than one
 * statement and build the EXPLAIN from the connected provider's strategy here, so the transaction route cannot explain
 * a statement the query route refuses.
 */

/**
 * The error an unreadable `explain` field gets. It names the whole allowed shape
 * rather than what was sent, the way `BOUND_PARAMS_MESSAGE` does.
 */
const EXPLAIN_REQUEST_MESSAGE = 'explain must be { "mode": "estimate" } or { "mode": "analyze" }';

export type ExplainRequestResult =
  | { valid: true; explain: { mode: ExplainMode } | undefined }
  | { valid: false; message: string };

/**
 * Read a request's `explain` field: the ASK for a plan, not a statement (#574).
 *
 * The EXPLAIN statement is built on the server because the accepted form is not
 * always knowable before connecting. Measured 2026-09-06 over the MySQL wire
 * protocol (mysql2 3.24.2, text protocol): `EXPLAIN FORMAT=JSON SELECT 1` is
 * refused by TiDB v8.5.1 (errno 1105, "explain format 'json' is not supported
 * now"), Apache Doris 4.1.3 (errno 1105, "mismatched input '='"), StarRocks
 * 3.3.22 and SingleStore (both errno 1064), while a plain `EXPLAIN SELECT 1` is
 * accepted on every one of them. `POST /api/db/provider-meta` never connects
 * (#457), so the client cannot be told which form to build; it asks for a mode
 * and the connected provider's capabilities decide the rest.
 */
export function readExplainRequest(value: unknown): ExplainRequestResult {
  if (value === undefined) return { valid: true, explain: undefined };
  if (typeof value !== "object" || value === null) return { valid: false, message: EXPLAIN_REQUEST_MESSAGE };

  const mode = (value as { mode?: unknown }).mode;
  if (mode !== "estimate" && mode !== "analyze") return { valid: false, message: EXPLAIN_REQUEST_MESSAGE };

  return { valid: true, explain: { mode } };
}

/** What a text of more than one statement is answered when a plan of it is asked for. */
export const ONE_STATEMENT_EXPLAIN_MESSAGE = "Only a single statement can be explained";

/**
 * AN EXPLAIN PREFIXES ONE STATEMENT (#1311). Handed `SELECT 1 AS a; INSERT ...` it
 * explained the SELECT and the simple-query protocol then RAN the INSERT as a
 * statement of its own: measured on Materialize 26.44.1, AlloyDB Omni 17.9 and
 * Cloudberry 2.1.0, one RUN of that text applied the INSERT twice, once in the run
 * and once in its background plan request. A plan of several statements is not a
 * plan of anything, so the text is refused before a provider is opened. It is read
 * under the connection's own grammar, the one the editor splits a run with, so a
 * `;` inside a quote or a comment is not a second statement, and neither is a note
 * after the final `;` (a fragment of comments only is not counted). A text with a
 * run the grammar cannot close is refused too: the splitter finds no boundary in
 * it, yet `SELECT E'\''; INSERT ...` is two statements to PostgreSQL. So is a text whose
 * line comment holds a lone carriage return, which ends the comment on PostgreSQL and
 * not on CockroachDB, so the code after it is a second statement to one. Only SQL text
 * is counted: an engine whose text is not SQL enforces one statement in its own
 * parser (Firestore's provider refuses a second statement), and the SQL counter
 * would read a `;` in its comment as a boundary.
 */
export function explainsSeveralStatements(sql: string, type: DatabaseType): boolean {
  if (!readsSqlText(type)) return false;
  const grammar = resolveSqlGrammar(type);
  return (
    countCodeStatements(sql, grammar) > 1 ||
    hasUnterminatedSpan(sql, grammar) ||
    hasLoneCarriageReturnInLineComment(sql, grammar)
  );
}

export type BuiltExplain = { built: true; statement: string; format: ExplainFormat } | { built: false; error: string };

/**
 * The statement that runs for an explain ask: the one the CONNECTED provider's strategy builds, never the caller's own
 * SQL, since falling back to that would execute e.g. an UPDATE the user only asked to see (#201). The format is named
 * in the answer so the client stores the plan under the format that really produced it, rather than under the static
 * one provider-meta gave it.
 */
export function buildExplainStatement(
  capabilities: ProviderCapabilities,
  sql: string,
  mode: ExplainMode,
): BuiltExplain {
  // `getExplainStrategy` indexes a Record, so a format outside this build's union
  // (an external implementer of the published interface can declare anything)
  // comes back undefined rather than null; a strict null check let that reach
  // `strategy.buildSql` and surface as a TypeError 500 instead of this 400.
  const strategy = capabilities.supportsExplain ? getExplainStrategy(capabilities.explainFormat) : null;
  if (!strategy) return { built: false, error: "This server does not support EXPLAIN" };
  const statement = strategy.buildSql(sql, mode);
  if (statement === null) return { built: false, error: "Only SELECT statements can be explained" };
  return { built: true, statement, format: strategy.format };
}
