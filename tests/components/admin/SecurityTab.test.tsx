import '../../setup-dom';
import { mockToastSuccess } from '../../helpers/mock-sonner';
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

  // ===========================================================================
  // NEW TESTS
  // ===========================================================================

  test('access tab shows security badges (ENABLED, Supported, Configurable)', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<SecurityTab />);
    });
    const { getByText, queryAllByText, queryByText } = renderResult!;

    await act(async () => {
      clickRadixTab(getByText('Access'));
    });

    await waitFor(() => {
      // Admin Access and User Access both have ENABLED badges
      const enabledBadges = queryAllByText('ENABLED');
      expect(enabledBadges.length).toBe(2);

      // SSL/TLS and SSH Tunnel have Supported badges
      const supportedBadges = queryAllByText('Supported');
      expect(supportedBadges.length).toBe(2);

      // Data Masking has Configurable badge
      expect(queryByText('Configurable')).not.toBeNull();
    });
  });

  test('access tab shows JWT and RBAC info', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<SecurityTab />);
    });
    const { getByText, queryByText } = renderResult!;

    await act(async () => {
      clickRadixTab(getByText('Access'));
    });

    await waitFor(() => {
      // Authentication method shows RBAC
      expect(queryByText('Environment Variable (RBAC)')).not.toBeNull();
      // API security shows JWT
      expect(queryByText('JWT / HTTP-only Cookie')).not.toBeNull();
    });
  });

  test('thresholds tab shows direction text (Alert when above/below)', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<SecurityTab />);
    });
    const { getByText, queryByText } = renderResult!;

    await act(async () => {
      clickRadixTab(getByText('Thresholds'));
    });

    await waitFor(() => {
      // cacheHitRatio has direction 'below'
      expect(queryByText('Alert when below')).not.toBeNull();
      // connectionPercent has direction 'above'
      expect(queryByText('Alert when above')).not.toBeNull();
    });
  });

  test('save button is disabled when no changes have been made', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<SecurityTab />);
    });
    const { getByText } = renderResult!;

    await act(async () => {
      clickRadixTab(getByText('Thresholds'));
    });

    await waitFor(() => {
      const saveButton = getByText('Save Config').closest('button');
      expect(saveButton).not.toBeNull();
      expect(saveButton!.disabled).toBe(true);
    });
  });

  test('save button becomes enabled after slider change', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<SecurityTab />);
    });
    const { getByText, container } = renderResult!;

    await act(async () => {
      clickRadixTab(getByText('Thresholds'));
    });

    // Find a slider thumb and press ArrowRight to change the value
    await waitFor(() => {
      const sliders = container.querySelectorAll('[role="slider"]');
      expect(sliders.length).toBeGreaterThan(0);
    });

    const sliders = container.querySelectorAll('[role="slider"]');
    await act(async () => {
      (sliders[0] as HTMLElement).focus();
      fireEvent.keyDown(sliders[0], { key: 'ArrowRight' });
    });

    await waitFor(() => {
      const saveButton = getByText('Save Config').closest('button');
      expect(saveButton).not.toBeNull();
      expect(saveButton!.disabled).toBe(false);
    });
  });

  test('save config writes to localStorage and shows success toast', async () => {
    mockToastSuccess.mockClear();

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<SecurityTab />);
    });
    const { getByText, container } = renderResult!;

    await act(async () => {
      clickRadixTab(getByText('Thresholds'));
    });

    // Change a slider value so Save becomes enabled
    await waitFor(() => {
      const sliders = container.querySelectorAll('[role="slider"]');
      expect(sliders.length).toBeGreaterThan(0);
    });

    const sliders = container.querySelectorAll('[role="slider"]');
    await act(async () => {
      (sliders[0] as HTMLElement).focus();
      fireEvent.keyDown(sliders[0], { key: 'ArrowRight' });
    });

    // Click Save Config
    await act(async () => {
      fireEvent.click(getByText('Save Config'));
    });

    // Verify localStorage was written
    const stored = localStorage.getItem('libredb_threshold_config');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed.length).toBe(2);

    // Verify success toast
    expect(mockToastSuccess).toHaveBeenCalledWith('Threshold configuration saved');
  });

  test('reset defaults restores values and shows success toast', async () => {
    mockToastSuccess.mockClear();

    // Pre-seed localStorage with custom thresholds
    const custom = [
      { metric: 'cacheHitRatio', warning: 50, critical: 30, direction: 'below', label: 'Cache Hit Ratio' },
      { metric: 'connectionPercent', warning: 60, critical: 85, direction: 'above', label: 'Connection Usage' },
    ];
    localStorage.setItem('libredb_threshold_config', JSON.stringify(custom));

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<SecurityTab />);
    });
    const { getByText, queryByText } = renderResult!;

    await act(async () => {
      clickRadixTab(getByText('Thresholds'));
    });

    // Click Reset Defaults
    await act(async () => {
      fireEvent.click(getByText('Reset Defaults'));
    });

    // Verify default values are shown (from the mock DEFAULT_THRESHOLDS)
    await waitFor(() => {
      // Cache Hit Ratio warning=90, critical=80 (defaults)
      expect(queryByText('Cache Hit Ratio')).not.toBeNull();
      expect(queryByText('Connection Usage')).not.toBeNull();
    });

    // Verify localStorage was overwritten with defaults
    const stored = localStorage.getItem('libredb_threshold_config');
    expect(stored).not.toBeNull();
    const parsed = JSON.parse(stored!);
    expect(parsed[0].warning).toBe(90);
    expect(parsed[0].critical).toBe(80);

    // Verify success toast
    expect(mockToastSuccess).toHaveBeenCalledWith('Thresholds reset to defaults');
  });

  test('loads thresholds from localStorage on mount', async () => {
    // Pre-seed localStorage with custom values
    const custom = [
      { metric: 'cacheHitRatio', warning: 55, critical: 40, direction: 'below', label: 'Cache Hit Ratio' },
      { metric: 'connectionPercent', warning: 65, critical: 88, direction: 'above', label: 'Connection Usage' },
    ];
    localStorage.setItem('libredb_threshold_config', JSON.stringify(custom));

    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<SecurityTab />);
    });
    const { getByText, queryByText } = renderResult!;

    await act(async () => {
      clickRadixTab(getByText('Thresholds'));
    });

    // The custom warning/critical values should appear in the rendered output
    await waitFor(() => {
      // cacheHitRatio warning=55 should be displayed
      expect(queryByText('55%')).not.toBeNull();
      // cacheHitRatio critical=40 should be displayed
      expect(queryByText('40%')).not.toBeNull();
      // connectionPercent warning=65 should be displayed
      expect(queryByText('65%')).not.toBeNull();
      // connectionPercent critical=88 should be displayed
      expect(queryByText('88%')).not.toBeNull();
    });
  });

  test('percentage suffix is shown for percent metrics', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<SecurityTab />);
    });
    const { getByText, queryAllByText, queryByText } = renderResult!;

    await act(async () => {
      clickRadixTab(getByText('Thresholds'));
    });

    // Both mock thresholds are percent metrics (not 'deadlocks')
    // cacheHitRatio: warning=90, critical=80
    // connectionPercent: warning=70, critical=90
    await waitFor(() => {
      // 90% appears twice (cacheHitRatio warning + connectionPercent critical)
      const ninetyPercent = queryAllByText('90%');
      expect(ninetyPercent.length).toBe(2);

      // 80% appears once (cacheHitRatio critical)
      expect(queryByText('80%')).not.toBeNull();

      // 70% appears once (connectionPercent warning)
      expect(queryByText('70%')).not.toBeNull();
    });
  });

  test('warning and critical slider labels render', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<SecurityTab />);
    });
    const { getByText, queryAllByText } = renderResult!;

    await act(async () => {
      clickRadixTab(getByText('Thresholds'));
    });

    await waitFor(() => {
      // Each metric has a Warning and Critical label (2 metrics = 2 of each)
      const warningLabels = queryAllByText('Warning');
      expect(warningLabels.length).toBe(2);

      const criticalLabels = queryAllByText('Critical');
      expect(criticalLabels.length).toBe(2);
    });
  });

  test('thresholds tab renders all metric rows with full structure', async () => {
    let renderResult: ReturnType<typeof render>;
    await act(async () => {
      renderResult = render(<SecurityTab />);
    });
    const { getByText, container, queryByText } = renderResult!;

    await act(async () => {
      clickRadixTab(getByText('Thresholds'));
    });

    await waitFor(() => {
      // Title and description are present
      expect(queryByText('Monitoring Thresholds')).not.toBeNull();
      expect(
        queryByText(/Configure warning and critical thresholds/)
      ).not.toBeNull();

      // Both metric labels
      expect(queryByText('Cache Hit Ratio')).not.toBeNull();
      expect(queryByText('Connection Usage')).not.toBeNull();

      // Both direction texts
      expect(queryByText('Alert when below')).not.toBeNull();
      expect(queryByText('Alert when above')).not.toBeNull();

      // Slider elements: 2 metrics x 2 sliders (warning + critical) = 4 slider thumbs
      const sliderThumbs = container.querySelectorAll('[role="slider"]');
      expect(sliderThumbs.length).toBe(4);

      // Both action buttons
      expect(queryByText('Save Config')).not.toBeNull();
      expect(queryByText('Reset Defaults')).not.toBeNull();
    });
  });
});
