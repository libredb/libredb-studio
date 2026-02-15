import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, fireEvent, waitFor, act } from '@testing-library/react';
import { AIAutopilotPanel } from '@/components/AIAutopilotPanel';
import { mockPostgresConnection } from '../fixtures/connections';

// ── Helpers ─────────────────────────────────────────────────────────────────

function createStreamResponse(text: string, status = 200) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'Content-Type': 'text/plain' } });
}

function createJsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const validSchemaContext = JSON.stringify([
  { name: 'users', rowCount: 100, columns: [{ name: 'id', type: 'integer' }, { name: 'email', type: 'varchar' }] },
  { name: 'orders', rowCount: 500, columns: [{ name: 'id', type: 'integer' }, { name: 'user_id', type: 'integer' }] },
]);

const defaultProps = {
  connection: mockPostgresConnection,
  schemaContext: validSchemaContext,
};

// ── Tests ───────────────────────────────────────────────────────────────────

describe('AIAutopilotPanel', () => {
  let originalFetch: typeof globalThis.fetch;
  let mockWriteText: ReturnType<typeof mock>;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    mockWriteText = mock(async () => {});
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: mockWriteText },
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  // ── Idle State ──────────────────────────────────────────────────────────

  test('renders idle state with header and run button', () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(''))) as never;
    const { queryAllByText, queryByText } = render(
      <AIAutopilotPanel {...defaultProps} />
    );
    expect(queryAllByText('AI Performance Autopilot').length).toBeGreaterThan(0);
    expect(queryByText('Run Analysis')).not.toBeNull();
  });

  test('shows idle placeholder text when no report', () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(''))) as never;
    const { container } = render(
      <AIAutopilotPanel {...defaultProps} />
    );
    expect(container.textContent).toContain('AI-powered optimization recommendations');
  });

  test('shows idle placeholder when connection is null', () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(''))) as never;
    const { container } = render(
      <AIAutopilotPanel connection={null} schemaContext="" />
    );
    expect(container.textContent).toContain('AI-powered optimization recommendations');
  });

  // ── Button states ───────────────────────────────────────────────────────

  test('run button is disabled when connection is null', () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(''))) as never;
    const { queryByText } = render(
      <AIAutopilotPanel connection={null} schemaContext="" />
    );
    const button = queryByText('Run Analysis')!.closest('button');
    expect(button).not.toBeNull();
    expect(button!.disabled).toBe(true);
  });

  test('run button is enabled when connection is provided', () => {
    globalThis.fetch = mock(() => Promise.resolve(new Response(''))) as never;
    const { queryByText } = render(
      <AIAutopilotPanel {...defaultProps} />
    );
    const button = queryByText('Run Analysis')!.closest('button');
    expect(button!.disabled).toBe(false);
  });

  // ── runAutopilot: success path ──────────────────────────────────────────

  test('shows loading state while analyzing', async () => {
    let resolveAutopilot: (value: Response) => void;
    const autopilotPromise = new Promise<Response>((r) => { resolveAutopilot = r; });

    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') {
        return Promise.resolve(createJsonResponse({ tables: [], indexes: [], slowQueries: [] }));
      }
      return autopilotPromise;
    }) as never;

    const { queryByText } = render(<AIAutopilotPanel {...defaultProps} />);

    await act(async () => {
      fireEvent.click(queryByText('Run Analysis')!.closest('button')!);
    });

    // Should show Analyzing... while waiting
    expect(queryByText('Analyzing...')).not.toBeNull();

    // Resolve to finish
    await act(async () => {
      resolveAutopilot!(createStreamResponse('done'));
    });
  });

  test('streams report content from autopilot endpoint', async () => {
    const reportText = '## Performance Report\n\nYour database is healthy.';

    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') {
        return Promise.resolve(createJsonResponse({
          tables: [{ name: 'users', rows: 100 }],
          indexes: [],
          slowQueries: [],
          performance: {},
          overview: {},
        }));
      }
      return Promise.resolve(createStreamResponse(reportText));
    }) as never;

    const { queryByText, container } = render(<AIAutopilotPanel {...defaultProps} />);

    await act(async () => {
      fireEvent.click(queryByText('Run Analysis')!.closest('button')!);
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Performance Report');
      expect(container.textContent).toContain('Your database is healthy.');
    });
  });

  test('shows Re-analyze after report is loaded', async () => {
    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') {
        return Promise.resolve(createJsonResponse({}));
      }
      return Promise.resolve(createStreamResponse('Report content'));
    }) as never;

    const { queryByText } = render(<AIAutopilotPanel {...defaultProps} />);

    await act(async () => {
      fireEvent.click(queryByText('Run Analysis')!.closest('button')!);
    });

    await waitFor(() => {
      expect(queryByText('Re-analyze')).not.toBeNull();
    });
  });

  // ── runAutopilot: does nothing without connection ───────────────────────

  test('runAutopilot does nothing when connection is null', async () => {
    const fetchMock = mock(() => Promise.resolve(new Response('')));
    globalThis.fetch = fetchMock as never;

    const { queryByText } = render(
      <AIAutopilotPanel connection={null} schemaContext="" />
    );

    // Button is disabled, but try clicking anyway
    await act(async () => {
      fireEvent.click(queryByText('Run Analysis')!.closest('button')!);
    });

    // fetch should not have been called
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // ── runAutopilot: monitoring fetch fails gracefully ─────────────────────

  test('continues when monitoring endpoint returns non-ok response', async () => {
    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') {
        return Promise.resolve(new Response('', { status: 500 }));
      }
      return Promise.resolve(createStreamResponse('## Recommendations\n\nUse indexes.'));
    }) as never;

    const { queryByText, container } = render(<AIAutopilotPanel {...defaultProps} />);

    await act(async () => {
      fireEvent.click(queryByText('Run Analysis')!.closest('button')!);
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Recommendations');
    });
  });

  // ── runAutopilot: autopilot endpoint error ──────────────────────────────

  test('shows error when autopilot endpoint returns non-ok', async () => {
    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') {
        return Promise.resolve(createJsonResponse({}));
      }
      return Promise.resolve(createJsonResponse({ error: 'AI service unavailable' }, 503));
    }) as never;

    const { queryByText, container } = render(<AIAutopilotPanel {...defaultProps} />);

    await act(async () => {
      fireEvent.click(queryByText('Run Analysis')!.closest('button')!);
    });

    await waitFor(() => {
      expect(container.textContent).toContain('AI service unavailable');
    });
  });

  test('shows default error message when autopilot error has no message', async () => {
    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') {
        return Promise.resolve(createJsonResponse({}));
      }
      return Promise.resolve(createJsonResponse({}, 500));
    }) as never;

    const { queryByText, container } = render(<AIAutopilotPanel {...defaultProps} />);

    await act(async () => {
      fireEvent.click(queryByText('Run Analysis')!.closest('button')!);
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Autopilot analysis failed');
    });
  });

  // ── runAutopilot: no reader ─────────────────────────────────────────────

  test('shows error when response body has no reader', async () => {
    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') {
        return Promise.resolve(createJsonResponse({}));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    }) as never;

    const { queryByText, container } = render(<AIAutopilotPanel {...defaultProps} />);

    await act(async () => {
      fireEvent.click(queryByText('Run Analysis')!.closest('button')!);
    });

    await waitFor(() => {
      expect(container.textContent).toContain('No reader');
    });
  });

  // ── runAutopilot: fetch throws ──────────────────────────────────────────

  test('shows error when fetch throws an exception', async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error('Network failure'))) as never;

    const { queryByText, container } = render(<AIAutopilotPanel {...defaultProps} />);

    await act(async () => {
      fireEvent.click(queryByText('Run Analysis')!.closest('button')!);
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Network failure');
    });
  });

  test('shows Unknown error for non-Error throws', async () => {
    globalThis.fetch = mock(() => Promise.reject('string error')) as never;

    const { queryByText, container } = render(<AIAutopilotPanel {...defaultProps} />);

    await act(async () => {
      fireEvent.click(queryByText('Run Analysis')!.closest('button')!);
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Unknown error');
    });
  });

  // ── schemaContext parsing ───────────────────────────────────────────────

  test('handles invalid JSON schemaContext gracefully (falls back to substring)', async () => {
    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') {
        return Promise.resolve(createJsonResponse({}));
      }
      return Promise.resolve(createStreamResponse('Analysis done'));
    }) as never;

    const { queryByText, container } = render(
      <AIAutopilotPanel connection={mockPostgresConnection} schemaContext="not valid json {{{" />
    );

    await act(async () => {
      fireEvent.click(queryByText('Run Analysis')!.closest('button')!);
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Analysis done');
    });
  });

  test('handles empty schemaContext', async () => {
    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') {
        return Promise.resolve(createJsonResponse({}));
      }
      return Promise.resolve(createStreamResponse('Report'));
    }) as never;

    const { queryByText, container } = render(
      <AIAutopilotPanel connection={mockPostgresConnection} schemaContext="" />
    );

    await act(async () => {
      fireEvent.click(queryByText('Run Analysis')!.closest('button')!);
    });

    await waitFor(() => {
      expect(container.textContent).toContain('Report');
    });
  });

  // ── Markdown rendering ──────────────────────────────────────────────────

  test('renders ## headers', async () => {
    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') return Promise.resolve(createJsonResponse({}));
      return Promise.resolve(createStreamResponse('## My Header'));
    }) as never;

    const { queryByText, container } = render(<AIAutopilotPanel {...defaultProps} />);
    await act(async () => { fireEvent.click(queryByText('Run Analysis')!.closest('button')!); });

    await waitFor(() => {
      const h2 = container.querySelector('h2');
      expect(h2).not.toBeNull();
      expect(h2!.textContent).toBe('My Header');
    });
  });

  test('renders ### subheaders', async () => {
    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') return Promise.resolve(createJsonResponse({}));
      return Promise.resolve(createStreamResponse('### Sub Header'));
    }) as never;

    const { queryByText, container } = render(<AIAutopilotPanel {...defaultProps} />);
    await act(async () => { fireEvent.click(queryByText('Run Analysis')!.closest('button')!); });

    await waitFor(() => {
      const h3 = container.querySelector('h3');
      expect(h3).not.toBeNull();
      expect(h3!.textContent).toBe('Sub Header');
    });
  });

  test('renders bullet lists with - prefix', async () => {
    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') return Promise.resolve(createJsonResponse({}));
      return Promise.resolve(createStreamResponse('- First item\n- Second item'));
    }) as never;

    const { queryByText, container } = render(<AIAutopilotPanel {...defaultProps} />);
    await act(async () => { fireEvent.click(queryByText('Run Analysis')!.closest('button')!); });

    await waitFor(() => {
      const items = container.querySelectorAll('li');
      expect(items.length).toBe(2);
      expect(items[0].textContent).toContain('First item');
      expect(items[1].textContent).toContain('Second item');
    });
  });

  test('renders numbered lists', async () => {
    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') return Promise.resolve(createJsonResponse({}));
      return Promise.resolve(createStreamResponse('1. Step one\n2. Step two'));
    }) as never;

    const { queryByText, container } = render(<AIAutopilotPanel {...defaultProps} />);
    await act(async () => { fireEvent.click(queryByText('Run Analysis')!.closest('button')!); });

    await waitFor(() => {
      const items = container.querySelectorAll('li.list-decimal');
      expect(items.length).toBe(2);
    });
  });

  test('renders bold text with **markers**', async () => {
    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') return Promise.resolve(createJsonResponse({}));
      return Promise.resolve(createStreamResponse('This has **bold** text'));
    }) as never;

    const { queryByText, container } = render(<AIAutopilotPanel {...defaultProps} />);
    await act(async () => { fireEvent.click(queryByText('Run Analysis')!.closest('button')!); });

    await waitFor(() => {
      const strong = container.querySelector('strong');
      expect(strong).not.toBeNull();
      expect(strong!.textContent).toBe('bold');
    });
  });

  test('renders plain text paragraphs', async () => {
    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') return Promise.resolve(createJsonResponse({}));
      return Promise.resolve(createStreamResponse('Just a regular paragraph.'));
    }) as never;

    const { queryByText, container } = render(<AIAutopilotPanel {...defaultProps} />);
    await act(async () => { fireEvent.click(queryByText('Run Analysis')!.closest('button')!); });

    await waitFor(() => {
      const p = container.querySelector('p.text-xs.text-zinc-400');
      expect(p).not.toBeNull();
      expect(p!.textContent).toContain('Just a regular paragraph.');
    });
  });

  test('renders empty lines as spacers', async () => {
    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') return Promise.resolve(createJsonResponse({}));
      return Promise.resolve(createStreamResponse('Line one\n\nLine two'));
    }) as never;

    const { queryByText, container } = render(<AIAutopilotPanel {...defaultProps} />);
    await act(async () => { fireEvent.click(queryByText('Run Analysis')!.closest('button')!); });

    await waitFor(() => {
      const spacer = container.querySelector('.h-2');
      expect(spacer).not.toBeNull();
    });
  });

  // ── Code blocks ─────────────────────────────────────────────────────────

  test('renders code blocks with copy button', async () => {
    const sql = 'SELECT * FROM users;';
    const report = '```sql\n' + sql + '\n```';

    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') return Promise.resolve(createJsonResponse({}));
      return Promise.resolve(createStreamResponse(report));
    }) as never;

    const { queryByText, container } = render(<AIAutopilotPanel {...defaultProps} />);
    await act(async () => { fireEvent.click(queryByText('Run Analysis')!.closest('button')!); });

    await waitFor(() => {
      const pre = container.querySelector('pre');
      expect(pre).not.toBeNull();
      expect(pre!.textContent).toContain('SELECT * FROM users;');

      // Copy button exists
      const copyBtn = container.querySelector('button[title="Copy"]');
      expect(copyBtn).not.toBeNull();
    });
  });

  test('renders execute button when onExecuteQuery is provided', async () => {
    const sql = 'CREATE INDEX idx_email ON users(email);';
    const report = '```sql\n' + sql + '\n```';

    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') return Promise.resolve(createJsonResponse({}));
      return Promise.resolve(createStreamResponse(report));
    }) as never;

    const onExecuteQuery = mock(() => {});
    const { queryByText, container } = render(
      <AIAutopilotPanel {...defaultProps} onExecuteQuery={onExecuteQuery} />
    );
    await act(async () => { fireEvent.click(queryByText('Run Analysis')!.closest('button')!); });

    await waitFor(() => {
      const execBtn = container.querySelector('button[title="Execute"]');
      expect(execBtn).not.toBeNull();
    });
  });

  test('does not render execute button when onExecuteQuery is not provided', async () => {
    const report = '```sql\nSELECT 1;\n```';

    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') return Promise.resolve(createJsonResponse({}));
      return Promise.resolve(createStreamResponse(report));
    }) as never;

    const { queryByText, container } = render(
      <AIAutopilotPanel {...defaultProps} />
    );
    await act(async () => { fireEvent.click(queryByText('Run Analysis')!.closest('button')!); });

    await waitFor(() => {
      const execBtn = container.querySelector('button[title="Execute"]');
      expect(execBtn).toBeNull();
    });
  });

  // ── Copy to clipboard ───────────────────────────────────────────────────

  test('copy button copies SQL to clipboard', async () => {
    const sql = 'EXPLAIN ANALYZE SELECT * FROM orders;';
    const report = '```sql\n' + sql + '\n```';

    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') return Promise.resolve(createJsonResponse({}));
      return Promise.resolve(createStreamResponse(report));
    }) as never;

    const { queryByText, container } = render(<AIAutopilotPanel {...defaultProps} />);
    await act(async () => { fireEvent.click(queryByText('Run Analysis')!.closest('button')!); });

    await waitFor(() => {
      const copyBtn = container.querySelector('button[title="Copy"]');
      expect(copyBtn).not.toBeNull();
    });

    fireEvent.click(container.querySelector('button[title="Copy"]')!);
    expect(mockWriteText).toHaveBeenCalledTimes(1);
    expect((mockWriteText.mock.calls as unknown[][])[0][0]).toBe(sql);
  });

  // ── Execute button ──────────────────────────────────────────────────────

  test('execute button calls onExecuteQuery with SQL', async () => {
    const sql = 'VACUUM ANALYZE users;';
    const report = '```sql\n' + sql + '\n```';

    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') return Promise.resolve(createJsonResponse({}));
      return Promise.resolve(createStreamResponse(report));
    }) as never;

    const onExecuteQuery = mock(() => {});
    const { queryByText, container } = render(
      <AIAutopilotPanel {...defaultProps} onExecuteQuery={onExecuteQuery} />
    );
    await act(async () => { fireEvent.click(queryByText('Run Analysis')!.closest('button')!); });

    await waitFor(() => {
      const execBtn = container.querySelector('button[title="Execute"]');
      expect(execBtn).not.toBeNull();
    });

    fireEvent.click(container.querySelector('button[title="Execute"]')!);
    expect(onExecuteQuery).toHaveBeenCalledTimes(1);
    expect((onExecuteQuery.mock.calls as unknown[][])[0][0]).toBe(sql);
  });

  // ── Multiple code blocks ────────────────────────────────────────────────

  test('renders multiple code blocks independently', async () => {
    const report = '## Fix 1\n```sql\nSELECT 1;\n```\n## Fix 2\n```sql\nSELECT 2;\n```';

    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') return Promise.resolve(createJsonResponse({}));
      return Promise.resolve(createStreamResponse(report));
    }) as never;

    const { queryByText, container } = render(<AIAutopilotPanel {...defaultProps} />);
    await act(async () => { fireEvent.click(queryByText('Run Analysis')!.closest('button')!); });

    await waitFor(() => {
      const preElements = container.querySelectorAll('pre');
      expect(preElements.length).toBe(2);
      expect(preElements[0].textContent).toContain('SELECT 1;');
      expect(preElements[1].textContent).toContain('SELECT 2;');
    });
  });

  // ── Bold in lists ───────────────────────────────────────────────────────

  test('renders bold text inside bullet list items', async () => {
    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') return Promise.resolve(createJsonResponse({}));
      return Promise.resolve(createStreamResponse('- **Impact**: High'));
    }) as never;

    const { queryByText, container } = render(<AIAutopilotPanel {...defaultProps} />);
    await act(async () => { fireEvent.click(queryByText('Run Analysis')!.closest('button')!); });

    await waitFor(() => {
      const strong = container.querySelector('li strong');
      expect(strong).not.toBeNull();
      expect(strong!.textContent).toBe('Impact');
    });
  });

  // ── Schema slicing ─────────────────────────────────────────────────────

  test('sends filtered schema with max 30 tables and 6 columns each', async () => {
    const bigSchema = Array.from({ length: 50 }, (_, i) => ({
      name: `table_${i}`,
      rowCount: i * 10,
      columns: Array.from({ length: 10 }, (_, j) => ({ name: `col_${j}`, type: 'text' })),
    }));

    let capturedBody: string | null = null;
    globalThis.fetch = mock((url: string, opts?: RequestInit) => {
      if (url === '/api/db/monitoring') {
        return Promise.resolve(createJsonResponse({}));
      }
      if (url === '/api/ai/autopilot') {
        capturedBody = opts?.body as string;
        return Promise.resolve(createStreamResponse('Done'));
      }
      return Promise.resolve(new Response(''));
    }) as never;

    const { queryByText } = render(
      <AIAutopilotPanel connection={mockPostgresConnection} schemaContext={JSON.stringify(bigSchema)} />
    );

    await act(async () => {
      fireEvent.click(queryByText('Run Analysis')!.closest('button')!);
    });

    await waitFor(() => {
      expect(capturedBody).not.toBeNull();
    });

    const parsed = JSON.parse(capturedBody!);
    // schemaContext should only have 30 table lines
    const lines = parsed.schemaContext.split('\n').filter((l: string) => l.trim());
    expect(lines.length).toBe(30);
    // Each line should have max 6 columns
    const firstLine = lines[0];
    // columns are joined with ", " — count commas to approximate
    // 6 columns = 5 commas (in the column part)
    expect(firstLine).toContain('col_0');
    expect(firstLine).toContain('col_5');
    expect(firstLine).not.toContain('col_6');
  });

  // ── Error display styling ───────────────────────────────────────────────

  test('error message has red styling', async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error('Connection lost'))) as never;

    const { queryByText, container } = render(<AIAutopilotPanel {...defaultProps} />);
    await act(async () => { fireEvent.click(queryByText('Run Analysis')!.closest('button')!); });

    await waitFor(() => {
      const errorDiv = container.querySelector('.text-red-400');
      expect(errorDiv).not.toBeNull();
      expect(errorDiv!.textContent).toContain('Connection lost');
    });
  });

  // ── Hides placeholder when report/error/loading ─────────────────────────

  test('hides idle placeholder when report is shown', async () => {
    globalThis.fetch = mock((url: string) => {
      if (url === '/api/db/monitoring') return Promise.resolve(createJsonResponse({}));
      return Promise.resolve(createStreamResponse('Report text'));
    }) as never;

    const { queryByText } = render(<AIAutopilotPanel {...defaultProps} />);
    await act(async () => { fireEvent.click(queryByText('Run Analysis')!.closest('button')!); });

    await waitFor(() => {
      // Placeholder should be gone
      expect(queryByText('AI-powered optimization recommendations')).toBeNull();
      // Report should be visible
      expect(queryByText('Report text')).not.toBeNull();
    });
  });

  test('hides idle placeholder when error is shown', async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error('fail'))) as never;

    const { queryByText } = render(<AIAutopilotPanel {...defaultProps} />);
    await act(async () => { fireEvent.click(queryByText('Run Analysis')!.closest('button')!); });

    await waitFor(() => {
      expect(queryByText('AI-powered optimization recommendations')).toBeNull();
    });
  });

  // ── Monitoring data is passed to autopilot ──────────────────────────────

  test('passes monitoring data to autopilot endpoint', async () => {
    const monitoringData = {
      tables: [{ name: 'users', rows: 100 }],
      indexes: [{ name: 'idx_1' }],
      slowQueries: [{ query: 'SELECT *', duration: 5000 }],
      performance: { cpu: 0.5 },
      overview: { connections: 10 },
    };

    let capturedBody: string | null = null;
    globalThis.fetch = mock((url: string, opts?: RequestInit) => {
      if (url === '/api/db/monitoring') {
        return Promise.resolve(createJsonResponse(monitoringData));
      }
      if (url === '/api/ai/autopilot') {
        capturedBody = opts?.body as string;
        return Promise.resolve(createStreamResponse('OK'));
      }
      return Promise.resolve(new Response(''));
    }) as never;

    const { queryByText } = render(<AIAutopilotPanel {...defaultProps} />);
    await act(async () => { fireEvent.click(queryByText('Run Analysis')!.closest('button')!); });

    await waitFor(() => {
      expect(capturedBody).not.toBeNull();
    });

    const parsed = JSON.parse(capturedBody!);
    expect(parsed.slowQueries).toEqual(monitoringData.slowQueries);
    expect(parsed.indexStats).toEqual(monitoringData.indexes);
    expect(parsed.tableStats).toEqual(monitoringData.tables);
    expect(parsed.performanceMetrics).toEqual(monitoringData.performance);
    expect(parsed.overview).toEqual(monitoringData.overview);
    expect(parsed.databaseType).toBe('postgres');
  });
});
