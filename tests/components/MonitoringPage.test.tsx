import '../setup-dom';
import { mock } from 'bun:test';
import React from 'react';

// Mock MonitoringDashboard to avoid its massive dependency tree
mock.module('@/components/monitoring/MonitoringDashboard', () => ({
  MonitoringDashboard: () => React.createElement('div', { 'data-testid': 'monitoring-dashboard' }, 'MonitoringDashboard Mock'),
}));

const { default: MonitoringPage } = await import('@/app/monitoring/page');

import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';

describe('MonitoringPage', () => {
  afterEach(() => { cleanup(); });

  test('renders MonitoringDashboard component', () => {
    const { getByTestId } = render(<MonitoringPage />);
    expect(getByTestId('monitoring-dashboard')).not.toBeNull();
  });

  test('renders MonitoringDashboard content', () => {
    const { getByText } = render(<MonitoringPage />);
    expect(getByText('MonitoringDashboard Mock')).not.toBeNull();
  });

  test('is a client component that renders directly', () => {
    const element = MonitoringPage();
    expect(element.type).toBeDefined();
  });
});
