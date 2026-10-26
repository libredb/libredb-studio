import { DEFAULT_SQL_GRAMMAR, NO_EXTRA_WORDS } from "@/lib/db/sql-grammar/shared";
import type { SqlGrammar, SqlGrammarSpec } from "@/lib/db/sql-grammar/types";

// PostgreSQL quote_ident quotes every keyword except UNRESERVED_KEYWORD.
// Source: PostgreSQL 18, src/include/parser/kwlist.h and
// src/backend/utils/adt/ruleutils.c (quote_identifier).
// https://github.com/postgres/postgres/blob/REL_18_STABLE/src/include/parser/kwlist.h
// Keep this separate from SQL_KEYWORDS: that list is only editor suggestions.
const QUOTED_KEYWORDS = new Set(
  `all analyse analyze and any array as asc asymmetric authorization between bigint binary bit boolean
both case cast char character check coalesce collate collation column concurrently constraint create
cross current_catalog current_date current_role current_schema current_time current_timestamp
current_user dec decimal default deferrable desc distinct do else end except exists extract false
fetch float for foreign freeze from full grant greatest group grouping having ilike in initially
inner inout int integer intersect interval into is isnull join json json_array json_arrayagg
json_exists json_object json_objectagg json_query json_scalar json_serialize json_table json_value
lateral leading least left like limit localtime localtimestamp merge_action national natural nchar
none normalize not notnull null nullif numeric offset on only or order out outer overlaps overlay
placing position precision primary real references returning right row select session_user setof
similar smallint some substring symmetric system_user table tablesample then time timestamp to
trailing treat trim true union unique user using values varchar variadic verbose when where window
with xmlattributes xmlconcat xmlelement xmlexists xmlforest xmlnamespaces xmlparse xmlpi xmlroot
xmlserialize xmltable`.split(/\s+/),
);

/** A name in double quotes, a `"` inside it doubled: PostgreSQL's delimited identifier. */
function doubleQuoted(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Format one catalog identifier using PostgreSQL's conservative quote_ident rule. */
function formatPostgresIdentifier(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) && !QUOTED_KEYWORDS.has(name) ? name : doubleQuoted(name);
}

