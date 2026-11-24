import { DEFAULT_SQL_GRAMMAR, type SqlGrammar } from "@libredb/provider-sdk/sql";

/**
 * The one grammar two engines share: `sqlite` and `libsql`, since libSQL reads
 * SQLite's grammar. The measurements behind its rows:
 * - HASH and BRACKET: the SQLite amalgamation bundled with `better-sqlite3` classifies
 *   `#` as `CC_VARALPHA`, an alphabetic bind-variable prefix, and opens comments
 *   on `--` and `/*` only. The same tokenizer is where its BRACKET row comes from:
 *   `[` is `CC_QUOTE2`, "`[...]` style quoted ids", scanned to the first `]` -
 *   Microsoft-style identifiers, accepted for compatibility.
 * - BLOCK COMMENT is FLAT, from the bundled amalgamation's own tokenizer: `case
 *   CC_SLASH` scans forward for the first `*\/` with no depth count at all.
 */
export const SQLITE_GRAMMAR: SqlGrammar = {
  hash: "code",
  bracket: "quoted-identifier",
  blockComment: "flat",
  alternateQuoting: false,
  // Probed 2026-08-25 through the bundled driver: `SELECT 1 AS a // note` and
  // `SELECT 1 // 2` are both 'near "/": syntax error'. The amalgamation's tokenizer
  // agrees - `case CC_SLASH` opens a run only on `/*`.
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  // `CREATE TRIGGER … BEGIN … END` is the one statement with a body. Measured through
  // node:sqlite 3.50.4 before the fact existed: the trigger cut at its inner `;` was
  // `incomplete input`.
  script: { blocks: "trigger-body", separatorLine: null, unit: "statement" },
  trailingLimitClauses: DEFAULT_SQL_GRAMMAR.trailingLimitClauses,
  // The INSERTs that delete the row a new one collides with on a primary or unique key (SQLite reference, "INSERT"
  // and "The ON CONFLICT Clause"): `REPLACE INTO`, whose INTO is required, and `INSERT OR REPLACE`. Measured through
  // bun:sqlite on 3.53.4, OR ROLLBACK, OR ABORT and OR FAIL refuse the new row with an error and OR IGNORE skips it,
  // so none of them changes a row already there and none asks.
  confirmForms: [
    ["REPLACE", "INTO"],
    ["INSERT", "OR", "REPLACE"],
  ],
};

/** The empty word set, for an engine that adds no word to a shared set. */
export const NO_EXTRA_WORDS: ReadonlySet<string> = new Set();

/** What a redacted literal becomes. */
export const REDACTED_VALUE = "?";
