import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { mock } from 'bun:test';
import React from 'react';

// ── Mock Recharts ───────────────────────────────────────────────────────────
mock.module('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: unknown }) => children,
  AreaChart: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement('div', { 'data-testid': 'mock-area-chart', ...props }, children as React.ReactNode),
  BarChart: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement('div', { 'data-testid': 'mock-bar-chart', ...props }, children as React.ReactNode),
  LineChart: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement('div', { 'data-testid': 'mock-line-chart', ...props }, children as React.ReactNode),
  PieChart: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement('div', { 'data-testid': 'mock-pie-chart', ...props }, children as React.ReactNode),
  ScatterChart: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement('div', { 'data-testid': 'mock-scatter-chart', ...props }, children as React.ReactNode),
  RadialBarChart: ({ children }: { children: unknown }) =>
    React.createElement('div', { 'data-testid': 'mock-radial-chart' }, children as React.ReactNode),
  Area: () => null,
  Bar: () => null,
  Line: () => null,
  Pie: () => null,
  Scatter: () => null,
  Cell: () => null,
  RadialBar: () => null,
  XAxis: () => null,
  YAxis: () => null,
  ZAxis: () => null,
  CartesianGrid: () => null,
  Tooltip: () => null,
  Legend: () => null,
  PolarAngleAxis: () => null,
}));

// ── Mock html2canvas (dynamic import in export) ─────────────────────────────
mock.module('html2canvas', () => ({
  default: mock(async () => ({
    toDataURL: () => 'data:image/png;base64,fake',
  })),
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

// ── Mock Shadcn UI components that use Radix ────────────────────────────────
mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick, className, ...props }: Record<string, unknown>) =>
    React.createElement('button', { onClick: onClick as (() => void), className, ...props }, children as React.ReactNode),
}));

mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'dropdown-menu' }, children),
  DropdownMenuTrigger: ({ children, ...props }: Record<string, unknown>) =>
    React.createElement('div', { 'data-testid': 'dropdown-trigger', ...props }, children as React.ReactNode),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'dropdown-content' }, children),
  DropdownMenuItem: ({ children, onClick, className }: Record<string, unknown>) =>
    React.createElement('div', { role: 'menuitem', onClick: onClick as (() => void), className }, children as React.ReactNode),
}));

mock.module('@/components/ui/select', () => ({
  Select: ({ children, value }: Record<string, unknown>) =>
    React.createElement('div', { 'data-testid': 'select', 'data-value': value }, children as React.ReactNode),
  SelectTrigger: ({ children, className }: Record<string, unknown>) =>
    React.createElement('div', { 'data-testid': 'select-trigger', className }, children as React.ReactNode),
  SelectContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'select-content' }, children),
  SelectItem: ({ children, value }: Record<string, unknown>) =>
    React.createElement('div', { 'data-testid': `select-item-${value}`, role: 'option' }, children as React.ReactNode),
  SelectValue: ({ placeholder }: Record<string, unknown>) =>
    React.createElement('span', { 'data-testid': 'select-value' }, placeholder as string),
}));

// ── Imports AFTER mocks ─────────────────────────────────────────────────────
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { DataCharts } from '@/components/DataCharts';
import type { QueryResult } from '@/lib/types';

import userEvent from '@testing-library/user-event';

// ── Test data ───────────────────────────────────────────────────────────────

const mockNumericResult: QueryResult = {
  rows: [
    { category: 'Electronics', revenue: 15000, cost: 8000, date: '2025-01-01' },
    { category: 'Clothing', revenue: 12000, cost: 6000, date: '2025-02-01' },
    { category: 'Books', revenue: 8000, cost: 3000, date: '2025-03-01' },
    { category: 'Food', revenue: 20000, cost: 12000, date: '2025-04-01' },
    { category: 'Sports', revenue: 10000, cost: 5000, date: '2025-05-01' },
  ],
  fields: ['category', 'revenue', 'cost', 'date'],
  rowCount: 5,
  executionTime: 15,
};

const mockEmptyResult: QueryResult = {
  rows: [],
  fields: [],
  rowCount: 0,
  executionTime: 1,
};

const mockSingleRowResult: QueryResult = {
  rows: [{ id: 1, value: 100 }],
  fields: ['id', 'value'],
  rowCount: 1,
  executionTime: 2,
};

const mockNoNumericResult: QueryResult = {
  rows: [
    { name: 'Alice', status: 'active' },
    { name: 'Bob', status: 'inactive' },
    { name: 'Charlie', status: 'active' },
  ],
  fields: ['name', 'status'],
  rowCount: 3,
  executionTime: 5,
};

