import type { ExplainStrategy } from "./types";

/**
 * BigQuery has no EXPLAIN statement. The marker tells the provider to send the statement with `dryRun: true`,
 * which validates it and reports the bytes it would scan without running or billing anything.
 */
export const BIGQUERY_DRY_RUN_MARKER = "-- libredb:bigquery-dry-run\n";

interface DryRunRow {
  bytes_processed: number;
  bytes_processed_human: string;
}

function isDryRunRow(value: unknown): value is DryRunRow {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as DryRunRow).bytes_processed === "number" &&
    typeof (value as DryRunRow).bytes_processed_human === "string"
  );
}

export const bigqueryDryRunStrategy: ExplainStrategy = {
  format: "bigquery-dryrun",
  // A dry run is free, so the editor prices the statement while it is typed.
  liveEstimate: true,
  // A dry run never executes, so every statement kind is safe and estimate equals analyze.
  buildSql(sql) {
    return `${BIGQUERY_DRY_RUN_MARKER}${sql}`;
  },
  extractPlan(result) {
    return result.rows?.[0] ?? null;
  },
  toRenderModel(raw) {
    if (!isDryRunRow(raw)) return null;
    return {
      kind: "tree",
      root: {
        label: `Dry run: ${raw.bytes_processed_human} would be processed`,
        detail: `${raw.bytes_processed.toLocaleString("en-US")} bytes`,
        children: [],
      },
      raw,
    };
  },
};
