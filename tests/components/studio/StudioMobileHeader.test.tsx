import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';

mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => React.createElement('div', {}, children),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => React.createElement('div', {}, children),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => React.createElement('div', {}, children),
  DropdownMenuItem: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) => React.createElement('div', { onClick, role: 'menuitem' }, children),
}));

import { StudioMobileHeader } from '@/components/studio/StudioMobileHeader';
import type { DatabaseConnection } from '@/lib/types';

const conn: DatabaseConnection = { id: '1', name: 'prod-db', type: 'postgres', host: 'localhost', port: 5432, database: 'db', user: 'u', password: 'p', createdAt: new Date() };

describe('StudioMobileHeader', () => {
  afterEach(() => { cleanup(); });

  const defaults = {
    connections: [conn],
    activeConnection: conn,
    connectionPulse: 'healthy' as const,
    user: { role: 'admin' },
    isAdmin: true,
    activeMobileTab: 'editor' as const,
    isExecuting: false,
    currentQuery: 'SELECT 1',
    queryEditorRef: { current: null },
    metadata: null,
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
    onBeginTransaction: mock(() => {}),
    onCommitTransaction: mock(() => {}),
    onRollbackTransaction: mock(() => {}),
    onTogglePlayground: mock(() => {}),
    onToggleEditing: mock(() => {}),
    onImport: mock(() => {}),
  };

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
});
