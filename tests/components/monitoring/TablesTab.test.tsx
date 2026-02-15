import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import React from 'react';
import { describe, test, expect, mock, afterEach } from 'bun:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { TablesTab } from '@/components/monitoring/tabs/TablesTab';
import type { MonitoringData } from '@/lib/db/types';

function makeData(): MonitoringData {
  return {
    timestamp: new Date('2026-02-15T12:00:00Z'),
    overview: {
      version: '16.3',
      uptime: '1s',
      activeConnections: 3,
      maxConnections: 100,
      databaseSize: '1 GB',
      databaseSizeBytes: 1024 * 1024 * 1024,
      tableCount: 2,
      indexCount: 2,
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
    tables: [
      {
        schemaName: 'public',
        tableName: 'users',
        rowCount: 1200,
        deadRowCount: 10,
        tableSize: '100 MB',
        tableSizeBytes: 104857600,
        indexSize: '20 MB',
        indexSizeBytes: 20971520,
        totalSize: '120 MB',
        totalSizeBytes: 125829120,
        bloatRatio: 5,
        lastVacuum: new Date('2026-02-01T00:00:00Z'),
      },
      {
        schemaName: 'public',
        tableName: 'events',
        rowCount: 500000,
        deadRowCount: 30000,
        tableSize: '600 MB',
        tableSizeBytes: 629145600,
        indexSize: '100 MB',
        indexSizeBytes: 104857600,
        totalSize: '700 MB',
        totalSizeBytes: 734003200,
        bloatRatio: 25,
      },
    ],
  } as unknown as MonitoringData;
}

describe('TablesTab', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders skeleton when loading and data is null', () => {
    const { queryByText } = render(
      <TablesTab data={null} loading onRunMaintenance={mock(async () => true)} />
    );
    expect(queryByText('Table Statistics')).toBeNull();
  });

  test('shows empty state when no tables match', () => {
    const { queryByText } = render(
      <TablesTab
        data={{ ...makeData(), tables: [] } as MonitoringData}
        loading={false}
        onRunMaintenance={mock(async () => true)}
      />
    );
    expect(queryByText('No tables found.')).not.toBeNull();
  });

  test('updates search query input value', () => {
    const { queryByText, getByPlaceholderText } = render(
      <TablesTab data={makeData()} loading={false} onRunMaintenance={mock(async () => true)} />
    );

    expect(queryByText('users')).not.toBeNull();
    expect(queryByText('events')).not.toBeNull();

    const input = getByPlaceholderText('Search...');
    fireEvent.change(input, { target: { value: 'event' } });
    expect((input as HTMLInputElement).value).toBe('event');
  });

  test('runs maintenance actions when admin clicks action buttons', async () => {
    const onRunMaintenance = mock(async () => true);
    const { container } = render(
      <TablesTab data={makeData()} loading={false} onRunMaintenance={onRunMaintenance} isAdmin />
    );

    const analyzeButton = container.querySelector('button[title="Analyze"]');
    const vacuumButton = container.querySelector('button[title="Vacuum"]');
    const reindexButton = container.querySelector('button[title="Reindex"]');

    expect(analyzeButton).not.toBeNull();
    expect(vacuumButton).not.toBeNull();
    expect(reindexButton).not.toBeNull();

    fireEvent.click(analyzeButton!);
    await waitFor(() => {
      expect(onRunMaintenance).toHaveBeenCalledWith('analyze', 'users');
    });

    fireEvent.click(vacuumButton!);
    await waitFor(() => {
      expect(onRunMaintenance).toHaveBeenCalledWith('vacuum', 'users');
    });

    fireEvent.click(reindexButton!);
    await waitFor(() => {
      expect(onRunMaintenance).toHaveBeenCalledWith('reindex', 'users');
    });
  });

  test('shows non-admin placeholder for actions', () => {
    const { queryAllByText } = render(
      <TablesTab data={makeData()} loading={false} onRunMaintenance={mock(async () => true)} isAdmin={false} />
    );
    expect(queryAllByText('-').length).toBeGreaterThan(0);
  });
});
