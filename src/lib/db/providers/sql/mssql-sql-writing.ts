/**
 * SQL Server's own SQL writing functions, which Studio's SQL writing function table binds to the names the engine's
 * declaration gives (src/lib/db/sql-writing/index.ts, `SQL_WRITING_FUNCTIONS`): its inline edit's `boundEdit` and its
 * result export's `typedLiteral`. Its SQL writing facts are stated in its declaration,
 * src/lib/db/engine-declarations/mssql.json.
 */
import { normalized } from "@/lib/db/sql-writing/export-shared";
import { firstWord, literalUnicode, unwrappedType } from "@/lib/db/sql-writing/shared";
import type { InlineEditSpec, TypedWriter } from "@/lib/db/sql-writing/types";

/**
 * The text the provider reads a `datetime` and a `smalldatetime` as (#1452): the engine's own.
 * The inline grid edit (`use-inline-editing.ts`) binds it with a `T` for the same reason the
 * SQL INSERT export (`MSSQL_TYPED_LITERAL` below) writes it with one.
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
export const MSSQL_TYPED_LITERAL: TypedWriter = (value, declared) => {
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
 * (`MSSQL_TYPED_LITERAL` above). Text in any other shape is bound as typed.
 */
export const MSSQL_BOUND_EDIT: NonNullable<InlineEditSpec["boundEdit"]> = (text, declaredType, bind) =>
  declaredType !== undefined &&
  MSSQL_DATEFORMAT_TYPES.has(firstWord(unwrappedType(declaredType))) &&
  MSSQL_DATETIME_TEXT.test(text)
    ? bind(text.replace(" ", "T"))
    : undefined;
