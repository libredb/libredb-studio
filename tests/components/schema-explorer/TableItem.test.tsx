import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import React from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, within } from '@testing-library/react';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockToastSuccess = mock((msg: string) => { void msg; });

mock.module('sonner', () => ({
  toast: { success: mockToastSuccess, error: mock(() => {}), info: mock(() => {}) },
}));

mock.module('framer-motion', () => ({
  motion: new Proxy({}, {
    get: () => (props: Record<string, unknown>) =>
      React.createElement('div', props, props.children as React.ReactNode),
  }),
  AnimatePresence: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', {}, children),
}));

mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', {}, children),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', {}, children),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'dropdown' }, children),
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) =>
    React.createElement('div', { onClick, role: 'menuitem' }, children),
  DropdownMenuSeparator: () => React.createElement('hr'),
}));

mock.module('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', {}, children),
  ContextMenuTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', {}, children),
  ContextMenuContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'context-menu' }, children),
  ContextMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) =>
    React.createElement('div', { onClick, role: 'menuitem' }, children),
  ContextMenuSeparator: () => React.createElement('hr'),
}));

mock.module('@/components/schema-explorer/ColumnList', () => ({
  ColumnList: ({ columns, indexes }: { columns: unknown[]; indexes: unknown[] }) =>
    React.createElement('div', { 'data-testid': 'column-list' }, `${columns.length} cols, ${indexes.length} idx`),
}));

// ── Imports after mocks ─────────────────────────────────────────────────────

import { TableItem } from '@/components/schema-explorer/TableItem';
import type { TableSchema } from '@/lib/types';

// ── Test data ───────────────────────────────────────────────────────────────

const largeTable: TableSchema = {
  name: 'users',
  rowCount: 1500,
  indexes: [{ name: 'idx_users_email', columns: ['email'], unique: true }],
  columns: [
    { name: 'id', type: 'SERIAL', nullable: false, isPrimary: true },
    { name: 'email', type: 'VARCHAR(255)', nullable: true, isPrimary: false },
  ],
};

const smallTable: TableSchema = {
  name: 'settings',
  rowCount: 42,
  indexes: [],
  columns: [
    { name: 'key', type: 'TEXT', nullable: false, isPrimary: true },
    { name: 'value', type: 'TEXT', nullable: true, isPrimary: false },
  ],
};

