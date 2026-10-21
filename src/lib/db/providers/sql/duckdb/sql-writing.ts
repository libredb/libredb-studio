import {
  EXACT_DECIMAL_TYPE_NAMES,
  FLOAT64_TYPE_NAMES,
  identifierDoubleQuoted,
  INSTANT_TYPE_NAMES,
  literalStandard,
  NO_BARE_SPELLING,
  placeholderQuestion,
  QUOTED_WORD_NON_FINITE,
  STANDARD_DDL_TYPES,
  STANDARD_TYPE_VOCABULARY,
  unquoteStandard,
} from "@/lib/db/sql-writing/shared";
import { binaryUnhex } from "@/lib/db/sql-writing/export-shared";
import { duckdbLiteral } from "./typed-literals";
import type { SqlWritingSpec } from "@/lib/db/sql-writing/types";

/** How a generated statement spells a literal, a name and a bind for DuckDB. */
export const DUCKDB_SQL_WRITING: SqlWritingSpec = {
  // Measured on DuckDB v1.5.5, both directions: `SELECT 'it''s'` answers `it's`, and
  // `SELECT 'a\b', length('a\b')` answers the three characters `a\b` - so a backslash
  // is data, and doubling it would add a second one to the value.
  escapeLiteral: literalStandard,
  unescapeLiteral: unquoteStandard,
  // The SQL standard form. Measured on v1.5.5: `"quoted identifier"` works, and `[…]` is a
  // LIST literal here rather than a name quote, so the bracket form would be wrong for it.
  quoteIdentifier: identifierDoubleQuoted,
  // DuckDB binds BOTH forms - measured on v1.5.5, `runAndReadAll("SELECT ?::INTEGER
  // AS a, ?::VARCHAR AS b", [7, "x"])` and `runAndReadAll("SELECT $1::INTEGER AS a",
  // [9])` each answer - so this is a choice rather than a reading, and `?` is the one
  // taken. `$` is overloaded in this dialect: `$tag$…$tag$` is a dollar-quoted string
  // literal (measured), so a `$1` written into a generated statement sits one
  // character away from a form the readers in this folder have to tell apart, while
  // `?` has no second meaning anywhere in DuckDB's grammar. It also matches the
  // positional ORDER the driver binds by, which is the array's, not the digit's.
  placeholder: placeholderQuestion,
  temporalLiteral: null,
  inlineEdit: {
    instantTypeNames: INSTANT_TYPE_NAMES,
    exactDecimalTypeNames: EXACT_DECIMAL_TYPE_NAMES,
    float64TypeNames: FLOAT64_TYPE_NAMES,
  },
  export: {
    ddlTypes: STANDARD_DDL_TYPES,
    // Measured on DuckDB v1.5.5, one `CREATE TABLE probe (c <name>)` per name read back
    // out of `duckdb_columns().data_type`. Every name here resolved to an UNNARROWED
    // type - the seven text spellings to `VARCHAR`, the four byte ones to `BLOB`, the
    // four moment ones to `TIMESTAMP` (and `TIMESTAMP WITH TIME ZONE` to itself).
    //
    // `numeric` and `decimal` are the absences that matter: DuckDB accepts both and
    // stores `DECIMAL(18,3)`, which rounds away every value past the third decimal the
    // column existed for - the same silent narrowing MySQL's bare `decimal` does. They
    // are therefore re-spelled from their family rather than kept.
    standsAlone: [
      "character varying",
      "varchar",
      "nvarchar",
      "character",
      "char",
      "nchar",
      "text",
      "binary",
      "varbinary",
      "blob",
      "bytea",
      "timestamp",
      "timestamp without time zone",
      "timestamp with time zone",
      "datetime",
    ],
    bareSpelling: NO_BARE_SPELLING,
    typeVocabulary: STANDARD_TYPE_VOCABULARY,
    // `unhex`, and NOT `standard-hex` even though DuckDB is Postgres-shaped everywhere
    // else in this file. Measured on v1.5.5: `X'0102'` is not a binary literal at all -
    // `SELECT typeof(X'0102')` answers `VARCHAR` and `SELECT X'0102'` answers the five
    // characters `x0102`, so the standard spelling PARSES and writes text where bytes
    // belong. `unhex('0102deadbeef')` answers a real `BLOB`, and the generated pair
    // replays: inserted into a `BLOB` column it reads back as `hex(payload)` =
    // `0102DEADBEEF` with `octet_length(payload)` 6, and `unhex('')` inserts the
    // zero-length blob (`octet_length` 0). `0x0102` is a parser error here.
    binaryLiteral: binaryUnhex,
    nonFinite: QUOTED_WORD_NON_FINITE,
    insertForm: "values",
    typedLiteral: duckdbLiteral,
  },
};
