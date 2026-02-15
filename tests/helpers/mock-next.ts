/**
 * Next.js API Route test helpers
 * Creates mock NextRequest objects and cookie helpers
 */

export function createMockRequest(
  url: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
    cookies?: Record<string, string>;
  } = {}
): Request {
  const { method = 'GET', body, headers = {}, cookies = {} } = options;

  const cookieHeader = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');

  const allHeaders: Record<string, string> = {
    ...headers,
    ...(cookieHeader ? { cookie: cookieHeader } : {}),
    ...(body ? { 'content-type': 'application/json' } : {}),
  };

  const init: RequestInit = {
    method,
    headers: allHeaders,
    ...(body ? { body: JSON.stringify(body) } : {}),
  };

  return new Request(`http://localhost:3000${url}`, init);
}

export function createMockCookies() {
  const store = new Map<string, { value: string; options?: Record<string, unknown> }>();

  return {
    get: (name: string) => {
      const entry = store.get(name);
      return entry ? { name, value: entry.value } : undefined;
    },
    set: (name: string, value: string, options?: Record<string, unknown>) => {
      store.set(name, { value, options });
    },
    delete: (name: string) => {
      store.delete(name);
    },
    has: (name: string) => store.has(name),
    getAll: () => Array.from(store.entries()).map(([name, { value }]) => ({ name, value })),
    _store: store,
  };
}

/**
 * Parse JSON from a Response object
 */
export async function parseResponseJSON<T = unknown>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

/**
 * Read streaming response body as text
 */
export async function readStreamResponse(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const decoder = new TextDecoder();
  let result = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }

  return result;
}
