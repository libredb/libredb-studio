import { binaryZeroX, normalized } from "@/lib/db/sql-writing/export-shared";
import {
  EXACT_DECIMAL_TYPE_NAMES,
  firstWord,
  FLOAT64_TYPE_NAMES,
  identifierBracket,
  INSTANT_TYPE_NAMES,
  literalUnicode,
  NO_BARE_SPELLING,
  NULL_NON_FINITE,
  placeholderAtP,
  STANDARD_TYPE_VOCABULARY,
  unquoteUnicode,
  unwrappedType,
} from "@/lib/db/sql-writing/shared";
import type { SqlWritingSpec, TypedWriter } from "@/lib/db/sql-writing/types";

/**
 * The text the provider reads a `datetime` and a `smalldatetime` as (#1452): the engine's own.
 * The inline grid edit (`use-inline-editing.ts`) binds it with a `T` for the same reason the
 * SQL INSERT export (`mssqlLiteral` below) writes it with one.
 */
const MSSQL_DATETIME_TEXT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,3})?$/;

/**
 * The SQL Server types that read `yyyy-mm-dd hh:mi:ss` through the session's DATEFORMAT.
 * `datetime2` and `date` read it the same under every DATEFORMAT, so they are not here.
 */
const MSSQL_DATEFORMAT_TYPES: ReadonlySet<string> = new Set(["datetime", "smalldatetime"]);

/**
 * T-SQL has no boolean literal: `true` parses as a column name (`Msg 207: Invalid column
 * name 'true'`, measured on SQL Server 2025 17.0.5005.3) and fails the whole batch. A BIT
 * takes `1` and `0`, and `mssql` hands a BIT back as a JS boolean.
 *
 * A `datetime` or `smalldatetime` cell is the engine's own `yyyy-mm-dd hh:mi:ss[.mmm]` text
 * (#1452), and unlike `datetime2` and `date`, those two types read that form through the
 * session's DATEFORMAT. Measured on SQL Server 2022 CU27 (16.0.4295.3): under `british`,
 * `Deutsch` and `Français` (dmy) `'2026-10-04 12:34:56.123'` is stored as April 10th and
 * `'2026-10-25 …'` is refused, while `'2026-10-04T12:34:56.123'` is October 4th under those
 * and under `us_english` and `Japanese`. So the text goes out with its space as a `T`.
 */
const mssqlLiteral: TypedWriter = (value, declared) => {
  if (typeof value === "boolean") return value ? "1" : "0";
  const type = normalized(declared);
  if (
    (type === "datetime" || type === "smalldatetime") &&
    typeof value === "string" &&
    MSSQL_DATETIME_TEXT.test(value)
  ) {
    return literalUnicode(value.replace(" ", "T"));
  }
  return undefined;
};

/** How a generated statement spells a literal, a name and a bind for SQL Server. */
export const MSSQL_SQL_WRITING: SqlWritingSpec = {
  // SQL Server parses a BARE literal in the database's collation code page and only an
  // `N`-prefixed one as Unicode, so the prefix is not decoration: every catalog name in
  // `sys` is `sysname`, which is `nvarchar(128)`.
  // Measured on SQL Server 2022 CU26, database AdventureWorks2022, collation
  // `SQL_Latin1_General_CP1_CI_AS` (code page 1252), with schemas `Müşteri` and `Müsteri`
  // both present: `SELECT 'Müşteri'` answers `Müsteri`, because `ş` (U+015F) is not in
  // 1252 and the server best-fits it to `s`. So `… WHERE s.name = 'Müşteri'` matched
  // `Müsteri.Siparis` - THE WRONG OBJECT - while `… WHERE s.name = N'Müşteri'` matched
  // `Müşteri.Sipariş`. With no `Müsteri` present the bare form matched nothing at all.
  // Both failures are silent, which is why this dialect does not share the `standard`
  // row: the escaping is the same, the code page is not.
  escapeLiteral: literalUnicode,
  unescapeLiteral: unquoteUnicode,
  quoteIdentifier: identifierBracket,
  // The mssql provider registers its inputs as `p1`, `p2`, … which the statement spells `@p1`, `@p2`.
  placeholder: placeholderAtP,
  temporalLiteral: null,
  inlineEdit: {
    instantTypeNames: INSTANT_TYPE_NAMES,
    exactDecimalTypeNames: EXACT_DECIMAL_TYPE_NAMES,
    float64TypeNames: FLOAT64_TYPE_NAMES,
    /**
     * The edited text as it is bound: as typed, except the one form SQL Server reads by DATEFORMAT.
     *
     * The provider reads a `datetime` and a `smalldatetime` as the engine's own
     * `yyyy-mm-dd hh:mi:ss[.mmm]` text (#1452), and the grid opens its editor on that text. Bound
     * as it is, the nvarchar parameter reaches those two columns through the session's DATEFORMAT.
     * MEASURED 2026-10-12 on SQL Server 2022 CU27 (16.0.4295.3), this hook's own `UPDATE ... SET
     * [dt] = @p1` in a session under `british`: `2026-10-04 12:34:57.123` was stored as April 10th
     * and `2026-10-25 23:59:58.997` was refused as out of range, while the same text with a `T`
     * was stored as written, and a `smalldatetime` the same. This provider's own sessions read
     * `mdy` today - tedious opens each one with `set dateformat mdy` and `set language
     * us_english`, and a `SET LANGUAGE` a user runs ends with its own `sp_executesql` call - so the
     * `T` keeps the edit from leaning on that driver default, the way the SQL INSERT export does
     * (`mssqlLiteral` above). Text in any other shape is bound as typed.
     */
    boundEdit: (text, declaredType, bind) =>
      declaredType !== undefined &&
      MSSQL_DATEFORMAT_TYPES.has(firstWord(unwrappedType(declaredType))) &&
      MSSQL_DATETIME_TEXT.test(text)
        ? bind(text.replace(" ", "T"))
        : undefined,
  },
  export: {
    ddlTypes: {
      text: "NVARCHAR(MAX)",
      integer: "BIGINT",
      numeric: "FLOAT",
      boolean: "BIT",
      timestamp: "DATETIME2",
      // `BLOB` is not a T-SQL type name at all, and `IMAGE` has been deprecated since
      // 2005.
      binary: "VARBINARY(MAX)",
    },
    standsAlone: [
      "text",
      "ntext",
      "image",
      "money",
      "uniqueidentifier",
      "datetime",
      "datetime2",
      "smalldatetime",
      "datetimeoffset",
    ],
    bareSpelling: NO_BARE_SPELLING,
    typeVocabulary: STANDARD_TYPE_VOCABULARY,
    // Measured on SQL Server 2022: `SELECT CONVERT(varchar(64), 0x0102deadbeef, 2)`
    // answers `0102DEADBEEF`, `DATALENGTH(0x)` answers 0, so the empty case is spelled,
    // and `SELECT X'0102'` is `Msg 207 … Invalid column name 'X'`.
    binaryLiteral: binaryZeroX,
    nonFinite: NULL_NON_FINITE,
    insertForm: "values",
    typedLiteral: mssqlLiteral,
  },
};
