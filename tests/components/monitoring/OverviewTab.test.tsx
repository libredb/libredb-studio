import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { OverviewTab } from '@/components/monitoring/tabs/OverviewTab';
import type { MonitoringData } from '@/lib/db/types';
import type { TimeSeriesPoint } from '@/lib/time-series-buffer';

mock.module('@/components/monitoring/tabs/MetricChart', () => ({
  MetricChart: ({ title }: { title: string }) => React.createElement('div', { 'data-testid': 'metric-chart' }, title),
}));

function makeData(): MonitoringData {
  return {
    timestamp: new Date('2026-02-15T12:00:00Z'),
    overview: {
      version: 'PostgreSQL 16.3',
      uptime: '2h 5m',
      activeConnections: 8,
      maxConnections: 100,
      databaseSize: '1.8 GB',
      databaseSizeBytes: 1932735283,
      tableCount: 24,
      indexCount: 61,
    },
    performance: {
      cacheHitRatio: 95.7,
      bufferPoolUsage: 62,
      deadlocks: 1,
      checkpointWriteTime: '18ms',
    },
    slowQueries: [{ query: 'SELECT 1', calls: 10, totalTime: 100, avgTime: 10, rows: 10 }],
    activeSessions: [
      { pid: 1, user: 'admin', database: 'db', state: 'active', query: 'SELECT 1', duration: '1s', durationMs: 1000 },
      { pid: 2, user: 'app', database: 'db', state: 'idle', query: '', duration: '2s', durationMs: 2000 },
    ],
  } as unknown as MonitoringData;
}

function makeHistory(): TimeSeriesPoint<MonitoringData>[] {
  return [
    { timestamp: new Date('2026-02-15T12:00:00Z'), data: makeData() },
    { timestamp: new Date('2026-02-15T12:01:00Z'), data: { ...makeData(), overview: { ...makeData().overview, activeConnections: 12 } } as MonitoringData },
  ] as unknown as TimeSeriesPoint<MonitoringData>[];
}

describe('OverviewTab', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders skeleton while loading without data', () => {
    const { queryByText } = render(<OverviewTab data={null} loading />);
    expect(queryByText('Connections')).toBeNull();
  });

  test('renders key overview cards and quick stats', () => {
    const { queryByText, container } = render(<OverviewTab data={makeData()} loading={false} />);
    expect(queryByText('PostgreSQL 16.3')).not.toBeNull();
    expect(queryByText('2h 5m')).not.toBeNull();
    expect(container.textContent).toContain('8/100');
    expect(queryByText('8% used')).not.toBeNull();
    expect(queryByText('24')).not.toBeNull();
    expect(queryByText('61 indexes')).not.toBeNull();
    expect(queryByText('Quick Stats')).not.toBeNull();
  });

  test('renders connection trend when history has enough points', () => {
    const { queryByText, queryByTestId } = render(
      <OverviewTab data={makeData()} loading={false} history={makeHistory()} />
    );
    expect(queryByText('Connection Trend')).not.toBeNull();
    expect(queryByTestId('metric-chart')).not.toBeNull();
  });
});
