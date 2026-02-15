import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import { mock } from 'bun:test';
import { setupFramerMotionMock } from '../../helpers/mock-monaco';

// Setup framer-motion mock before component imports
setupFramerMotionMock();

// Mock the child TableItem component to simplify testing
mock.module('@/components/schema-explorer/TableItem', () => ({
  TableItem: ({ table }: { table: { name: string } }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': `table-${table.name}` }, table.name);
  },
}));

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

import { SchemaExplorer } from '@/components/schema-explorer/SchemaExplorer';
import { mockSchema, emptySchema } from '../../fixtures/schemas';

// =============================================================================
// SchemaExplorer Tests
// =============================================================================

function createDefaultProps(overrides: Partial<Parameters<typeof SchemaExplorer>[0]> = {}) {
  return {
    schema: mockSchema,
    isLoadingSchema: false,
    onTableClick: mock(() => {}),
    onGenerateSelect: mock(() => {}),
    onCreateTableClick: mock(() => {}),
    isAdmin: false,
    metadata: {
      capabilities: {
        queryLanguage: 'sql' as const,
        supportsExplain: true,
        supportsExternalQueryLimiting: true,
        supportsCreateTable: true,
        supportsMaintenance: false,
        maintenanceOperations: [],
        supportsConnectionString: false,
        defaultPort: 5432,
        schemaRefreshPattern: '',
      },
      labels: {
        entityName: 'Table',
        entityNamePlural: 'Tables',
        rowName: 'row',
        rowNamePlural: 'rows',
        selectAction: 'SELECT * FROM',
        generateAction: 'Generate',
        analyzeAction: 'Analyze',
        vacuumAction: 'Vacuum',
        searchPlaceholder: 'Search tables or columns...',
        analyzeGlobalLabel: 'Analyze All',
        analyzeGlobalTitle: 'Analyze All Tables',
        analyzeGlobalDesc: 'Update statistics for all tables',
        vacuumGlobalLabel: 'Vacuum All',
        vacuumGlobalTitle: 'Vacuum All Tables',
        vacuumGlobalDesc: 'Reclaim storage for all tables',
      },
    },
    ...overrides,
  };
}

