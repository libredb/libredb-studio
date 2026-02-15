import '../setup-dom';
import { mock } from 'bun:test';
import React from 'react';

// Mock Studio to avoid its massive dependency tree
mock.module('@/components/Studio', () => ({
  default: () => React.createElement('div', { 'data-testid': 'studio' }, 'Studio Mock'),
}));

const { default: Page } = await import('@/app/page');

import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';

describe('Page', () => {
  afterEach(() => { cleanup(); });

  test('renders Studio component', () => {
    const { getByTestId } = render(<Page />);
    expect(getByTestId('studio')).not.toBeNull();
  });

  test('renders Studio content', () => {
    const { getByText } = render(<Page />);
    expect(getByText('Studio Mock')).not.toBeNull();
  });

  test('is a valid React component (returns JSX)', () => {
    const element = Page();
    expect(element).not.toBeNull();
    expect(element.type).toBeDefined();
  });
});
