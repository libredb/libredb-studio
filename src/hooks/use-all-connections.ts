"use client";

import { appFetch } from "@/lib/config/base-path";
import { useState, useEffect } from "react";
import type { DatabaseConnection } from "@/lib/types";
import { storage } from "@/lib/storage";
import { connectionsUnderPolicy, readConnectionPolicy } from "@/lib/connection-policy";

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
      // The user's own connections the server would refuse (ALLOW_CUSTOM_CONNECTIONS) are left out
      // here as they are in the editor, so the admin pages, the monitoring page and the schema diff
      // never offer a connection that can only answer 403.
      const policy = await readConnectionPolicy();
      const userConns = connectionsUnderPolicy(storage.getConnections(), policy);
      const dismissed = new Set(storage.getDismissedSeeds());

      try {
        const res = await appFetch("/api/connections/managed");
        if (res.ok) {
          const { connections: managedConns } = await res.json();
          if (managedConns?.length > 0 && !cancelled) {
            const merged: DatabaseConnection[] = [];
            const addedIds = new Set<string>();

            // Managed connections first
            for (const mc of managedConns) {
              if (mc.managed === false && mc.seedId && dismissed.has(mc.seedId)) continue;
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
    return () => {
      cancelled = true;
    };
  }, []);

  return { connections, loading };
}
