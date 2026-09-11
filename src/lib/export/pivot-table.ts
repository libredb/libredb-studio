import { csvRow } from "./csv";
import { jsonText } from "./json";

export function pivotTableText(
  headers: readonly string[],
  rows: readonly (readonly unknown[])[],
  format: "csv" | "json",
): string {
  if (format === "json") {
    const records = rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row[index]])));
    return jsonText(records, 2);
  }

  return [csvRow(headers), ...rows.map((row) => csvRow(row))].join("\n");
}
