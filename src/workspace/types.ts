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

/**
 * There is deliberately no `agent` flag here (#329).
 *
 * The agent runtime is standalone-only in Phase 1: it is gated by a server-side
 * setting the standalone shell discovers at runtime, and no embedded code path
 * reaches it. A capability declared here would therefore be set by a host and
 * never read — which is precisely the state the deprecated `inlineEditing` note
 * below records this repository as avoiding (#288). It is also not a gap a host
 * can close by asking: nothing in `StudioWorkspace` renders an agent surface,
 * and `tests/unit/agent-package-boundary.test.ts` pins that no agent module is
 * even reachable from the published entry points.
 *
 * When the embedded shell does grow one, the flag arrives in the same change as
 * the code that reads it — additive and optional, like every field here, because
 * this interface is implemented outside this repository.
 */
export interface WorkspaceFeatures {
  ai?: boolean;
  charts?: boolean;
  codeGenerator?: boolean;
  testDataGenerator?: boolean;
  schemaDiagram?: boolean;
  dataImport?: boolean;
  /**
   * @deprecated Declared but not read: setting it has no effect (#288).
   *
   * The embedded workspace has no editing path to switch on. `StudioWorkspace`
   * hard-codes `editingEnabled={false}` at both grid call sites, and the embedded
   * query adapter's `executeQuery` takes no execution options, so it could not
   * carry the `skipSafety` flag the standalone inline-edit path relies on (#269)
   * even if a caller reached it.
   *
   * Kept rather than removed because this interface is published and implemented
   * outside this repo, so deleting the field would stop a host that sets it from
   * compiling. Saying so here is the honest half: a declared capability that is
   * neither implemented nor rejected is the state to avoid, and this rejects it
   * where a host reads the contract. It becomes real, or goes away in a major,
   * with per-dialect row editing (#279).
   */
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
  // Deprecated and unread — see the field's note above (#288). It stays in the
  // defaults because the type is `Required<WorkspaceFeatures>`, and `false` is
  // the only value that matches what the embedded workspace actually does.
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
