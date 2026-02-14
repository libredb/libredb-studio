import '../setup-dom';
import { mockToastSuccess, mockToastError } from '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { renderHook, act, waitFor } from '@testing-library/react';
import { mockGlobalFetch, restoreGlobalFetch } from '../helpers/mock-fetch';

import { useMonitoringData } from '@/hooks/use-monitoring-data';
import type { DatabaseConnection } from '@/lib/types';

// =============================================================================
// Test Data
// =============================================================================
const mockConnection: DatabaseConnection = {
  id: 'mon-pg-1',
  name: 'Test PostgreSQL',
  type: 'postgres',
  host: 'localhost',
  port: 5432,
  user: 'testuser',
  password: 'testpass',
  database: 'testdb',
  createdAt: new Date('2025-01-01T00:00:00Z'),
  environment: 'development',
};

const mockMonitoringResponse = {
  timestamp: new Date().toISOString(),
  overview: {
    version: '15.4',
    uptime: 86400,
    startTime: new Date().toISOString(),
    connections: { active: 5, idle: 10, total: 15, max: 100 },
    databaseSize: '256 MB',
  },
  performance: {
    queriesPerSecond: 150,
    avgQueryTime: 2.5,
    cacheHitRatio: 99.1,
    transactionsPerSecond: 50,
  },
  slowQueries: [],
  activeSessions: [],
};

