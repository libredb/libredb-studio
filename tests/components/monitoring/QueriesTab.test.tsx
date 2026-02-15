import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { QueriesTab } from '@/components/monitoring/tabs/QueriesTab';
import type { MonitoringData } from '@/lib/db/types';

mock.module('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => React.createElement('div', {}, children),
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement('div', {}, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => React.createElement('div', {}, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) => React.createElement('div', {}, children),
}));

function makeData(): MonitoringData {
  return {
    timestamp: new Date('2026-02-15T12:00:00Z'),
    overview: {
      version: '16.3',
      uptime: '2h',
      activeConnections: 3,
      maxConnections: 100,
      databaseSize: '1 GB',
      databaseSizeBytes: 1024 * 1024 * 1024,
      tableCount: 2,
      indexCount: 3,
    },
    performance: { cacheHitRatio: 98, queriesPerSecond: 10, avgQueryTime: 40 },
    slowQueries: [
      { queryId: 'q1', query: 'SELECT * FROM users', calls: 10, totalTime: 1200, avgTime: 120, rows: 300 },
      { queryId: 'q2', query: 'SELECT * FROM events', calls: 200, totalTime: 900, avgTime: 4.5, rows: 100000 },
      { queryId: 'q3', query: 'VACUUM users', calls: 2, totalTime: 3000, avgTime: 1500, rows: 0 },
    ],
    activeSessions: [],
  } as unknown as MonitoringData;
}

describe('QueriesTab', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders skeleton while loading without data', () => {
    const { queryByText } = render(<QueriesTab data={null} loading />);
    expect(queryByText('Slowest Queries')).toBeNull();
  });

  test('shows empty state when no slow queries exist', () => {
    const { queryByText } = render(
      <QueriesTab data={{ ...makeData(), slowQueries: [] } as MonitoringData} loading={false} />
    );
    expect(queryByText('No query statistics available.')).not.toBeNull();
    expect(queryByText('pg_stat_statements required')).not.toBeNull();
  });

  test('renders stats cards and slow query rows', () => {
    const { queryByText, queryAllByText } = render(<QueriesTab data={makeData()} loading={false} />);

    expect(queryByText('Slowest Queries')).not.toBeNull();
    expect(queryAllByText('SELECT * FROM users').length).toBeGreaterThan(0);
    expect(queryAllByText('SELECT * FROM events').length).toBeGreaterThan(0);
    expect(queryAllByText('VACUUM users').length).toBeGreaterThan(0);
    expect(queryByText('Slow')).not.toBeNull();
  });

  test('sorts by calls when Calls header is clicked', () => {
    const { container, queryByText } = render(<QueriesTab data={makeData()} loading={false} />);

    const callsSortButton = queryByText('Calls');
    expect(callsSortButton).not.toBeNull();
    fireEvent.click(callsSortButton!);

    const rows = container.querySelectorAll('tbody tr');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.textContent).toContain('SELECT * FROM events');
  });
});
