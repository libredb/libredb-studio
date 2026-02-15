import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, fireEvent, render } from '@testing-library/react';
import { DatabaseDocs } from '@/components/DatabaseDocs';
import type { TableSchema } from '@/lib/types';

globalThis.fetch = mock(() => Promise.resolve(new Response('', { status: 200 }))) as never;

const schema: TableSchema[] = [
  { name: 'users', rowCount: 100, indexes: [], columns: [{ name: 'id', type: 'SERIAL', nullable: false, isPrimary: true }, { name: 'email', type: 'VARCHAR', nullable: true, isPrimary: false }] },
  { name: 'orders', rowCount: 500, indexes: [], columns: [{ name: 'id', type: 'SERIAL', nullable: false, isPrimary: true }] },
];

describe('DatabaseDocs', () => {
  afterEach(() => { cleanup(); });

  test('renders header, search, and table reference', () => {
    const { queryByText, queryByPlaceholderText } = render(
      <DatabaseDocs schema={schema} schemaContext="[]" databaseType="postgres" />
    );
    expect(queryByText('Database Docs')).not.toBeNull();
    expect(queryByText('2 tables')).not.toBeNull();
    expect(queryByPlaceholderText('Search tables or columns...')).not.toBeNull();
    expect(queryByText('users')).not.toBeNull();
    expect(queryByText('orders')).not.toBeNull();
  });

  test('search filters tables', async () => {
    const { queryByText, queryByPlaceholderText } = render(
      <DatabaseDocs schema={schema} schemaContext="[]" />
    );
    const input = queryByPlaceholderText('Search tables or columns...')!;
    fireEvent.change(input, { target: { value: 'orders' } });
    await new Promise(r => setTimeout(r, 50));
    expect(queryByText('orders')).not.toBeNull();
  });

  test('shows column details in table reference', () => {
    const { queryByText } = render(<DatabaseDocs schema={schema} schemaContext="[]" />);
    expect(queryByText('email')).not.toBeNull();
    expect(queryByText('VARCHAR')).not.toBeNull();
  });
});
