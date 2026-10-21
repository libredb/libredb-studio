import {
  EXACT_DECIMAL_TYPE_NAMES,
  FLOAT64_TYPE_NAMES,
  identifierBacktickBackslash,
  INSTANT_TYPE_NAMES,
  literalBackslash,
  NO_BARE_SPELLING,
  NOTHING_STANDS_ALONE,
  NULL_NON_FINITE,
  STANDARD_DDL_TYPES,
  STANDARD_TYPE_VOCABULARY,
  unquoteBackslash,
} from "@/lib/db/sql-writing/shared";
import { binaryTextBackslash } from "@/lib/db/sql-writing/export-shared";
import type { SqlWritingSpec } from "@/lib/db/sql-writing/types";

/** How a generated statement spells a literal, a name and a bind for BigQuery. */
export const BIGQUERY_SQL_WRITING: SqlWritingSpec = {
  // GoogleSQL escapes the quote as \\' and does not accept doubling.
  escapeLiteral: literalBackslash,
  unescapeLiteral: unquoteBackslash,
  // GoogleSQL quotes a name in backticks and escapes inside it with a backslash; a doubled
  // backtick is not an escape there, it ends the name.
  quoteIdentifier: identifierBacktickBackslash,
  placeholder: null,
  temporalLiteral: null,
  inlineEdit: {
    instantTypeNames: INSTANT_TYPE_NAMES,
    exactDecimalTypeNames: EXACT_DECIMAL_TYPE_NAMES,
    float64TypeNames: FLOAT64_TYPE_NAMES,
  },
  export: {
    ddlTypes: STANDARD_DDL_TYPES,
    standsAlone: NOTHING_STANDS_ALONE,
    bareSpelling: NO_BARE_SPELLING,
    typeVocabulary: STANDARD_TYPE_VOCABULARY,
    binaryLiteral: binaryTextBackslash,
    nonFinite: NULL_NON_FINITE,
    insertForm: "values",
  },
};
