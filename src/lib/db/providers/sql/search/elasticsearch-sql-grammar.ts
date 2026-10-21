import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * The two search engines and Trino are the rows here established by LIVE PROBE rather
 * than from documentation or a bundled driver: their SQL surfaces are HTTP endpoints
 * on a running cluster, so the grammar can be asked directly, and asking it beats
 * every other source. The search probes ran 2026-08-19 against Elasticsearch 9.1.4 and
 * OpenSearch 3.8.0, and they DISAGREE about two of the four facts - which is the
 * reason the one provider implementation still has two rows here. The Trino probes ran
 * 2026-08-20 against 476; that row sits below, after OpenSearch's.
 */
const ELASTICSEARCH_GRAMMAR: SqlGrammar = {
  // `#` opens NOTHING: `SELECT 1 # x` is a `parsing_exception`, "mismatched input
  // '#'", and so is `SELECT # x\n1`. So the rest of the line is not hidden, which is
  // the only thing the readers in this folder ask about. Reading it as a comment (the
  // compatibility default) would also leave every `#` run AMBIGUOUS
  // (`hashRunIsAmbiguous`), and since #297 an unreadable span is a confirmation
  // PROMPT rather than silence - a prompt on a statement this engine simply refuses.
  hash: "code",
  // NOT established, and left at the default deliberately. `[` has no meaning at all
  // in this grammar - `SELECT [1, 2]` and `SELECT [customer] FROM probe_orders` are
  // both "extraneous input '['" - so it is neither an identifier quote nor a
  // subscript, and this module's rule 2 forbids reading one dialect's rule off
  // another's behaviour (see the header, and the undecided table in
  // `docs/editor/query-optimization.md`). The name
  // reading can only cost a bound on a statement the engine refuses anyway, which is
  // the same fail-safe argument the `mysql` and `oracle` rows make.
  bracket: DEFAULT_SQL_GRAMMAR.bracket,
  // FLAT: `SELECT /* a /* b */ 1 AS a` answers 200 with the column, so the first
  // `*/` closed the run. A nesting reader would have seen an unterminated comment.
  blockComment: "flat",
  // `SELECT q'{it's}'` is a `parsing_exception` - the form does not exist here.
  alternateQuoting: false,
  // NOT established: this engine was not reachable from the run that probed the other
  // eight (2026-08-25), and this module's rule 2 forbids reading its rule off the
  // five refusals measured elsewhere. It keeps the compatibility default, and the direction that
  // costs is worth stating: if `//` DOES open a comment here, this dialect's splitter
  // over-splits exactly as `cassandra`'s did.
  doubleSlashComment: DEFAULT_SQL_GRAMMAR.doubleSlashComment,
  backslashAlwaysEscapes: false,
  script: DEFAULT_SQL_GRAMMAR.script,
  trailingLimitClauses: DEFAULT_SQL_GRAMMAR.trailingLimitClauses,
};

/** How Elasticsearch statement text is read: grammar, SQL text, redaction, update target and completion. */
export const ELASTICSEARCH_SQL_GRAMMAR: SqlGrammarSpec = {
  // Established by probing the engine itself (its SQL surface is an HTTP endpoint, so the grammar can be asked
  // rather than read about); it disagrees with OpenSearch about `#` and about `[…]`. It carries no established
  // BRACKET reading - `[` is not in its grammar at all - and no `//` reading, because the engine was not reachable
  // from the run that probed the other eight.
  grammar: ELASTICSEARCH_GRAMMAR,
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
