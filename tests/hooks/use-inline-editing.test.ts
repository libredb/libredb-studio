import '../setup-dom';
import { mockToastSuccess, mockToastError } from '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { restoreGlobalFetch } from '../helpers/mock-fetch';

import { useInlineEditing } from '@/hooks/use-inline-editing';
import type { DatabaseConnection, QueryTab, QueryResult } from '@/lib/types';
import type { CellChange } from '@/components/ResultsGrid';

// ── Test Data ───────────────────────────────────────────────────────────────

const makeConnection = (overrides: Partial<DatabaseConnection> = {}): DatabaseConnection => ({
  id: 'conn-1',
  name: 'Test DB',
  type: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'admin',
  password: 'secret',
  createdAt: new Date('2026-01-01'),
  ...overrides,
});

const makeResult = (overrides: Partial<QueryResult> = {}): QueryResult => ({
  rows: [
    { id: 1, name: 'Alice', email: 'alice@test.com' },
    { id: 2, name: 'Bob', email: 'bob@test.com' },
  ],
  fields: ['id', 'name', 'email'],
  rowCount: 2,
  executionTime: 12,
  ...overrides,
});

const makeTab = (overrides: Partial<QueryTab> = {}): QueryTab => ({
  id: 'tab-1',
  name: 'users',
  query: 'SELECT * FROM users',
  result: makeResult(),
  isExecuting: false,
  type: 'sql',
  ...overrides,
});

const makeChange = (overrides: Partial<CellChange> = {}): CellChange => ({
  rowIndex: 0,
  columnId: 'name',
  originalValue: 'Alice',
  newValue: 'Alice Updated',
  ...overrides,
});

// =============================================================================
// useInlineEditing Tests
// =============================================================================
describe('useInlineEditing', () => {
  let mockExecuteQuery: ReturnType<typeof mock>;

  beforeEach(() => {
    mockExecuteQuery = mock(() => {});
    mockToastSuccess.mockClear();
    mockToastError.mockClear();
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  // ── Initial State ─────────────────────────────────────────────────────────

  test('initially editingEnabled is false and pendingChanges is empty', () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      })
    );

    expect(result.current.editingEnabled).toBe(false);
    expect(result.current.pendingChanges).toEqual([]);
  });

  // ── handleCellChange adds a change ────────────────────────────────────────

  test('handleCellChange adds a change', () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      })
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });

    expect(result.current.pendingChanges).toHaveLength(1);
    expect(result.current.pendingChanges[0].columnId).toBe('name');
    expect(result.current.pendingChanges[0].newValue).toBe('Alice Updated');
  });

  // ── handleCellChange replaces existing change for same cell ───────────────

  test('handleCellChange replaces existing change for same cell', () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      })
    );

    act(() => {
      result.current.handleCellChange(makeChange({ newValue: 'First edit' }));
    });

    act(() => {
      result.current.handleCellChange(makeChange({ newValue: 'Second edit' }));
    });

    expect(result.current.pendingChanges).toHaveLength(1);
    expect(result.current.pendingChanges[0].newValue).toBe('Second edit');
  });

  // ── handleCellChange removes change when reverting to original ────────────

  test('handleCellChange removes change when reverting to original value', () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      })
    );

    // Add a change first
    act(() => {
      result.current.handleCellChange(makeChange({ newValue: 'Edited' }));
    });

    expect(result.current.pendingChanges).toHaveLength(1);

    // Revert to original value
    act(() => {
      result.current.handleCellChange(makeChange({ newValue: 'Alice' }));
    });

    expect(result.current.pendingChanges).toHaveLength(0);
  });

  // ── handleCellChange ignores no-op change ─────────────────────────────────

  test('handleCellChange ignores no-op change', () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      })
    );

    // Try to add a "change" where newValue equals originalValue
    act(() => {
      result.current.handleCellChange(makeChange({
        originalValue: 'Alice',
        newValue: 'Alice',
      }));
    });

    expect(result.current.pendingChanges).toHaveLength(0);
  });

  // ── handleApplyChanges generates UPDATE SQL ───────────────────────────────

  test('handleApplyChanges generates UPDATE SQL and calls executeQuery', async () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      })
    );

    // Add a pending change
    act(() => {
      result.current.handleCellChange(makeChange({
        rowIndex: 0,
        columnId: 'name',
        originalValue: 'Alice',
        newValue: 'Alice Updated',
      }));
    });

    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).toHaveBeenCalledTimes(1);

    const sql = (mockExecuteQuery as ReturnType<typeof mock>).mock.calls[0][0] as string;
    expect(sql).toContain('UPDATE');
    expect(sql).toContain('users');
    expect(sql).toContain("name = 'Alice Updated'");
    expect(sql).toContain('WHERE id = 1');

    // Changes should be cleared after apply
    expect(result.current.pendingChanges).toEqual([]);
    expect(result.current.editingEnabled).toBe(false);
  });

  // ── handleApplyChanges no primary key ─────────────────────────────────────

  test('handleApplyChanges shows toast when no primary key column found', async () => {
    const tabNoPk = makeTab({
      result: makeResult({
        fields: ['name', 'email'],  // No 'id' or '*_id' column
        rows: [{ name: 'Alice', email: 'alice@test.com' }],
      }),
    });

    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: tabNoPk,
        executeQuery: mockExecuteQuery as (sql: string) => void,
      })
    );

    act(() => {
      result.current.handleCellChange({
        rowIndex: 0,
        columnId: 'name',
        originalValue: 'Alice',
        newValue: 'Bob',
      });
    });

    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(mockToastError).toHaveBeenCalledWith(
      'Cannot Apply Changes',
      { description: expect.stringContaining('No primary key column detected') }
    );
  });

  // ── handleApplyChanges no active connection ───────────────────────────────

  test('handleApplyChanges does nothing when no active connection', async () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: null,
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      })
    );

    act(() => {
      result.current.handleCellChange(makeChange());
    });

    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
  });

  // ── handleApplyChanges empty pendingChanges ───────────────────────────────

  test('handleApplyChanges does nothing when pendingChanges is empty', async () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      })
    );

    await act(async () => {
      await result.current.handleApplyChanges();
    });

    expect(mockExecuteQuery).not.toHaveBeenCalled();
    expect(mockToastSuccess).not.toHaveBeenCalled();
  });

  // ── handleDiscardChanges ──────────────────────────────────────────────────

  test('handleDiscardChanges clears pendingChanges', () => {
    const { result } = renderHook(() =>
      useInlineEditing({
        activeConnection: makeConnection(),
        currentTab: makeTab(),
        executeQuery: mockExecuteQuery as (sql: string) => void,
      })
    );

    // Add some changes
    act(() => {
      result.current.handleCellChange(makeChange({ rowIndex: 0, columnId: 'name', newValue: 'X' }));
      result.current.handleCellChange(makeChange({ rowIndex: 1, columnId: 'email', originalValue: 'bob@test.com', newValue: 'y@test.com' }));
    });

    expect(result.current.pendingChanges.length).toBeGreaterThan(0);

    act(() => {
      result.current.handleDiscardChanges();
    });

    expect(result.current.pendingChanges).toEqual([]);
  });
});
