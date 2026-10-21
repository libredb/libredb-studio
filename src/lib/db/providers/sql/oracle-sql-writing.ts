import {
  EXACT_DECIMAL_TYPE_NAMES,
  FLOAT64_TYPE_NAMES,
  identifierDoubleQuoted,
  INSTANT_TYPE_NAMES,
  literalStandard,
  NO_BARE_SPELLING,
  placeholderColon,
  STANDARD_TYPE_VOCABULARY,
  unquoteStandard,
} from "@/lib/db/sql-writing/shared";
import { binaryHexToRaw } from "@/lib/db/sql-writing/export-shared";
import type { SqlWritingSpec } from "@/lib/db/sql-writing/types";

/** The declared types the Oracle provider reads as wall-clock text (#1131) or an instant (#1224). */
const ORACLE_TIMESTAMP_TYPE = /^TIMESTAMP\s*(\(\d\))?$/;
const ORACLE_ZONED_TIMESTAMP_TYPE = /^TIMESTAMP\s*(\(\d\))?\s+WITH\s+(LOCAL\s+)?TIME\s+ZONE$/;

/** The masks `TO_DATE` and `TO_TIMESTAMP` read the provider's text and the `Date` fields through (#1131, #1498). */
const ORACLE_DATE_MASK = "YYYY-MM-DD HH24:MI:SS";
const ORACLE_BC_DATE_MASK = "SYYYY-MM-DD HH24:MI:SS";

/**
 * The text the Oracle provider reads a DATE and a TIMESTAMP as (#1131): the wall clock,
 * a leading `-` on a BC year, and a fraction only where there is one.
 */
const ORACLE_ZONELESS_TEXT = /^(-?)\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,9})?$/;

/**
 * The text `Date#toISOString` writes for a year from 0000 to 9999. A year outside that
 * range is written with a sign and six digits (`-000044-…`, `+012026-…`) and does not
 * match: Oracle has no year after 9999, and a BC year's text is left for a separate change
 * (the `Date` path itself writes one as `SYYYY`, #1498), so that text stays quoted.
 */
const ISO_INSTANT_TEXT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Which Oracle conversion function a `Date` cell is written through. The provider's own
 * rows carry a DATE and a TIMESTAMP as text since #1131 (`OracleDateColumn` below), so a
 * naive `Date` reaches this only from a host that built its rows itself.
 *
 * Oracle parses none of the literal forms a `Date` stringifies to: measured through the
 * real export path on the Oracle Free image (`Oracle AI Database 26ai Free Release
 * 23.26.2.0.0`), an exported `'2026-08-24T07:11:12.345Z'` is `ORA-01843: An invalid month
 * was specified` for all three timestamp types and `ORA-01861: literal does not match
 * format string` for a DATE, so every ordinary Oracle table with a date column produced a
 * file that could not be replayed. The conversion function IS the literal here, the way
 * `HEXTORAW` is for a RAW.
 *
 * The shape has to come from the DECLARED type, because the two shapes disagree about
 * which fields of the `Date` are the value:
 *
 * - A naive `DATE`/`TIMESTAMP` reaches us as a `Date` the driver built by reading the
 *   stored wall clock **in the Node process's zone**. Measured, a `DATE` holding
 *   `2026-08-24 10:11:12` arrived as `2026-08-24T07:11:12.000Z` from a process at
 *   `+03:00`. So the fields that replay it are the LOCAL ones, and writing the ISO text
 *   would move every such value by the exporter's own offset - silently, since it still
 *   parses.
 * - A zoned column (`WITH TIME ZONE`, `WITH LOCAL TIME ZONE`) reaches us as the true UTC
 *   instant, its stored offset already gone at the driver boundary
 *   (`docs/providers/oracle.md` 5.5). `FROM_TZ(..., 'UTC')` is what keeps that instant
 *   whatever zone the replaying session runs in: a plain `TO_TIMESTAMP` is read in the
 *   SESSION time zone, so the same file would land on a different instant on a machine
 *   in another zone. No offset is invented - the value comes back rendered as UTC, and
 *   the original zone is the thing 5.5 says only the server still has.
 *
 * With no declared type - `columnTypes` is optional on `ResultExportSource`, and a host
 * driving the embeddable surface may supply none - the timestamp form is the fallback:
 * Oracle's own provider always declares (`metaData[].dbTypeName`, 5.4), the naive types
 * are the common ones, and the fallback is the shape that is exact for them.
 */
