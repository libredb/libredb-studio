"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import type { DatabaseConnection } from "@/lib/types";
import { buildConnectionPayload } from "./use-connection-payload";
import type { MonitoringData, MonitoringOptions } from "@/lib/db/types";
import { toast } from "sonner";
import { TimeSeriesBuffer, type TimeSeriesPoint } from "@/lib/time-series-buffer";

interface UseMonitoringDataReturn {
  data: MonitoringData | null;
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  autoRefresh: boolean;
  refreshInterval: number;
  history: TimeSeriesPoint<MonitoringData>[];
  setAutoRefresh: (enabled: boolean) => void;
  setRefreshInterval: (ms: number) => void;
  refresh: () => Promise<void>;
  killSession: (pid: number | string) => Promise<boolean>;
  runMaintenance: (type: string, target?: string) => Promise<boolean>;
}

const DEFAULT_REFRESH_INTERVAL = 30000; // 30 seconds

export function useMonitoringData(
  connection: DatabaseConnection | null,
  options?: MonitoringOptions,
): UseMonitoringDataReturn {
  const [dataState, setData] = useState<MonitoringData | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorState, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(DEFAULT_REFRESH_INTERVAL);
  // History belongs to a SELECTION, not to a connection id: leaving a connection
  // and coming back is a fresh chart, and the id repeats while the excursion does
  // not. This counter numbers the selections, and it is adjusted during render
  // rather than in an effect (react.dev, "You Might Not Need an Effect" -
  // adjusting some state when a prop changes) so that the very render which
  // switches connections already reports an empty history.
  const connectionId = connection?.id ?? null;
  const [selection, setSelection] = useState({ id: connectionId, seq: 0 });
  if (selection.id !== connectionId) {
    setSelection({ id: connectionId, seq: selection.seq + 1 });
  }

  // History carries the selection it belongs to, so a switch needs no reset:
  // a record whose selection no longer matches reads as no history at all.
  const [historyState, setHistory] = useState<{
    selection: number;
    points: TimeSeriesPoint<MonitoringData>[];
  } | null>(null);

  // Time series buffer for historical data
  const historyRef = useRef(new TimeSeriesBuffer<MonitoringData>(120));
  // Which selection the buffer above currently holds points for.
  const historyOwnerRef = useRef<number | null>(null);

  // Use refs to store latest values without causing re-renders
  const connectionRef = useRef(connection);
  const optionsRef = useRef(options);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);
  // Mirrored for `fetchData`, which takes no dependencies.
  const selectionRef = useRef(selection.seq);

  // Update refs when props change. This one is declared before the effect that
  // fetches, so a switch has already renumbered the selection by the time that
  // effect asks for the new connection's first sample.
  useEffect(() => {
    selectionRef.current = selection.seq;
  }, [selection.seq]);

  useEffect(() => {
    connectionRef.current = connection;
  }, [connection]);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  // Cleanup on unmount
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const fetchData = useCallback(async () => {
    const currentConnection = connectionRef.current;

    // No state to clear here: with no connection the exposed data and error are
    // derived as null during render (see the return below).
    if (!currentConnection) {
      return;
    }

    // Read before the await: the result belongs to the selection that asked for
    // it, not to whichever one is on screen when it lands.
    const selectionSeq = selectionRef.current;

    // Cancel previous request if still pending
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    abortControllerRef.current = new AbortController();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/db/monitoring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...buildConnectionPayload(currentConnection),
          options: optionsRef.current,
        }),
        signal: abortControllerRef.current.signal,
      });

      const result = await res.json();

      if (!res.ok) {
        throw new Error(result.error || "Failed to fetch monitoring data");
      }

      // Only update state if component is still mounted
      if (!isMountedRef.current) return;

      // Convert date strings back to Date objects
      if (result.timestamp) {
        result.timestamp = new Date(result.timestamp);
      }
      if (result.overview?.startTime) {
        result.overview.startTime = new Date(result.overview.startTime);
      }

      setData(result);
      setLastUpdated(new Date());
      setError(null);

      // Push to history buffer. The buffer belongs to whichever selection last
      // settled into it, so it is emptied here - after the await, once we know
      // which selection this result is for - rather than in the effect.
      if (historyOwnerRef.current !== selectionSeq) {
        historyRef.current.clear();
        historyOwnerRef.current = selectionSeq;
      }
      historyRef.current.push(result);
      setHistory({ selection: selectionSeq, points: historyRef.current.getAll() });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return; // Request was cancelled, ignore
      }
      if (!isMountedRef.current) return;

      const errorMessage = err instanceof Error ? err.message : "Unknown error";
      setError(errorMessage);
      // Don't clear existing data on error, show stale data
    } finally {
      if (isMountedRef.current) {
        setLoading(false);
      }
    }
  }, []); // No dependencies - uses refs

  // Initial fetch when connection changes
  useEffect(() => {
    // Nothing is reset here: data and error are derived from `connection`, and
    // history from the selection counter renumbered above - all during render,
    // so an emptied or changed selection answers correctly on the very render
    // that changed it.
    if (!connection) return;

    // Initial fetch
    fetchData();

    return () => {
      // Cleanup: abort any pending request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [connection, fetchData]); // Only re-run when connection ID changes

  // Auto-refresh setup (separate effect)
  useEffect(() => {
    // Clear existing interval (the effect cleanup below also clears it between runs)
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = null;

    // Setup new interval if autoRefresh is enabled and we have a connection
    if (autoRefresh && connection) {
      intervalRef.current = setInterval(fetchData, refreshInterval);
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [autoRefresh, refreshInterval, connection, fetchData]);

  const refresh = useCallback(async () => {
    await fetchData();
  }, [fetchData]);

  const killSession = useCallback(
    async (pid: number | string): Promise<boolean> => {
      const currentConnection = connectionRef.current;
      if (!currentConnection) return false;

      try {
        const res = await fetch("/api/db/maintenance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "kill",
            target: String(pid),
            ...buildConnectionPayload(currentConnection),
          }),
        });

        const result = await res.json();

        if (!res.ok) {
          throw new Error(result.error || "Failed to kill session");
        }

        toast.success(`Session ${pid} terminated successfully`);

        // Refresh data after killing session
        await fetchData();

        return true;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : "Failed to kill session";
        toast.error(errorMessage);
        return false;
      }
    },
    [fetchData],
  );

  const runMaintenance = useCallback(
    async (type: string, target?: string): Promise<boolean> => {
      const currentConnection = connectionRef.current;
      if (!currentConnection) return false;

      try {
        const res = await fetch("/api/db/maintenance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type,
            target,
            ...buildConnectionPayload(currentConnection),
          }),
        });

        const result = await res.json();

        if (!res.ok) {
          throw new Error(result.error || `Failed to run ${type}`);
        }

        toast.success(result.message || `${type} completed successfully`);

        // Refresh data after maintenance
        await fetchData();

        return true;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : `Failed to run ${type}`;
        toast.error(errorMessage);
        return false;
      }
    },
    [fetchData],
  );

  // Derived rather than reset in the connection effect: with no connection
  // there is nothing to report, and history belongs to one selection only.
  return {
    data: connection === null ? null : dataState,
    loading,
    error: connection === null ? null : errorState,
    lastUpdated,
    autoRefresh,
    refreshInterval,
    history: historyState?.selection === selection.seq ? historyState.points : [],
    setAutoRefresh,
    setRefreshInterval,
    refresh,
    killSession,
    runMaintenance,
  };
}
