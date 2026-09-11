import { quoteIdentifier } from "@/lib/sql/identifier";

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

/** Format one catalog identifier using PostgreSQL's conservative quote_ident rule. */
export function formatPostgresIdentifier(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) && !QUOTED_KEYWORDS.has(name) ? name : quoteIdentifier(name, "postgres");
}
