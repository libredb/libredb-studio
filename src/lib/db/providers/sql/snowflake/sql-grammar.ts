import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

/**
 * Snowflake. The lexical facts were measured on the trial capture of 2026-10-12 (Snowflake 10.37.100), each named on
 * its field by its item in `tests/fixtures/snowflake/trial-2026-10-12-v10.37.100/`; the rest are read off Snowflake's
 * SQL reference (string and binary literals, dollar-quoted constants, `SELECT ... FOR UPDATE`).
 *
 * The one measured reading the shared reader does not follow is the string continuation: M63 ran `'a\<line feed>b'`
 * as a three-character string, and the reader leaves a literal unterminated at a backslash before a line feed, the
 * fail-safe direction, so the statement loses its bound and the confirmation gate asks.
 */
const SNOWFLAKE_GRAMMAR: SqlGrammar = {
  // CODE: M62 refused `SELECT 3 # 2` at the `#` ("unexpected '# '"), so `#` hides nothing, and ran `X''` as a binary
  // value, which the reader reads as a name and an ordinary string.
  hash: "code",
  // A SUBSCRIPT: `v[0]` and `v['key']` read a semi-structured value, and names are quoted with `"` only.
  bracket: "subscript",
  // FLAT: M60 ran `SELECT /* a /* b */ 1` and refused the same text with a second `*/` ("unexpected '/'").
  blockComment: "flat",
  alternateQuoting: false,
  // A LINE comment: M63 ran `SELECT 1 AS c // a comment`.
  doubleSlashComment: true,
  // A backslash escapes inside `'…'` (`'it\'s'`), as the reference gives it.
  backslashAlwaysEscapes: true,
  // False: M61 named a column `a\b` from `"a\b"`, so a backslash inside `"…"` is part of the name.
  doubleQuoteBackslashEscapes: false,
  // False: M64 ran `SELECT 1 AS a$b$c` as the name `A$B$C`, and the reference gives `$$` as the only dollar-quoted
  // form, so a `$` that would open a tagged run is code.
  dollarTags: false,
  // A Scripting block runs through `EXECUTE IMMEDIATE $$ … $$`, which the span reader holds whole.
  script: DEFAULT_SQL_GRAMMAR.script,
  // `SELECT ... FOR UPDATE [NOWAIT | WAIT <n>]` ends the statement, after any LIMIT. The wait is a number, so a `)`
  // after it ends the match.
  trailingLimitClauses: [/\s+FOR\s+UPDATE(?:\s+NOWAIT|\s+WAIT\s+\d+)?\s*$/i],
  // The reference gives NULL, '' and $$$$ as an unlimited LIMIT (and FETCH) count and a zero OFFSET; measured on the
  // trial on 2026-10-14, each returned every row, any case, and a LIMIT appended after one is a syntax error (SF-021).
  nonNumericRowBounds: ["NULL", "''", "$$$$"],
  // The forms that replace, overwrite, unload, delete stage files, run text the gate cannot read, spend credits or
  // open a path out of the account, none of which the shared set names: every COPY asks, whichever way it moves data,
  // and so does every CALL and every pipe. `CREATE OR ALTER` drops whatever columns its new definition leaves out. A
  // dynamic table, a dynamic Iceberg table, a Cortex Search service and a replication or failover group each refresh
  // or replicate on their own and bill for it.
  confirmForms: [
    ["CREATE", "OR", "REPLACE"],
    ["CREATE", "OR", "ALTER"],
    ["INSERT", "OVERWRITE"],
    ["COPY"],
    ["REMOVE"],
    ["RM"],
    ["EXECUTE", "IMMEDIATE"],
    ["EXECUTE", "TASK"],
    ["EXECUTE", "ALERT"],
    ["EXECUTE", "NOTEBOOK"],
    ["EXECUTE", "JOB", "SERVICE"],
    ["EXECUTE", "DBT", "PROJECT"],
    ["CALL"],
    ["CREATE", "WAREHOUSE"],
    ["CREATE", "TASK"],
    ["CREATE", "USER"],
    ["CREATE", "ROLE"],
    ["CREATE", "NETWORK", "POLICY"],
    ["CREATE", "COMPUTE", "POOL"],
    ["CREATE", "SERVICE"],
    ["CREATE", "DYNAMIC", "TABLE"],
    ["CREATE", "TRANSIENT", "DYNAMIC", "TABLE"],
    ["CREATE", "ALERT"],
    ["CREATE", "MATERIALIZED", "VIEW"],
    ["CREATE", "SECURE", "MATERIALIZED", "VIEW"],
    ["CREATE", "PIPE"],
    ["CREATE", "EXTERNAL", "ACCESS", "INTEGRATION"],
    ["CREATE", "API", "INTEGRATION"],
    ["CREATE", "NETWORK", "RULE"],
    ["CREATE", "REPLICATION", "GROUP"],
    ["CREATE", "FAILOVER", "GROUP"],
    ["CREATE", "CORTEX", "SEARCH", "SERVICE"],
    ["CREATE", "DYNAMIC", "ICEBERG", "TABLE"],
    // SF-013: a security integration changes who can sign in; a notification or storage integration and a share open
    // a path out of the account; an account and a managed (reader) account are billed accounts of their own.
    ["CREATE", "SECURITY", "INTEGRATION"],
    ["CREATE", "NOTIFICATION", "INTEGRATION"],
    ["CREATE", "STORAGE", "INTEGRATION"],
    ["CREATE", "ACCOUNT"],
    ["CREATE", "MANAGED", "ACCOUNT"],
    ["CREATE", "SHARE"],
  ],
  // An external stage reads and writes files outside the account; an internal one, with no URL, keeps them inside, so
  // only a stage that names a URL asks (SF-013). `CREATE OR REPLACE STAGE` already asks above.
  confirmFormsWhen: [
    { form: ["CREATE", "STAGE"], when: "URL" },
    { form: ["CREATE", "TEMPORARY", "STAGE"], when: "URL" },
    { form: ["CREATE", "TEMP", "STAGE"], when: "URL" },
  ],
  // Formatted as PostgreSQL, `QUALIFY` was lower-cased and joined to the GROUP BY list, and `@stage` became `@ stage`
  // (SF-041); sql-formatter's Snowflake language keeps the clause and refuses the stage reference, which leaves the
  // text as written.
  formatterLanguage: "snowflake",
  // Snowflake's own clauses and the functions a session reaches for first (SF-042), from Snowflake's SQL reference.
  completionWords: {
    keywords: [
      "QUALIFY",
      "ILIKE",
      "RLIKE",
      "LATERAL",
      "PIVOT",
      "UNPIVOT",
      "MATCH_RECOGNIZE",
      "SAMPLE",
      "TABLESAMPLE",
      "EXCLUDE",
      "MINUS",
      "TOP",
      "ASOF JOIN",
      "CONNECT BY",
      "START WITH",
      "CHANGES",
    ],
    functions: [
      "ARRAY_AGG",
      "ARRAY_CONSTRUCT",
      "ARRAY_CONTAINS",
      "ARRAY_SIZE",
      "OBJECT_CONSTRUCT",
      "OBJECT_KEYS",
      "PARSE_JSON",
      "TRY_PARSE_JSON",
      "TO_VARIANT",
      "TO_JSON",
      "FLATTEN",
      "GET_PATH",
      "TYPEOF",
      "IFF",
      "NVL",
      "NVL2",
      "ZEROIFNULL",
      "DIV0",
      "LISTAGG",
      "TRY_CAST",
      "TRY_TO_NUMBER",
      "TRY_TO_DATE",
      "TO_TIMESTAMP",
      "DATEADD",
      "DATEDIFF",
      "CONVERT_TIMEZONE",
      "SPLIT_PART",
      "REGEXP_SUBSTR",
      "REGEXP_REPLACE",
      "APPROX_COUNT_DISTINCT",
      "MEDIAN",
      "CURRENT_ROLE",
      "CURRENT_WAREHOUSE",
      "CURRENT_DATABASE",
      "CURRENT_SCHEMA",
      "CURRENT_USER",
      "CURRENT_ACCOUNT",
      "CURRENT_REGION",
      "CURRENT_DATE",
      "LAST_QUERY_ID",
      "RESULT_SCAN",
      "GENERATOR",
      "SEQ4",
      "UNIFORM",
      "RANDOM",
      "HASH",
      "SHA2",
    ],
  },
  // Each statement runs in its own session (see `snowflake/statements.ts`), so `ALTER SESSION SET | UNSET` cannot
  // outlive it, and the result already says the setting does not carry over (SF-030). `ALTER SESSION POLICY` alters an
  // account object that does outlive it, so only the SET and UNSET forms are exempt.
  confirmExemptForms: [
    ["ALTER", "SESSION", "SET"],
    ["ALTER", "SESSION", "UNSET"],
  ],
  // An anonymous procedure (`WITH p AS PROCEDURE … CALL p()`) and any `SYSTEM$` function, wherever they are written.
  confirmCodeForms: [["AS", "PROCEDURE"], { prefix: "SYSTEM$" }],
};

/** How Snowflake statement text is read: grammar, SQL text, redaction, update target and completion. */
export const SNOWFLAKE_SQL_GRAMMAR: SqlGrammarSpec = {
  grammar: SNOWFLAKE_GRAMMAR,
  readsSqlText: true,
  redaction: { kind: "sql", nameQuote: null },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  completion: { formatSegment: null, readQuotedQualifier: null },
};
