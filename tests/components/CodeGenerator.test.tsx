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

  test('shows table name in header', () => {
    const { queryAllByText } = render(
      <CodeGenerator isOpen onClose={mock(() => {})} tableName="orders" tableSchema={schema} />
    );
    // Table name appears in header and footer
    expect(queryAllByText('orders').length).toBeGreaterThanOrEqual(1);
  });

  test('shows database type when provided', () => {
    const { queryByText } = render(
      <CodeGenerator isOpen onClose={mock(() => {})} tableName="users" tableSchema={schema} databaseType="postgres" />
    );
    expect(queryByText('postgres')).not.toBeNull();
  });

  test('does not show database type badge when not provided', () => {
    const { queryByText } = render(
      <CodeGenerator isOpen onClose={mock(() => {})} tableName="users" tableSchema={schema} />
    );
    expect(queryByText('postgres')).toBeNull();
  });

  test('shows no schema message when tableSchema is null', () => {
    const { container } = render(
      <CodeGenerator isOpen onClose={mock(() => {})} tableName="users" tableSchema={null} />
    );
    expect(container.textContent).toContain('No schema available');
  });

  test('switches to Zod schema', () => {
    const { queryByText, container } = render(
      <CodeGenerator isOpen onClose={mock(() => {})} tableName="users" tableSchema={schema} />
    );
    fireEvent.click(queryByText('TypeScript Interface')!);
    fireEvent.click(queryByText('Zod Schema')!);
    expect(container.textContent).toContain('z.object');
  });

  test('switches to Prisma model', () => {
    const { queryByText, container } = render(
      <CodeGenerator isOpen onClose={mock(() => {})} tableName="users" tableSchema={schema} />
    );
    fireEvent.click(queryByText('TypeScript Interface')!);
    fireEvent.click(queryByText('Prisma Model')!);
    expect(container.textContent).toContain('model User');
  });

  test('switches to Python dataclass', () => {
    const { queryByText, container } = render(
      <CodeGenerator isOpen onClose={mock(() => {})} tableName="users" tableSchema={schema} />
    );
    fireEvent.click(queryByText('TypeScript Interface')!);
    fireEvent.click(queryByText('Python Dataclass')!);
    expect(container.textContent).toContain('@dataclass');
    expect(container.textContent).toContain('class User:');
  });

  test('switches to Java POJO', () => {
    const { queryByText, container } = render(
      <CodeGenerator isOpen onClose={mock(() => {})} tableName="users" tableSchema={schema} />
    );
    fireEvent.click(queryByText('TypeScript Interface')!);
    fireEvent.click(queryByText('Java POJO')!);
    expect(container.textContent).toContain('public class User');
  });

  test('footer shows column count and format', () => {
    const { queryByText } = render(
      <CodeGenerator isOpen onClose={mock(() => {})} tableName="users" tableSchema={schema} />
    );
    expect(queryByText(/5 columns/)).not.toBeNull();
    expect(queryByText(/ts format/)).not.toBeNull();
  });

  test('footer format changes with language', () => {
    const { queryByText } = render(
      <CodeGenerator isOpen onClose={mock(() => {})} tableName="users" tableSchema={schema} />
    );
    fireEvent.click(queryByText('TypeScript Interface')!);
    fireEvent.click(queryByText('Go Struct')!);
    expect(queryByText(/go format/)).not.toBeNull();
  });

  test('copy button shows Copied! after click', () => {
    const writeText = mock(async (t: string) => { void t; });
    Object.defineProperty(globalThis.navigator, 'clipboard', { value: { writeText }, configurable: true });

    const { queryByText } = render(
      <CodeGenerator isOpen onClose={mock(() => {})} tableName="users" tableSchema={schema} />
    );
    fireEvent.click(queryByText('Copy')!);
    expect(queryByText('Copied!')).not.toBeNull();
  });

  test('dropdown closes after selecting language', () => {
    const { queryByText, queryAllByText } = render(
      <CodeGenerator isOpen onClose={mock(() => {})} tableName="users" tableSchema={schema} />
    );
    // Open dropdown
    fireEvent.click(queryByText('TypeScript Interface')!);
    // All languages should be visible
    expect(queryByText('Go Struct')).not.toBeNull();
    // Select one
    fireEvent.click(queryByText('Go Struct')!);
    // Dropdown should close — 'Python Dataclass' should not be in dropdown (only in button would be Go Struct)
    const pythonItems = queryAllByText('Python Dataclass');
    // After closing, the dropdown items are gone
    expect(pythonItems.length).toBe(0);
  });
});
