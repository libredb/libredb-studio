import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

const MSSQL_GRAMMAR: SqlGrammar = {
  hash: "code",
  bracket: "quoted-identifier",
  blockComment: "nesting",
  alternateQuoting: false,
  // Probed 2026-08-25 on 2022 through sqlcmd: `SELECT 1 AS a // note` is Msg 102,
  // "Incorrect syntax near '/'".
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  // The batch is the unit, cut at `GO` lines, and `blocks` stays `none` because a batch
  // already holds every body it contains: `CREATE PROCEDURE` runs to the end of its batch.
  // Measured on 2025 RTM-CU9: `DECLARE @x INT = 5; SELECT @x * 2` sent as two requests is
  // `Must declare the scalar variable "@x"`, and as one batch answers 10.
  // A MERGE keeps its `;`: the server refuses one without it (Msg 10713, SF-046).
  script: { blocks: "none", separatorLine: "GO", unit: "batch", terminatedStatements: ["MERGE"] },
  trailingLimitClauses: DEFAULT_SQL_GRAMMAR.trailingLimitClauses,
};

/** How SQL Server statement text is read: grammar, SQL text, redaction, update target and completion. */
export const MSSQL_SQL_GRAMMAR: SqlGrammarSpec = {
  // `#name` and `##name` are local and global temp tables, which is
  // ordinary T-SQL; the comment forms are `--` and the block form. `[name]` is a
  // delimited identifier and a `]` inside one is written doubled, which is exactly
  // what this repo's own quoter emits for the dialect (`src/lib/sql/identifier.ts`,
  // pinned by the MSSQL provider suite's `escapeIdentifier` test).
  // Block comments NEST: "Slash Star (Block Comment) (Transact-SQL)"
  // (learn.microsoft.com; checked 2026-08-05): nested comments are supported, a
  // `/*` anywhere inside a comment starts a nested one, and a missing closer is
  // an error. This is the row the report on #300 got wrong, which is why it was
  // re-established rather than copied.
  // `//` reads as CODE (2022, sqlcmd), refusing the characters where they stand; the probe is quoted on the
  // constant above.
  grammar: MSSQL_GRAMMAR,
  readsSqlText: true,
  // `[` is a name under every session setting. A double quote is a string while `QUOTED_IDENTIFIER` is off, so it
  // is masked like any literal.
  redaction: { kind: "sql", nameQuote: "[" },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
