import '../../setup-dom';

import React from 'react';
import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { mock } from 'bun:test';

// ── Mocks ───────────────────────────────────────────────────────────────────

mock.module('framer-motion', () => ({
  motion: new Proxy({}, {
    get: () => (props: Record<string, unknown>) =>
      React.createElement('div', {}, props.children as React.ReactNode),
  }),
  AnimatePresence: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', {}, children),
}));

// ── Imports after mocks ─────────────────────────────────────────────────────

import { ColumnList } from '@/components/schema-explorer/ColumnList';
import type { TableSchema } from '@/lib/types';

// ── Test data ───────────────────────────────────────────────────────────────

const columnsWithPrimary: TableSchema['columns'] = [
  { name: 'id', type: 'SERIAL', nullable: false, isPrimary: true },
  { name: 'email', type: 'VARCHAR(255)', nullable: true, isPrimary: false },
  { name: 'created_at', type: 'timestamp', nullable: false, isPrimary: false },
];

const columnsNoPrimary: TableSchema['columns'] = [
  { name: 'key', type: 'TEXT', nullable: false, isPrimary: false },
  { name: 'value', type: 'JSONB', nullable: true, isPrimary: false },
];

const indexesSample: TableSchema['indexes'] = [
  { name: 'idx_email', columns: ['email'], unique: true },
  { name: 'idx_created', columns: ['created_at'], unique: false },
];

// ── Tests ───────────────────────────────────────────────────────────────────

describe('ColumnList', () => {
  afterEach(() => {
    cleanup();
  });

  // ── Column rendering ────────────────────────────────────────────────────

  test('renders all column names', () => {
    const { queryByText } = render(
      <ColumnList columns={columnsWithPrimary} indexes={[]} />
    );
    expect(queryByText('id')).not.toBeNull();
    expect(queryByText('email')).not.toBeNull();
    expect(queryByText('created_at')).not.toBeNull();
  });

  test('renders column types stripped of parenthesized params', () => {
    const { queryByText } = render(
      <ColumnList columns={columnsWithPrimary} indexes={[]} />
    );
    // VARCHAR(255) → should display "VARCHAR" only (type.split('(')[0])
    expect(queryByText('VARCHAR')).not.toBeNull();
    expect(queryByText('SERIAL')).not.toBeNull();
    expect(queryByText('timestamp')).not.toBeNull();
  });

  test('does not render full type with params', () => {
    const { queryByText } = render(
      <ColumnList columns={columnsWithPrimary} indexes={[]} />
    );
    expect(queryByText('VARCHAR(255)')).toBeNull();
  });

  // ── Primary key indicator ───────────────────────────────────────────────

  test('renders Key icon for primary key columns', () => {
    const { container } = render(
      <ColumnList columns={columnsWithPrimary} indexes={[]} />
    );
    // Key icon has text-yellow-500/70 class
    const keyIcons = container.querySelectorAll('.text-yellow-500\\/70');
    expect(keyIcons.length).toBe(1); // only 'id' is primary
  });

  test('renders dot indicator for non-primary columns', () => {
    const { container } = render(
      <ColumnList columns={columnsNoPrimary} indexes={[]} />
    );
    // Non-primary columns get a small dot (bg-muted-foreground/50)
    const dots = container.querySelectorAll('.bg-muted-foreground\\/50');
    expect(dots.length).toBe(2); // both columns are non-primary
    // No key icons
    const keyIcons = container.querySelectorAll('.text-yellow-500\\/70');
    expect(keyIcons.length).toBe(0);
  });

  // ── Indexes section ─────────────────────────────────────────────────────

  test('shows Indexes section when indexes are present', () => {
    const { queryByText } = render(
      <ColumnList columns={columnsWithPrimary} indexes={indexesSample} />
    );
    expect(queryByText('Indexes')).not.toBeNull();
  });

  test('renders all index names', () => {
    const { queryByText } = render(
      <ColumnList columns={columnsWithPrimary} indexes={indexesSample} />
    );
    expect(queryByText('idx_email')).not.toBeNull();
    expect(queryByText('idx_created')).not.toBeNull();
  });

  test('hides Indexes section when no indexes', () => {
    const { queryByText } = render(
      <ColumnList columns={columnsWithPrimary} indexes={[]} />
    );
    expect(queryByText('Indexes')).toBeNull();
  });

  test('index element has title attribute with column names', () => {
    const { queryByText } = render(
      <ColumnList columns={columnsWithPrimary} indexes={indexesSample} />
    );
    const indexEl = queryByText('idx_email');
    expect(indexEl).not.toBeNull();
    expect(indexEl!.getAttribute('title')).toBe('email');
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  test('renders empty column list without crashing', () => {
    const { container } = render(
      <ColumnList columns={[]} indexes={[]} />
    );
    expect(container).not.toBeNull();
  });

  test('handles columns with simple types (no parens)', () => {
    const columns: TableSchema['columns'] = [
      { name: 'active', type: 'boolean', nullable: false, isPrimary: false },
    ];
    const { queryByText } = render(
      <ColumnList columns={columns} indexes={[]} />
    );
    expect(queryByText('boolean')).not.toBeNull();
  });
});
