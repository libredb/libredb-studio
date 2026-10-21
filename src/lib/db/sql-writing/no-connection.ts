import { binaryStandardHex } from "./export-shared";
import {
  EXACT_DECIMAL_TYPE_NAMES,
  FLOAT64_TYPE_NAMES,
  INSTANT_TYPE_NAMES,
  identifierDoubleQuoted,
  literalStandard,
  unquoteStandard,
  NO_BARE_SPELLING,
  NOTHING_STANDS_ALONE,
  NULL_NON_FINITE,
  STANDARD_DDL_TYPES,
  STANDARD_TYPE_VOCABULARY,
} from "./shared";
import type { SqlWritingSpec } from "./types";

/**
 * What a generator with no connection to name an engine writes.
 *
 * It gets the standard literal, matching the standard identifier quoting such a generator
 * already emits: doubling the backslash there would corrupt the value on every dialect that
 * reads it as data, which is the larger group. A generator with no connection to name one
 * can claim only the standard.
 */
export const NO_CONNECTION_SQL_WRITING: SqlWritingSpec = {
  escapeLiteral: literalStandard,
  unescapeLiteral: unquoteStandard,
  quoteIdentifier: identifierDoubleQuoted,
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
    binaryLiteral: binaryStandardHex,
    nonFinite: NULL_NON_FINITE,
    insertForm: "values",
  },
};
