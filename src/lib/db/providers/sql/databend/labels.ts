/**
 * The Databend labels and the kill's maintenance spec (design 2.4).
 *
 * Every wording the base provider would inherit from PostgreSQL and that is false here is overridden: Databend
 * refreshes statistics with ANALYZE TABLE and removes old data files with VACUUM TABLE, and Studio sends neither
 * (`maintenanceOperations` is `["kill"]`), so those cards are never drawn and are worded true all the same. The
 * slow-query state names `system_history` and its grant; the sessions state names the warehouse-wide scope of
 * `system.processes` [11 #13]; the table-stats caption names the default catalog the monitoring reads cover [X35].
 *
 * Pure: it imports the types only, so `getLabels()` can answer before connect.
 */
import type { MaintenanceOperationSpec, ProviderLabels } from "@/lib/db/types";

/** Every label sentence. */
export const DATABEND_LABEL_SENTENCES = Object.freeze({
  analyzeGlobalDesc:
    "Databend refreshes table statistics with ANALYZE TABLE, which Studio does not send; run it in the editor.",
  vacuumGlobalDesc:
    "Databend's VACUUM TABLE removes data files past the Time Travel retention period, which Studio does not send; run it in the editor.",
  slowQueriesEmptyState:
    "Query stats come from system_history.query_history, which needs Databend's history tables (not every Databend Cloud tenant has them) and GRANT SELECT ON system_history.*, and fills in batches, so the newest statements arrive late.",
  sessionsEmptyState:
    "No statement is running: this list covers every user's running statements on the server or warehouse, not only this connection's.",
  tableStatsCaption: "The base tables of the default catalog, largest first; other catalogs are not read.",
});

export const DATABEND_LABELS: ProviderLabels = Object.freeze({
  entityName: "Table",
  entityNamePlural: "Tables",
  rowName: "row",
  rowNamePlural: "rows",
  selectAction: "Select Top 50",
  generateAction: "Generate Query",
  analyzeAction: "Analyze Table",
  vacuumAction: "Vacuum Table",
  searchPlaceholder: "Search tables or columns...",
  analyzeGlobalLabel: "Run Analyze",
  analyzeGlobalTitle: "Not Run from Studio",
  analyzeGlobalDesc: DATABEND_LABEL_SENTENCES.analyzeGlobalDesc,
  vacuumGlobalLabel: "Run Vacuum",
  vacuumGlobalTitle: "Not Run from Studio",
  vacuumGlobalDesc: DATABEND_LABEL_SENTENCES.vacuumGlobalDesc,
  slowQueriesEmptyState: DATABEND_LABEL_SENTENCES.slowQueriesEmptyState,
  sessionsEmptyState: DATABEND_LABEL_SENTENCES.sessionsEmptyState,
  tableStatsCaption: DATABEND_LABEL_SENTENCES.tableStatsCaption,
});

/**
 * The kill [X08]: its target is a session id the Sessions panel supplies, and `KILL QUERY` on it stops that session's
 * current statement, so there is no table or global control.
 */
export const DATABEND_KILL_SPEC: MaintenanceOperationSpec = Object.freeze({
  label: "Kill Query",
  perEntity: false,
  global: false,
});
