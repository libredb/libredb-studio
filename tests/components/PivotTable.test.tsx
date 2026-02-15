import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
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

  test('renders config bar and auto-detects fields', () => {
    const { queryByText } = render(<PivotTable result={result} />);
    expect(queryByText('COUNT')).not.toBeNull();
    expect(queryByText('SUM')).not.toBeNull();
    expect(queryByText('AVG')).not.toBeNull();
  });

  test('renders pivot data with row field detected', () => {
    const { container } = render(<PivotTable result={result} />);
    const text = container.textContent || '';
    expect(text).toContain('groups');
  });
});
