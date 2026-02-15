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

  // ── executeQuery uses queryEditorRef.getEffectiveQuery when available ──

  test('executeQuery uses queryEditorRef.getEffectiveQuery when no override', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/query': { ok: true, json: mockQueryResult },
    });
    const mockEditorRef = {
      current: {
        getEffectiveQuery: () => 'SELECT id FROM users WHERE active = true',
        focus: () => {},
      },
    };
    const params = createDefaultParams({ queryEditorRef: mockEditorRef });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery(); // No override
    });

    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/query')
    );
    expect(queryCall).toBeDefined();
    const body = JSON.parse(queryCall![1]!.body as string);
    expect(body.sql).toBe('SELECT id FROM users WHERE active = true');
  });

  // ── executeQuery falls back to tab query when no override and no ref ────

  test('executeQuery falls back to tab query when no override and no ref', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/query': { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery(); // No override, ref is null
    });

    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/query')
    );
    expect(queryCall).toBeDefined();
    const body = JSON.parse(queryCall![1]!.body as string);
    expect(body.sql).toBe('SELECT * FROM users'); // Falls back to tab query
  });

  // ── executeQuery shows toast when EXPLAIN not supported ────────────────

  test('executeQuery shows toast when EXPLAIN not supported', async () => {
    mockGlobalFetch({});
    const noExplainMetadata: ProviderMetadata = {
      ...mockMetadata,
      capabilities: { ...mockMetadata.capabilities, supportsExplain: false },
    };
    const params = createDefaultParams({ metadata: noExplainMetadata });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('SELECT * FROM users', undefined, true); // isExplain = true
    });

    expect(mockToastError).toHaveBeenCalled();
  });

  // ── executeQuery in playground mode begins + rollbacks transaction ─────

  test('executeQuery in playground mode begins and rollbacks transaction', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/transaction': { ok: true, json: mockQueryResult },
      '/api/db/query': { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams({ playgroundMode: true });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('SELECT * FROM users');
    });

    // Should have called transaction endpoint for begin, query, and rollback
    const txnCalls = fetchMock.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/transaction')
    );
    expect(txnCalls.length).toBeGreaterThanOrEqual(2); // begin + query (rollback may also count)

    // First call should be BEGIN
    const beginBody = JSON.parse(txnCalls[0][1]!.body as string);
    expect(beginBody.action).toBe('begin');
  });

  // ── executeQuery in playground mode rollbacks on error ─────────────────

  test('executeQuery in playground mode rollbacks on error', async () => {
    mockGlobalFetch({
      '/api/db/transaction': () => {
        return { ok: true, json: mockQueryResult };
      },
      '/api/db/query': { ok: true, json: mockQueryResult },
    });

    // Override for more specific behavior
    let callCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/api/db/transaction')) {
        callCount++;
        const body = JSON.parse(init?.body as string || '{}');
        if (body.action === 'begin') {
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (body.action === 'query') {
          return new Response(JSON.stringify({ error: 'syntax error' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (body.action === 'rollback') {
          return new Response(JSON.stringify({ success: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
    }) as typeof fetch;

    const params = createDefaultParams({ playgroundMode: true });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('INVALID SQL');
    });

    // Should have called transaction endpoint at least 2 times (begin + rollback on error)
    expect(callCount).toBeGreaterThanOrEqual(2);

    globalThis.fetch = originalFetch;
  });

  // ── multi-statement error shows error toast ────────────────────────────

  test('multi-statement query with error shows error toast', async () => {
    const multiErrorResult = {
      multiStatement: true,
      executedCount: 2,
      statementCount: 3,
      hasError: true,
      rows: [],
      fields: [],
      rowCount: 0,
      executionTime: 30,
      statements: [
        { index: 0, status: 'success', rowCount: 1 },
        { index: 1, status: 'error', error: 'relation "bad" does not exist' },
      ],
    };

    mockGlobalFetch({
      '/api/db/multi-query': { ok: true, json: multiErrorResult },
      '/api/db/query': { ok: true, json: mockQueryResult },
    });

    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('SELECT 1; SELECT * FROM bad; SELECT 2;');
    });

    expect(mockToastError).toHaveBeenCalled();
  });

  // ── executeQuery refreshes schema after DDL ────────────────────────────

  test('executeQuery calls fetchSchema after DDL query', async () => {
    const fetchSchemaMock = mock(async () => {});
    mockGlobalFetch({
      '/api/db/query': { ok: true, json: { ...mockQueryResult, rows: [], rowCount: 0 } },
    });
    const params = createDefaultParams({ fetchSchema: fetchSchemaMock });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('CREATE TABLE test_table (id INT)', undefined, false, { skipSafety: true });
    });

    expect(fetchSchemaMock).toHaveBeenCalled();
  });

  // ── executeQuery does NOT refresh schema for SELECT ────────────────────

  test('executeQuery does NOT call fetchSchema for SELECT', async () => {
    const fetchSchemaMock = mock(async () => {});
    mockGlobalFetch({
      '/api/db/query': { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams({ fetchSchema: fetchSchemaMock });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('SELECT * FROM users');
    });

    expect(fetchSchemaMock).not.toHaveBeenCalled();
  });

  // ── handleLoadMore does nothing when no more data ──────────────────────

  test('handleLoadMore does nothing when pagination hasMore is false', async () => {
    const fetchMock = mockGlobalFetch({});
    const tabNoMore = createTab({
      result: {
        ...mockQueryResult,
        pagination: { limit: 500, offset: 0, hasMore: false, totalReturned: 2, wasLimited: false },
      },
    });
    const params = createDefaultParams({ tabs: [tabNoMore], currentTab: tabNoMore });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      result.current.handleLoadMore();
    });

    // No fetch calls for query
    const queryCalls = fetchMock.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/query')
    );
    expect(queryCalls.length).toBe(0);
  });

  // ── handleUnlimitedQuery executes pending unlimited query ──────────────

  test('handleUnlimitedQuery executes pending unlimited query', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/query': { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    // Set pending unlimited query
    act(() => {
      result.current.setPendingUnlimitedQuery({ query: 'SELECT * FROM big_table', tabId: 'tab-1' });
      result.current.setUnlimitedWarningOpen(true);
    });

    expect(result.current.pendingUnlimitedQuery).not.toBeNull();
    expect(result.current.unlimitedWarningOpen).toBe(true);

    await act(async () => {
      result.current.handleUnlimitedQuery();
    });

    // Should have cleared the pending state
    expect(result.current.unlimitedWarningOpen).toBe(false);
    expect(result.current.pendingUnlimitedQuery).toBeNull();

    // Should have called query API with unlimited flag
    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/query')
    );
    expect(queryCall).toBeDefined();
    const body = JSON.parse(queryCall![1]!.body as string);
    expect(body.options.unlimited).toBe(true);
  });

  // ── handleUnlimitedQuery does nothing when no pending query ───────────

  test('handleUnlimitedQuery does nothing when no pending query', async () => {
    const fetchMock = mockGlobalFetch({});
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      result.current.handleUnlimitedQuery();
    });

    // No fetch calls
    expect(fetchMock.mock.calls.length).toBe(0);
  });

  // ── "Query was cancelled" message handling ─────────────────────────────

  test('shows cancellation toast for "Query was cancelled" error message', async () => {
    mockGlobalFetch({
      '/api/db/query': { ok: false, status: 500, json: { error: 'Query was cancelled by user' } },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('SELECT pg_sleep(60)');
    });

    // Should show cancellation toast, not generic error
    expect(mockToastSuccess).toHaveBeenCalled();
  });

  // ── execute-query custom event listener ────────────────────────────────

  test('listens for execute-query custom events', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/query': { ok: true, json: mockQueryResult },
    });
    const params = createDefaultParams();

    renderHook(() => useQueryExecution(params));

    // Dispatch custom event
    await act(async () => {
      window.dispatchEvent(new CustomEvent('execute-query', {
        detail: { query: 'SELECT 42' },
      }));
    });

    // Give it time to process
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/query')
    );
    expect(queryCall).toBeDefined();
    const body = JSON.parse(queryCall![1]!.body as string);
    expect(body.sql).toBe('SELECT 42');
  });

  // ── executeQuery with EXPLAIN builds correct query for mysql ───────────

  test('executeQuery builds EXPLAIN FORMAT=JSON for mysql', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/query': { ok: true, json: { rows: [{ 'QUERY PLAN': {} }], fields: ['QUERY PLAN'], rowCount: 1, executionTime: 5 } },
    });
    const mysqlConnection = { ...mockConnection, type: 'mysql' as const };
    const params = createDefaultParams({ activeConnection: mysqlConnection });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('SELECT * FROM users', undefined, true);
    });

    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/query')
    );
    expect(queryCall).toBeDefined();
    const body = JSON.parse(queryCall![1]!.body as string);
    expect(body.sql).toContain('EXPLAIN FORMAT=JSON');
  });

  // ── executeQuery EXPLAIN skips non-SELECT ──────────────────────────────

  test('executeQuery EXPLAIN on non-SELECT sends original query', async () => {
    const fetchMock = mockGlobalFetch({
      '/api/db/query': { ok: true, json: { rows: [], fields: [], rowCount: 0, executionTime: 5 } },
    });
    const params = createDefaultParams();

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('INSERT INTO users (name) VALUES (\'test\')', undefined, true);
    });

    const queryCall = fetchMock.mock.calls.find(
      (call) => typeof call[0] === 'string' && call[0].includes('/api/db/query')
    );
    expect(queryCall).toBeDefined();
    const body = JSON.parse(queryCall![1]!.body as string);
    // Non-SELECT queries should not be wrapped in EXPLAIN
    expect(body.sql).not.toContain('EXPLAIN');
  });

  // ── executeQuery load more appends rows ────────────────────────────────

  test('executeQuery with offset appends rows (load more)', async () => {
    const existingRows = [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];
    const newRows = [{ id: 3, name: 'Charlie' }];

    mockGlobalFetch({
      '/api/db/query': { ok: true, json: { rows: newRows, fields: ['id', 'name'], rowCount: 1, executionTime: 5, pagination: { limit: 500, offset: 2, hasMore: false, totalReturned: 1, wasLimited: false } } },
    });

    const tabWithResults = createTab({
      result: {
        ...mockQueryResult,
        rows: existingRows,
        rowCount: 2,
        pagination: { limit: 500, offset: 0, hasMore: true, totalReturned: 2, wasLimited: true },
      },
      allRows: existingRows,
      currentOffset: 2,
    });

    const setTabsMock = mock((fn: unknown) => {
      if (typeof fn === 'function') {
        fn([tabWithResults]);
      }
    });

    const params = createDefaultParams({
      tabs: [tabWithResults],
      currentTab: tabWithResults,
      setTabs: setTabsMock,
    });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('SELECT * FROM users', 'tab-1', false, { limit: 500, offset: 2 });
    });

    // setTabs should have been called to append rows
    expect(setTabsMock).toHaveBeenCalled();
  });

  // ── executeQuery demo connection error has enhanced message ─────────────

  test('executeQuery on demo connection shows enhanced error message', async () => {
    mockGlobalFetch({
      '/api/db/query': { ok: false, status: 500, json: { error: 'Connection timeout' } },
    });
    const demoConnection = { ...mockConnection, isDemo: true };
    const params = createDefaultParams({ activeConnection: demoConnection });

    const { result } = renderHook(() => useQueryExecution(params));

    await act(async () => {
      await result.current.executeQuery('SELECT * FROM users');
    });

    expect(mockToastError).toHaveBeenCalled();
  });
});
