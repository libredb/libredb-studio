// src/workspace/types.ts
import type { DatabaseType, TableSchema, SavedQuery } from '@/lib/types';

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
  columns?: { name: string; type?: string }[];
  rowCount: number;
  executionTime: number;
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

  onQueryExecute: (connectionId: string, sql: string, options?: {
    limit?: number;
    offset?: number;
    unlimited?: boolean;
  }) => Promise<WorkspaceQueryResult>;
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
