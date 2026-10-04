/**
 * The two InfluxDB label sets (SPEC 6.4).
 *
 * `statementLanguage` is what plan mode states after "Write it in" (`src/lib/agent/investigation.ts`); on
 * both types the engine's name alone would lead a model to the wrong language (Flux, or InfluxQL on a
 * SQL connection), so each sentence names what runs and what does not.
 *
 * Neither type has table stats (section 7), so `tableStatsCaption` is absent. The maintenance actions and
 * triads are never rendered while `supportsMaintenance` is false (`maintenanceControl()` gates every
 * placement on it first), and are written true to the engine all the same, the Prometheus pattern.
 *
 * Pure: it imports the label type only.
 */
import type { ProviderLabels } from "@/lib/db/types";

const SESSIONS_EMPTY_STATE = "InfluxDB has no session list: every request stands alone.";

/** The maintenance wording both types share: InfluxDB runs its own compaction and keeps no statistics to update. */
const MAINTENANCE_LABELS = {
  analyzeAction: "Measurement Statistics",
  vacuumAction: "Compact Storage",
  analyzeGlobalLabel: "Statistics",
  analyzeGlobalTitle: "Not available",
  analyzeGlobalDesc:
    "InfluxDB keeps no planner statistics to update, and Studio reads no row count or size it cannot state honestly. Nothing runs from here.",
  vacuumGlobalLabel: "Compact",
  vacuumGlobalTitle: "Compaction Is the Server's Own",
  vacuumGlobalDesc:
    "InfluxDB compacts its storage on its own schedule, and a connection in Studio is read-only. Nothing runs from here.",
} as const;

export const INFLUXQL_LABELS: ProviderLabels = {
  entityName: "Measurement",
  entityNamePlural: "Measurements",
  // Lower case, as every provider writes its row labels.
  rowName: "point",
  rowNamePlural: "points",
  selectAction: "Preview Newest Points",
  generateAction: "Generate Query",
  searchPlaceholder: "Search measurements...",
  statementLanguage:
    'InfluxQL: one SELECT, SHOW or EXPLAIN statement, no INTO, no Flux; name a measurement as "db".."measurement".',
  slowQueriesEmptyState:
    "InfluxDB keeps no query log Studio reads; 1.x SHOW QUERIES shows other users' statements and is not read.",
  sessionsEmptyState: SESSIONS_EMPTY_STATE,
  ...MAINTENANCE_LABELS,
};

export const INFLUXDB3_LABELS: ProviderLabels = {
  entityName: "Table",
  entityNamePlural: "Tables",
  rowName: "row",
  rowNamePlural: "rows",
  selectAction: "Preview Newest Rows",
  generateAction: "Generate Query",
  searchPlaceholder: "Search tables...",
  statementLanguage:
    "Apache DataFusion SQL as InfluxDB 3 runs it, not InfluxQL and not Flux: one SELECT, WITH, VALUES, SHOW, EXPLAIN or DESCRIBE statement; unquoted names fold to lower case; the time column is \"time\"; filter time with now() - INTERVAL '1 hour'.",
  slowQueriesEmptyState:
    "InfluxDB 3 records queries in a server-wide table that shows other users' statements and marks a streamed query finished early, so Studio does not read it.",
  sessionsEmptyState: SESSIONS_EMPTY_STATE,
  ...MAINTENANCE_LABELS,
  analyzeAction: "Table Statistics",
};
