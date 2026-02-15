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
import { mockGlobalFetch, restoreGlobalFetch, type MockFetchResponse } from '../helpers/mock-fetch';

import { DataProfiler } from '@/components/DataProfiler';
import { detectSensitiveColumns, maskValue } from '@/lib/data-masking';
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
      '/api/db/profile': (() => new Promise(() => {})) as () => Promise<MockFetchResponse>,
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

  // ── Null bar coloring: emerald for <20% ──────────────────────────────────

  test('null bar uses emerald color when nullPercent < 20', async () => {
    const profileWithLowNull = {
      tableName: 'users',
      totalRows: 100,
      columns: [
        { name: 'id', type: 'integer', totalRows: 100, nullCount: 10, nullPercent: 10, distinctCount: 90, minValue: '1', maxValue: '100', sampleValues: ['1'] },
      ],
    };

    restoreGlobalFetch();
    mockGlobalFetch({
      '/api/db/profile': { ok: true, json: profileWithLowNull },
      '/api/ai/describe-schema': { ok: false, status: 500, json: { error: 'AI not configured' } },
    });

    const props = createDefaultProps();
    const { container } = render(<DataProfiler {...props} />);

    await waitFor(() => {
      expect(within(container).queryByText('Column Profiles')).not.toBeNull();
    });

    // The null bar inner div should have emerald class
    const nullBar = container.querySelector('.bg-emerald-500');
    expect(nullBar).not.toBeNull();

    // The percent label should also be emerald
    const nullLabel = within(container).queryByText('10% null');
    expect(nullLabel).not.toBeNull();
    expect(nullLabel!.className).toContain('text-emerald-400');
  });

  // ── Null bar coloring: amber for 20-50% ──────────────────────────────────

  test('null bar uses amber color when nullPercent is between 20 and 50', async () => {
    const profileWithMidNull = {
      tableName: 'users',
      totalRows: 100,
      columns: [
        { name: 'status', type: 'varchar', totalRows: 100, nullCount: 35, nullPercent: 35, distinctCount: 65, minValue: 'A', maxValue: 'Z', sampleValues: ['A'] },
      ],
    };

    restoreGlobalFetch();
    mockGlobalFetch({
      '/api/db/profile': { ok: true, json: profileWithMidNull },
      '/api/ai/describe-schema': { ok: false, status: 500, json: { error: 'AI not configured' } },
    });

    const props = createDefaultProps();
    const { container } = render(<DataProfiler {...props} />);

    await waitFor(() => {
      expect(within(container).queryByText('Column Profiles')).not.toBeNull();
    });

    const nullBar = container.querySelector('.bg-amber-500');
    expect(nullBar).not.toBeNull();

    const nullLabel = within(container).queryByText('35% null');
    expect(nullLabel).not.toBeNull();
    expect(nullLabel!.className).toContain('text-amber-400');
  });

  // ── Null bar coloring: red for >50% ──────────────────────────────────────

  test('null bar uses red color when nullPercent > 50', async () => {
    const profileWithHighNull = {
      tableName: 'users',
      totalRows: 100,
      columns: [
        { name: 'notes', type: 'text', totalRows: 100, nullCount: 75, nullPercent: 75, distinctCount: 25, minValue: 'a', maxValue: 'z', sampleValues: ['a'] },
      ],
    };

    restoreGlobalFetch();
    mockGlobalFetch({
      '/api/db/profile': { ok: true, json: profileWithHighNull },
      '/api/ai/describe-schema': { ok: false, status: 500, json: { error: 'AI not configured' } },
    });

    const props = createDefaultProps();
    const { container } = render(<DataProfiler {...props} />);

    await waitFor(() => {
      expect(within(container).queryByText('Column Profiles')).not.toBeNull();
    });

    const nullBar = container.querySelector('.bg-red-500');
    expect(nullBar).not.toBeNull();

    const nullLabel = within(container).queryByText('75% null');
    expect(nullLabel).not.toBeNull();
    expect(nullLabel!.className).toContain('text-red-400');
  });

  // ── Min/Max value display ────────────────────────────────────────────────

  test('displays min and max values for each column', async () => {
    const props = createDefaultProps();
    const { container } = render(<DataProfiler {...props} />);
    const view = within(container);

    await waitFor(() => {
      expect(view.queryByText('Column Profiles')).not.toBeNull();
    });

    // Check min/max labels exist in the rendered output
    const allSpans = container.querySelectorAll('span');
    const minTexts: string[] = [];
    const maxTexts: string[] = [];
    allSpans.forEach((el) => {
      if (el.textContent?.startsWith('min:')) minTexts.push(el.textContent);
      if (el.textContent?.startsWith('max:')) maxTexts.push(el.textContent);
    });

    // We have 3 columns with min/max values
    expect(minTexts.length).toBe(3);
    expect(maxTexts.length).toBe(3);

    // Verify specific values appear (use queryAllByText since values may appear in both min and sample)
    const aliceMatches = view.queryAllByText('Alice');
    expect(aliceMatches.length).toBeGreaterThan(0);
    const zaraMatches = view.queryAllByText('Zara');
    expect(zaraMatches.length).toBeGreaterThan(0);
  });

  // ── Sample values rendered as chips ──────────────────────────────────────

  test('renders sample values as styled chips', async () => {
    const props = createDefaultProps();
    const { container } = render(<DataProfiler {...props} />);
    const view = within(container);

    await waitFor(() => {
      expect(view.queryByText('Column Profiles')).not.toBeNull();
    });

    // Sample values from mockProfileResponse — use queryAllByText since values may appear in multiple places
    const onesMatches = view.queryAllByText('1');
    expect(onesMatches.length).toBeGreaterThan(0);

    // 'Bob' and 'Carol' are unique sample values from name column
    expect(view.queryByText('Bob')).not.toBeNull();
    expect(view.queryByText('Carol')).not.toBeNull();

    // Chips should have the bg-zinc-800 + rounded + font-mono classes
    const chips = container.querySelectorAll('span.bg-zinc-800.rounded.font-mono');
    expect(chips.length).toBeGreaterThanOrEqual(8); // 3 + 3 + 2 sample values
  });

  // ── AI summary streaming display ─────────────────────────────────────────

  test('displays AI summary when streaming succeeds', async () => {
    const aiText = 'This table stores user account data with good data quality.';
    restoreGlobalFetch();

    // Override fetch directly to control the streaming response
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const pathname = new URL(url, 'http://localhost:3000').pathname;

      if (pathname.includes('/api/db/profile')) {
        return new Response(JSON.stringify(mockProfileResponse), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }

      if (pathname.includes('/api/ai/describe-schema')) {
        // Create a readable stream that yields the AI text
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(aiText));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        });
      }

      return new Response('Not found', { status: 404 });
    }) as unknown as typeof fetch;

    const props = createDefaultProps();
    const { container } = render(<DataProfiler {...props} />);
    const view = within(container);

    // Wait for profile data to load first
    await waitFor(() => {
      expect(view.queryByText('Column Profiles')).not.toBeNull();
    });

    // The AI section should appear with the streamed content
    await waitFor(() => {
      expect(view.queryByText('AI Analysis')).not.toBeNull();
    }, { timeout: 3000 });

    // The actual AI text should be displayed
    await waitFor(() => {
      expect(view.queryByText(aiText)).not.toBeNull();
    }, { timeout: 3000 });

    globalThis.fetch = originalFetch;
  });

  // ── Profile fetch error handling ─────────────────────────────────────────

  test('displays error message when profile fetch fails', async () => {
    restoreGlobalFetch();
    mockGlobalFetch({
      '/api/db/profile': { ok: false, status: 500, json: { error: 'Connection refused' } },
    });

    const props = createDefaultProps();
    const { container } = render(<DataProfiler {...props} />);
    const view = within(container);

    await waitFor(() => {
      expect(view.queryByText('Connection refused')).not.toBeNull();
    });

    // Error should be in a red-styled container
    const errorDiv = container.querySelector('.bg-red-500\\/10');
    expect(errorDiv).not.toBeNull();
  });

  // ── Column error message display ─────────────────────────────────────────

  test('displays column-level error when col.error is present', async () => {
    const profileWithColError = {
      tableName: 'users',
      totalRows: 100,
      columns: [
        { name: 'id', type: 'integer', totalRows: 100, nullCount: 0, nullPercent: 0, distinctCount: 100, error: 'Permission denied for column' },
      ],
    };

    restoreGlobalFetch();
    mockGlobalFetch({
      '/api/db/profile': { ok: true, json: profileWithColError },
      '/api/ai/describe-schema': { ok: false, status: 500, json: { error: 'AI not configured' } },
    });

    const props = createDefaultProps();
    const { container } = render(<DataProfiler {...props} />);
    const view = within(container);

    await waitFor(() => {
      expect(view.queryByText('Permission denied for column')).not.toBeNull();
    });

    // Error text should have amber color class
    const errorEl = view.queryByText('Permission denied for column');
    expect(errorEl).not.toBeNull();
    expect(errorEl!.className).toContain('text-amber-400');
  });

  // ── Sensitive column masking (lock icon + masked values) ─────────────────

  test('shows lock icon and masked values for sensitive columns', async () => {
    // Override detectSensitiveColumns to return a map with 'email' as sensitive
    const mockRule = { pattern: /email/i, label: 'Email', mask: (v: string) => v };
    (detectSensitiveColumns as ReturnType<typeof mock>).mockImplementation(
      () => new Map([['email', mockRule]])
    );
    (maskValue as ReturnType<typeof mock>).mockImplementation(() => '****');

    const props = createDefaultProps();
    const { container } = render(<DataProfiler {...props} />);
    const view = within(container);

    await waitFor(() => {
      expect(view.queryByText('Column Profiles')).not.toBeNull();
    });

    // Lock icon should be present (title attribute = 'Sensitive column - values masked')
    const lockIcon = container.querySelector('[title="Sensitive column - values masked"]');
    expect(lockIcon).not.toBeNull();

    // Masked values should appear as '****'
    const maskedValues = view.queryAllByText('****');
    expect(maskedValues.length).toBeGreaterThan(0);

    // Restore default mock
    (detectSensitiveColumns as ReturnType<typeof mock>).mockImplementation(() => new Map());
  });

  // ── No fetch when connection is null ─────────────────────────────────────

  test('does not fetch profile when connection is null', () => {
    const fetchMock = restoreGlobalFetch();
    void fetchMock;
    const fetchSpy = mockGlobalFetch({
      '/api/db/profile': { ok: true, json: mockProfileResponse },
    });

    const props = createDefaultProps({ connection: null });
    const { container } = render(<DataProfiler {...props} />);
    const view = within(container);

    // Should not show loading state or profile data
    expect(view.queryByText('Profiling users...')).toBeNull();

    // Fetch should not have been called
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── No fetch when tableSchema is null ────────────────────────────────────

  test('does not fetch profile when tableSchema is null', () => {
    restoreGlobalFetch();
    const fetchSpy = mockGlobalFetch({
      '/api/db/profile': { ok: true, json: mockProfileResponse },
    });

    const props = createDefaultProps({ tableSchema: null });
    const { container } = render(<DataProfiler {...props} />);
    const view = within(container);

    // Should not show loading or profile data
    expect(view.queryByText('Profiling users...')).toBeNull();

    // The effect calls fetchProfile which returns early if !tableSchema,
    // but it still calls fetch because the guard is inside fetchProfile.
    // Actually looking at the code: useEffect guards on `connection` but not `tableSchema`.
    // fetchProfile guards on both: `if (!connection || !tableSchema) return;`
    // But the useEffect only checks: `if (isOpen && tableName && connection)`
    // Since connection is provided but tableSchema is null, the effect fires but fetchProfile returns early.
    // So fetch should NOT have been called.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // ── Average null % in summary ────────────────────────────────────────────

  test('displays correct average null percentage in summary', async () => {
    // mockProfileResponse columns: id=0%, name=5%, email=0% → avg = (0+5+0)/3 ≈ 2%
    const props = createDefaultProps();
    const { container } = render(<DataProfiler {...props} />);
    const view = within(container);

    await waitFor(() => {
      expect(view.queryByText('Avg Null %')).not.toBeNull();
    });

    // Math.round((0 + 5 + 0) / 3) = Math.round(1.666) = 2
    expect(view.queryByText('2%')).not.toBeNull();
  });

  // ── Columns count in summary ─────────────────────────────────────────────

  test('displays correct column count in summary', async () => {
    const props = createDefaultProps();
    const { container } = render(<DataProfiler {...props} />);

    await waitFor(() => {
      expect(within(container).queryByText('Columns')).not.toBeNull();
    });

    // Find the Columns summary card and verify its value
    // The summary grid has 3 cards; the Columns card contains "3"
    const summaryCards = container.querySelectorAll('.bg-\\[\\#0a0a0a\\]');
    const columnsCard = Array.from(summaryCards).find(
      (card) => card.textContent?.includes('Columns')
    );
    expect(columnsCard).not.toBeNull();
    expect(columnsCard!.textContent).toContain('3');
  });

  // ── State reset on close/reopen ──────────────────────────────────────────

  test('resets state when closed and reopened', async () => {
    const props = createDefaultProps();
    const { container, rerender } = render(<DataProfiler {...props} />);
    const view = within(container);

    // Wait for profile data to load
    await waitFor(() => {
      expect(view.queryByText('Column Profiles')).not.toBeNull();
    });

    // Close the profiler
    rerender(<DataProfiler {...createDefaultProps({ isOpen: false })} />);

    // Should not render anything when closed
    expect(container.innerHTML).toBe('');

    // Setup a different profile response for reopen
    restoreGlobalFetch();
    const newProfile = {
      tableName: 'users',
      totalRows: 999,
      columns: [
        { name: 'id', type: 'integer', totalRows: 999, nullCount: 0, nullPercent: 0, distinctCount: 999, minValue: '1', maxValue: '999', sampleValues: ['1'] },
      ],
    };
    mockGlobalFetch({
      '/api/db/profile': { ok: true, json: newProfile },
      '/api/ai/describe-schema': { ok: false, status: 500, json: { error: 'AI not configured' } },
    });

    // Reopen
    rerender(<DataProfiler {...createDefaultProps({ isOpen: true })} />);

    // Wait for new data
    await waitFor(() => {
      expect(within(container).queryByText('Column Profiles')).not.toBeNull();
    });

    // Should show new total rows (999) — may appear in multiple places (totalRows, distinct, maxValue)
    const nineNineNine = within(container).queryAllByText('999');
    expect(nineNineNine.length).toBeGreaterThan(0);
  });
});
