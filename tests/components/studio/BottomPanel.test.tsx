import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import { mock } from 'bun:test';
import { setupRechartssMock } from '../../helpers/mock-monaco';

// Setup recharts mock before component imports
setupRechartssMock();

// ---- Mock all child components rendered by BottomPanel ----

mock.module('@/components/ResultsGrid', () => ({
  ResultsGrid: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'resultsgrid' }, 'ResultsGrid');
  },
}));

mock.module('@/components/VisualExplain', () => ({
  VisualExplain: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'visualexplain' }, 'VisualExplain');
  },
}));

mock.module('@/components/QueryHistory', () => ({
  QueryHistory: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'queryhistory' }, 'QueryHistory');
  },
}));

mock.module('@/components/SavedQueries', () => ({
  SavedQueries: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'savedqueries' }, 'SavedQueries');
  },
}));

mock.module('@/components/DataCharts', () => ({
  DataCharts: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'datacharts' }, 'DataCharts');
  },
}));

mock.module('@/components/NL2SQLPanel', () => ({
  NL2SQLPanel: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'nl2sqlpanel' }, 'NL2SQLPanel');
  },
}));

mock.module('@/components/AIAutopilotPanel', () => ({
  AIAutopilotPanel: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'aiautopilotpanel' }, 'AIAutopilotPanel');
  },
}));

mock.module('@/components/PivotTable', () => ({
  PivotTable: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'pivottable' }, 'PivotTable');
  },
}));

mock.module('@/components/DatabaseDocs', () => ({
  DatabaseDocs: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'databasedocs' }, 'DatabaseDocs');
  },
}));

mock.module('@/components/SchemaDiff', () => ({
  SchemaDiff: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'schemadiff' }, 'SchemaDiff');
  },
}));

// ---- Now import bun:test, testing-library, and the component ----

import { describe, test, expect, afterEach } from 'bun:test';
import { render, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

import { BottomPanel } from '@/components/studio/BottomPanel';
import type { BottomPanelMode } from '@/components/studio/BottomPanel';

// =============================================================================
// BottomPanel Tests
// =============================================================================

function createDefaultProps(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    mode: 'results' as BottomPanelMode,
    onSetMode: mock(() => {}),
    currentTab: {
      id: 'tab-1',
      name: 'Query 1',
      query: 'SELECT 1',
      result: null,
      isExecuting: false,
      type: 'sql' as const,
    },
    schema: [],
    schemaContext: '[]',
    activeConnection: null,
    metadata: null,
    historyKey: 0,
    savedKey: 0,
    isNL2SQLOpen: false,
    onSetIsNL2SQLOpen: mock(() => {}),
    maskingEnabled: false,
    onToggleMasking: undefined,
    userRole: 'admin',
    maskingConfig: {
      enabled: false,
      patterns: [],
      roleSettings: {
        admin: { canToggle: true, canReveal: true },
        user: { canToggle: false, canReveal: false },
      },
    },
    editingEnabled: false,
    pendingChanges: [],
    onCellChange: mock(() => {}),
    onApplyChanges: mock(() => {}),
    onDiscardChanges: mock(() => {}),
    onExecuteQuery: mock(() => {}),
    onLoadQuery: mock(() => {}),
    onLoadMore: undefined,
    isLoadingMore: false,
    onExportResults: mock(() => {}),
    ...overrides,
  };
}

describe('BottomPanel', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders tab buttons for all modes', () => {
    const props = createDefaultProps();
    const { getByText } = render(<BottomPanel {...props as React.ComponentProps<typeof BottomPanel>} />);

    const expectedLabels = [
      'Results', 'Explain', 'History', 'Saved', 'Charts',
      'NL2SQL', 'Autopilot', 'Pivot', 'Docs', 'Diff', 'Dashboard',
    ];
    for (const label of expectedLabels) {
      const btn = getByText(label);
      expect(btn).not.toBeNull();
    }
  });

  test('Results tab is active by default when mode="results"', () => {
    const props = createDefaultProps({ mode: 'results' });
    const { getByText } = render(<BottomPanel {...props as React.ComponentProps<typeof BottomPanel>} />);

    const resultsButton = getByText('Results').closest('button');
    expect(resultsButton).not.toBeNull();
    // Active tab should have the active class (text-blue-400 for results)
    expect(resultsButton!.className).toContain('text-blue-400');
  });

  test('shows empty state placeholder when currentTab.result is null', () => {
    const props = createDefaultProps({ mode: 'results' });
    const { getByText } = render(<BottomPanel {...props as React.ComponentProps<typeof BottomPanel>} />);

    // The empty state shows "Execute a query or check history"
    const emptyText = getByText('Execute a query or check history');
    expect(emptyText).not.toBeNull();
  });

  test('tab click fires onSetMode with correct mode', () => {
    const onSetMode = mock(() => {});
    const props = createDefaultProps({ onSetMode });
    const { getByText } = render(<BottomPanel {...props as React.ComponentProps<typeof BottomPanel>} />);

    // Click the History tab
    const historyButton = getByText('History').closest('button');
    expect(historyButton).not.toBeNull();
    fireEvent.click(historyButton!);

    expect(onSetMode).toHaveBeenCalledTimes(1);
    expect(onSetMode).toHaveBeenCalledWith('history');
  });

  test('ResultsGrid renders when mode="results" and result exists', () => {
    const props = createDefaultProps({
      mode: 'results',
      currentTab: {
        id: 'tab-1',
        name: 'Query 1',
        query: 'SELECT 1',
        result: {
          rows: [{ id: 1, name: 'test' }],
          fields: ['id', 'name'],
          rowCount: 1,
          executionTime: 42,
        },
        isExecuting: false,
        type: 'sql' as const,
      },
    });
    const { queryByTestId } = render(<BottomPanel {...props as React.ComponentProps<typeof BottomPanel>} />);

    const grid = queryByTestId('resultsgrid');
    expect(grid).not.toBeNull();
    expect(grid!.textContent).toBe('ResultsGrid');
  });

  test('History tab renders QueryHistory component when mode="history"', () => {
    const props = createDefaultProps({ mode: 'history' });
    const { queryByTestId } = render(<BottomPanel {...props as React.ComponentProps<typeof BottomPanel>} />);

    const history = queryByTestId('queryhistory');
    expect(history).not.toBeNull();
    expect(history!.textContent).toBe('QueryHistory');
  });
});
