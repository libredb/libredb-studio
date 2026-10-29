/**
 * Search HTTP transport endpoints (Elasticsearch and OpenSearch)
 *
 * The rest of this transport is exercised through the two provider suites under
 * tests/integration/db. This file pins how its URLs are built (the host and port are
 * validated when the transport is constructed, and a redirect is refused rather than
 * followed), how a 401 or 403 is read, and how a bounded statement pages, stops and
 * closes its cursor.
 *
 * globalThis.fetch is replaced per test and restored in afterEach; mock.module()
 * is deliberately not used, since it is process-wide in bun.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ConnectionError, DatabaseConfigError } from "@/lib/db/errors";
import { SearchHttpTransport } from "@/lib/db/providers/sql/search/http-transport";
import { SearchBoundsError, SearchTransportError } from "@/lib/db/providers/sql/search/transport";
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

/**
 * A bounded statement, against a fake cluster that answers the SQL endpoint from a queue of pages and the cursor
 * close with the acknowledgement Elasticsearch 9.1.4 sends (measured: `{"succeeded":true}`). Each page is the
 * product's own envelope, so the rows go through the same rebuild the editor's statements do.
 */
describe.each(["elasticsearch", "opensearch"] as const)("SearchHttpTransport (%s) bounded query", (dialect) => {
  const CLOSE_PATH = dialect === "elasticsearch" ? "/_sql/close" : "/_plugins/_sql/close";

  /** One page in this product's envelope: `k` keyword rows, and a cursor when one is given. */
  function page(values: readonly string[], cursor?: string, withColumns = true): string {
    const columns = [{ name: "k", type: "keyword" }];
    const rows = values.map((value) => [value]);
    const envelope =
      dialect === "elasticsearch"
        ? { ...(withColumns ? { columns } : {}), rows }
        : { schema: columns, datarows: rows, total: rows.length, size: rows.length, status: 200 };
    return JSON.stringify(cursor === undefined ? envelope : { ...envelope, cursor });
  }

  let pages: string[] = [];
  let closeStatus = 200;

  beforeEach(() => {
    pages = [];
    closeStatus = 200;
    handler = (url) =>
      new URL(url).pathname === CLOSE_PATH
        ? new Response('{"succeeded":true}', { status: closeStatus, headers: { "content-type": "application/json" } })
        : new Response(pages.shift() ?? "{}", { headers: { "content-type": "application/json" } });
  });

  function transport(): SearchHttpTransport {
    return new SearchHttpTransport(dialect, makeConnection(dialect));
  }

  const bodies = (): Record<string, unknown>[] =>
    calls.map((call) => JSON.parse(String(call.init?.body)) as Record<string, unknown>);
  const paths = (): string[] => calls.map((call) => new URL(call.url).pathname);

  async function refusal(promise: Promise<unknown>): Promise<SearchBoundsError> {
    const caught = await promise.catch((error: unknown) => error);
    expect(caught).toBeInstanceOf(SearchBoundsError);
    return caught as SearchBoundsError;
  }

  test("asks for one row past the row bound, and returns an answer inside both bounds whole", async () => {
    pages = [page(["a", "b"])];
    const result = await transport().queryBounded("SELECT k FROM t", { maxRows: 3, maxBytes: 1_000 });

    expect(result.rows).toEqual([{ k: "a" }, { k: "b" }]);
    expect(result.fieldNames).toEqual(["k"]);
    expect(bodies()[0]).toMatchObject({ query: "SELECT k FROM t", fetch_size: 4 });
    expect(calls).toHaveLength(1);
  });

  test("an answer at exactly the row bound is returned", async () => {
    pages = [page(["a", "b", "c"])];
    const result = await transport().queryBounded("SELECT k FROM t", { maxRows: 3, maxBytes: 1_000 });

    expect(result.rows).toHaveLength(3);
  });

  test("never asks for a page past the cluster's default result window", async () => {
    pages = [page([])];
    await transport().queryBounded("SELECT k FROM t", { maxRows: 50_000, maxBytes: 1_000 });

    expect(bodies()[0]?.fetch_size).toBe(10_000);
  });

  test("a page past the row bound closes the cursor it carries, then refuses with the rows read", async () => {
    pages = [page(["a", "b", "c", "d"], "c1")];
    const error = await refusal(transport().queryBounded("SELECT k FROM t", { maxRows: 3, maxBytes: 1_000 }));

    expect([error.bound, error.measured, error.allowed]).toEqual(["row", 4, 3]);
    expect(paths().at(-1)).toBe(CLOSE_PATH);
    expect(bodies().at(-1)).toEqual({ cursor: "c1" });
  });

  test("a page past the row bound with no cursor closes nothing", async () => {
    pages = [page(["a", "b", "c", "d"])];
    await refusal(transport().queryBounded("SELECT k FROM t", { maxRows: 3, maxBytes: 1_000 }));

    expect(paths()).not.toContain(CLOSE_PATH);
  });

  test("follows a short page's cursor, keeps page one's columns, and stops on the page that crosses the bound", async () => {
    pages = [page(["a"], "c1"), page(["b", "c"], "c2", false), page(["d"], "c3", false)];
    const error = await refusal(transport().queryBounded("SELECT k FROM t", { maxRows: 3, maxBytes: 1_000 }));

    expect([error.measured, error.allowed]).toEqual([4, 3]);
    expect(bodies().slice(1, 3)).toEqual([{ cursor: "c1" }, { cursor: "c2" }]);
    expect(bodies().at(-1)).toEqual({ cursor: "c3" });
    expect(paths().at(-1)).toBe(CLOSE_PATH);
  });

  test("returns every page when the cursor runs out inside the bounds", async () => {
    pages = [page(["a"], "c1"), page(["b"], undefined, false)];
    const result = await transport().queryBounded("SELECT k FROM t", { maxRows: 3, maxBytes: 1_000 });

    expect(result.rows).toEqual([{ k: "a" }, { k: "b" }]);
    expect(paths()).not.toContain(CLOSE_PATH);
  });

  test("rows past the byte bound close the cursor and refuse with the bytes the rows measure as JSON", async () => {
    pages = [page(["aaaa", "bbbb"], "c1")];
    // [{"k":"aaaa"},{"k":"bbbb"}] is 27 bytes.
    const error = await refusal(transport().queryBounded("SELECT k FROM t", { maxRows: 10, maxBytes: 26 }));

    expect([error.bound, error.measured, error.allowed]).toEqual(["byte", 27, 26]);
    expect(paths().at(-1)).toBe(CLOSE_PATH);
  });

  test("rows that measure exactly the byte bound are returned", async () => {
    pages = [page(["aaaa", "bbbb"])];
    const result = await transport().queryBounded("SELECT k FROM t", { maxRows: 10, maxBytes: 27 });

    expect(result.rows).toHaveLength(2);
  });

  test("a body past its cap is abandoned unread and refused with the bytes read", async () => {
    // The cap is three times the byte bound plus 64 KiB; this body is past it on its own.
    pages = [page(["x".repeat(70_000)])];
    const error = await refusal(transport().queryBounded("SELECT k FROM t", { maxRows: 10, maxBytes: 10 }));

    expect(error.bound).toBe("byte");
    expect(error.measured).toBeGreaterThan(10 * 3 + 65_536);
    expect(error.allowed).toBe(10);
  });

  test("the cap alone refuses a body whose rows are inside the byte bound, and stops reading it", async () => {
    // Row bytes stay far under the bound; the envelope carries the bulk, so only the body cap can refuse this page.
    const padded = `${page(["a"]).slice(0, -1)},"pad":"${"x".repeat(200_000)}"}`;
    const chunk = 40_000;
    let pulled = 0;
    handler = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            const start = pulled * chunk;
            if (start >= padded.length) {
              controller.close();
              return;
            }
            controller.enqueue(new TextEncoder().encode(padded.slice(start, start + chunk)));
            pulled += 1;
          },
        }),
        { headers: { "content-type": "application/json" } },
      );
    // The cap is 100 * 3 + 65,536 = 65,836 bytes, crossed by the second 40,000-byte chunk.
    const error = await refusal(transport().queryBounded("SELECT k FROM t", { maxRows: 10, maxBytes: 100 }));

    expect([error.bound, error.measured, error.allowed]).toEqual(["byte", 80_000, 100]);
    expect(pulled).toBeLessThan(Math.ceil(padded.length / chunk));
  });

  test("a body under its cap is read whole, even when its envelope alone is past the byte bound", async () => {
    // 85,000 bytes of envelope: under the cap of 10,000 * 3 + 65,536, and past 10,000 + 65,536.
    pages = [`${page(["a"]).slice(0, -1)},"pad":"${"x".repeat(85_000)}"}`];
    const result = await transport().queryBounded("SELECT k FROM t", { maxRows: 10, maxBytes: 10_000 });

    expect(result.rows).toEqual([{ k: "a" }]);
  });

  test("an empty first page adds no comma before the first row a later page brings", async () => {
    pages = [page([], "c1"), page(["aaaa", "bbbb"], undefined, false)];
    // [{"k":"aaaa"},{"k":"bbbb"}] is 27 bytes, exactly the bound.
    const result = await transport().queryBounded("SELECT k FROM t", { maxRows: 10, maxBytes: 27 });

    expect(result.rows).toHaveLength(2);
  });

  test("a later page the cluster refuses closes the cursor the page before it left open", async () => {
    pages = [page(["a"], "c1")];
    handler = (url) => {
      if (new URL(url).pathname === CLOSE_PATH) {
        return new Response('{"succeeded":true}', { headers: { "content-type": "application/json" } });
      }
      const next = pages.shift();
      return next === undefined
        ? new Response('{"error":{"type":"search_phase_execution_exception"}}', { status: 500 })
        : new Response(next, { headers: { "content-type": "application/json" } });
    };
    const caught = await transport()
      .queryBounded("SELECT k FROM t", { maxRows: 3, maxBytes: 1_000 })
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(SearchTransportError);
    expect(paths().at(-1)).toBe(CLOSE_PATH);
    expect(bodies().at(-1)).toEqual({ cursor: "c1" });
  });

  test("an unreadable later page closes the cursor the page before it left open", async () => {
    pages = [page(["a"], "c1"), "[]"];
    await transport()
      .queryBounded("SELECT k FROM t", { maxRows: 3, maxBytes: 1_000 })
      .catch((error: unknown) => error);

    expect(paths().at(-1)).toBe(CLOSE_PATH);
    expect(bodies().at(-1)).toEqual({ cursor: "c1" });
  });

  test("a later page past its cap closes the cursor the page before it left open", async () => {
    // Page one's rows measure 11 bytes, inside the bound of 20; page two is past the cap of 20 * 3 + 65,536.
    pages = [page(["a"], "c1"), page(["x".repeat(70_000)], "c2", false)];
    const error = await refusal(transport().queryBounded("SELECT k FROM t", { maxRows: 10, maxBytes: 20 }));

    expect(error.bound).toBe("byte");
    expect(error.measured).toBeGreaterThan(20 * 3 + 65_536);
    expect(paths().at(-1)).toBe(CLOSE_PATH);
    expect(bodies().at(-1)).toEqual({ cursor: "c1" });
  });

  test("a deadline that ends on a later page still closes the cursor, on a signal of its own", async () => {
    const controller = new AbortController();
    pages = [page(["a"], "c1")];
    handler = (url) => {
      if (new URL(url).pathname === CLOSE_PATH) {
        return new Response('{"succeeded":true}', { headers: { "content-type": "application/json" } });
      }
      const next = pages.shift();
      if (next === undefined) {
        controller.abort(new DOMException("deadline", "TimeoutError"));
        throw new DOMException("deadline", "TimeoutError");
      }
      return new Response(next, { headers: { "content-type": "application/json" } });
    };
    const caught = await transport()
      .queryBounded("SELECT k FROM t", { maxRows: 3, maxBytes: 1_000 }, controller.signal)
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(SearchTransportError);
    expect((caught as SearchTransportError).category).toBe("timeout");
    const close = calls.at(-1);
    expect(new URL(close?.url ?? "").pathname).toBe(CLOSE_PATH);
    expect(close?.init?.signal?.aborted).toBe(false);
  });

  test("a refused cursor close does not hide the bound the answer went past", async () => {
    closeStatus = 500;
    pages = [page(["a", "b"], "c1")];
    const error = await refusal(transport().queryBounded("SELECT k FROM t", { maxRows: 1, maxBytes: 1_000 }));

    expect(error.bound).toBe("row");
  });

  test("a cursor that never runs out is closed and refused after the page limit", async () => {
    pages = Array.from({ length: 1_001 }, (_, index) => page([], `c${index}`));
    const caught = await transport()
      .queryBounded("SELECT k FROM t", { maxRows: 3, maxBytes: 1_000 })
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(SearchTransportError);
    expect((caught as Error).message).toContain("more result pages than this connection will follow");
    expect(paths().at(-1)).toBe(CLOSE_PATH);
  });

  test("an unreadable page is refused as the editor's statements are", async () => {
    pages = ["[]"];
    const caught = await transport()
      .queryBounded("SELECT k FROM t", { maxRows: 3, maxBytes: 1_000 })
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(SearchTransportError);
  });

  test("an unreadable later page is refused too", async () => {
    pages = [page(["a"], "c1"), "[]"];
    const caught = await transport()
      .queryBounded("SELECT k FROM t", { maxRows: 3, maxBytes: 1_000 })
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(SearchTransportError);
  });
});
