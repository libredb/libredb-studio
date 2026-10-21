import { binaryStandardHex } from "./export-shared";
import {
  EXACT_DECIMAL_TYPE_NAMES,
  FLOAT64_TYPE_NAMES,
  INSTANT_TYPE_NAMES,
  identifierDoubleQuoted,
  literalDoubleAndBackslash,
  unquoteDoublingOnly,
  NO_BARE_SPELLING,
  NOTHING_STANDS_ALONE,
  NULL_NON_FINITE,
  STANDARD_DDL_TYPES,
  STANDARD_TYPE_VOCABULARY,
} from "./shared";
import type { SqlWritingSpec } from "./types";

/**
 * What a string outside the `DatabaseType` union gets, which is what it got before the
 * registry (spec 2.3): `QuerySafetyDialog` takes `databaseType?: string`, so such a string
 * does reach a reader.
 *
 * A literal doubles both the quote and the backslash, because no table row named the string
 * and the old writer fell through to that branch; a literal is read back with doubling only;
 * a name gets the standard quoting; and there is no placeholder or temporal form.
 */
export const UNKNOWN_TYPE_SQL_WRITING: SqlWritingSpec = {
  escapeLiteral: literalDoubleAndBackslash,
  unescapeLiteral: unquoteDoublingOnly,
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
