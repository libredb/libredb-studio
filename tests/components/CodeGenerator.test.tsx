import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { CodeGenerator } from '@/components/CodeGenerator';
import type { TableSchema } from '@/lib/types';

const schema: TableSchema = {
  name: 'users',
  indexes: [],
  columns: [
    { name: 'id', type: 'SERIAL', nullable: false, isPrimary: true },
    { name: 'email', type: 'VARCHAR(255)', nullable: false, isPrimary: false },
    { name: 'age', type: 'INTEGER', nullable: true, isPrimary: false },
    { name: 'is_active', type: 'BOOLEAN', nullable: false, isPrimary: false },
    { name: 'created_at', type: 'TIMESTAMP', nullable: true, isPrimary: false },
  ],
};

describe('CodeGenerator', () => {
  afterEach(() => { cleanup(); });

  test('does not render when isOpen is false', () => {
    const { container } = render(
      <CodeGenerator isOpen={false} onClose={mock(() => {})} tableName="users" tableSchema={schema} />
    );
    expect(container.textContent).toBe('');
  });

  test('renders TypeScript interface by default', () => {
    const { queryByText, container } = render(
      <CodeGenerator isOpen onClose={mock(() => {})} tableName="users" tableSchema={schema} />
    );
    expect(queryByText('Code Generator')).not.toBeNull();
    expect(container.textContent).toContain('export interface User');
    expect(container.textContent).toContain('email: string');
    expect(container.textContent).toContain('age: number | null');
  });

  test('switches language via dropdown', () => {
    const { queryByText, container } = render(
      <CodeGenerator isOpen onClose={mock(() => {})} tableName="users" tableSchema={schema} />
    );
    fireEvent.click(queryByText('TypeScript Interface')!);
    fireEvent.click(queryByText('Go Struct')!);
    expect(container.textContent).toContain('type User struct');
  });

  test('copy button works', () => {
    const writeText = mock(async (t: string) => { void t; });
    Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText }, configurable: true });

    const { queryByText } = render(
      <CodeGenerator isOpen onClose={mock(() => {})} tableName="users" tableSchema={schema} />
    );
    fireEvent.click(queryByText('Copy')!);
    expect(writeText).toHaveBeenCalledTimes(1);
  });

  test('close button fires onClose', () => {
    const onClose = mock(() => {});
    const { container } = render(
      <CodeGenerator isOpen onClose={onClose} tableName="users" tableSchema={schema} />
    );
    const closeBtn = container.querySelector('button');
    fireEvent.click(closeBtn!);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
