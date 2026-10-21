import { readsAsFormula } from "@/lib/export/csv";

/**
 * One rectangle of the grid's selection, as the text the clipboard will carry.
 *
 * The cells are already the text the grid would copy for each one (`formatCellCopy` of the
 * displayed value), so a masked cell arrives here as its mask: this module only lays text out.
 */
export interface ClipboardRegion {
  headers?: readonly string[];
  rows: readonly (readonly string[])[];
}

const NEEDS_QUOTING = /[\t\n\r"]/;

/**
 * One cell of a tab-separated range, quoted the way Excel and Google Sheets write and read it.
 *
 * A tab or a line break inside a value would otherwise start a new cell or a new row on paste,
 * so such a value is wrapped in double quotes and any quote inside it doubled.
 *
 * A value a spreadsheet would run as a formula is prefixed with an apostrophe first, the CSV
 * export's guard (X1 in `src/lib/export/csv.ts`): a range is copied to be pasted into a
 * spreadsheet, which evaluates a pasted `=HYPERLINK(...)` the way it evaluates one in an opened
 * file, on the machine of a reader who did not write the query.
 */
export function clipboardField(text: string): string {
  const guarded = readsAsFormula(text) ? `'${text}` : text;
  return NEEDS_QUOTING.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * The clipboard text for a selection: tab-separated cells, one line per row.
 *
 * A lone cell with no header is the exception and copies its value raw, because that copy is
 * pasted into an editor or a search box far more often than into a spreadsheet, and quoting a
 * multi-line value or prefixing an apostrophe there would hand back text the user never saw.
 * It is what Copy Cell has always copied. Several regions stack one
 * under the other in the order they were selected: rectangles of different widths have no
 * shared column layout to keep.
 */
export function selectionClipboardText(regions: readonly ClipboardRegion[]): string {
  if (regions.length === 1 && regions[0].headers === undefined && regions[0].rows.length === 1) {
    const [only] = regions[0].rows;
    if (only.length === 1) return only[0];
  }
  const lines: string[] = [];
  for (const region of regions) {
    if (region.headers !== undefined) lines.push(region.headers.map(clipboardField).join("\t"));
    for (const row of region.rows) lines.push(row.map(clipboardField).join("\t"));
  }
  return lines.join("\n");
}
