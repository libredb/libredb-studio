import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import { mock, describe, test, expect, afterEach } from 'bun:test';
import React from 'react';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { SessionsTab } from '@/components/monitoring/tabs/SessionsTab';
import type { MonitoringData } from '@/lib/db/types';

mock.module('@/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => React.createElement('div', {}, children),
  Tooltip: ({ children }: { children: React.ReactNode }) => React.createElement('div', {}, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => React.createElement('div', {}, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) => React.createElement('div', {}, children),
}));

mock.module('@/components/ui/alert-dialog', () => ({
  AlertDialog: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    (open ? React.createElement('div', { 'data-testid': 'alert-dialog' }, children) : null),
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => React.createElement('div', {}, children),
  AlertDialogHeader: ({ children }: { children: React.ReactNode }) => React.createElement('div', {}, children),
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => React.createElement('h2', {}, children),
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => React.createElement('p', {}, children),
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => React.createElement('div', {}, children),
  AlertDialogCancel: ({ children }: { children: React.ReactNode }) => React.createElement('button', { type: 'button' }, children),
  AlertDialogAction: ({ children, onClick }: { children: React.ReactNode; onClick?: () => void }) =>
    React.createElement('button', { type: 'button', onClick }, children),
}));

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
      tableCount: 0,
      indexCount: 0,
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
    activeSessions: [
      {
        pid: 101,
        user: 'admin',
        database: 'db',
        state: 'active',
        query: 'SELECT * FROM users',
        duration: '1.2s',
        durationMs: 1200,
      },
      {
        pid: 202,
        user: 'app',
        database: 'db',
        state: 'idle in transaction',
        query: 'UPDATE users SET active = true',
        duration: '65s',
        durationMs: 65000,
        waitEventType: 'Lock',
      },
    ],
  } as unknown as MonitoringData;
}

describe('SessionsTab', () => {
  afterEach(() => {
    cleanup();
  });

  test('renders skeleton when loading and data is null', () => {
    const { queryByText } = render(
      <SessionsTab data={null} loading onKillSession={mock(async () => true)} />
    );
    expect(queryByText('Sessions (')).toBeNull();
  });

  test('shows empty state when there are no active sessions', () => {
    const { queryByText } = render(
      <SessionsTab
        data={{ ...makeData(), activeSessions: [] } as MonitoringData}
        loading={false}
        onKillSession={mock(async () => true)}
      />
    );
    expect(queryByText('No active sessions found.')).not.toBeNull();
  });

  test('renders stats and session state badges', () => {
    const { queryByText, queryAllByText } = render(
      <SessionsTab data={makeData()} loading={false} onKillSession={mock(async () => true)} />
    );

    expect(queryByText('Sessions (2)')).not.toBeNull();
    expect(queryAllByText('Active').length).toBeGreaterThan(0);
    expect(queryByText('Idle in TX')).not.toBeNull();
    expect(queryByText('65s')).not.toBeNull();
  });

  test('calls onKillSession after confirming terminate action', async () => {
    const onKillSession = mock(async () => true);
    const { container, queryByText } = render(
      <SessionsTab data={makeData()} loading={false} onKillSession={onKillSession} isAdmin />
    );

    const killButtons = Array.from(container.querySelectorAll('button')).filter((btn) =>
      btn.className.includes('text-destructive')
    );
    expect(killButtons.length).toBeGreaterThan(0);
    fireEvent.click(killButtons[0]!);

    expect(queryByText('Terminate Session?')).not.toBeNull();
    const terminateButton = queryByText('Terminate');
    expect(terminateButton).not.toBeNull();
    fireEvent.click(terminateButton!);

    await waitFor(() => {
      expect(onKillSession).toHaveBeenCalledWith(101);
    });
  });

  test('hides admin actions when isAdmin is false', () => {
    const { queryAllByText } = render(
      <SessionsTab data={makeData()} loading={false} onKillSession={mock(async () => true)} isAdmin={false} />
    );
    expect(queryAllByText('-').length).toBeGreaterThan(0);
  });
});
