import {
  EXACT_DECIMAL_TYPE_NAMES,
  FLOAT64_TYPE_NAMES,
  identifierDoubleQuoted,
  INSTANT_TYPE_NAMES,
  literalStandard,
  NO_BARE_SPELLING,
  NOTHING_STANDS_ALONE,
  NULL_NON_FINITE,
  placeholderQuestion,
  STANDARD_TYPE_VOCABULARY,
  unquoteStandard,
} from "@/lib/db/sql-writing/shared";
import { binaryBinaryHex } from "@/lib/db/sql-writing/export-shared";
import type { SqlWritingSpec } from "@/lib/db/sql-writing/types";

/** How a generated statement spells a literal, a name and a bind for Db2. */
export const DB2_SQL_WRITING: SqlWritingSpec = {
  // Measured on Db2 LUW 12.1.0.0 through db2-node 1.0.22 (#786), both directions: `VALUES
  // 'O''Brien'` answers `O'Brien`, and `VALUES 'a\b'` answers the three characters `a\b` with
  // `LENGTH` 3, so a backslash is data.
  escapeLiteral: literalStandard,
  unescapeLiteral: unquoteStandard,
  quoteIdentifier: identifierDoubleQuoted,
  // db2-node binds a params array against `?`, measured on Db2 LUW 12.1.0.0 (#786).
  placeholder: placeholderQuestion,
  temporalLiteral: null,
  inlineEdit: {
    instantTypeNames: INSTANT_TYPE_NAMES,
    exactDecimalTypeNames: EXACT_DECIMAL_TYPE_NAMES,
    float64TypeNames: FLOAT64_TYPE_NAMES,
  },
  export: {
    // Db2 has no TEXT: measured on 12.1.0.0, `CREATE TABLE ... (c TEXT)` is SQL0204N `"TEXT" is an
    // undefined name`, while BIGINT, DOUBLE PRECISION, BOOLEAN, TIMESTAMP and BLOB are whole types.
    // CLOB, the unbounded character type, rather than a VARCHAR whose bound a cell could pass (#786).
    ddlTypes: {
      text: "CLOB",
      integer: "BIGINT",
      numeric: "DOUBLE PRECISION",
      boolean: "BOOLEAN",
      timestamp: "TIMESTAMP",
      binary: "BLOB",
    },
    // No name was measured standing alone on Db2 in its first version (#786), so every bare name is
    // re-spelled from its family.
    standsAlone: NOTHING_STANDS_ALONE,
    bareSpelling: NO_BARE_SPELLING,
    typeVocabulary: STANDARD_TYPE_VOCABULARY,
    // Measured on Db2 LUW 12.1.0.0 (#786): `INSERT … VALUES (X'0102deadbeef')` into a `BLOB` or a
    // `VARBINARY` column is SQL0408N, "a value is not compatible with the data type of its
    // assignment target", because `X'…'` is a character string here. `BX'0102deadbeef'` goes into
    // `BLOB`, `VARBINARY` and `VARCHAR FOR BIT DATA` alike, reading back as `HEX(…)` =
    // `0102DEADBEEF`, and `BX''` inserts the zero-length value into all three.
    binaryLiteral: binaryBinaryHex,
    nonFinite: NULL_NON_FINITE,
    insertForm: "values",
  },
};
