// src/workspace/types.ts
import type { DatabaseType, SavedQuery, QueryWarning } from "@/lib/types";
import type { DetailedObject } from "@/lib/db/detailed-object";
import type { Container, DatabaseObject, KindCount, ProviderCapabilities, ProviderLabels } from "@/lib/db/types";

// === Connection (platform → studio) ===

export interface WorkspaceConnection {
  id: string;
  name: string;
  type: DatabaseType;
  /**
   * What this connection's provider can do, as `getCapabilities()` reports it.
   *
   * The standalone shell reads the same object from `POST /api/db/provider-meta`;
   * the embedded shell cannot — it has no route of its own, and the connection it
   * is handed carries no credentials to describe, so the host is the only party
   * that can answer. Both fields are therefore supplied per connection here.
   *
   * Everything capability-driven is off until they are: the tab's query dialect,
   * so a Redis connection gets Redis commands instead of `SELECT * FROM user:*`
   * (#427); the schema explorer's per-row actions; the provider's own wording.
   *
   * Additive and optional, like every field on this published interface. Absent
   * reads exactly as it did before the field existed — studio treats the provider
   * as unknown and falls back to SQL and to the base labels.
   */
  capabilities?: ProviderCapabilities;
  /** This provider's UI wording, as `getLabels()` reports it. See `capabilities`. */
  labels?: ProviderLabels;
  /**
   * Read no catalog when this connection opens (#765).
   *
   * The host is the only party that can declare it, for the same reason it declares
   * `capabilities`: it owns the connection and knows which of its tenants' databases holds
   * tens of thousands of objects. The workspace then shows a load action in place of the
   * object tree and reads nothing until the user presses it; the editor and query
   * execution are unaffected.
   *
   * Additive and optional, like every field on this published interface. Absent reads
   * exactly as it did before the field existed.
   */
  skipObjectScan?: boolean;
}

// === Object reading (studio → platform) ===

/**
 * The host's reading of one connection's OBJECT MODEL, one lazy read at a time (#789, B76).
 *
 * The three methods are `DatabaseProvider`'s own container-scoped surface with a connection id in
 * front, so a host holding a provider (`@libredb/studio/providers` builds one) implements each in
 * a line. They are what the object tree asks for, and nothing more: containers under a parent, the
 * per-kind counts of one container, and the objects of one container-and-kind pair.
 *
 * Required, and this is the major that may add it. The embedded shell mounts the same tree as the
 * standalone one, and that tree used to post to `/api/db/objects/*` - which cannot work here for
 * two independent reasons. The package ships no API routes at all (`package.json`'s `exports` map
 * carries components and types), so those paths belong to whatever server the host mounted the
 * workspace in; and the connection this shell builds from `WorkspaceConnection` carries no host,
 * port, user or file path, because the published interface has no field for one and a host would
 * not want to hand credentials to a browser to post back. Measured before this prop existed, on
 * every connection an adopter could declare: the tree showed "The object list could not be read"
 * over the engine's own refusal ("ClickHouse requires a host or a connection string").
 *
 * A flat catalog handed over in one call would have closed it too, and is what `onSchemaFetch`
 * already does. It is not what this is: the tree exists to open a 43,512-object schema without
 * reading it, so the seam is per read and stays lazy.
 */
export interface WorkspaceObjectReader {
  /**
   * The containers under `parent`, or the top level when it is absent.
   *
   * A container level is a schema, a database, a keyspace: whatever the engine's own
   * `ProviderCapabilities.containerLevels` declared for this connection. Mark the one the session
   * is already in with `isSessionDefault`, and the workspace opens it on first paint.
   */
  listContainers(connectionId: string, parent?: readonly string[]): Promise<readonly Container[]>;
  /**
   * How many objects of each declared kind this container holds.
   *
   * The key is the kind id from the connection's declaration. A kind the engine refused to count
   * answers `{ unavailable: <the engine's own sentence> }` rather than a zero, and a real number
   * that stopped at a bound carries `sampledFrom`.
   */
  countObjects(connectionId: string, container: readonly string[]): Promise<Record<string, KindCount>>;
  /** The objects of one container and one kind, which is one opened folder. */
  listObjects(connectionId: string, container: readonly string[], kind: string): Promise<readonly DatabaseObject[]>;
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
 *
 * There is also no `ai` flag any more (#331 T2). It gated exactly one thing — the
 * NL2SQL panel's open state at the two `StudioWorkspace` call sites — and that
 * panel is gone, so the field would have been read nowhere at all. That is a
 * different case from the `inlineEditing` note below, which is kept: inlineEditing
 * describes a capability that still exists in the standalone shell and is expected
 * to become real in the embedded one (#279), so a host that sets it is describing
 * something coherent. `ai` would have described a surface this package no longer
 * contains — a published flag that gates nothing, which is worse than absent
 * because a host cannot tell by reading it. Removing it is a breaking change for
 * any consumer of the published `@libredb/studio` package that sets the flag, and
 * this docblock is where that change is recorded; libredb-platform was checked on
 * 2026-08-13 and never set it.
 */
export interface WorkspaceFeatures {
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
  /**
   * The host's reading of one connection's objects (#789).
   *
   * `DetailedObject`, which carries the `kind` its engine declared and the `path` its segments
   * make up beside the columns. Every consumer filter in the workspace reads that kind: a view
   * is not offered as an import target, and a routine is not drawn in the diagram.
   *
   * BOTH FIELDS ARE REQUIRED as of the major that deleted `TableSchema` (#789). They were
   * optional while a flat reading with nowhere to put them was still live, and a host that
   * answered without them had its objects reach every consumer unfiltered, because a
   * declaration nobody made cannot narrow anything. There is no such reading left, so a host
   * says what each object IS and where it lives rather than handing over a qualified name for
   * this package to split - which it may not do, since a table literally called `a.b` is
   * indistinguishable from `b` in `a` once either side is one string.
   *
   * This shell has no object routes of its own, so nothing here can fill the fields in on
   * the host's behalf: the standalone app reads `/api/db/objects/inventory` and this one
   * reads whatever the host returns.
   */
  onSchemaFetch: (connectionId: string) => Promise<readonly DetailedObject[]>;
  /**
   * The host's per-read object surface, which is what the object tree in the sidebar calls
   * (#789, B76). See `WorkspaceObjectReader` for why it is required and why it is not
   * `onSchemaFetch`.
   *
   * `onSchemaFetch` is NOT superseded by it and both are required: this one feeds the tree, and
   * the flat reading still feeds the ER diagram, the profiler, the code and test-data generators,
   * and the schema context the editor completes against.
   */
  onObjectsFetch: WorkspaceObjectReader;

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
