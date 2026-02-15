import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VisualExplain, type ExplainPlanResult } from '@/components/VisualExplain';

let originalFetch: typeof globalThis.fetch;

function mockFetchStream(body: string, ok = true, errorBody?: { error: string }) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return mock(() =>
    Promise.resolve({
      ok,
      body: ok ? stream : null,
      json: () => Promise.resolve(errorBody || {}),
    })
  );
}

// Sample plan with Seq Scan on large table + row estimate mismatch
const samplePlan: ExplainPlanResult[] = [
  {
    Plan: {
      'Node Type': 'Seq Scan',
      'Relation Name': 'users',
      'Actual Rows': 15000,
      'Plan Rows': 100,
      'Actual Total Time': 42.5,
      'Total Cost': 120,
      'Shared Hit Blocks': 80,
      'Shared Read Blocks': 5,
      Filter: 'status = active',
      Plans: [
        {
          'Node Type': 'Index Scan',
          'Relation Name': 'orders',
          'Actual Rows': 200,
          'Plan Rows': 200,
          'Actual Total Time': 1.2,
          'Total Cost': 10,
          'Index Name': 'idx_orders_user_id',
        },
      ],
    },
    'Execution Time': 42.5,
    'Planning Time': 0.8,
  },
];

// Healthy plan — no warnings
const healthyPlan: ExplainPlanResult[] = [
  {
    Plan: {
      'Node Type': 'Index Scan',
      'Actual Rows': 10,
      'Plan Rows': 10,
      'Actual Total Time': 0.5,
      'Total Cost': 5,
      'Index Name': 'idx_pk',
    },
    'Execution Time': 0.5,
    'Planning Time': 0.1,
  },
];

// Plan with expensive sort
const sortPlan: ExplainPlanResult[] = [
  {
    Plan: {
      'Node Type': 'Sort',
      'Actual Rows': 5000,
      'Plan Rows': 5000,
      'Actual Total Time': 250,
      'Total Cost': 300,
    },
    'Execution Time': 250,
    'Planning Time': 0.5,
  },
];

// Plan with high nested loop count
const nestedLoopPlan: ExplainPlanResult[] = [
  {
    Plan: {
      'Node Type': 'Nested Loop',
      'Actual Rows': 50000,
      'Plan Rows': 100,
      'Actual Total Time': 800,
      'Total Cost': 900,
      'Actual Loops': 5000,
    },
    'Execution Time': 800,
    'Planning Time': 1.0,
  },
];

