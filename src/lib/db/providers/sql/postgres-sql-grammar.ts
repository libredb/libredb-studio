/**
 * PostgreSQL's SQL grammar functions, the ones its declaration names at `sqlText.completion` and Studio's grammar
 * function table binds (src/lib/db/sql-grammar/index.ts, `SQL_GRAMMAR_FUNCTIONS`): only PostgreSQL completions
 * introduce quoted table names, and every other dialect keeps its bare-identifier lookup and quotes through the
 * connection's capabilities. Its grammar facts are stated in its declaration,
 * src/lib/db/engine-declarations/postgres.json.
 */
import type { QuotedQualifierReader, SegmentFormatter } from "@/lib/db/sql-grammar/types";

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

/**
 * PostgreSQL's completion segment formatter, the `formatSegment` its declaration names: one catalog identifier quoted
 * by PostgreSQL's conservative quote_ident rule, bare only when it is lower case and no keyword but an unreserved one.
 */
export const POSTGRES_FORMAT_SEGMENT: SegmentFormatter = function formatPostgresIdentifier(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) && !QUOTED_KEYWORDS.has(name) ? name : doubleQuoted(name);
};

/**
 * PostgreSQL's completion quoted qualifier reader, the `readQuotedQualifier` its declaration names: the qualifier a
 * text up to a dot ends in when it is written in double quotes, its doubled quotes undone, or undefined.
 */
export const POSTGRES_READ_QUOTED_QUALIFIER: QuotedQualifierReader = function readPostgresQuotedQualifier(
  textToDot: string,
): string | undefined {
  return textToDot.match(/"((?:[^"]|"")+)"\.$/)?.[1].replace(/""/g, '"');
};
