import '../setup-dom';
import { mockToastSuccess, mockToastError } from '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { describe, test, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { renderHook, act, waitFor } from '@testing-library/react';
import { mockGlobalFetch, restoreGlobalFetch } from '../helpers/mock-fetch';
import { storage } from '@/lib/storage';

// ── Mock QuerySafetyDialog ──────────────────────────────────────────────────
mock.module('@/components/QuerySafetyDialog', () => ({
  isDangerousQuery: (q: string) =>
    q.toUpperCase().includes('DROP') ||
    q.toUpperCase().includes('DELETE') ||
    q.toUpperCase().includes('TRUNCATE'),
}));

import { useQueryExecution } from '@/hooks/use-query-execution';
import type { DatabaseConnection, QueryTab } from '@/lib/types';
import type { ProviderMetadata } from '@/hooks/use-provider-metadata';

// =============================================================================
// Test Data
// =============================================================================
const mockConnection: DatabaseConnection = {
  id: 'qe-pg-1',
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

const mockMetadata: ProviderMetadata = {
  capabilities: {
    queryLanguage: 'sql' as const,
    supportsExplain: true,
    supportsExternalQueryLimiting: true,
    supportsCreateTable: true,
    supportsMaintenance: true,
    maintenanceOperations: ['vacuum', 'analyze'],
    supportsConnectionString: true,
    defaultPort: 5432,
    schemaRefreshPattern: '^(CREATE|DROP|ALTER)\\b',
  },
  labels: {
    entityName: 'Table',
    entityNamePlural: 'Tables',
    rowName: 'Row',
    rowNamePlural: 'Rows',
    selectAction: 'SELECT * FROM',
    generateAction: 'Generate SELECT',
    analyzeAction: 'Analyze',
    vacuumAction: 'Vacuum',
    searchPlaceholder: 'Search tables...',
    analyzeGlobalLabel: 'Analyze All',
    analyzeGlobalTitle: 'Analyze All Tables',
    analyzeGlobalDesc: 'Analyze all tables in the database',
    vacuumGlobalLabel: 'Vacuum All',
    vacuumGlobalTitle: 'Vacuum All Tables',
    vacuumGlobalDesc: 'Vacuum all tables in the database',
  },
};

const createTab = (overrides?: Partial<QueryTab>): QueryTab => ({
  id: 'tab-1',
  name: 'Query 1',
  query: 'SELECT * FROM users',
  result: null,
  isExecuting: false,
  type: 'sql',
  ...overrides,
});

const mockQueryResult = {
  rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
  fields: ['id', 'name'],
  rowCount: 2,
  executionTime: 15,
  pagination: { limit: 500, offset: 0, hasMore: false, totalReturned: 2, wasLimited: false },
};

function createDefaultParams(overrides?: Record<string, unknown>) {
  const tab = createTab();
  const setTabsMock = mock((fn: unknown) => {
    // Apply function if it's a function (for state updater pattern)
    if (typeof fn === 'function') {
      fn([tab]);
    }
  });

  return {
    activeConnection: mockConnection,
    metadata: mockMetadata,
    tabs: [tab],
    activeTabId: 'tab-1',
    currentTab: tab,
    setTabs: setTabsMock,
    transactionActive: false,
    playgroundMode: false,
    fetchSchema: mock(async () => {}),
    queryEditorRef: { current: null },
    ...overrides,
  };
}

// =============================================================================
// useQueryExecution Tests
// =============================================================================
let addToHistorySpy: ReturnType<typeof spyOn>;

describe('useQueryExecution', () => {
  beforeEach(() => {
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
    addToHistorySpy = spyOn(storage, 'addToHistory').mockImplementation(() => {});
  });

  afterEach(() => {
    addToHistorySpy.mockRestore();
    restoreGlobalFetch();
  });

  // ── Initially bottomPanelMode is 'results' ────────────────────────────────

  test('initially bottomPanelMode is results', () => {
    mockGlobalFetch({});
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    expect(result.current.bottomPanelMode).toBe('results');
  });

  // ── executeQuery shows toast when no connection ────────────────────────────

  test('executeQuery shows toast when no connection', async () => {
    mockGlobalFetch({});
    const params = createDefaultParams({ activeConnection: null });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('SELECT 1');
    });

    // useToast wraps sonnerToast.error for destructive variant
    expect(mockToastError).toHaveBeenCalled();
  });

  // ── executeQuery calls /api/db/query POST with correct body ────────────────

  test('executeQuery calls /api/db/query POST with correct body', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/query': { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('SELECT * FROM users');
    });

    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/query')
    );
    expect(queryCall).toBeDefined();
    expect(queryCall![1]).toMatchObject({ method: 'POST' });

    const body = JSON.parse(queryCall![1]!.body as string);
    expect(body.sql).toBe('SELECT * FROM users');
    expect(body.connection).toBeDefined();
    expect(body.connection.id).toBe('qe-pg-1');
  });

  // ── executeQuery updates tab result on success ─────────────────────────────

  test('executeQuery updates tab result on success', async () => {
    mockGlobalFetch({
      '/api/db/query': { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('SELECT * FROM users');
    });

    // setTabs should have been called (state updater function)
    expect(params.setTabs).toHaveBeenCalled();
  });

  // ── executeQuery adds to history on success ────────────────────────────────

  test('executeQuery adds to history on success', async () => {
    mockGlobalFetch({
      '/api/db/query': { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('SELECT * FROM users');
    });

    expect(storage.addToHistory).toHaveBeenCalled();
    const historyArg = (storage.addToHistory as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
    expect(historyArg.query).toBe('SELECT * FROM users');
    expect(historyArg.connectionId).toBe('qe-pg-1');
    expect(historyArg.status).toBe('success');
  });

  // ── executeQuery shows toast on error ──────────────────────────────────────

  test('executeQuery shows toast on error', async () => {
    mockGlobalFetch({
      '/api/db/query': { ok: false, status: 400, json: { error: 'syntax error at position 1' } },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('SELEC * FROM users');
    });

    expect(mockToastError).toHaveBeenCalled();
  });

  // ── executeQuery sets safetyCheckQuery for dangerous queries ───────────────

  test('executeQuery sets safetyCheckQuery for dangerous queries (DROP/DELETE)', async () => {
    mockGlobalFetch({});
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('DROP TABLE users');
    });

    expect(result.current.safetyCheckQuery).toBe('DROP TABLE users');
  });

  test('executeQuery sets safetyCheckQuery for DELETE queries', async () => {
    mockGlobalFetch({});
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('DELETE FROM users WHERE id = 1');
    });

    expect(result.current.safetyCheckQuery).toBe('DELETE FROM users WHERE id = 1');
  });

  // ── executeQuery skips safety check when skipSafety is true ────────────────

  test('executeQuery skips safety check when skipSafety is true', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/query': { ok: true, json: { ...mockQueryResult, rows: [], rowCount: 0 } },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('DROP TABLE users', undefined, false, { skipSafety: true });
    });

    // Should NOT set safetyCheckQuery, should proceed to execute
    expect(result.current.safetyCheckQuery).toBeNull();

    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/query')
    );
    expect(queryCall).toBeDefined();
  });

  // ── forceExecuteQuery clears safetyCheckQuery and calls executeQuery ───────

  test('forceExecuteQuery clears safetyCheckQuery and calls with skipSafety', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/query': { ok: true, json: { ...mockQueryResult, rows: [], rowCount: 0 } },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    // First trigger safety check
    await act(async () => {
      await result.current.executeQuery('DROP TABLE users');
    });
    expect(result.current.safetyCheckQuery).toBe('DROP TABLE users');

    // Now force execute
    await act(async () => {
      result.current.forceExecuteQuery('DROP TABLE users');
    });

    // safetyCheckQuery should be cleared
    expect(result.current.safetyCheckQuery).toBeNull();

    // Query should have been sent to server
    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/query')
    );
    expect(queryCall).toBeDefined();
  });

  // ── cancelQuery aborts the fetch controller ────────────────────────────────

  test('cancelQuery aborts the fetch controller', async () => {
    // We intercept fetch to track AbortSignal usage
    let abortSignalUsed = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/db/query') && init?.signal) {
        // Track that signal was provided
        abortSignalUsed = true;
        // Return a delayed promise that respects abort
        return new Promise<Response>((resolve, reject) => {
          if (init.signal!.aborted) {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
            return;
          }
          init.signal!.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
          // Never resolve naturally — test will cancel
        });
      }
      if (url.includes('/api/db/cancel')) {
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    }) as typeof fetch;

    const params = createDefaultParams();
    const { result } = renderHook(() => useQueryExecution(params));

    // Start a query (don't await it — it will hang until cancelled)
    const queryPromise = act(async () => {
      await result.current.executeQuery('SELECT * FROM users');
    });

    // Cancel it
    await act(async () => {
      await result.current.cancelQuery();
    });

    await queryPromise;

    expect(abortSignalUsed).toBe(true);
    // Toast should indicate cancellation
    expect(mockToastSuccess).toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  // ── cancelQuery calls /api/db/cancel on server ─────────────────────────────

  test('cancelQuery calls /api/db/cancel on server', async () => {
    let cancelCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/db/query')) {
        return new Promise<Response>((resolve, reject) => {
          if (init?.signal?.aborted) {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
            return;
          }
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      }
      if (url.includes('/api/db/cancel')) {
        cancelCalled = true;
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    }) as typeof fetch;

    const params = createDefaultParams();
    const { result } = renderHook(() => useQueryExecution(params));

    // Start query
    const queryPromise = act(async () => {
      await result.current.executeQuery('SELECT * FROM users');
    });

    // Cancel
    await act(async () => {
      await result.current.cancelQuery();
    });

    await queryPromise;

    expect(cancelCalled).toBe(true);

    globalThis.fetch = originalFetch;
  });

  // ── handleLoadMore calls executeQuery with offset ──────────────────────────

  test('handleLoadMore calls executeQuery with offset', async () => {
    const tabWithResults = createTab({
      result: {
        ...mockQueryResult,
        pagination: { limit: 500, offset: 0, hasMore: true, totalReturned: 500, wasLimited: true },
      },
      currentOffset: 500,
    });

    const fetchMock = mockGlobalFetch({
      '/api/db/query': { ok: true, json: { ...mockQueryResult, rows: [{ id: 3, name: 'Charlie' }], rowCount: 1 } },
    });

    const params = createDefaultParams({
      tabs: [tabWithResults],
      currentTab: tabWithResults,
    });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      result.current.handleLoadMore();
    });

    await waitFor(() => {
      const queryCall = fetchMock.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('/api/db/query')
      );
      expect(queryCall).toBeDefined();
      const body = JSON.parse(queryCall![1]!.body as string);
      expect(body.options.offset).toBe(500);
    });
  });

  // ── setBottomPanelMode changes mode ────────────────────────────────────────

  test('setBottomPanelMode changes mode', () => {
    mockGlobalFetch({});
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    act(() => {
      result.current.setBottomPanelMode('history');
    });

    expect(result.current.bottomPanelMode).toBe('history');

    act(() => {
      result.current.setBottomPanelMode('saved');
    });

    expect(result.current.bottomPanelMode).toBe('saved');
  });

  // ── executeQuery sets explain panel mode for explain queries ────────────────

  test('executeQuery sets explain panel mode for explain queries', async () => {
    mockGlobalFetch({
      '/api/db/query': { ok: true, json: { rows: [{ 'QUERY PLAN': { plan: 'Seq Scan' } }], fields: ['QUERY PLAN'], rowCount: 1, executionTime: 5 } },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('SELECT * FROM users', undefined, true);
    });

    expect(result.current.bottomPanelMode).toBe('explain');
  });

  // ── executeQuery uses /api/db/multi-query for multi-statement queries ──────

  test('executeQuery uses /api/db/multi-query for multi-statement queries', async () => {
    const multiResult = {
      multiStatement: true,
      executedCount: 2,
      statementCount: 2,
      hasError: false,
      rows: [{ id: 1 }],
      fields: ['id'],
      rowCount: 1,
      executionTime: 20,
      statements: [
        { index: 0, status: 'success', rowCount: 1 },
        { index: 1, status: 'success', rowCount: 0 },
      ],
    };

    const fetchMock = mockGlobalFetch({
      '/api/db/multi-query': { ok: true, json: multiResult },
      '/api/db/query': { ok: true, json: mockQueryResult },
    });

    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('SELECT 1; SELECT 2;');
    });

    const multiCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/multi-query')
    );
    expect(multiCall).toBeDefined();
  });

  // ── executeQuery uses /api/db/transaction when transactionActive ───────────

  test('executeQuery uses /api/db/transaction when transactionActive', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/transaction': { ok: true, json: mockQueryResult },
      '/api/db/query': { ok: true, json: mockQueryResult },
    });

    const params = createDefaultParams({ transactionActive: true });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('SELECT * FROM users');
    });

    const txnCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/transaction')
    );
    expect(txnCall).toBeDefined();

    const body = JSON.parse(txnCall![1]!.body as string);
    expect(body.action).toBe('query');
    expect(body.sql).toBe('SELECT * FROM users');
  });

  // ── executeQuery adds error to history on failure ──────────────────────────

  test('executeQuery adds to history on error response', async () => {
    mockGlobalFetch({
      '/api/db/query': { ok: false, status: 400, json: { error: 'relation does not exist' } },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('SELECT * FROM nonexistent');
    });

    expect(storage.addToHistory).toHaveBeenCalled();
    const historyArg = (storage.addToHistory as ReturnType<typeof mock>).mock.calls[0][0] as Record<string, unknown>;
    expect(historyArg.status).toBe('error');
    expect(historyArg.errorMessage).toBe('relation does not exist');
  });

  // ── safetyCheckQuery is null initially ─────────────────────────────────────

  test('safetyCheckQuery is null initially', () => {
    mockGlobalFetch({});
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    expect(result.current.safetyCheckQuery).toBeNull();
  });

  // ── unlimitedWarningOpen is false initially ────────────────────────────────

  test('unlimitedWarningOpen is false initially', () => {
    mockGlobalFetch({});
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    expect(result.current.unlimitedWarningOpen).toBe(false);
  });

  // ── pendingUnlimitedQuery is null initially ────────────────────────────────

  test('pendingUnlimitedQuery is null initially', () => {
    mockGlobalFetch({});
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    expect(result.current.pendingUnlimitedQuery).toBeNull();
  });
});
