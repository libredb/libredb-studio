import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { VisualExplain, type ExplainPlanResult } from '@/components/VisualExplain';

// Suppress fetch calls
globalThis.fetch = mock(() => Promise.resolve(new Response('', { status: 200 }))) as never;

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

describe('VisualExplain', () => {
  afterEach(() => { cleanup(); });

  test('shows empty state when plan is null', () => {
    const { queryByText } = render(<VisualExplain plan={null} />);
    expect(queryByText('No execution plan')).not.toBeNull();
  });

  test('shows empty state when plan is empty array', () => {
    const { queryByText } = render(<VisualExplain plan={[]} />);
    expect(queryByText('No execution plan')).not.toBeNull();
  });

  test('renders header stats and insights tab', () => {
    const { container, queryByText } = render(<VisualExplain plan={samplePlan} query="SELECT * FROM users" />);
    expect(queryByText('execution')).not.toBeNull();
    expect(queryByText('rows')).not.toBeNull();
    expect(queryByText('cost')).not.toBeNull();
    expect(queryByText('Performance Issues')).not.toBeNull();
    expect(queryByText('Sequential Scan')).not.toBeNull();
    expect(container.textContent).toContain('Execution Plan');
  });

  test('switches to tree tab', () => {
    const { queryByText } = render(<VisualExplain plan={samplePlan} />);
    fireEvent.click(queryByText('tree')!);
    expect(queryByText('Seq Scan')).not.toBeNull();
  });

  test('switches to raw tab and shows JSON', () => {
    const { container, queryByText } = render(<VisualExplain plan={samplePlan} />);
    fireEvent.click(queryByText('raw')!);
    expect(container.textContent).toContain('"Node Type"');
  });

  test('switches to AI tab and shows placeholder', () => {
    const { queryByText } = render(<VisualExplain plan={samplePlan} query="SELECT 1" />);
    fireEvent.click(queryByText('AI Explain')!);
    expect(queryByText('AI Query Analysis')).not.toBeNull();
    expect(queryByText('Analyze with AI')).not.toBeNull();
  });

  test('shows no warnings badge when plan is healthy', () => {
    const healthyPlan: ExplainPlanResult[] = [{
      Plan: { 'Node Type': 'Index Scan', 'Actual Rows': 10, 'Plan Rows': 10, 'Actual Total Time': 0.5, 'Total Cost': 5, 'Index Name': 'idx_pk' },
      'Execution Time': 0.5,
      'Planning Time': 0.1,
    }];
    const { queryByText } = render(<VisualExplain plan={healthyPlan} />);
    expect(queryByText('Query looks good')).not.toBeNull();
  });
});
