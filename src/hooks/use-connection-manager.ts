'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import type { DatabaseConnection, TableSchema } from '@/lib/types';
import { useToast } from '@/hooks/use-toast';
import { storage } from '@/lib/storage';
import { logger } from '@/lib/logger';
import { buildConnectionPayload } from './use-connection-payload';

export function useConnectionManager(storageReady = false) {
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [activeConnection, setActiveConnection] = useState<DatabaseConnection | null>(null);
  const [schema, setSchema] = useState<TableSchema[]>([]);
  const [isLoadingSchema, setIsLoadingSchema] = useState(false);
  const [connectionPulse, setConnectionPulse] = useState<'healthy' | 'degraded' | 'error' | null>(null);

  const { toast } = useToast();

  // Fetch schema for a connection
  const fetchSchema = useCallback(async (conn: DatabaseConnection) => {
    setIsLoadingSchema(true);

    if (conn.isDemo) {
      console.log('[DemoDB] Fetching schema for demo connection:', conn.name);
    }

    try {
      const payload = conn.managed && conn.seedId
        ? { connectionId: `seed:${conn.seedId}` }
        : conn;  // bare conn for backward compat with schema route
      const response = await fetch('/api/db/schema', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const errorMessage = errorData.error || 'Failed to fetch schema';

        if (conn.isDemo) {
          console.error('[DemoDB] Schema fetch failed:', errorMessage);
          throw new Error(`Demo database unavailable: ${errorMessage}. You can add your own database connection.`);
        }
        throw new Error(errorMessage);
      }

      const data = await response.json();

      if (conn.isDemo) {
        console.log('[DemoDB] Schema loaded successfully:', {
          tables: data.length,
          tableNames: data.slice(0, 5).map((t: TableSchema) => t.name),
        });
      }

      setSchema(data);
    } catch (error) {
      const title = conn.isDemo ? "Demo Database Error" : "Schema Error";
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      toast({ title, description: errorMessage, variant: "destructive" });
    } finally {
      setIsLoadingSchema(false);
    }
  }, [toast]);

  // Memoized derived values
  const tableNames = useMemo(() => schema.map(s => s.name), [schema]);
  const schemaContext = useMemo(() => JSON.stringify(schema), [schema]);

  // Initialize connections once storage sync is ready
  useEffect(() => {
    if (!storageReady) return;

    const initializeConnections = async () => {
      const LOG_PREFIX = '[DemoDB]';
      const loadedConnections = storage.getConnections();

      // Fetch demo connection from server
      try {
        console.log(`${LOG_PREFIX} Checking for demo connection...`);
        const res = await fetch('/api/demo-connection');

        if (res.ok) {
          const data = await res.json();

          if (data.enabled && data.connection) {
            const demoConn = {
              ...data.connection,
              createdAt: new Date(data.connection.createdAt),
            };

            // Check if demo connection already exists (by id or isDemo flag)
            const existingDemo = loadedConnections.find(
              (c: DatabaseConnection) => c.id === demoConn.id || (c.isDemo && c.type === 'postgres')
            );

            if (existingDemo) {
              // Update existing demo connection (credentials may have changed)
              console.log(`${LOG_PREFIX} Updating existing demo connection:`, {
                id: existingDemo.id,
                name: demoConn.name,
              });
              const updatedDemo = { ...demoConn, id: existingDemo.id };
              storage.saveConnection(updatedDemo);
              const updatedConnections = storage.getConnections();
              setConnections(updatedConnections);

              // Restore persisted active connection, fallback to first
              if (updatedConnections.length > 0) {
                const savedId = storage.getActiveConnectionId();
                const saved = savedId ? updatedConnections.find((c: DatabaseConnection) => c.id === savedId) : null;
                setActiveConnection(saved ?? updatedConnections[0]);
              }
            } else {
              // Add new demo connection
              console.log(`${LOG_PREFIX} Adding new demo connection:`, {
                id: demoConn.id,
                name: demoConn.name,
                database: demoConn.database,
              });
              storage.saveConnection(demoConn);
              const updatedConnections = storage.getConnections();
              setConnections(updatedConnections);

              // Restore persisted active connection, fallback to demo if no others
              const savedId = storage.getActiveConnectionId();
              const saved = savedId ? updatedConnections.find((c: DatabaseConnection) => c.id === savedId) : null;
              if (loadedConnections.length === 0) {
                console.log(`${LOG_PREFIX} Auto-selecting demo as active connection (no other connections)`);
                setActiveConnection(saved ?? demoConn);
              } else {
                setActiveConnection(saved ?? updatedConnections[0]);
              }
            }
            return;
          } else {
            console.log(`${LOG_PREFIX} Demo connection not enabled or not configured`);
          }
        } else {
          console.warn(`${LOG_PREFIX} API returned non-ok status:`, res.status);
        }
      } catch {
        logger.warn('Failed to fetch demo connection', { route: 'use-connection-manager' });
      }

      // Fetch managed (seed) connections
      let managedMerged = false;
      try {
        const managedRes = await fetch('/api/connections/managed');
        if (managedRes.ok) {
          const { connections: managedConns } = await managedRes.json();
          if (managedConns?.length > 0) {
            const userConns = storage.getConnections();
            const merged: DatabaseConnection[] = [];

            // Add managed:true connections (always from server)
            for (const mc of managedConns) {
              if (mc.managed) {
                merged.push({ ...mc, createdAt: new Date(mc.createdAt) });
              } else {
                // managed:false — check if already copied (by seedId)
                const existingCopy = userConns.find((uc: DatabaseConnection) => uc.seedId === mc.seedId);
                if (existingCopy) {
                  merged.push(existingCopy);
                } else {
                  const userCopy: DatabaseConnection = { ...mc, createdAt: new Date(mc.createdAt), managed: false };
                  storage.saveConnection(userCopy);
                  merged.push(userCopy);
                }
              }
            }

            // Add remaining user connections (not from seeds)
            const seedIds = new Set(managedConns.map((mc: { seedId: string }) => mc.seedId));
            for (const uc of userConns) {
              if (!uc.seedId || !seedIds.has(uc.seedId)) {
                merged.push(uc);
              }
            }

            setConnections(merged);
            managedMerged = true;

            if (merged.length > 0) {
              const savedId = storage.getActiveConnectionId();
              const saved = savedId ? merged.find((c: DatabaseConnection) => c.id === savedId) : null;
              setActiveConnection(saved ?? merged[0]);
            }
          }
        }
      } catch {
        // Managed connections are optional — don't break app
      }

      if (!managedMerged) {
        setConnections(loadedConnections);
        if (loadedConnections.length > 0) {
          const savedId = storage.getActiveConnectionId();
          const saved = savedId ? loadedConnections.find((c: DatabaseConnection) => c.id === savedId) : null;
          setActiveConnection(saved ?? loadedConnections[0]);
        }
      }
    };

    initializeConnections().catch((err) => {
      logger.warn('Connection initialization failed', { route: 'use-connection-manager', error: err instanceof Error ? err.message : String(err) });
    });
  }, [storageReady]);  

  // Persist active connection ID
  useEffect(() => {
    if (activeConnection) {
      storage.setActiveConnectionId(activeConnection.id);
    }
  }, [activeConnection]);

  // Connection pulse — quick health check every 60s
  useEffect(() => {
    if (!activeConnection || activeConnection.isDemo) {
      setConnectionPulse(null);
      return;
    }
    const checkHealth = async () => {
      try {
        const res = await fetch('/api/db/health', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildConnectionPayload(activeConnection)),
        });
        setConnectionPulse(res.ok ? 'healthy' : 'degraded');
      } catch {
        setConnectionPulse('error');
      }
    };
    checkHealth().catch(() => {});
    const interval = setInterval(checkHealth, 60000);
    return () => clearInterval(interval);
  }, [activeConnection]);

  return {
    connections,
    setConnections,
    activeConnection,
    setActiveConnection,
    schema,
    setSchema,
    isLoadingSchema,
    connectionPulse,
    fetchSchema,
    tableNames,
    schemaContext,
  };
}
