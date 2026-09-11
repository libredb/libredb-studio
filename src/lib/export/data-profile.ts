/**
 * The text a Data Profiler download carries, for both formats.
 *
 * Separate from the component for the same reason `query-history.ts` is: the part
 * worth pinning is what gets WRITTEN, and asserting that through a component means
 * a portal, a stubbed `document.createElement` and a blob read before the first
 * character can be checked. Here the headers, the column order, the escaping and
 * the masking are all ordinary string assertions.
 *
 * The masking is the reason this file is not a formatting detail. The profiler
 * shows `MIN`, `MAX` and five sample values per column, so a profile of a `users`
 * table holds real addresses; the screen masks them for a sensitive column and an
 * export that did not would hand out what the UI is careful to hide. Every path
 * out of here masks the same three fields the component renders masked.
 */

import { maskValue, type MaskingRule } from "@/lib/data-masking";
import { csvRow } from "./csv";
import { jsonText } from "./json";

/** One column's statistics, as `/api/db/profile` returns them. */
export interface ColumnProfile {
  name: string;
  type?: string;
  totalRows: number;
  nullCount: number;
  nullPercent: number;
  distinctCount: number;
  minValue?: string;
  maxValue?: string;
  sampleValues?: string[];
  error?: string;
}

/** A whole profiling run for one table. */
export interface ProfileData {
  tableName: string;
  totalRows: number;
  columns: ColumnProfile[];
}

/** What separates the sample values inside their single cell. */
const SAMPLE_SEPARATOR = " | ";

const HEADERS = [
  "Column",
  "Type",
  "Total Rows",
  "Null Count",
  "Null %",
  "Distinct Count",
  "Min",
  "Max",
  "Sample Values",
  "Error",
];

/**
 * `column` with its sensitive values masked and its absent ones written as empty.
 *
 * Absent stays empty rather than becoming the mask: a column with no `MIN` has
 * nothing to hide, and `maskValue` answers `NULL` for an absent value, which reads
 * back as a column that genuinely holds that word.
 */
function exportedColumn(column: ColumnProfile, rule: MaskingRule | undefined): Required<ColumnProfile> {
  return {
    name: column.name,
    type: column.type || "",
    totalRows: column.totalRows,
    nullCount: column.nullCount,
    nullPercent: column.nullPercent,
    distinctCount: column.distinctCount,
    minValue: column.minValue && rule ? maskValue(column.minValue, rule) : column.minValue || "",
    maxValue: column.maxValue && rule ? maskValue(column.maxValue, rule) : column.maxValue || "",
    sampleValues: column.sampleValues?.map((value) => (rule ? maskValue(value, rule) : value)) || [],
    error: column.error || "",
  };
}

/**
 * `profile` as the text of a `format` download.
 *
 * `sensitive` is the map the component already computed for the screen, passed in
 * rather than recomputed here, so the file cannot mask a different set of columns
 * from the one the user was shown.
 */
export function dataProfileText(
  profile: ProfileData,
  sensitive: ReadonlyMap<string, MaskingRule>,
  format: "csv" | "json",
): string {
  const columns = profile.columns.map((column) => exportedColumn(column, sensitive.get(column.name)));

  // Through `jsonText`, which is what every other export writes JSON with: a bigint
  // or a cycle takes a bare `JSON.stringify` down from inside the click handler, with
  // no file and nothing in the UI to say why. Today's fields cannot hold either, and
  // a field added later must not be able to.
  if (format === "json") {
    return jsonText({ tableName: profile.tableName, totalRows: profile.totalRows, columns }, 2);
  }

  const rows = columns.map((column) =>
    csvRow([
      column.name,
      column.type,
      column.totalRows,
      column.nullCount,
      column.nullPercent,
      column.distinctCount,
      column.minValue,
      column.maxValue,
      column.sampleValues.join(SAMPLE_SEPARATOR),
      column.error,
    ]),
  );

  return [csvRow(HEADERS), ...rows].join("\n");
}
