"use client";

import { useState, useCallback, useMemo } from "react";
import type { DatabaseConnection, TableSchema } from "@/lib/types";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";
import type { WorkspaceConnection } from "@/workspace/types";

interface UseConnectionAdapterParams {
  connections: WorkspaceConnection[];
  onSchemaFetch: (connectionId: string) => Promise<TableSchema[]>;
}

export function useConnectionAdapter({ connections: externalConnections, onSchemaFetch }: UseConnectionAdapterParams) {
  const connections: DatabaseConnection[] = useMemo(
    () =>
      externalConnections.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        createdAt: new Date(),
        managed: true,
      })),
    [externalConnections],
  );

  // The selection is held by ID, not by object, so it resolves against the host's
  // CURRENT list during render instead of being repaired by an effect one render
  // later. Holding the object also meant a host that renamed a connection in place
  // kept being served the captured one — the "still in the list?" test matched on
  // id, so nothing re-synced.
  const [activeConnectionId, setActiveConnectionId] = useState<string | null>(null);
  const [schema, setSchema] = useState<TableSchema[]>([]);
  const [isLoadingSchema, setIsLoadingSchema] = useState(false);

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

  const fetchSchema = useCallback(
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
    schemaContext,
  };
}
