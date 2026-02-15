import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render } from '@testing-library/react';
import { AIAutopilotPanel } from '@/components/AIAutopilotPanel';

globalThis.fetch = mock(() => Promise.resolve(new Response('', { status: 200 }))) as never;

describe('AIAutopilotPanel', () => {
  afterEach(() => { cleanup(); });

  test('renders idle state with header and run button', () => {
    const { queryAllByText, queryByText } = render(
      <AIAutopilotPanel connection={{ id: '1', name: 'test', type: 'postgres', host: 'localhost', port: 5432, database: 'db', user: 'u', password: 'p', createdAt: new Date() }} schemaContext="[]" />
    );
    expect(queryAllByText('AI Performance Autopilot').length).toBeGreaterThan(0);
    expect(queryByText('Run Analysis')).not.toBeNull();
  });

  test('shows idle placeholder when no connection', () => {
    const { container } = render(
      <AIAutopilotPanel connection={null} schemaContext="" />
    );
    expect(container.textContent).toContain('Run Analysis');
    expect(container.textContent).toContain('AI-powered optimization recommendations');
  });
});
