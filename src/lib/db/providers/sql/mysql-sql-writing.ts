import {
  EXACT_DECIMAL_TYPE_NAMES,
  FLOAT64_TYPE_NAMES,
  identifierBacktickDoubled,
  INSTANT_TYPE_NAMES,
  literalDoubleAndBackslash,
  NULL_NON_FINITE,
  placeholderQuestion,
  STANDARD_TYPE_VOCABULARY,
  unquoteDoubleAndBackslash,
} from "@/lib/db/sql-writing/shared";
import { binaryStandardHex } from "@/lib/db/sql-writing/export-shared";
import type { SqlWritingSpec } from "@/lib/db/sql-writing/types";

/** How a generated statement spells a literal, a name and a bind for MySQL. */
export const MYSQL_SQL_WRITING: SqlWritingSpec = {
  // Default `sql_mode`. A server running with NO_BACKSLASH_ESCAPES reads the
  // doubled backslash as two characters, which is why binding the value beats
  // quoting it wherever a bind form exists.
  escapeLiteral: literalDoubleAndBackslash,
  unescapeLiteral: unquoteDoubleAndBackslash,
  quoteIdentifier: identifierBacktickDoubled,
  // `mysql2` takes `?`.
  placeholder: placeholderQuestion,
  temporalLiteral: null,
  inlineEdit: {
    instantTypeNames: INSTANT_TYPE_NAMES,
    exactDecimalTypeNames: EXACT_DECIMAL_TYPE_NAMES,
    float64TypeNames: FLOAT64_TYPE_NAMES,
  },
  export: {
    ddlTypes: {
      text: "TEXT",
      integer: "BIGINT",
      numeric: "DOUBLE",
      boolean: "BOOLEAN",
      timestamp: "DATETIME",
      binary: "BLOB",
    },
    standsAlone: ["text", "tinytext", "mediumtext", "longtext", "blob", "tinyblob", "mediumblob", "longblob", "year"],
    // `mysql2` hands a bit string back as bytes, which `bit(64)`, MySQL's widest, takes for every
    // width. MySQL's bare `datetime`, `timestamp` and `time` have fractional precision 0, which
    // ROUNDS a `.999` replayed into them up to the next second, so they are written at precision 6
    // (#1386).
    bareSpelling: { bit: "bit(64)", datetime: "datetime(6)", timestamp: "timestamp(6)", time: "time(6)" },
    typeVocabulary: STANDARD_TYPE_VOCABULARY,
    // Measured on MySQL 26.7.0: `SELECT HEX(X'0102deadbeef')` answers `0102DEADBEEF` and
    // `SELECT LENGTH(X'')` answers 0, so MySQL is on `binaryStandardHex` rather than `binaryZeroX` even
    // though it accepts `0x0102deadbeef` too: a zero-length value has no `0x` spelling
    // (`SELECT LENGTH(0x)` is `ERROR 1054 … Unknown column '0x'`), and an empty cell is
    // not a case an export gets to refuse.
    binaryLiteral: binaryStandardHex,
    nonFinite: NULL_NON_FINITE,
    insertForm: "values",
  },
};