const noRowCountTable: TableSchema = {
  name: 'logs',
  indexes: [],
  columns: [
    { name: 'id', type: 'SERIAL', nullable: false, isPrimary: true },
  ],
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe('TableItem', () => {
  let mockWriteText: ReturnType<typeof mock>;

  beforeEach(() => {
    mockWriteText = mock(async (text: string) => { void text; });
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      configurable: true,
    });
    mockToastSuccess.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  // ── Rendering ─────────────────────────────────────────────────────────────

  test('renders table name', () => {
    const { queryByText } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} />
    );
    expect(queryByText('users')).not.toBeNull();
  });

  test('renders row count formatted as K for >= 1000', () => {
    const { queryByText } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} />
    );
    expect(queryByText('1.5k')).not.toBeNull();
  });

  test('renders raw row count for < 1000', () => {
    const { queryByText } = render(
      <TableItem table={smallTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} />
    );
    expect(queryByText('42')).not.toBeNull();
  });

  test('does not render row count when undefined', () => {
    const { queryByText } = render(
      <TableItem table={noRowCountTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} />
    );
    // No row count text should be rendered
    expect(queryByText(/^\d/)).toBeNull();
  });

  // ── Expand / Collapse ─────────────────────────────────────────────────────

  test('hides ColumnList when collapsed', () => {
    const { queryByTestId } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} />
    );
    expect(queryByTestId('column-list')).toBeNull();
  });

  test('shows ColumnList with columns and indexes when expanded', () => {
    const { queryByTestId } = render(
      <TableItem table={largeTable} isExpanded onToggle={mock(() => {})} isAdmin={false} />
    );
    const columnList = queryByTestId('column-list');
    expect(columnList).not.toBeNull();
    expect(columnList!.textContent).toContain('2 cols');
    expect(columnList!.textContent).toContain('1 idx');
  });

  test('applies bg-accent/50 class when expanded', () => {
    const { container } = render(
      <TableItem table={largeTable} isExpanded onToggle={mock(() => {})} isAdmin={false} />
    );
    const row = container.querySelector('.bg-accent\\/50');
    expect(row).not.toBeNull();
  });

  // ── onToggle ──────────────────────────────────────────────────────────────

  test('calls onToggle when row is clicked', () => {
    const onToggle = mock(() => {});
    const { queryByText } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={onToggle} isAdmin={false} />
    );
    fireEvent.click(queryByText('users')!);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  // ── Dropdown action callbacks ─────────────────────────────────────────────

  test('onTableClick fires with table name on "Select Top 100" click', () => {
    const onTableClick = mock((name: string) => { void name; });
    const { getByTestId } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} onTableClick={onTableClick} />
    );
    const dropdown = within(getByTestId('dropdown'));
    fireEvent.click(dropdown.getByText('Select Top 100'));
    expect(onTableClick).toHaveBeenCalledTimes(1);
    expect(onTableClick.mock.calls[0][0]).toBe('users');
  });

  test('onGenerateSelect fires with table name on "Generate Query" click', () => {
    const onGenerateSelect = mock((name: string) => { void name; });
    const { getByTestId } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} onGenerateSelect={onGenerateSelect} />
    );
    const dropdown = within(getByTestId('dropdown'));
    fireEvent.click(dropdown.getByText('Generate Query'));
    expect(onGenerateSelect).toHaveBeenCalledTimes(1);
    expect(onGenerateSelect.mock.calls[0][0]).toBe('users');
  });

  test('copyToClipboard copies table name and shows toast on "Copy Name" click', () => {
    const { getByTestId } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} />
    );
    const dropdown = within(getByTestId('dropdown'));
    fireEvent.click(dropdown.getByText('Copy Name'));
    expect(mockWriteText).toHaveBeenCalledTimes(1);
    expect(mockWriteText.mock.calls[0][0]).toBe('users');
    expect(mockToastSuccess).toHaveBeenCalledTimes(1);
    expect(mockToastSuccess.mock.calls[0][0]).toContain('copied to clipboard');
  });

  test('onProfileTable fires with table name on "Profile Table" click', () => {
    const onProfileTable = mock((name: string) => { void name; });
    const { getByTestId } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} onProfileTable={onProfileTable} />
    );
    const dropdown = within(getByTestId('dropdown'));
    fireEvent.click(dropdown.getByText('Profile Table'));
    expect(onProfileTable).toHaveBeenCalledTimes(1);
    expect(onProfileTable.mock.calls[0][0]).toBe('users');
  });

  test('onGenerateCode fires with table name on "Generate Code" click', () => {
    const onGenerateCode = mock((name: string) => { void name; });
    const { getByTestId } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} onGenerateCode={onGenerateCode} />
    );
    const dropdown = within(getByTestId('dropdown'));
    fireEvent.click(dropdown.getByText('Generate Code'));
    expect(onGenerateCode).toHaveBeenCalledTimes(1);
    expect(onGenerateCode.mock.calls[0][0]).toBe('users');
  });

  test('onGenerateTestData fires with table name on "Generate Test Data" click', () => {
    const onGenerateTestData = mock((name: string) => { void name; });
    const { getByTestId } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} onGenerateTestData={onGenerateTestData} />
    );
    const dropdown = within(getByTestId('dropdown'));
    fireEvent.click(dropdown.getByText('Generate Test Data'));
    expect(onGenerateTestData).toHaveBeenCalledTimes(1);
    expect(onGenerateTestData.mock.calls[0][0]).toBe('users');
  });

  // ── Admin-only actions ────────────────────────────────────────────────────

  test('shows Analyze and Vacuum actions for admin', () => {
    const { getByTestId } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin />
    );
    const dropdown = within(getByTestId('dropdown'));
    expect(dropdown.queryByText('Analyze Table')).not.toBeNull();
    expect(dropdown.queryByText('Vacuum Table')).not.toBeNull();
  });

  test('hides Analyze and Vacuum actions for non-admin', () => {
    const { getByTestId } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} />
    );
    const dropdown = within(getByTestId('dropdown'));
    expect(dropdown.queryByText('Analyze Table')).toBeNull();
    expect(dropdown.queryByText('Vacuum Table')).toBeNull();
  });

  test('onOpenMaintenance fires with "tables" and table name on Analyze click', () => {
    const onOpenMaintenance = mock((tab?: string, tbl?: string) => { void tab; void tbl; });
    const { getByTestId } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin onOpenMaintenance={onOpenMaintenance} />
    );
    const dropdown = within(getByTestId('dropdown'));
    fireEvent.click(dropdown.getByText('Analyze Table'));
    expect(onOpenMaintenance).toHaveBeenCalledTimes(1);
    expect(onOpenMaintenance.mock.calls[0][0]).toBe('tables');
    expect(onOpenMaintenance.mock.calls[0][1]).toBe('users');
  });

  test('onOpenMaintenance fires on Vacuum click', () => {
    const onOpenMaintenance = mock((tab?: string, tbl?: string) => { void tab; void tbl; });
    const { getByTestId } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin onOpenMaintenance={onOpenMaintenance} />
    );
    const dropdown = within(getByTestId('dropdown'));
    fireEvent.click(dropdown.getByText('Vacuum Table'));
    expect(onOpenMaintenance).toHaveBeenCalledTimes(1);
    expect(onOpenMaintenance.mock.calls[0][0]).toBe('tables');
    expect(onOpenMaintenance.mock.calls[0][1]).toBe('users');
  });

  // ── Custom labels ─────────────────────────────────────────────────────────

  test('uses custom labels from provider metadata', () => {
    const labels = {
      selectAction: 'Run db.find()',
      generateAction: 'Build Aggregation',
      entityName: 'Collection',
      entityNamePlural: 'Collections',
      rowName: 'document',
      rowNamePlural: 'documents',
      analyzeAction: 'Run Stats',
      vacuumAction: 'Compact',
      searchPlaceholder: 'Search collections...',
      analyzeGlobalLabel: 'Analyze All',
      analyzeGlobalTitle: 'Analyze',
      analyzeGlobalDesc: 'Run stats on all',
      vacuumGlobalLabel: 'Compact All',
      vacuumGlobalTitle: 'Compact',
      vacuumGlobalDesc: 'Compact all',
    };
    const { getByTestId } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin labels={labels} />
    );
    const dropdown = within(getByTestId('dropdown'));
    expect(dropdown.queryByText('Run db.find()')).not.toBeNull();
    expect(dropdown.queryByText('Build Aggregation')).not.toBeNull();
    expect(dropdown.queryByText('Run Stats')).not.toBeNull();
    expect(dropdown.queryByText('Compact')).not.toBeNull();
    // Default labels should not appear
    expect(dropdown.queryByText('Select Top 100')).toBeNull();
    expect(dropdown.queryByText('Generate Query')).toBeNull();
  });

  test('copyToClipboard uses custom entityName in toast', () => {
    const labels = {
      entityName: 'Collection',
      entityNamePlural: 'Collections',
      rowName: 'document',
      rowNamePlural: 'documents',
      selectAction: 'Select Top 100',
      generateAction: 'Generate Query',
      analyzeAction: 'Analyze Table',
      vacuumAction: 'Vacuum Table',
      searchPlaceholder: 'Search...',
      analyzeGlobalLabel: 'Analyze All',
      analyzeGlobalTitle: 'Analyze',
      analyzeGlobalDesc: 'Run stats',
      vacuumGlobalLabel: 'Compact All',
      vacuumGlobalTitle: 'Compact',
      vacuumGlobalDesc: 'Compact all',
    };
    const { getByTestId } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} labels={labels} />
    );
    const dropdown = within(getByTestId('dropdown'));
    fireEvent.click(dropdown.getByText('Copy Name'));
    expect(mockToastSuccess.mock.calls[0][0]).toContain('Collection');
  });

  // ── Callbacks not provided (optional chaining safety) ─────────────────────

  test('does not crash when optional callbacks are not provided', () => {
    const { getByTestId } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin />
    );
    const dropdown = within(getByTestId('dropdown'));
    // Click all menu items without providing callbacks - should not throw
    fireEvent.click(dropdown.getByText('Select Top 100'));
    fireEvent.click(dropdown.getByText('Generate Query'));
    fireEvent.click(dropdown.getByText('Profile Table'));
    fireEvent.click(dropdown.getByText('Generate Code'));
    fireEvent.click(dropdown.getByText('Generate Test Data'));
    fireEvent.click(dropdown.getByText('Analyze Table'));
    fireEvent.click(dropdown.getByText('Vacuum Table'));
    // If we got here, no crash occurred
    expect(true).toBe(true);
  });

  // ── Expanded state styling ────────────────────────────────────────────────

  test('table name has text-foreground class when expanded', () => {
    const { queryByText } = render(
      <TableItem table={largeTable} isExpanded onToggle={mock(() => {})} isAdmin={false} />
    );
    const nameSpan = queryByText('users');
    expect(nameSpan).not.toBeNull();
    expect(nameSpan!.className).toContain('text-foreground');
  });

  test('table name has text-muted-foreground class when collapsed', () => {
    const { queryByText } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} />
    );
    const nameSpan = queryByText('users');
    expect(nameSpan).not.toBeNull();
    expect(nameSpan!.className).toContain('text-muted-foreground');
  });

  // ── Context menu ──────────────────────────────────────────────────────────

  test('renders context menu with same actions as dropdown', () => {
    const { queryAllByText } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin />
    );
    // Each action should appear twice: once in dropdown, once in context menu
    expect(queryAllByText('Select Top 100').length).toBe(2);
    expect(queryAllByText('Generate Query').length).toBe(2);
    expect(queryAllByText('Copy Name').length).toBe(2);
    expect(queryAllByText('Profile Table').length).toBe(2);
    expect(queryAllByText('Generate Code').length).toBe(2);
    expect(queryAllByText('Generate Test Data').length).toBe(2);
    expect(queryAllByText('Analyze Table').length).toBe(2);
    expect(queryAllByText('Vacuum Table').length).toBe(2);
  });

  test('context menu actions are not duplicated for non-admin', () => {
    const { queryAllByText } = render(
      <TableItem table={largeTable} isExpanded={false} onToggle={mock(() => {})} isAdmin={false} />
    );
    // Standard actions appear twice (dropdown + context menu)
    expect(queryAllByText('Select Top 100').length).toBe(2);
    // Admin-only actions should not appear at all
    expect(queryAllByText('Analyze Table').length).toBe(0);
    expect(queryAllByText('Vacuum Table').length).toBe(0);
  });
});
