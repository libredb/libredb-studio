import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import { mock } from 'bun:test';
import { setupRechartssMock, setupFramerMotionMock } from '../../helpers/mock-monaco';

setupRechartssMock();
setupFramerMotionMock();

const mockRefresh = mock(() => {});
const mockKillSession = mock(async () => true);
const mockRunMaintenance = mock(async () => true);

mock.module('@/hooks/use-monitoring-data', () => ({
  useMonitoringData: mock(() => ({
    data: {
      activeSessions: [
        {
          pid: 1234,
          user: 'admin',
          state: 'active',
          query: 'SELECT 1',
          duration: '00:01:00',
          durationMs: 60000,
          database: 'dev',
        },
      ],
      tables: [
        {
          tableName: 'users',
          schemaName: 'public',
          rowCount: 1000,
          tableSize: '16 MB',
          totalSize: '20 MB',
          bloatRatio: 5,
        },
      ],
    },
    loading: false,
    error: null,
    refresh: mockRefresh,
    killSession: mockKillSession,
    runMaintenance: mockRunMaintenance,
  })),
}));

mock.module('@/lib/storage', () => ({
  storage: {
    getConnections: mock(() => [
      {
        id: 'c1',
        name: 'PG Dev',
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        database: 'dev',
        createdAt: new Date(),
      },
    ]),
    getActiveConnectionId: mock(() => 'c1'),
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
import { render, act, cleanup } from '@testing-library/react';
import React from 'react';

import { OperationsTab } from '@/components/admin/tabs/OperationsTab';

// =============================================================================
// OperationsTab Tests
// =============================================================================

describe('OperationsTab', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockRefresh.mockClear();
    mockKillSession.mockClear();
    mockRunMaintenance.mockClear();
  });

  test('renders connection selector', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;

    // The connection selector shows the selected connection name
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

    // Tables section header
    expect(queryByText('Tables (1)')).not.toBeNull();
    // Table name from mock data
    expect(queryByText('users')).not.toBeNull();
  });

  test('shows sessions panel with session list', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { queryByText } = renderResult!;

    // Sessions section header
    expect(queryByText('Sessions (1)')).not.toBeNull();
    // Session PID from mock data
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
    // Session query from mock data
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
    // 1000 rows in mock data — could be displayed as 1,000 or 1000
    expect(container.textContent).toMatch(/1,?000/);
  });

  test('shows connection type in selector', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OperationsTab />);
    });
    const { container } = renderResult!;
    // Connection type shown in parentheses
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
});
