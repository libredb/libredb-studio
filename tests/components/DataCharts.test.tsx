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

  // ── 1. Renders "Cannot Visualize Data" when result is null ────────────────

  test('renders empty state when result is null', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: null }));

    expect(queryByText('Cannot Visualize Data')).not.toBeNull();
    expect(queryByText('No data to visualize')).not.toBeNull();
  });

  // ── 2. Renders empty state when result has empty rows ─────────────────────

  test('renders empty state when result has empty rows', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockEmptyResult }));

    expect(queryByText('Cannot Visualize Data')).not.toBeNull();
  });

  // ── 3. Renders empty state for single row ─────────────────────────────────

  test('renders empty state for single row result', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockSingleRowResult }));

    expect(queryByText('Cannot Visualize Data')).not.toBeNull();
    expect(queryByText('Need at least 2 rows for visualization')).not.toBeNull();
  });

  // ── 4. Renders empty state when no numeric fields ─────────────────────────

  test('renders empty state when no numeric fields exist', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNoNumericResult }));

    expect(queryByText('Cannot Visualize Data')).not.toBeNull();
    expect(queryByText('No numeric fields found for Y-axis')).not.toBeNull();
  });

  // ── 5. Shows chart type selector buttons ──────────────────────────────────

  test('shows chart type selector buttons', () => {
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

  // ── 6. X-Axis selector renders ────────────────────────────────────────────

  test('X-Axis selector renders with field options', () => {
    const { queryByText, queryByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));

    expect(queryByText('X-Axis')).not.toBeNull();
    expect(queryByTestId('select-item-category')).not.toBeNull();
    expect(queryByTestId('select-item-revenue')).not.toBeNull();
    expect(queryByTestId('select-item-cost')).not.toBeNull();
    expect(queryByTestId('select-item-date')).not.toBeNull();
  });

  // ── 7. Y-Axis selector renders ────────────────────────────────────────────

  test('Y-Axis selector renders', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));

    expect(queryByText('Y-Axis')).not.toBeNull();
  });

  // ── 8. Save chart button present ──────────────────────────────────────────

  test('Save chart button present', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));

    expect(queryByText('Save')).not.toBeNull();
  });

  // ── 9. Export button present ──────────────────────────────────────────────

  test('Export button present', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));

    expect(queryByText('Export')).not.toBeNull();
  });

  // ── 10. Aggregation selector present ──────────────────────────────────────

  test('Aggregation selector present', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));

    expect(queryByText('Agg')).not.toBeNull();
  });

  // ── 11. Date grouping selector appears for date columns ───────────────────

  test('date grouping selector appears when date columns exist', () => {
    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));

    expect(queryByText('Group')).not.toBeNull();
  });

  // ── 12. Footer stats display ──────────────────────────────────────────────

  test('footer shows row and field counts', () => {
    const { container } = render(React.createElement(DataCharts, { result: mockNumericResult }));

    const footerText = container.textContent || '';
    expect(footerText).toContain('5');
    expect(footerText).toContain('4');
  });

  test('switches chart types to scatter and histogram', async () => {
    const { queryByText, queryByTestId } = render(React.createElement(DataCharts, { result: mockNumericResult }));

    const scatterButton = queryByText('Scatter');
    expect(scatterButton).not.toBeNull();
    fireEvent.click(scatterButton!);

    await waitFor(() => {
      expect(queryByTestId('mock-scatter-chart')).not.toBeNull();
    });

    const histogramButton = queryByText('Histogram');
    expect(histogramButton).not.toBeNull();
    fireEvent.click(histogramButton!);

    await waitFor(() => {
      expect(queryByTestId('mock-bar-chart')).not.toBeNull();
    });
  });

  test('exports chart as PNG without throwing', async () => {
    const linkClick = mock(() => {});
    const originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = linkClick as unknown as typeof HTMLAnchorElement.prototype.click;

    const { queryByText } = render(React.createElement(DataCharts, { result: mockNumericResult }));
    const exportPngItem = queryByText('Export as PNG');
    expect(exportPngItem).not.toBeNull();
    fireEvent.click(exportPngItem!);

    await waitFor(() => {
      expect(linkClick).toHaveBeenCalled();
    });

    HTMLAnchorElement.prototype.click = originalClick;
  });
});
