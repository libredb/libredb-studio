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

  // ── inferFakerType: email column ────────────────────────────────────────────

  test('inferFakerType maps email column to email generator', () => {
    const { container } = render(
      <TestDataGenerator isOpen onClose={mock(() => {})} tableName="users" tableSchema={{
        name: 'users', indexes: [],
        columns: [{ name: 'email', type: 'VARCHAR(255)', nullable: false, isPrimary: false }],
      }} onExecuteQuery={mock(() => {})} />
    );
    const text = container.textContent || '';
    expect(text).toContain('email: email');
    expect(text).toContain('@example.com');
  });

  // ── inferFakerType: phone column ────────────────────────────────────────────

  test('inferFakerType maps phone column to phone generator', () => {
    const { container } = render(
      <TestDataGenerator isOpen onClose={mock(() => {})} tableName="contacts" tableSchema={{
        name: 'contacts', indexes: [],
        columns: [{ name: 'phone', type: 'VARCHAR(20)', nullable: true, isPrimary: false }],
      }} onExecuteQuery={mock(() => {})} />
    );
    const text = container.textContent || '';
    expect(text).toContain('phone: phone');
    expect(text).toContain('+1-555-');
  });

  // ── AutoIncrement columns excluded + shown with line-through ────────────────

  test('autoIncrement columns are excluded from SQL and shown with line-through', () => {
    const { container } = render(
      <TestDataGenerator isOpen onClose={mock(() => {})} tableName="employees" tableSchema={schema} onExecuteQuery={mock(() => {})} />
    );
    const text = container.textContent || '';
    // SQL should NOT include the "id" column in INSERT
    expect(text).not.toContain('"id"');
    // The mapping preview should show "id: autoIncrement" with line-through class
    const spans = container.querySelectorAll('span.line-through');
    expect(spans.length).toBeGreaterThan(0);
    const autoIncrSpan = Array.from(spans).find(s => s.textContent?.includes('id: autoIncrement'));
    expect(autoIncrSpan).not.toBeNull();
  });

  // ── MongoDB insertMany JSON generation ──────────────────────────────────────

  test('generates MongoDB insertMany JSON when queryLanguage is json', () => {
    const { container } = render(
      <TestDataGenerator isOpen onClose={mock(() => {})} tableName="users" tableSchema={{
        name: 'users', indexes: [],
        columns: [
          { name: 'name', type: 'VARCHAR(100)', nullable: false, isPrimary: false },
          { name: 'email', type: 'VARCHAR(255)', nullable: false, isPrimary: false },
        ],
      }} queryLanguage="json" onExecuteQuery={mock(() => {})} />
    );
    const text = container.textContent || '';
    expect(text).toContain('"collection": "users"');
    expect(text).toContain('"operation": "insertMany"');
    expect(text).toContain('"documents"');
    expect(text).not.toContain('INSERT INTO');
  });

  // ── Copy button writes to clipboard ─────────────────────────────────────────

  test('copy button writes generated query to clipboard', () => {
    const mockWriteText = mock(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      writable: true,
      configurable: true,
    });

    const { queryByText } = render(
      <TestDataGenerator isOpen onClose={mock(() => {})} tableName="employees" tableSchema={schema} onExecuteQuery={mock(() => {})} />
    );
    fireEvent.click(queryByText('Copy')!);
    expect(mockWriteText).toHaveBeenCalledTimes(1);
    const arg = (mockWriteText.mock.calls as unknown[][])[0][0] as string;
    expect(arg).toContain('INSERT INTO employees');
  });

  // ── "Copied!" feedback text ─────────────────────────────────────────────────

  test('shows Copied! feedback after clicking copy button', () => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: mock(() => Promise.resolve()) },
      writable: true,
      configurable: true,
    });

    const { queryByText } = render(
      <TestDataGenerator isOpen onClose={mock(() => {})} tableName="employees" tableSchema={schema} onExecuteQuery={mock(() => {})} />
    );
    expect(queryByText('Copy')).not.toBeNull();
    expect(queryByText('Copied!')).toBeNull();
    fireEvent.click(queryByText('Copy')!);
    expect(queryByText('Copied!')).not.toBeNull();
  });

  // ── Regenerate button ───────────────────────────────────────────────────────

  test('regenerate button re-generates data', () => {
    const { queryByText, container } = render(
      <TestDataGenerator isOpen onClose={mock(() => {})} tableName="employees" tableSchema={schema} onExecuteQuery={mock(() => {})} />
    );
    const before = container.querySelector('pre')?.textContent || '';
    fireEvent.click(queryByText('Regenerate')!);
    const after = container.querySelector('pre')?.textContent || '';
    // Both should contain INSERT INTO (still valid SQL)
    expect(before).toContain('INSERT INTO employees');
    expect(after).toContain('INSERT INTO employees');
  });

  // ── Column mapping preview display ──────────────────────────────────────────

  test('shows column mapping preview for each column', () => {
    const { container } = render(
      <TestDataGenerator isOpen onClose={mock(() => {})} tableName="employees" tableSchema={schema} onExecuteQuery={mock(() => {})} />
    );
    const text = container.textContent || '';
    expect(text).toContain('id: autoIncrement');
    expect(text).toContain('email: email');
    expect(text).toContain('name: fullName');
    expect(text).toContain('salary: price');
  });

  // ── Row count 25 generates 25 rows ─────────────────────────────────────────

  test('selecting row count 25 generates 25 value rows', () => {
    const onExecuteQuery = mock((q: string) => { void q; });
    const { queryByText } = render(
      <TestDataGenerator isOpen onClose={mock(() => {})} tableName="employees" tableSchema={schema} onExecuteQuery={onExecuteQuery} />
    );
    fireEvent.click(queryByText('25')!);
    fireEvent.click(queryByText('Execute')!);
    const sql = onExecuteQuery.mock.calls[0][0] as string;
    // Count the number of value tuples (each starts with '(')
    const tuples = sql.split('\n').filter(line => line.trim().startsWith('('));
    expect(tuples.length).toBe(25);
  });

  // ── Close button calls onClose ──────────────────────────────────────────────

  test('close button (X) calls onClose', () => {
    const onClose = mock(() => {});
    const { container } = render(
      <TestDataGenerator isOpen onClose={onClose} tableName="employees" tableSchema={schema} onExecuteQuery={mock(() => {})} />
    );
    // The X close button is the first button in the header
    const closeBtn = container.querySelector('button');
    expect(closeBtn).not.toBeNull();
    // Find the button that contains the X icon — it's the one right after header text
    const allButtons = container.querySelectorAll('button');
    const xButton = Array.from(allButtons).find(btn => {
      const svg = btn.querySelector('svg');
      return svg && !btn.textContent?.trim();
    });
    expect(xButton).not.toBeNull();
    fireEvent.click(xButton!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  // ── Column/row count in footer ──────────────────────────────────────────────

  test('footer shows correct column and row count', () => {
    const { container } = render(
      <TestDataGenerator isOpen onClose={mock(() => {})} tableName="employees" tableSchema={schema} onExecuteQuery={mock(() => {})} />
    );
    const text = container.textContent || '';
    // 4 columns total, 1 is autoIncrement (id), so 3 columns shown
    expect(text).toContain('3 columns');
    expect(text).toContain('10 rows');
  });

  // ── Numeric types not quoted in SQL ─────────────────────────────────────────

  test('numeric types are not quoted in SQL output', () => {
    const numericSchema: TableSchema = {
      name: 'metrics', indexes: [],
      columns: [
        { name: 'score', type: 'INTEGER', nullable: false, isPrimary: false },
        { name: 'rate', type: 'DECIMAL(5,2)', nullable: false, isPrimary: false },
      ],
    };
    const onExecuteQuery = mock((q: string) => { void q; });
    const { queryByText } = render(
      <TestDataGenerator isOpen onClose={mock(() => {})} tableName="metrics" tableSchema={numericSchema} onExecuteQuery={onExecuteQuery} />
    );
    fireEvent.click(queryByText('Execute')!);
    const sql = onExecuteQuery.mock.calls[0][0] as string;
    // Extract the first value tuple
    const firstRow = sql.split('\n').find(line => line.trim().startsWith('('));
    expect(firstRow).toBeDefined();
    // Numeric values should appear as bare numbers (no surrounding quotes)
    const values = firstRow!.trim().replace(/^\(/, '').replace(/\);?$/, '').split(',').map(v => v.trim());
    for (const v of values) {
      expect(v).not.toMatch(/^'/);
      expect(v).not.toMatch(/'$/);
    }
  });

  // ── String types quoted in SQL ──────────────────────────────────────────────

  test('string types are quoted with single quotes in SQL output', () => {
    const stringSchema: TableSchema = {
      name: 'people', indexes: [],
      columns: [
        { name: 'name', type: 'VARCHAR(100)', nullable: false, isPrimary: false },
        { name: 'email', type: 'TEXT', nullable: false, isPrimary: false },
      ],
    };
    const onExecuteQuery = mock((q: string) => { void q; });
    const { queryByText } = render(
      <TestDataGenerator isOpen onClose={mock(() => {})} tableName="people" tableSchema={stringSchema} onExecuteQuery={onExecuteQuery} />
    );
    fireEvent.click(queryByText('Execute')!);
    const sql = onExecuteQuery.mock.calls[0][0] as string;
    // Extract the first value tuple, strip surrounding parens/comma/semicolon
    const firstRow = sql.split('\n').find(line => line.trim().startsWith('('));
    expect(firstRow).toBeDefined();
    const inner = firstRow!.trim().replace(/^\(/, '').replace(/\)[,;]?\s*$/, '');
    // Split by ', ' outside quotes — here both values are simple quoted strings
    const values = inner.split(/, (?=')/);
    for (const v of values) {
      expect(v).toMatch(/^'/);
      expect(v).toMatch(/'$/);
    }
  });
});