describe('SchemaExplorer', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    // Clear any mocks between tests
  });

  // ── Loading state ─────────────────────────────────────────────────────────

  test('loading state shows spinner', () => {
    const props = createDefaultProps({ isLoadingSchema: true });
    const { container } = render(<SchemaExplorer {...props} />);
    const view = within(container);

    expect(view.queryByText('Scanning Schema...')).not.toBeNull();
  });

  // ── Empty state ───────────────────────────────────────────────────────────

  test('empty state when schema is empty', () => {
    const props = createDefaultProps({ schema: emptySchema });
    const { container } = render(<SchemaExplorer {...props} />);
    const view = within(container);

    expect(view.queryByText('No structures found')).not.toBeNull();
  });

  // ── Renders table items ───────────────────────────────────────────────────

  test('renders table items from schema', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaExplorer {...props} />);

    expect(container.querySelector('[data-testid="table-users"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="table-orders"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="table-products"]')).not.toBeNull();
  });

  // ── Search filters ────────────────────────────────────────────────────────

  test('search filters tables by name', async () => {
    const user = userEvent.setup();
    const props = createDefaultProps();
    const { container } = render(<SchemaExplorer {...props} />);
    const view = within(container);

    const searchInput = view.getByPlaceholderText('Search tables or columns...');
    await user.type(searchInput, 'users');

    // Only users table should remain
    expect(container.querySelector('[data-testid="table-users"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="table-orders"]')).toBeNull();
    expect(container.querySelector('[data-testid="table-products"]')).toBeNull();
  });

  // ── Table count badge ─────────────────────────────────────────────────────

  test('shows table count badge', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaExplorer {...props} />);
    const view = within(container);

    expect(view.queryByText('3')).not.toBeNull();
  });

  // ── Create table button ───────────────────────────────────────────────────

  test('create table button visible when capabilities.supportsCreateTable', () => {
    const onCreateTableClick = mock(() => {});
    const props = createDefaultProps({ onCreateTableClick });
    const { container } = render(<SchemaExplorer {...props} />);

    const createButton = container.querySelector('button[title="Create Table"]');
    expect(createButton).not.toBeNull();
  });

  // ── Create table button click ───────────────────────────────────────────

  test('create table button calls onCreateTableClick when clicked', async () => {
    const user = userEvent.setup();
    const onCreateTableClick = mock(() => {});
    const props = createDefaultProps({ onCreateTableClick });
    const { container } = render(<SchemaExplorer {...props} />);

    const createButton = container.querySelector('button[title="Create Table"]') as HTMLElement;
    await user.click(createButton);
    expect(onCreateTableClick).toHaveBeenCalledTimes(1);
  });

  // ── Create table button hidden ──────────────────────────────────────────

  test('create table button hidden when supportsCreateTable is false', () => {
    const props = createDefaultProps({
      metadata: {
        capabilities: {
          queryLanguage: 'sql' as const,
          supportsExplain: true,
          supportsExternalQueryLimiting: true,
          supportsCreateTable: false,
          supportsMaintenance: false,
          maintenanceOperations: [],
          supportsConnectionString: false,
          defaultPort: 5432,
          schemaRefreshPattern: '',
        },
        labels: {
          entityName: 'Table',
          entityNamePlural: 'Tables',
          rowName: 'row',
          rowNamePlural: 'rows',
          selectAction: 'SELECT * FROM',
          generateAction: 'Generate',
          analyzeAction: 'Analyze',
          vacuumAction: 'Vacuum',
          searchPlaceholder: 'Search tables or columns...',
          analyzeGlobalLabel: 'Analyze All',
          analyzeGlobalTitle: 'Analyze All Tables',
          analyzeGlobalDesc: 'Update statistics for all tables',
          vacuumGlobalLabel: 'Vacuum All',
          vacuumGlobalTitle: 'Vacuum All Tables',
          vacuumGlobalDesc: 'Reclaim storage for all tables',
        },
      },
    });
    const { container } = render(<SchemaExplorer {...props} />);

    const createButton = container.querySelector('button[title="Create Table"]');
    expect(createButton).toBeNull();
  });

  // ── Search filters by column name ───────────────────────────────────────

  test('search filters tables by column name match', async () => {
    const user = userEvent.setup();
    const props = createDefaultProps();
    const { container } = render(<SchemaExplorer {...props} />);
    const view = within(container);

    // 'email' is a column in users table
    const searchInput = view.getByPlaceholderText('Search tables or columns...');
    await user.type(searchInput, 'email');

    // users table has 'email' column, so it should match
    expect(container.querySelector('[data-testid="table-users"]')).not.toBeNull();
    // orders and products don't have an 'email' column
    expect(container.querySelector('[data-testid="table-orders"]')).toBeNull();
    expect(container.querySelector('[data-testid="table-products"]')).toBeNull();
  });

  // ── Search no results ───────────────────────────────────────────────────

  test('search with no matching results shows empty list', async () => {
    const user = userEvent.setup();
    const props = createDefaultProps();
    const { container } = render(<SchemaExplorer {...props} />);
    const view = within(container);

    const searchInput = view.getByPlaceholderText('Search tables or columns...');
    await user.type(searchInput, 'nonexistent_xyz');

    expect(container.querySelector('[data-testid="table-users"]')).toBeNull();
    expect(container.querySelector('[data-testid="table-orders"]')).toBeNull();
    expect(container.querySelector('[data-testid="table-products"]')).toBeNull();
  });

  // ── Search clear button ─────────────────────────────────────────────────

  test('clear button appears when search has text and clears on click', async () => {
    const user = userEvent.setup();
    const props = createDefaultProps();
    const { container } = render(<SchemaExplorer {...props} />);
    const view = within(container);

    const searchInput = view.getByPlaceholderText('Search tables or columns...');
    await user.type(searchInput, 'users');

    // Only users table visible after typing
    expect(container.querySelector('[data-testid="table-orders"]')).toBeNull();

    // The clear button is a <button> with a Hash icon (rotate-45)
    const clearButton = container.querySelector('button.absolute.right-2') as HTMLElement;
    expect(clearButton).not.toBeNull();
    await user.click(clearButton);

    // All tables should reappear
    expect(container.querySelector('[data-testid="table-users"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="table-orders"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="table-products"]')).not.toBeNull();
  });

  test('clear button not shown when search is empty', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaExplorer {...props} />);

    const clearButton = container.querySelector('button.absolute.right-2');
    expect(clearButton).toBeNull();
  });

  // ── Admin maintenance button ────────────────────────────────────────────

  test('maintenance settings button visible for admin', () => {
    const props = createDefaultProps({ isAdmin: true });
    const { container } = render(<SchemaExplorer {...props} />);

    const maintenanceButton = container.querySelector('button[title="Database Maintenance"]');
    expect(maintenanceButton).not.toBeNull();
  });

  test('maintenance settings button hidden for non-admin', () => {
    const props = createDefaultProps({ isAdmin: false });
    const { container } = render(<SchemaExplorer {...props} />);

    const maintenanceButton = container.querySelector('button[title="Database Maintenance"]');
    expect(maintenanceButton).toBeNull();
  });

  test('maintenance button calls onOpenMaintenance with "global"', async () => {
    const user = userEvent.setup();
    const onOpenMaintenance = mock(() => {});
    const props = createDefaultProps({ isAdmin: true, onOpenMaintenance });
    const { container } = render(<SchemaExplorer {...props} />);

    const maintenanceButton = container.querySelector('button[title="Database Maintenance"]') as HTMLElement;
    await user.click(maintenanceButton);
    expect(onOpenMaintenance).toHaveBeenCalledTimes(1);
    expect((onOpenMaintenance.mock.calls as unknown[][])[0][0]).toBe('global');
  });

  // ── Custom labels ───────────────────────────────────────────────────────

  test('uses custom search placeholder from labels', () => {
    const props = createDefaultProps({
      metadata: {
        capabilities: {
          queryLanguage: 'json' as const,
          supportsExplain: false,
          supportsExternalQueryLimiting: false,
          supportsCreateTable: false,
          supportsMaintenance: false,
          maintenanceOperations: [],
          supportsConnectionString: true,
          defaultPort: 27017,
          schemaRefreshPattern: '',
        },
        labels: {
          entityName: 'Collection',
          entityNamePlural: 'Collections',
          rowName: 'document',
          rowNamePlural: 'documents',
          selectAction: 'db.find()',
          generateAction: 'Build Aggregation',
          analyzeAction: 'Run Stats',
          vacuumAction: 'Compact',
          searchPlaceholder: 'Search collections...',
          analyzeGlobalLabel: 'Analyze All',
          analyzeGlobalTitle: 'Analyze',
          analyzeGlobalDesc: 'Run stats',
          vacuumGlobalLabel: 'Compact All',
          vacuumGlobalTitle: 'Compact',
          vacuumGlobalDesc: 'Compact all',
        },
      },
    });
    const { container } = render(<SchemaExplorer {...props} />);
    const view = within(container);

    expect(view.getByPlaceholderText('Search collections...')).not.toBeNull();
  });

  test('uses custom entity name in create button title', () => {
    const props = createDefaultProps({
      metadata: {
        capabilities: {
          queryLanguage: 'json' as const,
          supportsExplain: false,
          supportsExternalQueryLimiting: false,
          supportsCreateTable: true,
          supportsMaintenance: false,
          maintenanceOperations: [],
          supportsConnectionString: true,
          defaultPort: 27017,
          schemaRefreshPattern: '',
        },
        labels: {
          entityName: 'Collection',
          entityNamePlural: 'Collections',
          rowName: 'document',
          rowNamePlural: 'documents',
          selectAction: 'db.find()',
          generateAction: 'Build Aggregation',
          analyzeAction: 'Run Stats',
          vacuumAction: 'Compact',
          searchPlaceholder: 'Search collections...',
          analyzeGlobalLabel: 'Analyze All',
          analyzeGlobalTitle: 'Analyze',
          analyzeGlobalDesc: 'Run stats',
          vacuumGlobalLabel: 'Compact All',
          vacuumGlobalTitle: 'Compact',
          vacuumGlobalDesc: 'Compact all',
        },
      },
    });
    const { container } = render(<SchemaExplorer {...props} />);

    const createButton = container.querySelector('button[title="Create Collection"]');
    expect(createButton).not.toBeNull();
  });

  // ── Null metadata handling ──────────────────────────────────────────────

  test('renders with null metadata using default labels', () => {
    const props = createDefaultProps({ metadata: null });
    const { container } = render(<SchemaExplorer {...props} />);
    const view = within(container);

    // Default search placeholder
    expect(view.getByPlaceholderText('Search tables or columns...')).not.toBeNull();
    // Default create button title
    const createButton = container.querySelector('button[title="Create Table"]');
    expect(createButton).not.toBeNull();
    // Tables should still render
    expect(container.querySelector('[data-testid="table-users"]')).not.toBeNull();
  });

  test('renders with undefined metadata using default labels', () => {
    const props = createDefaultProps({ metadata: undefined });
    const { container } = render(<SchemaExplorer {...props} />);
    const view = within(container);

    expect(view.getByPlaceholderText('Search tables or columns...')).not.toBeNull();
  });

  // ── Loading state content ───────────────────────────────────────────────

  test('loading state does not render tables or search', () => {
    const props = createDefaultProps({ isLoadingSchema: true });
    const { container } = render(<SchemaExplorer {...props} />);
    const view = within(container);

    expect(view.queryByPlaceholderText('Search tables or columns...')).toBeNull();
    expect(container.querySelector('[data-testid="table-users"]')).toBeNull();
  });

  // ── Empty state content ─────────────────────────────────────────────────

  test('empty state shows descriptive message', () => {
    const props = createDefaultProps({ schema: emptySchema });
    const { container } = render(<SchemaExplorer {...props} />);
    const view = within(container);

    expect(view.queryByText(/couldn.*find any tables/i)).not.toBeNull();
  });

  test('empty state does not render search input', () => {
    const props = createDefaultProps({ schema: emptySchema });
    const { container } = render(<SchemaExplorer {...props} />);
    const view = within(container);

    expect(view.queryByPlaceholderText('Search tables or columns...')).toBeNull();
  });

  // ── Explorer header ─────────────────────────────────────────────────────

  test('renders Explorer header label', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaExplorer {...props} />);
    const view = within(container);

    expect(view.queryByText('Explorer')).not.toBeNull();
  });

  // ── Case-insensitive search ─────────────────────────────────────────────

  test('search is case-insensitive', async () => {
    const user = userEvent.setup();
    const props = createDefaultProps();
    const { container } = render(<SchemaExplorer {...props} />);
    const view = within(container);

    const searchInput = view.getByPlaceholderText('Search tables or columns...');
    await user.type(searchInput, 'USERS');

    expect(container.querySelector('[data-testid="table-users"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="table-orders"]')).toBeNull();
  });
});
