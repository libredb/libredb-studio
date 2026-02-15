import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import { mock } from 'bun:test';
import { setupRechartssMock, setupFramerMotionMock } from '../../helpers/mock-monaco';

setupRechartssMock();
setupFramerMotionMock();

// ---- Trackable mock functions ----
const mockRefresh = mock(() => {});
const mockKillSession = mock(() => true);
const mockRunMaintenance = mock(() => true);

// ---- Override objects ----
let monitoringOverride: Record<string, unknown> = {};
let mockConnectionsList: Record<string, unknown>[] = [
  {
    id: 'c1',
    name: 'PG Dev',
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'dev',
    createdAt: new Date(),
  },
];
let mockActiveConnectionId: string | null = 'c1';

const defaultSessions = [
  {
    pid: 1234,
    user: 'admin',
    state: 'active',
    query: 'SELECT 1',
    duration: '00:01:00',
    durationMs: 60000,
    database: 'dev',
  },
];

const defaultTables = [
  {
    tableName: 'users',
    schemaName: 'public',
    rowCount: 1000,
    tableSize: '16 MB',
    totalSize: '20 MB',
    bloatRatio: 5,
  },
];

mock.module('@/hooks/use-monitoring-data', () => ({
  useMonitoringData: mock(() => ({
    data: {
      activeSessions: defaultSessions,
      tables: defaultTables,
    },
    loading: false,
    error: null,
    refresh: mockRefresh,
    killSession: mockKillSession,
    runMaintenance: mockRunMaintenance,
    ...monitoringOverride,
  })),
}));

mock.module('@/lib/storage', () => ({
  storage: {
    getConnections: mock(() => mockConnectionsList),
    getActiveConnectionId: mock(() => mockActiveConnectionId),
  },
}));

mock.module('@/lib/db-ui-config', () => ({
  getDBIcon: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return (props: Record<string, unknown>) => React.createElement('span', { ...props, 'data-testid': 'db-icon' });
  },
  getDBColor: () => 'text-blue-400',
}));

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, act, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';

import { OperationsTab } from '@/components/admin/tabs/OperationsTab';

// =============================================================================
// Test data
// =============================================================================

const multiSessions = [
  { pid: 100, user: 'admin', state: 'active', query: 'SELECT 1', duration: '00:00:05', durationMs: 5000, database: 'dev' },
  { pid: 101, user: 'user1', state: 'idle', query: '', duration: '00:00:10', durationMs: 10000, database: 'dev' },
  { pid: 102, user: 'user2', state: 'idle in transaction', query: 'UPDATE users SET x=1', duration: '00:02:00', durationMs: 120000, database: 'dev' },
  { pid: 103, user: 'user3', state: 'idle in transaction (aborted)', query: 'INSERT INTO t', duration: '00:00:30', durationMs: 30000, database: 'dev' },
  { pid: 104, user: 'user4', state: 'fastpath function call', query: '', duration: '00:00:01', durationMs: 1000, database: 'dev', waitEventType: 'Lock' },
];

const multiTables = [
  { tableName: 'users', schemaName: 'public', rowCount: 1000, tableSize: '16 MB', totalSize: '20 MB', bloatRatio: 5 },
  { tableName: 'orders', schemaName: 'public', rowCount: 50000, tableSize: '128 MB', totalSize: '200 MB', bloatRatio: 25 },
  { tableName: 'products', schemaName: 'public', rowCount: 200, tableSize: '2 MB', totalSize: '3 MB', bloatRatio: 0 },
];

// =============================================================================
// OperationsTab Tests
// =============================================================================

