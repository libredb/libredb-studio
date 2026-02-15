import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import React from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { RowDetailSheet } from '@/components/results-grid/RowDetailSheet';

mock.module('@/components/ui/sheet', () => ({
  Sheet: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? React.createElement('div', { 'data-testid': 'sheet' }, children) : null,
  SheetContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'sheet-content' }, children),
  SheetHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', {}, children),
  SheetTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement('h2', {}, children),
}));

mock.module('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => React.createElement('div', {}, children),
}));

mock.module('@/lib/data-masking', () => ({
  maskValueByPattern: (value: unknown) => {
    void value;
    return '***MASKED***';
  },
}));

describe('results-grid/RowDetailSheet', () => {
  const writeText = mock(async (text: string) => {
    void text;
  });

  beforeEach(() => {
    writeText.mockClear();
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  test('does not render when closed', () => {
    const { queryByTestId } = render(
      <RowDetailSheet
        row={{ id: 1, email: 'a@b.com' }}
        fields={['id', 'email']}
        isOpen={false}
        onClose={mock(() => {})}
        rowIndex={0}
      />
    );
    expect(queryByTestId('sheet')).toBeNull();
  });

  test('copies raw json when masking is not active', () => {
    const { queryByText } = render(
      <RowDetailSheet
        row={{ id: 1, email: 'alice@example.com' }}
        fields={['id', 'email']}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
      />
    );

    fireEvent.click(queryByText('Copy JSON')!);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String(writeText.mock.calls[0]?.[0])).toContain('alice@example.com');
  });

  test('copies masked json when masking is active', () => {
    const sensitiveColumns = new Map<string, unknown>([['email', { type: 'email' }]]);
    const { queryByText } = render(
      <RowDetailSheet
        row={{ id: 1, email: 'alice@example.com' }}
        fields={['id', 'email']}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
        maskingActive
        sensitiveColumns={sensitiveColumns as never}
      />
    );

    fireEvent.click(queryByText('Copy JSON')!);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String(writeText.mock.calls[0]?.[0])).toContain('***MASKED***');
  });

  test('shows masked value and reveals when reveal button is clicked', () => {
    const sensitiveColumns = new Map<string, unknown>([['email', { type: 'email' }]]);
    const { queryByText, queryByTitle } = render(
      <RowDetailSheet
        row={{ id: 1, email: 'alice@example.com' }}
        fields={['id', 'email']}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
        maskingActive
        sensitiveColumns={sensitiveColumns as never}
        allowReveal
      />
    );

    expect(queryByText('***MASKED***')).not.toBeNull();

    fireEvent.click(queryByTitle('Reveal value (10s)')!);
    expect(queryByText('alice@example.com')).not.toBeNull();
  });

  test('displays Row #N header with correct 1-based index', () => {
    const { queryByText } = render(
      <RowDetailSheet
        row={{ id: 1 }}
        fields={['id']}
        isOpen
        onClose={mock(() => {})}
        rowIndex={4}
      />
    );
    expect(queryByText('Row #5')).not.toBeNull();
  });

  test('copies individual field value to clipboard', () => {
    const { container } = render(
      <RowDetailSheet
        row={{ id: 1, name: 'Alice' }}
        fields={['id', 'name']}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
      />
    );

    // Each field row has a copy button; get all ghost buttons (copy buttons)
    const buttons = Array.from(container.querySelectorAll('button'));
    // The last button per field row is the copy button; skip the "Copy JSON" button (first button)
    const copyButtons = buttons.filter(b => !b.textContent?.includes('Copy JSON') && !b.textContent?.includes('Copied'));
    // Click the second copy button (for "name" field)
    fireEvent.click(copyButtons[1]!);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String(writeText.mock.calls[0]?.[0])).toBe('Alice');
  });

  test('shows check icon after copying a field value', () => {
    const { container } = render(
      <RowDetailSheet
        row={{ id: 1, name: 'Bob' }}
        fields={['id', 'name']}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
      />
    );

    const buttons = Array.from(container.querySelectorAll('button'));
    const copyButtons = buttons.filter(b => !b.textContent?.includes('Copy JSON') && !b.textContent?.includes('Copied'));
    // Click the first copy button (for "id" field)
    fireEvent.click(copyButtons[0]!);

    // After copy, the Check icon (emerald-400 colored) should replace the Copy icon
    const checkIcon = container.querySelector('.text-emerald-400');
    expect(checkIcon).not.toBeNull();
  });

  test('displays NULL for null and undefined values', () => {
    const { container } = render(
      <RowDetailSheet
        row={{ a: null, b: undefined }}
        fields={['a', 'b']}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
      />
    );

    // null: typeof null === 'object' so JSON.stringify(null) => "null"
    // undefined: String(undefined ?? 'NULL') => "NULL"
    const valueElements = Array.from(container.querySelectorAll('.font-mono.break-all'));
    expect(valueElements.length).toBe(2);
    expect(valueElements[0]!.textContent).toBe('null');
    expect(valueElements[1]!.textContent).toBe('NULL');
  });

  test('displays JSON.stringify for object values', () => {
    const obj = { foo: 'bar', num: 42 };
    const { queryByText } = render(
      <RowDetailSheet
        row={{ data: obj }}
        fields={['data']}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
      />
    );

    expect(queryByText(JSON.stringify(obj))).not.toBeNull();
  });

  test('renders long values (>50 chars) with smaller text class', () => {
    const longValue = 'A'.repeat(60);
    const { container } = render(
      <RowDetailSheet
        row={{ description: longValue }}
        fields={['description']}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
      />
    );

    // The value element should have both font-mono break-all (base) and text-xs (long value)
    const valueElement = container.querySelector('.font-mono.break-all.text-xs');
    expect(valueElement).not.toBeNull();
    expect(valueElement!.textContent).toBe(longValue);
  });

  test('reveal button auto-hides field after timeout', () => {
    const sensitiveColumns = new Map<string, unknown>([['email', { type: 'email' }]]);
    const { queryByText, queryByTitle } = render(
      <RowDetailSheet
        row={{ email: 'secret@example.com' }}
        fields={['email']}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
        maskingActive
        sensitiveColumns={sensitiveColumns as never}
        allowReveal
      />
    );

    // Initially masked
    expect(queryByText('***MASKED***')).not.toBeNull();

    // Mock setTimeout AFTER render to avoid breaking React internals
    const origSetTimeout = globalThis.setTimeout;
    let capturedCallback: (() => void) | null = null;
    globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
      if (ms === 10000) {
        capturedCallback = fn as () => void;
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }
      return origSetTimeout(fn, ms);
    }) as typeof setTimeout;

    // Reveal the field
    fireEvent.click(queryByTitle('Reveal value (10s)')!);
    expect(queryByText('secret@example.com')).not.toBeNull();

    // The timeout callback should have been captured
    expect(capturedCallback).not.toBeNull();

    // Execute the timeout callback to auto-hide
    act(() => { capturedCallback!(); });

    // Field should be masked again
    expect(queryByText('***MASKED***')).not.toBeNull();

    globalThis.setTimeout = origSetTimeout;
  });

  test('renders all field name labels', () => {
    const fields = ['id', 'username', 'email', 'created_at', 'status'];
    const row: Record<string, unknown> = {};
    fields.forEach(f => { row[f] = `val_${f}`; });

    const { queryByText } = render(
      <RowDetailSheet
        row={row}
        fields={fields}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
      />
    );

    for (const field of fields) {
      expect(queryByText(field)).not.toBeNull();
    }
  });

  test('raw JSON copy contains exact row data when no masking active', () => {
    const row = { id: 42, name: 'Charlie', active: true, score: 99.5 };
    const { queryByText } = render(
      <RowDetailSheet
        row={row}
        fields={['id', 'name', 'active', 'score']}
        isOpen
        onClose={mock(() => {})}
        rowIndex={0}
      />
    );

    fireEvent.click(queryByText('Copy JSON')!);
    expect(writeText).toHaveBeenCalledTimes(1);
    const copiedJson = String(writeText.mock.calls[0]?.[0]);
    const parsed = JSON.parse(copiedJson);
    expect(parsed).toEqual(row);
  });
});
