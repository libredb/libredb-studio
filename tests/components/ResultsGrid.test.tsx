import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { mock } from 'bun:test';
import React from 'react';

// ── Mock framer-motion ──────────────────────────────────────────────────────
mock.module('framer-motion', () => {
  const passthrough = ({ children, ...props }: Record<string, unknown>) =>
    React.createElement('div', props, children as React.ReactNode);

  return {
    motion: new Proxy({}, {
      get: () => passthrough,
    }),
    AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
    useAnimation: () => ({ start: mock(() => {}), stop: mock(() => {}) }),
    useInView: () => true,
  };
});

// ── Mock data-masking ───────────────────────────────────────────────────────
const mockShouldMask = mock(() => false);
const mockCanToggleMasking = mock(() => true);
const mockCanReveal = mock(() => true);
const mockDetectSensitiveColumnsFromConfig = mock(() => new Map());
const mockMaskValueByPattern = mock(() => '***');
const mockLoadMaskingConfig = mock(() => ({
  enabled: false,
  patterns: [],
  roles: {},
}));

mock.module('@/lib/data-masking', () => ({
  shouldMask: mockShouldMask,
  canToggleMasking: mockCanToggleMasking,
  canReveal: mockCanReveal,
  detectSensitiveColumnsFromConfig: mockDetectSensitiveColumnsFromConfig,
  maskValueByPattern: mockMaskValueByPattern,
  loadMaskingConfig: mockLoadMaskingConfig,
}));

// ── Mock sub-components to simplify testing ─────────────────────────────────
mock.module('@/components/results-grid/ResultCard', () => ({
  ResultCard: (props: Record<string, unknown>) =>
    React.createElement('div', { 'data-testid': 'result-card', 'data-index': props.index }),
}));

mock.module('@/components/results-grid/RowDetailSheet', () => ({
  RowDetailSheet: (props: Record<string, unknown>) =>
    props.isOpen
      ? React.createElement('div', { 'data-testid': 'row-detail-sheet' }, 'Row Detail')
      : null,
}));

mock.module('@/components/results-grid/StatsBar', () => ({
  StatsBar: (props: Record<string, unknown>) =>
    React.createElement('div', { 'data-testid': 'stats-bar' },
      React.createElement('span', { 'data-testid': 'row-count' }, `${(props.result as { rows: unknown[] })?.rows?.length ?? 0} rows`),
      React.createElement('span', { 'data-testid': 'exec-time' }, `EXEC TIME: ${(props.result as { executionTime?: number })?.executionTime ?? 0}ms`),
      props.onToggleMasking
        ? React.createElement('button', { 'data-testid': 'masking-toggle', onClick: props.onToggleMasking as () => void }, 'MASK')
        : null,
      props.editingEnabled && props.pendingChanges && (props.pendingChanges as unknown[]).length > 0
        ? React.createElement('span', { 'data-testid': 'pending-changes' }, `${(props.pendingChanges as unknown[]).length} changes`)
        : null,
    ),
  LoadMoreFooter: (props: Record<string, unknown>) =>
    props.hasMore
      ? React.createElement('div', { 'data-testid': 'load-more-footer' },
          React.createElement('button', { onClick: props.onLoadMore as () => void, 'data-testid': 'load-more-btn' }, 'Load More (500 rows)')
        )
      : null,
}));

// ── Mock @tanstack/react-virtual ────────────────────────────────────────────
mock.module('@tanstack/react-virtual', () => ({
  useVirtualizer: (opts: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: opts.count }, (_, i) => ({
        index: i,
        start: i * 36,
        size: 36,
        key: i,
      })),
    getTotalSize: () => opts.count * 36,
  }),
}));

// ── Mock lucide-react icons ─────────────────────────────────────────────────
mock.module('lucide-react', () => {
  return new Proxy({}, {
    get: (_target, prop) => {
      if (prop === '__esModule') return true;
      return (props: Record<string, unknown>) =>
        React.createElement('span', { 'data-icon': prop, className: props.className as string });
    },
  });
});

// ── Imports AFTER mocks ─────────────────────────────────────────────────────
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { ResultsGrid, type CellChange } from '@/components/ResultsGrid';
import type { QueryResult } from '@/lib/types';

// ── Test data ───────────────────────────────────────────────────────────────

const mockResult: QueryResult = {
  rows: [
    { id: 1, name: 'Alice', email: 'alice@example.com' },
    { id: 2, name: 'Bob', email: 'bob@example.com' },
    { id: 3, name: 'Charlie', email: 'charlie@example.com' },
  ],
  fields: ['id', 'name', 'email'],
  rowCount: 3,
  executionTime: 12,
};

const mockEmptyResult: QueryResult = {
  rows: [],
  fields: [],
  rowCount: 0,
  executionTime: 1,
};

const mockPaginatedResult: QueryResult = {
  rows: Array.from({ length: 50 }, (_, i) => ({
    id: i + 1,
    name: `User ${i + 1}`,
    email: `user${i + 1}@example.com`,
  })),
  fields: ['id', 'name', 'email'],
  rowCount: 50,
  executionTime: 25,
  pagination: {
    limit: 50,
    offset: 0,
    hasMore: true,
    totalReturned: 50,
    wasLimited: true,
  },
};

