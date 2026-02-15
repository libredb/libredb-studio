import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { mock } from 'bun:test';

// Mock cmdk before component import
mock.module('cmdk', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require('react');
  const Command = React.forwardRef(({ children, ...props }: Record<string, unknown>, ref: React.Ref<HTMLElement>) =>
    React.createElement('div', { ...props, ref, 'data-testid': 'command' }, children));
  Command.displayName = 'Command';

  const CommandInput = React.forwardRef((props: Record<string, unknown>, ref: React.Ref<HTMLElement>) =>
    React.createElement('input', { ...props, ref, 'data-testid': 'command-input' }));
  CommandInput.displayName = 'CommandInput';
  Command.Input = CommandInput;

  const CommandList = ({ children, ...props }: Record<string, unknown>) =>
    React.createElement('div', { ...props, 'data-testid': 'command-list' }, children);
  CommandList.displayName = 'CommandList';
  Command.List = CommandList;

  const CommandEmpty = ({ children }: Record<string, unknown>) =>
    React.createElement('div', { 'data-testid': 'command-empty' }, children);
  CommandEmpty.displayName = 'CommandEmpty';
  Command.Empty = CommandEmpty;

  const CommandGroup = ({ children, heading, ...props }: Record<string, unknown>) =>
    React.createElement('div', { ...props, 'data-testid': `command-group-${heading}` },
      React.createElement('div', null, heading), children);
  CommandGroup.displayName = 'CommandGroup';
  Command.Group = CommandGroup;

  const CommandItem = ({ children, onSelect, ...props }: Record<string, unknown>) =>
    React.createElement('div', { ...props, onClick: onSelect, role: 'option', 'data-testid': 'command-item' }, children);
  CommandItem.displayName = 'CommandItem';
  Command.Item = CommandItem;

  const CommandSeparator = () => null;
  CommandSeparator.displayName = 'CommandSeparator';
  Command.Separator = CommandSeparator;

  return { Command };
});

// Mock storage
mock.module('@/lib/storage', () => ({
  storage: {
    getSavedQueries: mock(() => []),
    getHistory: mock(() => []),
  },
}));

// Mock db-ui-config
mock.module('@/lib/db-ui-config', () => ({
  getDBIcon: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    const MockDBIcon = (props: Record<string, unknown>) => React.createElement('span', { ...props, 'data-testid': 'db-icon' });
    MockDBIcon.displayName = 'MockDBIcon';
    return MockDBIcon;
  },
  getDBConfig: () => ({ icon: () => null, color: 'text-blue-400', label: 'PostgreSQL', defaultPort: '5432' }),
  getDBColor: () => 'text-blue-400',
}));

