// src/workspace/types.ts
import type { DatabaseType, TableSchema, SavedQuery, QueryWarning } from "@/lib/types";

// === Connection (platform → studio) ===

export interface WorkspaceConnection {
  id: string;
  name: string;
  type: DatabaseType;
}

// === User (platform → studio) ===

export interface WorkspaceUser {
  id: string;
  name?: string;
  role?: string;
}

// === Query result (studio ← platform) ===

export interface WorkspaceQueryResult {
  rows: Record<string, unknown>[];
  fields: string[];
  /**
   * The declared type of each column, as the engine spells it. Optional per
   * column, because a computed projection often has none. The adapter turns this
   * into the grid's `columnTypes` map (#285).
   */
  columns?: { name: string; type?: string }[];
  rowCount: number;
  executionTime: number;
  /**
   * Notices the engine attached to this run — an analytics engine answering 200
   * with rows missing, a query service returning advice about the statement. The
   * grid renders them from the field's presence, so a host that has none should
   * omit the field rather than send an empty array (#285).
   *
   * Additive and optional: this interface is published (`src/exports/workspace.ts`)
   * and implemented outside this repo, so a required field would stop every
   * existing host from compiling.
   */
  warnings?: QueryWarning[];
  pagination?: {
    limit: number;
    offset: number;
    hasMore: boolean;
    totalReturned: number;
    wasLimited: boolean;
  };
}

// === Feature flags ===

export interface WorkspaceFeatures {
  ai?: boolean;
  charts?: boolean;
  codeGenerator?: boolean;
  testDataGenerator?: boolean;
  schemaDiagram?: boolean;
  dataImport?: boolean;
  inlineEditing?: boolean;
  transactions?: boolean;
  connectionManagement?: boolean;
  dataMasking?: boolean;
}

export const DEFAULT_WORKSPACE_FEATURES: Required<WorkspaceFeatures> = {
  ai: false,
  charts: true,
  codeGenerator: true,
  testDataGenerator: true,
  schemaDiagram: true,
  dataImport: true,
  inlineEditing: false,
  transactions: false,
  connectionManagement: false,
  dataMasking: false,
};

// === Saved query input ===

export interface SavedQueryInput {
  name: string;
  query: string;
  description?: string;
  connectionType?: string;
  tags?: string[];
}

// === Main props ===

export interface StudioWorkspaceProps {
  connections: WorkspaceConnection[];
  currentUser?: WorkspaceUser;

  onQueryExecute: (
    connectionId: string,
    sql: string,
    options?: {
      limit?: number;
      offset?: number;
      unlimited?: boolean;
    },
  ) => Promise<WorkspaceQueryResult>;
  onSchemaFetch: (connectionId: string) => Promise<TableSchema[]>;

  onTestConnection?: (config: {
    type: DatabaseType;
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    sslEnabled?: boolean;
  }) => Promise<{ success: boolean; message: string }>;
  onSaveQuery?: (query: SavedQueryInput) => Promise<void>;
  onLoadSavedQueries?: () => Promise<SavedQuery[]>;

  features?: WorkspaceFeatures;
  className?: string;
}
