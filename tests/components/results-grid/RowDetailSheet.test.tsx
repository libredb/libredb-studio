import '../../setup-dom';
import '../../helpers/mock-sonner';
import '../../helpers/mock-navigation';

import React from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
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
});
