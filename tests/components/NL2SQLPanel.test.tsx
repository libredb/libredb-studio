import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import React from 'react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { cleanup, render, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NL2SQLPanel } from '@/components/NL2SQLPanel';

const defaultProps = {
  isOpen: true as boolean,
  onClose: mock(() => {}),
  onExecuteQuery: mock(() => {}),
  onLoadQuery: mock(() => {}),
  schemaContext: '[]',
  databaseType: undefined as string | undefined,
  queryLanguage: undefined as string | undefined,
};

function renderPanel(overrides: Partial<typeof defaultProps> = {}) {
  const user = userEvent.setup();
  const props = { ...defaultProps, ...overrides };
  const result = render(<NL2SQLPanel {...props} />);
  const input = result.queryByPlaceholderText(/Ask in plain English/) as HTMLInputElement | null;
  const form = result.container.querySelector('form');
  return { ...result, user, input, form, props };
}

// Helper to create a mock streaming response
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

describe('NL2SQLPanel', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    defaultProps.onClose = mock(() => {});
    defaultProps.onExecuteQuery = mock(() => {});
    defaultProps.onLoadQuery = mock(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    cleanup();
  });

  // -----------------------------------------------------------------------
  // Rendering / visibility
  // -----------------------------------------------------------------------

  test('does not render when isOpen is false', () => {
    const { container } = renderPanel({ isOpen: false });
    expect(container.textContent).toBe('');
  });

  test('renders header and empty state when open', () => {
    const { queryByText, input } = renderPanel();
    expect(queryByText('Natural Language Query')).not.toBeNull();
    expect(queryByText('Ask a question in plain English')).not.toBeNull();
    expect(input).not.toBeNull();
  });

  test('shows example prompt text', () => {
    const { queryByText } = renderPanel();
    expect(queryByText(/Show me the top 10 employees by salary/)).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // Close button
  // -----------------------------------------------------------------------

  test('calls onClose when close button clicked', async () => {
    const onClose = mock(() => {});
    const { container, user } = renderPanel({ onClose });
    const headerButtons = container.querySelectorAll('.flex.items-center.gap-1 button');
    const closeBtnEl = headerButtons[headerButtons.length - 1];
    await user.click(closeBtnEl);
    expect(onClose).toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Submit button disabled state
  // -----------------------------------------------------------------------

  test('submit button is disabled when input is empty', () => {
    const { form } = renderPanel();
    const submitBtn = form?.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(true);
  });

  test('submit button is enabled when input has text', async () => {
    const { form, input, user } = renderPanel();
    await user.type(input!, 'show all users');
    const submitBtn = form?.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(submitBtn.disabled).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Submitting a question — success flow
  // -----------------------------------------------------------------------

  test('sends question to API and displays user message', async () => {
    const responseText = 'Here is your query:\n```sql\nSELECT * FROM users;\n```';
    globalThis.fetch = mockFetchStream(responseText) as unknown as typeof fetch;

    const { input, form, user, queryByText } = renderPanel();
    await user.type(input!, 'show all users');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(queryByText('show all users')).not.toBeNull();
    });
  });

  test('displays assistant response with extracted query', async () => {
    const responseText = 'Here is your query:\n```sql\nSELECT * FROM users;\n```';
    globalThis.fetch = mockFetchStream(responseText) as unknown as typeof fetch;

    const { input, form, user, container } = renderPanel();
    await user.type(input!, 'show all users');
    fireEvent.submit(form!);

    await waitFor(() => {
      const pre = container.querySelector('pre');
      expect(pre).not.toBeNull();
      expect(pre!.textContent).toContain('SELECT * FROM users;');
    });
  });

  test('shows Run and Load to Editor buttons for extracted query', async () => {
    const responseText = '```sql\nSELECT 1;\n```';
    globalThis.fetch = mockFetchStream(responseText) as unknown as typeof fetch;

    const { input, form, user, queryByText } = renderPanel();
    await user.type(input!, 'test');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(queryByText('Run')).not.toBeNull();
      expect(queryByText('Load to Editor')).not.toBeNull();
    });
  });

  test('Run button calls onExecuteQuery with extracted query', async () => {
    const responseText = '```sql\nSELECT * FROM orders;\n```';
    const onExecuteQuery = mock(() => {});
    globalThis.fetch = mockFetchStream(responseText) as unknown as typeof fetch;

    const { input, form, user, queryByText } = renderPanel({ onExecuteQuery });
    await user.type(input!, 'get orders');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(queryByText('Run')).not.toBeNull();
    });

    await user.click(queryByText('Run')!);
    expect(onExecuteQuery).toHaveBeenCalledWith('SELECT * FROM orders;');
  });

  test('Load to Editor button calls onLoadQuery with extracted query', async () => {
    const responseText = '```sql\nSELECT id FROM items;\n```';
    const onLoadQuery = mock(() => {});
    globalThis.fetch = mockFetchStream(responseText) as unknown as typeof fetch;

    const { input, form, user, queryByText } = renderPanel({ onLoadQuery });
    await user.type(input!, 'get items');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(queryByText('Load to Editor')).not.toBeNull();
    });

    await user.click(queryByText('Load to Editor')!);
    expect(onLoadQuery).toHaveBeenCalledWith('SELECT id FROM items;');
  });

  // -----------------------------------------------------------------------
  // Submitting a question — error flow
  // -----------------------------------------------------------------------

  test('displays error when API returns non-ok response', async () => {
    globalThis.fetch = mockFetchStream('', false, { error: 'AI model unavailable' }) as unknown as typeof fetch;

    const { input, form, user, queryByText } = renderPanel();
    await user.type(input!, 'test query');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(queryByText('AI model unavailable')).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Empty/whitespace question
  // -----------------------------------------------------------------------

  test('does not submit empty question', async () => {
    globalThis.fetch = mock(() => Promise.resolve({ ok: true })) as unknown as typeof fetch;

    const { form } = renderPanel();
    fireEvent.submit(form!);

    // fetch should not be called
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // Question counter
  // -----------------------------------------------------------------------

  test('shows question count after messages exist', async () => {
    const responseText = '```sql\nSELECT 1;\n```';
    globalThis.fetch = mockFetchStream(responseText) as unknown as typeof fetch;

    const { input, form, user, queryByText } = renderPanel();
    await user.type(input!, 'first question');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(queryByText('1 questions')).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Clear conversation
  // -----------------------------------------------------------------------

  test('clear button removes all messages', async () => {
    const responseText = 'answer';
    globalThis.fetch = mockFetchStream(responseText) as unknown as typeof fetch;

    const { input, form, user, queryByText, container } = renderPanel();
    await user.type(input!, 'hello');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(queryByText('hello')).not.toBeNull();
    });

    // Find and click the clear/trash button
    const trashBtn = container.querySelector('button[title="Clear conversation"]');
    expect(trashBtn).not.toBeNull();
    await user.click(trashBtn!);

    // Messages should be cleared, empty state should return
    expect(queryByText('hello')).toBeNull();
    expect(queryByText('Ask a question in plain English')).not.toBeNull();
  });

  // -----------------------------------------------------------------------
  // extractCodeBlock (tested through component behavior)
  // -----------------------------------------------------------------------

  test('extracts SQL code block from response', async () => {
    const responseText = 'Try this:\n```sql\nSELECT name FROM employees;\n```\nThis gets all names.';
    globalThis.fetch = mockFetchStream(responseText) as unknown as typeof fetch;

    const { input, form, user, container } = renderPanel();
    await user.type(input!, 'get names');
    fireEvent.submit(form!);

    await waitFor(() => {
      const pre = container.querySelector('pre');
      expect(pre!.textContent).toBe('SELECT name FROM employees;');
    });
  });

  test('extracts JSON code block from response', async () => {
    const responseText = '```json\n{"collection":"users","operation":"find"}\n```';
    globalThis.fetch = mockFetchStream(responseText) as unknown as typeof fetch;

    const { input, form, user, container } = renderPanel();
    await user.type(input!, 'find users');
    fireEvent.submit(form!);

    await waitFor(() => {
      const pre = container.querySelector('pre');
      expect(pre!.textContent).toContain('"collection":"users"');
    });
  });

  test('extracts mongodb code block from response', async () => {
    const responseText = '```mongodb\ndb.users.find({})\n```';
    globalThis.fetch = mockFetchStream(responseText) as unknown as typeof fetch;

    const { input, form, user, container } = renderPanel();
    await user.type(input!, 'show users');
    fireEvent.submit(form!);

    await waitFor(() => {
      const pre = container.querySelector('pre');
      expect(pre!.textContent).toBe('db.users.find({})');
    });
  });

  test('shows explanation text without code block markup', async () => {
    const responseText = 'Here is the query:\n```sql\nSELECT 1;\n```\nThis selects the number one.';
    globalThis.fetch = mockFetchStream(responseText) as unknown as typeof fetch;

    const { input, form, user, queryByText } = renderPanel();
    await user.type(input!, 'test');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(queryByText(/This selects the number one/)).not.toBeNull();
    });
  });

  test('handles response without code block (no Run/Load buttons)', async () => {
    const responseText = 'I need more information about your schema to generate a query.';
    globalThis.fetch = mockFetchStream(responseText) as unknown as typeof fetch;

    const { input, form, user, queryByText } = renderPanel();
    await user.type(input!, 'do something');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(queryByText(/I need more information/)).not.toBeNull();
    });
    expect(queryByText('Run')).toBeNull();
    expect(queryByText('Load to Editor')).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Schema context filtering
  // -----------------------------------------------------------------------

  test('sends filtered schema context to API', async () => {
    const schema = JSON.stringify([
      { name: 'users', rowCount: 100, columns: [{ name: 'id', type: 'int', isPrimary: true }] },
      { name: 'orders', rowCount: 500, columns: [{ name: 'id', type: 'int' }] },
    ]);
    globalThis.fetch = mockFetchStream('response') as unknown as typeof fetch;

    const { input, form, user } = renderPanel({ schemaContext: schema });
    await user.type(input!, 'test');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.question).toBe('test');
    // Schema should be formatted, with orders first (higher rowCount)
    expect(body.schemaContext).toContain('orders');
    expect(body.schemaContext).toContain('users');
    expect(body.schemaContext.indexOf('orders')).toBeLessThan(body.schemaContext.indexOf('users'));
  });

  test('handles invalid schema JSON gracefully (truncates to 3000 chars)', async () => {
    globalThis.fetch = mockFetchStream('response') as unknown as typeof fetch;

    const { input, form, user } = renderPanel({ schemaContext: 'not valid json' });
    await user.type(input!, 'test');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.schemaContext).toBe('not valid json');
  });

  // -----------------------------------------------------------------------
  // Database type and query language
  // -----------------------------------------------------------------------

  test('passes databaseType and queryLanguage to API', async () => {
    globalThis.fetch = mockFetchStream('response') as unknown as typeof fetch;

    const { input, form, user } = renderPanel({
      databaseType: 'postgres',
      queryLanguage: 'sql',
    });
    await user.type(input!, 'test');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.databaseType).toBe('postgres');
    expect(body.queryLanguage).toBe('sql');
  });

  // -----------------------------------------------------------------------
  // Loading state
  // -----------------------------------------------------------------------

  test('shows loading indicator while waiting for response', async () => {
    // Create a fetch that never resolves
    globalThis.fetch = mock(() => new Promise(() => {})) as unknown as typeof fetch;

    const { input, form, user, queryByText } = renderPanel();
    await user.type(input!, 'test');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(queryByText('Generating query...')).not.toBeNull();
    });
  });

  test('disables input while loading', async () => {
    globalThis.fetch = mock(() => new Promise(() => {})) as unknown as typeof fetch;

    const { input, form, user } = renderPanel();
    await user.type(input!, 'test');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(input!.disabled).toBe(true);
    });
  });

  // -----------------------------------------------------------------------
  // conversationHistory sent in second API request
  // -----------------------------------------------------------------------

  test('sends conversationHistory with prior messages on second request', async () => {
    const responseText1 = '```sql\nSELECT 1;\n```';
    const responseText2 = '```sql\nSELECT 2;\n```';
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      const text = callCount === 1 ? responseText1 : responseText2;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
      return Promise.resolve({ ok: true, body: stream });
    }) as unknown as typeof fetch;

    const { input, form, user } = renderPanel();

    // First question
    await user.type(input!, 'first question');
    fireEvent.submit(form!);
    await waitFor(() => {
      expect(callCount).toBe(1);
    });

    // Second question
    await user.type(input!, 'second question');
    fireEvent.submit(form!);
    await waitFor(() => {
      expect(callCount).toBe(2);
    });

    const secondCall = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[1] as unknown as [string, RequestInit];
    const body = JSON.parse(secondCall[1].body as string);
    expect(body.conversationHistory).toBeDefined();
    expect(body.conversationHistory.length).toBe(2);
    expect(body.conversationHistory[0]).toEqual({ role: 'user', content: 'first question' });
    expect(body.conversationHistory[1].role).toBe('assistant');
  });

  // -----------------------------------------------------------------------
  // Question count display after multiple messages
  // -----------------------------------------------------------------------

  test('displays correct question count after multiple exchanges', async () => {
    let callCount = 0;
    globalThis.fetch = mock(() => {
      callCount++;
      const text = `answer ${callCount}`;
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(text));
          controller.close();
        },
      });
      return Promise.resolve({ ok: true, body: stream });
    }) as unknown as typeof fetch;

    const { input, form, user, queryByText } = renderPanel();

    // First question
    await user.type(input!, 'q1');
    fireEvent.submit(form!);
    await waitFor(() => {
      expect(queryByText('1 questions')).not.toBeNull();
    });

    // Second question
    await user.type(input!, 'q2');
    fireEvent.submit(form!);
    await waitFor(() => {
      expect(queryByText('2 questions')).not.toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Clear conversation button visibility
  // -----------------------------------------------------------------------

  test('clear conversation button is visible when messages exist', async () => {
    const responseText = 'some response';
    globalThis.fetch = mockFetchStream(responseText) as unknown as typeof fetch;

    const { input, form, user, container } = renderPanel();
    await user.type(input!, 'hello');
    fireEvent.submit(form!);

    await waitFor(() => {
      const clearBtn = container.querySelector('button[title="Clear conversation"]');
      expect(clearBtn).not.toBeNull();
    });
  });

  test('clear conversation button is hidden when no messages exist', () => {
    const { container } = renderPanel();
    const clearBtn = container.querySelector('button[title="Clear conversation"]');
    expect(clearBtn).toBeNull();
  });

  // -----------------------------------------------------------------------
  // Input focus on panel open
  // -----------------------------------------------------------------------

  test('input receives focus when panel opens', () => {
    const { input } = renderPanel({ isOpen: true });
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  // -----------------------------------------------------------------------
  // Explanation text alongside code block
  // -----------------------------------------------------------------------

  test('renders both code block and explanation text in assistant message', async () => {
    const responseText = 'Here is the query:\n```sql\nSELECT id FROM products;\n```\nThis returns all product IDs from the table.';
    globalThis.fetch = mockFetchStream(responseText) as unknown as typeof fetch;

    const { input, form, user, container, queryByText } = renderPanel();
    await user.type(input!, 'get product ids');
    fireEvent.submit(form!);

    await waitFor(() => {
      // Code block is rendered
      const pre = container.querySelector('pre');
      expect(pre).not.toBeNull();
      expect(pre!.textContent).toBe('SELECT id FROM products;');
      // Explanation text is also rendered
      expect(queryByText(/This returns all product IDs/)).not.toBeNull();
      // Code block markup is stripped from explanation
      expect(queryByText(/```/)).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Schema context parse failure fallback — truncation
  // -----------------------------------------------------------------------

  test('truncates invalid schema context to 3000 characters', async () => {
    const longInvalidSchema = 'x'.repeat(5000);
    globalThis.fetch = mockFetchStream('response') as unknown as typeof fetch;

    const { input, form, user } = renderPanel({ schemaContext: longInvalidSchema });
    await user.type(input!, 'test');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    const fetchCall = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(fetchCall[1].body as string);
    expect(body.schemaContext.length).toBe(3000);
    expect(body.schemaContext).toBe('x'.repeat(3000));
  });

  // -----------------------------------------------------------------------
  // Non-ok response with fallback error message
  // -----------------------------------------------------------------------

  test('displays fallback error message when API error has no error field', async () => {
    globalThis.fetch = mock(() =>
      Promise.resolve({
        ok: false,
        body: null,
        json: () => Promise.resolve({}),
      })
    ) as unknown as typeof fetch;

    const { input, form, user, queryByText } = renderPanel();
    await user.type(input!, 'test query');
    fireEvent.submit(form!);

    await waitFor(() => {
      expect(queryByText('Request failed')).not.toBeNull();
    });
  });
});
