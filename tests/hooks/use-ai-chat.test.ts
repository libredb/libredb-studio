import '../setup-dom';
import '../helpers/mock-sonner';
import '../helpers/mock-navigation';

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { renderHook, act, waitFor } from '@testing-library/react';
import { mockGlobalFetch, restoreGlobalFetch } from '../helpers/mock-fetch';

import { useAiChat } from '@/hooks/use-ai-chat';

// ── Helpers ─────────────────────────────────────────────────────────────────

interface ParsedTable {
  name: string;
  rowCount?: number;
  columns?: Array<{ name: string; type: string; isPrimary?: boolean }>;
}

const defaultParsedSchema: ParsedTable[] = [
  {
    name: 'users',
    rowCount: 100,
    columns: [
      { name: 'id', type: 'integer', isPrimary: true },
      { name: 'email', type: 'varchar' },
    ],
  },
];

const defaultSchemaContext = JSON.stringify(defaultParsedSchema);

function makeDeps(overrides: Partial<Parameters<typeof useAiChat>[0]> = {}) {
  return {
    parsedSchema: defaultParsedSchema,
    schemaContext: defaultSchemaContext,
    databaseType: 'postgres',
    getEditorValue: mock(() => '') as () => string,
    setEditorValue: mock(() => {}) as (value: string) => void,
    onChange: mock(() => {}) as (val: string) => void,
    ...overrides,
  };
}

/**
 * Creates a ReadableStream that emits the given chunks of text.
 */
