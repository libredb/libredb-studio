import '../../setup-dom';
import { mock } from 'bun:test';
import React from 'react';

// Mock recharts — DOM-only environment can't render SVG charts
mock.module('recharts', () => ({
  AreaChart: ({ children, data }: { children: React.ReactNode; data: unknown[] }) =>
    React.createElement('div', { 'data-testid': 'area-chart', 'data-count': data.length }, children),
  Area: (props: Record<string, unknown>) =>
    React.createElement('div', { 'data-testid': 'area', 'data-color': props.stroke }),
  XAxis: () => React.createElement('div', { 'data-testid': 'x-axis' }),
  YAxis: () => React.createElement('div', { 'data-testid': 'y-axis' }),
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'responsive-container' }, children),
  Tooltip: () => React.createElement('div', { 'data-testid': 'tooltip' }),
}));

const { MetricChart } = await import('@/components/monitoring/tabs/MetricChart');

import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';

describe('MetricChart', () => {
  afterEach(() => { cleanup(); });

  test('shows collecting message when data has 0 points', () => {
    const { getByText } = render(
      <MetricChart data={[]} color="#3b82f6" title="CPU Usage" />
    );
    expect(getByText('Collecting data for CPU Usage...')).not.toBeNull();
  });

  test('shows collecting message when data has 1 point', () => {
    const { getByText } = render(
      <MetricChart data={[{ timestamp: Date.now(), value: 42 }]} color="#3b82f6" title="Memory" />
    );
    expect(getByText('Collecting data for Memory...')).not.toBeNull();
  });

  test('does not render chart when data has fewer than 2 points', () => {
    const { queryByTestId } = render(
      <MetricChart data={[{ timestamp: Date.now(), value: 10 }]} color="#f00" title="Test" />
    );
    expect(queryByTestId('area-chart')).toBeNull();
  });

  test('renders chart when data has 2+ points', () => {
    const data = [
      { timestamp: 1000, value: 10 },
      { timestamp: 2000, value: 20 },
    ];
    const { getByTestId, queryByText } = render(
      <MetricChart data={data} color="#22c55e" title="Connections" />
    );
    expect(getByTestId('area-chart')).not.toBeNull();
    expect(getByTestId('responsive-container')).not.toBeNull();
    expect(queryByText(/Collecting data/)).toBeNull();
  });

  test('passes data length to AreaChart', () => {
    const data = [
      { timestamp: 1000, value: 10 },
      { timestamp: 2000, value: 20 },
      { timestamp: 3000, value: 30 },
    ];
    const { getByTestId } = render(
      <MetricChart data={data} color="#3b82f6" title="QPS" />
    );
    expect(getByTestId('area-chart').getAttribute('data-count')).toBe('3');
  });

  test('passes color to Area stroke', () => {
    const data = [
      { timestamp: 1000, value: 10 },
      { timestamp: 2000, value: 20 },
    ];
    const { getByTestId } = render(
      <MetricChart data={data} color="#ef4444" title="Errors" />
    );
    expect(getByTestId('area').getAttribute('data-color')).toBe('#ef4444');
  });

  test('renders all chart sub-components', () => {
    const data = [
      { timestamp: 1000, value: 10 },
      { timestamp: 2000, value: 20 },
    ];
    const { getByTestId } = render(
      <MetricChart data={data} color="#3b82f6" title="Latency" unit="ms" />
    );
    expect(getByTestId('x-axis')).not.toBeNull();
    expect(getByTestId('y-axis')).not.toBeNull();
    expect(getByTestId('tooltip')).not.toBeNull();
    expect(getByTestId('area')).not.toBeNull();
  });

  test('uses title in collecting message', () => {
    const { getByText } = render(
      <MetricChart data={[]} color="#3b82f6" title="Custom Metric" />
    );
    expect(getByText('Collecting data for Custom Metric...')).not.toBeNull();
  });

  test('defaults unit to empty string', () => {
    const { container } = render(
      <MetricChart data={[]} color="#3b82f6" title="Test" />
    );
    // Should render without error (unit defaults to '')
    expect(container).not.toBeNull();
  });
});
