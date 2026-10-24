import {
  EXACT_DECIMAL_TYPE_NAMES,
  FLOAT64_TYPE_NAMES,
  identifierDoubleQuoted,
  INSTANT_TYPE_NAMES,
  literalStandard,
  NO_BARE_SPELLING,
  NOTHING_STANDS_ALONE,
  NULL_NON_FINITE,
  STANDARD_DDL_TYPES,
  STANDARD_TYPE_VOCABULARY,
  unquoteStandard,
} from "@/lib/db/sql-writing/shared";
import { binaryStandardHex } from "@/lib/db/sql-writing/export-shared";
import type { SqlWritingSpec } from "@/lib/db/sql-writing/types";

/** How a generated statement spells a literal, a name and a bind for Weaviate. */
export const WEAVIATE_SQL_WRITING: SqlWritingSpec = {
  // This engine declares `queryLanguage: "json"`, so no statement is ever built for it to
  // read. What a generator emits for such a connection is portable SQL meant to run elsewhere,
  // and the standard form is the only thing it can claim.
  escapeLiteral: literalStandard,
  unescapeLiteral: unquoteStandard,
  // The SQL standard form, which this engine's generators fall back to.
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
    // This engine declares `queryLanguage: "json"`, so no statement is ever built for it to
    // read, and the standard form is the only thing an export can claim (as for its literal).
    binaryLiteral: binaryStandardHex,
    nonFinite: NULL_NON_FINITE,
    insertForm: "values",
  },
};