type OracleDateShape = "date" | "timestamp" | "zoned";

function oracleDateShape(declared: string | undefined): OracleDateShape {
  const bare = declared?.trim().toUpperCase().replace(/\s+/g, " ") ?? "";
  if (bare === "DATE") return "date";
  return bare.endsWith("TIME ZONE") ? "zoned" : "timestamp";
}

/**
 * How one Oracle column's date cells are written: `shape` for a `Date`, and `text` for a
 * cell that arrives as a string: the zone-less text the provider reads a DATE and a
 * TIMESTAMP as (#1131), or, for a zoned column, the `Date#toISOString` text a row carries
 * once it has been through JSON over HTTP (#1224).
 *
 * `text` is set only for a column DECLARED `DATE`, `TIMESTAMP[(n)]` or
 * `TIMESTAMP[(n)] WITH [LOCAL] TIME ZONE`, never by the fallback `shape` takes. A VARCHAR2
 * holding `2026-09-01 10:30:00` is text, and converting it would store the NLS rendering
 * of a timestamp where the characters belonged.
 */
interface OracleDateColumn {
  shape: OracleDateShape;
  text?: "date" | "timestamp" | "zoned";
}

function oracleDateColumn(declared: string | undefined): OracleDateColumn {
  const bare = declared?.trim().toUpperCase() ?? "";
  const text =
    bare === "DATE"
      ? "date"
      : ORACLE_TIMESTAMP_TYPE.test(bare)
        ? "timestamp"
        : ORACLE_ZONED_TIMESTAMP_TYPE.test(bare)
          ? "zoned"
          : undefined;
  return { shape: oracleDateShape(declared), ...(text === undefined ? {} : { text }) };
}

/** `value`, two digits at least, so `2026-1-2 3:4:5` never reaches a format mask. */
function pad(value: number, width = 2): string {
  return String(value).padStart(width, "0");
}

/**
 * An Oracle date literal, from the LOCAL fields for a naive column and the UTC ones for
 * a zoned column (see `oracleDateShape`).
 *
 * The fraction is three digits and `FF3` rather than dropped: a `Date` carries
 * milliseconds and a `TIMESTAMP(6)` keeps them. `TO_DATE` is used for a declared `DATE`
 * because a `DATE` has no fractional second at all - measured, a `TO_TIMESTAMP` literal
 * inserted into a `DATE` column is accepted and silently truncated to the whole second,
 * so nothing is lost either way and the explicit function says what the column is.
 */
function oracleDateLiteral(value: Date, shape: OracleDateShape): string {
  const utc = shape === "zoned";
  const year = utc ? value.getUTCFullYear() : value.getFullYear();
  // A BC year keeps its sign in front of the zeros (`-0044`, never `0-44`) and takes the signed
  // `SYYYY` mask, as `oracleTextLiteral` does for the provider's text (#1498).
  const bc = year < 0;
  const date = `${bc ? "-" : ""}${pad(Math.abs(year), 4)}-${pad((utc ? value.getUTCMonth() : value.getMonth()) + 1)}-${pad(utc ? value.getUTCDate() : value.getDate())}`;
  const time = `${pad(utc ? value.getUTCHours() : value.getHours())}:${pad(utc ? value.getUTCMinutes() : value.getMinutes())}:${pad(utc ? value.getUTCSeconds() : value.getSeconds())}`;
  const mask = bc ? ORACLE_BC_DATE_MASK : ORACLE_DATE_MASK;
  if (shape === "date") return `TO_DATE('${date} ${time}', '${mask}')`;
  const stamp = `TO_TIMESTAMP('${date} ${time}.${pad(utc ? value.getUTCMilliseconds() : value.getMilliseconds(), 3)}', '${mask}.FF3')`;
  return utc ? `FROM_TZ(${stamp}, 'UTC')` : stamp;
}

/**
 * That text as the literal of the declared type, or `undefined` when it is not in that form.
 *
 * Quoted as it is, the text is read through the session's `NLS_DATE_FORMAT`, `DD-MON-RR` by
 * default, and refused. The mask spells the text's own form instead, so it replays the same
 * in every session: `SYYYY` only for a signed year, and `FF` only for a fraction, since `FF`
 * with no digit count takes the one to nine digits a TIMESTAMP holds. A DATE has no
 * fractional second, so a fraction is not a DATE's text. The text is digits and separators
 * by that same match, so interpolating it needs no quoting.
 */
