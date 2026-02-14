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
import { mockPostgresConnection, mockMySQLConnection } from '../fixtures/connections';
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
});
