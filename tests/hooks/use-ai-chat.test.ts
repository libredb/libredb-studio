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
});
