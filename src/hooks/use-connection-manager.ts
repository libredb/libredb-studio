"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import type { DatabaseConnection, TableSchema, TableRelations } from "@/lib/types";
import { useToast } from "@/hooks/use-toast";
import { storage } from "@/lib/storage";
import { logger } from "@/lib/logger";
import { buildConnectionPayload } from "./use-connection-payload";

/** Managed connections as serialized by GET /api/connections/managed. */
type ManagedConnectionPayload = Omit<DatabaseConnection, "createdAt"> & { createdAt: string; seedId?: string };

/** Pending-seed poll: 1s ticks, give up after 30. NEXT_PUBLIC_MANAGED_POLL_MS
 * shortens the tick in source builds and tests only — NEXT_PUBLIC_ values are
 * inlined at build time, so packaged artifacts always use the default. */
const MANAGED_POLL_MAX_ATTEMPTS = 30;

export function useConnectionManager(storageReady = false) {
  const [connections, setConnections] = useState<DatabaseConnection[]>([]);
  const [activeConnection, setActiveConnection] = useState<DatabaseConnection | null>(null);
  const [schema, setSchema] = useState<TableSchema[]>([]);
  const [isLoadingSchema, setIsLoadingSchema] = useState(false);
  const [connectionPulse, setConnectionPulse] = useState<"healthy" | "degraded" | "error" | null>(null);

  const { toast } = useToast();

  // Fetch schema for a connection — two phases so a slow/failing stats query
  // never blocks the table list:
  //   1. /api/db/schema/list      → tables + columns + PKs (fast)  → render tree
  //   2. /api/db/schema/relations → foreign keys + indexes (heavy) → async merge
  const fetchSchema = useCallback(
    async (conn: DatabaseConnection) => {
      setIsLoadingSchema(true);

      const payload = conn.managed && conn.seedId ? { connectionId: `seed:${conn.seedId}` } : conn; // bare conn for backward compat with schema route
      const init = (path: string): [string, RequestInit] => [
        path,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) },
      ];

      // Phase 1 — structural list (blocks; this is what the explorer needs)
      try {
        const response = await fetch(...init("/api/db/schema/list"));
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.error || "Failed to fetch schema");
        }
        const list: TableSchema[] = await response.json();
        setSchema(list);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        toast({ title: "Schema Error", description: errorMessage, variant: "destructive" });
        return; // finally still clears the loading flag; skip relations
      } finally {
        setIsLoadingSchema(false);
      }

      // Phase 2 — relationships + indexes (best-effort; never breaks the list)
      try {
        const relRes = await fetch(...init("/api/db/schema/relations"));
        if (!relRes.ok) {
          const errorData = await relRes.json().catch(() => ({}));
          throw new Error(errorData.error || "Failed to fetch schema relations");
        }
        const relations: TableRelations[] = await relRes.json();
        const byName = new Map(relations.map((r) => [r.name, r]));
        setSchema((prev) =>
          prev.map((t) => {
            const r = byName.get(t.name);
            return r ? { ...t, foreignKeys: r.foreignKeys, indexes: r.indexes } : t;
          }),
        );
      } catch (error) {
        // Foreign keys / indexes are non-essential for browsing — log and move on.
        logger.error("Failed to load schema relations (FK/indexes); table list unaffected", {
          route: "use-connection-manager",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [toast],
  );

  // Memoized derived values
  const tableNames = useMemo(() => schema.map((s) => s.name), [schema]);
  const schemaContext = useMemo(() => JSON.stringify(schema), [schema]);

  // Initialize connections once storage sync is ready
  useEffect(() => {
    if (!storageReady) return;

    let cancelled = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const stopPoll = () => {
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    // Merge the server's managed (seed) connections with the user's own,
    // persisting editable copies of new seeds. Used by the initial fetch AND
    // the pending-seed poll below, so both produce identical lists.
    const mergeManagedConnections = (managedConns: ManagedConnectionPayload[]): DatabaseConnection[] => {
      const userConns = storage.getConnections();
      const dismissed = new Set(storage.getDismissedSeeds());
      const merged: DatabaseConnection[] = [];

      // Add managed:true connections (always from server)
      for (const mc of managedConns) {
        if (mc.managed) {
          merged.push({ ...mc, createdAt: new Date(mc.createdAt) });
        } else {
          // managed:false — editable user copy
          if (mc.seedId && dismissed.has(mc.seedId)) continue; // user deleted it; do not re-add
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
      const seedIds = new Set(managedConns.map((mc) => mc.seedId));
      const mergedIds = new Set(merged.map((c) => c.id));
      for (const uc of userConns) {
        // Skip if this user connection came from a seed (by seedId or id match)
        if (uc.seedId && seedIds.has(uc.seedId)) continue;
        if (mergedIds.has(uc.id)) continue;
        merged.push(uc);
      }

      return merged;
    };

    const fetchManaged = async (): Promise<{
      merged: DatabaseConnection[] | null;
      pendingSeeds: string[];
      failed: boolean;
    }> => {
      const managedRes = await fetch("/api/connections/managed");
      // A non-OK response is a transient failure, NOT "nothing pending" — the
      // poll below must keep retrying (bounded by its attempt budget) instead
      // of treating it as an authoritative empty pendingSeeds.
      if (!managedRes.ok) return { merged: null, pendingSeeds: [], failed: true };
      const { connections: managedConns, pendingSeeds } = (await managedRes.json()) as {
        connections?: ManagedConnectionPayload[];
        pendingSeeds?: string[];
      };
      return {
        merged: managedConns && managedConns.length > 0 ? mergeManagedConnections(managedConns) : null,
        pendingSeeds: pendingSeeds ?? [],
        failed: false,
      };
    };

    // A seed being created asynchronously on the server (e.g. the SQLite
    // sample file copy at boot) is advertised via pendingSeeds. Poll quietly
    // until it appears so the sample shows up without a page refresh; give up
    // after the attempt budget and never surface errors — the sample is a
    // nicety, not a dependency.
    const startSeedPoll = (pendingSeeds: string[]) => {
      const dismissed = new Set(storage.getDismissedSeeds());
      if (!pendingSeeds.some((seedId) => !dismissed.has(seedId))) return;

      const pollMs = Number(process.env.NEXT_PUBLIC_MANAGED_POLL_MS) || 1000;
      let attempts = 0;
      let inFlight = false;
      pollTimer = setInterval(() => {
        if (inFlight) return;
        inFlight = true;
        attempts += 1;
        fetchManaged()
          .then(({ merged, pendingSeeds: stillPending, failed }) => {
            if (cancelled) return;
            if (merged) {
              setConnections(merged);
              setActiveConnection((prev) => prev ?? merged[0] ?? null);
            }
            if (failed) return; // transient HTTP failure — keep polling until the attempt budget runs out
            const dismissedNow = new Set(storage.getDismissedSeeds());
            if (!stillPending.some((seedId) => !dismissedNow.has(seedId))) stopPoll();
          })
          .catch(() => {
            // Silent — same contract as the initial managed fetch.
          })
          .finally(() => {
            inFlight = false;
            if (attempts >= MANAGED_POLL_MAX_ATTEMPTS) stopPoll();
          });
      }, pollMs);
    };

    const initializeConnections = async () => {
      const loadedConnections = storage.getConnections();

      // Fetch managed (seed) connections
      let managedMerged = false;
      try {
        const { merged, pendingSeeds } = await fetchManaged();
        if (cancelled) return;
        if (merged) {
          setConnections(merged);
          managedMerged = true;

          if (merged.length > 0) {
            const savedId = storage.getActiveConnectionId();
            const saved = savedId ? merged.find((c: DatabaseConnection) => c.id === savedId) : null;
            setActiveConnection(saved ?? merged[0]);
          }
        }
        startSeedPoll(pendingSeeds);
      } catch {
        // Managed connections are optional — don't break app. Deliberately NO
        // speculative seed poll when this initial fetch fails (rejection here,
        // or failed:true reaching startSeedPoll as empty pendingSeeds): when
        // embedded in libredb-platform this endpoint does not exist, and
        // polling on failure would fire up to 30 useless requests per mount.
        // A transient boot-time failure is rare (this same server just served
        // the page) and self-heals on refresh; the failure tolerance inside
        // the poll only guards the window where a pending seed was actually
        // observed.
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
      logger.warn("Connection initialization failed", {
        route: "use-connection-manager",
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return () => {
      cancelled = true;
      stopPoll();
    };
  }, [storageReady]);

  // Persist active connection ID
  useEffect(() => {
    if (activeConnection) {
      storage.setActiveConnectionId(activeConnection.id);
    }
  }, [activeConnection]);

  // Connection pulse — quick health check every 60s
  useEffect(() => {
    if (!activeConnection) {
      setConnectionPulse(null);
      return;
    }
    const checkHealth = async () => {
      try {
        const res = await fetch("/api/db/health", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(buildConnectionPayload(activeConnection)),
        });
        setConnectionPulse(res.ok ? "healthy" : "degraded");
      } catch {
        setConnectionPulse("error");
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
