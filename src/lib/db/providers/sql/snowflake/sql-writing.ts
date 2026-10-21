import {
  EXACT_DECIMAL_TYPE_NAMES,
  FLOAT64_TYPE_NAMES,
  identifierDoubleQuoted,
  INSTANT_TYPE_NAMES,
  literalDoubleAndBackslash,
  NO_BARE_SPELLING,
  NOTHING_STANDS_ALONE,
  STANDARD_TYPE_VOCABULARY,
  unquoteDoubleAndBackslash,
} from "@/lib/db/sql-writing/shared";
import { binaryStandardHex } from "@/lib/db/sql-writing/export-shared";
import { snowflakeLiteral, snowflakeVectorDeclaration } from "./typed-literals";
import type { SqlWritingSpec } from "@/lib/db/sql-writing/types";

/** How a generated statement spells a literal, a name and a bind for Snowflake. */
export const SNOWFLAKE_SQL_WRITING: SqlWritingSpec = {
  // Snowflake reads both escapes in a single-quoted string constant: a doubled quote is one quote, and a backslash
  // escapes the next character, so it is doubled first, as Databend's is.
  escapeLiteral: literalDoubleAndBackslash,
  unescapeLiteral: unquoteDoubleAndBackslash,
  quoteIdentifier: identifierDoubleQuoted,
  placeholder: null,
  temporalLiteral: null,
  inlineEdit: {
    instantTypeNames: INSTANT_TYPE_NAMES,
    exactDecimalTypeNames: EXACT_DECIMAL_TYPE_NAMES,
    float64TypeNames: FLOAT64_TYPE_NAMES,
  },
  export: {
    // Snowflake's float type is FLOAT and its byte type BINARY; it has no BLOB. Provisional until a replay on an account.
    ddlTypes: {
      text: "TEXT",
      integer: "BIGINT",
      numeric: "FLOAT",
      boolean: "BOOLEAN",
      timestamp: "TIMESTAMP",
      binary: "BINARY",
    },
    // Not measured: no Snowflake account read a probe column back for this change, so every bare name is re-spelled
    // portably until one does.
    standsAlone: NOTHING_STANDS_ALONE,
    bareSpelling: NO_BARE_SPELLING,
    typeVocabulary: STANDARD_TYPE_VOCABULARY,
    // Snowflake reads `X'0102deadbeef'` as a BINARY constant, the standard form; not yet measured on an account.
    binaryLiteral: binaryStandardHex,
    // Snowflake's trial setup (2026-10-12) created its FLOAT infinities with `'inf'::FLOAT` and `'-inf'::FLOAT`, and
    // `'NaN'::FLOAT` is the same documented form.
    nonFinite: { NaN: "'NaN'::FLOAT", Infinity: "'inf'::FLOAT", "-Infinity": "'-inf'::FLOAT" },
    // Snowflake's `INSERT ... VALUES` refuses `PARSE_JSON`, which its semi-structured cells are written with
    // (`typed-literals.ts`), so every Snowflake row takes the SELECT form. Provisional until a replay on an account
    // confirms it.
    insertForm: "select",
    typedLiteral: snowflakeLiteral,
    declareFromSample: (declared, sample) =>
      declared.trim().toUpperCase() === "VECTOR" ? snowflakeVectorDeclaration(sample) : undefined,
  },
};
