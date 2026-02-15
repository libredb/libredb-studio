import { describe, test, expect, mock } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DatabaseConnection } from '@/lib/types';

// =============================================================================
// Test Data
// =============================================================================

const mockConnection: DatabaseConnection = {
  id: 'conn-1',
  name: 'Test PG',
  type: 'postgres',
  host: 'localhost',
  port: 5432,
  database: 'testdb',
  user: 'admin',
  password: 'secret',
  createdAt: new Date(),
};

const mockConnection2: DatabaseConnection = {
  id: 'conn-2',
  name: 'Test MySQL',
  type: 'mysql',
  host: 'localhost',
  port: 3306,
  database: 'mydb',
  user: 'root',
  password: 'pass',
  createdAt: new Date(),
};

const noop = () => {};

const defaultProps = {
  connections: [mockConnection],
  activeConnection: mockConnection,
  connectionPulse: 'healthy' as const,
  user: { role: 'admin' },
  isAdmin: true,
  activeMobileTab: 'editor' as const,
  isExecuting: false,
  currentQuery: 'SELECT * FROM users',
  queryEditorRef: { current: null },
  onSelectConnection: noop,
  onAddConnection: noop,
  onLogout: noop,
  onSaveQuery: noop,
  onClearQuery: noop,
  onExecuteQuery: noop,
  onCancelQuery: noop,
};

