import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import React from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, fireEvent } from '@testing-library/react';

mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => React.createElement('div', {}, children),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => React.createElement('div', {}, children),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => React.createElement('div', {}, children),
  DropdownMenuItem: ({ children, onClick, disabled }: { children: React.ReactNode; onClick?: () => void; disabled?: boolean }) =>
    React.createElement('div', { onClick: disabled ? undefined : onClick, role: 'menuitem', 'aria-disabled': disabled }, children),
  DropdownMenuSeparator: ({ className }: { className?: string }) =>
    React.createElement('hr', { className }),
}));

mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick, className, disabled, ...rest }: Record<string, unknown>) =>
    React.createElement('button', { onClick: onClick as (() => void), className, disabled, ...rest }, children as React.ReactNode),
}));

mock.module('lucide-react', () => {
  return new Proxy({}, {
    get: (_target, prop) => {
      if (prop === '__esModule') return true;
      return (props: Record<string, unknown>) =>
        React.createElement('span', { 'data-icon': prop, className: props.className as string });
    },
  });
});

import { StudioMobileHeader } from '@/components/studio/StudioMobileHeader';
import type { DatabaseConnection } from '@/lib/types';

const conn: DatabaseConnection = { id: '1', name: 'prod-db', type: 'postgres', host: 'localhost', port: 5432, database: 'db', user: 'u', password: 'p', createdAt: new Date() };

describe('StudioMobileHeader', () => {
  afterEach(() => { cleanup(); });

  const mockToggleAi = mock(() => {});
  const mockOnExplain = mock(() => {});
  const mockOnBeginTransaction = mock(() => {});
  const mockOnCommitTransaction = mock(() => {});
  const mockOnRollbackTransaction = mock(() => {});
  const mockOnTogglePlayground = mock(() => {});
  const mockOnToggleEditing = mock(() => {});
  const mockOnImport = mock(() => {});

  const defaults = {
    connections: [conn],
    activeConnection: conn,
    connectionPulse: 'healthy' as const,
    user: { role: 'admin' },
    isAdmin: true,
    activeMobileTab: 'editor' as const,
    isExecuting: false,
    currentQuery: 'SELECT 1',
    queryEditorRef: { current: { toggleAi: mockToggleAi, format: mock(() => {}), getValue: mock(() => 'SELECT 1') } },
    transactionActive: false,
    playgroundMode: false,
    editingEnabled: false,
    onSelectConnection: mock(() => {}),
    onAddConnection: mock(() => {}),
    onLogout: mock(() => {}),
    onSaveQuery: mock(() => {}),
    onClearQuery: mock(() => {}),
    onExecuteQuery: mock(() => {}),
    onCancelQuery: mock(() => {}),
    onBeginTransaction: mockOnBeginTransaction,
    onCommitTransaction: mockOnCommitTransaction,
    onRollbackTransaction: mockOnRollbackTransaction,
    onTogglePlayground: mockOnTogglePlayground,
    onToggleEditing: mockOnToggleEditing,
    onImport: mockOnImport,
  };

  beforeEach(() => {
    mockToggleAi.mockClear();
    mockOnExplain.mockClear();
    mockOnBeginTransaction.mockClear();
    mockOnCommitTransaction.mockClear();
    mockOnRollbackTransaction.mockClear();
    mockOnTogglePlayground.mockClear();
    mockOnToggleEditing.mockClear();
    mockOnImport.mockClear();
  });

  test('renders DB selector and Online badge', () => {
    const { queryAllByText, container } = render(<StudioMobileHeader {...defaults} />);
    expect(queryAllByText('prod-db').length).toBeGreaterThan(0);
    expect(container.textContent).toContain('Online');
  });

  test('shows RUN button when on editor tab', () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} />);
    expect(queryByText('RUN')).not.toBeNull();
  });

  test('shows CANCEL button when executing', () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} isExecuting />);
    expect(queryByText('CANCEL')).not.toBeNull();
  });

  test('hides action row when not on editor tab', () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} activeMobileTab="database" />);
    expect(queryByText('RUN')).toBeNull();
  });

  test('shows Select DB when no active connection', () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} activeConnection={null} />);
    expect(queryByText('Select DB')).not.toBeNull();
  });

  // =========================================================================
  // Callbacks & Badges
  // =========================================================================

  test('AI button click calls queryEditorRef.current.toggleAi()', () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} />);
    const aiBtn = queryByText('AI');
    expect(aiBtn).not.toBeNull();
    fireEvent.click(aiBtn!.closest('button')!);
    expect(mockToggleAi).toHaveBeenCalledTimes(1);
  });

  test('Explain Plan click calls onExplain when provided', () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} onExplain={mockOnExplain} />);
    const explainItem = queryByText('Explain Plan');
    expect(explainItem).not.toBeNull();
    fireEvent.click(explainItem!.closest('[role="menuitem"]')!);
    expect(mockOnExplain).toHaveBeenCalledTimes(1);
  });

  test('Explain Plan not rendered when onExplain is undefined', () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} />);
    expect(queryByText('Explain Plan')).toBeNull();
  });

  test('BEGIN Transaction click calls onBeginTransaction', () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} />);
    const item = queryByText('BEGIN Transaction');
    expect(item).not.toBeNull();
    fireEvent.click(item!.closest('[role="menuitem"]')!);
    expect(mockOnBeginTransaction).toHaveBeenCalledTimes(1);
  });

  test('transactionActive=true shows COMMIT and calls onCommitTransaction', () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} transactionActive />);
    const item = queryByText('COMMIT');
    expect(item).not.toBeNull();
    fireEvent.click(item!.closest('[role="menuitem"]')!);
    expect(mockOnCommitTransaction).toHaveBeenCalledTimes(1);
  });

  test('transactionActive=true shows ROLLBACK and calls onRollbackTransaction', () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} transactionActive />);
    const item = queryByText('ROLLBACK');
    expect(item).not.toBeNull();
    fireEvent.click(item!.closest('[role="menuitem"]')!);
    expect(mockOnRollbackTransaction).toHaveBeenCalledTimes(1);
  });

  test('Enable Sandbox click calls onTogglePlayground', () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} />);
    const item = queryByText('Enable Sandbox');
    expect(item).not.toBeNull();
    fireEvent.click(item!.closest('[role="menuitem"]')!);
    expect(mockOnTogglePlayground).toHaveBeenCalledTimes(1);
  });

  test('Enable Editing click calls onToggleEditing', () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} />);
    const item = queryByText('Enable Editing');
    expect(item).not.toBeNull();
    fireEvent.click(item!.closest('[role="menuitem"]')!);
    expect(mockOnToggleEditing).toHaveBeenCalledTimes(1);
  });

  test('Import Data click calls onImport', () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} />);
    const item = queryByText('Import Data');
    expect(item).not.toBeNull();
    fireEvent.click(item!.closest('[role="menuitem"]')!);
    expect(mockOnImport).toHaveBeenCalledTimes(1);
  });

  test('transactionActive=true shows TXN badge', () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} transactionActive />);
    expect(queryByText('TXN')).not.toBeNull();
  });

  test('playgroundMode=true shows SANDBOX badge', () => {
    const { queryByText } = render(<StudioMobileHeader {...defaults} playgroundMode />);
    expect(queryByText('SANDBOX')).not.toBeNull();
  });
});
