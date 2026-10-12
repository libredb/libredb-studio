import "../setup-dom";
import { mockToastSuccess } from "../helpers/mock-sonner";
import "../helpers/mock-navigation";

import { describe, test, expect, mock, beforeEach } from "bun:test";
import { renderHook, act, waitFor } from "@testing-library/react";
import { createMockProvider } from "../helpers/mock-provider";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import {
  QueryError,
  QueryCancelledError,
  TimeoutError,
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  AuthenticationError,
  PoolExhaustedError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
  isRetryableError,
  mapDatabaseError,
} from "@/lib/db/errors";
import type { DatabaseConnection, QueryTab } from "@/lib/types";
import type { ProviderMetadata } from "@/hooks/use-provider-metadata";

/**
 * The id the editor's Stop posts must be the id the multi-query route bound for the unit in flight: the hook mints
 * it, the route hands it to the provider, and the cancel route names it. This drives the hook's request through the
 * real handler with a cancel-capable fake, so a change on either side that breaks the pairing fails here.
 */

// The ids the fake was handed, one per unit it started.
const seen: (string | undefined)[] = [];
let releaseUnit: (() => void) | undefined;
const provider = createMockProvider();
const cancelQuery = mock(async (_id: string) => {
  releaseUnit?.();
  return true;
});
Object.assign(provider, { cancelQuery });
(provider.query as ReturnType<typeof mock>).mockImplementation(
  async (_sql: string, _params?: unknown[], queryId?: string) => {
    seen.push(queryId);
    await new Promise<void>((resolve) => {
      releaseUnit = resolve;
    });
    throw new QueryCancelledError("The query was cancelled.");
  },
);
const mockGetOrCreateProvider = mock(async () => provider as never);

mock.module("@/lib/auth", () => ({
  getSession: mock(async () => ({ role: "admin", username: "admin" })),
  signJWT: mock(async () => "mock-token"),
  verifyJWT: mock(async () => null),
  login: mock(async () => {}),
  logout: mock(async () => {}),
}));

mock.module("@/lib/seed/resolve-connection", () => {
  class SeedConnectionError extends Error {
    constructor(
      message: string,
      public statusCode: number,
    ) {
      super(message);
      this.name = "SeedConnectionError";
    }
  }
  return {
    resolveConnection: mock(async (body: Record<string, unknown>) => {
      if (!body.connection && !body.connectionId) {
        throw new SeedConnectionError("Either connection or connectionId is required", 400);
      }
      return body.connection;
    }),
    SeedConnectionError,
  };
});

mock.module("@/lib/db", () => ({
  getOrCreateProvider: mockGetOrCreateProvider,
  createDatabaseProvider: mock(async () => provider),
  removeProvider: mock(async () => {}),
  clearProviderCache: mock(async () => {}),
  getProviderCacheStats: mock(() => ({ size: 0, connections: [] })),
  QueryError,
  QueryCancelledError,
  TimeoutError,
  DatabaseError,
  DatabaseConfigError,
  ConnectionError,
  AuthenticationError,
  PoolExhaustedError,
  isDatabaseError,
  isConnectionError,
  isQueryError,
  isTimeoutError,
  isAuthenticationError,
  isRetryableError,
  mapDatabaseError,
}));

mock.module("@/components/QuerySafetyDialog", () => ({
  isDangerousQuery: () => false,
}));

const { POST } = await import("@/app/api/db/multi-query/route");
const { useQueryExecution } = await import("@/hooks/use-query-execution");

const connection: DatabaseConnection = {
  id: "contract-pg-1",
  name: "Contract PostgreSQL",
  type: "postgres",
  host: "localhost",
  port: 5432,
  user: "testuser",
  password: "testpass",
  database: "testdb",
  createdAt: new Date("2025-01-01T00:00:00Z"),
  environment: "development",
};

const metadata = {
  capabilities: { queryLanguage: "sql", supportsQueryCancel: true, defaultPort: 5432 },
  labels: {},
} as unknown as ProviderMetadata;

function params() {
  const tab: QueryTab = {
    id: "tab-1",
    name: "Query 1",
    query: "SELECT 1; SELECT 2",
    result: null,
    isExecuting: false,
    type: "sql",
  };
  return {
    activeConnection: connection,
    metadata,
    tabs: [tab],
    activeTabId: "tab-1",
    currentTab: tab,
    setTabs: mock((fn: unknown) => {
      if (typeof fn === "function") fn([tab]);
    }),
    transactionActive: false,
    playgroundMode: false,
    fetchSchema: mock(async () => {}),
    queryEditorRef: { current: null },
  };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Stop on a script and the multi-query route's binding", () => {
  beforeEach(() => {
    clearRateLimitState();
    seen.length = 0;
    cancelQuery.mockClear();
    mockToastSuccess.mockClear();
  });

  test("the id Stop posts is the id the route bound for the unit in flight", async () => {
    const cancelledIds: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/api/db/multi-query")) {
        const signal = init?.signal ?? undefined;
        const answer = POST(
          new Request("http://localhost:3000/api/db/multi-query", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: init?.body,
            signal,
          }) as never,
        );
        // A real fetch rejects once its signal aborts, whatever the server goes on to answer.
        return new Promise<Response>((resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
          answer.then(resolve, reject);
        });
      }
      if (url.includes("/api/db/cancel")) {
        const { queryId } = JSON.parse(init?.body as string) as { queryId: string };
        cancelledIds.push(queryId);
        return json({ cancelled: await cancelQuery(queryId) });
      }
      return json({ error: "Not found" }, 404);
    }) as typeof fetch;
    try {
      const { result } = renderHook(() => useQueryExecution(params()));
      const running = act(async () => {
        await result.current.executeQuery("SELECT 1; SELECT 2");
      });
      await waitFor(() => expect(seen).toHaveLength(1));
      await act(async () => {
        await result.current.cancelQuery();
      });
      await running;

      expect(seen[0]).toMatch(/^q-\d+-/);
      expect(cancelledIds).toEqual([seen[0] as string]);
      expect(seen).toHaveLength(1);
      expect(mockToastSuccess).toHaveBeenCalledWith("Query Cancelled", expect.anything());
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
