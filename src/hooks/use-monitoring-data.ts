"use client";

import { appFetch } from "@/lib/config/base-path";
import { useState, useEffect, useCallback, useRef } from "react";
import type { DatabaseConnection } from "@/lib/types";
import { buildConnectionPayload, catalogField } from "./use-connection-payload";
import type { MaintenancePreview, MaintenanceResult, MonitoringData, MonitoringOptions } from "@/lib/db/types";
import { toast } from "sonner";
import { TimeSeriesBuffer, type TimeSeriesPoint } from "@/lib/time-series-buffer";

/** What one maintenance run came to: whether it happened, and the refusal's own sentence when it did not. */
export interface MaintenanceOutcome {
  readonly success: boolean;
  /** The route's sentence for a refused request, or the engine's own for a run it reported failed. */
  readonly error?: string;
}

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
  runMaintenance: (type: string, target?: string, container?: string) => Promise<boolean>;
  /** `runMaintenance` with its reason: for a caller that records or shows why a run was refused. */
  runMaintenanceOutcome: (type: string, target?: string, container?: string) => Promise<MaintenanceOutcome>;
  /** Rows from the last maintenance call on this selection, or null when that call had none. */
  maintenanceReport: Pick<MaintenanceResult, "rows" | "fields"> | null;
  previewMaintenance: (type: string, target: string, container?: string) => Promise<MaintenancePreview>;
}

const DEFAULT_REFRESH_INTERVAL = 30000; // 30 seconds

/**
 * The table a maintenance response carried, or null when it carried only a sentence.
 *
 * Rows without columns, and columns without rows, are not a table: the Operations tab
 * would render an empty header or a row with nothing to label it.
 */
function maintenanceReportFrom(
  result: Pick<MaintenanceResult, "rows" | "fields">,
): Pick<MaintenanceResult, "rows" | "fields"> | null {
  if (
    !Array.isArray(result.rows) ||
    result.rows.length === 0 ||
    !Array.isArray(result.fields) ||
    result.fields.length === 0
  ) {
    return null;
  }
  return { rows: result.rows, fields: result.fields };
}

export function useMonitoringData(
  connection: DatabaseConnection | null,
  options?: MonitoringOptions,
  /** The database to monitor on a server-level connection (#1530); its panels are that database's. */
  catalog?: string,
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
  // A selection is a connection AND, on a server-level one, a database (#1530): another database is
  // another chart, exactly as another connection is.
  const connectionId = connection === null ? null : JSON.stringify([connection.id, catalog ?? null]);
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

  // The table from the last maintenance call, tagged with the selection that asked
  // for it. A switch reads as no table, the same way history does, so one connection
  // never keeps showing another's INFO.
  const [reportState, setReportState] = useState<{
    selection: number;
    report: Pick<MaintenanceResult, "rows" | "fields"> | null;
  } | null>(null);

  // Time series buffer for historical data
  const historyRef = useRef(new TimeSeriesBuffer<MonitoringData>(120));
  // Which selection the buffer above currently holds points for.
  const historyOwnerRef = useRef<number | null>(null);

  // Use refs to store latest values without causing re-renders
  const connectionRef = useRef(connection);
  const catalogRef = useRef(catalog);
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
      const res = await appFetch("/api/db/monitoring", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...buildConnectionPayload(currentConnection),
          ...catalogField(catalogRef.current),
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

    // The database rides on a ref `fetchData` reads, set here so a switch refetches with it (#1530).
    catalogRef.current = catalog;

    // Initial fetch
    fetchData();

    return () => {
      // Cleanup: abort any pending request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [connection, catalog, fetchData]); // Only re-run when the connection or its database changes

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
        const res = await appFetch("/api/db/maintenance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: "kill",
            target: String(pid),
            ...buildConnectionPayload(currentConnection),
            ...catalogField(catalogRef.current),
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

  // The run and why it did not happen. `runMaintenance` below is this, read as a boolean: a caller that writes the
  // reason somewhere the toast is not (the Operations tab's log, the dialog that asked) needs the sentence too (#1418).
  const runMaintenanceOutcome = useCallback(
    async (type: string, target?: string, container?: string): Promise<MaintenanceOutcome> => {
      const currentConnection = connectionRef.current;
      if (!currentConnection) return { success: false };

      // Read before the await: the table belongs to the selection that asked for
      // it, not to whichever one is on screen when the reply arrives.
      const selectionSeq = selectionRef.current;

      try {
        const res = await appFetch("/api/db/maintenance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type,
            target,
            container,
            ...buildConnectionPayload(currentConnection),
            ...catalogField(catalogRef.current),
          }),
        });

        const result = await res.json();

        if (!res.ok) {
          throw new Error(result.error || `Failed to run ${type}`);
        }

        // A 200 says the statement reached the engine, not that the engine did the work:
        // `MaintenanceResult.success` is the engine's own verdict, and reading only the
        // status code turned every refusal into a green tick. Measured through the real
        // MySQL provider on 2026-08-25, OPTIMIZE on a table that is not there answers 200
        // with `{success:false, message:"OPTIMIZE failed: ... doesn't exist"}` - and
        // `OperationsTab` writes this boolean straight into its operation log, so the
        // whole surface recorded a completed operation. A provider that reports no verdict
        // keeps the old reading: only an explicit `false` is a refusal.
        if (result.success === false) {
          const refusal: string = result.message || `${type} failed`;
          toast.error(refusal);
          setReportState({ selection: selectionSeq, report: null });
          // Refreshed anyway: a refused operation can still have moved part of the state
          // it was asked about (Oracle rebuilds index by index), so the panels must not
          // keep showing what was true before the attempt.
          await fetchData();
          return { success: false, error: refusal };
        }

        toast.success(result.message || `${type} completed successfully`);
        setReportState({ selection: selectionSeq, report: maintenanceReportFrom(result) });

        // Refresh data after maintenance
        await fetchData();

        return { success: true };
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : `Failed to run ${type}`;
        toast.error(errorMessage);
        setReportState({ selection: selectionSeq, report: null });
        return { success: false, error: errorMessage };
      }
    },
    [fetchData],
  );

  const runMaintenance = useCallback(
    async (type: string, target?: string, container?: string): Promise<boolean> =>
      (await runMaintenanceOutcome(type, target, container)).success,
    [runMaintenanceOutcome],
  );

  // What one per-row operation will do (spec 3.11). Raised rather than toasted: the dialog that asked shows the
  // route's own sentence in place of the preview, and offers no confirm button.
  const previewMaintenance = useCallback(
    async (type: string, target: string, container?: string): Promise<MaintenancePreview> => {
      const currentConnection = connectionRef.current;
      if (!currentConnection) throw new Error("No connection is selected");

      const res = await appFetch("/api/db/maintenance/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type,
          target,
          container,
          ...buildConnectionPayload(currentConnection),
          ...catalogField(catalogRef.current),
        }),
      });
      const result = await res.json();
      if (!res.ok) throw new Error(result.error || `Failed to preview ${type}`);
      return result.preview as MaintenancePreview;
    },
    [],
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
    runMaintenanceOutcome,
    maintenanceReport: connection !== null && reportState?.selection === selection.seq ? reportState.report : null,
    previewMaintenance,
  };
}
