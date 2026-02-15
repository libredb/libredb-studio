import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { PerformanceTab } from '@/components/monitoring/tabs/PerformanceTab';
import type { MonitoringData } from '@/lib/db/types';
import type { TimeSeriesPoint } from '@/lib/time-series-buffer';

mock.module('@/components/monitoring/tabs/MetricChart', () => ({
  MetricChart: ({ title }: { title: string }) => React.createElement('div', { 'data-testid': 'metric-chart' }, title),
}));

function makeData(overrides: Partial<MonitoringData['performance']> = {}): MonitoringData {
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
    performance: {
      cacheHitRatio: 98.2,
      bufferPoolUsage: 65,
      deadlocks: 0,
      checkpointWriteTime: '12ms',
      ...overrides,
    },
    slowQueries: [],
    activeSessions: [],
  } as unknown as MonitoringData;
}

function makeHistory(): TimeSeriesPoint<MonitoringData>[] {
  return [
    { timestamp: new Date('2026-02-15T12:00:00Z'), data: makeData() },
    { timestamp: new Date('2026-02-15T12:01:00Z'), data: makeData({ cacheHitRatio: 96.1, bufferPoolUsage: 72, deadlocks: 1 }) },
  ] as unknown as TimeSeriesPoint<MonitoringData>[];
}

describe('PerformanceTab', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders skeleton while loading without data', () => {
    const { queryByText } = render(<PerformanceTab data={null} loading />);
    expect(queryByText('Cache Hit')).toBeNull();
  });

  test('renders healthy metrics and positive tip', () => {
    const { queryByText } = render(<PerformanceTab data={makeData()} loading={false} />);
    expect(queryByText('Cache Hit')).not.toBeNull();
    expect(queryByText('Buffer')).not.toBeNull();
    expect(queryByText('Deadlocks')).not.toBeNull();
    expect(queryByText('Performing well!')).not.toBeNull();
  });

  test('renders warning tips for low cache and deadlocks', () => {
    const { queryByText, queryAllByText } = render(
      <PerformanceTab
        data={makeData({ cacheHitRatio: 72, deadlocks: 3, bufferPoolUsage: 88 })}
        loading={false}
      />
    );
    expect(queryByText('Low Cache Hit')).not.toBeNull();
    expect(queryAllByText('Deadlocks').length).toBeGreaterThan(0);
    expect(queryByText('Attention')).not.toBeNull();
  });

  test('shows trend charts when history has at least 2 points', () => {
    const { queryByText, queryAllByTestId } = render(
      <PerformanceTab data={makeData()} loading={false} history={makeHistory()} />
    );
    expect(queryByText('Cache Hit Trend')).not.toBeNull();
    expect(queryByText('Buffer Pool Trend')).not.toBeNull();
    expect(queryByText('Deadlock Trend')).not.toBeNull();
    expect(queryAllByTestId('metric-chart').length).toBeGreaterThanOrEqual(3);
  });
});
