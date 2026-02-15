import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';

// ── Mock MonitoringDashboard to capture props ───────────────────────────────

let capturedProps: Record<string, unknown> | null = null;

mock.module('@/components/monitoring/MonitoringDashboard', () => ({
  MonitoringDashboard: (props: Record<string, unknown>) => {
    capturedProps = props;
    return React.createElement('div', { 'data-testid': 'monitoring-dashboard' }, 'MonitoringDashboard');
  },
}));

// ── Import after mock ───────────────────────────────────────────────────────

import { MonitoringEmbed } from '@/components/admin/tabs/MonitoringEmbed';

// ── Tests ───────────────────────────────────────────────────────────────────

describe('MonitoringEmbed', () => {
  afterEach(() => {
    cleanup();
    capturedProps = null;
  });

  test('renders MonitoringDashboard inside a full-height container', () => {
    const { queryByTestId, container } = render(<MonitoringEmbed />);
    expect(queryByTestId('monitoring-dashboard')).not.toBeNull();
    // Wrapper div has h-full class
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper.className).toContain('h-full');
  });

  test('passes isEmbedded=true to MonitoringDashboard', () => {
    render(<MonitoringEmbed />);
    expect(capturedProps).not.toBeNull();
    expect(capturedProps!.isEmbedded).toBe(true);
  });

  test('does not pass any other props to MonitoringDashboard', () => {
    render(<MonitoringEmbed />);
    expect(capturedProps).not.toBeNull();
    const keys = Object.keys(capturedProps!);
    expect(keys).toEqual(['isEmbedded']);
  });

  test('renders MonitoringDashboard text content', () => {
    const { queryByText } = render(<MonitoringEmbed />);
    expect(queryByText('MonitoringDashboard')).not.toBeNull();
  });
});