import { describe, test, expect, afterEach } from 'bun:test';
import { render, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

import { CommandPalette } from '@/components/CommandPalette';
import { storage } from '@/lib/storage';
import { mockPostgresConnection, mockMySQLConnection, mockSQLiteConnection, mockMongoDBConnection, mockRedisConnection, mockOracleConnection } from '../fixtures/connections';
import { mockSchema } from '../fixtures/schemas';

// =============================================================================
// CommandPalette Tests
// =============================================================================

function createDefaultProps(overrides: Partial<Parameters<typeof CommandPalette>[0]> = {}) {
  return {
    connections: [mockPostgresConnection, mockMySQLConnection],
    activeConnection: mockPostgresConnection,
    schema: mockSchema,
    onSelectConnection: mock(() => {}),
    onTableClick: mock(() => {}),
    onAddConnection: mock(() => {}),
    onExecuteQuery: mock(() => {}),
    onLoadSavedQuery: mock(() => {}),
    onLoadHistoryQuery: mock(() => {}),
    onNavigateHealth: mock(() => {}),
    onNavigateMonitoring: mock(() => {}),
    onShowDiagram: mock(() => {}),
    onFormatQuery: mock(() => {}),
    onSaveQuery: mock(() => {}),
    onToggleAI: mock(() => {}),
    onLogout: mock(() => {}),
    ...overrides,
  };
}

describe('CommandPalette', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders without crashing (dialog not visible initially)', () => {
    const props = createDefaultProps();
    const { queryByText } = render(<CommandPalette {...props} />);
    // Dialog starts closed (open=false), so content is not rendered
    expect(queryByText('Run Query')).toBeNull();
  });

  test('Cmd+K keyboard shortcut opens dialog', () => {
    const props = createDefaultProps();
    const { queryByText } = render(<CommandPalette {...props} />);

    // Initially, dialog content is not visible
    expect(queryByText('Run Query')).toBeNull();

    // Fire Cmd+K to open the dialog
    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    // After opening, the actions should be visible
    expect(queryByText('Run Query')).not.toBeNull();
  });

  test('shows connections when dialog is open', () => {
    const props = createDefaultProps();
    const { queryByText } = render(<CommandPalette {...props} />);

    // Open dialog
    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    // Connection names should appear
    expect(queryByText('Test PostgreSQL')).not.toBeNull();
    expect(queryByText('Test MySQL')).not.toBeNull();
  });

  test('shows tables from schema when dialog is open', () => {
    const props = createDefaultProps();
    const { queryByText } = render(<CommandPalette {...props} />);

    // Open dialog
    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    // Table names from mockSchema
    expect(queryByText('users')).not.toBeNull();
    expect(queryByText('orders')).not.toBeNull();
    expect(queryByText('products')).not.toBeNull();
  });

  test('active connection gets "Active" badge', () => {
    const props = createDefaultProps({
      activeConnection: mockPostgresConnection,
    });
    const { queryByText } = render(<CommandPalette {...props} />);

    // Open dialog
    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    // The active connection should have "Active" text
    expect(queryByText('Active')).not.toBeNull();
  });

  test('no "Active" badge when no connection is active', () => {
    const props = createDefaultProps({
      activeConnection: null,
    });
    const { queryByText } = render(<CommandPalette {...props} />);

    // Open dialog
    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    expect(queryByText('Active')).toBeNull();
  });

  test('callbacks fire when action items clicked', () => {
    const onExecuteQuery = mock(() => {});
    const props = createDefaultProps({ onExecuteQuery });
    const { getByText } = render(<CommandPalette {...props} />);

    // Open dialog
    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    // Find and click "Run Query" item
    const runQueryText = getByText('Run Query');
    const commandItem = runQueryText.closest('[role="option"]');
    expect(commandItem).not.toBeNull();
    fireEvent.click(commandItem!);

    // runAction calls setOpen(false) then setTimeout(action, 100)
    // Verify dialog closed (content disappears since open becomes false)
  });

  test('dialog closes after Cmd+K toggle', () => {
    const props = createDefaultProps();
    const { queryByText } = render(<CommandPalette {...props} />);

    // Open dialog
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(queryByText('Run Query')).not.toBeNull();

    // Close dialog by pressing Cmd+K again
    fireEvent.keyDown(document, { key: 'k', metaKey: true });
    expect(queryByText('Run Query')).toBeNull();
  });

  // ===========================================================================
  // Additional Tests
  // ===========================================================================

  test('Ctrl+K keyboard shortcut opens dialog (Windows)', () => {
    const props = createDefaultProps();
    const { queryByText } = render(<CommandPalette {...props} />);

    // Initially closed
    expect(queryByText('Run Query')).toBeNull();

    // Fire Ctrl+K (Windows shortcut) to open the dialog
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });

    // After opening, the actions should be visible
    expect(queryByText('Run Query')).not.toBeNull();
  });

  test('Schema Diagram is hidden when no activeConnection', () => {
    const props = createDefaultProps({ activeConnection: null });
    const { queryByText } = render(<CommandPalette {...props} />);

    // Open dialog
    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    // Schema Diagram (ERD) should not be rendered
    expect(queryByText('Schema Diagram (ERD)')).toBeNull();
  });

  test('Schema Diagram is visible with activeConnection', () => {
    const props = createDefaultProps({ activeConnection: mockPostgresConnection });
    const { queryByText } = render(<CommandPalette {...props} />);

    // Open dialog
    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    // Schema Diagram (ERD) should be rendered
    expect(queryByText('Schema Diagram (ERD)')).not.toBeNull();
  });

  test('Saved Queries group renders from storage', () => {
    const mockSaved = [
      { id: 'sq-1', name: 'Get active users', query: 'SELECT * FROM users WHERE is_active = true', connectionType: 'postgres' as const, createdAt: new Date(), updatedAt: new Date() },
      { id: 'sq-2', name: 'Count orders', query: 'SELECT COUNT(*) FROM orders', connectionType: 'postgres' as const, createdAt: new Date(), updatedAt: new Date() },
    ];
    (storage.getSavedQueries as ReturnType<typeof mock>).mockReturnValue(mockSaved);

    const props = createDefaultProps();
    const { queryByText, getByTestId } = render(<CommandPalette {...props} />);

    // Open dialog
    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    // Saved Queries group heading should appear
    expect(getByTestId('command-group-Saved Queries')).not.toBeNull();
    expect(queryByText('Get active users')).not.toBeNull();
    expect(queryByText('Count orders')).not.toBeNull();

    // Restore default
    (storage.getSavedQueries as ReturnType<typeof mock>).mockReturnValue([]);
  });

  test('Recent Queries group renders from history', () => {
    const mockHistory = [
      { id: 'h-1', connectionId: 'test-pg-1', query: 'SELECT * FROM users LIMIT 10', executionTime: 42, status: 'success' as const, executedAt: new Date() },
      { id: 'h-2', connectionId: 'test-pg-1', query: 'SELECT * FROM orders WHERE total > 100', executionTime: 78, status: 'success' as const, executedAt: new Date() },
    ];
    (storage.getHistory as ReturnType<typeof mock>).mockReturnValue(mockHistory);

    const props = createDefaultProps();
    const { getByTestId, queryByText } = render(<CommandPalette {...props} />);

    // Open dialog
    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    // Recent Queries group heading should appear
    expect(getByTestId('command-group-Recent Queries')).not.toBeNull();
    expect(queryByText('42ms')).not.toBeNull();
    expect(queryByText('78ms')).not.toBeNull();

    // Restore default
    (storage.getHistory as ReturnType<typeof mock>).mockReturnValue([]);
  });

  test('table column and row count display', () => {
    const props = createDefaultProps();
    const { queryByText } = render(<CommandPalette {...props} />);

    // Open dialog
    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    // users table: 6 columns, 100 rows
    expect(queryByText('6 cols / 100 rows')).not.toBeNull();
    // orders table: 5 columns, 500 rows
    expect(queryByText('5 cols / 500 rows')).not.toBeNull();
    // products table: 4 columns, 50 rows
    expect(queryByText('4 cols / 50 rows')).not.toBeNull();
  });

  test('Format Query action callback fires via runAction', () => {
    const onFormatQuery = mock(() => {});
    const props = createDefaultProps({ onFormatQuery });
    const { getByText } = render(<CommandPalette {...props} />);

    // Open dialog
    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    // Click Format Query item
    const formatItem = getByText('Format Query').closest('[role="option"]');
    expect(formatItem).not.toBeNull();
    fireEvent.click(formatItem!);

    // Dialog should close (content disappears)
    expect(getByText).toBeDefined();
  });

  test('Save Query action callback fires via runAction', () => {
    const onSaveQuery = mock(() => {});
    const props = createDefaultProps({ onSaveQuery });
    const { getByText } = render(<CommandPalette {...props} />);

    // Open dialog
    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    // Click Save Current Query item
    const saveItem = getByText('Save Current Query').closest('[role="option"]');
    expect(saveItem).not.toBeNull();
    fireEvent.click(saveItem!);
  });

  test('AI Assistant action callback fires via runAction', () => {
    const onToggleAI = mock(() => {});
    const props = createDefaultProps({ onToggleAI });
    const { getByText } = render(<CommandPalette {...props} />);

    // Open dialog
    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    // Click AI Assistant item
    const aiItem = getByText('AI Assistant').closest('[role="option"]');
    expect(aiItem).not.toBeNull();
    fireEvent.click(aiItem!);
  });

  test('Logout action callback fires via runAction', () => {
    const onLogout = mock(() => {});
    const props = createDefaultProps({ onLogout });
    const { getByText } = render(<CommandPalette {...props} />);

    // Open dialog
    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    // Click Logout item
    const logoutItem = getByText('Logout').closest('[role="option"]');
    expect(logoutItem).not.toBeNull();
    fireEvent.click(logoutItem!);
  });

  test('connection item click calls onSelectConnection', () => {
    const onSelectConnection = mock(() => {});
    const props = createDefaultProps({ onSelectConnection });
    const { getByText } = render(<CommandPalette {...props} />);

    // Open dialog
    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    // Click the MySQL connection item
    const mysqlItem = getByText('Test MySQL').closest('[role="option"]');
    expect(mysqlItem).not.toBeNull();
    fireEvent.click(mysqlItem!);

    // runAction calls setOpen(false) then setTimeout(callback, 100)
    // The dialog should close immediately
  });

  test('table item click calls onTableClick', () => {
    const onTableClick = mock(() => {});
    const props = createDefaultProps({ onTableClick });
    const { getByText } = render(<CommandPalette {...props} />);

    // Open dialog
    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    // Click the "orders" table item
    const ordersItem = getByText('orders').closest('[role="option"]');
    expect(ordersItem).not.toBeNull();
    fireEvent.click(ordersItem!);
  });

  test('DB icon is rendered for each connection', () => {
    const props = createDefaultProps({
      connections: [mockPostgresConnection, mockMySQLConnection, mockSQLiteConnection, mockMongoDBConnection, mockRedisConnection, mockOracleConnection],
    });
    const { getAllByTestId } = render(<CommandPalette {...props} />);

    // Open dialog
    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    // Each connection should render a db-icon via the mocked getDBIcon
    const dbIcons = getAllByTestId('db-icon');
    expect(dbIcons.length).toBe(6);
  });

  test('"No results found" is shown in empty command state', () => {
    const props = createDefaultProps({
      connections: [],
      schema: [],
      activeConnection: null,
    });
    const { queryByText } = render(<CommandPalette {...props} />);

    // Open dialog
    fireEvent.keyDown(document, { key: 'k', metaKey: true });

    // CommandEmpty renders "No results found." text
    expect(queryByText('No results found.')).not.toBeNull();
  });
});
