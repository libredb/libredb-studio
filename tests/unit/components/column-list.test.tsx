import { describe, test, expect } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ColumnList } from '@/components/schema-explorer/ColumnList';
import type { TableSchema } from '@/lib/types';

// =============================================================================
// Test Data
// =============================================================================

const primaryColumn: TableSchema['columns'][0] = {
  name: 'id',
  type: 'integer',
  nullable: false,
  isPrimary: true,
};

const regularColumn: TableSchema['columns'][0] = {
  name: 'email',
  type: 'varchar(255)',
  nullable: false,
  isPrimary: false,
};

const nullableColumn: TableSchema['columns'][0] = {
  name: 'bio',
  type: 'text',
  nullable: true,
  isPrimary: false,
};

const typedColumn: TableSchema['columns'][0] = {
  name: 'price',
  type: 'numeric(10,2)',
  nullable: false,
  isPrimary: false,
};

const indexes: TableSchema['indexes'] = [
  { name: 'users_pkey', columns: ['id'], unique: true },
  { name: 'users_email_key', columns: ['email'], unique: true },
];

// =============================================================================
// ColumnList Tests
// =============================================================================

describe('ColumnList', () => {
  // ── Renders columns ──────────────────────────────────────────────────────

  test('renders all column names', () => {
    const html = renderToStaticMarkup(
      <ColumnList columns={[primaryColumn, regularColumn]} indexes={[]} />
    );

    expect(html).toContain('id');
    expect(html).toContain('email');
  });

  // ── Primary key icon ─────────────────────────────────────────────────────

  test('renders Key icon for primary key column', () => {
    const html = renderToStaticMarkup(
      <ColumnList columns={[primaryColumn]} indexes={[]} />
    );

    // Key icon has yellow styling
    expect(html).toContain('text-yellow-500');
  });

  // ── Non-primary column dot ───────────────────────────────────────────────

  test('renders dot indicator for non-primary column', () => {
    const html = renderToStaticMarkup(
      <ColumnList columns={[regularColumn]} indexes={[]} />
    );

    // Non-primary columns get a dot instead of key icon
    expect(html).toContain('rounded-full');
    expect(html).not.toContain('text-yellow-500');
  });

  // ── Type display strips parentheses ──────────────────────────────────────

  test('displays column type without size specification', () => {
    const html = renderToStaticMarkup(
      <ColumnList columns={[typedColumn]} indexes={[]} />
    );

    // type.split('(')[0] should show 'numeric' not 'numeric(10,2)'
    expect(html).toContain('numeric');
    expect(html).not.toContain('10,2');
  });

  test('displays simple type as-is', () => {
    const html = renderToStaticMarkup(
      <ColumnList columns={[nullableColumn]} indexes={[]} />
    );

    expect(html).toContain('text');
  });

  // ── Mixed primary and non-primary ────────────────────────────────────────

  test('renders mix of primary and non-primary columns', () => {
    const html = renderToStaticMarkup(
      <ColumnList columns={[primaryColumn, regularColumn, nullableColumn]} indexes={[]} />
    );

    expect(html).toContain('id');
    expect(html).toContain('email');
    expect(html).toContain('bio');
    // Should have both key icon and dot
    expect(html).toContain('text-yellow-500');
    expect(html).toContain('rounded-full');
  });

  // ── No indexes ───────────────────────────────────────────────────────────

  test('does not render indexes section when empty', () => {
    const html = renderToStaticMarkup(
      <ColumnList columns={[primaryColumn]} indexes={[]} />
    );

    expect(html).not.toContain('Indexes');
  });

  // ── With indexes ─────────────────────────────────────────────────────────

  test('renders indexes section when indexes exist', () => {
    const html = renderToStaticMarkup(
      <ColumnList columns={[primaryColumn, regularColumn]} indexes={indexes} />
    );

    expect(html).toContain('Indexes');
    expect(html).toContain('users_pkey');
    expect(html).toContain('users_email_key');
  });

  // ── Index title attribute ────────────────────────────────────────────────

  test('renders index columns as title attribute', () => {
    const html = renderToStaticMarkup(
      <ColumnList columns={[primaryColumn]} indexes={indexes} />
    );

    // title should contain joined column names
    expect(html).toContain('title="id"');
    expect(html).toContain('title="email"');
  });

  // ── Index with multiple columns ──────────────────────────────────────────

  test('renders composite index columns joined with comma', () => {
    const compositeIndex = [
      { name: 'idx_composite', columns: ['user_id', 'created_at'], unique: false },
    ];

    const html = renderToStaticMarkup(
      <ColumnList columns={[primaryColumn]} indexes={compositeIndex} />
    );

    expect(html).toContain('idx_composite');
    expect(html).toContain('title="user_id, created_at"');
  });

  // ── Empty columns array ──────────────────────────────────────────────────

  test('renders empty state when no columns', () => {
    const html = renderToStaticMarkup(
      <ColumnList columns={[]} indexes={[]} />
    );

    // Should render the wrapper div but no column items
    expect(html).toContain('<div');
    expect(html).not.toContain('text-yellow-500');
    expect(html).not.toContain('rounded-full');
  });

  // ── varchar type stripping ───────────────────────────────────────────────

  test('strips varchar size from type display', () => {
    const html = renderToStaticMarkup(
      <ColumnList columns={[regularColumn]} indexes={[]} />
    );

    expect(html).toContain('varchar');
    expect(html).not.toContain('255');
  });
});
