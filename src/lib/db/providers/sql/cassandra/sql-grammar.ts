import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * Established the same way as the three rows above and for the same reason - the
 * server IS the source - and probed BEFORE any Cassandra provider code existed
 * (2026-08-20, Apache Cassandra 5.0.9, `system.local.release_version`, over the
 * native protocol). Every fact below is a statement the server answered, not a
 * reading taken from a neighbouring dialect.
 *
 * CQL needs TWO facts about comments that the rows above do not, and they are
 * carried in two different places because only one of them is about WHAT a run is.
 * The first is shared with exactly one other dialect here, ClickHouse; the second is
 * this engine's alone.
 *
 * 1. A THIRD comment form, `//`, which ClickHouse has too. That IS a grammar fact,
 *    it is now the
 *    `doubleSlashComment` field, and this docblock used to say the record could not
 *    express it - which cost the splitter a manufactured `DROP` (see the field's own
 *    doc and the row below). It is not widened to the dialects that lack it: five of
 *    them refuse the characters outright and PostgreSQL reads them as an operator
 *    name, each measured.
 * 2. A line comment of EITHER form must be closed by a NEWLINE. That is a fact about
 *    where a statement may END rather than about what a run is, so it has no field
 *    here: `SqlSpan` reports a line comment closed by end of input as terminated,
 *    which is right in every other dialect and is what the readers over it are
 *    asking. Measured, `SELECT * FROM probe.customers LIMIT 3 -- note` with nothing
 *    after it is "line 1:45 mismatched character '<EOF>' expecting set null" and the
 *    same text with a trailing `\n` returns the rows - so the shared limiter's
 *    insert-before-trailing-trivia rewrite (#280) can turn a VALID statement into a
 *    syntax error, because `sql.trim()` drops the newline that closed the comment.
 *    The Cassandra provider's own `prepareQuery` still declines to rewrite a
 *    statement that would end inside a line comment; what changed is that it now
 *    finds BOTH comment forms through the shared span reader rather than carrying a
 *    private `//` scan of its own. See `providers/sql/cassandra/index.ts`.
 */
const CASSANDRA_GRAMMAR: SqlGrammar = {
  // `#` opens NOTHING and is not an identifier character either. Three probes:
  // `… WHERE id = 1 # trailing` -> "line 1:44 no viable alternative at character
  // '#'"; `SELECT # x\n id …` -> the same at 1:7; `SELECT id#a …` -> the same at 1:9.
  // So the rest of the line is not hidden, which is the only thing the readers here
  // ask. The compatibility default would leave every `#` run AMBIGUOUS, and since
  // #297 an unreadable span is a confirmation PROMPT rather than silence - a prompt on
  // a statement CQL refuses outright.
  hash: "code",
  // A SUBSCRIPT, and both halves of that reading were measured. It is read THROUGH to
  // a term: `SELECT [id] FROM probe.customers WHERE id = 1` answers a column named
  // `[id]` of type `list` holding `[1]` - the brackets built a collection literal from
  // the column - and `SELECT [1, 2] …` is refused with "Cannot infer type for term
  // [1, 2] in selection clause", a complaint about TYPING a term the parser already
  // read. It NESTS: `SELECT [[id]] …` answers `[[1]]`. A literal inside it is a
  // literal: `SELECT ['a]b'] …` reaches the same type-inference complaint, so the `]`
  // inside the string did not close the run - which is precisely what the
  // identifier reading, stopping at the first `]`, cannot do. CQL subscripts
  // collections for real as well (`m['k']`), and names are quoted with `"` (measured:
  // `SELECT "id" FROM probe.customers` returns the column, a backtick is "no viable
  // alternative at character '`'", and a double-quoted STRING is a syntax error).
  bracket: "subscript",
  // FLAT: `SELECT /* a /* b */ id FROM probe.customers WHERE id = 1` returns the row,
  // so the first `*/` closed the run. A nesting reader would have seen an
  // unterminated comment and refused to bound the statement.
  blockComment: "flat",
  // `… WHERE name = q'{it''s}'` is "line 1:45 no viable alternative at input
  // '{it's}'" - the form does not exist here, so those characters are a name followed
  // by an ordinary string.
  alternateQuoting: false,
  // A LINE comment, which is what the docblock above used to say this record could not
  // carry. Probed 2026-08-25 over the native protocol on 5.0.9 AND on ScyllaDB
  // 2026.2.4, which shares this type-id and answered identically:
  //   `SELECT release_version FROM system.local // note; DROP KEYSPACE nope\n`
  //     -> the ROW. One read. And the DROP did not run: a bare `DROP KEYSPACE nope`
  //        answers "Keyspace 'nope' doesn't exist", so the OK is the proof.
  //   the same text with no trailing newline
  //     -> "line 1:68 mismatched character '<EOF>' expecting set null" (Scylla: "line
  //        1:68 : Unexpected ''") - the SECOND CQL fact, stated in the docblock above.
  //   `SELECT release_version FROM system.local // note\nDROP KEYSPACE nope`
  //     -> "line 2:0 mismatched input 'DROP' expecting EOF", so the run ended at the
  //        newline: a LINE comment, not a to-end-of-input one.
  doubleSlashComment: true,
  backslashAlwaysEscapes: false,
  script: DEFAULT_SQL_GRAMMAR.script,
  // Clauses that must follow the row bound (#1398), measured on ScyllaDB 2026.3.2
  // (E2E pass of 2026-10-03/04), which shares this type-id:
  //   `SELECT * FROM t BYPASS CACHE` -> rows; with the bound appended after it,
  //     `line 1:38 : Syntax error`.
  //   `SELECT * FROM t USING TIMEOUT 5s` -> rows; appended, `line 1:42`.
  //   `SELECT * FROM t LIMIT 10 BYPASS CACHE` -> rows: the bound keeps its place
  //     before the clause.
  // `ALLOW FILTERING` is the one this row already knew (`… LIMIT 3 ALLOW FILTERING`
  // returns rows, `… ALLOW FILTERING LIMIT 3` is "mismatched input 'LIMIT'"), which
  // the Cassandra provider used to transpose after the fact; all three now come from
  // this one declaration. `USING TIMEOUT` and `BYPASS CACHE` are ScyllaDB's, not
  // Apache Cassandra 5.0's (measured there: `USING TIMEOUT 1ms` is `mismatched input
  // 'USING' expecting EOF`), and the cost of declaring them on this shared row is
  // none: a 5.0 statement ending in either is refused bound or unbound. The duration
  // token excludes brackets, so a `)` after it ends the match: a `USING TIMEOUT` run
  // followed by a closing parenthesis - a subquery's tail on a dialect that has one,
  // or text the engine will refuse - is never read as the statement's own clause.
  trailingLimitClauses: [/\s+ALLOW\s+FILTERING\s*$/i, /\s+BYPASS\s+CACHE\s*$/i, /\s+USING\s+TIMEOUT\s+[^()\s]+\s*$/i],
};

/** How Cassandra statement text is read: grammar, SQL text, redaction, update target and completion. */
export const CASSANDRA_SQL_GRAMMAR: SqlGrammarSpec = {
  // `//` reads as a LINE comment (Apache Cassandra 5.0.9 and ScyllaDB 2026.2.4, both over the native protocol),
  // established by two probes rather than one: the hiding was shown by a `;` plus a write that did NOT execute,
  // and the LINE half by a clause on the next line that DID.
  grammar: CASSANDRA_GRAMMAR,
  // True, and it is the closest call of all the engines. CQL
  // genuinely lacks JOIN, OFFSET, EXPLAIN and subqueries - each measured as a syntax
  // error on 5.0.9 - but this fact is not about vocabulary: it asks whether the text is
  // SQL-SHAPED, so that a SQL span reader can find where a literal ends and where a
  // comment hides a write. CQL is written with the same statement keywords, the same
  // `'…'` literals with doubled quotes, the same `"…"` quoted names and the same `--`
  // and `/* *\/` comments, so that reading is correct here. Reading it as not SQL would switch the
  // SQL checks off for text that IS SQL - the mirror of the defect this fact exists to
  // fix.
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: null },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