// =============================================================================
// ResultsGrid Tests
// =============================================================================

describe('ResultsGrid', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockShouldMask.mockClear();
    mockCanToggleMasking.mockClear();
    mockCanReveal.mockClear();
    mockDetectSensitiveColumnsFromConfig.mockClear();
    mockDetectSensitiveColumnsFromConfig.mockReturnValue(new Map());
    mockShouldMask.mockReturnValue(false);
  });

  // ── 1. Renders "No results" when result has empty rows ────────────────────

  test('renders empty state when result has empty rows', () => {
    const { queryByText } = render(React.createElement(ResultsGrid, { result: mockEmptyResult }));

    expect(queryByText('Query returned no data')).not.toBeNull();
  });

  // ── 2. Renders column headers from result.fields ──────────────────────────

  test('renders column headers from result.fields', () => {
    const { queryAllByText } = render(React.createElement(ResultsGrid, { result: mockResult }));

    expect(queryAllByText('id').length).toBeGreaterThan(0);
    expect(queryAllByText('name').length).toBeGreaterThan(0);
    expect(queryAllByText('email').length).toBeGreaterThan(0);
  });

  // ── 3. Renders data rows from result.rows ─────────────────────────────────

  test('renders data rows from result.rows', () => {
    const { queryAllByText } = render(React.createElement(ResultsGrid, { result: mockResult }));

    expect(queryAllByText('Alice').length).toBeGreaterThan(0);
    expect(queryAllByText('Bob').length).toBeGreaterThan(0);
    expect(queryAllByText('Charlie').length).toBeGreaterThan(0);
  });

  // ── 4. Shows row count via StatsBar ───────────────────────────────────────

  test('shows row count in stats bar', () => {
    const { queryByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));

    const rowCount = queryByTestId('row-count');
    expect(rowCount).not.toBeNull();
    expect(rowCount!.textContent).toContain('3 rows');
  });

  // ── 5. Shows execution time via StatsBar ──────────────────────────────────

  test('shows execution time in stats bar', () => {
    const { queryByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));

    const execTime = queryByTestId('exec-time');
    expect(execTime).not.toBeNull();
    expect(execTime!.textContent).toContain('12ms');
  });

  // ── 6. Load More button shows when pagination hasMore ─────────────────────

  test('Load More button shows when pagination hasMore', () => {
    const onLoadMore = mock(() => {});
    const { queryByTestId } = render(React.createElement(ResultsGrid, {
      result: mockPaginatedResult,
      onLoadMore,
    }));

    const loadMoreBtn = queryByTestId('load-more-btn');
    expect(loadMoreBtn).not.toBeNull();
    expect(loadMoreBtn!.textContent).toContain('Load More');
  });

  // ── 7. Load More button fires onLoadMore ──────────────────────────────────

  test('Load More button fires onLoadMore callback', () => {
    const onLoadMore = mock(() => {});
    const { getByTestId } = render(React.createElement(ResultsGrid, {
      result: mockPaginatedResult,
      onLoadMore,
    }));

    const loadMoreBtn = getByTestId('load-more-btn');
    fireEvent.click(loadMoreBtn);
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  // ── 8. Masking toggle button renders when onToggleMasking provided ────────

  test('masking toggle button renders when onToggleMasking provided', () => {
    const onToggleMasking = mock(() => {});
    const { queryByTestId } = render(React.createElement(ResultsGrid, {
      result: mockResult,
      onToggleMasking,
    }));

    const maskToggle = queryByTestId('masking-toggle');
    expect(maskToggle).not.toBeNull();
  });

  // ── 9. Masking toggle button not rendered without onToggleMasking ─────────

  test('masking toggle button not rendered without onToggleMasking', () => {
    const { queryByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));

    const maskToggle = queryByTestId('masking-toggle');
    expect(maskToggle).toBeNull();
  });

  // ── 10. Pending changes indicator shows when editing enabled ──────────────

  test('pending changes indicator shows when editingEnabled with changes', () => {
    const pendingChanges: CellChange[] = [
      { rowIndex: 0, columnId: 'name', originalValue: 'Alice', newValue: 'Alicia' },
    ];
    const { queryByTestId } = render(React.createElement(ResultsGrid, {
      result: mockResult,
      editingEnabled: true,
      pendingChanges,
      onCellChange: mock(() => {}),
      onApplyChanges: mock(() => {}),
      onDiscardChanges: mock(() => {}),
    }));

    const changesIndicator = queryByTestId('pending-changes');
    expect(changesIndicator).not.toBeNull();
    expect(changesIndicator!.textContent).toContain('1 changes');
  });

  // ── 11. No Load More when no pagination ───────────────────────────────────

  test('no Load More footer when pagination not present', () => {
    const { queryByTestId } = render(React.createElement(ResultsGrid, { result: mockResult }));

    const loadMore = queryByTestId('load-more-footer');
    expect(loadMore).toBeNull();
  });

  // ── 12. Empty state message is descriptive ────────────────────────────────

  test('empty state contains helpful message', () => {
    const { queryByText } = render(React.createElement(ResultsGrid, { result: mockEmptyResult }));

    expect(queryByText('The operation was successful, but the result set is currently empty.')).not.toBeNull();
  });
});
