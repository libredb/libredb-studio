/**
 * Global fetch mock helper for hook and component tests
 */
import { mock } from 'bun:test';

export interface MockFetchResponse {
  status?: number;
  ok?: boolean;
  json?: unknown;
  text?: string;
  headers?: Record<string, string>;
}

type FetchMockFn = ReturnType<typeof mock<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>>;

/**
 * Install a global fetch mock that matches URL patterns to responses.
 * Returns the mock function for assertions.
 */
export function mockGlobalFetch(
  routes: Record<string, MockFetchResponse | ((req: Request) => MockFetchResponse | Promise<MockFetchResponse>)>
): FetchMockFn {
  const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const pathname = new URL(url, 'http://localhost:3000').pathname;

    for (const [pattern, handler] of Object.entries(routes)) {
      if (pathname.includes(pattern)) {
        const mockResponse = typeof handler === 'function'
          ? await handler(new Request(url, init))
          : handler;

        return new Response(
          mockResponse.json !== undefined ? JSON.stringify(mockResponse.json) : (mockResponse.text ?? ''),
          {
            status: mockResponse.status ?? 200,
            headers: {
              'content-type': 'application/json',
              ...mockResponse.headers,
            },
          }
        );
      }
    }

    return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 });
  });

  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/**
 * Restore original fetch (call in afterEach/afterAll)
 */
const _originalFetch = globalThis.fetch;
export function restoreGlobalFetch() {
  globalThis.fetch = _originalFetch;
}
