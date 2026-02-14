import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import { mock } from 'bun:test';
import { setupRechartssMock, setupFramerMotionMock } from '../../helpers/mock-monaco';

setupRechartssMock();
setupFramerMotionMock();

const mockSetAutoRefresh = mock(() => {});
const mockSetRefreshInterval = mock(() => {});
const mockRefresh = mock(() => {});
const mockKillSession = mock(async () => true);
const mockRunMaintenance = mock(async () => true);

mock.module('@/hooks/use-monitoring-data', () => ({
  useMonitoringData: mock(() => ({
    data: {
      overview: {
        version: '15.4',
        uptime: 86400,
        connections: { active: 5, total: 15, max: 100 },
        databaseSize: '256 MB',
      },
      performance: {
        queriesPerSecond: 150,
        avgQueryTime: 2.5,
        cacheHitRatio: 99.1,
      },
      slowQueries: [],
      activeSessions: [],
    },
    loading: false,
    error: null,
    lastUpdated: new Date(),
    autoRefresh: true,
    refreshInterval: 10000,
    history: [],
    setAutoRefresh: mockSetAutoRefresh,
    setRefreshInterval: mockSetRefreshInterval,
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

// Mock all 7 monitoring tab sub-components
mock.module('@/components/monitoring/tabs/OverviewTab', () => ({
  OverviewTab: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'monitoring-overviewtab' }, 'OverviewTab');
  },
}));

mock.module('@/components/monitoring/tabs/PerformanceTab', () => ({
  PerformanceTab: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'monitoring-performancetab' }, 'PerformanceTab');
  },
}));

mock.module('@/components/monitoring/tabs/QueriesTab', () => ({
  QueriesTab: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'monitoring-queriestab' }, 'QueriesTab');
  },
}));

mock.module('@/components/monitoring/tabs/SessionsTab', () => ({
  SessionsTab: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'monitoring-sessionstab' }, 'SessionsTab');
  },
}));

mock.module('@/components/monitoring/tabs/TablesTab', () => ({
  TablesTab: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'monitoring-tablestab' }, 'TablesTab');
  },
}));

mock.module('@/components/monitoring/tabs/StorageTab', () => ({
  StorageTab: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'monitoring-storagetab' }, 'StorageTab');
  },
}));

mock.module('@/components/monitoring/tabs/PoolTab', () => ({
  PoolTab: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'monitoring-pooltab' }, 'PoolTab');
  },
}));

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, act, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

import { mockRouterPush } from '../../helpers/mock-navigation';

import { MonitoringDashboard } from '@/components/monitoring/MonitoringDashboard';

// =============================================================================
// MonitoringDashboard Tests
// =============================================================================

describe('MonitoringDashboard', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockRouterPush.mockClear();
    mockRefresh.mockClear();
    mockSetAutoRefresh.mockClear();
    mockSetRefreshInterval.mockClear();
  });

  test('renders monitoring title', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText('Monitoring')).not.toBeNull();
  });

  test('shows connection selector', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { queryByText } = renderResult!;

    // The connection selector shows the selected connection name
    expect(queryByText('PG Dev')).not.toBeNull();
  });

  test('shows 7 tab triggers', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText('Overview')).not.toBeNull();
    expect(queryByText('Performance')).not.toBeNull();
    expect(queryByText('Queries')).not.toBeNull();
    expect(queryByText('Sessions')).not.toBeNull();
    expect(queryByText('Tables')).not.toBeNull();
    expect(queryByText('Storage')).not.toBeNull();
    expect(queryByText('Pool')).not.toBeNull();
  });

  test('refresh button present', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { container } = renderResult!;

    // Refresh button has title "Refresh now"
    const refreshButton = container.querySelector('[title="Refresh now"]');
    expect(refreshButton).not.toBeNull();
  });

  test('auto-refresh toggle present', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { container } = renderResult!;

    // Auto-refresh toggle button has title containing "auto-refresh"
    const autoRefreshButton = container.querySelector('[title="Pause auto-refresh"]');
    expect(autoRefreshButton).not.toBeNull();
  });

  test('no connection shows empty state', async () => {
    // Override storage to return empty connections
    const storageModule = await import('@/lib/storage');
    const originalGetConnections = (storageModule.storage as unknown as Record<string, unknown>).getConnections;
    (storageModule.storage as unknown as Record<string, unknown>).getConnections = mock(() => []);

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText('No Connection Selected')).not.toBeNull();
    expect(queryByText('Select a database connection to view monitoring data.')).not.toBeNull();

    // Restore
    (storageModule.storage as unknown as Record<string, unknown>).getConnections = originalGetConnections;
  });

  test('isEmbedded=true hides back button', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard isEmbedded={true} />);
    });
    const { queryByText } = renderResult!;

    // When embedded, the Back button should not be present
    expect(queryByText('Back')).toBeNull();
  });

  test('tab switching works', async () => {
    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<MonitoringDashboard />);
    });
    const { queryByTestId, container } = renderResult!;

    // Default tab is overview
    expect(queryByTestId('monitoring-overviewtab')).not.toBeNull();

    // Click on Performance tab (must use userEvent for Radix tabs in happy-dom)
    const allTriggers = container.querySelectorAll('[role="tab"]');
    const perfTrigger = Array.from(allTriggers).find((t) => t.textContent?.includes('Performance')) as HTMLElement;
    await user.click(perfTrigger);

    // Performance tab content should now be visible
    await waitFor(() => {
      expect(queryByTestId('monitoring-performancetab')).not.toBeNull();
    });
  });
});
