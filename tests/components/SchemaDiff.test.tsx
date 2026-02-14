import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { mock } from 'bun:test';

// Mock diff engine
const mockDiffResult = {
  tables: [
    {
      action: 'added',
      tableName: 'new_table',
      columns: [
        { action: 'added', columnName: 'id', targetType: 'integer', changes: ['Added column "id" (integer)'] },
      ],
      indexes: [],
      foreignKeys: [],
    },
    {
      action: 'removed',
      tableName: 'old_table',
      columns: [
        { action: 'removed', columnName: 'name', sourceType: 'varchar', changes: ['Removed column "name"'] },
      ],
      indexes: [],
      foreignKeys: [],
    },
    {
      action: 'modified',
      tableName: 'users',
      columns: [
        { action: 'modified', columnName: 'email', sourceType: 'varchar(100)', targetType: 'varchar(255)', changes: ['Type changed: varchar(100) -> varchar(255)'] },
      ],
      indexes: [],
      foreignKeys: [],
    },
  ],
  summary: { added: 1, removed: 1, modified: 1 },
  hasChanges: true,
};

const mockDiffSchemas = mock(() => structuredClone(mockDiffResult));
const mockGenerateMigrationSQL = mock(() => 'CREATE TABLE new_table (\n  id integer\n);\nDROP TABLE old_table;');

mock.module('@/lib/schema-diff/diff-engine', () => ({
  diffSchemas: mockDiffSchemas,
}));

mock.module('@/lib/schema-diff/migration-generator', () => ({
  generateMigrationSQL: mockGenerateMigrationSQL,
}));

// Mock SnapshotTimeline
mock.module('@/components/SnapshotTimeline', () => ({
  SnapshotTimeline: ({ snapshots }: { snapshots: unknown[] }) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'snapshot-timeline' }, `${snapshots.length} snapshots`);
  },
}));

// Mock storage
const mockSnapshots = [
  {
    id: 'snap-1',
    connectionId: 'c1',
    connectionName: 'TestDB',
    databaseType: 'postgres',
    schema: [
      {
        name: 'old_table',
        columns: [{ name: 'name', type: 'varchar', nullable: true, isPrimary: false }],
        indexes: [],
        foreignKeys: [],
      },
      {
        name: 'users',
        columns: [{ name: 'email', type: 'varchar(100)', nullable: true, isPrimary: false }],
        indexes: [],
        foreignKeys: [],
      },
    ],
    createdAt: new Date('2026-01-10T10:00:00Z'),
    label: 'Before migration',
  },
];

mock.module('@/lib/storage', () => ({
  storage: {
    getSchemaSnapshots: mock(() => [...mockSnapshots]),
    saveSchemaSnapshot: mock(() => {}),
    deleteSchemaSnapshot: mock(() => {}),
    getConnections: mock(() => []),
  },
}));

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, fireEvent, within, cleanup } from '@testing-library/react';
import React from 'react';

import { SchemaDiff } from '@/components/SchemaDiff';
import { mockSchema } from '../fixtures/schemas';
import { mockPostgresConnection } from '../fixtures/connections';

// =============================================================================
// SchemaDiff Tests
// =============================================================================

function createDefaultProps(overrides: Partial<Parameters<typeof SchemaDiff>[0]> = {}) {
  return {
    schema: mockSchema,
    connection: mockPostgresConnection,
    ...overrides,
  };
}

describe('SchemaDiff', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockDiffSchemas.mockClear();
    mockGenerateMigrationSQL.mockClear();
    mockDiffSchemas.mockImplementation(() => structuredClone(mockDiffResult));
    mockGenerateMigrationSQL.mockImplementation(() => 'CREATE TABLE new_table (\n  id integer\n);\nDROP TABLE old_table;');
  });

  // ── Renders diff header ───────────────────────────────────────────────────

  test('renders diff title/header', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiff {...props} />);
    const view = within(container);

    expect(view.queryByText('Schema Diff')).not.toBeNull();
  });

  // ── Snapshot selector renders ─────────────────────────────────────────────

  test('snapshot selector renders', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiff {...props} />);
    const view = within(container);

    expect(view.queryByText('Source')).not.toBeNull();
    expect(view.queryByText('Target')).not.toBeNull();
  });

  // ── Snapshot button renders ───────────────────────────────────────────────

  test('snapshot button renders', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiff {...props} />);
    const view = within(container);

    expect(view.queryByText('Snapshot')).not.toBeNull();
  });

  // ── Empty state when no target selected ───────────────────────────────────

  test('shows instruction when no target is selected', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiff {...props} />);
    const view = within(container);

    expect(view.queryByText('Select source and target to compare schemas')).not.toBeNull();
    expect(view.queryByText('Take a snapshot first, then compare with the current schema')).not.toBeNull();
  });

  // ── Shows snapshot timeline when snapshots exist ──────────────────────────

  test('shows snapshot timeline when snapshots exist', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiff {...props} />);

    expect(container.querySelector('[data-testid="snapshot-timeline"]')).not.toBeNull();
    const view = within(container);
    expect(view.queryByText('1 snapshots')).not.toBeNull();
  });

  // ── vs separator visible ──────────────────────────────────────────────────

  test('vs separator visible between source and target', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiff {...props} />);
    const view = within(container);

    expect(view.queryByText('vs')).not.toBeNull();
  });

  // ── No connection disables snapshot ───────────────────────────────────────

  test('snapshot button is disabled when no connection', () => {
    const props = createDefaultProps({ connection: null });
    const { container } = render(<SchemaDiff {...props} />);

    const snapshotButton = Array.from(container.querySelectorAll('button')).find(
      btn => btn.textContent?.includes('Snapshot')
    );
    expect(snapshotButton).not.toBeNull();
    expect(snapshotButton!.getAttribute('disabled')).not.toBeNull();
  });

  // ── Snapshot button opens label input ─────────────────────────────────────

  test('snapshot button opens label input on click', () => {
    const props = createDefaultProps();
    const { container } = render(<SchemaDiff {...props} />);
    const view = within(container);

    const snapshotButton = Array.from(container.querySelectorAll('button')).find(
      btn => btn.textContent?.includes('Snapshot')
    );
    expect(snapshotButton).not.toBeNull();
    fireEvent.click(snapshotButton!);

    // After clicking, the label input and Save/Cancel buttons should appear
    expect(view.queryByPlaceholderText('Label (optional)...')).not.toBeNull();
    expect(view.queryByText('Save')).not.toBeNull();
    expect(view.queryByText('Cancel')).not.toBeNull();
  });
});
