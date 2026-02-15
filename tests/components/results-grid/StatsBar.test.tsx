import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { LoadMoreFooter, StatsBar } from '@/components/results-grid/StatsBar';
import type { QueryResult } from '@/lib/types';
import type { CellChange } from '@/components/ResultsGrid';

function makeResult(): QueryResult {
  return {
    rows: [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }],
    fields: ['id', 'name'],
    rowCount: 2,
    executionTime: 14,
    pagination: {
      limit: 2,
      offset: 0,
      hasMore: true,
      totalReturned: 2,
      wasLimited: true,
    },
  };
}

describe('results-grid/StatsBar', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders stats and filter summary, clears filters', () => {
    const onClearFilters = mock(() => {});
    const { queryByText } = render(
      <StatsBar
        result={makeResult()}
        filteredRowCount={1}
        activeFilterCount={2}
        onClearFilters={onClearFilters}
        viewMode="card"
        onSetViewMode={mock(() => {})}
        hasSensitive={false}
        effectiveMaskingEnabled={false}
        userCanToggle={false}
      />
    );

    expect(queryByText('2 rows')).not.toBeNull();
    expect(queryByText('2 columns')).not.toBeNull();
    expect(queryByText('AUTO-LIMITED')).not.toBeNull();
    expect(queryByText('2 filters • 1 shown')).not.toBeNull();

    fireEvent.click(queryByText('2 filters • 1 shown')!);
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });

  test('supports masking toggle and view switch', () => {
    const onToggleMasking = mock(() => {});
    const onSetViewMode = mock((mode: 'card' | 'table') => {
      void mode;
    });
    const { container, queryByText } = render(
      <StatsBar
        result={makeResult()}
        filteredRowCount={2}
        activeFilterCount={0}
        onClearFilters={mock(() => {})}
        viewMode="table"
        onSetViewMode={onSetViewMode}
        hasSensitive
        effectiveMaskingEnabled={false}
        userCanToggle
        onToggleMasking={onToggleMasking}
      />
    );

    expect(queryByText('MASK')).not.toBeNull();
    fireEvent.click(queryByText('MASK')!);
    expect(onToggleMasking).toHaveBeenCalledTimes(1);

    const buttons = container.querySelectorAll('button');
    fireEvent.click(buttons[buttons.length - 2]!);
    fireEvent.click(buttons[buttons.length - 1]!);
    expect(onSetViewMode).toHaveBeenCalledTimes(2);
  });

  test('shows locked masked label when user cannot toggle', () => {
    const { queryByText } = render(
      <StatsBar
        result={makeResult()}
        filteredRowCount={2}
        activeFilterCount={0}
        onClearFilters={mock(() => {})}
        viewMode="card"
        onSetViewMode={mock(() => {})}
        hasSensitive
        effectiveMaskingEnabled
        userCanToggle={false}
      />
    );
    expect(queryByText('MASKED')).not.toBeNull();
  });

  test('shows pending changes actions and executes callbacks', () => {
    const onApplyChanges = mock(() => {});
    const onDiscardChanges = mock(() => {});
    const pendingChanges: CellChange[] = [
      { rowIndex: 0, columnId: 'name', originalValue: 'Alice', newValue: 'Alicia' },
    ];
    const { container, queryByText } = render(
      <StatsBar
        result={makeResult()}
        filteredRowCount={2}
        activeFilterCount={0}
        onClearFilters={mock(() => {})}
        viewMode="card"
        onSetViewMode={mock(() => {})}
        hasSensitive={false}
        effectiveMaskingEnabled={false}
        userCanToggle={false}
        editingEnabled
        pendingChanges={pendingChanges}
        onApplyChanges={onApplyChanges}
        onDiscardChanges={onDiscardChanges}
      />
    );

    expect(queryByText('1 change')).not.toBeNull();
    const buttons = container.querySelectorAll('button');
    fireEvent.click(buttons[0]!);
    fireEvent.click(buttons[1]!);
    expect(onApplyChanges).toHaveBeenCalledTimes(1);
    expect(onDiscardChanges).toHaveBeenCalledTimes(1);
  });
});

describe('results-grid/LoadMoreFooter', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders nothing when hasMore is false', () => {
    const { container } = render(
      <LoadMoreFooter hasMore={false} onLoadMore={mock(() => {})} />
    );
    expect(container.textContent).toBe('');
  });

  test('calls onLoadMore and shows loading state', () => {
    const onLoadMore = mock(() => {});
    const { queryByText, rerender } = render(
      <LoadMoreFooter hasMore onLoadMore={onLoadMore} isLoadingMore={false} />
    );
    expect(queryByText('Load More (500 rows)')).not.toBeNull();
    fireEvent.click(queryByText('Load More (500 rows)')!);
    expect(onLoadMore).toHaveBeenCalledTimes(1);

    rerender(<LoadMoreFooter hasMore onLoadMore={onLoadMore} isLoadingMore />);
    expect(queryByText('Loading...')).not.toBeNull();
  });
});
