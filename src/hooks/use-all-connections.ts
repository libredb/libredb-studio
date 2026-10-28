"use client";

import { appFetch } from "@/lib/config/base-path";
import { useState, useEffect } from "react";
import type { DatabaseConnection } from "@/lib/types";
import { storage } from "@/lib/storage";
import { connectionsUnderPolicy, readConnectionPolicy } from "@/lib/connection-policy";
import { managedRefreshIntervalMs } from "@/hooks/use-connection-manager";

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

    /** The cacheHint of an answer, which cadences its re-reads. */
    interface LoadAnswer {
      cacheHint: number | null;
    }

    /** Whether two values are equal, reading arrays and plain objects field by field. */
    const valueEquals = (a: unknown, b: unknown): boolean => {
      if (a === b) return true;
      if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
      if (Array.isArray(a) && Array.isArray(b)) {
        return a.length === b.length && a.every((item, i) => valueEquals(item, b[i]));
      }
      if (
        typeof a === "object" &&
        a !== null &&
        typeof b === "object" &&
        b !== null &&
        !(a instanceof Date) &&
        !(b instanceof Date) &&
        !Array.isArray(a) &&
        !Array.isArray(b)
      ) {
        const ka = Object.keys(a);
        const kb = Object.keys(b);
        return (
          ka.length === kb.length &&
          ka.every((key) => valueEquals((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
        );
      }
      return false;
    };

    /**
     * Whether two rows of the list carry the same data. The managed endpoint stamps every
     * discovered connection with a fresh `createdAt` on each projection, so for those rows
     * the timestamp is generation noise rather than data and is not compared; a user's own
     * row keeps its stored timestamp and compares it.
     */
    const rowEquals = (a: DatabaseConnection, b: DatabaseConnection): boolean => {
      const ka = Object.keys(a) as (keyof DatabaseConnection)[];
      const kb = Object.keys(b) as (keyof DatabaseConnection)[];
      if (ka.length !== kb.length) return false;
      return ka.every((key) => {
        if (key === "createdAt" && b.managed === true) return true;
        return valueEquals(a[key], b[key]);
      });
    };

    /**
     * Reuse a row of the previous list when the answer carries it unchanged, so consumers
     * that key effects on the connection object (the monitoring dashboard's data read, the
     * operations tab's catalogs) do not restart for a refresh that changed nothing. Rows are
     * matched by id, so a connection added, withdrawn or moved elsewhere in the list keeps
     * the surviving rows' identity; a row is reused only when every other field is equal,
     * so an updated name or endpoint still lands.
     */
    const reconcile = (previous: DatabaseConnection[], next: DatabaseConnection[]): DatabaseConnection[] => {
      if (previous.length === 0) return next;
      const byId = new Map(previous.map((row) => [row.id, row]));
      let unchanged = previous.length === next.length;
      const shared: DatabaseConnection[] = next.map((row) => {
        const prev = byId.get(row.id);
        if (prev !== undefined && rowEquals(prev, row)) return prev;
        unchanged = false;
        return row;
      });
      return unchanged ? previous : shared;
    };

    async function load(initial: boolean): Promise<LoadAnswer | undefined> {
      // The user's own connections the server would refuse (ALLOW_CUSTOM_CONNECTIONS) are left out
      // here as they are in the editor, so the admin pages, the monitoring page and the schema diff
      // never offer a connection that can only answer 403.
      const policy = await readConnectionPolicy();
      if (cancelled) return undefined;
      const userConns = connectionsUnderPolicy(storage.getConnections(), policy);
      const dismissed = new Set(storage.getDismissedSeeds());

      try {
        const res = await appFetch("/api/connections/managed");
        if (res.ok && !cancelled) {
          const { connections: managedConns, cacheHint } = await res.json();
          if (cancelled) return undefined;
          const hint = typeof cacheHint === "number" && Number.isFinite(cacheHint) ? cacheHint : null;
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

            setConnections((prev) => reconcile(initial ? [] : prev, merged));
            setLoading(false);
            return { cacheHint: hint };
          }
        }
      } catch {
        // Managed connections optional
      }

      // The first load falls back to the user's own list; a refresh does not, so a
      // transient failure keeps the last list the first load produced (#2020).
      if (!cancelled && initial) {
        setConnections(userConns);
        setLoading(false);
      }
      return undefined;
    }

    // The managed list after the first load (#2020), one read at a time like the editor
    // hook's refresh: a trigger that arrives while a read is in flight is absorbed by it,
    // and a refresh only runs while the document is visible. It reads quietly: a refresh
    // that fails changes nothing, because `load` only writes state on a successful read.
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    let refreshInFlight = false;

    const refresh = () => {
      if (cancelled || refreshInFlight || document.visibilityState !== "visible") return;
      refreshInFlight = true;
      load(false)
        .catch(() => {
          // Silent — same contract as the initial managed fetch.
        })
        .finally(() => {
          refreshInFlight = false;
        });
    };

    const startRefresh = (cacheHint: number | null) => {
      refreshTimer = setInterval(refresh, managedRefreshIntervalMs(cacheHint));
      window.addEventListener("focus", refresh);
      document.addEventListener("visibilitychange", refresh);
    };

    // The interval starts on the first answer's cacheHint, the same signal the editor hook
    // uses: before that there is no list to refresh and no hint to cadence it by.
    let firstAnswerStarted = false;
    const initialLoad = async () => {
      const answer = await load(true);
      if (!firstAnswerStarted && !cancelled) {
        firstAnswerStarted = true;
        startRefresh(answer?.cacheHint ?? null);
      }
    };

    initialLoad();

    return () => {
      cancelled = true;
      if (refreshTimer !== null) clearInterval(refreshTimer);
      refreshTimer = null;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  return { connections, loading };
}
