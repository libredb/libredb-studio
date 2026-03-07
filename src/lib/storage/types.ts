import type {
  DatabaseConnection,
  QueryHistoryItem,
  SavedQuery,
  SchemaSnapshot,
  SavedChartConfig,
} from '../types';
import type { AuditEvent } from '../audit';
import type { MaskingConfig } from '../data-masking';
import type { ThresholdConfig } from '../monitoring-thresholds';

/**
 * All persistable collections and their data types.
 * Maps 1:1 with localStorage keys (minus the `libredb_` prefix).
 */
export interface StorageData {
  connections: DatabaseConnection[];
  history: QueryHistoryItem[];
  saved_queries: SavedQuery[];
  schema_snapshots: SchemaSnapshot[];
  saved_charts: SavedChartConfig[];
  active_connection_id: string | null;
  audit_log: AuditEvent[];
  masking_config: MaskingConfig;
  threshold_config: ThresholdConfig[];
}

/** Collection names that can be synced to server storage */
export type StorageCollection = keyof StorageData;

/** All persistable collection names */
export const STORAGE_COLLECTIONS: StorageCollection[] = [
  'connections',
  'history',
  'saved_queries',
  'schema_snapshots',
  'saved_charts',
  'active_connection_id',
  'audit_log',
  'masking_config',
  'threshold_config',
];

/**
 * Server-side storage provider interface.
 * Implements the Strategy Pattern — SQLite and PostgreSQL both implement this.
 */
export interface ServerStorageProvider {
  /** Create tables if they don't exist */
  initialize(): Promise<void>;
  /** Get all collections for a user */
  getAllData(userId: string): Promise<Partial<StorageData>>;
  /** Get a single collection for a user */
  getCollection<K extends StorageCollection>(userId: string, collection: K): Promise<StorageData[K] | null>;
  /** Set a single collection for a user */
  setCollection<K extends StorageCollection>(userId: string, collection: K, data: StorageData[K]): Promise<void>;
  /** Merge multiple collections (used for migration) */
  mergeData(userId: string, data: Partial<StorageData>): Promise<void>;
  /** Health check */
  isHealthy(): Promise<boolean>;
  /** Cleanup resources */
  close(): Promise<void>;
}

/** Storage config returned by /api/storage/config */
export interface StorageConfigResponse {
  provider: 'local' | 'sqlite' | 'postgres';
  serverMode: boolean;
}

/** Event dispatched on storage mutations */
export interface StorageChangeDetail {
  collection: StorageCollection;
  data: unknown;
}
