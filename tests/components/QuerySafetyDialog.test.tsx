import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QuerySafetyDialog, isDangerousQuery } from '@/components/QuerySafetyDialog';

function createStreamResponse({
  chunks,
  ok = true,
  status = 200,
  jsonBody = {},
}: {
  chunks: string[];
  ok?: boolean;
  status?: number;
  jsonBody?: unknown;
}) {
  let idx = 0;
  return {
    ok,
    status,
    body: {
      getReader: () => ({
        read: async () => {
          if (idx >= chunks.length) {
            return { done: true, value: undefined };
          }
          const value = new TextEncoder().encode(chunks[idx]);
          idx += 1;
          return { done: false, value };
        },
      }),
    },
    json: async () => jsonBody,
  } as unknown as Response;
}

describe('QuerySafetyDialog', () => {
  const onClose = mock(() => {});
  const onProceed = mock(() => {});

  beforeEach(() => {
    onClose.mockClear();
    onProceed.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test('renders nothing when dialog is closed', () => {
    const { container } = render(
      <QuerySafetyDialog
        isOpen={false}
        query="SELECT 1"
        schemaContext=""
        onClose={onClose}
        onProceed={onProceed}
      />
    );
    expect(container.textContent).toBe('');
  });

  test('renders parsed high-risk analysis and caution action label', async () => {
    const payload = {
      riskLevel: 'high',
      summary: 'This query can update many rows.',
      warnings: [{ type: 'update', severity: 'warning', message: 'Potential full-table update', detail: 'WHERE clause is too broad.' }],
      affectedRows: '12000',
      cascadeEffects: 'none',
      recommendation: 'Add stricter predicates before execution.',
    };
    const markdownJson = `\`\`\`json\n${JSON.stringify(payload)}\n\`\`\``;
    globalThis.fetch = mock(async () => createStreamResponse({ chunks: [markdownJson] })) as unknown as typeof fetch;

    const { queryByText } = render(
      <QuerySafetyDialog
        isOpen
        query="UPDATE users SET role = 'admin'"
        schemaContext='[{"name":"users","rowCount":12000,"columns":[{"name":"id","type":"integer"}]}]'
        databaseType="postgres"
        onClose={onClose}
        onProceed={onProceed}
      />
    );

    await waitFor(() => {
      expect(queryByText('High Risk')).not.toBeNull();
      expect(queryByText('This query can update many rows.')).not.toBeNull();
      expect(queryByText('Potential full-table update')).not.toBeNull();
      expect(queryByText('Affected rows:')).not.toBeNull();
      expect(queryByText('Proceed with Caution')).not.toBeNull();
    });
  });

  test('shows raw response when analysis payload cannot be parsed', async () => {
    globalThis.fetch = mock(async () => createStreamResponse({ chunks: ['Plain text analysis output'] })) as unknown as typeof fetch;

    const { queryByText } = render(
      <QuerySafetyDialog
        isOpen
        query="DELETE FROM users WHERE id = 5"
        schemaContext=""
        onClose={onClose}
        onProceed={onProceed}
      />
    );

    await waitFor(() => {
      expect(queryByText('Plain text analysis output')).not.toBeNull();
    });
  });

  test('shows API error message when backend returns non-ok response', async () => {
    globalThis.fetch = mock(async () =>
      createStreamResponse({
        chunks: [],
        ok: false,
        status: 400,
        jsonBody: { error: 'Rate limit exceeded' },
      })
    ) as unknown as typeof fetch;

    const { queryByText } = render(
      <QuerySafetyDialog
        isOpen
        query="DROP TABLE users"
        schemaContext=""
        onClose={onClose}
        onProceed={onProceed}
      />
    );

    await waitFor(() => {
      expect(queryByText('Rate limit exceeded')).not.toBeNull();
    });
  });

  test('calls onClose and onProceed from action buttons', async () => {
    const safePayload = {
      riskLevel: 'safe',
      summary: 'Query looks safe.',
      warnings: [],
      affectedRows: 'none',
      cascadeEffects: 'none',
      recommendation: 'Proceed.',
    };
    globalThis.fetch = mock(async () =>
      createStreamResponse({ chunks: [JSON.stringify(safePayload)] })
    ) as unknown as typeof fetch;

    const { queryByText, container } = render(
      <QuerySafetyDialog
        isOpen
        query="SELECT * FROM users"
        schemaContext=""
        onClose={onClose}
        onProceed={onProceed}
      />
    );

    await waitFor(() => {
      expect(queryByText('Execute Query')).not.toBeNull();
    });

    const cancelButton = queryByText('Cancel');
    expect(cancelButton).not.toBeNull();
    fireEvent.click(cancelButton!);
    expect(onClose).toHaveBeenCalled();

    const proceedButton = queryByText('Execute Query');
    expect(proceedButton).not.toBeNull();
    fireEvent.click(proceedButton!);
    expect(onProceed).toHaveBeenCalled();

    const closeIconButton = container.querySelector('button');
    expect(closeIconButton).not.toBeNull();
    fireEvent.click(closeIconButton!);
    expect(onClose.mock.calls.length).toBeGreaterThan(1);
  });
});

describe('isDangerousQuery', () => {
  test('detects dangerous DML and DDL statements', () => {
    expect(isDangerousQuery('DELETE FROM users')).toBe(true);
    expect(isDangerousQuery('DROP TABLE users')).toBe(true);
    expect(isDangerousQuery('ALTER TABLE users ADD COLUMN x int')).toBe(true);
    expect(isDangerousQuery('GRANT SELECT ON users TO analyst')).toBe(true);
  });

  test('detects UPDATE/DELETE without WHERE as dangerous', () => {
    expect(isDangerousQuery('UPDATE users SET active = false')).toBe(true);
    expect(isDangerousQuery('DELETE FROM sessions')).toBe(true);
  });

  test('allows read-only queries', () => {
    expect(isDangerousQuery('SELECT * FROM users')).toBe(false);
    expect(isDangerousQuery('WITH cte AS (SELECT 1) SELECT * FROM cte')).toBe(false);
  });
});
