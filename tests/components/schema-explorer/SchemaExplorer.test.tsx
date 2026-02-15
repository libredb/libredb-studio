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
});
