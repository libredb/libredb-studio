// src/exports/types.ts
// Re-export all public types for npm consumers
export type {
  DatabaseType,
  ConnectionEnvironment,
  SSLMode,
  SSLConfig,
  SSHTunnelConfig,
  DatabaseConnection,
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
 * Exported because the prop's type names it: a host that types its own schema reader has to be
 * able to name what it returns. `kind` and `path` are REQUIRED on it as of the major that
 * deleted `TableSchema`: every entry now comes from the object surface, and a host reading its
 * own catalog has to say what each entry is and where it lives rather than handing over a
 * qualified name for this package to split.
 *
 * `StoredObject` is the same shape with those two optional, and it is what `SchemaSnapshot`
 * holds, because a snapshot written before the object model cannot have them.
 */
export type { DetailedObject, StoredObject } from "../lib/db/detailed-object";

// The container-aware object model (#789)
export type {
  ObjectRole,
  ObjectKindSpec,
  ContainerLevelSpec,
  Container,
  DatabaseObject,
  KindCount,
  ObjectDetail,
  ObjectDetailBatch,
} from "../lib/db/types";
