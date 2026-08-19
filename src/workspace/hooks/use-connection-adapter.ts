"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
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

  const [activeConnection, setActiveConnection] = useState<DatabaseConnection | null>(connections[0] ?? null);
  const [schema, setSchema] = useState<TableSchema[]>([]);
  const [isLoadingSchema, setIsLoadingSchema] = useState(false);

  useEffect(() => {
    if (connections.length === 0) {
      setActiveConnection(null);
      return;
    }
    if (activeConnection && connections.some((c) => c.id === activeConnection.id)) {
      return;
    }
    setActiveConnection(connections[0]);
  }, [connections]); // eslint-disable-line react-hooks/exhaustive-deps

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
    setActiveConnection: setActiveConnection as (conn: DatabaseConnection | null) => void,
    schema,
    setSchema,
    isLoadingSchema,
    connectionPulse: null as "healthy" | "degraded" | "error" | null,
    fetchSchema,
    schemaContext,
  };
}
