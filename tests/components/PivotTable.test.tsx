import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { PivotTable } from '@/components/PivotTable';
import type { QueryResult } from '@/lib/types';

const result: QueryResult = {
  rows: [
    { dept: 'Engineering', status: 'active', salary: 90000 },
    { dept: 'Engineering', status: 'inactive', salary: 85000 },
    { dept: 'Sales', status: 'active', salary: 70000 },
    { dept: 'Sales', status: 'active', salary: 75000 },
  ],
  fields: ['dept', 'status', 'salary'],
  rowCount: 4,
  executionTime: 5,
};

describe('PivotTable', () => {
  afterEach(() => { cleanup(); });

  test('shows empty state when result is null', () => {
    const { queryByText } = render(<PivotTable result={null} />);
    expect(queryByText('Pivot Table')).not.toBeNull();
    expect(queryByText('Execute a query to create pivot tables')).not.toBeNull();
  });

  test('shows empty state when result has no rows', () => {
    const empty: QueryResult = { rows: [], fields: ['id'], rowCount: 0, executionTime: 1 };
    const { queryByText } = render(<PivotTable result={empty} />);
    expect(queryByText('Pivot Table')).not.toBeNull();
  });

  test('renders config bar and auto-detects fields', () => {
    const { queryByText } = render(<PivotTable result={result} />);
    expect(queryByText('COUNT')).not.toBeNull();
    expect(queryByText('SUM')).not.toBeNull();
    expect(queryByText('AVG')).not.toBeNull();
    expect(queryByText('MIN')).not.toBeNull();
    expect(queryByText('MAX')).not.toBeNull();
  });

  test('renders pivot data with row field detected', () => {
    const { container } = render(<PivotTable result={result} />);
    const text = container.textContent || '';
    expect(text).toContain('groups');
  });

  test('shows row/column/value labels', () => {
    const { queryByText } = render(<PivotTable result={result} />);
    expect(queryByText('Rows:')).not.toBeNull();
    expect(queryByText('Columns:')).not.toBeNull();
    expect(queryByText('Values:')).not.toBeNull();
  });

  test('auto-detects string column as rowField and numeric as valueField', () => {
    const { container } = render(<PivotTable result={result} />);
    const selects = container.querySelectorAll('select');
    // First select is rowField — should have dept auto-selected
    expect(selects[0]?.value).toBe('dept');
    // Third select is valueField — should have salary auto-selected
    expect(selects[2]?.value).toBe('salary');
  });

  test('changing row field select updates pivot', () => {
    const { container } = render(<PivotTable result={result} />);
    const rowSelect = container.querySelectorAll('select')[0];
    fireEvent.change(rowSelect!, { target: { value: 'status' } });
    const text = container.textContent || '';
    // After selecting 'status', should show groups based on active/inactive
    expect(text).toContain('active');
  });

  test('changing column field adds pivot columns', () => {
    const { container } = render(<PivotTable result={result} />);
    const colSelect = container.querySelectorAll('select')[1];
    fireEvent.change(colSelect!, { target: { value: 'status' } });
    const text = container.textContent || '';
    // Column headers should include status values
    expect(text).toContain('active');
    expect(text).toContain('inactive');
  });

  test('changing value field select updates pivot', () => {
    const { container } = render(<PivotTable result={result} />);
    const valSelect = container.querySelectorAll('select')[2];
    fireEvent.change(valSelect!, { target: { value: '' } });
    // Cleared value field — pivot uses count
    const text = container.textContent || '';
    expect(text).toContain('groups');
  });

  test('clicking SUM button changes aggregation', () => {
    const { queryByText, container } = render(<PivotTable result={result} />);
    const sumBtn = queryByText('SUM');
    fireEvent.click(sumBtn!);
    const text = container.textContent || '';
    // SUM aggregation should show in status footer
    expect(text).toContain('SUM aggregation');
  });

  test('clicking AVG button changes aggregation', () => {
    const { queryByText, container } = render(<PivotTable result={result} />);
    fireEvent.click(queryByText('AVG')!);
    expect(container.textContent).toContain('AVG aggregation');
  });

  test('clicking MIN button changes aggregation', () => {
    const { queryByText, container } = render(<PivotTable result={result} />);
    fireEvent.click(queryByText('MIN')!);
    expect(container.textContent).toContain('MIN aggregation');
  });

  test('clicking MAX button changes aggregation', () => {
    const { queryByText, container } = render(<PivotTable result={result} />);
    fireEvent.click(queryByText('MAX')!);
    expect(container.textContent).toContain('MAX aggregation');
  });

  test('Generate SQL button appears when onLoadQuery provided and row selected', () => {
    const onLoadQuery = mock(() => {});
    const { queryByText } = render(<PivotTable result={result} onLoadQuery={onLoadQuery} />);
    expect(queryByText('Generate SQL')).not.toBeNull();
  });

  test('Generate SQL button not shown when onLoadQuery not provided', () => {
    const { queryByText } = render(<PivotTable result={result} />);
    expect(queryByText('Generate SQL')).toBeNull();
  });

  test('clicking Generate SQL calls onLoadQuery with SQL', () => {
    const onLoadQuery = mock((sql: string) => { void sql; });
    const { queryByText } = render(<PivotTable result={result} onLoadQuery={onLoadQuery} />);
    fireEvent.click(queryByText('Generate SQL')!);
    expect(onLoadQuery).toHaveBeenCalledTimes(1);
    const sql = onLoadQuery.mock.calls[0][0];
    expect(sql).toContain('SELECT');
    expect(sql).toContain('GROUP BY');
    expect(sql).toContain('dept');
  });

  test('Generate SQL with column field uses CASE WHEN', () => {
    const onLoadQuery = mock((sql: string) => { void sql; });
    const { container, queryByText } = render(<PivotTable result={result} onLoadQuery={onLoadQuery} />);
    // Set column field
    const colSelect = container.querySelectorAll('select')[1];
    fireEvent.change(colSelect!, { target: { value: 'status' } });
    fireEvent.click(queryByText('Generate SQL')!);
    const sql = onLoadQuery.mock.calls[0][0];
    expect(sql).toContain('CASE WHEN');
  });

  test('status footer shows group and column counts', () => {
    const { container } = render(<PivotTable result={result} />);
    const text = container.textContent || '';
    // 2 groups (Engineering, Sales)
    expect(text).toContain('2 groups');
    // 1 column (__all__)
    expect(text).toContain('1 columns');
  });

  test('pivot table renders header with rowField name', () => {
    const { container } = render(<PivotTable result={result} />);
    const ths = container.querySelectorAll('th');
    expect(ths.length).toBeGreaterThan(0);
    expect(ths[0]?.textContent).toBe('dept');
  });

  test('pivot table renders row keys', () => {
    const { container } = render(<PivotTable result={result} />);
    const tds = container.querySelectorAll('td');
    const rowKeys = Array.from(tds).filter((_, i) => i % 2 === 0).map(td => td.textContent);
    expect(rowKeys).toContain('Engineering');
    expect(rowKeys).toContain('Sales');
  });

  test('no auto-detect when fewer than 2 fields', () => {
    const single: QueryResult = {
      rows: [{ id: 1 }],
      fields: ['id'],
      rowCount: 1,
      executionTime: 1,
    };
    const { queryByText } = render(<PivotTable result={single} />);
    // Config bar should render but no auto-detection — shows "Select row and value fields" placeholder
    expect(queryByText('Select row and value fields to build pivot')).not.toBeNull();
  });

  test('clearing row field shows placeholder', () => {
    const { container, queryByText } = render(<PivotTable result={result} />);
    const rowSelect = container.querySelectorAll('select')[0];
    fireEvent.change(rowSelect!, { target: { value: '' } });
    expect(queryByText('Select row and value fields to build pivot')).not.toBeNull();
  });
});
