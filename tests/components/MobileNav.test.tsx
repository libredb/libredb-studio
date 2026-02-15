import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { MobileNav } from '@/components/MobileNav';

describe('MobileNav', () => {
  afterEach(() => { cleanup(); });

  test('renders 3 tab buttons', () => {
    const { queryByText } = render(
      <MobileNav activeTab="editor" onTabChange={mock(() => {})} />
    );
    expect(queryByText('DB')).not.toBeNull();
    expect(queryByText('Schema')).not.toBeNull();
    expect(queryByText('SQL')).not.toBeNull();
  });

  test('fires onTabChange when tab is clicked', () => {
    const onTabChange = mock((tab: string) => { void tab; });
    const { queryByText } = render(
      <MobileNav activeTab="editor" onTabChange={onTabChange} />
    );
    fireEvent.click(queryByText('DB')!);
    expect(onTabChange).toHaveBeenCalledTimes(1);
  });
});
