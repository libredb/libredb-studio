import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import { mock } from 'bun:test';
import { setupRechartssMock, setupFramerMotionMock } from '../../helpers/mock-monaco';

setupRechartssMock();
setupFramerMotionMock();

// Mock date-fns to avoid complex date computations in tests
mock.module('date-fns', () => ({
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  format: (date: Date, fmt: string) => 'Mon',
  subDays: (date: Date, days: number) => new Date(date.getTime() - days * 86400000),
  startOfDay: (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()),
}));

const mockGetConnections = mock(() => [
  {
    id: 'c1',
    name: 'PG Dev',
    type: 'postgres',
    host: 'localhost',
    port: 5432,
    database: 'dev',
    createdAt: new Date(),
  },
]);

const mockGetHistory = mock(() => [
  {
    id: 'h1',
    query: 'SELECT 1',
    executedAt: new Date(),
    executionTime: 10,
    rowCount: 1,
    status: 'success',
    connectionId: 'c1',
    connectionName: 'PG Dev',
  },
]);

mock.module('@/lib/storage', () => ({
  storage: {
    getConnections: mockGetConnections,
    getHistory: mockGetHistory,
  },
}));

mock.module('@/lib/db-ui-config', () => ({
  getDBIcon: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return (props: Record<string, unknown>) => React.createElement('span', { ...props, 'data-testid': 'db-icon' });
  },
  getDBColor: () => 'text-blue-400',
  getDBConfig: () => ({ icon: () => null, color: 'text-blue-400', label: 'PostgreSQL', defaultPort: '5432' }),
}));

mock.module('next/link', () => ({
  default: ({ children, href, ...props }: Record<string, unknown>) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('a', { href, ...props }, children);
  },
}));

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, waitFor, act, cleanup } from '@testing-library/react';
import React from 'react';

import { mockGlobalFetch, restoreGlobalFetch } from '../../helpers/mock-fetch';

import { OverviewTab } from '@/components/admin/tabs/OverviewTab';

// =============================================================================
// OverviewTab Tests
// =============================================================================

describe('OverviewTab', () => {
  afterEach(() => {
    cleanup();
  });

  let fetchMock: ReturnType<typeof mockGlobalFetch>;

  beforeEach(() => {
    mockGetConnections.mockClear();
    mockGetHistory.mockClear();

    // Reset to default return values
    mockGetConnections.mockImplementation(() => [
      {
        id: 'c1',
        name: 'PG Dev',
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        database: 'dev',
        createdAt: new Date(),
      },
    ]);

    mockGetHistory.mockImplementation(() => [
      {
        id: 'h1',
        query: 'SELECT 1',
        executedAt: new Date(),
        executionTime: 10,
        rowCount: 1,
        status: 'success',
        connectionId: 'c1',
        connectionName: 'PG Dev',
      },
    ]);

    fetchMock = mockGlobalFetch({
      '/api/admin/audit': {
        json: { events: [] },
      },
      '/api/admin/fleet-health': {
        json: {
          results: [
            {
              connectionId: 'c1',
              connectionName: 'PG Dev',
              type: 'postgres',
              status: 'healthy',
              latencyMs: 15,
              databaseSize: '256 MB',
              activeConnections: 5,
            },
          ],
        },
      },
    });
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  test('renders when user provided', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OverviewTab user={{ username: 'admin', role: 'admin' }} />);
    });
    const { queryByText } = renderResult!;

    // Should render content (not empty state) when connections exist
    await waitFor(() => {
      // Hero section should contain status text
      expect(queryByText('All Systems Operational')).not.toBeNull();
    });
  });

  test('shows empty state when no connections', async () => {
    mockGetConnections.mockImplementation(() => []);

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OverviewTab user={{ username: 'admin', role: 'admin' }} />);
    });
    const { queryByText } = renderResult!;

    // The empty state shows "Welcome to Command Center"
    expect(queryByText('Welcome to Command Center')).not.toBeNull();
  });

  test('shows hero section when connections exist', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OverviewTab user={{ username: 'admin', role: 'admin' }} />);
    });
    const { queryByText } = renderResult!;

    await waitFor(() => {
      // Hero section contains health label and status
      expect(queryByText('Health')).not.toBeNull();
      expect(queryByText('Live')).not.toBeNull();
    });
  });

  test('fleet health section renders', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OverviewTab user={{ username: 'admin', role: 'admin' }} />);
    });
    const { queryByText } = renderResult!;

    await waitFor(() => {
      expect(queryByText('Fleet Status')).not.toBeNull();
    });
  });

  test('quick actions section renders', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OverviewTab user={{ username: 'admin', role: 'admin' }} />);
    });
    const { queryByText } = renderResult!;

    await waitFor(() => {
      expect(queryByText('Quick Actions')).not.toBeNull();
      expect(queryByText('Maintenance')).not.toBeNull();
      expect(queryByText('Security & Masking')).not.toBeNull();
      expect(queryByText('Real-time Monitoring')).not.toBeNull();
    });
  });

  test('fetches fleet health on mount', async () => {
    await act(async () => {
      render(<OverviewTab user={{ username: 'admin', role: 'admin' }} />);
    });

    await waitFor(() => {
      const calls = fetchMock.mock.calls;
      const fleetCall = calls.find((c: unknown[]) => {
        const url = typeof c[0] === 'string' ? c[0] : '';
        return url.includes('/api/admin/fleet-health');
      });
      expect(fleetCall).not.toBeUndefined();
    });
  });

  test('shows key metrics section', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OverviewTab user={{ username: 'admin', role: 'admin' }} />);
    });
    const { queryByText, queryAllByText } = renderResult!;

    await waitFor(() => {
      expect(queryByText('Key Metrics')).not.toBeNull();
      expect(queryByText('Query Success')).not.toBeNull();
      expect(queryByText('Fleet Health')).not.toBeNull();
      expect(queryByText('Avg Response')).not.toBeNull();
      expect(queryAllByText('Total Queries').length).toBeGreaterThan(0);
    });
  });

  test('shows user badge in hero section', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<OverviewTab user={{ username: 'admin', role: 'admin' }} />);
    });
    const { queryByText } = renderResult!;

    await waitFor(() => {
      expect(queryByText('admin (admin)')).not.toBeNull();
    });
  });
});