// Mock next/navigation before importing the component
mock.module('next/navigation', () => ({
  useRouter: () => ({ push: noop, replace: noop, prefetch: noop, back: noop }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

// Import after mocking
const { StudioMobileHeader } = await import('@/components/studio/StudioMobileHeader');

// =============================================================================
// Note: Radix DropdownMenuContent is portaled and NOT rendered in SSR
// (renderToStaticMarkup). Only trigger buttons and non-dropdown content
// appear in the static HTML. Tests check trigger text, badges, and
// conditional rendering of Row 1 / Row 2.
// =============================================================================

describe('StudioMobileHeader', () => {
  // ── Basic rendering ────────────────────────────────────────────────────

  test('renders header element with mobile-only class', () => {
    const html = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} />
    );
    expect(html).toContain('<header');
    expect(html).toContain('md:hidden');
    expect(html).toContain('sticky');
    expect(html).toContain('backdrop-blur-xl');
  });

  // ── Active connection name in trigger ──────────────────────────────────

  test('displays active connection name in trigger button', () => {
    const html = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} />
    );
    expect(html).toContain('Test PG');
  });

  test('displays "Select DB" when no active connection', () => {
    const html = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} activeConnection={null} />
    );
    expect(html).toContain('Select DB');
  });

  // ── Database icon in trigger ───────────────────────────────────────────

  test('renders Database icon in connection trigger', () => {
    const html = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} />
    );
    expect(html).toContain('lucide-database');
    expect(html).toContain('text-blue-400');
  });

  // ── ChevronDown icon in trigger ────────────────────────────────────────

  test('renders ChevronDown icon in connection trigger', () => {
    const html = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} />
    );
    expect(html).toContain('lucide-chevron-down');
  });

  // ── Online badge ───────────────────────────────────────────────────────

  test('shows Online badge when connection is active', () => {
    const html = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} />
    );
    expect(html).toContain('Online');
    expect(html).toContain('text-emerald-500');
    expect(html).toContain('bg-emerald-500/10');
  });

  test('hides Online badge when no active connection', () => {
    const html = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} activeConnection={null} />
    );
    expect(html).not.toContain('Online');
  });

  // ── Monitoring (Gauge) button ──────────────────────────────────────────

  test('renders monitoring gauge button', () => {
    const html = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} />
    );
    expect(html).toContain('lucide-gauge');
    expect(html).toContain('hover:text-purple-400');
  });

  // ── Connection pulse indicator ─────────────────────────────────────────

  test('renders healthy pulse indicator', () => {
    const html = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} connectionPulse="healthy" />
    );
    expect(html).toContain('bg-emerald-500');
    expect(html).toContain('animate-pulse');
    expect(html).toContain('Connection: healthy');
  });

  test('renders degraded pulse indicator', () => {
    const html = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} connectionPulse="degraded" />
    );
    expect(html).toContain('bg-amber-500');
    expect(html).toContain('Connection: degraded');
  });

  test('renders error pulse indicator', () => {
    const html = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} connectionPulse="error" />
    );
    expect(html).toContain('bg-red-500');
    expect(html).toContain('Connection: error');
  });

  test('hides pulse indicator when null', () => {
    const html = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} connectionPulse={null} />
    );
    expect(html).not.toContain('Connection:');
    expect(html).not.toContain('bg-amber-500');
  });

  // ── User trigger button ────────────────────────────────────────────────

  test('renders user trigger button when user exists', () => {
    const html = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} />
    );
    expect(html).toContain('lucide-user');
  });

  test('hides user trigger button when user is null', () => {
    const html = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} user={null} />
    );
    expect(html).not.toContain('lucide-user');
  });

  // ── Editor action bar (Row 2) conditionally rendered ───────────────────

  test('shows editor action bar when activeMobileTab is editor', () => {
    const html = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} activeMobileTab="editor" />
    );
    // Row 2 container
    expect(html).toContain('bg-[#080808]');
    // AI button (not inside dropdown, directly visible)
    expect(html).toContain('lucide-sparkles');
    expect(html).toContain('>AI<');
    // More options trigger
    expect(html).toContain('lucide-ellipsis-vertical');
  });

  test('hides editor action bar when activeMobileTab is database', () => {
    const html = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} activeMobileTab="database" />
    );
    expect(html).not.toContain('bg-[#080808]');
    expect(html).not.toContain('lucide-sparkles');
    expect(html).not.toContain('RUN');
  });

  test('hides editor action bar when activeMobileTab is schema', () => {
    const html = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} activeMobileTab="schema" />
    );
    expect(html).not.toContain('bg-[#080808]');
    expect(html).not.toContain('CANCEL');
    expect(html).not.toContain('lucide-play');
  });

  // ── RUN / CANCEL button ────────────────────────────────────────────────

  test('shows RUN button when not executing', () => {
    const html = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} isExecuting={false} />
    );
    expect(html).toContain('RUN');
    expect(html).toContain('bg-blue-600');
    expect(html).toContain('lucide-play');
    expect(html).not.toContain('CANCEL');
    expect(html).not.toContain('lucide-square');
  });

  test('shows CANCEL button when executing', () => {
    const html = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} isExecuting={true} />
    );
    expect(html).toContain('CANCEL');
    expect(html).toContain('bg-red-600');
    expect(html).toContain('lucide-square');
    expect(html).not.toContain('RUN');
    expect(html).not.toContain('lucide-play');
  });

  test('disables RUN button when no active connection', () => {
    const html = renderToStaticMarkup(
      <StudioMobileHeader
        {...defaultProps}
        activeConnection={null}
        isExecuting={false}
      />
    );
    expect(html).toContain('disabled');
  });

  // ── Row 1 always visible ───────────────────────────────────────────────

  test('always renders Row 1 regardless of activeMobileTab', () => {
    for (const tab of ['database', 'schema', 'editor'] as const) {
      const html = renderToStaticMarkup(
        <StudioMobileHeader {...defaultProps} activeMobileTab={tab} />
      );
      // Row 1 elements always present
      expect(html).toContain('Test PG');
      expect(html).toContain('Online');
      expect(html).toContain('lucide-gauge');
    }
  });

  // ── Empty connections vs non-empty render different triggers ────────────

  test('renders dropdown trigger with connection name', () => {
    const html = renderToStaticMarkup(
      <StudioMobileHeader
        {...defaultProps}
        connections={[mockConnection, mockConnection2]}
        activeConnection={mockConnection2}
      />
    );
    expect(html).toContain('Test MySQL');
    expect(html).not.toContain('Select DB');
  });

  // ── All three pulse states have different classes ───────────────────────

  test('pulse states are mutually exclusive classes', () => {
    const healthyHtml = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} connectionPulse="healthy" />
    );
    const degradedHtml = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} connectionPulse="degraded" />
    );
    const errorHtml = renderToStaticMarkup(
      <StudioMobileHeader {...defaultProps} connectionPulse="error" />
    );

    // healthy has animate-pulse, others don't
    expect(healthyHtml).toContain('animate-pulse');
    expect(degradedHtml).not.toContain('animate-pulse');
    expect(errorHtml).not.toContain('animate-pulse');

    // Each has unique color
    expect(healthyHtml).toContain('bg-emerald-500');
    expect(degradedHtml).toContain('bg-amber-500');
    expect(errorHtml).toContain('bg-red-500');
  });
});
