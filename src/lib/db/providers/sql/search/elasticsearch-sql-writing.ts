import {
  EXACT_DECIMAL_TYPE_NAMES,
  FLOAT64_TYPE_NAMES,
  identifierDoubleQuoted,
  INSTANT_TYPE_NAMES,
  literalStandard,
  NO_BARE_SPELLING,
  NOTHING_STANDS_ALONE,
  NULL_NON_FINITE,
  STANDARD_DDL_TYPES,
  STANDARD_TYPE_VOCABULARY,
  unquoteStandard,
} from "@/lib/db/sql-writing/shared";
import { binaryStandardHex } from "@/lib/db/sql-writing/export-shared";
import type { SqlWritingSpec } from "@/lib/db/sql-writing/types";

/** How a generated statement spells a literal, a name and a bind for Elasticsearch. */
export const ELASTICSEARCH_SQL_WRITING: SqlWritingSpec = {
  // Elasticsearch doubles the quote and reads a backslash as DATA. Measured on
  // 9.1.4 (2026-08-19): `SELECT 'a''b'` -> `a'b`; `SELECT 'a\\b'` -> the two
  // characters `a\b`; `SELECT 'a\'b'` is a `parsing_exception` at the character AFTER
  // the backslash, which is only possible if the `\` did not escape the quote that
  // closed the literal; and `SELECT 'a\'` returns `a\`.
  escapeLiteral: literalStandard,
  unescapeLiteral: unquoteStandard,
  // The SQL standard form. Measured: `FROM "probe_orders"` and `SELECT "note.keyword"` both
  // answer 200, and a backtick is refused outright. Elasticsearch 9.1.4 is the exact opposite of
  // OpenSearch - it answers a backtick with "backquoted identifiers not supported; please use
  // double quotes instead" - so the two search ids cannot share a form.
  quoteIdentifier: identifierDoubleQuoted,
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
