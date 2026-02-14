import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import { describe, test, expect, mock, afterEach } from 'bun:test';
import { render, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

import { StudioTabBar } from '@/components/studio/StudioTabBar';
import type { QueryTab } from '@/lib/types';

// =============================================================================
// StudioTabBar Tests
// =============================================================================

afterEach(() => {
  cleanup();
});

function createTab(overrides: Partial<QueryTab> = {}): QueryTab {
  return {
    id: 'tab-1',
    name: 'Query 1',
    query: 'SELECT 1',
    result: null,
    isExecuting: false,
    type: 'sql',
    ...overrides,
  };
}

function createDefaultProps(overrides: Record<string, unknown> = {}) {
  const tab1 = createTab({ id: 'tab-1', name: 'Query 1' });
  const tab2 = createTab({ id: 'tab-2', name: 'Query 2' });

  return {
    tabs: [tab1, tab2],
    activeTabId: 'tab-1',
    editingTabId: null,
    editingTabName: '',
    onSetActiveTabId: mock(() => {}),
    onSetEditingTabId: mock(() => {}),
    onSetEditingTabName: mock(() => {}),
    onSetTabs: mock(() => {}),
    onCloseTab: mock(() => {}),
    onAddTab: mock(() => {}),
    ...overrides,
  };
}

describe('StudioTabBar', () => {
  test('renders all tabs', () => {
    const props = createDefaultProps();
    const { queryByText } = render(<StudioTabBar {...props} />);

    expect(queryByText('Query 1')).not.toBeNull();
    expect(queryByText('Query 2')).not.toBeNull();
  });

  test('active tab has highlighted styling', () => {
    const props = createDefaultProps({ activeTabId: 'tab-1' });
    const { container } = render(<StudioTabBar {...props} />);

    // Use container-scoped queries to avoid cross-test contamination
    const tabElements = container.querySelectorAll('[class*="border-t-2"]');
    // First tab (Query 1) should be active
    const tab1 = tabElements[0];
    expect(tab1).not.toBeNull();
    expect(tab1?.className.includes('border-blue-500')).toBe(true);
    expect(tab1?.className.includes('bg-[#141414]')).toBe(true);

    // Second tab (Query 2) should be inactive
    const tab2 = tabElements[1];
    expect(tab2).not.toBeNull();
    expect(tab2?.className.includes('border-transparent')).toBe(true);
  });

  test('click on tab fires onSetActiveTabId', () => {
    const onSetActiveTabId = mock(() => {});
    const props = createDefaultProps({ onSetActiveTabId });
    const { container } = render(<StudioTabBar {...props} />);

    // Click on the second tab (border-t-2 elements are the tab containers)
    const tabElements = container.querySelectorAll('[class*="border-t-2"]');
    const tab2 = tabElements[1];
    expect(tab2).not.toBeNull();
    fireEvent.click(tab2!);

    expect(onSetActiveTabId).toHaveBeenCalledTimes(1);
    expect(onSetActiveTabId).toHaveBeenCalledWith('tab-2');
  });

  test('plus button fires onAddTab', () => {
    const onAddTab = mock(() => {});
    const props = createDefaultProps({ onAddTab });
    const { container } = render(<StudioTabBar {...props} />);

    // The Plus icon is an SVG element with cursor-pointer class
    const svgElements = container.querySelectorAll('svg');
    const plusIcon = Array.from(svgElements).find(el =>
      el.className.baseVal?.includes('cursor-pointer') || el.getAttribute('class')?.includes('cursor-pointer')
    );
    expect(plusIcon).not.toBeNull();
    fireEvent.click(plusIcon!);

    expect(onAddTab).toHaveBeenCalledTimes(1);
  });

  test('close button fires onCloseTab when multiple tabs', () => {
    const onCloseTab = mock(() => {});
    const props = createDefaultProps({ onCloseTab });
    const { container } = render(<StudioTabBar {...props} />);

    // X icons are SVG elements with class containing 'ml-auto'
    const closeIcons = container.querySelectorAll('svg[class*="ml-auto"]');
    expect(closeIcons.length).toBeGreaterThan(0);

    // Click the first close icon
    fireEvent.click(closeIcons[0]);

    expect(onCloseTab).toHaveBeenCalledTimes(1);
  });

  test('close button hidden when only one tab', () => {
    const singleTab = createTab({ id: 'tab-1', name: 'Query 1' });
    const props = createDefaultProps({
      tabs: [singleTab],
      activeTabId: 'tab-1',
    });
    const { container } = render(<StudioTabBar {...props} />);

    // With only one tab, X close icons should not be rendered
    const closeIcons = container.querySelectorAll('svg[class*="ml-auto"]');
    expect(closeIcons.length).toBe(0);
  });
});
