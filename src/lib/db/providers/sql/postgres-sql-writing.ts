import {
  EXACT_DECIMAL_TYPE_NAMES,
  FLOAT64_TYPE_NAMES,
  identifierDoubleQuoted,
  INSTANT_TYPE_NAMES,
  literalStandard,
  placeholderDollar,
  QUOTED_WORD_NON_FINITE,
  STANDARD_TYPE_VOCABULARY,
  unquoteStandard,
} from "@/lib/db/sql-writing/shared";
import { binaryPgBytea } from "@/lib/db/sql-writing/export-shared";
import { postgresLiteral } from "./postgres-typed-literals";
import type { SqlWritingSpec } from "@/lib/db/sql-writing/types";

/** How a generated statement spells a literal, a name and a bind for PostgreSQL. */
export const POSTGRES_SQL_WRITING: SqlWritingSpec = {
  // `standard_conforming_strings` has been on by default since PostgreSQL 9.1, so
  // a backslash in a plain literal is data.
  escapeLiteral: literalStandard,
  unescapeLiteral: unquoteStandard,
  // The SQL standard form.
  quoteIdentifier: identifierDoubleQuoted,
  // `pg` takes `$n`.
  placeholder: placeholderDollar,
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
      numeric: "DOUBLE PRECISION",
      boolean: "BOOLEAN",
      timestamp: "TIMESTAMP",
      binary: "BYTEA",
    },
    standsAlone: [
      "character varying",
      "varchar",
      "text",
      "bytea",
      "numeric",
      "decimal",
      "money",
      "timestamp",
      "timestamp without time zone",
      "timestamp with time zone",
    ],
    // `pg` hands a bit string back as text such as `1010`, which a bare `bit` (`bit(1)`) refuses
    // with `bit string length 4 does not match type bit(1)`, and `bit varying` takes at any length
    // (#1386).
    bareSpelling: { bit: "bit varying" },
    typeVocabulary: STANDARD_TYPE_VOCABULARY,
    binaryLiteral: binaryPgBytea,
    nonFinite: QUOTED_WORD_NON_FINITE,
    insertForm: "values",
    typedLiteral: postgresLiteral,
  },
};
