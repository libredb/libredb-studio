import '../../setup-dom';
import '../../helpers/mock-sonner';
import { mockRouterPush } from '../../helpers/mock-navigation';

import React from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, fireEvent } from '@testing-library/react';

mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => React.createElement('div', { 'data-testid': 'dropdown-menu' }, children),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => React.createElement('div', { 'data-testid': 'dropdown-trigger' }, children),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => React.createElement('div', { 'data-testid': 'dropdown-content' }, children),
  DropdownMenuItem: ({ children, onClick, className }: { children: React.ReactNode; onClick?: () => void; className?: string }) =>
    React.createElement('div', { onClick, role: 'menuitem', className }, children),
}));

mock.module('@/components/ui/button', () => ({
  Button: ({ children, onClick, className, ...rest }: { children: React.ReactNode; onClick?: () => void; className?: string; [k: string]: unknown }) =>
    React.createElement('button', { onClick, className, ...rest }, children),
}));

import { StudioDesktopHeader } from '@/components/studio/StudioDesktopHeader';
import type { DatabaseConnection } from '@/lib/types';

// --- Fixtures ---
const baseConnection: DatabaseConnection = {
  id: '1',
  name: 'staging-db',
  type: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'app',
  user: 'admin',
  password: 'secret',
  createdAt: new Date(),
};

const connectionWithEnv: DatabaseConnection = {
  ...baseConnection,
  id: '2',
  name: 'prod-db',
  type: 'mysql',
  environment: 'production' as DatabaseConnection['environment'],
  color: '#ef4444',
};

const connectionWithOtherEnv: DatabaseConnection = {
  ...baseConnection,
  id: '3',
  name: 'test-db',
  type: 'sqlite',
  environment: 'other' as DatabaseConnection['environment'],
};

const connectionWithEnvNoColor: DatabaseConnection = {
  ...baseConnection,
  id: '4',
  name: 'dev-db',
  type: 'postgres',
  environment: 'development' as DatabaseConnection['environment'],
  color: undefined,
};

const defaultProps = {
  activeConnection: baseConnection,
  connectionPulse: null as 'healthy' | 'degraded' | 'error' | null,
  user: { role: 'admin' } as { role?: string } | null,
  isAdmin: true,
  onLogout: mock(() => {}),
};

