import '../setup-dom';
import React from 'react';
import { CommunitySection } from '@/components/community-section';

import { afterEach, describe, expect, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';

describe('CommunitySection', () => {
  afterEach(() => { cleanup(); });

  const actionLabels = ['Star & Fork', 'Open an Issue', 'Discussions', 'Contribute', 'Translate', 'Sponsor'];

  describe('Desktop variant', () => {
    test('renders section title', () => {
      const { getByText } = render(<CommunitySection variant="desktop" />);
      expect(getByText('Join the Community')).not.toBeNull();
    });

    test('renders Open Source pill badge', () => {
      const { getByText } = render(<CommunitySection variant="desktop" />);
      expect(getByText('Open Source')).not.toBeNull();
    });

    test('renders subtitle text', () => {
      const { getByText } = render(<CommunitySection variant="desktop" />);
      expect(getByText('This project is open source. Your contributions make it better!')).not.toBeNull();
    });

    test('renders all 6 community action cards', () => {
      const { getByText } = render(<CommunitySection variant="desktop" />);
      for (const label of actionLabels) {
        expect(getByText(label)).not.toBeNull();
      }
    });

    test('each card is an anchor with target="_blank"', () => {
      const { getByText } = render(<CommunitySection variant="desktop" />);
      for (const label of actionLabels) {
        const anchor = getByText(label).closest('a');
        expect(anchor).not.toBeNull();
        expect(anchor!.getAttribute('target')).toBe('_blank');
        expect(anchor!.getAttribute('rel')).toBe('noopener noreferrer');
      }
    });

    test('cards link to correct GitHub URLs', () => {
      const { getByText } = render(<CommunitySection variant="desktop" />);
      const expectedUrls: Record<string, string> = {
        'Star & Fork': 'https://github.com/libredb/libredb-studio',
        'Open an Issue': 'https://github.com/libredb/libredb-studio/issues',
        'Discussions': 'https://github.com/libredb/libredb-studio/discussions',
        'Contribute': 'https://github.com/libredb/libredb-studio/blob/main/CONTRIBUTING.md',
        'Translate': 'https://github.com/libredb/libredb-studio/tree/main/src/lib',
        'Sponsor': 'https://github.com/sponsors/cevheri',
      };
      for (const [label, url] of Object.entries(expectedUrls)) {
        const anchor = getByText(label).closest('a');
        expect(anchor!.getAttribute('href')).toBe(url);
      }
    });
  });

  describe('Mobile variant', () => {
    test('renders section title', () => {
      const { getByText } = render(<CommunitySection variant="mobile" />);
      expect(getByText('Join the Community')).not.toBeNull();
    });

    test('renders all 6 community pills', () => {
      const { getByText } = render(<CommunitySection variant="mobile" />);
      for (const label of actionLabels) {
        expect(getByText(label)).not.toBeNull();
      }
    });

    test('each pill is an anchor with target="_blank"', () => {
      const { getByText } = render(<CommunitySection variant="mobile" />);
      for (const label of actionLabels) {
        const anchor = getByText(label).closest('a');
        expect(anchor).not.toBeNull();
        expect(anchor!.getAttribute('target')).toBe('_blank');
      }
    });

    test('renders divider', () => {
      const { container } = render(<CommunitySection variant="mobile" />);
      const divider = container.querySelector('.bg-muted');
      expect(divider).not.toBeNull();
    });
  });
});
