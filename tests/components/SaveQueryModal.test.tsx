import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, within } from '@testing-library/react';
import { SaveQueryModal } from '@/components/SaveQueryModal';

describe('SaveQueryModal', () => {
  afterEach(() => { cleanup(); });

  test('renders dialog elements when open', () => {
    const { baseElement } = render(<SaveQueryModal isOpen onClose={mock(() => {})} onSave={mock(() => {})} defaultQuery="SELECT 1" />);
    const body = within(baseElement);
    expect(body.queryAllByText('Save Query').length).toBeGreaterThan(0);
    expect(body.queryByPlaceholderText('e.g. Monthly Active Users')).not.toBeNull();
    expect(body.queryByPlaceholderText('What does this query do?')).not.toBeNull();
  });

  test('shows query preview', () => {
    const { baseElement } = render(<SaveQueryModal isOpen onClose={mock(() => {})} onSave={mock(() => {})} defaultQuery="SELECT * FROM users" />);
    expect(baseElement.textContent).toContain('SELECT * FROM users');
  });
});
