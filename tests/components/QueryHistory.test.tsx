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

  // ── Filter by success status ──────────────────────────────────────────────

  test('filter by success status shows only successful queries', async () => {
    const user = userEvent.setup();
    const props = createDefaultProps();
    const { container } = render(<QueryHistory {...props} />);
    const view = within(container);

    // Click the "success" filter button
    const successButton = view.getByText('success');
    await user.click(successButton);

    // Only the success item should remain
    expect(view.queryByText('SELECT * FROM users')).not.toBeNull();
    expect(view.queryByText('DROP TABLE bad')).toBeNull();
  });

  // ── Filter by error status ────────────────────────────────────────────────

  test('filter by error status shows only failed queries', async () => {
    const user = userEvent.setup();
    const props = createDefaultProps();
    const { container } = render(<QueryHistory {...props} />);
    const view = within(container);

    // Click the "error" filter button
    const errorButton = view.getByText('error');
    await user.click(errorButton);

    // Only the error item should remain
    expect(view.queryByText('DROP TABLE bad')).not.toBeNull();
    expect(view.queryByText('SELECT * FROM users')).toBeNull();
  });

  // ── All Connections toggle shows all items ────────────────────────────────

  test('All Connections toggle shows items from all connections', async () => {
    const user = userEvent.setup();
    const props = createDefaultProps({ activeConnectionId: 'c1' });
    const { container } = render(<QueryHistory {...props} />);
    const view = within(container);

    // With "Active Conn" (default), only c1 items should show
    expect(view.queryByText('SELECT * FROM users')).not.toBeNull();
    expect(view.queryByText('DROP TABLE bad')).toBeNull();

    // Click "All Connections" to show all
    const allConnButton = view.getByText('All Connections');
    await user.click(allConnButton);

    expect(view.queryByText('SELECT * FROM users')).not.toBeNull();
    expect(view.queryByText('DROP TABLE bad')).not.toBeNull();
  });

  // ── Active Conn toggle filters by activeConnectionId ──────────────────────

  test('Active Conn toggle filters by activeConnectionId', async () => {
    const user = userEvent.setup();
    const props = createDefaultProps({ activeConnectionId: 'c1' });
    const { container } = render(<QueryHistory {...props} />);
    const view = within(container);

    // Switch to "All Connections" first
    await user.click(view.getByText('All Connections'));
    expect(view.queryByText('DROP TABLE bad')).not.toBeNull();

    // Switch back to "Active Conn"
    await user.click(view.getByText('Active Conn'));

    // Only c1 connection item should show
    expect(view.queryByText('SELECT * FROM users')).not.toBeNull();
    expect(view.queryByText('DROP TABLE bad')).toBeNull();
  });

  // ── Sort by executionTime ─────────────────────────────────────────────────

  test('sort by executionTime orders items by duration', async () => {
    const user = userEvent.setup();
    const props = createDefaultProps();
    const { container } = render(<QueryHistory {...props} />);
    const view = within(container);

    // Click "Duration" header to sort by executionTime (desc by default)
    const durationHeader = view.getByText('Duration');
    await user.click(durationHeader);

    // Check ordering: 25ms should come before 5ms in desc order
    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);

    const firstRowText = rows[0].textContent || '';
    const secondRowText = rows[1].textContent || '';
    expect(firstRowText).toContain('25ms');
    expect(secondRowText).toContain('5ms');
  });

  // ── Sort direction toggle on second click ─────────────────────────────────

  test('sort direction toggles on second click of same column', async () => {
    const user = userEvent.setup();
    const props = createDefaultProps();
    const { container } = render(<QueryHistory {...props} />);
    const view = within(container);

    // Click "Duration" header twice to toggle to asc
    const durationHeader = view.getByText('Duration');
    await user.click(durationHeader); // desc
    await user.click(durationHeader); // asc

    // In asc order: 5ms should come before 25ms
    const rows = container.querySelectorAll('tbody tr');
    const firstRowText = rows[0].textContent || '';
    const secondRowText = rows[1].textContent || '';
    expect(firstRowText).toContain('5ms');
    expect(secondRowText).toContain('25ms');
  });

  // ── Search clear button (X) ───────────────────────────────────────────────

  test('search clear button resets search and shows all items', async () => {
    const user = userEvent.setup();
    const props = createDefaultProps();
    const { container } = render(<QueryHistory {...props} />);
    const view = within(container);

    // Type a search term
    const searchInput = view.getByPlaceholderText('Search by query, connection or tab...');
    await user.type(searchInput, 'SELECT');

    // Only one item visible
    expect(view.queryByText('DROP TABLE bad')).toBeNull();

    // Click the X clear button
    const clearSearchButton = container.querySelector('button .w-3.h-3')?.closest('button');
    expect(clearSearchButton).not.toBeNull();
    await user.click(clearSearchButton!);

    // Both items should be visible again
    expect(view.queryByText('SELECT * FROM users')).not.toBeNull();
    expect(view.queryByText('DROP TABLE bad')).not.toBeNull();
  });

  // ── Export CSV creates download link ──────────────────────────────────────

  test('export CSV creates download link', async () => {
    const user = userEvent.setup();
    const createObjectURLMock = mock(() => 'blob:fake-csv-url');
    const revokeObjectURLMock = mock(() => {});
    const clickMock = mock(() => {});

    globalThis.URL.createObjectURL = createObjectURLMock;
    globalThis.URL.revokeObjectURL = revokeObjectURLMock;

    const origCreateElement = document.createElement.bind(document);
    const createElementSpy = mock((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === 'a') {
        el.click = clickMock;
      }
      return el;
    });
    document.createElement = createElementSpy as unknown as typeof document.createElement;

    const props = createDefaultProps();
    const { container } = render(<QueryHistory {...props} />);

    // Click Export button to open dropdown
    const exportButton = within(container).getByText('Export');
    await user.click(exportButton);

    // Find and click "Export as CSV" in the dropdown (rendered in document body)
    const csvOption = within(document.body as HTMLElement).getByText('Export as CSV');
    await user.click(csvOption);

    expect(createObjectURLMock).toHaveBeenCalled();
    expect(clickMock).toHaveBeenCalled();
    expect(revokeObjectURLMock).toHaveBeenCalled();

    // Restore
    document.createElement = origCreateElement;
  });

  // ── Export JSON creates download link ─────────────────────────────────────

  test('export JSON creates download link', async () => {
    const user = userEvent.setup();
    const createObjectURLMock = mock(() => 'blob:fake-json-url');
    const revokeObjectURLMock = mock(() => {});
    const clickMock = mock(() => {});

    globalThis.URL.createObjectURL = createObjectURLMock;
    globalThis.URL.revokeObjectURL = revokeObjectURLMock;

    const origCreateElement = document.createElement.bind(document);
    const createElementSpy = mock((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === 'a') {
        el.click = clickMock;
      }
      return el;
    });
    document.createElement = createElementSpy as unknown as typeof document.createElement;

    const props = createDefaultProps();
    const { container } = render(<QueryHistory {...props} />);

    // Click Export button to open dropdown
    const exportButton = within(container).getByText('Export');
    await user.click(exportButton);

    // Find and click "Export as JSON" in the dropdown (rendered in document body)
    const jsonOption = within(document.body as HTMLElement).getByText('Export as JSON');
    await user.click(jsonOption);

    expect(createObjectURLMock).toHaveBeenCalled();
    expect(clickMock).toHaveBeenCalled();
    expect(revokeObjectURLMock).toHaveBeenCalled();

    // Restore
    document.createElement = origCreateElement;
  });

  // ── Duration > 500ms amber styling ────────────────────────────────────────

  test('duration greater than 500ms shows amber styling', () => {
    const slowHistory = [
      {
        id: 'h-slow',
        query: 'SELECT * FROM huge_table',
        executedAt: new Date('2026-01-15T10:00:00Z'),
        executionTime: 750,
        rowCount: 5000,
        status: 'success' as const,
        connectionId: 'c1',
        connectionName: 'TestDB',
        tabName: 'Query 1',
      },
    ];
    mockGetHistory.mockImplementation(() => [...slowHistory]);

    const props = createDefaultProps();
    const { container } = render(<QueryHistory {...props} />);

    // The 750ms duration cell should have amber styling
    const amberBadge = container.querySelector('.text-amber-400.bg-amber-400\\/10');
    expect(amberBadge).not.toBeNull();
    expect(amberBadge!.textContent).toBe('750ms');
  });

  // ── Error message display for failed queries ──────────────────────────────

  test('error message is displayed for failed queries', () => {
    const props = createDefaultProps();
    const { container } = render(<QueryHistory {...props} />);
    const view = within(container);

    // The error message from h2 should be visible
    expect(view.queryByText('permission denied')).not.toBeNull();
  });

  // ── Null rowCount shows dash ──────────────────────────────────────────────

  test('null rowCount shows dash character', () => {
    const historyWithNullRowCount = [
      {
        id: 'h-null',
        query: 'CREATE INDEX idx ON users(name)',
        executedAt: new Date('2026-01-15T10:00:00Z'),
        executionTime: 30,
        rowCount: null as unknown as number,
        status: 'success' as const,
        connectionId: 'c1',
        connectionName: 'TestDB',
        tabName: 'Query 1',
      },
    ];
    mockGetHistory.mockImplementation(() => [...historyWithNullRowCount]);

    const props = createDefaultProps();
    const { container } = render(<QueryHistory {...props} />);

    // The row count cell should show "-" for null/undefined rowCount
    const cells = container.querySelectorAll('td');
    const rowCountCell = Array.from(cells).find(cell => {
      const span = cell.querySelector('.font-mono.text-xs');
      return span && span.textContent === '-';
    });
    expect(rowCountCell).not.toBeNull();
  });

  // ── Clear history cancelled by user ───────────────────────────────────────

  test('clear history cancelled by user does not clear items', () => {
    const originalConfirm = globalThis.confirm;
    globalThis.confirm = mock(() => false) as unknown as typeof confirm;

    const props = createDefaultProps();
    const { container } = render(<QueryHistory {...props} />);
    const view = within(container);

    expect(view.queryByText('SELECT * FROM users')).not.toBeNull();

    const clearButton = view.getByText('Clear');
    fireEvent.click(clearButton);

    // Storage should NOT have been called
    expect(mockClearHistory).not.toHaveBeenCalled();

    // Items should still be visible
    expect(view.queryByText('SELECT * FROM users')).not.toBeNull();
    expect(view.queryByText('DROP TABLE bad')).not.toBeNull();

    globalThis.confirm = originalConfirm;
  });

  // ── refreshTrigger change reloads history ─────────────────────────────────

  test('refreshTrigger change reloads history from storage', () => {
    const props = createDefaultProps({ refreshTrigger: 0 });
    const { container, rerender } = render(<QueryHistory {...props} />);
    const view = within(container);

    expect(view.queryByText('SELECT * FROM users')).not.toBeNull();

    // Clear mock call count from initial render
    mockGetHistory.mockClear();

    // Change the refreshTrigger to simulate a new query execution
    const newHistory = [
      ...mockHistory,
      {
        id: 'h3',
        query: 'INSERT INTO orders VALUES(1)',
        executedAt: new Date('2026-01-16T12:00:00Z'),
        executionTime: 10,
        rowCount: 1,
        status: 'success' as const,
        connectionId: 'c1',
        connectionName: 'TestDB',
        tabName: 'Query 3',
      },
    ];
    mockGetHistory.mockImplementation(() => [...newHistory]);

    rerender(<QueryHistory {...createDefaultProps({ refreshTrigger: 1 })} />);

    // getHistory should have been called again
    expect(mockGetHistory).toHaveBeenCalled();

    // New item should be visible
    expect(view.queryByText('INSERT INTO orders VALUES(1)')).not.toBeNull();
  });

  // ── Sort by rowCount ──────────────────────────────────────────────────────

  test('sort by rowCount orders items by row count', async () => {
    const user = userEvent.setup();
    const props = createDefaultProps();
    const { container } = render(<QueryHistory {...props} />);
    const view = within(container);

    // Click "Rows" header to sort by rowCount (desc by default)
    const rowsHeader = view.getByText('Rows');
    await user.click(rowsHeader);

    // In desc order: 10 rows (h1) should come before 0 rows (h2)
    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBe(2);

    const firstRowText = rows[0].textContent || '';
    const secondRowText = rows[1].textContent || '';
    expect(firstRowText).toContain('SELECT * FROM users');
    expect(secondRowText).toContain('DROP TABLE bad');
  });
});
