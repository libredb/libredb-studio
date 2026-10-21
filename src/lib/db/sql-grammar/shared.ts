import type { SqlGrammar } from "./types";

/**
 * What a call that names no dialect gets.
 *
 * Deliberately today's reading rather than a stricter "report undeterminable
 * wherever the dialects disagree". The strict default is the more honest one in
 * the abstract, but every fixture written for #275, #280, #287, #291 and #294
 * calls these readers without a dialect, and rewriting the meaning of that whole
 * suite in the same change that introduces the channel would leave nothing
 * pinning the old behaviour. Pinned by its own tests instead, so it is a decision
 * rather than an accident.
 */
export const DEFAULT_SQL_GRAMMAR: SqlGrammar = {
  hash: "comment-unless-operator",
  bracket: "quoted-identifier",
  blockComment: "flat",
  alternateQuoting: false,
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  script: { blocks: "none", separatorLine: null, unit: "statement" },
  trailingLimitClauses: [],
};

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
};

/** The empty word set, for an engine that adds no word to a shared set. */
export const NO_EXTRA_WORDS: ReadonlySet<string> = new Set();

/** What a redacted literal becomes. */
export const REDACTED_VALUE = "?";
