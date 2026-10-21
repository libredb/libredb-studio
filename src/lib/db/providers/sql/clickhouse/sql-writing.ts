import {
  EXACT_DECIMAL_TYPE_NAMES,
  FLOAT64_TYPE_NAMES,
  identifierDoubleQuoted,
  INSTANT_TYPE_NAMES,
  literalDoubleAndBackslash,
  NO_BARE_SPELLING,
  STANDARD_TYPE_VOCABULARY,
  unquoteDoubleAndBackslash,
} from "@/lib/db/sql-writing/shared";
import { binaryUnhex } from "@/lib/db/sql-writing/export-shared";
import { clickhouseLiteral } from "./typed-literals";
import type { SqlWritingSpec } from "@/lib/db/sql-writing/types";

/** How a generated statement spells a literal, a name and a bind for ClickHouse. */
export const CLICKHOUSE_SQL_WRITING: SqlWritingSpec = {
  // Matches what the ClickHouse provider already does when it builds its own
  // literals (`src/lib/db/providers/sql/clickhouse/index.ts`).
  escapeLiteral: literalDoubleAndBackslash,
  unescapeLiteral: unquoteDoubleAndBackslash,
  // The SQL standard form.
  quoteIdentifier: identifierDoubleQuoted,
  // ClickHouse binds named parameters only and its provider refuses positional ones outright.
  placeholder: null,
  temporalLiteral: null,
  inlineEdit: {
    instantTypeNames: INSTANT_TYPE_NAMES,
    exactDecimalTypeNames: EXACT_DECIMAL_TYPE_NAMES,
    float64TypeNames: FLOAT64_TYPE_NAMES,
  },
  export: {
    // ClickHouse has no BLOB: its byte container IS `String`, which is a byte sequence
    // and not a text encoding, and `unhex` (the literal below) returns exactly that.
    // Measured on 26.7.1, the other four standard spellings all resolve to a whole type
    // (`TEXT` -> `String`, `BIGINT` -> `Int64`, `DOUBLE PRECISION` -> `Float64`,
    // `TIMESTAMP` -> `DateTime`), so ClickHouse needs no row of its own for them.
    ddlTypes: {
      text: "TEXT",
      integer: "BIGINT",
      numeric: "DOUBLE PRECISION",
      boolean: "BOOLEAN",
      timestamp: "TIMESTAMP",
      binary: "String",
    },
    standsAlone: [
      "character varying",
      "varchar",
      "varchar2",
      "nvarchar",
      "character",
      "char",
      "nchar",
      "text",
      "tinytext",
      "mediumtext",
      "longtext",
      "clob",
      "varbinary",
      "blob",
      "tinyblob",
      "mediumblob",
      "longblob",
      "bytea",
      "timestamp",
      "datetime",
      "year",
    ],
    bareSpelling: NO_BARE_SPELLING,
    typeVocabulary: STANDARD_TYPE_VOCABULARY,
    // Measured on 26.7.1: `unhex('0102deadbeef')` into a `String` column reads back as
    // `hex(payload)` = `0102DEADBEEF` with `length(payload)` 6, and `length(unhex(''))`
    // is 0.
    binaryLiteral: binaryUnhex,
    // ClickHouse 26.9.18.11 read the bare `nan`, `inf` and `-inf` back into `Float64` and `Float32` (2026-10-14).
    nonFinite: { NaN: "nan", Infinity: "inf", "-Infinity": "-inf" },
    insertForm: "values",
    typedLiteral: clickhouseLiteral,
  },
};