describe('VisualExplain', () => {
  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() => Promise.resolve(new Response('', { status: 200 }))) as never;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  // -----------------------------------------------------------------------
  // Empty state
  // -----------------------------------------------------------------------

  test('shows empty state when plan is null', () => {
    const { queryByText } = render(<VisualExplain plan={null} />);
    expect(queryByText('No execution plan')).not.toBeNull();
    expect(queryByText(/Run a SELECT query/)).not.toBeNull();
  });

  test('shows empty state when plan is empty array', () => {
    const { queryByText } = render(<VisualExplain plan={[]} />);
    expect(queryByText('No execution plan')).not.toBeNull();
  });

  test('shows empty state when plan is undefined', () => {
    const { queryByText } = render(<VisualExplain plan={undefined} />);
    expect(queryByText('No execution plan')).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Header stats
  // -----------------------------------------------------------------------

  test('renders execution time, rows, and cost in header', () => {
    const { queryByText } = render(<VisualExplain plan={samplePlan} />);
    expect(queryByText('execution')).not.toBeNull();
    expect(queryByText('rows')).not.toBeNull();
    expect(queryByText('cost')).not.toBeNull();
  });

  test('displays formatted execution time', () => {
    const { queryAllByText } = render(<VisualExplain plan={samplePlan} />);
    // 42.50ms appears in header + insights + plan node
    expect(queryAllByText('42.50ms').length).toBeGreaterThan(0);
  });

  test('displays formatted row count', () => {
    const { queryByText } = render(<VisualExplain plan={samplePlan} />);
    // 15000 + 200 = 15200 → "15.2K"
    expect(queryByText('15.2K')).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Insights tab (default)
  // -----------------------------------------------------------------------

  test('shows Sequential Scan warning for large table', () => {
    const { queryByText } = render(<VisualExplain plan={samplePlan} />);
    expect(queryByText('Performance Issues')).not.toBeNull();
    expect(queryByText('Sequential Scan')).not.toBeNull();
    expect(queryByText(/Full table scan on "users"/)).not.toBeNull();
  });

  test('shows Estimate Mismatch warning', () => {
    const { queryByText } = render(<VisualExplain plan={samplePlan} />);
    expect(queryByText('Estimate Mismatch')).not.toBeNull();
    expect(queryByText(/Statistics may be outdated/)).not.toBeNull();
  });

  test('shows "Query looks good" for healthy plan', () => {
    const { queryByText } = render(<VisualExplain plan={healthyPlan} />);
    expect(queryByText('Query looks good')).not.toBeNull();
    expect(queryByText(/No obvious performance issues/)).not.toBeNull();
  });

  test('shows Expensive Sort warning', () => {
    const { queryByText } = render(<VisualExplain plan={sortPlan} />);
    expect(queryByText('Expensive Sort')).not.toBeNull();
    expect(queryByText(/Sort operation took/)).not.toBeNull();
  });

  test('shows High Loop Count warning for nested loops', () => {
    const { queryByText } = render(<VisualExplain plan={nestedLoopPlan} />);
    expect(queryByText('High Loop Count')).not.toBeNull();
    expect(queryByText(/N\+1 problem/)).not.toBeNull();
  });

  test('renders insight metrics (Cache Hit Rate, Operations, Execution)', () => {
    const { queryByText } = render(<VisualExplain plan={samplePlan} />);
    expect(queryByText('Cache Hit Rate')).not.toBeNull();
    expect(queryByText('Operations')).not.toBeNull();
    expect(queryByText('Execution')).not.toBeNull();
  });

  test('calculates cache hit rate', () => {
    // 80 hits / (80+5) = 94.1%
    const { queryByText } = render(<VisualExplain plan={samplePlan} />);
    expect(queryByText('94.1%')).not.toBeNull();
  });

  test('shows "Execution Plan" section with plan tree', () => {
    const { queryByText } = render(<VisualExplain plan={samplePlan} />);
    expect(queryByText('Execution Plan')).not.toBeNull();
    expect(queryByText('Seq Scan')).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Tree tab
  // -----------------------------------------------------------------------

  test('switches to tree tab and shows plan nodes', () => {
    const { queryByText } = render(<VisualExplain plan={samplePlan} />);
    fireEvent.click(queryByText('tree')!);
    expect(queryByText('Seq Scan')).not.toBeNull();
    expect(queryByText('users')).not.toBeNull();
  });

  test('tree shows filter info for nodes with filters', () => {
    const { queryByText } = render(<VisualExplain plan={samplePlan} />);
    fireEvent.click(queryByText('tree')!);
    expect(queryByText('status = active')).not.toBeNull();
  });

  test('tree shows index name for index scans', () => {
    const { queryByText } = render(<VisualExplain plan={samplePlan} />);
    fireEvent.click(queryByText('tree')!);
    expect(queryByText('idx_orders_user_id')).not.toBeNull();
  });

  test('tree shows buffer stats', () => {
    const { queryByText } = render(<VisualExplain plan={samplePlan} />);
    fireEvent.click(queryByText('tree')!);
    expect(queryByText(/Cache hits: 80/)).not.toBeNull();
    expect(queryByText(/Disk reads: 5/)).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Raw tab
  // -----------------------------------------------------------------------

  test('switches to raw tab and shows JSON', () => {
    const { container, queryByText } = render(<VisualExplain plan={samplePlan} />);
    fireEvent.click(queryByText('raw')!);
    expect(container.textContent).toContain('"Node Type"');
    expect(container.textContent).toContain('"Seq Scan"');
  });

  // -----------------------------------------------------------------------
  // AI Explain tab
  // -----------------------------------------------------------------------

  test('switches to AI tab and shows initial state', () => {
    const { queryByText } = render(
      <VisualExplain plan={samplePlan} query="SELECT * FROM users" />
    );
    fireEvent.click(queryByText('AI Explain')!);
    expect(queryByText('AI Query Analysis')).not.toBeNull();
    expect(queryByText('Analyze with AI')).not.toBeNull();
  });

  test('AI tab shows disabled state when no query', () => {
    const { queryByText } = render(<VisualExplain plan={samplePlan} />);
    fireEvent.click(queryByText('AI Explain')!);
    expect(queryByText(/Run a query first/)).not.toBeNull();
  });

  test('AI Analyze button calls /api/ai/explain', async () => {
    const user = userEvent.setup();
    globalThis.fetch = mockFetchStream('## Analysis\nThis query performs a seq scan.') as unknown as typeof fetch;

    const { queryByText } = render(
      <VisualExplain plan={samplePlan} query="SELECT * FROM users" databaseType="postgres" />
    );
    fireEvent.click(queryByText('AI Explain')!);
    await user.click(queryByText('Analyze with AI')!);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as unknown as [string, RequestInit];
    expect(fetchCall[0]).toBe('/api/ai/explain');
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.query).toBe('SELECT * FROM users');
    expect(body.databaseType).toBe('postgres');
  });

  test('AI tab displays streamed response', async () => {
    const user = userEvent.setup();
    globalThis.fetch = mockFetchStream('## Performance\nThe query uses a sequential scan.') as unknown as typeof fetch;

    const { queryByText } = render(
      <VisualExplain plan={samplePlan} query="SELECT * FROM users" />
    );
    fireEvent.click(queryByText('AI Explain')!);
    await user.click(queryByText('Analyze with AI')!);

    await waitFor(() => {
      expect(queryByText('Performance')).not.toBeNull();
      expect(queryByText(/sequential scan/)).not.toBeNull();
    });
  });

  test('AI tab shows error on API failure', async () => {
    const user = userEvent.setup();
    globalThis.fetch = mockFetchStream('', false, { error: 'Model unavailable' }) as unknown as typeof fetch;

    const { queryByText } = render(
      <VisualExplain plan={samplePlan} query="SELECT 1" />
    );
    fireEvent.click(queryByText('AI Explain')!);
    await user.click(queryByText('Analyze with AI')!);

    await waitFor(() => {
      expect(queryByText('Model unavailable')).not.toBeNull();
    });
  });

  test('AI tab shows Re-analyze button after first analysis', async () => {
    const user = userEvent.setup();
    globalThis.fetch = mockFetchStream('Analysis result') as unknown as typeof fetch;

    const { queryByText } = render(
      <VisualExplain plan={samplePlan} query="SELECT 1" />
    );
    fireEvent.click(queryByText('AI Explain')!);
    await user.click(queryByText('Analyze with AI')!);

    await waitFor(() => {
      expect(queryByText('Re-analyze')).not.toBeNull();
    });
  });

  test('AI tab renders code blocks with "Try This" button for SQL', async () => {
    const user = userEvent.setup();
    const onLoadQuery = mock(() => {});
    globalThis.fetch = mockFetchStream('Try this:\n```sql\nSELECT id FROM users WHERE active;\n```\nDone.') as unknown as typeof fetch;

    const { queryByText, container } = render(
      <VisualExplain plan={samplePlan} query="SELECT * FROM users" onLoadQuery={onLoadQuery} />
    );
    fireEvent.click(queryByText('AI Explain')!);
    await user.click(queryByText('Analyze with AI')!);

    await waitFor(() => {
      const pre = container.querySelector('pre');
      expect(pre).not.toBeNull();
      expect(pre!.textContent).toContain('SELECT id FROM users WHERE active;');
      expect(queryByText('Try This')).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Tab navigation
  // -----------------------------------------------------------------------

  test('all 4 tabs are rendered: insights, AI Explain, tree, raw', () => {
    const { queryByText } = render(<VisualExplain plan={samplePlan} />);
    expect(queryByText('insights')).not.toBeNull();
    expect(queryByText('AI Explain')).not.toBeNull();
    expect(queryByText('tree')).not.toBeNull();
    expect(queryByText('raw')).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Format helpers (tested through rendered output)
  // -----------------------------------------------------------------------

  test('formatTime: seconds for >= 1000ms', () => {
    const bigPlan: ExplainPlanResult[] = [{
      Plan: { 'Node Type': 'Seq Scan', 'Actual Rows': 1, 'Plan Rows': 1, 'Actual Total Time': 2500, 'Total Cost': 1 },
      'Execution Time': 2500,
      'Planning Time': 0,
    }];
    const { queryAllByText } = render(<VisualExplain plan={bigPlan} />);
    expect(queryAllByText('2.50s').length).toBeGreaterThan(0);
  });

  test('formatTime: microseconds for < 1ms', () => {
    const tinyPlan: ExplainPlanResult[] = [{
      Plan: { 'Node Type': 'Index Scan', 'Actual Rows': 1, 'Plan Rows': 1, 'Actual Total Time': 0.05, 'Total Cost': 1 },
      'Execution Time': 0.05,
      'Planning Time': 0,
    }];
    const { queryAllByText } = render(<VisualExplain plan={tinyPlan} />);
    expect(queryAllByText('50μs').length).toBeGreaterThan(0);
  });

  test('formatNumber: millions', () => {
    const bigRowPlan: ExplainPlanResult[] = [{
      Plan: { 'Node Type': 'Seq Scan', 'Actual Rows': 2500000, 'Plan Rows': 2500000, 'Actual Total Time': 100, 'Total Cost': 500 },
      'Execution Time': 100,
      'Planning Time': 0,
    }];
    const { queryAllByText } = render(<VisualExplain plan={bigRowPlan} />);
    expect(queryAllByText('2.5M').length).toBeGreaterThan(0);
  });

  test('shows N/A for cache hit rate when no buffer data', () => {
    const { queryByText } = render(<VisualExplain plan={healthyPlan} />);
    expect(queryByText('N/A')).not.toBeNull();
  });
});
