import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

const CLICKHOUSE_GRAMMAR: SqlGrammar = {
  hash: "comment",
  bracket: "subscript",
  blockComment: "nesting",
  alternateQuoting: false,
  // A LINE comment, and the one CLICKHOUSE fact here established by probe rather than
  // from the reference - three probes on 26.7.1 over HTTP, because "the statement still ran"
  // cannot tell a comment from a token the parser skipped:
  //   `SELECT 1 AS a // note`             -> 1. So the characters are accepted.
  //   `SELECT 1 AS a // note; SELECT 999` -> 1, no error, while `SELECT 1; DROP TABLE
  //                                         nope` is "Syntax error (Multi-statements
  //                                         are not allowed)". So the `;` was HIDDEN.
  //   `SELECT 1 AS a // note\n, 2 AS b`   -> TWO columns: the run ends at the
  //                                         NEWLINE, so it is a line comment.
  // The cost of the old reading is measurable rather than theoretical: the shared
  // limiter appends before trailing trivia, so with `//` as code
  // `SELECT number FROM numbers(1000) // note` was emitted as
  // `… // note LIMIT 5` - 1000 rows returned while `wasLimited: true` was reported,
  // the exact shape #280 exists to prevent. With the fact carried it emits
  // `… LIMIT 5 // note` and returns 5 (both measured).
  doubleSlashComment: true,
  backslashAlwaysEscapes: false,
  script: DEFAULT_SQL_GRAMMAR.script,
  trailingLimitClauses: DEFAULT_SQL_GRAMMAR.trailingLimitClauses,
};

/** How ClickHouse statement text is read: grammar, SQL text, redaction, update target and completion. */
export const CLICKHOUSE_SQL_GRAMMAR: SqlGrammarSpec = {
  // `#`: the ClickHouse SQL syntax reference
  // (clickhouse.com/docs/sql-reference/syntax, "Comments", checked 2026-08-05)
  // lists `#` and `#!` beside `--` as single-line comment forms. The only row
  // here with no offline artifact to check - ClickHouse is reached over HTTP and
  // has no driver package under `node_modules` - so it is named with its source
  // and date rather than left implicit.
  // Brackets: `[…]` is an array literal or a subscript there, and
  // arrays nest (`Array(Array(T))` is a type). Source: the ClickHouse SQL reference
  // (clickhouse.com/docs/sql-reference, the Array type and the `[]` operator,
  // checked 2026-08-05); as with the `#` row there is no offline artifact, so the
  // two halves are corroborated separately from inside this repo - that `[…]` is an
  // array literal by the provider suite's own live-verified fixture
  // (`WITH [1, 2, 3] AS arr SELECT arrayJoin(arr)`), and that it is NOT an
  // identifier quote by `identifier.ts`, which quotes this dialect's names with the
  // standard `"…"` form. The nesting half rests on the reference alone.
  // Block comments NEST: the ClickHouse SQL syntax reference
  // (clickhouse.com/docs/sql-reference/syntax; checked 2026-08-05) states C-style
  // comments can be nested and gives a nested example. Same caveat as its `#`
  // row: reached over HTTP, so there is no driver artifact to check it against.
  // `//` reads as a LINE comment (26.7.1 over HTTP), established by two probes rather than one: the hiding was
  // shown by a `;` plus a write that did NOT execute, and the LINE half by a second column on the next line that DID.
  grammar: CLICKHOUSE_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: null },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