describe('StudioDesktopHeader', () => {
  beforeEach(() => {
    mockRouterPush.mockClear();
    defaultProps.onLogout = mock(() => {});
    process.env.NEXT_PUBLIC_APP_VERSION = '1.2.3';
  });

  afterEach(() => {
    cleanup();
  });

  // ── Connection Info (Left Section) ──

  describe('connection info', () => {
    test('renders connection name when connected', () => {
      const { getByText } = render(<StudioDesktopHeader {...defaultProps} />);
      expect(getByText('staging-db')).toBeTruthy();
    });

    test('renders "Quick Access" when no active connection', () => {
      const { getByText } = render(
        <StudioDesktopHeader {...defaultProps} activeConnection={null} />
      );
      expect(getByText('Quick Access')).toBeTruthy();
    });

    test('renders database type', () => {
      const { container } = render(<StudioDesktopHeader {...defaultProps} />);
      expect(container.textContent).toContain('postgres');
    });

    test('does not render type subtitle when no connection', () => {
      const { container } = render(
        <StudioDesktopHeader {...defaultProps} activeConnection={null} />
      );
      expect(container.textContent).not.toContain('postgres');
      expect(container.textContent).not.toContain('Online');
    });
  });

  // ── Environment Tag ──

  describe('environment tag', () => {
    test('shows environment name with custom color', () => {
      const { getByText } = render(
        <StudioDesktopHeader {...defaultProps} activeConnection={connectionWithEnv} />
      );
      const envSpan = getByText(/production/i);
      expect(envSpan).toBeTruthy();
      expect(envSpan.style.color).toBe('#ef4444');
    });

    test('uses default green color when no color is set', () => {
      const { getByText } = render(
        <StudioDesktopHeader {...defaultProps} activeConnection={connectionWithEnvNoColor} />
      );
      const envSpan = getByText(/development/i);
      expect(envSpan.style.color).toBe('#22c55e');
    });

    test('does not show environment tag when environment is "other"', () => {
      const { container } = render(
        <StudioDesktopHeader {...defaultProps} activeConnection={connectionWithOtherEnv} />
      );
      const typeSubtitle = container.querySelector('.font-mono.uppercase');
      // Neither environment name nor "Online" rendered — both conditions skip "other"
      expect(typeSubtitle?.textContent).not.toContain('other');
    });

    test('shows "Online" when no environment is set', () => {
      const { container } = render(<StudioDesktopHeader {...defaultProps} />);
      expect(container.textContent).toContain('Online');
    });

    test('does not show "Online" when valid environment is set', () => {
      const { container } = render(
        <StudioDesktopHeader {...defaultProps} activeConnection={connectionWithEnv} />
      );
      // "Online" should not appear in the type subtitle (the pulse section is separate)
      const typeSubtitle = container.querySelector('.font-mono.uppercase');
      expect(typeSubtitle?.textContent).toContain('production');
      expect(typeSubtitle?.textContent).not.toContain('Online');
    });
  });

  // ── Connection Pulse Indicator ──

  describe('connection pulse', () => {
    test('does not render pulse indicator when null', () => {
      const { container } = render(
        <StudioDesktopHeader {...defaultProps} connectionPulse={null} />
      );
      expect(container.querySelector('[title^="Connection:"]')).toBeNull();
    });

    test('renders healthy pulse with "Online" text and green dot', () => {
      const { container } = render(
        <StudioDesktopHeader {...defaultProps} connectionPulse="healthy" />
      );
      const pulseContainer = container.querySelector('[title="Connection: healthy"]');
      expect(pulseContainer).toBeTruthy();

      const dot = pulseContainer!.querySelector('.rounded-full');
      expect(dot?.className).toContain('bg-emerald-500');
      expect(dot?.className).toContain('animate-pulse');

      // "Online" text in the pulse section
      expect(pulseContainer!.textContent).toContain('Online');
    });

    test('renders degraded pulse with "Slow" text and amber dot', () => {
      const { container } = render(
        <StudioDesktopHeader {...defaultProps} connectionPulse="degraded" />
      );
      const pulseContainer = container.querySelector('[title="Connection: degraded"]');
      expect(pulseContainer).toBeTruthy();

      const dot = pulseContainer!.querySelector('.rounded-full');
      expect(dot?.className).toContain('bg-amber-500');
      expect(dot?.className).not.toContain('animate-pulse');

      expect(pulseContainer!.textContent).toContain('Slow');
    });

    test('renders error pulse with "Error" text and red dot', () => {
      const { container } = render(
        <StudioDesktopHeader {...defaultProps} connectionPulse="error" />
      );
      const pulseContainer = container.querySelector('[title="Connection: error"]');
      expect(pulseContainer).toBeTruthy();

      const dot = pulseContainer!.querySelector('.rounded-full');
      expect(dot?.className).toContain('bg-red-500');
      expect(dot?.className).not.toContain('animate-pulse');

      expect(pulseContainer!.textContent).toContain('Error');
    });
  });

  // ── Monitoring Button ──

  describe('monitoring button', () => {
    test('renders monitoring button', () => {
      const { getAllByText } = render(<StudioDesktopHeader {...defaultProps} />);
      // Monitoring appears as standalone button AND in dropdown
      expect(getAllByText(/Monitoring/).length).toBeGreaterThanOrEqual(1);
    });

    test('navigates to /monitoring on click', () => {
      const { getAllByText } = render(<StudioDesktopHeader {...defaultProps} />);
      // Click the standalone button (the one inside <button>)
      const monitoringBtn = getAllByText(/Monitoring/).find(
        (el) => el.closest('button') !== null
      );
      expect(monitoringBtn).toBeTruthy();
      fireEvent.click(monitoringBtn!);
      expect(mockRouterPush).toHaveBeenCalledWith('/monitoring');
    });
  });

  // ── User Dropdown Menu ──

  describe('user dropdown menu', () => {
    test('renders user dropdown when user exists', () => {
      const { container } = render(<StudioDesktopHeader {...defaultProps} />);
      expect(container.querySelector('[data-testid="dropdown-menu"]')).toBeTruthy();
    });

    test('does not render user dropdown when user is null', () => {
      const { container } = render(
        <StudioDesktopHeader {...defaultProps} user={null} />
      );
      expect(container.querySelector('[data-testid="dropdown-menu"]')).toBeNull();
    });

    test('shows Admin Dashboard menu item for admin users', () => {
      const { getByText } = render(<StudioDesktopHeader {...defaultProps} isAdmin={true} />);
      expect(getByText('Admin Dashboard')).toBeTruthy();
    });

    test('hides Admin Dashboard menu item for non-admin users', () => {
      const { queryByText } = render(
        <StudioDesktopHeader {...defaultProps} isAdmin={false} />
      );
      expect(queryByText('Admin Dashboard')).toBeNull();
    });

    test('navigates to /admin when Admin Dashboard clicked', () => {
      const { getByText } = render(<StudioDesktopHeader {...defaultProps} isAdmin={true} />);
      fireEvent.click(getByText('Admin Dashboard'));
      expect(mockRouterPush).toHaveBeenCalledWith('/admin');
    });

    test('shows Monitoring in dropdown menu', () => {
      const { getAllByText } = render(<StudioDesktopHeader {...defaultProps} />);
      // Monitoring appears both as standalone button and in dropdown
      const monitoringElements = getAllByText('Monitoring');
      expect(monitoringElements.length).toBeGreaterThanOrEqual(2);
    });

    test('navigates to /monitoring from dropdown menu item', () => {
      const { getAllByText } = render(<StudioDesktopHeader {...defaultProps} />);
      // The dropdown Monitoring item is the second one
      const monitoringItems = getAllByText('Monitoring');
      const dropdownMonitoring = monitoringItems.find(
        (el) => el.closest('[role="menuitem"]') !== null
      );
      expect(dropdownMonitoring).toBeTruthy();
      fireEvent.click(dropdownMonitoring!.closest('[role="menuitem"]')!);
      expect(mockRouterPush).toHaveBeenCalledWith('/monitoring');
    });

    test('shows Logout menu item', () => {
      const { getByText } = render(<StudioDesktopHeader {...defaultProps} />);
      expect(getByText('Logout')).toBeTruthy();
    });

    test('calls onLogout when Logout clicked', () => {
      const onLogout = mock(() => {});
      const { getByText } = render(
        <StudioDesktopHeader {...defaultProps} onLogout={onLogout} />
      );
      fireEvent.click(getByText('Logout'));
      expect(onLogout).toHaveBeenCalledTimes(1);
    });

    test('Logout menu item has red styling', () => {
      const { getByText } = render(<StudioDesktopHeader {...defaultProps} />);
      const logoutItem = getByText('Logout').closest('[role="menuitem"]');
      expect(logoutItem?.className).toContain('text-red-400');
    });
  });

  // ── Version Badge ──

  describe('version badge', () => {
    test('renders version from env variable', () => {
      process.env.NEXT_PUBLIC_APP_VERSION = '2.5.0';
      const { container } = render(<StudioDesktopHeader {...defaultProps} />);
      expect(container.textContent).toContain('v2.5.0');
    });

    test('renders empty version gracefully when env not set', () => {
      delete process.env.NEXT_PUBLIC_APP_VERSION;
      const { container } = render(<StudioDesktopHeader {...defaultProps} />);
      expect(container.textContent).toContain('v');
    });
  });

  // ── Combinations / Edge Cases ──

  describe('edge cases', () => {
    test('renders correctly with no connection and non-admin user', () => {
      const { getByText, queryByText } = render(
        <StudioDesktopHeader
          activeConnection={null}
          connectionPulse={null}
          user={{ role: 'user' }}
          isAdmin={false}
          onLogout={mock(() => {})}
        />
      );
      expect(getByText('Quick Access')).toBeTruthy();
      expect(queryByText('Admin Dashboard')).toBeNull();
      expect(getByText('Logout')).toBeTruthy();
    });

    test('renders correctly with connection, healthy pulse, admin user', () => {
      const { getByText, container } = render(
        <StudioDesktopHeader
          activeConnection={connectionWithEnv}
          connectionPulse="healthy"
          user={{ role: 'admin' }}
          isAdmin={true}
          onLogout={mock(() => {})}
        />
      );
      expect(getByText('prod-db')).toBeTruthy();
      expect(container.textContent).toContain('mysql');
      expect(container.textContent).toContain('production');
      expect(container.querySelector('[title="Connection: healthy"]')).toBeTruthy();
      expect(getByText('Admin Dashboard')).toBeTruthy();
    });

    test('user with undefined role still renders dropdown', () => {
      const { container } = render(
        <StudioDesktopHeader {...defaultProps} user={{}} />
      );
      expect(container.querySelector('[data-testid="dropdown-menu"]')).toBeTruthy();
    });

    test('renders header as sticky with correct z-index class', () => {
      const { container } = render(<StudioDesktopHeader {...defaultProps} />);
      const header = container.querySelector('header');
      expect(header?.className).toContain('sticky');
      expect(header?.className).toContain('z-30');
    });

    test('header is hidden on mobile (hidden md:flex)', () => {
      const { container } = render(<StudioDesktopHeader {...defaultProps} />);
      const header = container.querySelector('header');
      expect(header?.className).toContain('hidden');
      expect(header?.className).toContain('md:flex');
    });
  });
});
