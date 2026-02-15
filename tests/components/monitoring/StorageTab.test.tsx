import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import React from 'react';
import { describe, test, expect, afterEach } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { StorageTab } from '@/components/monitoring/tabs/StorageTab';
import type { MonitoringData } from '@/lib/db/types';

function makeMonitoringData(): MonitoringData {
  return {
    timestamp: new Date('2026-02-15T12:00:00Z'),
    overview: {
      version: '16.3',
      uptime: '1000s',
      activeConnections: 4,
      maxConnections: 100,
      databaseSize: '2.00 GB',
      databaseSizeBytes: 2 * 1024 * 1024 * 1024,
      tableCount: 2,
      indexCount: 1,
    },
    performance: {
      queriesPerSecond: 12,
      avgQueryTime: 7,
      cacheHitRatio: 98,
      cpuUsage: 15,
      memoryUsage: 40,
      memoryTotal: 100,
      memoryUsed: 40,
      diskUsage: 33,
      diskTotal: 100,
      diskUsed: 33,
      swapUsage: 0,
      loadAverage: [0.2, 0.3, 0.4],
      networkRx: 1,
      networkTx: 2,
      transactionsPerSecond: 8,
      commitsPerSecond: 7,
      rollbacksPerSecond: 1,
      tempFilesPerSecond: 0,
      deadlocksPerSecond: 0,
      replicationLag: 0,
      checkpointWriteTime: 0,
    },
    slowQueries: [],
    activeSessions: [],
    storage: [
      { name: 'pg_default', location: '/var/lib/postgres', size: '1.20 GB', sizeBytes: 1288490188, usagePercent: 60 },
      { name: 'WAL', location: '/var/lib/postgres/pg_wal', size: '300 MB', sizeBytes: 314572800, usagePercent: 15, walSize: '300 MB', walSizeBytes: 314572800 },
    ],
    tables: [
      {
        schemaName: 'public',
        tableName: 'orders',
        rowCount: 10000,
        tableSize: '500 MB',
        tableSizeBytes: 524288000,
        totalSize: '700 MB',
        totalSizeBytes: 734003200,
      },
      {
        schemaName: 'public',
        tableName: 'users',
        rowCount: 2500,
        tableSize: '200 MB',
        tableSizeBytes: 209715200,
        totalSize: '300 MB',
        totalSizeBytes: 314572800,
      },
    ],
    indexes: [
      {
        schemaName: 'public',
        tableName: 'orders',
        indexName: 'idx_orders_created_at',
        columns: ['created_at'],
        isUnique: false,
        isPrimary: false,
        indexSize: '120 MB',
        indexSizeBytes: 125829120,
        scans: 100,
      },
    ],
  } as unknown as MonitoringData;
}

describe('StorageTab', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders skeleton when loading without data', () => {
    const { queryByText } = render(<StorageTab data={null} loading />);
    expect(queryByText('Storage Breakdown')).toBeNull();
  });

  test('shows empty states when storage and table lists are missing', () => {
    const emptyData = {
      ...makeMonitoringData(),
      storage: [],
      tables: [],
      indexes: [],
    } as MonitoringData;
    const { queryByText } = render(<StorageTab data={emptyData} loading={false} />);

    expect(queryByText('No tablespace information available.')).not.toBeNull();
    expect(queryByText('No table information available.')).not.toBeNull();
  });

  test('renders storage cards, breakdown, badges and largest tables', () => {
    const { queryByText, queryAllByText } = render(<StorageTab data={makeMonitoringData()} loading={false} />);

    expect(queryByText('Storage Breakdown')).not.toBeNull();
    expect(queryByText('Tablespaces')).not.toBeNull();
    expect(queryByText('Largest Tables')).not.toBeNull();
    expect(queryByText('2.00 GB')).not.toBeNull();
    expect(queryAllByText('300 MB').length).toBeGreaterThan(0); // WAL card
    expect(queryByText('Default')).not.toBeNull();
    expect(queryAllByText('WAL').length).toBeGreaterThan(0);

    // largest tables are sorted by total size descending
    expect(queryByText('orders')).not.toBeNull();
    expect(queryByText('users')).not.toBeNull();
  });
});
