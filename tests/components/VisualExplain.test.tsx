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

  // -----------------------------------------------------------------------
  // PlanNode collapse / expand behaviour
  // -----------------------------------------------------------------------

  test('PlanNode at depth 0 starts expanded and collapses on click', () => {
    // samplePlan root has a child "Index Scan" — it should be visible initially
    const { queryByText } = render(<VisualExplain plan={samplePlan} />);
    // Switch to tree tab for a clean view of the plan
    fireEvent.click(queryByText('tree')!);

    // Child should be visible because root (depth 0) starts expanded
    expect(queryByText('Index Scan')).not.toBeNull();

    // Click on the root node to collapse it
    fireEvent.click(queryByText('Seq Scan')!);

    // After collapsing, the child should disappear
    expect(queryByText('Index Scan')).toBeNull();
  });

  test('PlanNode at depth >= 2 starts collapsed', () => {
    // Build a 3-level deep plan: root (depth 0) → child (depth 1) → grandchild (depth 2)
    const deepPlan: ExplainPlanResult[] = [
      {
        Plan: {
          'Node Type': 'Nested Loop',
          'Actual Rows': 100,
          'Plan Rows': 100,
          'Actual Total Time': 10,
          'Total Cost': 50,
          Plans: [
            {
              'Node Type': 'Hash Join',
              'Actual Rows': 50,
              'Plan Rows': 50,
              'Actual Total Time': 5,
              'Total Cost': 25,
              Plans: [
                {
                  'Node Type': 'Seq Scan',
                  'Relation Name': 'deep_table',
                  'Actual Rows': 10,
                  'Plan Rows': 10,
                  'Actual Total Time': 1,
                  'Total Cost': 5,
                },
              ],
            },
          ],
        },
        'Execution Time': 10,
        'Planning Time': 0.1,
      },
    ];
    const { queryByText } = render(<VisualExplain plan={deepPlan} />);
    fireEvent.click(queryByText('tree')!);

    // depth 0 (Nested Loop) is expanded → depth 1 (Hash Join) is visible
    expect(queryByText('Hash Join')).not.toBeNull();

    // depth 1 (Hash Join) is also expanded (depth < 2) → depth 2 node visible
    // But depth 2 (Seq Scan on deep_table) starts collapsed, so its details are irrelevant —
    // the node itself IS rendered by its parent (depth 1 expanded).
    // The key point: depth 2 node is rendered but its OWN children would be collapsed.
    // Since the Seq Scan has no children, we verify the grandchild is visible
    // because its parent (depth 1) is expanded.
    expect(queryByText('deep_table')).not.toBeNull();

    // Now build a 4-level plan to truly test depth 2 collapse:
    const deeperPlan: ExplainPlanResult[] = [
      {
        Plan: {
          'Node Type': 'Nested Loop',
          'Actual Rows': 100,
          'Plan Rows': 100,
          'Actual Total Time': 10,
          'Total Cost': 50,
          Plans: [
            {
              'Node Type': 'Hash Join',
              'Actual Rows': 50,
              'Plan Rows': 50,
              'Actual Total Time': 5,
              'Total Cost': 25,
              Plans: [
                {
                  'Node Type': 'Merge Join',
                  'Actual Rows': 20,
                  'Plan Rows': 20,
                  'Actual Total Time': 2,
                  'Total Cost': 10,
                  Plans: [
                    {
                      'Node Type': 'Index Scan',
                      'Relation Name': 'hidden_table',
                      'Actual Rows': 5,
                      'Plan Rows': 5,
                      'Actual Total Time': 0.5,
                      'Total Cost': 2,
                    },
                  ],
                },
              ],
            },
          ],
        },
        'Execution Time': 10,
        'Planning Time': 0.1,
      },
    ];
    cleanup();
    const { queryByText: q2 } = render(<VisualExplain plan={deeperPlan} />);
    fireEvent.click(q2('tree')!);

    // depth 0 = Nested Loop (expanded), depth 1 = Hash Join (expanded)
    // depth 2 = Merge Join (collapsed!) → depth 3 child should NOT be visible
    expect(q2('Merge Join')).not.toBeNull();
    expect(q2('hidden_table')).toBeNull();
  });

  // -----------------------------------------------------------------------
  // NodeIcon variants
  // -----------------------------------------------------------------------

  test('NodeIcon renders Layers icon for Join type', () => {
    const joinPlan: ExplainPlanResult[] = [
      {
        Plan: {
          'Node Type': 'Hash Join',
          'Actual Rows': 10,
          'Plan Rows': 10,
          'Actual Total Time': 1,
          'Total Cost': 5,
        },
        'Execution Time': 1,
        'Planning Time': 0.1,
      },
    ];
    const { container } = render(<VisualExplain plan={joinPlan} />);
    // Layers icon for Join has text-purple-400 class
    const purpleIcon = container.querySelector('.text-purple-400');
    expect(purpleIcon).not.toBeNull();
  });

  test('NodeIcon renders ArrowDown icon for Sort type', () => {
    // sortPlan already has Node Type = 'Sort'
    const { container } = render(<VisualExplain plan={sortPlan} />);
    // Sort nodes use ArrowDown icon with text-amber-400
    // Seq Scan also uses amber-400, but sortPlan has 'Sort' not 'Seq Scan'
    const amberIcon = container.querySelector('.text-amber-400');
    expect(amberIcon).not.toBeNull();
  });

  test('NodeIcon renders Zap icon for Aggregate type', () => {
    const aggPlan: ExplainPlanResult[] = [
      {
        Plan: {
          'Node Type': 'Aggregate',
          'Actual Rows': 1,
          'Plan Rows': 1,
          'Actual Total Time': 2,
          'Total Cost': 10,
        },
        'Execution Time': 2,
        'Planning Time': 0.1,
      },
    ];
    const { container } = render(<VisualExplain plan={aggPlan} />);
    // Aggregate uses Zap icon with text-pink-400
    const pinkIcon = container.querySelector('.text-pink-400');
    expect(pinkIcon).not.toBeNull();
  });

  test('NodeIcon renders HardDrive icon for Hash type', () => {
    const hashPlan: ExplainPlanResult[] = [
      {
        Plan: {
          'Node Type': 'Hash',
          'Actual Rows': 100,
          'Plan Rows': 100,
          'Actual Total Time': 3,
          'Total Cost': 15,
        },
        'Execution Time': 3,
        'Planning Time': 0.1,
      },
    ];
    const { container } = render(<VisualExplain plan={hashPlan} />);
    // Hash uses HardDrive icon with text-cyan-400
    const cyanIcon = container.querySelector('.text-cyan-400');
    expect(cyanIcon).not.toBeNull();
  });

  test('NodeIcon renders Database icon for unknown type', () => {
    const unknownPlan: ExplainPlanResult[] = [
      {
        Plan: {
          'Node Type': 'Materialize',
          'Actual Rows': 10,
          'Plan Rows': 10,
          'Actual Total Time': 1,
          'Total Cost': 5,
        },
        'Execution Time': 1,
        'Planning Time': 0.1,
      },
    ];
    const { container } = render(<VisualExplain plan={unknownPlan} />);
    // Unknown type uses Database icon with text-zinc-500
    // Need to find the icon inside the node icon wrapper (p-1 rounded div)
    const iconWrappers = container.querySelectorAll('.bg-white\\/5');
    // The node icon container has bg-white/5 for non-scan types
    let foundZincIcon = false;
    iconWrappers.forEach((wrapper) => {
      const icon = wrapper.querySelector('.text-zinc-500');
      if (icon) foundZincIcon = true;
    });
    expect(foundZincIcon).toBe(true);
  });

  // -----------------------------------------------------------------------
  // AI tab: onLoadQuery via "Try This" button
  // -----------------------------------------------------------------------

  test('clicking "Try This" calls onLoadQuery with the SQL code', async () => {
    const user = userEvent.setup();
    const onLoadQuery = mock(() => {});
    globalThis.fetch = mockFetchStream('Suggestion:\n```sql\nCREATE INDEX idx_active ON users(active);\n```\nDone.') as unknown as typeof fetch;

    const { queryByText } = render(
      <VisualExplain plan={samplePlan} query="SELECT * FROM users" onLoadQuery={onLoadQuery} />
    );
    fireEvent.click(queryByText('AI Explain')!);
    await user.click(queryByText('Analyze with AI')!);

    await waitFor(() => {
      expect(queryByText('Try This')).not.toBeNull();
    });

    await user.click(queryByText('Try This')!);
    expect(onLoadQuery).toHaveBeenCalledTimes(1);
    expect(onLoadQuery).toHaveBeenCalledWith('CREATE INDEX idx_active ON users(active);');
  });

  // -----------------------------------------------------------------------
  // formatTime: microsecond branch (ms < 1)
  // -----------------------------------------------------------------------

  test('formatTime shows microseconds for sub-millisecond execution', () => {
    const microPlan: ExplainPlanResult[] = [
      {
        Plan: {
          'Node Type': 'Result',
          'Actual Rows': 1,
          'Plan Rows': 1,
          'Actual Total Time': 0.002,
          'Total Cost': 0.01,
        },
        'Execution Time': 0.002,
        'Planning Time': 0,
      },
    ];
    const { queryAllByText } = render(<VisualExplain plan={microPlan} />);
    // 0.002ms * 1000 = 2μs
    expect(queryAllByText('2μs').length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Leaf nodes show spacer instead of chevron
  // -----------------------------------------------------------------------

  test('leaf nodes show spacer div instead of chevron icon', () => {
    // healthyPlan has a single Index Scan with no children → leaf node
    const { container, queryByText } = render(<VisualExplain plan={healthyPlan} />);
    fireEvent.click(queryByText('tree')!);

    // The leaf node should have a <div class="w-3"> spacer instead of a ChevronRight svg
    // PlanNode renders: children.length === 0 → <div className="w-3" />
    // ChevronRight has the class rotate-90 or is a ChevronRight svg
    const planNodeContainer = container.querySelector('.rounded-lg.border');
    expect(planNodeContainer).not.toBeNull();

    // Within the plan node, find the spacer div (w-3 without svg child)
    const spacers = planNodeContainer!.querySelectorAll('div.w-3');
    expect(spacers.length).toBeGreaterThan(0);

    // Verify there's no chevron (which would have the rotate-90 or transition-transform classes on an svg)
    // For a leaf node, there should be no ChevronRight rendered
    const chevrons = planNodeContainer!.querySelectorAll('svg.transition-transform');
    // healthyPlan has a single node with no children, so no chevrons at all
    expect(chevrons.length).toBe(0);
  });
});
