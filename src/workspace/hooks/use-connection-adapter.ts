'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { DatabaseConnection, TableSchema } from '@/lib/types';
import type { WorkspaceConnection } from '@/workspace/types';

interface UseConnectionAdapterParams {
  connections: WorkspaceConnection[];
  onSchemaFetch: (connectionId: string) => Promise<TableSchema[]>;
}

export function useConnectionAdapter({
  connections: externalConnections,
  onSchemaFetch,
}: UseConnectionAdapterParams) {
  const connections: DatabaseConnection[] = useMemo(
    () =>
      externalConnections.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        createdAt: new Date(),
        managed: true,
      })),
    [externalConnections]
  );

  const [activeConnection, setActiveConnection] = useState<DatabaseConnection | null>(
    connections[0] ?? null
  );
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
    [onSchemaFetch]
  );

  const tableNames = useMemo(() => schema.map((s) => s.name), [schema]);
  const schemaContext = useMemo(() => JSON.stringify(schema), [schema]);

  return {
    connections,
    setConnections: (() => {}) as React.Dispatch<React.SetStateAction<DatabaseConnection[]>>,
    activeConnection,
    setActiveConnection: setActiveConnection as (conn: DatabaseConnection | null) => void,
    schema,
    setSchema,
    isLoadingSchema,
    connectionPulse: null as 'healthy' | 'degraded' | 'error' | null,
    fetchSchema,
    tableNames,
    schemaContext,
  };
}
