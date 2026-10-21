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

/** How a generated statement spells a literal, a name and a bind for Modbus. */
export const MODBUS_SQL_WRITING: SqlWritingSpec = {
  // No generator calls `quoteLiteral` for Modbus either: a read request is JSON and names points.
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
    // A read request names points of a map, not rows: nothing it produces stands alone as a statement.
    standsAlone: NOTHING_STANDS_ALONE,
    bareSpelling: NO_BARE_SPELLING,
    typeVocabulary: STANDARD_TYPE_VOCABULARY,
    // Raw words are shown as hex by the provider itself; the inert default, as MTConnect's.
    binaryLiteral: binaryStandardHex,
    nonFinite: NULL_NON_FINITE,
    insertForm: "values",
  },
};
