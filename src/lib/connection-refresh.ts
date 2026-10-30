import { logger } from "@/lib/logger";

/**
 * Managed-list refresh after the first load (#1502): max(cacheHint, floor), capped at a minute.
 * NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS moves the floor in source builds and tests only,
 * because NEXT_PUBLIC_ values are inlined at build time.
 */
export const MANAGED_REFRESH_DEFAULT_FLOOR_MS = 5000;
export const MANAGED_REFRESH_MAX_MS = 60000;

/** Milliseconds between two refreshes: max(cacheHint, floor), capped at MANAGED_REFRESH_MAX_MS. */
export function managedRefreshIntervalMs(cacheHint: number | null): number {
  const floor = Number(process.env.NEXT_PUBLIC_MANAGED_REFRESH_FLOOR_MS) || MANAGED_REFRESH_DEFAULT_FLOOR_MS;
  return Math.min(Math.max(cacheHint ?? 0, floor), MANAGED_REFRESH_MAX_MS);
}

/** Missing routes and other initial failures are not polled; a governance outage is retried. */
export function shouldStartManagedRefresh(answered: boolean, unavailable: boolean): boolean {
  return answered || unavailable;
}

/**
 * Start the shared lifecycle after an answer or a 503 GOVERNANCE_UNAVAILABLE.
 * Interval, focus and visibility triggers read only while visible, one read at a time.
 * Callers apply successful reads and guard state writes after unmount; failures are logged here.
 */
export function startManagedListRefresh({
  answered,
  unavailable,
  cacheHint,
  refresh,
  route = "connection-refresh",
}: {
  answered: boolean;
  unavailable: boolean;
  cacheHint: number | null;
  refresh: () => Promise<void>;
  route?: string;
}): () => void {
  if (!shouldStartManagedRefresh(answered, unavailable)) return () => {};
  let stopped = false;
  let refreshInFlight = false;
  const refreshManaged = async () => {
    if (stopped || refreshInFlight || document.visibilityState !== "visible") return;
    refreshInFlight = true;
    try {
      await refresh();
    } catch (error) {
      logger.debug("Managed connection refresh failed", {
        route,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      refreshInFlight = false;
    }
  };

  const refreshTimer = setInterval(refreshManaged, managedRefreshIntervalMs(cacheHint));
  window.addEventListener("focus", refreshManaged);
  document.addEventListener("visibilitychange", refreshManaged);
  return () => {
    stopped = true;
    clearInterval(refreshTimer);
    window.removeEventListener("focus", refreshManaged);
    document.removeEventListener("visibilitychange", refreshManaged);
  };
}
