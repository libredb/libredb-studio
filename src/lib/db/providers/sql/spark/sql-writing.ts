import {
  EXACT_DECIMAL_TYPE_NAMES,
  FLOAT64_TYPE_NAMES,
  identifierBacktickDoubled,
  INSTANT_TYPE_NAMES,
  literalBackslash,
  NO_BARE_SPELLING,
  NOTHING_STANDS_ALONE,
  STANDARD_TYPE_VOCABULARY,
  unquoteBackslash,
} from "@/lib/db/sql-writing/shared";
import { binaryStandardHex } from "@/lib/db/sql-writing/export-shared";
import { sparkLiteral } from "./typed-literals";
import type { SqlWritingSpec } from "@/lib/db/sql-writing/types";

/** How a generated statement spells a literal, a name and a bind for Spark. */
export const SPARK_SQL_WRITING: SqlWritingSpec = {
  // Spark's lexer pairs a backslash with the next character inside '...' under every setting, so the quote is written
  // \' as Spark's own Literal.sql writes it; a doubled quote is an escape only from 4.1, so it is not used.
  escapeLiteral: literalBackslash,
  unescapeLiteral: unquoteBackslash,
  // Spark SQL (4.1 and 4.2) quotes a name in backticks and doubles a backtick inside it, the form its own
  // quoteIfNeeded writes; a double-quoted text is a string literal in Spark, so the standard form
  // would turn a name into a string. Names are case-insensitive there, so quoting never changes which object a
  // name means.
  quoteIdentifier: identifierBacktickDoubled,
  placeholder: null,
  temporalLiteral: null,
  inlineEdit: {
    instantTypeNames: INSTANT_TYPE_NAMES,
    exactDecimalTypeNames: EXACT_DECIMAL_TYPE_NAMES,
    float64TypeNames: FLOAT64_TYPE_NAMES,
  },
  export: {
    // Spark SQL has no TEXT, DOUBLE PRECISION or BLOB: its spellings are STRING, DOUBLE and BINARY.
    ddlTypes: {
      text: "STRING",
      integer: "BIGINT",
      numeric: "DOUBLE",
      boolean: "BOOLEAN",
      timestamp: "TIMESTAMP",
      binary: "BINARY",
    },
    // Not measured: no Spark server read a probe column back for this change, so every bare name is re-spelled portably
    // until one does.
    standsAlone: NOTHING_STANDS_ALONE,
    bareSpelling: NO_BARE_SPELLING,
    typeVocabulary: STANDARD_TYPE_VOCABULARY,
    // Spark reads `X'0102deadbeef'` as a BINARY literal, the standard form.
    binaryLiteral: binaryStandardHex,
    // Spark reads the three words through a CAST to DOUBLE, its documented special floating-point values.
    nonFinite: {
      NaN: "CAST('NaN' AS DOUBLE)",
      Infinity: "CAST('Infinity' AS DOUBLE)",
      "-Infinity": "CAST('-Infinity' AS DOUBLE)",
    },
    insertForm: "values",
    typedLiteral: sparkLiteral,
  },
};
