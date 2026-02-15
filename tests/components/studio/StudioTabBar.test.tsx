import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import { describe, test, expect, mock, afterEach } from 'bun:test';
import { render, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

import { StudioTabBar } from '@/components/studio/StudioTabBar';
import type { QueryTab } from '@/lib/types';

// =============================================================================
// Helpers
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
  const tab2 = createTab({ id: 'tab-2', name: 'Query 2', type: 'mongodb' });

  return {
    tabs: [tab1, tab2],
    activeTabId: 'tab-1',
    editingTabId: null as string | null,
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

// =============================================================================
// Tests
// =============================================================================

describe('StudioTabBar', () => {

  // ── Basic rendering ─────────────────────────────────────────────────────

  test('renders all tab names', () => {
    const props = createDefaultProps();
    const { queryByText } = render(<StudioTabBar {...props} />);
    expect(queryByText('Query 1')).not.toBeNull();
    expect(queryByText('Query 2')).not.toBeNull();
  });

  test('active tab has blue border and bg styling', () => {
    const props = createDefaultProps({ activeTabId: 'tab-1' });
    const { container } = render(<StudioTabBar {...props} />);
    const tabElements = container.querySelectorAll('[class*="border-t-2"]');
    expect(tabElements[0]?.className).toContain('border-blue-500');
    expect(tabElements[0]?.className).toContain('bg-[#141414]');
  });

  test('inactive tab has transparent border', () => {
    const props = createDefaultProps({ activeTabId: 'tab-1' });
    const { container } = render(<StudioTabBar {...props} />);
    const tabElements = container.querySelectorAll('[class*="border-t-2"]');
    expect(tabElements[1]?.className).toContain('border-transparent');
  });

  // ── Tab type icons ────────────────────────────────────────────────────

  test('renders different icons for sql and json tabs', () => {
    const props = createDefaultProps();
    const { container } = render(<StudioTabBar {...props} />);
    // Each tab should have at least one icon SVG (w-3 h-3)
    const tabElements = container.querySelectorAll('[class*="border-t-2"]');
    expect(tabElements.length).toBe(2);
    // Each tab div contains an SVG icon as the first child element
    const tab1Svgs = tabElements[0]?.querySelectorAll('svg');
    const tab2Svgs = tabElements[1]?.querySelectorAll('svg');
    expect(tab1Svgs!.length).toBeGreaterThanOrEqual(1);
    expect(tab2Svgs!.length).toBeGreaterThanOrEqual(1);
  });

  // ── Click → activate tab ──────────────────────────────────────────────

  test('click on tab fires onSetActiveTabId with tab id', () => {
    const onSetActiveTabId = mock(() => {});
    const props = createDefaultProps({ onSetActiveTabId });
    const { container } = render(<StudioTabBar {...props} />);
    const tabElements = container.querySelectorAll('[class*="border-t-2"]');
    fireEvent.click(tabElements[1]!);
    expect(onSetActiveTabId).toHaveBeenCalledTimes(1);
    expect(onSetActiveTabId).toHaveBeenCalledWith('tab-2');
  });

  // ── Plus button ───────────────────────────────────────────────────────

  test('plus button fires onAddTab', () => {
    const onAddTab = mock(() => {});
    const props = createDefaultProps({ onAddTab });
    const { container } = render(<StudioTabBar {...props} />);
    const svgElements = container.querySelectorAll('svg');
    const plusIcon = Array.from(svgElements).find(el =>
      el.getAttribute('class')?.includes('cursor-pointer')
    );
    expect(plusIcon).not.toBeNull();
    fireEvent.click(plusIcon!);
    expect(onAddTab).toHaveBeenCalledTimes(1);
  });

  // ── Close button ──────────────────────────────────────────────────────

  test('close button fires onCloseTab when multiple tabs', () => {
    const onCloseTab = mock(() => {});
    const props = createDefaultProps({ onCloseTab });
    const { container } = render(<StudioTabBar {...props} />);
    const closeIcons = container.querySelectorAll('svg[class*="ml-auto"]');
    expect(closeIcons.length).toBeGreaterThan(0);
    fireEvent.click(closeIcons[0]);
    expect(onCloseTab).toHaveBeenCalledTimes(1);
  });

  test('close button hidden when only one tab', () => {
    const singleTab = createTab({ id: 'tab-1', name: 'Query 1' });
    const props = createDefaultProps({ tabs: [singleTab], activeTabId: 'tab-1' });
    const { container } = render(<StudioTabBar {...props} />);
    const closeIcons = container.querySelectorAll('svg[class*="ml-auto"]');
    expect(closeIcons.length).toBe(0);
  });

  // ── Double-click → rename mode ────────────────────────────────────────

  test('double-click on tab enters rename mode', () => {
    const onSetEditingTabId = mock(() => {});
    const onSetEditingTabName = mock(() => {});
    const props = createDefaultProps({ onSetEditingTabId, onSetEditingTabName });
    const { container } = render(<StudioTabBar {...props} />);
    const tabElements = container.querySelectorAll('[class*="border-t-2"]');
    fireEvent.doubleClick(tabElements[0]!);
    expect(onSetEditingTabId).toHaveBeenCalledTimes(1);
    expect(onSetEditingTabId).toHaveBeenCalledWith('tab-1');
    expect(onSetEditingTabName).toHaveBeenCalledTimes(1);
    expect(onSetEditingTabName).toHaveBeenCalledWith('Query 1');
  });

  // ── Rename input rendering ────────────────────────────────────────────

  test('shows input field when editingTabId matches', () => {
    const props = createDefaultProps({ editingTabId: 'tab-1', editingTabName: 'Query 1' });
    const { container, queryByText } = render(<StudioTabBar {...props} />);
    // Tab name text should not be visible as span (it's an input now)
    const input = container.querySelector('input');
    expect(input).not.toBeNull();
    expect(input!.value).toBe('Query 1');
    // The span for tab-1 should not exist when editing
    // tab-2 name should still show as span
    expect(queryByText('Query 2')).not.toBeNull();
  });

  // ── Rename input onChange ─────────────────────────────────────────────

  test('rename input is rendered with correct value and className', () => {
    const props = createDefaultProps({ editingTabId: 'tab-1', editingTabName: 'Query 1' });
    const { container } = render(<StudioTabBar {...props} />);
    const input = container.querySelector('input')!;
    expect(input).not.toBeNull();
    expect(input.value).toBe('Query 1');
    expect(input.className).toContain('border-blue-500');
    expect(input.className).toContain('bg-transparent');
  });

  // ── Rename commit via blur ────────────────────────────────────────────

  test('blur on rename input commits name and exits editing', () => {
    const onSetTabs = mock(() => {});
    const onSetEditingTabId = mock(() => {});
    const props = createDefaultProps({
      editingTabId: 'tab-1',
      editingTabName: 'New Name',
      onSetTabs,
      onSetEditingTabId,
    });
    const { container } = render(<StudioTabBar {...props} />);
    const input = container.querySelector('input')!;
    fireEvent.blur(input);
    expect(onSetTabs).toHaveBeenCalledTimes(1);
    expect(onSetEditingTabId).toHaveBeenCalledTimes(1);
    expect(onSetEditingTabId).toHaveBeenCalledWith(null);
  });

  test('blur with empty name does not call onSetTabs', () => {
    const onSetTabs = mock(() => {});
    const onSetEditingTabId = mock(() => {});
    const props = createDefaultProps({
      editingTabId: 'tab-1',
      editingTabName: '   ',
      onSetTabs,
      onSetEditingTabId,
    });
    const { container } = render(<StudioTabBar {...props} />);
    const input = container.querySelector('input')!;
    fireEvent.blur(input);
    expect(onSetTabs).not.toHaveBeenCalled();
    expect(onSetEditingTabId).toHaveBeenCalledWith(null);
  });

  // ── Rename commit via Enter ───────────────────────────────────────────

  test('Enter key commits name and exits editing', () => {
    const onSetTabs = mock(() => {});
    const onSetEditingTabId = mock(() => {});
    const props = createDefaultProps({
      editingTabId: 'tab-1',
      editingTabName: 'Via Enter',
      onSetTabs,
      onSetEditingTabId,
    });
    const { container } = render(<StudioTabBar {...props} />);
    const input = container.querySelector('input')!;
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSetTabs).toHaveBeenCalledTimes(1);
    expect(onSetEditingTabId).toHaveBeenCalledWith(null);
  });

  test('Enter with empty name does not call onSetTabs', () => {
    const onSetTabs = mock(() => {});
    const onSetEditingTabId = mock(() => {});
    const props = createDefaultProps({
      editingTabId: 'tab-1',
      editingTabName: '',
      onSetTabs,
      onSetEditingTabId,
    });
    const { container } = render(<StudioTabBar {...props} />);
    const input = container.querySelector('input')!;
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onSetTabs).not.toHaveBeenCalled();
    expect(onSetEditingTabId).toHaveBeenCalledWith(null);
  });

  // ── Rename cancel via Escape ──────────────────────────────────────────

  test('Escape key cancels editing without saving', () => {
    const onSetTabs = mock(() => {});
    const onSetEditingTabId = mock(() => {});
    const props = createDefaultProps({
      editingTabId: 'tab-1',
      editingTabName: 'Unsaved',
      onSetTabs,
      onSetEditingTabId,
    });
    const { container } = render(<StudioTabBar {...props} />);
    const input = container.querySelector('input')!;
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onSetTabs).not.toHaveBeenCalled();
    expect(onSetEditingTabId).toHaveBeenCalledWith(null);
  });

  // ── Input click does not bubble ───────────────────────────────────────

  test('clicking rename input does not fire onSetActiveTabId', () => {
    const onSetActiveTabId = mock(() => {});
    const props = createDefaultProps({
      editingTabId: 'tab-1',
      editingTabName: 'Query 1',
      onSetActiveTabId,
    });
    const { container } = render(<StudioTabBar {...props} />);
    const input = container.querySelector('input')!;
    fireEvent.click(input);
    expect(onSetActiveTabId).not.toHaveBeenCalled();
  });

  // ── onSetTabs updater function produces correct result ────────────────

  test('onSetTabs updater renames the correct tab', () => {
    let capturedFn: ((prev: QueryTab[]) => QueryTab[]) | null = null;
    const onSetTabs = mock((fn: (prev: QueryTab[]) => QueryTab[]) => { capturedFn = fn; });
    const onSetEditingTabId = mock(() => {});
    const tab1 = createTab({ id: 'tab-1', name: 'Query 1' });
    const tab2 = createTab({ id: 'tab-2', name: 'Query 2' });
    const props = createDefaultProps({
      tabs: [tab1, tab2],
      editingTabId: 'tab-1',
      editingTabName: 'Renamed',
      onSetTabs,
      onSetEditingTabId,
    });
    const { container } = render(<StudioTabBar {...props} />);
    const input = container.querySelector('input')!;
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(capturedFn).not.toBeNull();
    const result = capturedFn!([tab1, tab2]);
    expect(result[0].name).toBe('Renamed');
    expect(result[1].name).toBe('Query 2');
  });

  test('onSetTabs updater via blur renames correctly', () => {
    let capturedFn: ((prev: QueryTab[]) => QueryTab[]) | null = null;
    const onSetTabs = mock((fn: (prev: QueryTab[]) => QueryTab[]) => { capturedFn = fn; });
    const onSetEditingTabId = mock(() => {});
    const tab1 = createTab({ id: 'tab-1', name: 'Query 1' });
    const props = createDefaultProps({
      tabs: [tab1],
      editingTabId: 'tab-1',
      editingTabName: 'Blur Name',
      onSetTabs,
      onSetEditingTabId,
    });
    const { container } = render(<StudioTabBar {...props} />);
    const input = container.querySelector('input')!;
    fireEvent.blur(input);

    expect(capturedFn).not.toBeNull();
    const result = capturedFn!([tab1]);
    expect(result[0].name).toBe('Blur Name');
  });
});
