import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import { mock } from 'bun:test';
import { setupRechartssMock, setupFramerMotionMock } from '../../helpers/mock-monaco';

setupRechartssMock();
setupFramerMotionMock();

// Mock child tab components to simplify
mock.module('@/components/admin/tabs/OverviewTab', () => ({
  OverviewTab: ({ user }: unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    const u = user as { username?: string } | null;
    return React.createElement('div', { 'data-testid': 'overview-tab' }, `OverviewTab${u ? ` - ${u.username}` : ''}`);
  },
}));

mock.module('@/components/admin/tabs/OperationsTab', () => ({
  OperationsTab: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'operations-tab' }, 'OperationsTab');
  },
}));

mock.module('@/components/admin/tabs/MonitoringEmbed', () => ({
  MonitoringEmbed: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'monitoring-embed' }, 'MonitoringEmbed');
  },
}));

mock.module('@/components/admin/tabs/SecurityTab', () => ({
  SecurityTab: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'security-tab' }, 'SecurityTab');
  },
}));

mock.module('@/components/admin/tabs/AuditTab', () => ({
  AuditTab: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'audit-tab' }, 'AuditTab');
  },
}));

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, fireEvent, waitFor, act, cleanup } from '@testing-library/react';
import React from 'react';

import { mockGlobalFetch, restoreGlobalFetch } from '../../helpers/mock-fetch';
import { mockRouterPush, mockRouterRefresh } from '../../helpers/mock-navigation';
import { mockToastSuccess } from '../../helpers/mock-sonner';

import AdminDashboard from '@/components/admin/AdminDashboard';

// =============================================================================
// AdminDashboard Tests
// =============================================================================

describe('AdminDashboard', () => {
  afterEach(() => {
    cleanup();
  });

  let fetchMock: ReturnType<typeof mockGlobalFetch>;

  beforeEach(() => {
    mockRouterPush.mockClear();
    mockRouterRefresh.mockClear();
    mockToastSuccess.mockClear();

    fetchMock = mockGlobalFetch({
      '/api/auth/me': {
        json: {
          authenticated: true,
          user: { username: 'admin', role: 'admin' },
        },
      },
      '/api/auth/logout': { json: { success: true } },
    });
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  test('renders admin dashboard title', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AdminDashboard />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText('Admin Dashboard')).not.toBeNull();
  });

  test('fetches user on mount', async () => {
    await act(async () => {
      render(<AdminDashboard />);
    });

    await waitFor(() => {
      const calls = fetchMock.mock.calls;
      const authCall = calls.find((c: unknown[]) => {
        const url = typeof c[0] === 'string' ? c[0] : '';
        return url.includes('/api/auth/me');
      });
      expect(authCall).not.toBeUndefined();
    });
  });

  test('shows 5 tab triggers', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AdminDashboard />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText('Overview')).not.toBeNull();
    expect(queryByText('Operations')).not.toBeNull();
    expect(queryByText('Monitoring')).not.toBeNull();
    expect(queryByText('Security')).not.toBeNull();
    expect(queryByText('Audit')).not.toBeNull();
  });

  test('default tab is overview', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AdminDashboard />);
    });
    const { queryByTestId } = renderResult!;

    // The OverviewTab mock content should be visible (default tab content)
    expect(queryByTestId('overview-tab')).not.toBeNull();
  });

  test('logout button present', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AdminDashboard />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText('Logout')).not.toBeNull();
  });

  test('editor button links to home', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AdminDashboard />);
    });
    const { queryByText, getByText } = renderResult!;

    expect(queryByText('Editor')).not.toBeNull();

    // Click the editor button
    const editorButton = getByText('Editor').closest('button');
    expect(editorButton).not.toBeNull();
    fireEvent.click(editorButton!);

    expect(mockRouterPush).toHaveBeenCalledWith('/');
  });

  test('shows username greeting after auth fetch', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AdminDashboard />);
    });
    const { queryByTestId } = renderResult!;

    // Wait for user data to be fetched and passed to OverviewTab
    await waitFor(() => {
      // The OverviewTab mock renders the username if user is provided
      const overviewTab = queryByTestId('overview-tab');
      expect(overviewTab).not.toBeNull();
      expect(overviewTab!.textContent).toContain('admin');
    });
  });

  test('logout button triggers logout flow', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<AdminDashboard />);
    });
    const { getByText } = renderResult!;

    const logoutButton = getByText('Logout').closest('button');
    expect(logoutButton).not.toBeNull();

    await act(async () => {
      fireEvent.click(logoutButton!);
    });

    await waitFor(() => {
      expect(mockRouterPush).toHaveBeenCalledWith('/login');
    });
  });
});
