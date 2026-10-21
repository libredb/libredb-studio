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
  STANDARD_DDL_TYPES,
  STANDARD_TYPE_VOCABULARY,
  unquoteStandard,
} from "@/lib/db/sql-writing/shared";
import { binaryStandardHex } from "@/lib/db/sql-writing/export-shared";
import type { SqlWritingSpec } from "@/lib/db/sql-writing/types";

/** How a generated statement spells a literal, a name and a bind for Druid. */
export const DRUID_SQL_WRITING: SqlWritingSpec = {
  // Druid quotes a string with single quotes and puts its backslash escapes in the
  // separate `U&'fo\00F6'` form, so a backslash in a plain literal is data.
  escapeLiteral: literalStandard,
  unescapeLiteral: unquoteStandard,
  // The SQL standard form.
  quoteIdentifier: identifierDoubleQuoted,
  // Druid binds a `parameters` array against `?`, live-verified when the
  // provider was written (`src/lib/db/providers/sql/druid/index.ts`).
  placeholder: placeholderQuestion,
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
    // Druid is the one row here
    // that is NOT measured: its SQL is Calcite's, which spells a binary literal `X'…'`,
    // and a standalone Druid takes no INSERT at all (that needs the MSQ extension), so
    // what is emitted for it is portable SQL meant to run elsewhere.
    binaryLiteral: binaryStandardHex,
    nonFinite: NULL_NON_FINITE,
    insertForm: "values",
  },
};
