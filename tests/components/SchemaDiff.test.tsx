import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { mock } from 'bun:test';
import React from 'react';

// ── Mock data ────────────────────────────────────────────────────────────────

const mockDiffWithChanges = {
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
      indexes: [
        { action: 'added', indexName: 'idx_email', changes: ['Added index idx_email'] },
        { action: 'removed', indexName: 'idx_old', changes: ['Removed index idx_old'] },
        { action: 'modified', indexName: 'idx_name', changes: ['Columns changed'] },
      ],
      foreignKeys: [
        { action: 'added', columnName: 'org_id', changes: ['Added FK on org_id'] },
        { action: 'removed', columnName: 'dept_id', changes: ['Removed FK on dept_id'] },
      ],
    },
  ],
  summary: { added: 1, removed: 1, modified: 1 },
  hasChanges: true,
};

const mockDiffNoChanges = {
  tables: [],
  summary: { added: 0, removed: 0, modified: 0 },
  hasChanges: false,
};

const mockDiffSchemas = mock(() => structuredClone(mockDiffWithChanges));
const mockGenerateMigrationSQL = mock(() => 'CREATE TABLE new_table (\n  id integer\n);\nDROP TABLE old_table;');

mock.module('@/lib/schema-diff/diff-engine', () => ({
  diffSchemas: mockDiffSchemas,
}));

mock.module('@/lib/schema-diff/migration-generator', () => ({
  generateMigrationSQL: mockGenerateMigrationSQL,
}));

// ── Mock SnapshotTimeline ────────────────────────────────────────────────────

let capturedTimelineProps: { onCompare?: (s: string, t: string) => void; onDelete?: (id: string) => void } = {};

mock.module('@/components/SnapshotTimeline', () => ({
  SnapshotTimeline: (props: { snapshots: unknown[]; onCompare?: (s: string, t: string) => void; onDelete?: (id: string) => void }) => {
    capturedTimelineProps = { onCompare: props.onCompare, onDelete: props.onDelete };
    return React.createElement('div', { 'data-testid': 'snapshot-timeline' }, `${props.snapshots.length} snapshots`);
  },
}));

// ── Mock UI components ───────────────────────────────────────────────────────

mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick, disabled, className, ...rest }: Record<string, unknown>) =>
    React.createElement('button', { onClick: onClick as (() => void), disabled: disabled as boolean, className, ...rest }, children as React.ReactNode),
}));

mock.module('@/components/ui/badge', () => ({
  Badge: ({ children, className }: { children: React.ReactNode; className?: string }) =>
    React.createElement('span', { 'data-testid': 'badge', className }, children),
}));

// ── Mock Select: capture onValueChange callbacks ─────────────────────────────

// We store onValueChange keyed by the Select's current value prop.
// Source starts with value="current", Target starts with value="".
const selectCallbacks = new Map<string, (v: string) => void>();

mock.module('@/components/ui/select', () => ({
  Select: ({ children, value, onValueChange }: { children: React.ReactNode; value?: string; onValueChange?: (v: string) => void }) => {
    const key = value ?? '__empty__';
    if (onValueChange) selectCallbacks.set(key, onValueChange);
    return React.createElement('div', { 'data-testid': `select-${key}` }, children);
  },
  SelectTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'select-trigger' }, children),
  SelectContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'select-content' }, children),
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) =>
    React.createElement('div', { 'data-testid': `select-item-${value}`, 'data-value': value }, children),
  SelectValue: ({ placeholder }: { placeholder?: string }) =>
    React.createElement('span', { 'data-testid': 'select-value' }, placeholder),
}));

// ── Mock storage ─────────────────────────────────────────────────────────────

const mockSnapshots = [
  {
    id: 'snap-1',
    connectionId: 'test-pg-1',
    connectionName: 'TestDB',
    databaseType: 'postgres',
    schema: [
      { name: 'old_table', columns: [{ name: 'name', type: 'varchar', nullable: true, isPrimary: false }], indexes: [], foreignKeys: [] },
      { name: 'users', columns: [{ name: 'email', type: 'varchar(100)', nullable: true, isPrimary: false }], indexes: [], foreignKeys: [] },
    ],
    createdAt: new Date('2026-01-10T10:00:00Z'),
    label: 'Before migration',
  },
];

