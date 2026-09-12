"use client";

import { useCallback, useMemo, useSyncExternalStore } from "react";
import { storage } from "@/lib/storage";
import type { StorageChangeDetail } from "@/lib/storage";

const EMPTY_FAVORITE_IDS = new Set<string>();

function subscribe(callback: () => void) {
  const handleStorageChange = (e: Event) => {
    const detail = (e as CustomEvent<StorageChangeDetail>).detail;
    if (detail?.collection === "favorite_connections") callback();
  };
  window.addEventListener("libredb-storage-change", handleStorageChange);
  return () => window.removeEventListener("libredb-storage-change", handleStorageChange);
}

/**
 * A JSON string rather than the raw array: `useSyncExternalStore` treats any snapshot that
 * is not `Object.is`-equal to the previous one as a change, and `storage.getFavoriteConnectionIds()`
 * returns a fresh array on every call. Without this, two renders with identical favorites would
 * still look like a change on every render, which can trigger the "getSnapshot should be cached"
 * infinite-loop warning.
 */
function getSnapshot(): string {
  return JSON.stringify(storage.getFavoriteConnectionIds());
}

function getServerSnapshot(): string {
  return "[]";
}

/**
 * Tracks which connection ids the user has starred, backed by the storage facade's
 * `favorite_connections` collection.
 *
 * Deliberately a separate id set rather than a field read off each `DatabaseConnection` —
 * see the comment on `StorageData["favorite_connections"]` for why a field on the connection
 * itself would not survive reload for the connections a user is most likely to favorite.
 *
 * Built on `useSyncExternalStore` (favorite_connections is exactly that: state that lives
 * outside React, in localStorage, mutated by the storage facade) rather than an effect that
 * reads storage and calls setState, so a favorite pulled down from the server, or toggled
 * from another mounted instance of this hook, is reflected here without a synchronous
 * setState-in-effect render cascade.
 */
export function useFavoriteConnections(storageReady: boolean) {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const favoriteIds = useMemo(() => {
    if (!storageReady) return EMPTY_FAVORITE_IDS;
    return new Set<string>(JSON.parse(snapshot) as string[]);
  }, [snapshot, storageReady]);

  const toggleFavorite = useCallback((id: string) => {
    // useSyncExternalStore re-renders via the subscription above once the facade
    // dispatches its change event.
    storage.toggleFavoriteConnection(id);
  }, []);

  return { favoriteIds, toggleFavorite };
}
