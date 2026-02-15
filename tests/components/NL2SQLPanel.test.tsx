import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { NL2SQLPanel } from '@/components/NL2SQLPanel';

describe('NL2SQLPanel', () => {
  afterEach(() => { cleanup(); });

  test('does not render when isOpen is false', () => {
    const { container } = render(
      <NL2SQLPanel isOpen={false} onClose={mock(() => {})} onExecuteQuery={mock(() => {})} onLoadQuery={mock(() => {})} schemaContext="[]" />
    );
    expect(container.textContent).toBe('');
  });

  test('renders header and empty state when open', () => {
    const { queryByText, queryByPlaceholderText } = render(
      <NL2SQLPanel isOpen onClose={mock(() => {})} onExecuteQuery={mock(() => {})} onLoadQuery={mock(() => {})} schemaContext="[]" />
    );
    expect(queryByText('Natural Language Query')).not.toBeNull();
    expect(queryByText('Ask a question in plain English')).not.toBeNull();
    expect(queryByPlaceholderText(/Ask in plain English/)).not.toBeNull();
  });
});
