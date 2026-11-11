"use client";

import { useMemo, useSyncExternalStore } from "react";
import { storage } from "@/lib/storage";
import type { StorageChangeDetail } from "@/lib/storage";
import type { SavedChartConfig } from "@/lib/types";

function subscribe(callback: () => void) {
  const handleStorageChange = (e: Event) => {
    const detail = (e as CustomEvent<StorageChangeDetail>).detail;
    if (detail?.collection === "saved_charts") callback();
  };
  window.addEventListener("libredb-storage-change", handleStorageChange);
  return () => window.removeEventListener("libredb-storage-change", handleStorageChange);
}

/**
 * A JSON string rather than the array: `storage.getSavedCharts()` returns a fresh array on
 * every call, and `useSyncExternalStore` reads any snapshot that is not `Object.is`-equal
 * to the last one as a change (the same reason as `use-favorite-connections.ts`).
 */
function getSnapshot(): string {
  return JSON.stringify(storage.getSavedCharts());
}

function getServerSnapshot(): string {
  return "[]";
}

/**
 * The saved charts, kept current: a chart saved or deleted while the caller is mounted
 * shows up on its next render, through the facade's `saved_charts` change event (#2281).
 * The Dashboard used to read them once, on mount, and missed every change after that.
 */
export function useSavedCharts(): SavedChartConfig[] {
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  return useMemo(
    () =>
      (JSON.parse(snapshot) as SavedChartConfig[]).map((chart) => ({
        ...chart,
        // The snapshot went through JSON, which turned each Date into a string.
        createdAt: new Date(chart.createdAt),
      })),
    [snapshot],
  );
}
