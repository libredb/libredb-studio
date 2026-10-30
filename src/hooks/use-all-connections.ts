"use client";

import { appFetch } from "@/lib/config/base-path";
import { useState, useEffect } from "react";
import type { DatabaseConnection } from "@/lib/types";
import { storage } from "@/lib/storage";
import { connectionsUnderPolicy, readConnectionPolicy, type ConnectionPolicy } from "@/lib/connection-policy";
import { ApiErrorCode } from "@/lib/api/error-codes";
import { startManagedListRefresh } from "@/lib/connection-refresh";
import { reconcileConnections } from "@/lib/connection-reconcile";

/**
 * Returns all connections: user connections from localStorage + managed seed connections from server.
 * Use this instead of storage.getConnections() in components that need the full list.
 *
 * This is a lightweight alternative to useConnectionManager — it only fetches and merges,
 * without active connection state, schema loading, or health checks.
 *
 * The managed list is read again while the hook stays mounted, with the editor hook's own
 * cadence (#1502): every max(cacheHint, floor) ms capped at a minute, only while the tab is
 * visible, and at once when the window regains focus or the document becomes visible (#2020).
 * A discovered database therefore appears in the admin pages, the monitoring page and the
 * schema diff without a page reload, and a withdrawn one disappears. A refresh that fails
 * changes nothing: the last list stays.
 */
export function useAllConnections() {
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    /** The first read decides whether to refresh and supplies the interval's cacheHint. */
    interface LoadAnswer {
      cacheHint: number | null;
      answered: boolean;
      unavailable: boolean;
    }

    async function load(initial: boolean, policy: ConnectionPolicy): Promise<LoadAnswer> {
      // The user's own connections the server would refuse (ALLOW_CUSTOM_CONNECTIONS) are left out
      // here as they are in the editor, so the admin pages, the monitoring page and the schema diff
      // never offer a connection that can only answer 403.
      const userConns = connectionsUnderPolicy(storage.getConnections(), policy);
      const dismissed = new Set(storage.getDismissedSeeds());
      const answer: LoadAnswer = { answered: false, unavailable: false, cacheHint: null };

      try {
        const res = await appFetch("/api/connections/managed");
        if (res.ok && !cancelled) {
          const { connections: managedConns, cacheHint } = (await res.json()) ?? {};
          if (cancelled) return answer;
          answer.answered = true;
          answer.cacheHint = typeof cacheHint === "number" && Number.isFinite(cacheHint) ? cacheHint : null;
          if (Array.isArray(managedConns)) {
            const merged: DatabaseConnection[] = [];
            const addedIds = new Set<string>();

            // Managed connections first. An empty answer is an answer too: the server withdrew
            // every managed entry, so what remains is the user's own list.
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

            setConnections((prev) => reconcileConnections(initial ? [] : prev, merged));
            setLoading(false);
            return answer;
          }
        } else if (res.status === 503) {
          const body = await res.json().catch(() => null);
          answer.unavailable = body?.code === ApiErrorCode.GOVERNANCE_UNAVAILABLE;
        }
      } catch (error) {
        // The first read is optional; refresh failures reach the shared lifecycle's logger.
        if (!initial) throw error;
      }

      // The first load falls back to the user's own list; a refresh does not, so a
      // transient failure keeps the last list the first load produced (#2020).
      if (!cancelled && initial) {
        setConnections(userConns);
        setLoading(false);
      }
      return answer;
    }

    let stopRefresh: (() => void) | undefined;

    // Read the policy once per mount, as the editor does. Only an answered first read or
    // 503 GOVERNANCE_UNAVAILABLE starts refreshes, using that read's cacheHint throughout.
    const initialLoad = async () => {
      const policy = await readConnectionPolicy();
      if (cancelled) return;
      const answer = await load(true, policy);
      if (!cancelled) {
        stopRefresh = startManagedListRefresh({
          ...answer,
          refresh: async () => {
            await load(false, policy);
          },
        });
      }
    };

    initialLoad();

    return () => {
      cancelled = true;
      stopRefresh?.();
    };
  }, []);

  return { connections, loading };
}