function oracleTextLiteral(text: string, type: "date" | "timestamp"): string | undefined {
  const match = ORACLE_ZONELESS_TEXT.exec(text);
  if (match === null) return undefined;
  const [, sign, fraction] = match;
  const mask = sign === "" ? ORACLE_DATE_MASK : ORACLE_BC_DATE_MASK;
  if (type === "date") return fraction === undefined ? `TO_DATE('${text}', '${mask}')` : undefined;
  return `TO_TIMESTAMP('${text}', '${mask}${fraction === undefined ? "" : ".FF"}')`;
}

/**
 * A zoned column's cell as it arrives over HTTP (#1224), as the literal the `Date` of that
 * instant gets, or `undefined` when it is not that text.
 *
 * The driver hands a `TIMESTAMP WITH [LOCAL] TIME ZONE` over as the `Date` of its instant,
 * and `POST /api/db/query` answers with JSON, so by the time an export over HTTP sees the
 * row the cell is that `Date`'s ISO text. Quoted, Oracle reads it through the session's
 * `NLS_TIMESTAMP_TZ_FORMAT` and refuses it (`ORA-01843`). The text is parsed back to its
 * `Date` and written by `oracleDateLiteral`, so the two paths cannot drift apart, and only
 * when that `Date` writes the same text again: `2026-02-30T…` and `T24:00:00.000Z` fit the
 * form but are not what `toISOString` writes for any instant. The literal is built from
 * the parsed fields, never from the text.
 */
function oracleZonedTextLiteral(text: string): string | undefined {
  if (!ISO_INSTANT_TEXT.test(text)) return undefined;
  const instant = new Date(text);
  return !Number.isNaN(instant.getTime()) && instant.toISOString() === text
    ? oracleDateLiteral(instant, "zoned")
    : undefined;
}

