import {
  EXACT_DECIMAL_TYPE_NAMES,
  FLOAT64_TYPE_NAMES,
  identifierBacktickDoubled,
  INSTANT_TYPE_NAMES,
  literalDoubleAndBackslash,
  NO_BARE_SPELLING,
  STANDARD_TYPE_VOCABULARY,
  unquoteDoubleAndBackslash,
} from "@/lib/db/sql-writing/shared";
import { binaryUnhex } from "@/lib/db/sql-writing/export-shared";
import { databendLiteral } from "./typed-literals";
import type { SqlWritingSpec } from "@/lib/db/sql-writing/types";

/** How a generated statement spells a literal, a name and a bind for Databend. */
export const DATABEND_SQL_WRITING: SqlWritingSpec = {
  // Databend reads both escapes in a single-quoted string in every one of its five `sql_dialect`s: a doubled quote
  // is one quote and a backslash escapes the next character, so it is doubled first (design 5.1). The live round
  // trip of the escaping corpus, `INSERT ... VALUES` included, passed on the pinned image (L4).
  escapeLiteral: literalDoubleAndBackslash,
  unescapeLiteral: unquoteDoubleAndBackslash,
  // Databend reads a backtick name in all five of its `sql_dialect`s, the default
  // PostgreSQL one included, and a doubled backtick is the only escape inside it: the
  // lexer rule has no backslash form, so `x\` is the name `x\`. Measured on the pinned
  // image (probe L4): names holding a backtick, a backslash, a quote, `;`, `--`, a
  // newline or a NUL round-trip byte-equal through CREATE TABLE, INSERT and SELECT
  // under both dialects. A bare name would be folded to lower case there, which is why
  // the provider quotes every name rather than only the ones that need it.
  quoteIdentifier: identifierBacktickDoubled,
  placeholder: null,
  temporalLiteral: null,
  inlineEdit: {
    instantTypeNames: INSTANT_TYPE_NAMES,
    exactDecimalTypeNames: EXACT_DECIMAL_TYPE_NAMES,
    float64TypeNames: FLOAT64_TYPE_NAMES,
  },
  export: {
    // Databend's measured spellings (design 7.2, X01): M08a created `VARCHAR`, `DOUBLE` and `BINARY` columns on the
    // pinned image and M08c read them back as `String`, `Float64` and `Binary`, unbounded. The standard `TEXT`,
    // `DOUBLE PRECISION` and `BLOB` were not measured there. `BIGINT`, `BOOLEAN` and `TIMESTAMP` were, as they are.
    ddlTypes: {
      text: "VARCHAR",
      integer: "BIGINT",
      numeric: "DOUBLE",
      boolean: "BOOLEAN",
      timestamp: "TIMESTAMP",
      binary: "BINARY",
    },
    // Measured by M08a and M08c on the pinned image: each was created and read back unbounded (`String`, `Timestamp`
    // with microseconds, `Binary`). Every other bare name is re-spelled from its family (design 7.2, X01).
    standsAlone: ["varchar", "timestamp", "binary"],
    // Databend has no row (design 7.2, X01): its `Timestamp` keeps microseconds without a precision and its `Decimal`
    // always carries its own, so no bare name it reports narrows the value its INSERT writes back.
    bareSpelling: NO_BARE_SPELLING,
    typeVocabulary: STANDARD_TYPE_VOCABULARY,
    // Databend reads a quoted string into BINARY through `binary_input_format`, utf-8 by default, so the standard
    // `X'…'` was not its measured spelling: M08b inserted `unhex('00ff10')` on the pinned image and M08c read back the
    // three bytes as `00FF10` (design 7.2, X01).
    binaryLiteral: binaryUnhex,
    // Databend (M08b, on the pinned image) inserted `'NaN'::FLOAT`, `'inf'::DOUBLE` and `'-inf'::FLOAT` into its
    // `FLOAT` and `DOUBLE` columns and read back NaN, Infinity and -Infinity.
    nonFinite: { NaN: "'NaN'::FLOAT", Infinity: "'inf'::DOUBLE", "-Infinity": "'-inf'::FLOAT" },
    insertForm: "values",
    typedLiteral: databendLiteral,
    // No `rewriteDeclared` (design 7.2, X01): its declared types are written as its query schema spells them
    // (`Nullable(Array(Int32 NULL))`), and the every-type replay of the provider's local pass is what proves or refutes
    // that spelling in a CREATE TABLE.
  },
};