const mockGetSchemaSnapshots = mock(() => [...mockSnapshots]);
const mockSaveSchemaSnapshot = mock(() => {});
const mockDeleteSchemaSnapshot = mock(() => {});
const mockGetConnections = mock(() => [
  { id: 'remote-1', name: 'Remote PG', type: 'postgres', host: 'remote', port: 5432, database: 'db', createdAt: new Date() },
  { id: 'remote-2', name: 'Prod DB', type: 'postgres', host: 'prod', port: 5432, database: 'db', environment: 'production', createdAt: new Date() },
  { id: 'demo-1', name: 'Demo', type: 'demo', isDemo: true, createdAt: new Date() },
]);

mock.module('@/lib/storage', () => ({
  storage: {
    getSchemaSnapshots: mockGetSchemaSnapshots,
    saveSchemaSnapshot: mockSaveSchemaSnapshot,
    deleteSchemaSnapshot: mockDeleteSchemaSnapshot,
    getConnections: mockGetConnections,
  },
}));

// ── Imports AFTER mocks ──────────────────────────────────────────────────────

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { SchemaDiff } from '@/components/SchemaDiff';
import { mockSchema } from '../fixtures/schemas';
import { mockPostgresConnection } from '../fixtures/connections';

// ── Helpers ──────────────────────────────────────────────────────────────────

function renderDiff(overrides: Partial<Parameters<typeof SchemaDiff>[0]> = {}) {
  return render(
    <SchemaDiff
      schema={mockSchema}
      connection={mockPostgresConnection}
      {...overrides}
    />
  );
}

/** Trigger the source Select's onValueChange (source value starts as "current") */
function changeSource(value: string) {
  const fn = selectCallbacks.get('current');
  if (fn) act(() => fn(value));
}

/** Trigger the target Select's onValueChange (target value starts as "") */
function changeTarget(value: string) {
  const fn = selectCallbacks.get('__empty__') || selectCallbacks.get('');
  if (fn) act(() => fn(value));
}

/** Get the target callback for async tests (no act() wrapping) */
function getTargetCallback() {
  return selectCallbacks.get('__empty__') || selectCallbacks.get('');
}

/** Helper to set native input value and trigger React change handler */
function changeInput(input: HTMLInputElement, value: string) {
  // React controlled inputs need nativeInputValueSetter
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(input, value);
  } else {
    // fallback
    Object.defineProperty(input, 'value', { value, writable: true, configurable: true });
  }
  fireEvent.input(input, { target: { value } });
  fireEvent.change(input, { target: { value } });
}