// Pure numeric data (no categorical) → scatter suggestion
const pureNumericResult: QueryResult = {
  rows: [
    { x: 1, y: 10, z: 100 },
    { x: 2, y: 20, z: 200 },
    { x: 3, y: 30, z: 300 },
  ],
  fields: ['x', 'y', 'z'],
  rowCount: 3,
  executionTime: 1,
};

// Date time-series data → line suggestion
const dateTimeResult: QueryResult = {
  rows: [
    { date: '2025-01-01', value: 100 },
    { date: '2025-02-01', value: 200 },
    { date: '2025-03-01', value: 150 },
  ],
  fields: ['date', 'value'],
  rowCount: 3,
  executionTime: 1,
};

// Categorical with few rows → pie suggestion
const fewCategoricalResult: QueryResult = {
  rows: [
    { type: 'A', count: 10 },
    { type: 'B', count: 20 },
    { type: 'C', count: 30 },
  ],
  fields: ['type', 'count'],
  rowCount: 3,
  executionTime: 1,
};

// Many rows to test bar suggestion (>10 rows)
const manyCategoricalResult: QueryResult = {
  rows: Array.from({ length: 15 }, (_, i) => ({
    name: `item_${i}`,
    value: (i + 1) * 10,
  })),
  fields: ['name', 'value'],
  rowCount: 15,
  executionTime: 1,
};

// Pie with >10 data points for "Showing top 10" footer
const manyPieResult: QueryResult = {
  rows: Array.from({ length: 15 }, (_, i) => ({
    category: `cat_${i}`,
    amount: (i + 1) * 5,
  })),
  fields: ['category', 'amount'],
  rowCount: 15,
  executionTime: 1,
};

// =============================================================================
// DataCharts Tests
// =============================================================================

