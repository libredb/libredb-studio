import type { DatabaseConnection, QueryHistoryItem, SavedQuery, SchemaSnapshot, SavedChartConfig } from "../types";
import type { AuditEvent } from "../audit";
import type { MaskingConfig } from "../data-masking";
import type { ThresholdConfig } from "../monitoring-thresholds";

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
  /** seedIds the user dismissed (deleted a managed:false seed copy) so it is not re-added. */
  dismissed_seeds: string[];
  /**
   * Connection ids the user has starred, kept separate from `connections` rather than as a
   * field on `DatabaseConnection`: a `managed:true` connection is always taken fresh from the
   * server on every load (see `mergeManagedConnections` in `use-connection-manager.ts`), so a
   * field on the connection object itself would be silently discarded on reload for exactly the
   * connections a user is most likely to want to favorite. A separate id list favorites
   * correctly regardless of who owns the connection, and a duplicated connection (which gets a
   * new id) does not inherit the original's favorite status for free.
   */
  favorite_connections: string[];
  /**
   * Connection ids in the user's preferred display order (#748), kept separate from
   * `connections` rather than as a field on `DatabaseConnection`: a `managed:true`
   * connection is always taken fresh from the server on every load (see
   * `mergeManagedConnections` in `use-connection-manager.ts`), so a field on the connection
   * object itself would be silently discarded on reload for exactly the connections a user
   * is most likely to have reordered.
   */
  connection_order: string[];
}

/** Collection names that can be synced to server storage */
export type StorageCollection = keyof StorageData;

/** All persistable collection names */
export const STORAGE_COLLECTIONS: StorageCollection[] = [
  "connections",
  "history",
  "saved_queries",
  "schema_snapshots",
  "saved_charts",
  "active_connection_id",
  "audit_log",
  "masking_config",
  "threshold_config",
  "dismissed_seeds",
  "favorite_connections",
  "connection_order",
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
  /** Every local account. Empty until the first seed. Not used for OIDC identities. */
  listAccounts(): Promise<StoredAccount[]>;
  /** One account by its stored email, or null. */
  getAccount(email: string): Promise<StoredAccount | null>;
  /** Insert. The email is the primary key. */
  insertAccount(account: StoredAccount): Promise<void>;
  /** Replace the mutable columns of an existing email. Does not rename. */
  updateAccount(account: StoredAccount): Promise<void>;
  /**
   * Remove the account and its `user_storage` rows. Disabling an account does not call this:
   * a disabled account keeps its rows so re-enabling restores them.
   */
  deleteAccount(email: string): Promise<void>;
}

/**
 * One local email/password account on the server store.
 * `passwordHash` is the scrypt encoding from src/lib/password-hash.ts, never the password.
 * `totpPending` is an enrolment that has not been confirmed; login ignores it.
 */
export interface StoredAccount {
  email: string;
  passwordHash: string;
  role: "admin" | "user";
  totpSecret: string | null;
  totpPending: string | null;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Storage config returned by /api/storage/config */
export interface StorageConfigResponse {
  provider: "local" | "sqlite" | "postgres";
  serverMode: boolean;
}

/** Event dispatched on storage mutations */
export interface StorageChangeDetail {
  collection: StorageCollection;
  data: unknown;
}
