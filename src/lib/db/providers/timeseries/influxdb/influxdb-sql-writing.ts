import {
  EXACT_DECIMAL_TYPE_NAMES,
  FLOAT64_TYPE_NAMES,
  identifierDoubleQuoted,
  INSTANT_TYPE_NAMES,
  literalBackslash,
  NO_BARE_SPELLING,
  NOTHING_STANDS_ALONE,
  NULL_NON_FINITE,
  STANDARD_DDL_TYPES,
  STANDARD_TYPE_VOCABULARY,
  unquoteBackslash,
} from "@/lib/db/sql-writing/shared";
import { binaryStandardHex } from "@/lib/db/sql-writing/export-shared";
import type { SqlWritingSpec } from "@/lib/db/sql-writing/types";

/** How a generated statement spells a literal, a name and a bind for InfluxDB 1.x. */
export const INFLUXDB_SQL_WRITING: SqlWritingSpec = {
  // Measured on InfluxDB 1.13.1: `... WHERE room = 'it\'s'` parses and `... WHERE room = 'it''s'`
  // is `error parsing query: found s, expected ;`; the scanner's string escapes are exactly `\n`,
  // `\\`, `\"` and `\'`. No generator calls `quoteLiteral` for InfluxQL: the provider's
  // `influxql-quote.ts` builds every literal and refuses a newline, which a backslash form cannot
  // carry. The row is the true answer for any future caller.
  escapeLiteral: literalBackslash,
  unescapeLiteral: unquoteBackslash,
  // The SQL standard form, which this engine's generators fall back to.
  quoteIdentifier: identifierDoubleQuoted,
  // InfluxQL is not SQL, and nothing binds there.
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
    // InfluxQL, not SQL: it has no INSERT and no byte literal, so no statement is built for it either.
    binaryLiteral: binaryStandardHex,
    nonFinite: NULL_NON_FINITE,
    insertForm: "values",
  },
};
