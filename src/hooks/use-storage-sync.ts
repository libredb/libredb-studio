"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import {
  storage,
  type StorageConfigResponse,
  type StorageChangeDetail,
  type StorageData,
  STORAGE_COLLECTIONS,
} from "@/lib/storage";
import { logger } from "@/lib/logger";

const MIGRATION_FLAG = "libredb_server_migrated";
const DEBOUNCE_MS = 500;
/** First retry delay after a failed push; doubles per consecutive failure. */
const RETRY_BASE_MS = 1000;
/** Ceiling for the backoff, so a long outage settles into a slow poll. */
const RETRY_MAX_MS = 30_000;

export interface StorageSyncState {
  isServerMode: boolean;
  isSyncing: boolean;
  isReady: boolean;
  lastSyncedAt: Date | null;
  syncError: string | null;
}

/**
 * Write-through cache sync hook.
 * Mounts in Studio.tsx after useAuth.
 *
 * - Discovers storage mode via GET /api/storage/config
 * - In server mode: pulls data on mount, pushes mutations (debounced)
 * - Handles first-login migration from localStorage to server
 * - Graceful degradation: if server unreachable, localStorage continues
 */
export function useStorageSync(): StorageSyncState {
  const [isServerMode, setIsServerMode] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * The retry timer is NOT the debounce timer.
   *
   * They overlap: a push takes as long as the network does, and the user keeps
   * typing while it is in flight, so by the time a failure comes back the
   * debounce slot usually holds a fresh 500ms timer for whatever they just
   * edited. Sharing one ref made the retry clear that timer and put its own
   * backoff — up to 30s — in its place, so a single failed push could hold a
   * later, unrelated, perfectly healthy edit off the server for half a minute.
   */
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCollectionsRef = useRef<Set<string>>(new Set());
  const retryDelayRef = useRef(RETRY_BASE_MS);
  const serverModeRef = useRef(false);
  /**
   * Whether this hook is still mounted. A push that is in flight when the user
   * navigates away resolves AFTER teardown, and the failure branch would arm a
   * timer no cleanup can reach — leaving a dead hook retrying, forever, on a
   * backoff that settles at one request every 30 seconds.
   */
  const mountedRef = useRef(true);

  // Self-reference so a failed flush can schedule the next one without
  // `flushPending` and `schedulePush` depending on each other.
  const flushPendingRef = useRef<() => void>(() => {});

  // ── Flush pending collections ──
  const flushPending = useCallback(async () => {
    // Declared inside the flush rather than as its own `useCallback`: it has
    // exactly one caller, and hoisting it only bought this memo a dependency
    // that could never change. It closes over nothing but refs, module-level
    // helpers and stable setters, so a fresh closure per flush costs one
    // allocation per debounce window and can hold nothing stale.
    /** Resolves to whether the collection actually reached the server. */
    const pushToServer = async (collection: string, data: unknown): Promise<boolean> => {
      try {
        const res = await fetch(`/api/storage/${collection}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${res.status}`);
        }
        setLastSyncedAt(new Date());
        setSyncError(null);
        return true;
      } catch (err) {
        logger.warn("StorageSync push failed", { collection, error: err instanceof Error ? err.message : String(err) });
        setSyncError(err instanceof Error ? err.message : "Sync failed");
        return false;
      }
    };

    const collections = Array.from(pendingCollectionsRef.current);
    pendingCollectionsRef.current.clear();
    if (collections.length === 0) return;

    setIsSyncing(true);
    try {
      const outcomes = await Promise.all(
        collections.map(async (col) => [col, await pushToServer(col, getCollectionData(col))] as const),
      );

      // A collection that failed to push is still only in localStorage. Putting
      // it back in the queue is what keeps the write recoverable — without this
      // it stays local until the user happens to mutate that same collection
      // again, which for a one-off edit is never.
      const failed = outcomes.filter(([, ok]) => !ok).map(([col]) => col);
      if (failed.length > 0) {
        for (const col of failed) {
          pendingCollectionsRef.current.add(col);
        }
        // Requeued above regardless, so the write is still recoverable if this
        // hook mounts again; what must not happen is arming a timer after
        // teardown, when nothing is left to clear it.
        if (!mountedRef.current) return;
        if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
        const delay = retryDelayRef.current;
        retryDelayRef.current = Math.min(delay * 2, RETRY_MAX_MS);
        retryTimerRef.current = setTimeout(() => flushPendingRef.current(), delay);
      } else {
        retryDelayRef.current = RETRY_BASE_MS;
      }
    } finally {
      setIsSyncing(false);
    }
  }, []);

  // Filled after commit, never during render: React forbids writing `ref.current`
  // while rendering, and the ref's only reader — the retry timer armed inside
  // `flushPending` — cannot fire before the first commit, so it never sees the
  // placeholder. Keyed on `flushPending` so the ref re-syncs if it ever becomes
  // reactive again.
  useEffect(() => {
    flushPendingRef.current = flushPending;
  }, [flushPending]);

  // ── Schedule debounced push ──
  const schedulePush = useCallback(
    (collection: string) => {
      pendingCollectionsRef.current.add(collection);
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        flushPending();
      }, DEBOUNCE_MS);
    },
    [flushPending],
  );

  // ── Pull all data from server → localStorage ──
  const pullFromServer = useCallback(async () => {
    setIsSyncing(true);
    try {
      const res = await fetch("/api/storage");
      if (!res.ok) return;
      const data = (await res.json()) as Partial<StorageData>;

      // Write server data to localStorage (overwrite)
      if (data.connections) writeCollectionToLocal("connections", data.connections);
      if (data.history) writeCollectionToLocal("history", data.history);
      if (data.saved_queries) writeCollectionToLocal("saved_queries", data.saved_queries);
      if (data.schema_snapshots) writeCollectionToLocal("schema_snapshots", data.schema_snapshots);
      if (data.saved_charts) writeCollectionToLocal("saved_charts", data.saved_charts);
      if (data.active_connection_id !== undefined)
        writeCollectionToLocal("active_connection_id", data.active_connection_id);
      if (data.audit_log) writeCollectionToLocal("audit_log", data.audit_log);
      if (data.masking_config) writeCollectionToLocal("masking_config", data.masking_config);
      if (data.threshold_config) writeCollectionToLocal("threshold_config", data.threshold_config);
      if (data.dismissed_seeds) writeCollectionToLocal("dismissed_seeds", data.dismissed_seeds);

      setLastSyncedAt(new Date());
      setSyncError(null);
    } catch (err) {
      logger.warn("StorageSync pull failed", { error: err instanceof Error ? err.message : String(err) });
      setSyncError(err instanceof Error ? err.message : "Pull failed");
    } finally {
      setIsSyncing(false);
    }
  }, []);

  // ── Migration: localStorage → server ──
  const migrateToServer = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (localStorage.getItem(MIGRATION_FLAG)) return;

    // Check if localStorage actually has any libredb data to migrate.
    // On a fresh browser, no libredb_* keys exist — skip migration to
    // avoid overwriting server data with empty defaults.
    const hasLocalData = STORAGE_COLLECTIONS.some((col) => localStorage.getItem(`libredb_${col}`) !== null);

    if (!hasLocalData) {
      localStorage.setItem(MIGRATION_FLAG, new Date().toISOString());
      return;
    }

    setIsSyncing(true);
    try {
      const allData: Partial<StorageData> = {};
      for (const col of STORAGE_COLLECTIONS) {
        // Only include collections that actually exist in localStorage
        const raw = localStorage.getItem(`libredb_${col}`);
        if (raw !== null) {
          const data = getCollectionData(col);
          if (data !== null && data !== undefined) {
            (allData as Record<string, unknown>)[col] = data;
          }
        }
      }

      if (Object.keys(allData).length === 0) {
        localStorage.setItem(MIGRATION_FLAG, new Date().toISOString());
        return;
      }

      const res = await fetch("/api/storage/migrate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(allData),
      });

      if (res.ok) {
        localStorage.setItem(MIGRATION_FLAG, new Date().toISOString());
      }
    } catch (err) {
      logger.warn("StorageSync migration failed", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      setIsSyncing(false);
    }
  }, []);

  // ── Lifecycle: one place that owns the timers ──
  // Assigning `true` rather than relying on the ref's initial value is what makes
  // a remount (StrictMode's double-invoke, or a real one) work: the ref survives
  // the teardown that set it false.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (debounceTimerRef.current) clearTimeout(debounceTimerRef.current);
      if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
    };
  }, []);

  // ── Initialize: discover storage mode ──
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const res = await fetch("/api/storage/config");
        if (!res.ok || cancelled) return;
        const config = (await res.json()) as StorageConfigResponse;

        if (config.serverMode && !cancelled) {
          setIsServerMode(true);
          serverModeRef.current = true;

          // Migration first, then pull
          await migrateToServer();
          if (!cancelled) {
            await pullFromServer();
          }
        }
      } catch {
        // Server unreachable — stay in local mode
        logger.debug("Storage server unreachable, staying in local mode");
      } finally {
        if (!cancelled) {
          setIsReady(true);
        }
      }
    }

    init();
    return () => {
      cancelled = true;
    };
  }, [migrateToServer, pullFromServer]);

  // ── Listen for storage mutations ──
  useEffect(() => {
    if (!isServerMode) return;

    function handleStorageChange(event: Event) {
      const detail = (event as CustomEvent<StorageChangeDetail>).detail;
      if (detail?.collection) {
        schedulePush(detail.collection);
      }
    }

    window.addEventListener("libredb-storage-change", handleStorageChange);
    // Timers are torn down by the lifecycle effect above, not here: a retry can
    // be armed after this effect's cleanup has already run.
    return () => window.removeEventListener("libredb-storage-change", handleStorageChange);
  }, [isServerMode, schedulePush]);

  return { isServerMode, isSyncing, isReady, lastSyncedAt, syncError };
}

// ── Helpers ──

/** Read a collection's current data from the storage facade */
function getCollectionData(collection: string): unknown {
  switch (collection) {
    case "connections":
      return storage.getConnections();
    case "history":
      return storage.getHistory();
    case "saved_queries":
      return storage.getSavedQueries();
    case "schema_snapshots":
      return storage.getSchemaSnapshots();
    case "saved_charts":
      return storage.getSavedCharts();
    case "active_connection_id":
      return storage.getActiveConnectionId();
    case "audit_log":
      return storage.getAuditLog();
    case "masking_config":
      return storage.getMaskingConfig();
    case "threshold_config":
      return storage.getThresholdConfig();
    case "dismissed_seeds":
      return storage.getDismissedSeeds();
    default:
      return null;
  }
}

/** Write server data directly to localStorage via storage key */
function writeCollectionToLocal(collection: string, data: unknown): void {
  const key = `libredb_${collection}`;
  if (data === null || data === undefined) {
    localStorage.removeItem(key);
  } else if (typeof data === "string") {
    localStorage.setItem(key, data);
  } else {
    localStorage.setItem(key, JSON.stringify(data));
  }
}
