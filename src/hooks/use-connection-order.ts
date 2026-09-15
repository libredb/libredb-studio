"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { storage } from "@/lib/storage";
import type { StorageChangeDetail } from "@/lib/storage";

const EMPTY_ORDER: string[] = [];

function subscribe(callback: () => void) {
  const handleStorageChange = (e: Event) => {
    const detail = (e as CustomEvent<StorageChangeDetail>).detail;
    if (detail?.collection === "connection_order") callback();
  };
  window.addEventListener("libredb-storage-change", handleStorageChange);
  return () => window.removeEventListener("libredb-storage-change", handleStorageChange);
}

function getSnapshot(): string {
  return JSON.stringify(storage.getConnectionOrder());
}

function getServerSnapshot(): string {
  return "[]";
}

/**
 * Tracks the user's custom connection order, backed by the storage facade's
 * `connection_order` collection. See the comment on `StorageData["connection_order"]` for why
 * this is one flat id list rather than one per favorite/non-favorite group.
 */
export function useConnectionOrder(storageReady: boolean) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const order = useMemo(() => {
    if (!storageReady) return EMPTY_ORDER;
    return JSON.parse(snapshot) as string[];
  }, [snapshot, storageReady]);

  const setOrder = useCallback((ids: string[]) => {
    storage.setConnectionOrder(ids);
  }, []);

  return { order, setOrder };
}
