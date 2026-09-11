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

/**
 * The shape a consumer of `StudioWorkspaceProps.onSchemaFetch` returns (#789).
 *
 * Exported because the prop's type names it: a host that types its own schema reader has to
 * be able to name what it returns. Its `kind` and `path` are optional, so a host that
 * answers what it answered before this type existed still satisfies it.
 */
export type { DetailedObject } from "../lib/db/detailed-object";

// The container-aware object model (#789)
export type {
  ObjectRole,
  ObjectKindSpec,
  ContainerLevelSpec,
  Container,
  DatabaseObject,
  KindCount,
  ObjectDetail,
} from "../lib/db/types";
