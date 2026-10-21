import {
  EXACT_DECIMAL_TYPE_NAMES,
  FLOAT64_TYPE_NAMES,
  identifierBacktickDoubled,
  INSTANT_TYPE_NAMES,
  literalDoubleAndBackslash,
  NO_BARE_SPELLING,
  NOTHING_STANDS_ALONE,
  NULL_NON_FINITE,
  STANDARD_DDL_TYPES,
  STANDARD_TYPE_VOCABULARY,
  unquoteDoubleAndBackslash,
} from "@/lib/db/sql-writing/shared";
import { binaryStandardHex } from "@/lib/db/sql-writing/export-shared";
import type { SqlWritingSpec } from "@/lib/db/sql-writing/types";

/** How a generated statement spells a literal, a name and a bind for OpenSearch. */
export const OPENSEARCH_SQL_WRITING: SqlWritingSpec = {
  // OpenSearch does BOTH, which is why its two type-ids do not share a row with
  // Elasticsearch's. Measured on 3.8.0 (2026-08-19): `SELECT 'a''b'` -> `a'b`, so
  // doubling works; `SELECT 'a\'b'` -> `a'b` too, so a backslash escapes the quote;
  // `SELECT 'a\\b'` -> ONE backslash, so it escapes itself; and `SELECT 'a\'` is a
  // `ParserException` - the trailing backslash escaped the closing quote and left the
  // literal open, which is exactly the defect #290 is about. The fork's SQL plugin
  // reads its literals the way MySQL does, and this row is not an inference from that
  // lineage but the four probes above.
  escapeLiteral: literalDoubleAndBackslash,
  unescapeLiteral: unquoteDoubleAndBackslash,
  // OpenSearch shares MySQL's backtick, and it is NOT a stylistic choice: measured
  // 2026-08-19 on 3.8.0, its SQL plugin reads a DOUBLE-quoted name as a string
  // literal, so `SELECT customer FROM "probe_orders"` is `IndexNotFoundException[no
  // such index ["probe_orders"]]` - quotes and all - while ``FROM `probe_orders``` is
  // HTTP 200. Worse in a predicate, where nothing fails: `WHERE "customer" = 'acme'`
  // compares two literals and answers 0 rows. Backticks work for both a table and a
  // field there. Elasticsearch 9.1.4 is the exact opposite - it answers a backtick
  // with "backquoted identifiers not supported; please use double quotes instead" -
  // so the two search ids cannot share a form.
  //
  // The doubling is this repo's own convention carried over from MySQL and is NOT
  // measured: an index or field name containing a backtick would be needed to probe
  // it, and creating one on the probe cluster to find out was judged not worth
  // polluting the fixtures. It is the fail-safe direction either way - a doubled
  // backtick can only make the engine refuse a name, never make it read one it
  // should not.
  quoteIdentifier: identifierBacktickDoubled,
  // Both search endpoints really do bind `?` (measured - ES takes
  // `{"query":"… WHERE id = ?","params":[1]}`, OpenSearch takes a `parameters` array of
  // `{type,value}` objects, both HTTP 200), but they spell the REQUEST differently and
  // the provider's seam carries the statement alone, so its `query()` refuses
  // positional parameters outright. Emitting `?` here would produce a statement whose
  // placeholder the provider then declines to fill.
  placeholder: null,
  temporalLiteral: null,
  inlineEdit: {
    instantTypeNames: INSTANT_TYPE_NAMES,
    exactDecimalTypeNames: EXACT_DECIMAL_TYPE_NAMES,
    float64TypeNames: FLOAT64_TYPE_NAMES,
  },
  export: {
    ddlTypes: STANDARD_DDL_TYPES,
    standsAlone: NOTHING_STANDS_ALONE,
    bareSpelling: NO_BARE_SPELLING,
    typeVocabulary: STANDARD_TYPE_VOCABULARY,
    // Neither endpoint parses INSERT at all, so what is emitted for them is portable SQL
    // for somewhere else; their SQL reads its literals the way MySQL's does.
    binaryLiteral: binaryStandardHex,
    nonFinite: NULL_NON_FINITE,
    insertForm: "values",
  },
};