function makeTextStream(...chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

// =============================================================================
// useAiChat Tests
// =============================================================================
describe('useAiChat', () => {
  beforeEach(() => {
    // Ensure requestAnimationFrame/cancelAnimationFrame are available
    if (typeof globalThis.requestAnimationFrame === 'undefined') {
      (globalThis as Record<string, unknown>).requestAnimationFrame = (cb: FrameRequestCallback) => {
        return setTimeout(() => cb(Date.now()), 0) as unknown as number;
      };
    }
    if (typeof globalThis.cancelAnimationFrame === 'undefined') {
      (globalThis as Record<string, unknown>).cancelAnimationFrame = (id: number) => {
        clearTimeout(id);
      };
    }
  });

  afterEach(() => {
    restoreGlobalFetch();
  });

  // ── Initial State ─────────────────────────────────────────────────────────

  test('initially showAi is false and aiPrompt is empty', () => {
    const { result } = renderHook(() => useAiChat(makeDeps()));

    expect(result.current.showAi).toBe(false);
    expect(result.current.aiPrompt).toBe('');
    expect(result.current.isAiLoading).toBe(false);
    expect(result.current.aiError).toBeNull();
    expect(result.current.aiConversationHistory).toEqual([]);
  });

  // ── setShowAi toggles visibility ──────────────────────────────────────────

  test('setShowAi toggles visibility', () => {
    const { result } = renderHook(() => useAiChat(makeDeps()));

    act(() => {
      result.current.setShowAi(true);
    });
    expect(result.current.showAi).toBe(true);

    act(() => {
      result.current.setShowAi(false);
    });
    expect(result.current.showAi).toBe(false);
  });

  // ── setAiPrompt updates prompt text ───────────────────────────────────────

  test('setAiPrompt updates prompt text', () => {
    const { result } = renderHook(() => useAiChat(makeDeps()));

    act(() => {
      result.current.setAiPrompt('show me all users');
    });
    expect(result.current.aiPrompt).toBe('show me all users');
  });

  // ── handleAiSubmit does nothing when prompt is empty ──────────────────────

  test('handleAiSubmit does nothing when prompt is empty', async () => {
    const fetchMock = mockGlobalFetch({});

    const { result } = renderHook(() => useAiChat(makeDeps()));

    await act(async () => {
      await result.current.handleAiSubmit();
    });

    // fetch should not have been called
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.isAiLoading).toBe(false);
  });

  // ── handleAiSubmit does nothing when isAiLoading is true ──────────────────

  test('handleAiSubmit does nothing when isAiLoading is true', async () => {
    // We simulate this by calling handleAiSubmit with a never-resolving fetch,
    // then calling it again while the first is still pending.
    let resolveFetch: ((value: Response) => void) | undefined;
    globalThis.fetch = mock(async () => {
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useAiChat(makeDeps()));

    // Set a prompt so handleAiSubmit doesn't bail early
    act(() => {
      result.current.setAiPrompt('query one');
    });

    // Start first call (will hang)
    act(() => {
      result.current.handleAiSubmit();
    });

    await waitFor(() => {
      expect(result.current.isAiLoading).toBe(true);
    });

    // Try to submit again while loading
    const fetchCallCount = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls.length;

    act(() => {
      result.current.setAiPrompt('query two');
    });

    await act(async () => {
      await result.current.handleAiSubmit();
    });

    // Fetch should NOT have been called a second time
    expect((globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls.length).toBe(fetchCallCount);

    // Clean up: resolve the pending fetch
    resolveFetch!(new Response(makeTextStream('done'), { status: 200 }));
    await waitFor(() => {
      expect(result.current.isAiLoading).toBe(false);
    });
  });

  // ── handleAiSubmit calls /api/ai/chat POST with correct body ──────────────

  test('handleAiSubmit calls /api/ai/chat POST with correct body', async () => {
    const stream = makeTextStream('SELECT 1');
    const fetchMock = mock(async () => new Response(stream, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const deps = makeDeps();
    const { result } = renderHook(() => useAiChat(deps));

    act(() => {
      result.current.setAiPrompt('list all tables');
    });

    await act(async () => {
      await result.current.handleAiSubmit();
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = (fetchMock.mock.calls as unknown[][])[0];
    expect(url).toBe('/api/ai/chat');
    expect((init as RequestInit).method).toBe('POST');

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.prompt).toBe('list all tables');
    expect(body.databaseType).toBe('postgres');
    expect(body.schemaContext).toBeDefined();
    expect(typeof body.schemaContext).toBe('string');
  });

  // ── handleAiSubmit reads streaming response and calls setEditorValue ──────

  test('handleAiSubmit reads streaming response and calls setEditorValue', async () => {
    const stream = makeTextStream('SELECT ', '* ', 'FROM users');
    globalThis.fetch = mock(async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;

    const mockSetEditorValue = mock(() => {});
    const deps = makeDeps({ setEditorValue: mockSetEditorValue as (v: string) => void });
    const { result } = renderHook(() => useAiChat(deps));

    act(() => {
      result.current.setAiPrompt('get all users');
    });

    await act(async () => {
      await result.current.handleAiSubmit();
    });

    // The final call to setEditorValue should contain the full response
    expect(mockSetEditorValue).toHaveBeenCalled();
    const calls = mockSetEditorValue.mock.calls as unknown[][];
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0]).toContain('SELECT * FROM users');
  });

  // ── handleAiSubmit updates aiConversationHistory after success ─────────────

  test('handleAiSubmit updates aiConversationHistory after success', async () => {
    const stream = makeTextStream('SELECT 1');
    globalThis.fetch = mock(async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;

    const { result } = renderHook(() => useAiChat(makeDeps()));

    act(() => {
      result.current.setAiPrompt('give me a query');
    });

    await act(async () => {
      await result.current.handleAiSubmit();
    });

    expect(result.current.aiConversationHistory).toHaveLength(2);
    expect(result.current.aiConversationHistory[0]).toEqual({
      role: 'user',
      content: 'give me a query',
    });
    expect(result.current.aiConversationHistory[1].role).toBe('assistant');
    expect(result.current.aiConversationHistory[1].content).toContain('SELECT 1');
  });

  // ── handleAiSubmit clears prompt and hides panel on success ───────────────

  test('handleAiSubmit clears prompt and hides panel on success', async () => {
    const stream = makeTextStream('SELECT 1');
    globalThis.fetch = mock(async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;

    const { result } = renderHook(() => useAiChat(makeDeps()));

    act(() => {
      result.current.setShowAi(true);
      result.current.setAiPrompt('some prompt');
    });

    expect(result.current.showAi).toBe(true);
    expect(result.current.aiPrompt).toBe('some prompt');

    await act(async () => {
      await result.current.handleAiSubmit();
    });

    expect(result.current.aiPrompt).toBe('');
    expect(result.current.showAi).toBe(false);
    expect(result.current.isAiLoading).toBe(false);
  });

  // ── handleAiSubmit sets aiError on fetch failure ──────────────────────────

  test('handleAiSubmit sets aiError on fetch failure', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('Network error');
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useAiChat(makeDeps()));

    act(() => {
      result.current.setAiPrompt('fail please');
    });

    await act(async () => {
      await result.current.handleAiSubmit();
    });

    expect(result.current.aiError).toBe('Network error');
    expect(result.current.isAiLoading).toBe(false);
  });

  // ── handleAiSubmit sets aiError on non-ok response ────────────────────────

  test('handleAiSubmit sets aiError on non-ok response', async () => {
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
        status: 429,
        headers: { 'content-type': 'application/json' },
      })
    ) as unknown as typeof fetch;

    const { result } = renderHook(() => useAiChat(makeDeps()));

    act(() => {
      result.current.setAiPrompt('something');
    });

    await act(async () => {
      await result.current.handleAiSubmit();
    });

    expect(result.current.aiError).toBe('Rate limit exceeded');
    expect(result.current.isAiLoading).toBe(false);
  });

  // ── Schema filtering: >100 tables truncated ────────────────────────────

  test('schema filtering truncates to top 100 tables by rowCount', async () => {
    // Create 120 tables
    const manyTables: ParsedTable[] = Array.from({ length: 120 }, (_, i) => ({
      name: `table_${i}`,
      rowCount: i * 10,
      columns: [{ name: 'id', type: 'integer', isPrimary: true }],
    }));

    const stream = makeTextStream('SELECT 1');
    const fetchMock = mock(async () => new Response(stream, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const deps = makeDeps({ parsedSchema: manyTables });
    const { result } = renderHook(() => useAiChat(deps));

    act(() => {
      result.current.setAiPrompt('query all');
    });

    await act(async () => {
      await result.current.handleAiSubmit();
    });

    const body = JSON.parse(((fetchMock.mock.calls as unknown[][])[0][1] as RequestInit).body as string);
    // Count the number of "Table: " occurrences in schemaContext
    const tableCount = (body.schemaContext.match(/Table: /g) || []).length;
    expect(tableCount).toBeLessThanOrEqual(100);
  });

  // ── Table with no columns → "(none)" ──────────────────────────────────

  test('table with no columns outputs "(none)"', async () => {
    const tablesNoColumns: ParsedTable[] = [
      { name: 'empty_table', rowCount: 0, columns: [] },
    ];

    const stream = makeTextStream('SELECT 1');
    const fetchMock = mock(async () => new Response(stream, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const deps = makeDeps({ parsedSchema: tablesNoColumns });
    const { result } = renderHook(() => useAiChat(deps));

    act(() => {
      result.current.setAiPrompt('query it');
    });

    await act(async () => {
      await result.current.handleAiSubmit();
    });

    const body = JSON.parse(((fetchMock.mock.calls as unknown[][])[0][1] as RequestInit).body as string);
    expect(body.schemaContext).toContain('(none)');
  });

  // ── Table with >10 columns → ellipsis ─────────────────────────────────

  test('table with >10 columns appends ellipsis', async () => {
    const manyColumns = Array.from({ length: 15 }, (_, i) => ({
      name: `col_${i}`, type: 'text',
    }));
    const tablesMany: ParsedTable[] = [
      { name: 'wide_table', rowCount: 50, columns: manyColumns },
    ];

    const stream = makeTextStream('SELECT 1');
    const fetchMock = mock(async () => new Response(stream, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const deps = makeDeps({ parsedSchema: tablesMany });
    const { result } = renderHook(() => useAiChat(deps));

    act(() => {
      result.current.setAiPrompt('query');
    });

    await act(async () => {
      await result.current.handleAiSubmit();
    });

    const body = JSON.parse(((fetchMock.mock.calls as unknown[][])[0][1] as RequestInit).body as string);
    expect(body.schemaContext).toContain('...');
  });

  // ── Editor content NOT starting with -- → appends \n\n prefix ──────────

  test('editor content not starting with -- appends \\n\\n prefix', async () => {
    const stream = makeTextStream('NEW SQL');
    globalThis.fetch = mock(async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;

    const mockSetEditorValue = mock(() => {});
    const deps = makeDeps({
      getEditorValue: mock(() => 'SELECT * FROM old') as () => string,
      setEditorValue: mockSetEditorValue as (v: string) => void,
    });

    const { result } = renderHook(() => useAiChat(deps));

    act(() => {
      result.current.setAiPrompt('add query');
    });

    await act(async () => {
      await result.current.handleAiSubmit();
    });

    const calls = mockSetEditorValue.mock.calls as unknown[][];
    const lastCall = calls[calls.length - 1][0] as string;
    expect(lastCall).toContain('SELECT * FROM old\n\n');
    expect(lastCall).toContain('NEW SQL');
  });

  // ── Editor content starting with -- → replaces entirely ────────────────

  test('editor content starting with -- replaces entirely', async () => {
    const stream = makeTextStream('NEW SQL');
    globalThis.fetch = mock(async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;

    const mockSetEditorValue = mock(() => {});
    const deps = makeDeps({
      getEditorValue: mock(() => '-- old comment\nSELECT 1') as () => string,
      setEditorValue: mockSetEditorValue as (v: string) => void,
    });

    const { result } = renderHook(() => useAiChat(deps));

    act(() => {
      result.current.setAiPrompt('replace');
    });

    await act(async () => {
      await result.current.handleAiSubmit();
    });

    const calls = mockSetEditorValue.mock.calls as unknown[][];
    const lastCall = calls[calls.length - 1][0] as string;
    // Should NOT contain old content
    expect(lastCall).not.toContain('-- old comment');
    expect(lastCall).toBe('NEW SQL');
  });

  // ── Empty editor content → replaces ────────────────────────────────────

  test('empty editor content replaces', async () => {
    const stream = makeTextStream('NEW SQL');
    globalThis.fetch = mock(async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;

    const mockSetEditorValue = mock(() => {});
    const deps = makeDeps({
      getEditorValue: mock(() => '') as () => string,
      setEditorValue: mockSetEditorValue as (v: string) => void,
    });

    const { result } = renderHook(() => useAiChat(deps));

    act(() => {
      result.current.setAiPrompt('generate');
    });

    await act(async () => {
      await result.current.handleAiSubmit();
    });

    const calls = mockSetEditorValue.mock.calls as unknown[][];
    const lastCall = calls[calls.length - 1][0] as string;
    expect(lastCall).toBe('NEW SQL');
  });

  // ── Second submit sends conversationHistory ────────────────────────────

  test('second submit sends conversationHistory', async () => {
    const stream1 = makeTextStream('SELECT 1');
    const stream2 = makeTextStream('SELECT 2');
    let callCount = 0;
    const fetchMock = mock(async () => {
      callCount++;
      return new Response(callCount === 1 ? stream1 : stream2, { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useAiChat(makeDeps()));

    // First submit
    act(() => { result.current.setAiPrompt('first query'); });
    await act(async () => { await result.current.handleAiSubmit(); });

    // Second submit
    act(() => { result.current.setAiPrompt('second query'); });
    await act(async () => { await result.current.handleAiSubmit(); });

    const secondBody = JSON.parse(((fetchMock.mock.calls as unknown[][])[1][1] as RequestInit).body as string);
    expect(secondBody.conversationHistory).toBeDefined();
    expect(secondBody.conversationHistory.length).toBe(2);
    expect(secondBody.conversationHistory[0].role).toBe('user');
  });

  // ── First submit has no conversationHistory ────────────────────────────

  test('first submit has no conversationHistory', async () => {
    const stream = makeTextStream('SELECT 1');
    const fetchMock = mock(async () => new Response(stream, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const { result } = renderHook(() => useAiChat(makeDeps()));

    act(() => { result.current.setAiPrompt('first'); });
    await act(async () => { await result.current.handleAiSubmit(); });

    const body = JSON.parse(((fetchMock.mock.calls as unknown[][])[0][1] as RequestInit).body as string);
    expect(body.conversationHistory).toBeUndefined();
  });

  // ── response.body is null → 'No reader available' error ────────────────

  test('response.body is null sets error', async () => {
    globalThis.fetch = mock(async () => {
      const res = new Response(null, { status: 200 });
      // Override body to null
      Object.defineProperty(res, 'body', { value: null });
      return res;
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useAiChat(makeDeps()));

    act(() => { result.current.setAiPrompt('generate'); });
    await act(async () => { await result.current.handleAiSubmit(); });

    expect(result.current.aiError).toBe('No reader available');
  });

  // ── Non-Error thrown → generic error message ──────────────────────────

  test('non-Error thrown sets generic error message', async () => {
    globalThis.fetch = mock(async () => {
      throw 42; // non-Error
    }) as unknown as typeof fetch;

    const { result } = renderHook(() => useAiChat(makeDeps()));

    act(() => { result.current.setAiPrompt('go'); });
    await act(async () => { await result.current.handleAiSubmit(); });

    expect(result.current.aiError).toBe('An unexpected error occurred while communicating with the AI.');
  });

  // ── onChange callback invoked with final response ──────────────────────

  test('onChange callback invoked with final response', async () => {
    const stream = makeTextStream('SELECT 42');
    globalThis.fetch = mock(async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;

    const mockOnChange = mock(() => {});
    const deps = makeDeps({ onChange: mockOnChange as (val: string) => void });
    const { result } = renderHook(() => useAiChat(deps));

    act(() => { result.current.setAiPrompt('answer'); });
    await act(async () => { await result.current.handleAiSubmit(); });

    expect(mockOnChange).toHaveBeenCalled();
    const lastCallArg = (mockOnChange.mock.calls as unknown[][])[0][0] as string;
    expect(lastCallArg).toContain('SELECT 42');
  });
});