const POSTGRES_GRAMMAR: SqlGrammar = {
  hash: "code",
  bracket: "subscript",
  blockComment: "nesting",
  alternateQuoting: false,
  // CODE, and the strongest of the six refusals: `SELECT 1 // 2` on 18 is "operator
  // does not exist: integer // integer", so `//` is a real OPERATOR NAME here that
  // merely has no implementation for those argument types - not a comment and not a
  // syntax error. `SELECT 1 AS a // note` is "syntax error at or near \"//\"".
  doubleSlashComment: false,
  backslashAlwaysEscapes: false,
  // Established, and equal to the default: a routine body is a literal (`$$ … $$` or
  // `'…'`), which the span reader already holds whole, so no `;` inside one is code.
  script: DEFAULT_SQL_GRAMMAR.script,
  // Materialize's `AS OF [AT LEAST] <t>`, which shares this type-id route (E2E pass
  // of 2026-10-03/04, #1398): `SELECT * FROM ui_mv AS OF AT LEAST 0` sent with the
  // bound appended is `Expected end of statement, found LIMIT`, and with the bound
  // before the clause it returns rows. The timestamp is a number or a single-quoted
  // literal - the forms the clause's own grammar documents - so `AS of` as an alias
  // (its next word is a name, not a literal) and an `AS OF` inside a subquery (a
  // `)` follows the timestamp) never match. Real PostgreSQL and RisingWave share
  // this row and have no such clause: a statement of theirs ending in these words
  // is one the server refuses bound or unbound, so the reading costs neither.
  trailingLimitClauses: [/\s+AS\s+OF\s+(?:AT\s+LEAST\s+)?(?:\d+|'[^']*')\s*$/i],
  // `LIMIT ALL` is PostgreSQL's own spelling of "no limit" (SELECT docs, LIMIT { count | ALL });
  // the parser takes the ALL alternative for the count only - the FETCH spelling has no ALL arm
  // (gram.y: select_limit_value has one, select_fetch_first_value does not). The count is a word,
  // so the shared digit-only probe missed it, `hasLimit` read false and a second `LIMIT` followed
  // the statement's own - which PostgreSQL refuses as two LIMIT clauses. Declaring the value reads
  // the form as the statement's own unlimited bound, like Snowflake's `NULL` (SF-021). The
  // declaration is shared by the whole row-bound probe family: an `OFFSET ALL` is not PostgreSQL
  // syntax either, but a lone one is left untouched by the normal path and the engine keeps
  // refusing the text as written.
  nonNumericRowBounds: ["ALL"],
  // `DO` runs an anonymous block whose code is a literal, `$$ ... $$` or `'...'`, which the gate does not read, so it
  // asks whatever the block does; `DO LANGUAGE <name>` writes the language before the body. The `DO` of
  // `ON CONFLICT DO NOTHING | UPDATE` and of `CREATE RULE ... DO INSTEAD | ALSO` is followed by a word and does not ask.
  confirmCodeForms: [{ wordThenBody: "DO" }, ["DO", "LANGUAGE"]],
  // `EXPLAIN` only plans. `EXPLAIN ANALYZE` (and the British `ANALYSE`) executes the explained statement, and so does
  // a parenthesised `ANALYZE` whose value is absent or anything other than a boolean false (`false`, `off`, `no`, `0`
  // and their accepted prefixes) or an integer literal of value 0. `0x1`, `0b1`, `0o1` and `0_1` are 1, so they
  // execute (PostgreSQL manual, EXPLAIN; the integer scanner). CockroachDB shares this type-id, so the same
  // statements ask there (#1863).
  explainExecutesWithAnalyze: true,
};

/** How PostgreSQL statement text is read: grammar, SQL text, redaction, update target and completion. */
export const POSTGRES_SQL_GRAMMAR: SqlGrammarSpec = {
  // PostgreSQL has exactly two comment forms, `--` and the block
  // form; `#` is an operator character (`#>`, `#>>`, `#-` walk or delete a jsonb
  // path, `#` is integer XOR).
  // Block comments NEST: the PostgreSQL manual's lexical-structure chapter (4.1.5
  // Comments, postgresql.org/docs/current/sql-syntax-lexical.html; checked
  // 2026-08-05) says block comments nest "as specified in the SQL standard but
  // unlike C", precisely so a region containing comments can be commented out.
  // `//` reads as CODE (18), and PostgreSQL is the most explicit of the engines that refuse it: `SELECT 1 // 2`
  // is "operator does not exist: integer // integer", so `//` is an operator NAME here rather than a comment
  // marker or a syntax error.
  // Brackets: `expression[subscript]` extracts an element and
  // `expression[lower:upper]` a slice (PostgreSQL manual 4.2.3 Subscripts), and
  // array constructors nest: the manual's own example is
  // `SELECT ARRAY[[1,2],[3,4]]` (4.2.12 Array Constructors, which also notes the
  // inner `ARRAY` keyword may be omitted). Identifiers there are quoted with double
  // quotes (4.1.1), so `[` is never a name quote in this dialect.
  // PostgreSQL was briefly left there too, and the cost is why it is not: an
  // undeterminable run is also text the confirmation gate cannot read, and since #297
  // that gate ASKS rather than staying silent - so `ARRAY[[1,2],[3,4]]` and
  // `j['a]b']`, everyday reads in this dialect, both lost their bound AND prompted
  // before running. A confirmation an operator learns to click through protects
  // nothing, so a false prompt on everyday syntax is not the cheap direction it looks
  // like. The rule was established from the manual rather than the cost being
  // accepted. Pinned in `tests/components/QuerySafetyDialog.test.tsx` and the
  // PostgreSQL provider suite, and documented in `docs/providers/postgres.md`.
  grammar: POSTGRES_GRAMMAR,
  readsSqlText: true,
  // A double quote is a name under every session setting, the one quoted run a redacted statement keeps.
  redaction: { kind: "sql", nameQuote: '"' },
  updateTarget: {
    dashCommentNeedsSeparator: false,
    extraQueryOpeners: NO_EXTRA_WORDS,
    extraSetOperators: NO_EXTRA_WORDS,
  },
  // Only PostgreSQL completions introduce quoted table names; every other dialect keeps its bare-identifier
  // lookup and quotes through the connection's capabilities.
  completion: {
    formatSegment: formatPostgresIdentifier,
    readQuotedQualifier: (textToDot) => textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"'),
  },
};
