import {
  EVERY_TYPE_IS_FLOAT64,
  identifierDoubleQuoted,
  literalStandard,
  NO_BARE_SPELLING,
  NO_EXACT_DECIMAL_TYPE_NAMES,
  NO_INSTANT_TYPE_NAMES,
  placeholderQuestion,
  STANDARD_DDL_TYPES,
  STANDARD_TYPE_VOCABULARY,
  unquoteStandard,
  VERBATIM_DECLARED_TYPES_STAND_ALONE,
} from "@/lib/db/sql-writing/shared";
import { binaryStandardHex } from "@/lib/db/sql-writing/export-shared";
import type { SqlWritingSpec } from "@/lib/db/sql-writing/types";

/** How a generated statement spells a literal, a name and a bind for SQLite. */
export const SQLITE_SQL_WRITING: SqlWritingSpec = {
  escapeLiteral: literalStandard,
  unescapeLiteral: unquoteStandard,
  // The SQL standard form.
  quoteIdentifier: identifierDoubleQuoted,
  // The SQLite drivers take `?`.
  placeholder: placeholderQuestion,
  temporalLiteral: null,
  // SQLite's type words name an affinity and not a storage width; each fact, and what
  // measured it, is beside its shared name.
  inlineEdit: {
    instantTypeNames: NO_INSTANT_TYPE_NAMES,
    exactDecimalTypeNames: NO_EXACT_DECIMAL_TYPE_NAMES,
    float64TypeNames: EVERY_TYPE_IS_FLOAT64,
  },
  export: {
    ddlTypes: STANDARD_DDL_TYPES,
    // SQLite keeps a declared type as the exact string it was given; the measurement is
    // beside the shared name.
    standsAlone: VERBATIM_DECLARED_TYPES_STAND_ALONE,
    bareSpelling: NO_BARE_SPELLING,
    typeVocabulary: STANDARD_TYPE_VOCABULARY,
    // Measured through `bun:sqlite`: `select hex(X'0102deadbeef')` -> `0102DEADBEEF`,
    // and `typeof(X'')` -> `blob` with `length(X'')` 0.
    binaryLiteral: binaryStandardHex,
    // Replayed into the engine (2026-10-04): SQLite reads `9e999` and `-9e999` as its
    // infinities in a `REAL` column, where a quoted `'Infinity'` is stored as TEXT, and has
    // no NaN at all (it stores one as NULL).
    nonFinite: { NaN: "NULL", Infinity: "9e999", "-Infinity": "-9e999" },
    insertForm: "values",
  },
};
