/**
 * Search HTTP transport endpoints (Elasticsearch and OpenSearch)
 *
 * The rest of this transport is exercised through the two provider suites under
 * tests/integration/db. This file pins only how its URLs are built: the host and
 * port are validated when the transport is constructed, and a redirect is refused
 * rather than followed.
 *
 * globalThis.fetch is replaced per test and restored in afterEach; mock.module()
 * is deliberately not used, since it is process-wide in bun.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConnectionError, DatabaseConfigError } from "@/lib/db/errors";
import { SearchHttpTransport } from "@/lib/db/providers/sql/search/http-transport";
import { SearchTransportError } from "@/lib/db/providers/sql/search/transport";
import type { DatabaseConnection, DatabaseType } from "@/lib/db/types";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];
let handler: (url: string) => Response;

const VERSION_BODY = JSON.stringify({ version: { number: "9.1.0" } });

function makeConnection(type: DatabaseType, overrides: Partial<DatabaseConnection> = {}): DatabaseConnection {
  return { id: "search-1", name: "Search", type, host: "127.0.0.1", port: 9200, createdAt: new Date(), ...overrides };
}

beforeEach(() => {
  calls = [];
  handler = () => new Response(VERSION_BODY, { headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe.each(["elasticsearch", "opensearch"] as const)("SearchHttpTransport (%s) endpoint", (dialect) => {
  function makeTransport(overrides: Partial<DatabaseConnection> = {}): SearchHttpTransport {
    return new SearchHttpTransport(dialect, makeConnection(dialect, overrides));
  }

  test("builds the origin from host and port", async () => {
    await makeTransport().version();

    expect(calls[0]?.url).toBe("http://127.0.0.1:9200/");
  });

  test("brackets an IPv6 host", async () => {
    await makeTransport({ host: "::1" }).version();

    expect(calls[0]?.url).toBe("http://[::1]:9200/");
  });

  test("keeps the index listing's query parameters in the query", async () => {
    handler = () => new Response("[]", { headers: { "content-type": "application/json" } });
    await makeTransport().indices();

    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/_cat/indices");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("bytes")).toBe("b");
  });

  // A host is spliced into nothing: one that would rewrite the URL around it is
  // refused before the transport exists, so no request can carry the credential.
  test.each(["evil.example/steal?", "user@evil.example", "db#x", "db\\evil", "db%2f", "db evil"])(
    "refuses the host %p before any request is sent",
    (host) => {
      expect(() => makeTransport({ host })).toThrow(DatabaseConfigError);
      expect(calls).toHaveLength(0);
    },
  );

  test.each([0, 65536, 1.5, "9200abc"])("refuses the port %p before any request is sent", (port) => {
    expect(() => makeTransport({ port: port as number })).toThrow(DatabaseConfigError);
    expect(calls).toHaveLength(0);
  });

  test("refuses an index name that would climb out of its path", async () => {
    const error = await makeTransport()
      .mapping("..")
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DatabaseConfigError);
    expect(calls).toHaveLength(0);
  });
});

describe.each(["elasticsearch", "opensearch"] as const)("SearchHttpTransport (%s) redirects", (dialect) => {
  function makeTransport(): SearchHttpTransport {
    return new SearchHttpTransport(dialect, makeConnection(dialect));
  }

  test("asks fetch not to follow a redirect", async () => {
    await makeTransport().version();

    expect(calls[0]?.init?.redirect).toBe("manual");
  });

  test("refuses a 3xx response with a ConnectionError naming only the target origin", async () => {
    handler = () =>
      new Response("", { status: 301, headers: { location: "https://evil.example:9443/steal?token=SECRET" } });

    const error = await makeTransport()
      .version()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as Error).message).toContain("HTTP 301");
    expect((error as Error).message).toContain("https://evil.example:9443");
    expect((error as Error).message).not.toContain("SECRET");
    expect(calls).toHaveLength(1);
  });

  // A 404 with an absence rule is answered as "nothing here"; a redirect must not
  // be mistaken for that, or for anything else but a refusal.
  test("refuses a 3xx response on a listing that tolerates absence", async () => {
    handler = () => new Response("", { status: 302, headers: { location: "/login" } });

    const error = await makeTransport()
      .pipelines()
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConnectionError);
  });
});

// A 401/403 is a refused login only when its body says so or says nothing (#1413). Measured on
// Elasticsearch 9.5.3: a SQL read of a closed index answers HTTP 403 with this body, and the
// transport used to report it as "refused the credentials".
const CLOSED_INDEX_REASON = "index [closed_idx] blocked by: [FORBIDDEN/4/index closed];";
const CLOSED_INDEX_BODY = JSON.stringify({
  error: {
    root_cause: [{ type: "cluster_block_exception", reason: CLOSED_INDEX_REASON }],
    type: "cluster_block_exception",
    reason: CLOSED_INDEX_REASON,
  },
  status: 403,
});
const SECURITY_BODY = JSON.stringify({
  error: {
    type: "security_exception",
    reason: "unable to authenticate user [nobody] for REST request [/_sql?format=json]",
  },
  status: 401,
});

describe.each(["elasticsearch", "opensearch"] as const)("SearchHttpTransport (%s) 401 and 403 (#1413)", (dialect) => {
  async function failureOf(status: number, body: string): Promise<SearchTransportError> {
    handler = () => new Response(body, { status, headers: { "content-type": "application/json" } });
    const caught = await new SearchHttpTransport(dialect, makeConnection(dialect))
      .query("SELECT a FROM closed_idx")
      .catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(SearchTransportError);
    return caught as SearchTransportError;
  }

  test("a 403 whose body is an engine fault is that fault, with the engine's reason", async () => {
    const error = await failureOf(403, CLOSED_INDEX_BODY);

    expect(error.category).toBe("engine");
    expect(error.message).toBe(CLOSED_INDEX_REASON);
  });

  test("a 401 or 403 with a security fault in its body is a refused login", async () => {
    for (const status of [401, 403]) {
      const error = await failureOf(status, SECURITY_BODY);
      expect(error.category).toBe("auth");
      expect(error.message).toContain(`refused the credentials (HTTP ${status})`);
    }
  });

  test.each([
    "authorization_exception",
    "permission_denied_exception",
    "access_denied_exception",
    "invalid_credentials_exception",
    "ForbiddenException",
  ])("a 403 naming %s is a refused login", async (type) => {
    const error = await failureOf(403, JSON.stringify({ error: { type, reason: "denied" }, status: 403 }));
    expect(error.category).toBe("auth");
  });

  test("a 401 or 403 with no readable fault in its body stays a refused login", async () => {
    for (const [status, body] of [
      [401, ""],
      [403, "Forbidden"],
      [403, JSON.stringify({ error: "Unauthorized" })],
      [401, JSON.stringify({ status: 401 })],
      [403, JSON.stringify({ error: { reason: "no type" } })],
    ] as const) {
      const error = await failureOf(status, body);
      expect(error.category).toBe("auth");
    }
  });
});
