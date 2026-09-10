import type { QueryHistoryItem } from "@/lib/types";
import { csvRow } from "./csv";
import { jsonText } from "./json";

/** Shared record shape for the query-history panel and the admin audit tab. */
export function queryHistoryText(items: readonly QueryHistoryItem[], format: "csv" | "json"): string {
  // Keep the export path's bigint/cycle handling even though today's typed
  // history fields are primitives. Future metadata must not break the download.
  if (format === "json") return jsonText(items, 2);

  const headers = ["Executed At", "Status", "Connection", "Tab", "Execution Time (ms)", "Rows", "Query", "Error"];
  // Every field goes through the shared CSV writer. Escaping only query/error
  // once let commas in connection and tab names shift every following column.
  const rows = items.map((item) =>
    csvRow([
      item.executedAt,
      item.status,
      item.connectionName || item.connectionId,
      item.tabName || "",
      item.executionTime,
      item.rowCount || 0,
      item.query,
      item.errorMessage || "",
    ]),
  );
  return [csvRow(headers), ...rows].join("\n");
}
