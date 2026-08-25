// src/exports/types.ts
// Re-export all public types for npm consumers
export type {
  DatabaseType,
  ConnectionEnvironment,
  SSLMode,
  SSLConfig,
  SSHTunnelConfig,
  DatabaseConnection,
  TableSchema,
  ColumnSchema,
  IndexSchema,
  ForeignKeySchema,
  QueryPagination,
  QueryResult,
  QueryWarning,
  QueryTab,
  QueryHistoryItem,
  SavedQuery,
  SchemaSnapshot,
  SavedChartConfig,
  AggregationType,
  DateGrouping,
} from "../lib/types";

// Also export provider types
export type { ProviderCapabilities, ProviderLabels, MaintenanceOperationSpec } from "../lib/db/types";
