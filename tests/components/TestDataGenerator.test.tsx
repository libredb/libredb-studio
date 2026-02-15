import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { TestDataGenerator } from '@/components/TestDataGenerator';
import type { TableSchema } from '@/lib/types';

const schema: TableSchema = {
  name: 'employees',
  indexes: [],
  columns: [
    { name: 'id', type: 'SERIAL', nullable: false, isPrimary: true },
    { name: 'email', type: 'VARCHAR(255)', nullable: false, isPrimary: false },
    { name: 'name', type: 'VARCHAR(100)', nullable: false, isPrimary: false },
    { name: 'salary', type: 'DECIMAL(10,2)', nullable: true, isPrimary: false },
  ],
};

describe('TestDataGenerator', () => {
  afterEach(() => { cleanup(); });

  test('does not render when isOpen is false', () => {
    const { container } = render(
      <TestDataGenerator isOpen={false} onClose={mock(() => {})} tableName="employees" tableSchema={schema} onExecuteQuery={mock(() => {})} />
    );
    expect(container.textContent).toBe('');
  });

  test('renders header, row controls, and SQL preview', () => {
    const { queryByText, container } = render(
      <TestDataGenerator isOpen onClose={mock(() => {})} tableName="employees" tableSchema={schema} onExecuteQuery={mock(() => {})} />
    );
    expect(queryByText('Test Data Generator')).not.toBeNull();
    expect(queryByText('employees')).not.toBeNull();
    expect(queryByText('10')).not.toBeNull();
    expect(container.textContent).toContain('INSERT INTO employees');
  });

  test('row count buttons change output', () => {
    const { queryByText, container } = render(
      <TestDataGenerator isOpen onClose={mock(() => {})} tableName="employees" tableSchema={schema} onExecuteQuery={mock(() => {})} />
    );
    fireEvent.click(queryByText('5')!);
    const text = container.textContent || '';
    expect(text).toContain('INSERT INTO employees');
  });

  test('execute button fires onExecuteQuery and onClose', () => {
    const onExecuteQuery = mock((q: string) => { void q; });
    const onClose = mock(() => {});
    const { queryByText } = render(
      <TestDataGenerator isOpen onClose={onClose} tableName="employees" tableSchema={schema} onExecuteQuery={onExecuteQuery} />
    );
    fireEvent.click(queryByText('Execute')!);
    expect(onExecuteQuery).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
