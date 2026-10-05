/**
 * The XLSX export, kept out of `result-export.ts` because it is the one format whose
 * writer is asynchronous: the library arrives through a dynamic import, so it never
 * enters the main bundle, and `buildResultExport` stays synchronous for the text formats.
 *
 * Security posture, carried over from the CSV writer (`csv.ts`): every value is written
 * as a STRING cell. SheetJS's `aoa_to_sheet` types a string as `t: "s"` and never as a
 * formula, so a cell holding `=1+1`, `+cmd|' /C calc'!A0` or `@SUM(A1:A9)` stays data —
 * there is no `f` field for a reader to evaluate. The worksheet name is fixed rather than
 * derived from a tab or a query, so no dynamic name reaches the workbook and no
 * 31-character / forbidden-character rule has to be enforced.
 *
 * The value contract is the shared `renderValue` (`csv.ts`), so the workbook shows the
 * same `\x…` hex for a binary cell and the same ISO text for a date that the grid, the
 * CSV and the Markdown/HTML exports show.
 */

import { cellOf, renderValue, resolveColumns } from "./csv";
import type { ResultExportSource, ResultXlsxFile } from "./result-export";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
/** A fixed worksheet name: the export never names a sheet after user data. */
const SHEET_NAME = "Results";

/** `source` as an XLSX workbook with one worksheet holding a header row, as a `Blob`. */
export async function buildXlsxExport(source: ResultExportSource): Promise<ResultXlsxFile> {
  const XLSX = await import("@e965/xlsx");
  const columns = resolveColumns(source.rows, source.fields);
  const aoa = [
    columns.slice(),
    ...source.rows.map((row) => columns.map((column) => renderValue(cellOf(row, column)))),
  ];
  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, SHEET_NAME);
  const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "array" }) as ArrayBuffer;
  return { content: new Blob([bytes], { type: XLSX_MIME }), mimeType: XLSX_MIME, extension: "xlsx" };
}
