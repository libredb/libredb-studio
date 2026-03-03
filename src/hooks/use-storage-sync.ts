'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { storage, type StorageConfigResponse, type StorageChangeDetail, type StorageData, STORAGE_COLLECTIONS } from '@/lib/storage';

const MIGRATION_FLAG = 'libredb_server_migrated';
const DEBOUNCE_MS = 500;

export interface StorageSyncState {
  isServerMode: boolean;
  isSyncing: boolean;
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
  const [lastSyncedAt, setLastSyncedAt] = useState<Date | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCollectionsRef = useRef<Set<string>>(new Set());
  const serverModeRef = useRef(false);

  // ── Push a collection to server (debounced) ──
  const pushToServer = useCallback(async (collection: string, data: unknown) => {
    try {
      const res = await fetch(`/api/storage/${collection}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      setLastSyncedAt(new Date());
      setSyncError(null);
    } catch (err) {
      console.warn(`[StorageSync] Push failed for ${collection}:`, err);
      setSyncError(err instanceof Error ? err.message : 'Sync failed');
    }
  }, []);

  // ── Flush pending collections ──
  const flushPending = useCallback(async () => {
    const collections = Array.from(pendingCollectionsRef.current);
    pendingCollectionsRef.current.clear();
    if (collections.length === 0) return;

    setIsSyncing(true);
    try {
      await Promise.all(
        collections.map((col) => {
          const getter = getCollectionData(col);
          return pushToServer(col, getter);
        })
      );
    } finally {
      setIsSyncing(false);
    }
  }, [pushToServer]);

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
    [flushPending]
  );

  // ── Pull all data from server → localStorage ──
  const pullFromServer = useCallback(async () => {
    setIsSyncing(true);
    try {
      const res = await fetch('/api/storage');
      if (!res.ok) return;
      const data = (await res.json()) as Partial<StorageData>;

      // Write server data to localStorage (overwrite)
      if (data.connections) writeCollectionToLocal('connections', data.connections);
      if (data.history) writeCollectionToLocal('history', data.history);
      if (data.saved_queries) writeCollectionToLocal('saved_queries', data.saved_queries);
      if (data.schema_snapshots) writeCollectionToLocal('schema_snapshots', data.schema_snapshots);
      if (data.saved_charts) writeCollectionToLocal('saved_charts', data.saved_charts);
      if (data.active_connection_id !== undefined) writeCollectionToLocal('active_connection_id', data.active_connection_id);
      if (data.audit_log) writeCollectionToLocal('audit_log', data.audit_log);
      if (data.masking_config) writeCollectionToLocal('masking_config', data.masking_config);
      if (data.threshold_config) writeCollectionToLocal('threshold_config', data.threshold_config);

      setLastSyncedAt(new Date());
      setSyncError(null);
    } catch (err) {
      console.warn('[StorageSync] Pull failed:', err);
      setSyncError(err instanceof Error ? err.message : 'Pull failed');
    } finally {
      setIsSyncing(false);
    }
  }, []);

  // ── Migration: localStorage → server ──
  const migrateToServer = useCallback(async () => {
    if (typeof window === 'undefined') return;
    if (localStorage.getItem(MIGRATION_FLAG)) return;

    setIsSyncing(true);
    try {
      const allData: Partial<StorageData> = {};
      for (const col of STORAGE_COLLECTIONS) {
        const data = getCollectionData(col);
        if (data !== null && data !== undefined) {
          (allData as Record<string, unknown>)[col] = data;
        }
      }

      if (Object.keys(allData).length === 0) {
        localStorage.setItem(MIGRATION_FLAG, new Date().toISOString());
        return;
      }

      const res = await fetch('/api/storage/migrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(allData),
      });

      if (res.ok) {
        localStorage.setItem(MIGRATION_FLAG, new Date().toISOString());
      }
    } catch (err) {
      console.warn('[StorageSync] Migration failed:', err);
    } finally {
      setIsSyncing(false);
    }
  }, []);

  // ── Initialize: discover storage mode ──
  useEffect(() => {
    let cancelled = false;

    async function init() {
      try {
        const res = await fetch('/api/storage/config');
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

    window.addEventListener('libredb-storage-change', handleStorageChange);
    return () => {
      window.removeEventListener('libredb-storage-change', handleStorageChange);
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, [isServerMode, schedulePush]);

  return { isServerMode, isSyncing, lastSyncedAt, syncError };
}

// ── Helpers ──

/** Read a collection's current data from the storage facade */
function getCollectionData(collection: string): unknown {
  switch (collection) {
    case 'connections': return storage.getConnections();
    case 'history': return storage.getHistory();
    case 'saved_queries': return storage.getSavedQueries();
    case 'schema_snapshots': return storage.getSchemaSnapshots();
    case 'saved_charts': return storage.getSavedCharts();
    case 'active_connection_id': return storage.getActiveConnectionId();
    case 'audit_log': return storage.getAuditLog();
    case 'masking_config': return storage.getMaskingConfig();
    case 'threshold_config': return storage.getThresholdConfig();
    default: return null;
  }
}

/** Write server data directly to localStorage via storage key */
function writeCollectionToLocal(collection: string, data: unknown): void {
  const key = `libredb_${collection}`;
  if (data === null || data === undefined) {
    localStorage.removeItem(key);
  } else if (typeof data === 'string') {
    localStorage.setItem(key, data);
  } else {
    localStorage.setItem(key, JSON.stringify(data));
  }
}
