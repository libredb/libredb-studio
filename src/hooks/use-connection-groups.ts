"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { storage } from "@/lib/storage";
import type { StorageChangeDetail } from "@/lib/storage";
import type { ConnectionGroup } from "@/lib/storage/types";
import { newLocalId } from "@/lib/ids";

const EMPTY_GROUPS: ConnectionGroup[] = [];

function subscribe(callback: () => void) {
  const handleStorageChange = (e: Event) => {
    const detail = (e as CustomEvent<StorageChangeDetail>).detail;
    if (detail?.collection === "connection_groups") callback();
  };
  window.addEventListener("libredb-storage-change", handleStorageChange);
  return () => window.removeEventListener("libredb-storage-change", handleStorageChange);
}

function getSnapshot(): string {
  return JSON.stringify(storage.getConnectionGroups());
}

function getServerSnapshot(): string {
  return "[]";
}

/**
 * Tracks the user's connection groups (#1170), backed by the storage facade's
 * `connection_groups` collection. Every mutation reads the current list from storage rather
 * than from a render's closure, so two quick calls in one event compose instead of the
 * second overwriting the first.
 */
export function useConnectionGroups(storageReady: boolean) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const groups = useMemo(() => {
    if (!storageReady) return EMPTY_GROUPS;
    return JSON.parse(snapshot) as ConnectionGroup[];
  }, [snapshot, storageReady]);

  const createGroup = useCallback((name: string): string | null => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const id = newLocalId();
    storage.setConnectionGroups([
      ...storage.getConnectionGroups(),
      { id, name: trimmed, collapsed: false, connectionIds: [] },
    ]);
    return id;
  }, []);

  const renameGroup = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    storage.setConnectionGroups(
      storage.getConnectionGroups().map((group) => (group.id === id ? { ...group, name: trimmed } : group)),
    );
  }, []);

  const deleteGroup = useCallback((id: string) => {
    storage.setConnectionGroups(storage.getConnectionGroups().filter((group) => group.id !== id));
  }, []);

  const toggleCollapsed = useCallback((id: string) => {
    storage.setConnectionGroups(
      storage
        .getConnectionGroups()
        .map((group) => (group.id === id ? { ...group, collapsed: !group.collapsed } : group)),
    );
  }, []);

  /** Files a connection under `groupId`, or under no group when `groupId` is null. At most one group holds it. */
  const moveConnection = useCallback((connectionId: string, groupId: string | null) => {
    const current = storage.getConnectionGroups();
    if (groupId !== null && !current.some((group) => group.id === groupId)) return;
    storage.setConnectionGroups(
      current.map((group) => {
        const without = group.connectionIds.filter((id) => id !== connectionId);
        return { ...group, connectionIds: group.id === groupId ? [...without, connectionId] : without };
      }),
    );
  }, []);

  return { groups, createGroup, renameGroup, deleteGroup, toggleCollapsed, moveConnection };
}
