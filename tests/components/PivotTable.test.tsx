import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, fireEvent } from '@testing-library/react';
import { PivotTable, aggregate } from '@/components/PivotTable';
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

  // --- New tests ---

  test('aggregate sum returns correct total', () => {
    // 90000 + 85000 + 70000 + 75000 = 320000
    expect(aggregate([90000, 85000, 70000, 75000], 'sum')).toBe('320000.00');
    expect(aggregate([10, 20, 30], 'sum')).toBe('60.00');
    expect(aggregate([0], 'sum')).toBe('0.00');
  });

  test('aggregate avg returns correct average', () => {
    // (90000 + 85000 + 70000 + 75000) / 4 = 80000
    expect(aggregate([90000, 85000, 70000, 75000], 'avg')).toBe('80000.00');
    expect(aggregate([10, 20, 30], 'avg')).toBe('20.00');
    expect(aggregate([5], 'avg')).toBe('5.00');
  });

  test('aggregate min and max return correct extremes', () => {
    const values = [90000, 85000, 70000, 75000];
    expect(aggregate(values, 'min')).toBe('70000');
    expect(aggregate(values, 'max')).toBe('90000');
    // Single value
    expect(aggregate([42], 'min')).toBe('42');
    expect(aggregate([42], 'max')).toBe('42');
  });

  test('aggregate with non-numeric values returns fallback', () => {
    // All non-numeric: sum=0, avg=0, min/max='-'
    const nonNumeric = ['hello', 'world', undefined];
    expect(aggregate(nonNumeric, 'sum')).toBe('0');
    expect(aggregate(nonNumeric, 'avg')).toBe('0');
    expect(aggregate(nonNumeric, 'min')).toBe('-');
    expect(aggregate(nonNumeric, 'max')).toBe('-');
    // count still counts all values
    expect(aggregate(nonNumeric, 'count')).toBe('3');
  });

  test('generateSQL with colField produces CASE WHEN for each column value', () => {
    const onLoadQuery = mock((sql: string) => { void sql; });
    const { container, queryByText } = render(<PivotTable result={result} onLoadQuery={onLoadQuery} />);
    // Set column field to 'status'
    const colSelect = container.querySelectorAll('select')[1];
    fireEvent.change(colSelect!, { target: { value: 'status' } });
    // Click SUM so aggregation is SUM
    fireEvent.click(queryByText('SUM')!);
    fireEvent.click(queryByText('Generate SQL')!);
    const sql: string = onLoadQuery.mock.calls[0][0];
    // Should have CASE WHEN for both 'active' and 'inactive' column values
    expect(sql).toContain('CASE WHEN "status" = \'active\'');
    expect(sql).toContain('CASE WHEN "status" = \'inactive\'');
    expect(sql).toContain('SUM(CASE WHEN');
    expect(sql).toContain('"salary"');
    expect(sql).toContain('GROUP BY');
  });

  test('onLoadQuery callback receives full SQL when Generate SQL clicked', () => {
    const onLoadQuery = mock((sql: string) => { void sql; });
    const { queryByText } = render(<PivotTable result={result} onLoadQuery={onLoadQuery} />);
    fireEvent.click(queryByText('Generate SQL')!);
    expect(onLoadQuery).toHaveBeenCalledTimes(1);
    const sql: string = onLoadQuery.mock.calls[0][0];
    // Should be valid SQL structure
    expect(sql).toMatch(/^SELECT\n/);
    expect(sql).toContain('FROM your_table');
    expect(sql).toContain('GROUP BY');
    expect(sql).toContain('ORDER BY');
    expect(sql.endsWith(';')).toBe(true);
  });

  test('NULL values in row field are grouped under "NULL" key', () => {
    const nullResult: QueryResult = {
      rows: [
        { dept: null, salary: 100 },
        { dept: null, salary: 200 },
        { dept: 'Sales', salary: 300 },
      ],
      fields: ['dept', 'salary'],
      rowCount: 3,
      executionTime: 1,
    };
    const { container } = render(<PivotTable result={nullResult} />);
    // Auto-detect won't pick dept (first row sample is null, not string),
    // so manually set rowField via the select dropdown
    const rowSelect = container.querySelectorAll('select')[0];
    fireEvent.change(rowSelect!, { target: { value: 'dept' } });
    const tds = container.querySelectorAll('td');
    const cellTexts = Array.from(tds).map(td => td.textContent);
    // Null values should be represented as 'NULL' row key
    expect(cellTexts).toContain('NULL');
  });

  test('status bar shows correct group, column, and aggregation counts', () => {
    const { container, queryByText } = render(<PivotTable result={result} />);
    // Default: 2 groups (Engineering, Sales), 1 column (__all__), COUNT aggregation
    const text = container.textContent || '';
    expect(text).toContain('2 groups');
    expect(text).toContain('1 columns');
    expect(text).toContain('COUNT aggregation');

    // Set column field to 'status' — should show 2 columns (active, inactive)
    const colSelect = container.querySelectorAll('select')[1];
    fireEvent.change(colSelect!, { target: { value: 'status' } });
    const updatedText = container.textContent || '';
    expect(updatedText).toContain('2 groups');
    expect(updatedText).toContain('2 columns');

    // Switch aggregation to AVG
    fireEvent.click(queryByText('AVG')!);
    expect(container.textContent).toContain('AVG aggregation');
  });

  test('switching aggregation function updates displayed values', () => {
    const { container, queryByText } = render(<PivotTable result={result} />);
    // Default is COUNT — Engineering has 2 rows, Sales has 2 rows
    const getValueCells = () => Array.from(container.querySelectorAll('td'))
      .filter((_, i) => i % 2 === 1)
      .map(td => td.textContent);

    let values = getValueCells();
    // COUNT: Engineering=2, Sales=2
    expect(values).toContain('2');

    // Switch to SUM
    fireEvent.click(queryByText('SUM')!);
    values = getValueCells();
    // SUM: Engineering = 90000+85000=175000.00, Sales = 70000+75000=145000.00
    expect(values).toContain('175000.00');
    expect(values).toContain('145000.00');

    // Switch to AVG
    fireEvent.click(queryByText('AVG')!);
    values = getValueCells();
    // AVG: Engineering = 87500.00, Sales = 72500.00
    expect(values).toContain('87500.00');
    expect(values).toContain('72500.00');
  });

  test('generateSQL without colField produces simple aggregation', () => {
    const onLoadQuery = mock((sql: string) => { void sql; });
    const { queryByText } = render(<PivotTable result={result} onLoadQuery={onLoadQuery} />);
    // Default: no colField set, auto-detected rowField=dept, valueField=salary, aggFunction=count
    fireEvent.click(queryByText('Generate SQL')!);
    const sql: string = onLoadQuery.mock.calls[0][0];
    // Should NOT contain CASE WHEN
    expect(sql).not.toContain('CASE WHEN');
    // Should have simple aggregation like COUNT("salary") AS "count_value"
    expect(sql).toContain('COUNT("salary") AS "count_value"');
    expect(sql).toContain('"dept"');
    expect(sql).toContain('GROUP BY "dept"');
    expect(sql).toContain('ORDER BY "dept"');
  });
});
