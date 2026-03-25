'use client';

import { useState, useEffect } from 'react';
import type { DatabaseConnection } from '@/lib/types';
import { storage } from '@/lib/storage';

/**
 * Returns all connections: user connections from localStorage + managed seed connections from server.
 * Use this instead of storage.getConnections() in components that need the full list.
 *
 * This is a lightweight alternative to useConnectionManager — it only fetches and merges,
 * without active connection state, schema loading, or health checks.
 */
export function useAllConnections() {
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      const userConns = storage.getConnections();

      try {
        const res = await fetch('/api/connections/managed');
        if (res.ok) {
          const { connections: managedConns } = await res.json();
          if (managedConns?.length > 0 && !cancelled) {
            const merged: DatabaseConnection[] = [];
            const addedIds = new Set<string>();

            // Managed connections first
            for (const mc of managedConns) {
              merged.push({ ...mc, createdAt: new Date(mc.createdAt) });
              addedIds.add(mc.id);
              if (mc.seedId) addedIds.add(`seed:${mc.seedId}`);
            }

            // User connections (skip duplicates)
            for (const uc of userConns) {
              if (addedIds.has(uc.id)) continue;
              if (uc.seedId && managedConns.some((mc: { seedId: string }) => mc.seedId === uc.seedId)) continue;
              merged.push(uc);
            }

            setConnections(merged);
            setLoading(false);
            return;
          }
        }
      } catch {
        // Managed connections optional
      }

      if (!cancelled) {
        setConnections(userConns);
        setLoading(false);
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  return { connections, loading };
}
