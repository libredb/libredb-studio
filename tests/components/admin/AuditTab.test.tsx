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

mock.module('@/lib/storage', () => ({
  storage: {
    getHistory: mock(() => [
      {
        id: 'h1',
        query: 'SELECT 1',
        executedAt: new Date(),
        executionTime: 10,
        rowCount: 1,
        status: 'success',
        connectionId: 'c1',
        connectionName: 'TestDB',
      },
      {
        id: 'h2',
        query: 'DROP TABLE x',
        executedAt: new Date(),
        executionTime: 5,
        rowCount: 0,
        status: 'error',
        error: 'denied',
        connectionId: 'c1',
        connectionName: 'TestDB',
      },
    ]),
  },
}));

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, waitFor, act, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';

import { mockGlobalFetch, restoreGlobalFetch } from '../../helpers/mock-fetch';

import { AuditTab } from '@/components/admin/tabs/AuditTab';

// =============================================================================
// AuditTab Tests
// =============================================================================

describe('AuditTab', () => {
  afterEach(() => {
    cleanup();
  });

  let fetchMock: ReturnType<typeof mockGlobalFetch>;

  beforeEach(() => {
    fetchMock = mockGlobalFetch({
      '/api/admin/audit': {
        json: {
          events: [
            {
              id: 'a1',
              timestamp: new Date().toISOString(),
              type: 'maintenance',
              action: 'VACUUM',
              target: 'users',
              connectionName: 'TestDB',
              user: 'admin',
              result: 'success',
              duration: 120,
            },
            {
              id: 'a2',
              timestamp: new Date().toISOString(),
              type: 'kill_session',
              action: 'KILL',
              target: 'PID:5678',
              connectionName: 'TestDB',
              user: 'admin',
              result: 'failure',
              duration: 50,
            },
          ],
        },
      },
    });
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  test('renders 3 tabs (Operations, Queries, Stats)', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText('Operations')).not.toBeNull();
    expect(queryByText('Queries')).not.toBeNull();
    expect(queryByText('Stats')).not.toBeNull();
  });

  test('operations tab fetches audit events', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText } = renderResult!;

    // Wait for the fetch to complete and events to render
    await waitFor(() => {
      const calls = fetchMock.mock.calls;
      const auditCall = calls.find((c: unknown[]) => {
        const url = typeof c[0] === 'string' ? c[0] : '';
        return url.includes('/api/admin/audit');
      });
      expect(auditCall).not.toBeUndefined();
    });

    // Events should render after fetch
    await waitFor(() => {
      expect(queryByText('VACUUM')).not.toBeNull();
      expect(queryByText('KILL')).not.toBeNull();
    });
  });

  test('queries tab shows query history', async () => {
    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText, container } = renderResult!;

    // Click the Queries tab trigger (must use userEvent for Radix tabs in happy-dom)
    const allTriggers = container.querySelectorAll('[role="tab"]');
    const queriesTab = Array.from(allTriggers).find((t) => t.textContent?.includes('Queries')) as HTMLElement;
    await user.click(queriesTab);

    // Query history from mock storage
    await waitFor(() => {
      expect(queryByText('SELECT 1')).not.toBeNull();
      expect(queryByText('DROP TABLE x')).not.toBeNull();
    });
  });

  test('stats tab shows summary cards', async () => {
    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText, container } = renderResult!;

    // Click the Stats tab trigger (must use userEvent for Radix tabs in happy-dom)
    const allTriggers = container.querySelectorAll('[role="tab"]');
    const statsTab = Array.from(allTriggers).find((t) => t.textContent?.includes('Stats')) as HTMLElement;
    await user.click(statsTab);

    // Summary cards show total queries, success rate, etc.
    await waitFor(() => {
      expect(queryByText('Total Queries')).not.toBeNull();
      expect(queryByText('Success Rate')).not.toBeNull();
      expect(queryByText('Avg Duration')).not.toBeNull();
      expect(queryByText('Failed')).not.toBeNull();
    });
  });

  test('search filter works in operations tab', async () => {
    const user = userEvent.setup();
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText, getByPlaceholderText } = renderResult!;

    // Wait for events to load
    await waitFor(() => {
      expect(queryByText('VACUUM')).not.toBeNull();
    });

    // Find the search input and type a search query
    const searchInput = getByPlaceholderText('Search...');
    expect(searchInput).not.toBeNull();

    // Use userEvent for proper input handling in happy-dom
    await user.clear(searchInput);
    await user.type(searchInput, 'VACUUM');

    // VACUUM should still be visible, KILL should be filtered out
    await waitFor(() => {
      expect(queryByText('VACUUM')).not.toBeNull();
      expect(queryByText('KILL')).toBeNull();
    });
  });

  test('type filter dropdown present', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AuditTab />);
    });
    const { queryByText } = renderResult!;

    // The type filter select should show "All Types" by default
    expect(queryByText('All Types')).not.toBeNull();
  });
});
