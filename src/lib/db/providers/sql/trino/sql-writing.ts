import {
  EXACT_DECIMAL_TYPE_NAMES,
  FLOAT64_TYPE_NAMES,
  identifierDoubleQuoted,
  INSTANT_TYPE_NAMES,
  literalStandard,
  NO_BARE_SPELLING,
  NULL_NON_FINITE,
  STANDARD_TYPE_VOCABULARY,
  unquoteStandard,
} from "@/lib/db/sql-writing/shared";
import { binaryStandardHex } from "@/lib/db/sql-writing/export-shared";
import { trinoLiteral } from "./typed-literals";
import type { SqlWritingSpec } from "@/lib/db/sql-writing/types";

/** How a generated statement spells a literal, a name and a bind for Trino. */
export const TRINO_SQL_WRITING: SqlWritingSpec = {
  // Measured on Trino 476 (2026-08-20), both directions: `SELECT 'O''Brien' AS a`
  // answers `O'Brien`, so doubling is the escape; `SELECT 'a\\b' AS a` answers the two
  // characters `a\\b`, so a backslash is DATA and doubling it would add a second one to
  // the value. Trino spells its backslash escapes in the separate `U&'fo\\+0000F6'`
  // form, exactly as Druid does.
  escapeLiteral: literalStandard,
  unescapeLiteral: unquoteStandard,
  // The SQL standard form. Measured on 476: `SELECT "nationkey" FROM
  // tpch.sf1.nation LIMIT 1` returns the column, `SELECT 1 AS "a""b"` names it
  // `a"b`, and a backtick is refused in the engine's own words - "backquoted
  // identifiers are not supported; use double quotes to quote identifiers".
  quoteIdentifier: identifierDoubleQuoted,
  // Trino really does bind, through `PREPARE`/`EXECUTE` plus an `X-Trino-Prepared-Statement`
  // header, but the provider's transport seam carries the statement alone, so
  // `TrinoProvider.query()` REFUSES a non-empty params array outright. Emitting `?` here
  // would build a statement whose placeholder the provider then declines to fill.
  placeholder: null,
  temporalLiteral: null,
  inlineEdit: {
    instantTypeNames: INSTANT_TYPE_NAMES,
    exactDecimalTypeNames: EXACT_DECIMAL_TYPE_NAMES,
    float64TypeNames: FLOAT64_TYPE_NAMES,
  },
  export: {
    // `text` is `Unknown type 'text'` on Trino 476: `VARCHAR` is the unbounded
    // character type, and `DOUBLE PRECISION`, `BIGINT`, `BOOLEAN` and `TIMESTAMP` are
    // all accepted as they are (measured, `DOUBLE PRECISION` is stored as `double`).
    ddlTypes: {
      text: "VARCHAR",
      integer: "BIGINT",
      numeric: "DOUBLE PRECISION",
      boolean: "BOOLEAN",
      timestamp: "TIMESTAMP",
      binary: "VARBINARY",
    },
    standsAlone: ["varchar", "varbinary", "timestamp", "timestamp without time zone", "timestamp with time zone"],
    bareSpelling: NO_BARE_SPELLING,
    typeVocabulary: STANDARD_TYPE_VOCABULARY,
    // Trino measured on 476: `SELECT typeof(X'0102')` answers `varbinary`,
    // `to_hex(X'0102deadbeef')` answers `0102DEADBEEF`, `length(X'')` answers 0, and the
    // whole generated pair replays into the memory connector.
    binaryLiteral: binaryStandardHex,
    nonFinite: NULL_NON_FINITE,
    insertForm: "values",
    typedLiteral: trinoLiteral,
  },
};
