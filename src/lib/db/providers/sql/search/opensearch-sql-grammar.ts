import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

const OPENSEARCH_GRAMMAR: SqlGrammar = {
  // `#` really is a line comment, and this is where the fork's SQL plugin parts
  // company with Elasticsearch's. Three probes, because "the statement still ran" is
  // not enough to tell a comment from a token the parser ignored:
  //   `SELECT 1 AS a # , 2 AS b`         -> 200, ONE column: the rest was hidden.
  //   `SELECT 1 AS a # hidden\n, 2 AS b` -> 200, TWO columns: the run ended at the
  //                                         newline, so it is a LINE comment.
  //   `SELECT customer # FROM probe_orders` -> `SemanticCheckException`, "can't
  //                                         resolve … customer": the FROM was hidden.
  hash: "comment",
  // `[…]` is an identifier quote, MySQL/SQL-Server style: `SELECT [customer] FROM
  // probe_orders` answers the field's value, while `SELECT [1, 2]` is refused with
  // "All items between Brackets should be identifiers, got:LITERAL_INT". It has no
  // escape and does not nest - `[customer]]` and `[a[b]]` are both refused - which is
  // the SQLITE_GRAMMAR situation exactly: this reading's doubled-`]` allowance can
  // only swallow a closer in text the server rejects either way.
  bracket: "quoted-identifier",
  // FLAT, same probe and same answer as Elasticsearch.
  blockComment: "flat",
  // `SELECT q'{it's}'` is refused, "Illegal SQL expression".
  alternateQuoting: false,
  // NOT established, same reason and same stated cost as the Elasticsearch row above.
  doubleSlashComment: DEFAULT_SQL_GRAMMAR.doubleSlashComment,
  backslashAlwaysEscapes: false,
  script: DEFAULT_SQL_GRAMMAR.script,
  trailingLimitClauses: DEFAULT_SQL_GRAMMAR.trailingLimitClauses,
};

/** How OpenSearch statement text is read: grammar, SQL text, redaction, update target and completion. */
export const OPENSEARCH_SQL_GRAMMAR: SqlGrammarSpec = {
  // Established by probing the engine itself (its SQL surface is an HTTP endpoint, so the grammar can be asked
  // rather than read about); it disagrees with Elasticsearch about `#` and about `[…]`. It carries no `//`
  // reading, because the engine was not reachable from the run that probed the other eight.
  grammar: OPENSEARCH_GRAMMAR,
  // True, and deliberately so: the editor text is SQL
  // (measured - both search engines answer `POST`ed statements with columns and rows, and both
  // providers extend `SQLBaseProvider` and call `prepareQuery`). Reading it as not SQL
  // would switch the SQL checks off for text that IS SQL, which is the mirror of the
  // defect this fact exists to fix: the confirmation gate would stop reading a statement
  // it can read, and an unreadable statement's spans are what tell it a write is
  // hiding behind a comment. The other direction is the one #297 measured - reading
  // non-SQL as SQL prompted on ordinary reads - so a wrong answer here costs either a
  // gate that never asks or a gate an operator learns to click through.
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: null },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