/** How a generated statement spells a literal, a name and a bind for Oracle. */
export const ORACLE_SQL_WRITING: SqlWritingSpec = {
  escapeLiteral: literalStandard,
  unescapeLiteral: unquoteStandard,
  // The SQL standard form.
  quoteIdentifier: identifierDoubleQuoted,
  // `oracledb` binds an array to `:n`.
  placeholder: placeholderColon,
  /**
   * Oracle reads a quoted string in a date position through the session's `NLS_DATE_FORMAT`,
   * `DD-MON-RR` by default, and refuses the ISO text with `ORA-01861: literal does not match
   * format string` (#1400, on Oracle 23.26.3.0.0; the SQL export measured the same refusal for
   * all four date types, `docs/providers/oracle.md`). So the value goes through `TO_DATE` or
   * `TO_TIMESTAMP` with a mask that spells the text's own form, as the export writes the same
   * types, and the session's format moves nothing. Text that is not in that form is quoted as
   * it is: the mask would refuse it, and a plain literal says what the caller had.
   */
  temporalLiteral: (text, kind) => {
    if (kind === "date") {
      return /^\d{4}-\d{2}-\d{2}$/.test(text) ? `TO_DATE('${text}', 'YYYY-MM-DD')` : undefined;
    }
    return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
      ? `TO_TIMESTAMP('${text}', 'YYYY-MM-DD HH24:MI:SS')`
      : undefined;
  },
  inlineEdit: {
    instantTypeNames: INSTANT_TYPE_NAMES,
    exactDecimalTypeNames: EXACT_DECIMAL_TYPE_NAMES,
    float64TypeNames: FLOAT64_TYPE_NAMES,
    /**
     * An Oracle `DATE`, `TIMESTAMP` or `TIMESTAMP WITH [LOCAL] TIME ZONE` edit wrapped around its
     * `:n` bind placeholder, or `undefined` when the column or text is not one (#1807).
     *
     * The Oracle provider reads `DATE` and `TIMESTAMP` as their wall clock (`YYYY-MM-DD HH24:MI:SS[.FF]`,
     * #1131) and `TIMESTAMP WITH [LOCAL] TIME ZONE` arrives over HTTP as its `Date#toISOString` text
     * (`YYYY-MM-DDTHH:MM:SS.sssZ`, #1224). `oracledb` binds a string parameter as `DB_TYPE_VARCHAR`, which
     * Oracle reads into a date or timestamp column through the session's `NLS_DATE_FORMAT` (`DD-MON-RR`),
     * `NLS_TIMESTAMP_FORMAT` (`DD-MON-RR HH.MI.SSXFF AM`), or `NLS_TIMESTAMP_TZ_FORMAT`
     * (`DD-MON-RR HH.MI.SSXFF AM TZR`). MEASURED 2026-10-18 on Oracle AI Database 26ai Free 23.26.3.0.0
     * (`gvenzl/oracle-free:slim`, `oracledb` 26.0.0, `TZ=Europe/Istanbul`): a bare `:1` bind was refused
     * with `ORA-01861: literal does not match format string` on `DATE` and `ORA-01843: An invalid month
     * was specified.` on `TIMESTAMP`, `TIMESTAMP WITH TIME ZONE`, and `TIMESTAMP WITH LOCAL TIME ZONE`,
     * while `:1` wrapped in `TO_DATE(:1, '[S]YYYY-MM-DD HH24:MI:SS')`, `TO_TIMESTAMP(:1,
     * '[S]YYYY-MM-DD HH24:MI:SS[.FF]')`, or `FROM_TZ(TO_TIMESTAMP(:1, 'YYYY-MM-DD HH24:MI:SS.FF3'), 'UTC')`
     * stored each value equal on the server, BC dates included. Matched by the same regexes and masks the
     * SQL INSERT export uses (`export.columnWriters` below). Everything else returns `undefined` and binds as `:n`.
     */
    boundEdit: (text, declaredType, bind) => {
      const bare = declaredType?.trim().toUpperCase() ?? "";
      if (bare === "DATE" || ORACLE_TIMESTAMP_TYPE.test(bare)) {
        const match = ORACLE_ZONELESS_TEXT.exec(text);
        if (match === null) return undefined;
        const [, sign, fraction] = match;
        const mask = sign === "" ? ORACLE_DATE_MASK : ORACLE_BC_DATE_MASK;
        if (bare === "DATE") return fraction === undefined ? `TO_DATE(${bind(text)}, '${mask}')` : undefined;
        return `TO_TIMESTAMP(${bind(text)}, '${mask}${fraction === undefined ? "" : ".FF"}')`;
      }
      if (ORACLE_ZONED_TIMESTAMP_TYPE.test(bare) && ISO_INSTANT_TEXT.test(text)) {
        const instant = new Date(text);
        if (!Number.isNaN(instant.getTime()) && instant.toISOString() === text) {
          return `FROM_TZ(TO_TIMESTAMP(${bind(text.slice(0, -1).replace("T", " "))}, '${ORACLE_DATE_MASK}.FF3'), 'UTC')`;
        }
      }
      return undefined;
    },
  },
  export: {
    ddlTypes: {
      text: "VARCHAR2(4000)",
      integer: "NUMBER(19)",
      numeric: "BINARY_DOUBLE",
      boolean: "NUMBER(1)",
      timestamp: "TIMESTAMP",
      binary: "BLOB",
    },
    standsAlone: [
      "number",
      "binary_double",
      "binary_float",
      "clob",
      "nclob",
      "blob",
      "timestamp",
      "timestamp with time zone",
    ],
    bareSpelling: NO_BARE_SPELLING,
    typeVocabulary: STANDARD_TYPE_VOCABULARY,
    binaryLiteral: binaryHexToRaw,
    // Replayed into the engine (2026-10-04): Oracle AI Database 23.26.3 reads its own
    // constants into `BINARY_DOUBLE` and `BINARY_FLOAT`.
    nonFinite: { NaN: "BINARY_DOUBLE_NAN", Infinity: "BINARY_DOUBLE_INFINITY", "-Infinity": "-BINARY_DOUBLE_INFINITY" },
    insertForm: "values",
    columnWriters: (declared) =>
      declared.map((type) => {
        const column = oracleDateColumn(type);
        return (value) => {
          if (value instanceof Date) return oracleDateLiteral(value, column.shape);
          if (typeof value !== "string" || column.text === undefined) return undefined;
          return column.text === "zoned" ? oracleZonedTextLiteral(value) : oracleTextLiteral(value, column.text);
        };
      }),
  },
};
