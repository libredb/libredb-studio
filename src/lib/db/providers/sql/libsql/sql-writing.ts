import {
  EVERY_TYPE_IS_FLOAT64,
  identifierDoubleQuoted,
  literalStandard,
  NO_BARE_SPELLING,
  NO_EXACT_DECIMAL_TYPE_NAMES,
  NO_INSTANT_TYPE_NAMES,
  NULL_NON_FINITE,
  STANDARD_DDL_TYPES,
  STANDARD_TYPE_VOCABULARY,
  unquoteStandard,
  VERBATIM_DECLARED_TYPES_STAND_ALONE,
} from "@/lib/db/sql-writing/shared";
import { binaryStandardHex } from "@/lib/db/sql-writing/export-shared";
import type { SqlWritingSpec } from "@/lib/db/sql-writing/types";

/** How a generated statement spells a literal, a name and a bind for libSQL. */
export const LIBSQL_SQL_WRITING: SqlWritingSpec = {
  // Measured on sqld 0.24.33: `SELECT 'it''s'` answers `it's`, and a backslash has no
  // special meaning - the same standard doubling SQLite defines.
  escapeLiteral: literalStandard,
  unescapeLiteral: unquoteStandard,
  quoteIdentifier: identifierDoubleQuoted,
  placeholder: null,
  temporalLiteral: null,
  // libSQL embeds SQLite, so it reads the SQLite storage-class facts by their shared names,
  // where each one's measurement is written.
  inlineEdit: {
    /**
     * libSQL states this for the reason it states `float64TypeNames: "all"`: it embeds the same
     * engine and reports the same declarations — measured over the wire rather than reasoned
     * from that, and identical to bun:sqlite on all twelve of its combinations.
     */
    instantTypeNames: NO_INSTANT_TYPE_NAMES,
    /**
     * libSQL states this for the reason it states the other two: it embeds the same engine and
     * reports the same `sqlite3_column_decltype` declarations. The measurement is the one
     * beside `NO_EXACT_DECIMAL_TYPE_NAMES`, on bun:sqlite.
     */
    exactDecimalTypeNames: NO_EXACT_DECIMAL_TYPE_NAMES,
    /**
     * libSQL states this for the reason SQLite does: it embeds the same engine and reports the
     * same `sqlite3_column_decltype` declarations. Reading only the words `real` and `float`
     * refused the rest, a `DATE` column holding a julian day among them, measured on bun:sqlite
     * beside `EVERY_TYPE_IS_FLOAT64`.
     */
    float64TypeNames: EVERY_TYPE_IS_FLOAT64,
  },
  export: {
    ddlTypes: STANDARD_DDL_TYPES,
    // The same list, for the same measured reason: libSQL IS SQLite 3.47.0, and
    // `pragma_table_info` there answers the declared spelling verbatim too (measured on
    // sqld 0.24.33).
    standsAlone: VERBATIM_DECLARED_TYPES_STAND_ALONE,
    bareSpelling: NO_BARE_SPELLING,
    typeVocabulary: STANDARD_TYPE_VOCABULARY,
    // Measured over Hrana on sqld 0.24.33: `SELECT hex(X'0102deadbeef')` answers
    // `0102DEADBEEF`, `typeof(X'')` answers `blob` and `length(X'')` answers 0 - the
    // same readings as the SQLite row above, taken again rather than assumed.
    binaryLiteral: binaryStandardHex,
    nonFinite: NULL_NON_FINITE,
    insertForm: "values",
  },
};
