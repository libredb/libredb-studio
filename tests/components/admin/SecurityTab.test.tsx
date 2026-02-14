import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import { mock } from 'bun:test';
import { setupRechartssMock, setupFramerMotionMock } from '../../helpers/mock-monaco';

setupRechartssMock();
setupFramerMotionMock();

mock.module('@/components/MaskingSettings', () => ({
  MaskingSettings: () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    return React.createElement('div', { 'data-testid': 'masking-settings' }, 'MaskingSettings');
  },
}));

mock.module('@/lib/monitoring-thresholds', () => ({
  DEFAULT_THRESHOLDS: [
    { metric: 'cacheHitRatio', warning: 90, critical: 80, direction: 'below' as const, label: 'Cache Hit Ratio' },
    { metric: 'connectionPercent', warning: 70, critical: 90, direction: 'above' as const, label: 'Connection Usage' },
  ],
}));

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { render, fireEvent, act, waitFor, cleanup } from '@testing-library/react';
import React from 'react';

import { SecurityTab } from '@/components/admin/tabs/SecurityTab';

// =============================================================================
// SecurityTab Tests
// =============================================================================

// Helper: Radix Tabs uses onMouseDown (not onClick) to switch tabs.
// In happy-dom, fireEvent.click does not trigger onMouseDown in the correct
// event sequence, so we dispatch mouseDown explicitly.
function clickRadixTab(element: HTMLElement) {
  fireEvent.mouseDown(element, { button: 0 });
}

describe('SecurityTab', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    // Clear localStorage between tests
    if (typeof localStorage !== 'undefined') {
      localStorage.removeItem('libredb_threshold_config');
    }
  });

  test('renders 3 tabs (Data Masking, Access, Thresholds)', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<SecurityTab />);
    });
    const { queryByText } = renderResult!;

    expect(queryByText('Data Masking')).not.toBeNull();
    expect(queryByText('Access')).not.toBeNull();
    expect(queryByText('Thresholds')).not.toBeNull();
  });

  test('masking tab shows MaskingSettings component', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<SecurityTab />);
    });
    const { queryByTestId, queryByText } = renderResult!;

    // Data Masking is the default tab, so MaskingSettings should be visible
    expect(queryByTestId('masking-settings')).not.toBeNull();
    expect(queryByText('MaskingSettings')).not.toBeNull();
  });

  test('access tab shows security summary cards', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<SecurityTab />);
    });
    const { getByText, queryByText } = renderResult!;

    // Click the Access tab using mouseDown (Radix listens to onMouseDown)
    await act(async () => {
      clickRadixTab(getByText('Access'));
    });

    // Access summary shows these labels
    await waitFor(() => {
      expect(queryByText('Security & Access')).not.toBeNull();
      expect(queryByText('Authentication')).not.toBeNull();
      expect(queryByText('API Security')).not.toBeNull();
      expect(queryByText('Connection Security')).not.toBeNull();
    });
  });

  test('thresholds tab shows metric sliders', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<SecurityTab />);
    });
    const { getByText, queryByText } = renderResult!;

    // Click the Thresholds tab using mouseDown (Radix listens to onMouseDown)
    await act(async () => {
      clickRadixTab(getByText('Thresholds'));
    });

    // Threshold settings should show metric labels
    await waitFor(() => {
      expect(queryByText('Monitoring Thresholds')).not.toBeNull();
      expect(queryByText('Cache Hit Ratio')).not.toBeNull();
      expect(queryByText('Connection Usage')).not.toBeNull();
    });
  });

  test('save button present in thresholds', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<SecurityTab />);
    });
    const { getByText, queryByText } = renderResult!;

    // Click the Thresholds tab using mouseDown (Radix listens to onMouseDown)
    await act(async () => {
      clickRadixTab(getByText('Thresholds'));
    });

    await waitFor(() => {
      expect(queryByText('Save Config')).not.toBeNull();
    });
  });

  test('reset button present in thresholds', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<SecurityTab />);
    });
    const { getByText, queryByText } = renderResult!;

    // Click the Thresholds tab using mouseDown (Radix listens to onMouseDown)
    await act(async () => {
      clickRadixTab(getByText('Thresholds'));
    });

    await waitFor(() => {
      expect(queryByText('Reset Defaults')).not.toBeNull();
    });
  });
});