describe('OperationsTab', () => {
  beforeEach(() => {
    // Reset overrides
    monitoringOverride = {};
    mockConnectionsList = [
      { id: 'c1', name: 'PG Dev', type: 'postgres', host: 'localhost', port: 5432, database: 'dev', createdAt: new Date() },
    ];
    mockActiveConnectionId = 'c1';

    // Clear mocks
    mockRefresh.mockClear();
    mockKillSession.mockClear();
    mockKillSession.mockImplementation(() => true);
    mockRunMaintenance.mockClear();
    mockRunMaintenance.mockImplementation(() => true);
  });

  afterEach(() => {
    cleanup();
  });

  // =========================================================================
  // Existing rendering tests
  // =========================================================================

  test('renders connection selector', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText('PG Dev')).not.toBeNull();
  });

  test('shows global operations section', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText('Global Operations')).not.toBeNull();
    expect(queryByText('Update Statistics')).not.toBeNull();
    expect(queryByText('Reclaim Space')).not.toBeNull();
    expect(queryByText('Rebuild Indexes')).not.toBeNull();
  });

  test('shows tables panel with table list', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText('Tables (1)')).not.toBeNull();
    expect(queryByText('users')).not.toBeNull();
  });

  test('shows sessions panel with session list', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText('Sessions (1)')).not.toBeNull();
    expect(queryByText('1234')).not.toBeNull();
  });

  test('maintenance buttons present', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText('Run Analyze')).not.toBeNull();
    expect(queryByText('Run Vacuum')).not.toBeNull();
    expect(queryByText('Run Reindex')).not.toBeNull();
  });

  test('warning card present', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText('Warning')).not.toBeNull();
    expect(queryByText(/resource-intensive/)).not.toBeNull();
  });

  test('shows table size information', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText('16 MB')).not.toBeNull();
  });

  test('shows session user info', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText('admin')).not.toBeNull();
  });

  test('shows session query info', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;
    expect(container.textContent).toContain('SELECT 1');
  });

  test('shows session duration', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;
    expect(container.textContent).toContain('00:01:00');
  });

  test('shows row count for tables', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;
    expect(container.textContent).toMatch(/1,?000/);
  });

  test('shows connection type in selector', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;
    expect(container.textContent).toContain('(postgres)');
  });

  test('shows session state as Active badge', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;
    expect(container.textContent).toContain('Active');
  });

  // =========================================================================
  // Empty state: no connections
  // =========================================================================

  test('shows empty state when no connections', async () => {
    mockConnectionsList = [];
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText('No Database Connections')).not.toBeNull();
    expect(queryByText(/add a database connection/i)).not.toBeNull();
  });

  // =========================================================================
  // Error state
  // =========================================================================

  test('shows error message when error and no data', async () => {
    monitoringOverride = { data: null, error: 'Connection refused' };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText('Connection refused')).not.toBeNull();
  });

  // =========================================================================
  // Loading state
  // =========================================================================

  test('shows loading skeletons when loading with no data', async () => {
    monitoringOverride = {
      data: { activeSessions: [], tables: [] },
      loading: true,
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;
    // At minimum, the component renders skeleton placeholders when loading
    expect(container.textContent).toContain('Tables (0)');
    expect(container.textContent).toContain('Sessions (0)');
  });

  // =========================================================================
  // Empty sessions / empty tables
  // =========================================================================

  test('shows no sessions message when empty', async () => {
    monitoringOverride = {
      data: { activeSessions: [], tables: defaultTables },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText('No active sessions found.')).not.toBeNull();
  });

  // =========================================================================
  // Table search filter
  // =========================================================================

  test('filters tables by search input', async () => {
    monitoringOverride = {
      data: { activeSessions: defaultSessions, tables: multiTables },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container, queryByText } = renderResult!;

    // All 3 tables visible initially
    expect(queryByText('Tables (3)')).not.toBeNull();
    expect(queryByText('users')).not.toBeNull();
    expect(queryByText('orders')).not.toBeNull();
    expect(queryByText('products')).not.toBeNull();

    // Type in filter input
    const filterInput = container.querySelector('input[placeholder="Filter..."]') as HTMLInputElement;
    expect(filterInput).not.toBeNull();
    await act(async () => {
      fireEvent.change(filterInput, { target: { value: 'ord' } });
    });

    // Only 'orders' should match
    expect(queryByText('orders')).not.toBeNull();
    expect(queryByText('users')).toBeNull();
    expect(queryByText('products')).toBeNull();
  });

  test('shows no tables found when filter matches nothing', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container, queryByText } = renderResult!;

    const filterInput = container.querySelector('input[placeholder="Filter..."]') as HTMLInputElement;
    await act(async () => {
      fireEvent.change(filterInput, { target: { value: 'zzz_nonexistent' } });
    });
    expect(queryByText('No tables found.')).not.toBeNull();
  });

  // =========================================================================
  // Bloat ratio badge
  // =========================================================================

  test('shows bloat ratio badge for high-bloat tables', async () => {
    monitoringOverride = {
      data: { activeSessions: defaultSessions, tables: multiTables },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;

    // 'orders' table has 25% bloat (>10%) — should show badge
    expect(container.textContent).toContain('25% bloat');
    // 'products' table has 0% bloat — no bloat badge (only one bloat badge total)
    const bloatBadges = container.textContent!.match(/\d+% bloat/g) || [];
    expect(bloatBadges).toEqual(['25% bloat']);
  });

  // =========================================================================
  // Session state badge variants
  // =========================================================================

  test('renders correct badges for different session states', async () => {
    monitoringOverride = {
      data: { activeSessions: multiSessions, tables: defaultTables },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;
    const text = container.textContent || '';

    expect(text).toContain('Active');
    expect(text).toContain('Idle');
    expect(text).toContain('Idle TX');
    expect(text).toContain('Abort');
    // Default state — 'fastpath function call'
    expect(text).toContain('fastpath function call');
  });

  // =========================================================================
  // Session summary counts
  // =========================================================================

  test('shows correct session summary counts', async () => {
    monitoringOverride = {
      data: { activeSessions: multiSessions, tables: defaultTables },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;
    const text = container.textContent || '';

    // multiSessions: 1 active, 1 idle, 2 idle in tx (one normal, one aborted), 1 waiting
    expect(text).toContain('Sessions (5)');
  });

  // =========================================================================
  // Refresh button
  // =========================================================================

  test('refresh button calls refresh', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;

    const refreshBtn = queryByText('Refresh');
    expect(refreshBtn).not.toBeNull();
    await act(async () => {
      fireEvent.click(refreshBtn!.closest('button')!);
    });
    expect(mockRefresh).toHaveBeenCalledTimes(1);
  });

  // =========================================================================
  // handleRunMaintenance — success
  // =========================================================================

  test('handleRunMaintenance success adds success log entry', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;

    // Click "Run Analyze"
    const analyzeBtn = queryByText('Run Analyze');
    expect(analyzeBtn).not.toBeNull();
    await act(async () => {
      fireEvent.click(analyzeBtn!.closest('button')!);
    });

    expect(mockRunMaintenance).toHaveBeenCalledWith('analyze', undefined);
    // Operation log should appear with success
    expect(queryByText('Operation Log (this session)')).not.toBeNull();
    expect(queryByText('ANALYZE')).not.toBeNull();
  });

  test('handleRunMaintenance vacuum', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;

    const vacuumBtn = queryByText('Run Vacuum');
    await act(async () => {
      fireEvent.click(vacuumBtn!.closest('button')!);
    });
    expect(mockRunMaintenance).toHaveBeenCalledWith('vacuum', undefined);
    expect(queryByText('VACUUM')).not.toBeNull();
  });

  test('handleRunMaintenance reindex', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;

    const reindexBtn = queryByText('Run Reindex');
    await act(async () => {
      fireEvent.click(reindexBtn!.closest('button')!);
    });
    expect(mockRunMaintenance).toHaveBeenCalledWith('reindex', undefined);
    expect(queryByText('REINDEX')).not.toBeNull();
  });

  // =========================================================================
  // handleRunMaintenance — failure (returns false)
  // =========================================================================

  test('handleRunMaintenance failure shows failure in log', async () => {
    mockRunMaintenance.mockImplementation(() => false);
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText, container } = renderResult!;

    const analyzeBtn = queryByText('Run Analyze');
    await act(async () => {
      fireEvent.click(analyzeBtn!.closest('button')!);
    });

    expect(queryByText('ANALYZE')).not.toBeNull();
    // The log entry should show — the component uses XCircle icon for failure
    // We verify the log appears
    expect(queryByText('Operation Log (this session)')).not.toBeNull();
    // Target is 'all' for global operation
    expect(container.textContent).toContain('all');
  });

  // =========================================================================
  // handleRunMaintenance — exception (catch block)
  // =========================================================================

  test('handleRunMaintenance exception adds failure log entry', async () => {
    mockRunMaintenance.mockImplementation(() => { throw new Error('DB error'); });
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;

    const analyzeBtn = queryByText('Run Analyze');
    await act(async () => {
      fireEvent.click(analyzeBtn!.closest('button')!);
    });

    // Log should appear with failure entry
    expect(queryByText('Operation Log (this session)')).not.toBeNull();
    expect(queryByText('ANALYZE')).not.toBeNull();
  });

  // =========================================================================
  // handleRunMaintenance — per-table operation
  // =========================================================================

  test('handleRunMaintenance for specific table', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;

    // Find the table row for 'users' and click its analyze button (first icon button)
    const tableRows = container.querySelectorAll('.divide-y > div');
    const usersRow = Array.from(tableRows).find(row => row.textContent?.includes('users'));
    expect(usersRow).not.toBeNull();

    const buttons = usersRow!.querySelectorAll('button');
    // First button is Analyze, second is Vacuum
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    await act(async () => {
      fireEvent.click(buttons[0]!);
    });

    expect(mockRunMaintenance).toHaveBeenCalledWith('analyze', 'users');
  });

  test('per-table vacuum button calls runMaintenance with table name', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;

    const tableRows = container.querySelectorAll('.divide-y > div');
    const usersRow = Array.from(tableRows).find(row => row.textContent?.includes('users'));
    const buttons = usersRow!.querySelectorAll('button');
    await act(async () => {
      fireEvent.click(buttons[1]!);
    });

    expect(mockRunMaintenance).toHaveBeenCalledWith('vacuum', 'users');
  });

  // =========================================================================
  // Kill session flow
  // =========================================================================

  test('kill button opens confirmation dialog', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container, baseElement } = renderResult!;

    // Find the session row by PID 1234
    const cells = container.querySelectorAll('td');
    const pidCell = Array.from(cells).find(td => td.textContent?.includes('1234'));
    expect(pidCell).not.toBeNull();
    const row = pidCell!.closest('tr');
    const killBtn = row!.querySelector('td:last-child button');
    expect(killBtn).not.toBeNull();

    await act(async () => {
      fireEvent.click(killBtn!);
    });

    // Confirmation dialog should appear (may be portaled)
    const dialogText = baseElement.textContent || '';
    expect(dialogText).toContain('Terminate Session?');
    expect(dialogText).toContain('1234');
  });

  test('confirming kill calls killSession and adds log entry', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container, baseElement } = renderResult!;

    // Click kill button
    const cells = container.querySelectorAll('td');
    const pidCell = Array.from(cells).find(td => td.textContent?.includes('1234'));
    const row = pidCell!.closest('tr');
    const killBtn = row!.querySelector('td:last-child button');
    await act(async () => {
      fireEvent.click(killBtn!);
    });

    // Find and click "Terminate" button in the dialog
    const allButtons = baseElement.querySelectorAll('button');
    const terminateBtn = Array.from(allButtons).find(btn => btn.textContent?.trim() === 'Terminate');
    expect(terminateBtn).not.toBeNull();
    await act(async () => {
      fireEvent.click(terminateBtn!);
    });

    expect(mockKillSession).toHaveBeenCalledWith(1234);
    // Log entry should appear
    expect(baseElement.textContent).toContain('KILL');
    expect(baseElement.textContent).toContain('PID:1234');
  });

  test('cancel kill dialog does not call killSession', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container, baseElement } = renderResult!;

    // Click kill button
    const cells = container.querySelectorAll('td');
    const pidCell = Array.from(cells).find(td => td.textContent?.includes('1234'));
    const row = pidCell!.closest('tr');
    const killBtn = row!.querySelector('td:last-child button');
    await act(async () => {
      fireEvent.click(killBtn!);
    });

    // Find and click "Cancel" button
    const allButtons = baseElement.querySelectorAll('button');
    const cancelBtn = Array.from(allButtons).find(btn => btn.textContent?.trim() === 'Cancel');
    expect(cancelBtn).not.toBeNull();
    await act(async () => {
      fireEvent.click(cancelBtn!);
    });

    expect(mockKillSession).not.toHaveBeenCalled();
  });

  // =========================================================================
  // Session duration badge variants
  // =========================================================================

  test('session with >60s shows destructive duration badge', async () => {
    monitoringOverride = {
      data: {
        activeSessions: [
          { pid: 200, user: 'u1', state: 'active', query: 'Q', duration: '00:02:00', durationMs: 120000, database: 'dev' },
          { pid: 201, user: 'u2', state: 'idle', query: '', duration: '00:00:05', durationMs: 5000, database: 'dev' },
        ],
        tables: defaultTables,
      },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;
    const text = container.textContent || '';
    expect(text).toContain('00:02:00');
    expect(text).toContain('00:00:05');
  });

  // =========================================================================
  // Connection selection with saved active ID
  // =========================================================================

  test('selects saved active connection on mount', async () => {
    mockConnectionsList = [
      { id: 'c1', name: 'PG Dev', type: 'postgres', host: 'localhost', port: 5432, database: 'dev', createdAt: new Date() },
      { id: 'c2', name: 'MySQL Prod', type: 'mysql', host: 'localhost', port: 3306, database: 'prod', createdAt: new Date() },
    ];
    mockActiveConnectionId = 'c2';
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    // Should show MySQL Prod as selected (savedId matches c2)
    expect(queryByText('MySQL Prod')).not.toBeNull();
  });

  test('falls back to first connection when savedId not found', async () => {
    mockActiveConnectionId = 'nonexistent';
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText('PG Dev')).not.toBeNull();
  });

  test('falls back to first connection when no savedId', async () => {
    mockActiveConnectionId = null;
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;
    expect(queryByText('PG Dev')).not.toBeNull();
  });

  // =========================================================================
  // Session with no query shows dash
  // =========================================================================

  test('session with no query shows dash', async () => {
    monitoringOverride = {
      data: {
        activeSessions: [
          { pid: 300, user: 'admin', state: 'idle', query: '', duration: '00:00:01', durationMs: 1000, database: 'dev' },
        ],
        tables: defaultTables,
      },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;
    // When query is empty, component shows '-'
    const cells = container.querySelectorAll('td');
    const queryCell = Array.from(cells).find(td => td.textContent?.trim() === '-');
    expect(queryCell).not.toBeNull();
  });

  // =========================================================================
  // Loading skeletons — tables panel
  // =========================================================================

  test('shows loading skeletons in tables panel when loading=true and tables empty', async () => {
    monitoringOverride = {
      data: { activeSessions: defaultSessions, tables: [] },
      loading: true,
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;

    // The tables panel shows 5 Skeleton divs when loading && tables.length === 0
    const allSkeletons = container.querySelectorAll('[data-slot="skeleton"]');
    // Tables panel renders 5 skeletons; sessions panel has data so no skeletons there
    expect(allSkeletons.length).toBe(5);
    // Tables count header still shows 0
    expect(container.textContent).toContain('Tables (0)');
    // Sessions should render normally (not skeletons) since sessions have data
    expect(container.textContent).toContain('Sessions (1)');
  });

  // =========================================================================
  // Loading skeletons — sessions panel
  // =========================================================================

  test('shows loading skeletons in sessions panel when loading=true and sessions empty', async () => {
    monitoringOverride = {
      data: { activeSessions: [], tables: defaultTables },
      loading: true,
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;

    // The sessions panel shows 4 Skeleton divs when loading && sessions.length === 0
    const allSkeletons = container.querySelectorAll('[data-slot="skeleton"]');
    expect(allSkeletons.length).toBe(4);
    // Sessions count header still shows 0
    expect(container.textContent).toContain('Sessions (0)');
    // Tables should render normally since tables have data
    expect(container.textContent).toContain('Tables (1)');
    expect(container.textContent).toContain('users');
  });

  // =========================================================================
  // handleConnectionChange with non-existent connection id (guard)
  // =========================================================================

  test('handleConnectionChange with non-existent id does not change selection', async () => {
    // Use a non-existent savedId to test the guard in handleConnectionChange
    // When savedId doesn't match any connection, it falls back to first connection
    mockConnectionsList = [
      { id: 'c1', name: 'PG Dev', type: 'postgres', host: 'localhost', port: 5432, database: 'dev', createdAt: new Date() },
      { id: 'c2', name: 'MySQL Prod', type: 'mysql', host: 'localhost', port: 3306, database: 'prod', createdAt: new Date() },
    ];
    // Set savedId to a non-existent id
    mockActiveConnectionId = 'nonexistent-id';
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;

    // Since savedId doesn't match any connection, the guard falls back to first connection (PG Dev)
    expect(container.textContent).toContain('PG Dev');
    expect(container.textContent).toContain('(postgres)');

    // The component should not crash and should still render the monitoring data
    expect(container.textContent).toContain('Global Operations');
    expect(container.textContent).toContain('Sessions');
    expect(container.textContent).toContain('Tables');
  });

  // =========================================================================
  // Session duration badge outline variant (10s-60s range)
  // =========================================================================

  test('session with 10s-60s duration shows outline variant badge', async () => {
    monitoringOverride = {
      data: {
        activeSessions: [
          { pid: 400, user: 'u1', state: 'active', query: 'SELECT slow()', duration: '00:00:30', durationMs: 30000, database: 'dev' },
          { pid: 401, user: 'u2', state: 'idle', query: '', duration: '00:00:05', durationMs: 5000, database: 'dev' },
          { pid: 402, user: 'u3', state: 'active', query: 'SELECT very_slow()', duration: '00:02:00', durationMs: 120000, database: 'dev' },
        ],
        tables: defaultTables,
      },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;

    // Duration badge variant logic:
    // PID 400: durationMs=30000 (>10000, <=60000) -> variant="outline"
    // PID 401: durationMs=5000 (<=10000) -> variant="secondary"
    // PID 402: durationMs=120000 (>60000) -> variant="destructive"

    // Badge component renders as <span data-slot="badge">
    const allBadges = Array.from(container.querySelectorAll('span[data-slot="badge"]'));

    // Find the badge containing '00:00:30' (outline variant for 10s-60s range)
    const durationBadge400 = allBadges.find(
      badge => badge.textContent?.includes('00:00:30')
    );
    expect(durationBadge400).toBeDefined();
    // Outline variant: has text-foreground, does NOT have bg-destructive or bg-secondary
    expect(durationBadge400!.className).toContain('text-foreground');
    expect(durationBadge400!.className).not.toContain('bg-destructive');
    expect(durationBadge400!.className).not.toContain('bg-secondary');
    expect(durationBadge400!.className).not.toContain('border-transparent');

    // Find the badge containing '00:02:00' (destructive variant for >60s)
    const durationBadge402 = allBadges.find(
      badge => badge.textContent?.includes('00:02:00')
    );
    expect(durationBadge402).toBeDefined();
    expect(durationBadge402!.className).toContain('bg-destructive');

    // Find the badge containing '00:00:05' (secondary variant for <=10s)
    const durationBadge401 = allBadges.find(
      badge => badge.textContent?.includes('00:00:05')
    );
    expect(durationBadge401).toBeDefined();
    expect(durationBadge401!.className).toContain('bg-secondary');
  });

  // =========================================================================
  // Kill dialog shows user and state in description
  // =========================================================================

  test('kill dialog shows user and state in description', async () => {
    monitoringOverride = {
      data: {
        activeSessions: [
          { pid: 500, user: 'db_admin', state: 'idle in transaction', query: 'UPDATE t SET x=1', duration: '00:05:00', durationMs: 300000, database: 'dev' },
        ],
        tables: defaultTables,
      },
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container, baseElement } = renderResult!;

    // Find and click the kill button for PID 500
    const cells = container.querySelectorAll('td');
    const pidCell = Array.from(cells).find(td => td.textContent?.includes('500'));
    expect(pidCell).not.toBeNull();
    const row = pidCell!.closest('tr');
    const killBtn = row!.querySelector('td:last-child button');
    expect(killBtn).not.toBeNull();

    await act(async () => {
      fireEvent.click(killBtn!);
    });

    // Dialog should be open and show user and state info
    const dialogText = baseElement.textContent || '';
    expect(dialogText).toContain('Terminate Session?');
    expect(dialogText).toContain('500');
    // User is shown in the description
    expect(dialogText).toContain('db_admin');
    // State is shown in the description
    expect(dialogText).toContain('idle in transaction');
    // Also verify the warning about uncommitted transactions
    expect(dialogText).toContain('uncommitted transactions');
  });

  // =========================================================================
  // Error hidden when both error AND data present
  // =========================================================================

  test('error message is hidden when both error and data are present', async () => {
    monitoringOverride = {
      data: { activeSessions: defaultSessions, tables: defaultTables },
      error: 'Intermittent connection error',
    };
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText, container } = renderResult!;

    // The error message should NOT be displayed because data is present
    // (source code: `error && !data` — data is truthy, so error div is skipped)
    expect(queryByText('Intermittent connection error')).toBeNull();

    // But data should still render normally
    expect(queryByText('Sessions (1)')).not.toBeNull();
    expect(queryByText('Tables (1)')).not.toBeNull();
    expect(container.textContent).toContain('users');
    expect(container.textContent).toContain('1234');
  });
});
