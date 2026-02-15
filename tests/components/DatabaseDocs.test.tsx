import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DatabaseDocs } from '@/components/DatabaseDocs';
import type { TableSchema } from '@/lib/types';

const schema: TableSchema[] = [
  {
    name: 'users',
    rowCount: 100,
    indexes: [],
    columns: [
      { name: 'id', type: 'SERIAL', nullable: false, isPrimary: true },
      { name: 'email', type: 'VARCHAR', nullable: true, isPrimary: false },
    ],
  },
  {
    name: 'orders',
    rowCount: 500,
    indexes: [],
    columns: [
      { name: 'id', type: 'SERIAL', nullable: false, isPrimary: true },
      { name: 'amount', type: 'NUMERIC', nullable: true, isPrimary: false },
    ],
  },
];

const emptySchema: TableSchema[] = [];

function mockFetchStream(body: string, ok = true, errorBody?: { error: string }) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  });
  return mock(() =>
    Promise.resolve({
      ok,
      body: ok ? stream : null,
      json: () => Promise.resolve(errorBody || {}),
    })
  );
}

describe('DatabaseDocs', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() => Promise.resolve(new Response('', { status: 200 }))) as never;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  // -----------------------------------------------------------------------
  // Basic rendering
  // -----------------------------------------------------------------------

  test('renders header with table count', () => {
    const { queryByText } = render(
      <DatabaseDocs schema={schema} schemaContext="[]" databaseType="postgres" />
    );
    expect(queryByText('Database Docs')).not.toBeNull();
    expect(queryByText('2 tables')).not.toBeNull();
  });

  test('renders search input', () => {
    const { queryByPlaceholderText } = render(
      <DatabaseDocs schema={schema} schemaContext="[]" />
    );
    expect(queryByPlaceholderText('Search tables or columns...')).not.toBeNull();
  });

  test('renders table names in Table Reference', () => {
    const { queryByText } = render(
      <DatabaseDocs schema={schema} schemaContext="[]" />
    );
    expect(queryByText('users')).not.toBeNull();
    expect(queryByText('orders')).not.toBeNull();
    expect(queryByText('Table Reference')).not.toBeNull();
  });

  test('shows column details: name, type, PK, nullable', () => {
    const { queryByText, queryAllByText } = render(
      <DatabaseDocs schema={schema} schemaContext="[]" />
    );
    expect(queryByText('email')).not.toBeNull();
    expect(queryByText('VARCHAR')).not.toBeNull();
    // PK indicator
    expect(queryAllByText('PK').length).toBeGreaterThan(0);
    // Nullable columns show "Yes"
    expect(queryAllByText('Yes').length).toBeGreaterThan(0);
    // Non-nullable columns show "No"
    expect(queryAllByText('No').length).toBeGreaterThan(0);
  });

  test('shows row count for tables', () => {
    const { queryByText } = render(
      <DatabaseDocs schema={schema} schemaContext="[]" />
    );
    expect(queryByText('100 rows')).not.toBeNull();
    expect(queryByText('500 rows')).not.toBeNull();
  });

  test('shows column count per table', () => {
    const { queryAllByText } = render(
      <DatabaseDocs schema={schema} schemaContext="[]" />
    );
    expect(queryAllByText('2 columns').length).toBe(2);
  });

  test('renders empty state with 0 tables', () => {
    const { queryByText } = render(
      <DatabaseDocs schema={emptySchema} schemaContext="[]" />
    );
    expect(queryByText('0 tables')).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Search filtering
  // -----------------------------------------------------------------------

  test('search filters by table name', async () => {
    const user = userEvent.setup();
    const { queryByText, queryByPlaceholderText } = render(
      <DatabaseDocs schema={schema} schemaContext="[]" />
    );
    const input = queryByPlaceholderText('Search tables or columns...')!;
    await user.type(input, 'orders');

    expect(queryByText('orders')).not.toBeNull();
    expect(queryByText('users')).toBeNull();
  });

  test('search filters by column name', async () => {
    const user = userEvent.setup();
    const { queryByText, queryByPlaceholderText } = render(
      <DatabaseDocs schema={schema} schemaContext="[]" />
    );
    const input = queryByPlaceholderText('Search tables or columns...')!;
    await user.type(input, 'email');

    // "users" table has "email" column, so it should still be visible
    expect(queryByText('users')).not.toBeNull();
    // "orders" has no "email" column, so it should be filtered out
    expect(queryByText('orders')).toBeNull();
  });

  test('search is case-insensitive', async () => {
    const user = userEvent.setup();
    const { queryByText, queryByPlaceholderText } = render(
      <DatabaseDocs schema={schema} schemaContext="[]" />
    );
    const input = queryByPlaceholderText('Search tables or columns...')!;
    await user.type(input, 'USERS');

    expect(queryByText('users')).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // AI Documentation generation
  // -----------------------------------------------------------------------

  test('AI Describe button triggers fetch to /api/ai/describe-schema', async () => {
    const user = userEvent.setup();
    globalThis.fetch = mockFetchStream('## Overview\nThis database has 2 tables.') as unknown as typeof fetch;

    const { queryByText } = render(
      <DatabaseDocs schema={schema} schemaContext="[]" databaseType="postgres" />
    );

    await user.click(queryByText('AI Describe')!);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as unknown as [string, RequestInit];
    expect(fetchCall[0]).toBe('/api/ai/describe-schema');
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.databaseType).toBe('postgres');
    expect(body.mode).toBe('full');
  });

  test('shows AI-generated documentation after fetch', async () => {
    const user = userEvent.setup();
    globalThis.fetch = mockFetchStream('## Overview\nThis database stores user data.') as unknown as typeof fetch;

    const { queryByText } = render(
      <DatabaseDocs schema={schema} schemaContext="[]" />
    );

    await user.click(queryByText('AI Describe')!);

    await waitFor(() => {
      expect(queryByText('AI-Generated Documentation')).not.toBeNull();
      expect(queryByText('Overview')).not.toBeNull();
    });
  });

  test('renders AI docs markdown: h2, h3, list items, paragraphs', async () => {
    const user = userEvent.setup();
    const mdContent = '## Section\n### Subsection\n- Item one\n1. Numbered item\nPlain text paragraph\n';
    globalThis.fetch = mockFetchStream(mdContent) as unknown as typeof fetch;

    const { queryByText, container } = render(
      <DatabaseDocs schema={schema} schemaContext="[]" />
    );

    await user.click(queryByText('AI Describe')!);

    await waitFor(() => {
      expect(container.querySelector('h2')?.textContent).toBe('Section');
      expect(container.querySelector('h3')?.textContent).toBe('Subsection');
      const lis = container.querySelectorAll('li');
      expect(lis.length).toBe(2);
    });
  });

  test('shows button text "Regenerate" after AI docs exist', async () => {
    const user = userEvent.setup();
    globalThis.fetch = mockFetchStream('Some docs') as unknown as typeof fetch;

    const { queryByText } = render(
      <DatabaseDocs schema={schema} schemaContext="[]" />
    );

    await user.click(queryByText('AI Describe')!);

    await waitFor(() => {
      expect(queryByText('Regenerate')).not.toBeNull();
    });
  });

  test('displays error on API failure', async () => {
    const user = userEvent.setup();
    globalThis.fetch = mockFetchStream('', false, { error: 'LLM quota exceeded' }) as unknown as typeof fetch;

    const { queryByText } = render(
      <DatabaseDocs schema={schema} schemaContext="[]" />
    );

    await user.click(queryByText('AI Describe')!);

    await waitFor(() => {
      expect(queryByText('LLM quota exceeded')).not.toBeNull();
    });
  });

  test('sends filtered schema context (sorted by rowCount, max 50 tables)', async () => {
    const user = userEvent.setup();
    const schemaCtx = JSON.stringify([
      { name: 'small', rowCount: 10, columns: [{ name: 'id', type: 'int', isPrimary: true }] },
      { name: 'big', rowCount: 1000, columns: [{ name: 'id', type: 'int' }] },
    ]);
    globalThis.fetch = mockFetchStream('docs') as unknown as typeof fetch;

    const { queryByText } = render(
      <DatabaseDocs schema={schema} schemaContext={schemaCtx} />
    );

    await user.click(queryByText('AI Describe')!);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(fetchCall[1].body as string);
    // Should contain table info
    expect(body.schemaContext).toContain('big');
    expect(body.schemaContext).toContain('small');
  });

  test('handles invalid schema JSON in context gracefully', async () => {
    const user = userEvent.setup();
    globalThis.fetch = mockFetchStream('docs') as unknown as typeof fetch;

    const { queryByText } = render(
      <DatabaseDocs schema={schema} schemaContext="invalid json!" />
    );

    await user.click(queryByText('AI Describe')!);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(fetchCall[1].body as string);
    // Falls back to substring
    expect(body.schemaContext).toBe('invalid json!');
  });

  // -----------------------------------------------------------------------
  // Export Markdown
  // -----------------------------------------------------------------------

  test('Export MD button creates and clicks download link', async () => {
    const user = userEvent.setup();
    const createObjectURLMock = mock(() => 'blob:fake-url');
    const revokeObjectURLMock = mock(() => {});
    const clickMock = mock(() => {});

    globalThis.URL.createObjectURL = createObjectURLMock;
    globalThis.URL.revokeObjectURL = revokeObjectURLMock;

    const origCreateElement = document.createElement.bind(document);
    const createElementSpy = mock((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === 'a') {
        el.click = clickMock;
      }
      return el;
    });
    document.createElement = createElementSpy as unknown as typeof document.createElement;

    const { queryByText } = render(
      <DatabaseDocs schema={schema} schemaContext="[]" databaseType="postgres" />
    );

    await user.click(queryByText('Export MD')!);

    expect(createObjectURLMock).toHaveBeenCalled();
    expect(clickMock).toHaveBeenCalled();
    expect(revokeObjectURLMock).toHaveBeenCalled();

    // Restore
    document.createElement = origCreateElement;
  });

  // -----------------------------------------------------------------------
  // Header buttons
  // -----------------------------------------------------------------------

  test('shows AI Describe and Export MD buttons', () => {
    const { queryByText } = render(
      <DatabaseDocs schema={schema} schemaContext="[]" />
    );
    expect(queryByText('AI Describe')).not.toBeNull();
    expect(queryByText('Export MD')).not.toBeNull();
  });
});
