'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import type { DatabaseConnection } from '@/lib/types';
import type {
  MonitoringData,
  MonitoringOptions,
} from '@/lib/db/types';
import { toast } from 'sonner';

interface UseMonitoringDataReturn {
  data: MonitoringData | null;
  loading: boolean;
  error: string | null;
  lastUpdated: Date | null;
  autoRefresh: boolean;
  refreshInterval: number;
  setAutoRefresh: (enabled: boolean) => void;
  setRefreshInterval: (ms: number) => void;
  refresh: () => Promise<void>;
  killSession: (pid: number | string) => Promise<boolean>;
  runMaintenance: (type: string, target?: string) => Promise<boolean>;
}

const DEFAULT_REFRESH_INTERVAL = 30000; // 30 seconds

export function useMonitoringData(
  connection: DatabaseConnection | null,
  options?: MonitoringOptions
): UseMonitoringDataReturn {
  const [data, setData] = useState<MonitoringData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(DEFAULT_REFRESH_INTERVAL);

  // Use refs to store latest values without causing re-renders
  const connectionRef = useRef(connection);
  const optionsRef = useRef(options);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);

  // Update refs when props change
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

    if (!currentConnection) {
      setData(null);
      setError(null);
      return;
    }

    // Cancel previous request if still pending
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }

    abortControllerRef.current = new AbortController();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/db/monitoring', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connection: currentConnection,
          options: optionsRef.current
        }),
        signal: abortControllerRef.current.signal,
      });

      const result = await res.json();

      if (!res.ok) {
        throw new Error(result.error || 'Failed to fetch monitoring data');
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
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return; // Request was cancelled, ignore
      }
      if (!isMountedRef.current) return;

      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
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
    if (!connection) {
      setData(null);
      setError(null);
      return;
    }

    // Initial fetch
    fetchData();

    return () => {
      // Cleanup: abort any pending request
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, [connection?.id]); // Only re-run when connection ID changes

  // Auto-refresh setup (separate effect)
  useEffect(() => {
    // Clear existing interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

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
  }, [autoRefresh, refreshInterval, connection?.id, fetchData]);

  const refresh = useCallback(async () => {
    await fetchData();
  }, [fetchData]);

  const killSession = useCallback(async (pid: number | string): Promise<boolean> => {
    const currentConnection = connectionRef.current;
    if (!currentConnection) return false;

    try {
      const res = await fetch('/api/db/maintenance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'kill',
          target: String(pid),
          connection: currentConnection,
        }),
      });

      const result = await res.json();

      if (!res.ok) {
        throw new Error(result.error || 'Failed to kill session');
      }

      toast.success(`Session ${pid} terminated successfully`);

      // Refresh data after killing session
      await fetchData();

      return true;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to kill session';
      toast.error(errorMessage);
      return false;
    }
  }, [fetchData]);

  const runMaintenance = useCallback(async (type: string, target?: string): Promise<boolean> => {
    const currentConnection = connectionRef.current;
    if (!currentConnection) return false;

    try {
      const res = await fetch('/api/db/maintenance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          target,
          connection: currentConnection,
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
  }, [fetchData]);

  return {
    data,
    loading,
    error,
    lastUpdated,
    autoRefresh,
    refreshInterval,
    setAutoRefresh,
    setRefreshInterval,
    refresh,
    killSession,
    runMaintenance,
  };
}
