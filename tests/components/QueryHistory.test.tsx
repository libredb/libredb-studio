import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { mock } from 'bun:test';

// Mock storage before component import
const mockHistory = [
  {
    id: 'h1',
    query: 'SELECT * FROM users',
    executedAt: new Date('2026-01-15T10:00:00Z'),
    executionTime: 25,
    rowCount: 10,
    status: 'success' as const,
    connectionId: 'c1',
    connectionName: 'TestDB',
    tabName: 'Query 1',
  },
  {
    id: 'h2',
    query: 'DROP TABLE bad',
    executedAt: new Date('2026-01-14T08:00:00Z'),
    executionTime: 5,
    rowCount: 0,
    status: 'error' as const,
    errorMessage: 'permission denied',
    connectionId: 'c2',
    connectionName: 'ProdDB',
    tabName: 'Query 2',
  },
];

const mockGetHistory = mock(() => [...mockHistory]);
const mockClearHistory = mock(() => {});

mock.module('@/lib/storage', () => ({
  storage: {
    getHistory: mockGetHistory,
    clearHistory: mockClearHistory,
  },
}));

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, fireEvent, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

import { QueryHistory } from '@/components/QueryHistory';

// =============================================================================
// QueryHistory Tests
// =============================================================================

function createDefaultProps(overrides: Partial<Parameters<typeof QueryHistory>[0]> = {}) {
  return {
    onSelectQuery: mock(() => {}),
    activeConnectionId: undefined,
    refreshTrigger: 0,
    ...overrides,
  };
}

describe('QueryHistory', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockGetHistory.mockClear();
    mockClearHistory.mockClear();
    mockGetHistory.mockImplementation(() => [...mockHistory]);
  });

  // ── Renders history items ─────────────────────────────────────────────────

  test('renders history items from storage', () => {
    const props = createDefaultProps();
    const { container } = render(<QueryHistory {...props} />);
    const view = within(container);

    expect(view.queryByText('SELECT * FROM users')).not.toBeNull();
    expect(view.queryByText('DROP TABLE bad')).not.toBeNull();
  });

  // ── Status icons ──────────────────────────────────────────────────────────

  test('shows success and error status indicators', () => {
    const props = createDefaultProps();
    const { container } = render(<QueryHistory {...props} />);

    const successIndicators = container.querySelectorAll('.bg-emerald-500\\/10');
    const errorIndicators = container.querySelectorAll('.bg-red-500\\/10');

    expect(successIndicators.length).toBeGreaterThan(0);
    expect(errorIndicators.length).toBeGreaterThan(0);
  });

  // ── Search filters ────────────────────────────────────────────────────────

  test('search filters by query text', async () => {
    const user = userEvent.setup();
    const props = createDefaultProps();
    const { container } = render(<QueryHistory {...props} />);
    const view = within(container);

    // Both items initially visible
    expect(view.queryByText('SELECT * FROM users')).not.toBeNull();
    expect(view.queryByText('DROP TABLE bad')).not.toBeNull();

    // Type in search using userEvent (fireEvent.change doesn't trigger React 19 onChange)
    const searchInput = view.getByPlaceholderText('Search by query, connection or tab...');
    await user.type(searchInput, 'SELECT');

    // Only SELECT query should remain
    expect(view.queryByText('SELECT * FROM users')).not.toBeNull();
    expect(view.queryByText('DROP TABLE bad')).toBeNull();
  });

  // ── Restore button fires onSelectQuery ────────────────────────────────────

  test('onSelectQuery fires when restore button clicked', () => {
    const onSelectQuery = mock(() => {});
    const props = createDefaultProps({ onSelectQuery });
    const { container } = render(<QueryHistory {...props} />);
    const view = within(container);

    const restoreButtons = view.getAllByTitle('Restore Query');
    expect(restoreButtons.length).toBe(2);

    fireEvent.click(restoreButtons[0]);

    expect(onSelectQuery).toHaveBeenCalledTimes(1);
    expect(onSelectQuery).toHaveBeenCalledWith('SELECT * FROM users');
  });

  // ── Clear history ─────────────────────────────────────────────────────────

  test('clear history clears state after confirm', () => {
    const originalConfirm = globalThis.confirm;
    globalThis.confirm = mock(() => true) as unknown as typeof confirm;

    const props = createDefaultProps();
    const { container } = render(<QueryHistory {...props} />);
    const view = within(container);

    expect(view.queryByText('SELECT * FROM users')).not.toBeNull();

    const clearButton = view.getByText('Clear');
    fireEvent.click(clearButton);

    expect(mockClearHistory).toHaveBeenCalledTimes(1);
    expect(view.queryByText('SELECT * FROM users')).toBeNull();

    globalThis.confirm = originalConfirm;
  });

  // ── Empty state ───────────────────────────────────────────────────────────

  test('empty state when no items match filter', async () => {
    const user = userEvent.setup();
    const props = createDefaultProps();
    const { container } = render(<QueryHistory {...props} />);
    const view = within(container);

    const searchInput = view.getByPlaceholderText('Search by query, connection or tab...');
    await user.type(searchInput, 'NONEXISTENT_QUERY_XYZ');

    expect(view.queryByText('No history items found')).not.toBeNull();
    expect(view.queryByText('Run some queries to see them here')).not.toBeNull();
  });

  // ── Shows execution time and row count ────────────────────────────────────

  test('shows execution time and row count', () => {
    const props = createDefaultProps();
    const { container } = render(<QueryHistory {...props} />);
    const view = within(container);

    expect(view.queryByText('25ms')).not.toBeNull();
    expect(view.queryByText('5ms')).not.toBeNull();
    expect(view.queryByText('10')).not.toBeNull();
  });

  // ── Shows connection name and tab name ────────────────────────────────────

  test('shows connection name and tab name', () => {
    const props = createDefaultProps();
    const { container } = render(<QueryHistory {...props} />);
    const view = within(container);

    expect(view.queryByText('TestDB')).not.toBeNull();
    expect(view.queryByText('ProdDB')).not.toBeNull();
    expect(view.queryByText('Query 1')).not.toBeNull();
    expect(view.queryByText('Query 2')).not.toBeNull();
  });
});