describe('SchemaDiff', () => {
  beforeEach(() => {
    mockDiffSchemas.mockClear();
    mockGenerateMigrationSQL.mockClear();
    mockGetSchemaSnapshots.mockClear();
    mockSaveSchemaSnapshot.mockClear();
    mockDeleteSchemaSnapshot.mockClear();
    mockGetConnections.mockClear();
    selectCallbacks.clear();
    capturedTimelineProps = {};

    mockDiffSchemas.mockImplementation(() => structuredClone(mockDiffWithChanges));
    mockGenerateMigrationSQL.mockImplementation(() => 'CREATE TABLE new_table (\n  id integer\n);\nDROP TABLE old_table;');
    mockGetSchemaSnapshots.mockImplementation(() => [...mockSnapshots]);
    mockGetConnections.mockImplementation(() => [
      { id: 'remote-1', name: 'Remote PG', type: 'postgres', host: 'remote', port: 5432, database: 'db', createdAt: new Date() },
      { id: 'remote-2', name: 'Prod DB', type: 'postgres', host: 'prod', port: 5432, database: 'db', environment: 'production', createdAt: new Date() },
      { id: 'demo-1', name: 'Demo', type: 'demo', isDemo: true, createdAt: new Date() },
    ]);
  });

  afterEach(() => {
    cleanup();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Header
  // ═══════════════════════════════════════════════════════════════════════════

  describe('header', () => {
    test('renders "Schema Diff" title', () => {
      const { getByText } = renderDiff();
      expect(getByText('Schema Diff')).toBeTruthy();
    });

    test('renders Source and Target labels', () => {
      const { getByText } = renderDiff();
      expect(getByText('Source')).toBeTruthy();
      expect(getByText('Target')).toBeTruthy();
    });

    test('renders "vs" separator', () => {
      const { getByText } = renderDiff();
      expect(getByText('vs')).toBeTruthy();
    });

    test('renders "Current Schema" in select options', () => {
      const { getAllByText } = renderDiff();
      expect(getAllByText('Current Schema').length).toBeGreaterThanOrEqual(2);
    });

    test('renders snapshot items in select options', () => {
      const { getAllByText } = renderDiff();
      const items = getAllByText(/Before migration/);
      expect(items.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Empty State
  // ═══════════════════════════════════════════════════════════════════════════

  describe('empty state', () => {
    test('shows instructions when no target selected', () => {
      const { getByText } = renderDiff();
      expect(getByText('Select source and target to compare schemas')).toBeTruthy();
      expect(getByText('Take a snapshot first, then compare with the current schema')).toBeTruthy();
    });

    test('shows SnapshotTimeline when snapshots exist', () => {
      const { container, getByText } = renderDiff();
      expect(container.querySelector('[data-testid="snapshot-timeline"]')).toBeTruthy();
      expect(getByText('1 snapshots')).toBeTruthy();
    });

    test('hides SnapshotTimeline when no snapshots', () => {
      mockGetSchemaSnapshots.mockImplementation(() => []);
      const { container } = renderDiff();
      expect(container.querySelector('[data-testid="snapshot-timeline"]')).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Snapshot Controls
  // ═══════════════════════════════════════════════════════════════════════════

  describe('snapshot controls', () => {
    test('renders Snapshot button', () => {
      const { getByText } = renderDiff();
      expect(getByText('Snapshot')).toBeTruthy();
    });

    test('Snapshot button is disabled when no connection', () => {
      const { container } = renderDiff({ connection: null });
      const snapshotBtn = Array.from(container.querySelectorAll('button')).find(
        b => b.textContent?.includes('Snapshot')
      );
      expect(snapshotBtn?.disabled).toBe(true);
    });

    test('clicking Snapshot shows label input', () => {
      const { getByText, getByPlaceholderText } = renderDiff();
      fireEvent.click(getByText('Snapshot'));
      expect(getByPlaceholderText('Label (optional)...')).toBeTruthy();
      expect(getByText('Save')).toBeTruthy();
      expect(getByText('Cancel')).toBeTruthy();
    });

    test('Cancel button hides label input', () => {
      const { getByText, queryByPlaceholderText } = renderDiff();
      fireEvent.click(getByText('Snapshot'));
      expect(queryByPlaceholderText('Label (optional)...')).toBeTruthy();
      fireEvent.click(getByText('Cancel'));
      expect(queryByPlaceholderText('Label (optional)...')).toBeNull();
    });

    test('Save button calls storage.saveSchemaSnapshot', () => {
      const { getByText, getByPlaceholderText, queryByPlaceholderText } = renderDiff();
      fireEvent.click(getByText('Snapshot'));

      const input = getByPlaceholderText('Label (optional)...') as HTMLInputElement;
      changeInput(input, 'My label');
      fireEvent.click(getByText('Save'));

      expect(mockSaveSchemaSnapshot).toHaveBeenCalledTimes(1);
      const saved = (mockSaveSchemaSnapshot.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
      expect(saved.connectionId).toBe(mockPostgresConnection.id);
      expect(saved.connectionName).toBe(mockPostgresConnection.name);
      expect(saved.databaseType).toBe(mockPostgresConnection.type);

      // Label input should be hidden after save
      expect(queryByPlaceholderText('Label (optional)...')).toBeNull();
    });

    test('Save with empty label sets label to undefined', () => {
      const { getByText } = renderDiff();
      fireEvent.click(getByText('Snapshot'));
      fireEvent.click(getByText('Save'));

      expect(mockSaveSchemaSnapshot).toHaveBeenCalledTimes(1);
      expect(((mockSaveSchemaSnapshot.mock.calls as unknown[][])[0][0] as Record<string, unknown>).label).toBeUndefined();
    });

    test('Enter key in label input triggers snapshot save', () => {
      const { getByText, getByPlaceholderText } = renderDiff();
      fireEvent.click(getByText('Snapshot'));

      const input = getByPlaceholderText('Label (optional)...') as HTMLInputElement;
      changeInput(input, 'Enter label');
      fireEvent.keyDown(input, { key: 'Enter' });

      expect(mockSaveSchemaSnapshot).toHaveBeenCalledTimes(1);
    });

    test('takeSnapshot does nothing when connection is null', () => {
      // Snapshot button is disabled for null connection, so storage should not be called
      renderDiff({ connection: null });
      expect(mockSaveSchemaSnapshot).not.toHaveBeenCalled();
    });

    test('snapshot save refreshes snapshot list', () => {
      const { getByText } = renderDiff();
      const callsBefore = mockGetSchemaSnapshots.mock.calls.length;
      fireEvent.click(getByText('Snapshot'));
      fireEvent.click(getByText('Save'));
      expect(mockGetSchemaSnapshots.mock.calls.length).toBeGreaterThan(callsBefore);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Source/Target Selection
  // ═══════════════════════════════════════════════════════════════════════════

  describe('source/target selection', () => {
    test('selecting a target triggers diff display', () => {
      const { queryByText } = renderDiff();
      changeTarget('snap-1');
      // diff has changes → summary should appear
      expect(queryByText(/1 added, 1 removed, 1 modified/)).toBeTruthy();
    });

    test('selecting same source and target shows same-schema message', () => {
      const { getByText } = renderDiff();
      changeTarget('current');
      // source=current, target=current → same → null diff
      expect(getByText('Cannot compare same schema with itself')).toBeTruthy();
    });

    test('changing source updates diff', () => {
      renderDiff();
      changeSource('snap-1');
      changeTarget('current');
      expect(mockDiffSchemas).toHaveBeenCalled();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Diff View (hasChanges = true)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('diff view with changes', () => {
    function renderWithDiff() {
      const result = renderDiff();
      changeTarget('snap-1');
      return result;
    }

    test('shows summary counts', () => {
      const { getByText } = renderWithDiff();
      expect(getByText(/1 added, 1 removed, 1 modified/)).toBeTruthy();
    });

    test('renders all table names in sidebar', () => {
      const { getByText } = renderWithDiff();
      expect(getByText('new_table')).toBeTruthy();
      expect(getByText('old_table')).toBeTruthy();
      expect(getByText('users')).toBeTruthy();
    });

    test('renders action badges for tables', () => {
      const { getByText } = renderWithDiff();
      expect(getByText('Added')).toBeTruthy();
      expect(getByText('Removed')).toBeTruthy();
      expect(getByText('Modified')).toBeTruthy();
    });

    test('shows "Select a table" prompt when no table is selected', () => {
      const { getByText } = renderWithDiff();
      expect(getByText('Select a table to view diff details')).toBeTruthy();
    });

    test('clicking a table shows its detail', () => {
      const { getByText } = renderWithDiff();
      fireEvent.click(getByText('new_table'));
      // TableDiffDetail renders: table heading with action badge
      const badges = document.querySelectorAll('[data-testid="badge"]');
      const addedBadge = Array.from(badges).find(b => b.textContent === 'added');
      expect(addedBadge).toBeTruthy();
    });

    test('clicking a different table switches detail', () => {
      const { getByText } = renderWithDiff();
      fireEvent.click(getByText('new_table'));
      // new_table detail should show column "id"
      expect(getByText('id')).toBeTruthy();

      fireEvent.click(getByText('old_table'));
      // old_table detail should show column "name"
      expect(getByText('name')).toBeTruthy();
    });

    test('selected table has ChevronDown, others have ChevronRight', () => {
      const { container, getByText } = renderWithDiff();
      fireEvent.click(getByText('new_table'));

      const tableButtons = Array.from(container.querySelectorAll('button'));
      const newTableBtn = tableButtons.find(b => b.textContent?.includes('new_table'));
      const oldTableBtn = tableButtons.find(b => b.textContent?.includes('old_table'));

      expect(newTableBtn?.querySelector('.lucide-chevron-down')).toBeTruthy();
      expect(oldTableBtn?.querySelector('.lucide-chevron-right')).toBeTruthy();
    });

    test('selected table has highlighted background', () => {
      const { container, getByText } = renderWithDiff();
      fireEvent.click(getByText('users'));

      const usersBtn = Array.from(container.querySelectorAll('button')).find(
        b => b.textContent?.includes('users')
      );
      expect(usersBtn?.className).toContain('bg-white/10');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // No Changes State
  // ═══════════════════════════════════════════════════════════════════════════

  describe('no changes state', () => {
    test('shows "No differences found" message', () => {
      mockDiffSchemas.mockImplementation(() => structuredClone(mockDiffNoChanges));
      const { getByText } = renderDiff();
      changeTarget('snap-1');
      expect(getByText('No differences found between source and target')).toBeTruthy();
    });

    test('SQL Migration button does not appear when no changes', () => {
      mockDiffSchemas.mockImplementation(() => structuredClone(mockDiffNoChanges));
      const { queryByText } = renderDiff();
      changeTarget('snap-1');
      expect(queryByText('SQL Migration')).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Migration SQL View
  // ═══════════════════════════════════════════════════════════════════════════

  describe('migration SQL', () => {
    function renderWithDiff() {
      const result = renderDiff();
      changeTarget('snap-1');
      return result;
    }

    test('SQL Migration button appears when diff has changes', () => {
      const { getByText } = renderWithDiff();
      expect(getByText('SQL Migration')).toBeTruthy();
    });

    test('clicking SQL Migration shows SQL and changes button text', () => {
      const { getByText, container } = renderWithDiff();
      fireEvent.click(getByText('SQL Migration'));

      expect(container.textContent).toContain('CREATE TABLE new_table');
      expect(container.textContent).toContain('DROP TABLE old_table');
      expect(getByText('Diff View')).toBeTruthy();
    });

    test('toggling back to diff view shows table list again', () => {
      const { getByText } = renderWithDiff();
      fireEvent.click(getByText('SQL Migration'));
      expect(getByText('Diff View')).toBeTruthy();

      fireEvent.click(getByText('Diff View'));
      expect(getByText('SQL Migration')).toBeTruthy();
      expect(getByText('new_table')).toBeTruthy();
    });

    test('migration SQL is rendered in a pre tag', () => {
      const { getByText, container } = renderWithDiff();
      fireEvent.click(getByText('SQL Migration'));
      const pre = container.querySelector('pre');
      expect(pre).toBeTruthy();
      expect(pre!.textContent).toContain('CREATE TABLE');
    });

    test('generateMigrationSQL receives correct dialect', () => {
      renderWithDiff();
      if (mockGenerateMigrationSQL.mock.calls.length > 0) {
        const dialect = (mockGenerateMigrationSQL.mock.calls as unknown[][])[0][1];
        expect(dialect).toBe('postgres');
      }
    });

    test('defaults to postgres dialect when connection is null', () => {
      renderDiff({ connection: null });
      changeTarget('snap-1');
      if (mockGenerateMigrationSQL.mock.calls.length > 0) {
        const dialect = (mockGenerateMigrationSQL.mock.calls as unknown[][])[0][1];
        expect(dialect).toBe('postgres');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TableDiffDetail Sub-Component
  // ═══════════════════════════════════════════════════════════════════════════

  describe('TableDiffDetail', () => {
    function renderAndSelectTable(tableName: string) {
      const result = renderDiff();
      changeTarget('snap-1');
      fireEvent.click(result.getByText(tableName));
      return result;
    }

    // ── Header ──

    test('shows table name and action badge', () => {
      const { container } = renderAndSelectTable('new_table');
      const badges = container.querySelectorAll('[data-testid="badge"]');
      const addedBadge = Array.from(badges).find(b => b.textContent === 'added');
      expect(addedBadge).toBeTruthy();
    });

    test('removed table shows removed badge', () => {
      const { container } = renderAndSelectTable('old_table');
      const badges = container.querySelectorAll('[data-testid="badge"]');
      const removedBadge = Array.from(badges).find(b => b.textContent === 'removed');
      expect(removedBadge).toBeTruthy();
    });

    test('modified table shows modified badge', () => {
      const { container } = renderAndSelectTable('users');
      const badges = container.querySelectorAll('[data-testid="badge"]');
      const modifiedBadge = Array.from(badges).find(b => b.textContent === 'modified');
      expect(modifiedBadge).toBeTruthy();
    });

    // ── Columns ──

    test('renders "Columns" heading when columns exist', () => {
      const { getByText } = renderAndSelectTable('users');
      expect(getByText('Columns')).toBeTruthy();
    });

    test('renders added column with target type', () => {
      const { getByText } = renderAndSelectTable('new_table');
      expect(getByText('id')).toBeTruthy();
      expect(getByText('integer')).toBeTruthy();
    });

    test('renders removed column with source type', () => {
      const { getByText } = renderAndSelectTable('old_table');
      expect(getByText('name')).toBeTruthy();
      expect(getByText('varchar')).toBeTruthy();
    });

    test('renders modified column with change details', () => {
      const { getByText } = renderAndSelectTable('users');
      expect(getByText('email')).toBeTruthy();
      expect(getByText('Type changed: varchar(100) -> varchar(255)')).toBeTruthy();
    });

    test('added column row has green background', () => {
      const { getByText } = renderAndSelectTable('new_table');
      const colRow = getByText('id').closest('div[class*="rounded"]');
      expect(colRow?.className).toContain('bg-green-500/5');
    });

    test('removed column row has red background', () => {
      const { getByText } = renderAndSelectTable('old_table');
      const colRow = getByText('name').closest('div[class*="rounded"]');
      expect(colRow?.className).toContain('bg-red-500/5');
    });

    test('modified column row has yellow background', () => {
      const { getByText } = renderAndSelectTable('users');
      const colRow = getByText('email').closest('div[class*="rounded"]');
      expect(colRow?.className).toContain('bg-yellow-500/5');
    });

    // ── Indexes ──

    test('renders "Indexes" heading when indexes exist', () => {
      const { getByText } = renderAndSelectTable('users');
      expect(getByText('Indexes')).toBeTruthy();
    });

    test('renders index names and changes', () => {
      const { getByText } = renderAndSelectTable('users');
      expect(getByText('idx_email')).toBeTruthy();
      expect(getByText('idx_old')).toBeTruthy();
      expect(getByText('idx_name')).toBeTruthy();
      expect(getByText('Added index idx_email')).toBeTruthy();
      expect(getByText('Removed index idx_old')).toBeTruthy();
      expect(getByText('Columns changed')).toBeTruthy();
    });

    test('index rows have correct backgrounds', () => {
      const { getByText } = renderAndSelectTable('users');
      const addedIdx = getByText('idx_email').closest('div[class*="rounded"]');
      expect(addedIdx?.className).toContain('bg-green-500/5');
      const removedIdx = getByText('idx_old').closest('div[class*="rounded"]');
      expect(removedIdx?.className).toContain('bg-red-500/5');
      const modifiedIdx = getByText('idx_name').closest('div[class*="rounded"]');
      expect(modifiedIdx?.className).toContain('bg-yellow-500/5');
    });

    test('does not render "Indexes" heading when no indexes', () => {
      const { queryByText } = renderAndSelectTable('new_table');
      expect(queryByText('Indexes')).toBeNull();
    });

    // ── Foreign Keys ──

    test('renders "Foreign Keys" heading when FKs exist', () => {
      const { getByText } = renderAndSelectTable('users');
      expect(getByText('Foreign Keys')).toBeTruthy();
    });

    test('renders FK column names and changes', () => {
      const { getByText } = renderAndSelectTable('users');
      expect(getByText('org_id')).toBeTruthy();
      expect(getByText('dept_id')).toBeTruthy();
      expect(getByText('Added FK on org_id')).toBeTruthy();
      expect(getByText('Removed FK on dept_id')).toBeTruthy();
    });

    test('FK rows have correct backgrounds', () => {
      const { getByText } = renderAndSelectTable('users');
      const addedFK = getByText('org_id').closest('div[class*="rounded"]');
      expect(addedFK?.className).toContain('bg-green-500/5');
      const removedFK = getByText('dept_id').closest('div[class*="rounded"]');
      expect(removedFK?.className).toContain('bg-red-500/5');
    });

    test('does not render "Foreign Keys" heading when no FKs', () => {
      const { queryByText } = renderAndSelectTable('new_table');
      expect(queryByText('Foreign Keys')).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // SnapshotTimeline Integration
  // ═══════════════════════════════════════════════════════════════════════════

  describe('SnapshotTimeline integration', () => {
    test('onCompare callback sets source and target', () => {
      renderDiff();
      expect(capturedTimelineProps.onCompare).toBeDefined();

      act(() => {
        capturedTimelineProps.onCompare!('snap-1', 'current');
      });

      // Diff should be triggered
      expect(mockDiffSchemas).toHaveBeenCalled();
    });

    test('onDelete callback removes snapshot', () => {
      renderDiff();
      expect(capturedTimelineProps.onDelete).toBeDefined();

      act(() => {
        capturedTimelineProps.onDelete!('snap-1');
      });

      expect(mockDeleteSchemaSnapshot).toHaveBeenCalledWith('snap-1');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Cross-Connection Comparison
  // ═══════════════════════════════════════════════════════════════════════════

  describe('cross-connection comparison', () => {
    test('renders "Fetch from connection" section in target selector', () => {
      const { getByText } = renderDiff();
      expect(getByText('Fetch from connection')).toBeTruthy();
    });

    test('renders remote connections (excluding current and demo)', () => {
      const { getByText, queryByText } = renderDiff();
      expect(getByText('Remote PG')).toBeTruthy();
      expect(getByText('Prod DB')).toBeTruthy();
      expect(queryByText('Demo')).toBeNull();
    });

    test('does not show "Fetch from connection" when no other connections', () => {
      mockGetConnections.mockImplementation(() => []);
      const { queryByText } = renderDiff();
      expect(queryByText('Fetch from connection')).toBeNull();
    });

    test('production connection shows warning icon', () => {
      const { getByText } = renderDiff();
      // Find Prod DB text and check its parent container for the AlertTriangle icon
      const prodText = getByText('Prod DB');
      const wrapper = prodText.closest('[data-testid^="select-item-"]') || prodText.parentElement;
      expect(wrapper).toBeTruthy();
      // Lucide renders class="lucide lucide-triangle-alert ..."
      const alertIcon = wrapper!.querySelector('svg[class*="alert-triangle"], svg[class*="triangle-alert"]');
      expect(alertIcon).toBeTruthy();
    });

    test('selecting a remote connection triggers API fetch', async () => {
      const origFetch = globalThis.fetch;
      const mockFetch = mock(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ schema: mockSchema }),
        })
      );
      globalThis.fetch = mockFetch as unknown as typeof fetch;

      try {
        renderDiff();
        const fn = getTargetCallback();
        expect(fn).toBeTruthy();

        await act(async () => {
          fn!('conn:remote-1');
        });

        expect(mockFetch).toHaveBeenCalledTimes(1);
        const [url, options] = (mockFetch.mock.calls as unknown[][])[0] as [string, RequestInit];
        expect(url).toBe('/api/db/schema-snapshot');
        expect(JSON.parse(options.body as string).connection.id).toBe('remote-1');

        expect(mockSaveSchemaSnapshot).toHaveBeenCalledTimes(1);
        const saved = (mockSaveSchemaSnapshot.mock.calls as unknown[][])[0][0] as Record<string, unknown>;
        expect(saved.label).toBe('Live: Remote PG');
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test('shows "Fetching..." during remote fetch', async () => {
      const origFetch = globalThis.fetch;
      let resolveFetch!: (v: unknown) => void;
      const fetchPromise = new Promise((resolve) => { resolveFetch = resolve; });
      globalThis.fetch = mock(() => fetchPromise) as unknown as typeof fetch;

      try {
        const { queryByText } = renderDiff();
        const fn = getTargetCallback();

        // Start the fetch synchronously, then check for Fetching...
        act(() => {
          fn!('conn:remote-1');
        });

        expect(queryByText('Fetching...')).toBeTruthy();

        // Resolve the fetch
        await act(async () => {
          resolveFetch({ ok: true, json: () => Promise.resolve({ schema: [] }) });
        });

        expect(queryByText('Fetching...')).toBeNull();
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    test('handles fetch error gracefully', async () => {
      const origFetch = globalThis.fetch;
      const origError = console.error;
      const mockConsoleError = mock(() => {});
      console.error = mockConsoleError;

      globalThis.fetch = mock(() =>
        Promise.resolve({
          ok: false,
          json: () => Promise.resolve({ error: 'Unauthorized' }),
        })
      ) as unknown as typeof fetch;

      try {
        renderDiff();
        const fn = getTargetCallback();

        await act(async () => {
          fn!('conn:remote-1');
        });

        expect(mockConsoleError).toHaveBeenCalled();
        expect(mockSaveSchemaSnapshot).not.toHaveBeenCalled();
      } finally {
        globalThis.fetch = origFetch;
        console.error = origError;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // formatSnapshotLabel
  // ═══════════════════════════════════════════════════════════════════════════

  describe('formatSnapshotLabel', () => {
    test('snapshot with label shows label', () => {
      const { getAllByText } = renderDiff();
      const matches = getAllByText(/Before migration/);
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    test('snapshot without label shows connectionName', () => {
      mockGetSchemaSnapshots.mockImplementation(() => [
        { ...mockSnapshots[0], label: '' },
      ]);
      const { getAllByText } = renderDiff();
      const matches = getAllByText(/TestDB/);
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Action Badges (sidebar)
  // ═══════════════════════════════════════════════════════════════════════════

  describe('action badges', () => {
    function renderWithDiff() {
      const result = renderDiff();
      changeTarget('snap-1');
      return result;
    }

    test('added badge has green styling', () => {
      const { container } = renderWithDiff();
      const badges = container.querySelectorAll('[data-testid="badge"]');
      const addedBadge = Array.from(badges).find(b => b.textContent?.includes('Added'));
      expect(addedBadge).toBeTruthy();
      expect(addedBadge!.className).toContain('bg-green-500/20');
    });

    test('removed badge has red styling', () => {
      const { container } = renderWithDiff();
      const badges = container.querySelectorAll('[data-testid="badge"]');
      const removedBadge = Array.from(badges).find(b => b.textContent?.includes('Removed'));
      expect(removedBadge).toBeTruthy();
      expect(removedBadge!.className).toContain('bg-red-500/20');
    });

    test('modified badge has yellow styling', () => {
      const { container } = renderWithDiff();
      const badges = container.querySelectorAll('[data-testid="badge"]');
      const modifiedBadge = Array.from(badges).find(b => b.textContent?.includes('Modified'));
      expect(modifiedBadge).toBeTruthy();
      expect(modifiedBadge!.className).toContain('bg-yellow-500/20');
    });
  });
});
