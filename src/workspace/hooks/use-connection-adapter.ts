"use client";

import { useState, useCallback, useMemo } from "react";
import type { DatabaseConnection } from "@/lib/types";
import type { DetailedObject } from "@/lib/db/detailed-object";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import type { ObjectSource } from "@/components/object-tree";
import type { WorkspaceConnection, WorkspaceObjectReader } from "@/workspace/types";

interface UseConnectionAdapterParams {
  connections: WorkspaceConnection[];
  onSchemaFetch: (connectionId: string) => Promise<readonly DetailedObject[]>;
  onObjectsFetch: WorkspaceObjectReader;
}

export function useConnectionAdapter({
  connections: externalConnections,
  onSchemaFetch,
  onObjectsFetch,
}: UseConnectionAdapterParams) {
  const connections: DatabaseConnection[] = useMemo(
    () =>
      externalConnections.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        createdAt: new Date(),
        managed: true,
        // A hand-written field list, so a host field this forgets is dropped in silence.
        // Forgetting this one reads the catalog the host asked it not to (#765).
        skipObjectScan: c.skipObjectScan,
      })),
    [externalConnections],
  );

  // The selection is held by ID, not by object, so it resolves against the host's
  // CURRENT list during render instead of being repaired by an effect one render
  // later. Holding the object also meant a host that renamed a connection in place
  // kept being served the captured one — the "still in the list?" test matched on
  // id, so nothing re-synced.
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null);
  const [schema, setSchema] = useState<readonly DetailedObject[]>([]);
  const [isLoadingSchema, setIsLoadingSchema] = useState(false);
  /** The connection whose deferred catalog read the user has explicitly asked for, by id. */
  const [scanRequested, setScanRequested] = useState<string | null>(null);

  // Resolution is by id ONLY — no positional tail. An embedded shell still shows
  // the host's first connection when nothing has been chosen yet, but that fallback
  // is resolved once and then HELD as the id below, because re-resolving it
  // positionally on every render let the host move the selection: prepend or
  // reorder the list and the editor silently points at a database nobody picked,
  // with a schema re-fetch behind it (StudioWorkspace keys that fetch on
  // `activeConnection?.id`).
  const activeConnection = useMemo(
    () => connections.find((c) => c.id === activeConnectionId) ?? null,
    [connections, activeConnectionId],
  );

  // React's documented adjust-state-while-rendering guard (react.dev, "You Might
  // Not Need an Effect" — adjusting some state when a prop changes). It commits
  // the fallback for both ways the id can fail to resolve: nothing chosen yet, and
  // the chosen connection dropped by the host. It terminates — the id it commits
  // comes from the very list it just failed against, so the next pass resolves —
  // and an empty list falls straight through, leaving `activeConnection` null.
  if (!activeConnection && connections.length > 0) {
    setActiveConnectionId(connections[0].id);
  }

  const setActiveConnection = useCallback((conn: DatabaseConnection | null) => {
    setActiveConnectionId(conn?.id ?? null);
  }, []);

  const readSchema = useCallback(
    async (conn: DatabaseConnection) => {
      setIsLoadingSchema(true);
      try {
        const result = await onSchemaFetch(conn.id);
        setSchema(result);
      } catch {
        setSchema([]);
      } finally {
        setIsLoadingSchema(false);
      }
    },
    [onSchemaFetch],
  );

  /**
   * Whether THIS connection's catalog reads are deferred right now (#765).
   *
   * The same rule as `src/hooks/use-connection-manager.ts`, written again rather than
   * shared, because these two hooks share no state and no request layer: one reads the
   * studio's own routes and the other calls back into the host. What is shared is the
   * FIELD, and the reader's request is held here too as the connection's id rather than as
   * a boolean, so the next deferred connection is not already loaded.
   */
  const scanDeferred = useCallback(
    (conn: DatabaseConnection) => conn.skipObjectScan === true && scanRequested !== conn.id,
    [scanRequested],
  );

  const fetchSchema = useCallback(
    async (conn: DatabaseConnection) => {
      if (scanDeferred(conn)) {
        // Nothing was read for THIS connection, so the previous one's tables may not stay
        // on screen under its name (D31). `readSchema` is the only other writer.
        setSchema([]);
        return;
      }
      await readSchema(conn);
    },
    [readSchema, scanDeferred],
  );

  /** Read what opening this connection would have read, because the user asked. */
  const loadObjects = useCallback(() => {
    if (activeConnection === null) return;
    setScanRequested(activeConnection.id);
    void readSchema(activeConnection);
  }, [activeConnection, readSchema]);

  /**
   * What the object tree reads through, in this shell (#789, B76).
   *
   * The tree's own default posts to `/api/db/objects/*`, and this package ships no such route:
   * that path belongs to whatever server the host mounted the workspace in, and the connection
   * built above carries no host, port or file path for it to open anyway. So each read is
   * translated into the host's own call, one lazy read at a time.
   *
   * The connection arrives as an ARGUMENT rather than through the closure, which is what keeps
   * this value stable across renders: the tree re-issues its reads whenever its source changes
   * identity, so a source rebuilt per render would read for ever.
   */
  const objectSource = useMemo<ObjectSource>(
    () => (conn, request) => {
      switch (request.route) {
        case "containers":
          return onObjectsFetch.listContainers(conn.id, request.parent);
        case "counts":
          return onObjectsFetch.countObjects(conn.id, request.container);
        case "list":
          return onObjectsFetch.listObjects(conn.id, request.container, request.kind);
      }
    },
    [onObjectsFetch],
  );

  const schemaContext = useMemo(() => JSON.stringify(schema), [schema]);

  // The embedded shell's stand-in for `useProviderMetadata`: it has no
  // `/api/db/provider-meta` of its own and holds no credentials to describe, so
  // the host declares each connection's capabilities and wording alongside it
  // (#427). Absent stays `null` — the same value this hook returned before the
  // fields existed, which every consumer already reads as "provider unknown".
  const metadata = useMemo<ProviderMetadata | null>(() => {
    const declared = externalConnections.find((c) => c.id === activeConnection?.id);
    if (!declared?.capabilities) return null;
    // `labels` is optional for the host on purpose: every consumer reads it
    // through `?.` and falls back to its own base wording, so a host that only
    // knows the capabilities does not have to restate fifteen strings. It is
    // optional on `ProviderMetadata` too, so this passes it through as-is rather
    // than casting `undefined` into a field declared required.
    return { capabilities: declared.capabilities, labels: declared.labels };
  }, [externalConnections, activeConnection]);

  return {
    metadata,
    connections,
    setConnections: (() => {}) as React.Dispatch<React.SetStateAction<DatabaseConnection[]>>,
    activeConnection,
    setActiveConnection,
    schema,
    setSchema,
    isLoadingSchema,
    connectionPulse: null as "healthy" | "degraded" | "error" | null,
    fetchSchema,
    /** Whether the active connection is holding its catalog reads back. */
    objectScanDeferred: activeConnection !== null && scanDeferred(activeConnection),
    loadObjects,
    objectSource,
    schemaContext,
  };
}