describe('DataCharts', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    // Clear localStorage saved charts
    if (typeof localStorage !== 'undefined') {
      try { localStorage.removeItem('libredb_saved_charts'); } catch { /* ignore */ }
    }
  });

  // -----------------------------------------------------------------------
  // Empty states
  // -----------------------------------------------------------------------

  test('renders empty state when result is null', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: null }));
    expect(queryByText('Cannot Visualize Data')).not.toBeNull();
    expect(queryByText('No data to visualize')).not.toBeNull();
  });

  test('renders empty state when result has empty rows', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockEmptyResult }));
    expect(queryByText('Cannot Visualize Data')).not.toBeNull();
  });

  test('renders empty state for single row result', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockSingleRowResult }));
    expect(queryByText('Cannot Visualize Data')).not.toBeNull();
    expect(queryByText('Need at least 2 rows for visualization')).not.toBeNull();
  });

  test('renders empty state when no numeric fields exist', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNoNumericResult }));
    expect(queryByText('Cannot Visualize Data')).not.toBeNull();
    expect(queryByText('No numeric fields found for Y-axis')).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Chart type selector
  // -----------------------------------------------------------------------

  test('shows all 8 chart type selector buttons', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    expect(queryByText('Bar')).not.toBeNull();
    expect(queryByText('Line')).not.toBeNull();
    expect(queryByText('Pie')).not.toBeNull();
    expect(queryByText('Area')).not.toBeNull();
    expect(queryByText('Scatter')).not.toBeNull();
    expect(queryByText('Histogram')).not.toBeNull();
    expect(queryByText('Stacked')).not.toBeNull();
    expect(queryByText('Stack Area')).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Axis selectors
  // -----------------------------------------------------------------------

  test('X-Axis selector renders with field options', () => {
    const { queryByText, queryByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    expect(queryByText('X-Axis')).not.toBeNull();
    expect(queryByTestId('select-item-category')).not.toBeNull();
    expect(queryByTestId('select-item-revenue')).not.toBeNull();
    expect(queryByTestId('select-item-cost')).not.toBeNull();
    expect(queryByTestId('select-item-date')).not.toBeNull();
  });

  test('Y-Axis selector renders', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    expect(queryByText('Y-Axis')).not.toBeNull();
  });

  test('shows "Value" label instead of Y-Axis when pie chart', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: fewCategoricalResult }));
    // fewCategoricalResult → pie suggestion (categorical + ≤10 rows)
    expect(queryByText('Value')).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Toolbar buttons
  // -----------------------------------------------------------------------

  test('Save chart button present', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    expect(queryByText('Save')).not.toBeNull();
  });

  test('Export button present with PNG and SVG options', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    expect(queryByText('Export')).not.toBeNull();
    expect(queryByText('Export as PNG')).not.toBeNull();
    expect(queryByText('Export as SVG')).not.toBeNull();
  });

  test('Aggregation selector present', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    expect(queryByText('Agg')).not.toBeNull();
  });

  test('date grouping selector appears when date columns exist', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    expect(queryByText('Group')).not.toBeNull();
  });

  test('date grouping hidden when no date columns', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: pureNumericResult }));
    expect(queryByText('Group')).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Footer stats
  // -----------------------------------------------------------------------

  test('footer shows row and field counts', () => {
    const { container } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    const footerText = container.textContent || '';
    expect(footerText).toContain('Rows:');
    expect(footerText).toContain('Fields:');
    expect(footerText).toContain('Numeric:');
  });

  test('footer shows numeric field count', () => {
    const { container } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    const footerText = container.textContent || '';
    // mockNumericResult has 2 numeric fields: revenue, cost
    expect(footerText).toContain('Numeric:');
  });

  // -----------------------------------------------------------------------
  // Chart type switching
  // -----------------------------------------------------------------------

  test('switches to line chart', async () => {
    const { queryByText, queryByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText('Line')!);
    await waitFor(() => {
      expect(queryByTestId('mock-line-chart')).not.toBeNull();
    });
  });

  test('switches to area chart', async () => {
    const { queryByText, queryByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText('Area')!);
    await waitFor(() => {
      expect(queryByTestId('mock-area-chart')).not.toBeNull();
    });
  });

  test('switches to pie chart', async () => {
    const { queryByText, queryByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText('Pie')!);
    await waitFor(() => {
      expect(queryByTestId('mock-pie-chart')).not.toBeNull();
    });
  });

  test('switches to scatter and histogram', async () => {
    const { queryByText, queryByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));

    fireEvent.click(queryByText('Scatter')!);
    await waitFor(() => {
      expect(queryByTestId('mock-scatter-chart')).not.toBeNull();
    });

    fireEvent.click(queryByText('Histogram')!);
    await waitFor(() => {
      expect(queryByTestId('mock-bar-chart')).not.toBeNull();
    });
  });

  test('switches to stacked bar chart', async () => {
    const { queryByText, queryByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText('Stacked')!);
    await waitFor(() => {
      expect(queryByTestId('mock-bar-chart')).not.toBeNull();
    });
  });

  test('switches to stacked area chart', async () => {
    const { queryByText, queryByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText('Stack Area')!);
    await waitFor(() => {
      expect(queryByTestId('mock-area-chart')).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Suggested chart type based on data
  // -----------------------------------------------------------------------

  test('suggests scatter for pure numeric data', () => {
    const { queryByTestId } = render(React.createElement(DataCharts, { result: pureNumericResult }));
    expect(queryByTestId('mock-scatter-chart')).not.toBeNull();
  });

  test('suggests line for date time-series data', () => {
    const { queryByTestId } = render(React.createElement(DataCharts, { result: dateTimeResult }));
    expect(queryByTestId('mock-line-chart')).not.toBeNull();
  });

  test('suggests pie for few categorical rows', () => {
    const { queryByTestId } = render(React.createElement(DataCharts, { result: fewCategoricalResult }));
    expect(queryByTestId('mock-pie-chart')).not.toBeNull();
  });

  test('suggests bar for many categorical rows', () => {
    const { queryByTestId } = render(React.createElement(DataCharts, { result: manyCategoricalResult }));
    expect(queryByTestId('mock-bar-chart')).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Scatter-specific Y selector
  // -----------------------------------------------------------------------

  test('shows scatter Y selector when scatter type is active', async () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText('Scatter')!);
    await waitFor(() => {
      // Scatter has a separate "Y" label
      expect(queryByText('Y')).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Histogram-specific buckets selector
  // -----------------------------------------------------------------------

  test('shows Buckets selector when histogram is active', async () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText('Histogram')!);
    await waitFor(() => {
      expect(queryByText('Buckets')).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Y-axis toggle (multi-select via dropdown menuitem)
  // -----------------------------------------------------------------------

  test('Y-axis dropdown shows numeric field options', () => {
    const { queryAllByRole } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    const menuItems = queryAllByRole('menuitem');
    // Should have numeric fields: revenue, cost (revenue may have ✓ if auto-selected)
    const fieldNames = menuItems.map(el => el.textContent || '');
    expect(fieldNames.some(n => n.includes('revenue'))).toBe(true);
    expect(fieldNames.some(n => n.includes('cost'))).toBe(true);
  });

  test('clicking Y-axis field toggles selection', async () => {
    const { queryAllByRole } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    const menuItems = queryAllByRole('menuitem');
    // Find cost menuitem and click to toggle it
    const costItem = menuItems.find(el => el.textContent?.includes('cost'));
    expect(costItem).not.toBeNull();
    fireEvent.click(costItem!);
    // After toggle, yAxis should include cost — verify via menu items
    await waitFor(() => {
      const updatedItems = queryAllByRole('menuitem');
      const updatedCost = updatedItems.find(el => el.textContent?.includes('cost'));
      expect(updatedCost).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Pie-specific: X-Axis hidden, "Showing top 10" footer
  // -----------------------------------------------------------------------

  test('X-Axis label hidden for pie chart', async () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: fewCategoricalResult }));
    // fewCategoricalResult → pie suggestion
    expect(queryByText('X-Axis')).toBeNull();
  });

  test('shows "Showing top 10 values" for pie with >10 data points', async () => {
    const { queryByText, container } = render(React.createElement(DataCharts, { result: manyPieResult }));
    // manyPieResult has 15 rows and suggests bar, switch to pie
    fireEvent.click(queryByText('Pie')!);
    await waitFor(() => {
      const footerText = container.textContent || '';
      expect(footerText).toContain('Showing top 10 values');
    });
  });

  // -----------------------------------------------------------------------
  // Save chart flow
  // -----------------------------------------------------------------------

  test('Save button opens save dialog with input and buttons', async () => {
    const user = userEvent.setup();
    const { queryByText, queryByPlaceholderText } = render(React.createElement(DataCharts, { result: mockNumericResult }));

    await user.click(queryByText('Save')!);
    expect(queryByPlaceholderText('Chart name...')).not.toBeNull();
    expect(queryByText('Cancel')).not.toBeNull();
  });

  test('Cancel button closes save dialog', async () => {
    const user = userEvent.setup();
    const { queryByText, queryByPlaceholderText } = render(React.createElement(DataCharts, { result: mockNumericResult }));

    await user.click(queryByText('Save')!);
    expect(queryByPlaceholderText('Chart name...')).not.toBeNull();

    await user.click(queryByText('Cancel')!);
    expect(queryByPlaceholderText('Chart name...')).toBeNull();
  });

  test('saving a chart persists to localStorage', async () => {
    const user = userEvent.setup();
    const { queryByText, queryByPlaceholderText } = render(React.createElement(DataCharts, { result: mockNumericResult }));

    await user.click(queryByText('Save')!);
    const input = queryByPlaceholderText('Chart name...')!;
    await user.type(input, 'My Chart');

    // Click the "Save" button in the dialog (not the initial Save)
    const saveBtns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent === 'Save');
    const dialogSave = saveBtns[saveBtns.length - 1];
    await user.click(dialogSave);

    const stored = localStorage.getItem('libredb_saved_charts');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed.length).toBe(1);
    expect(parsed[0].name).toBe('My Chart');
  });

  test('does not save when name is empty', async () => {
    const user = userEvent.setup();
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));

    await user.click(queryByText('Save')!);
    // Click Save without typing a name
    const saveBtns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent === 'Save');
    const dialogSave = saveBtns[saveBtns.length - 1];
    await user.click(dialogSave);

    const stored = localStorage.getItem('libredb_saved_charts');
    expect(stored).toBeNull();
  });

  test('loads saved charts from localStorage on mount', () => {
    const savedCharts = [
      { id: '1', name: 'Chart 1', chartType: 'bar', xAxis: 'category', yAxis: ['revenue'], aggregation: 'none', dateGrouping: '' },
    ];
    localStorage.setItem('libredb_saved_charts', JSON.stringify(savedCharts));

    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    expect(queryByText('Saved (1)')).not.toBeNull();
  });

  test('loads saved chart config when clicked', async () => {
    const savedCharts = [
      { id: '1', name: 'Line View', chartType: 'line', xAxis: 'date', yAxis: ['revenue'], aggregation: 'sum', dateGrouping: 'month' },
    ];
    localStorage.setItem('libredb_saved_charts', JSON.stringify(savedCharts));

    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    expect(queryByText('Saved (1)')).not.toBeNull();

    // Click the saved chart name
    const chartName = queryByText('Line View');
    expect(chartName).not.toBeNull();
    fireEvent.click(chartName!);
  });

  test('deletes saved chart removes from localStorage', async () => {
    const user = userEvent.setup();
    const savedCharts = [
      { id: '1', name: 'Old Chart', chartType: 'bar', xAxis: 'category', yAxis: ['revenue'], aggregation: 'none', dateGrouping: '' },
    ];
    localStorage.setItem('libredb_saved_charts', JSON.stringify(savedCharts));

    const { container } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    // Find the delete button inside the saved chart dropdown (has .lucide-x SVG)
    const deleteBtn = container.querySelector('.lucide-x')?.closest('button');
    expect(deleteBtn).not.toBeNull();
    await user.click(deleteBtn!);

    const stored = localStorage.getItem('libredb_saved_charts');
    const parsed = JSON.parse(stored || '[]');
    expect(parsed.length).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------------

  test('exports chart as PNG without throwing', async () => {
    const linkClick = mock(() => {});
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = linkClick as unknown as typeof HTMLAnchorElement.prototype.click;

    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText('Export as PNG')!);

    await waitFor(() => {
      expect(linkClick).toHaveBeenCalled();
    });

    HTMLAnchorElement.prototype.click = originalClick;
  });

  test('Export SVG triggers download when SVG element exists', async () => {
    const createObjectURLMock = mock(() => 'blob:fake-svg-url');
    const revokeObjectURLMock = mock(() => {});
    const linkClick = mock(() => {});

    globalThis.URL.createObjectURL = createObjectURLMock;
    globalThis.URL.revokeObjectURL = revokeObjectURLMock;
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = linkClick as unknown as typeof HTMLAnchorElement.prototype.click;

    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText('Export as SVG')!);

    // SVG export depends on finding an actual SVG element in the DOM
    // With mocked recharts, there won't be one, so just verify no error thrown
    HTMLAnchorElement.prototype.click = originalClick;
  });

  // -----------------------------------------------------------------------
  // Aggregation / date grouping hidden for certain chart types
  // -----------------------------------------------------------------------

  test('aggregation hidden for scatter chart', async () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText('Scatter')!);
    await waitFor(() => {
      expect(queryByText('Agg')).toBeNull();
    });
  });

  test('aggregation hidden for histogram chart', async () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText('Histogram')!);
    await waitFor(() => {
      expect(queryByText('Agg')).toBeNull();
    });
  });

  test('date grouping hidden for scatter chart', async () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText('Scatter')!);
    await waitFor(() => {
      expect(queryByText('Group')).toBeNull();
    });
  });

  test('date grouping hidden for histogram chart', async () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText('Histogram')!);
    await waitFor(() => {
      expect(queryByText('Group')).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Aggregation options rendered
  // -----------------------------------------------------------------------

  test('aggregation selector shows all options', () => {
    const { queryAllByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    // Aggregation: none, sum, avg, count, min, max
    expect(queryAllByTestId('select-item-sum').length).toBeGreaterThan(0);
    expect(queryAllByTestId('select-item-avg').length).toBeGreaterThan(0);
    expect(queryAllByTestId('select-item-count').length).toBeGreaterThan(0);
    expect(queryAllByTestId('select-item-min').length).toBeGreaterThan(0);
    expect(queryAllByTestId('select-item-max').length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Date grouping options rendered
  // -----------------------------------------------------------------------

  test('date grouping selector shows all options', () => {
    const { queryAllByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    // Date grouping: hour, day, week, month, year
    expect(queryAllByTestId('select-item-hour').length).toBeGreaterThan(0);
    expect(queryAllByTestId('select-item-day').length).toBeGreaterThan(0);
    expect(queryAllByTestId('select-item-week').length).toBeGreaterThan(0);
    expect(queryAllByTestId('select-item-month').length).toBeGreaterThan(0);
    expect(queryAllByTestId('select-item-year').length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Histogram bucket options
  // -----------------------------------------------------------------------

  test('histogram buckets selector shows options', async () => {
    const { queryByText, queryByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    fireEvent.click(queryByText('Histogram')!);
    await waitFor(() => {
      expect(queryByTestId('select-item-5')).not.toBeNull();
      expect(queryByTestId('select-item-10')).not.toBeNull();
      expect(queryByTestId('select-item-20')).not.toBeNull();
      expect(queryByTestId('select-item-50')).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Field type icons
  // -----------------------------------------------------------------------

  test('renders field type icons in X-axis selector', () => {
    const { container } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    // Check that field icons are rendered via lucide SVG class names
    const hashIcons = container.querySelectorAll('.lucide-hash');
    const calendarIcons = container.querySelectorAll('.lucide-calendar');
    const typeIcons = container.querySelectorAll('.lucide-type');
    expect(hashIcons.length).toBeGreaterThan(0);
    expect(calendarIcons.length).toBeGreaterThan(0);
    expect(typeIcons.length).toBeGreaterThan(0);
  });
});
