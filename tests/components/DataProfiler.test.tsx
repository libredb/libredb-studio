import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { mock } from 'bun:test';

// Mock data-masking before component import
mock.module('@/lib/data-masking', () => ({
  detectSensitiveColumns: mock(() => new Map()),
  maskValue: mock(() => '****'),
}));

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, fireEvent, within, waitFor, cleanup } from '@testing-library/react';
import React from 'react';
import { mockGlobalFetch, restoreGlobalFetch } from '../helpers/mock-fetch';

import { DataProfiler } from '@/components/DataProfiler';
import { mockPostgresConnection } from '../fixtures/connections';
import { mockUsersTable } from '../fixtures/schemas';

// =============================================================================
// DataProfiler Tests
// =============================================================================

const mockProfileResponse = {
  tableName: 'users',
  totalRows: 100,
  columns: [
    {
      name: 'id',
      type: 'integer',
      totalRows: 100,
      nullCount: 0,
      nullPercent: 0,
      distinctCount: 100,
      minValue: '1',
      maxValue: '100',
      sampleValues: ['1', '2', '3'],
    },
    {
      name: 'name',
      type: 'varchar(255)',
      totalRows: 100,
      nullCount: 5,
      nullPercent: 5,
      distinctCount: 90,
      minValue: 'Alice',
      maxValue: 'Zara',
      sampleValues: ['Alice', 'Bob', 'Carol'],
    },
    {
      name: 'email',
      type: 'varchar(255)',
      totalRows: 100,
      nullCount: 0,
      nullPercent: 0,
      distinctCount: 100,
      minValue: 'alice@example.com',
      maxValue: 'zara@example.com',
      sampleValues: ['alice@example.com', 'bob@example.com'],
    },
  ],
};

function createDefaultProps(overrides: Partial<Parameters<typeof DataProfiler>[0]> = {}) {
  return {
    isOpen: true,
    onClose: mock(() => {}),
    tableName: 'users',
    tableSchema: mockUsersTable,
    connection: mockPostgresConnection,
    schemaContext: '',
    databaseType: 'postgres',
    ...overrides,
  };
}

describe('DataProfiler', () => {
  beforeEach(() => {
    mockGlobalFetch({
      '/api/db/profile': { ok: true, json: mockProfileResponse },
      '/api/ai/describe-schema': { ok: false, status: 500, json: { error: 'AI not configured' } },
    });
  });

  afterEach(() => {
    cleanup();
    restoreGlobalFetch();
  });

  // ── Does not render when isOpen is false ──────────────────────────────────

  test('does not render when isOpen is false', () => {
    const props = createDefaultProps({ isOpen: false });
    const { container } = render(<DataProfiler {...props} />);

    expect(container.innerHTML).toBe('');
  });

  // ── Renders dialog when isOpen is true ────────────────────────────────────

  test('renders dialog when isOpen is true', () => {
    const props = createDefaultProps({ isOpen: true });
    const { container } = render(<DataProfiler {...props} />);
    const view = within(container);

    expect(view.queryByText('Data Profiler')).not.toBeNull();
  });

  // ── Shows table name in title ─────────────────────────────────────────────

  test('shows table name in title area', () => {
    const props = createDefaultProps({ tableName: 'users' });
    const { container } = render(<DataProfiler {...props} />);
    const view = within(container);

    expect(view.queryByText('users')).not.toBeNull();
  });

  // ── Loading state during fetch ────────────────────────────────────────────

  test('shows loading state during fetch', () => {
    restoreGlobalFetch();
    // Use a fetch mock that never resolves
    mockGlobalFetch({
      '/api/db/profile': () => new Promise(() => {}) as unknown,
    });

    const props = createDefaultProps();
    const { container } = render(<DataProfiler {...props} />);
    const view = within(container);

    expect(view.queryByText('Profiling users...')).not.toBeNull();
  });

  // ── Displays profiled data after successful fetch ─────────────────────────

  test('displays profiled data after successful fetch', async () => {
    const props = createDefaultProps();
    const { container } = render(<DataProfiler {...props} />);
    const view = within(container);

    await waitFor(() => {
      expect(view.queryByText('Total Rows')).not.toBeNull();
    });

    // Summary stats — "100" appears in multiple places (Total Rows and distinct count)
    const allHundreds = view.queryAllByText('100');
    expect(allHundreds.length).toBeGreaterThan(0);
    expect(view.queryByText('Column Profiles')).not.toBeNull();
  });

  // ── Close button fires onClose ────────────────────────────────────────────

  test('close button fires onClose callback', () => {
    const onClose = mock(() => {});
    const props = createDefaultProps({ onClose });
    const { container } = render(<DataProfiler {...props} />);

    // The close button is in the header with text-zinc-500 class
    const closeButton = container.querySelector('button.text-zinc-500');
    expect(closeButton).not.toBeNull();

    fireEvent.click(closeButton!);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