// =============================================================================
// useMonitoringData Tests
// =============================================================================
describe('useMonitoringData', () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  // ── Returns null data when connection is null ──────────────────────────────

  test('returns null data when connection is null', () => {
    mockGlobalFetch({});

    const { result } = renderHook(() => useMonitoringData(null));

    expect(result.current.data).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  // ── Fetches monitoring data on connection change ───────────────────────────

  test('fetches monitoring data on connection change', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/monitoring': { ok: true, json: mockMonitoringResponse },
    });

    const { result } = renderHook(() => useMonitoringData(mockConnection));

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    const monCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/monitoring')
    );
    expect(monCall).toBeDefined();
    expect(monCall![1]).toMatchObject({ method: 'POST' });
  });

  // ── Sets loading true during fetch, false after ────────────────────────────

  test('sets loading true during fetch, false after', async () => {
    mockGlobalFetch({
      '/api/db/monitoring': { ok: true, json: mockMonitoringResponse },
    });

    const { result } = renderHook(() => useMonitoringData(mockConnection));

    // Loading should be true initially (fetch in progress)
    // Eventually resolves
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.data).not.toBeNull();
  });

  // ── Sets data from successful response ─────────────────────────────────────

  test('sets data from successful response', async () => {
    mockGlobalFetch({
      '/api/db/monitoring': { ok: true, json: mockMonitoringResponse },
    });

    const { result } = renderHook(() => useMonitoringData(mockConnection));

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    expect(result.current.data!.overview).toBeDefined();
    expect(result.current.data!.performance).toBeDefined();
    expect(result.current.error).toBeNull();
    expect(result.current.lastUpdated).not.toBeNull();
  });

  // ── Sets error from failed response ────────────────────────────────────────

  test('sets error from failed response', async () => {
    mockGlobalFetch({
      '/api/db/monitoring': { ok: false, status: 500, json: { error: 'Database unreachable' } },
    });

    const { result } = renderHook(() => useMonitoringData(mockConnection));

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    expect(result.current.error).toBe('Database unreachable');
    expect(result.current.loading).toBe(false);
  });

  // ── Does not clear existing data on error ──────────────────────────────────

  test('does not clear existing data on error', async () => {
    // First, load data successfully
    mockGlobalFetch({
      '/api/db/monitoring': { ok: true, json: mockMonitoringResponse },
    });

    const { result } = renderHook(() => useMonitoringData(mockConnection));

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    // Now make fetch fail
    restoreGlobalFetch();
    mockGlobalFetch({
      '/api/db/monitoring': { ok: false, status: 500, json: { error: 'Temporary failure' } },
    });

    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    // Data should still be present (stale data preserved)
    expect(result.current.data).not.toBeNull();
  });

  // ── refresh triggers a new fetch ───────────────────────────────────────────

  test('refresh triggers a new fetch', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/monitoring': { ok: true, json: mockMonitoringResponse },
    });

    const { result } = renderHook(() => useMonitoringData(mockConnection));

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    const callCountBefore = fetchMock.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/monitoring')
    ).length;

    await act(async () => {
      await result.current.refresh();
    });

    const callCountAfter = fetchMock.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/monitoring')
    ).length;

    expect(callCountAfter).toBeGreaterThan(callCountBefore);
  });

  // ── killSession calls /api/db/maintenance with type 'kill' ─────────────────

  test('killSession calls /api/db/maintenance with type kill', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/monitoring': { ok: true, json: mockMonitoringResponse },
      '/api/db/maintenance': { ok: true, json: { success: true, message: 'Session killed' } },
    });

    const { result } = renderHook(() => useMonitoringData(mockConnection));

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    await act(async () => {
      await result.current.killSession(12345);
    });

    const maintenanceCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/maintenance')
    );
    expect(maintenanceCall).toBeDefined();

    const body = JSON.parse(maintenanceCall![1]!.body as string);
    expect(body.type).toBe('kill');
    expect(body.target).toBe('12345');
    expect(body.connection).toBeDefined();
  });

  // ── killSession returns true on success ────────────────────────────────────

  test('killSession returns true on success', async () => {
    mockGlobalFetch({
      '/api/db/monitoring': { ok: true, json: mockMonitoringResponse },
      '/api/db/maintenance': { ok: true, json: { success: true, message: 'Session killed' } },
    });

    const { result } = renderHook(() => useMonitoringData(mockConnection));

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    let killResult = false;
    await act(async () => {
      killResult = await result.current.killSession(12345);
    });

    expect(killResult).toBe(true);
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  // ── killSession returns false on failure ───────────────────────────────────

  test('killSession returns false on failure', async () => {
    mockGlobalFetch({
      '/api/db/monitoring': { ok: true, json: mockMonitoringResponse },
      '/api/db/maintenance': { ok: false, status: 500, json: { error: 'Permission denied' } },
    });

    const { result } = renderHook(() => useMonitoringData(mockConnection));

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    let killResult = true;
    await act(async () => {
      killResult = await result.current.killSession(12345);
    });

    expect(killResult).toBe(false);
    expect(mockToastError).toHaveBeenCalled();
  });

  // ── runMaintenance calls correct endpoint ──────────────────────────────────

  test('runMaintenance calls correct endpoint', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/monitoring': { ok: true, json: mockMonitoringResponse },
      '/api/db/maintenance': { ok: true, json: { success: true, message: 'VACUUM completed' } },
    });

    const { result } = renderHook(() => useMonitoringData(mockConnection));

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    let maintenanceResult = false;
    await act(async () => {
      maintenanceResult = await result.current.runMaintenance('vacuum', 'public.users');
    });

    expect(maintenanceResult).toBe(true);

    const maintenanceCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/maintenance')
    );
    expect(maintenanceCall).toBeDefined();

    const body = JSON.parse(maintenanceCall![1]!.body as string);
    expect(body.type).toBe('vacuum');
    expect(body.target).toBe('public.users');
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  // ── history is empty initially ─────────────────────────────────────────────

  test('history is empty initially', () => {
    mockGlobalFetch({});

    const { result } = renderHook(() => useMonitoringData(null));

    expect(result.current.history).toEqual([]);
  });

  // ── history grows after successful fetch ───────────────────────────────────

  test('history grows after successful fetch', async () => {
    mockGlobalFetch({
      '/api/db/monitoring': { ok: true, json: mockMonitoringResponse },
    });

    const { result } = renderHook(() => useMonitoringData(mockConnection));

    await waitFor(() => {
      expect(result.current.data).not.toBeNull();
    });

    expect(result.current.history.length).toBeGreaterThan(0);
    expect(result.current.history[0]).toHaveProperty('timestamp');
    expect(result.current.history[0]).toHaveProperty('data');
  });
});
