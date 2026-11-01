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
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  test("returns an answer inside both bounds whole, in one request", async () => {
    pages = [page(["a", "b"])];
    const result = await transport().queryBounded("SELECT k FROM t", { maxRows: 3, maxBytes: 1_000 });

    expect(result.rows).toEqual([{ k: "a" }, { k: "b" }]);
    expect(result.fieldNames).toEqual(["k"]);
    expect(bodies()[0]).toMatchObject({ query: "SELECT k FROM t" });
    expect(calls).toHaveLength(1);
  });

  if (dialect === "elasticsearch") {
    test("asks for one row past the row bound", async () => {
      pages = [page(["a", "b"])];
      await transport().queryBounded("SELECT k FROM t", { maxRows: 3, maxBytes: 1_000 });

      expect(bodies()[0]).toMatchObject({ query: "SELECT k FROM t", fetch_size: 4 });
    });
  } else {
    test("asks for no page size, since one breaks the engine's aggregations", async () => {
      // Measured on 3.8.0: with `fetch_size`, a GROUP BY fails ("invalid value operation on MISSING_VALUE") or is
      // answered by the older engine, which cuts it at 200 rows with no cursor; without one, both answer whole.
      pages = [page(["a", "b"])];
      await transport().queryBounded("SELECT k FROM t", { maxRows: 3, maxBytes: 1_000 });

      expect(bodies()[0]).toEqual({ query: "SELECT k FROM t" });
    });
  }

  test("an answer at exactly the row bound is returned", async () => {
    pages = [page(["a", "b", "c"])];
    const result = await transport().queryBounded("SELECT k FROM t", { maxRows: 3, maxBytes: 1_000 });

    expect(result.rows).toHaveLength(3);
  });

  if (dialect === "elasticsearch") {
    test("never asks for a page past the cluster's default result window", async () => {
      pages = [page([])];
      await transport().queryBounded("SELECT k FROM t", { maxRows: 50_000, maxBytes: 1_000 });

      expect(bodies()[0]?.fetch_size).toBe(10_000);
    });
  }

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

/** One capture of tests/fixtures/opensearch/<version>/delete-setting/, written by tests/live/opensearch-write-refusals.ts. */
function deleteSettingCapture(version: string, name: string): { status: number; body: string } {
  const file = join(import.meta.dir, "../../../fixtures/opensearch", version, "delete-setting", `${name}.json`);
  return JSON.parse(readFileSync(file, "utf8")) as { status: number; body: string };
}

/**
 * The DELETE switch: OpenSearch's SQL grammar holds a DELETE that the `plugins.sql.delete.enabled` setting turns on
 * (2.19.4, measured; 3.8.0 no longer recognizes the setting), so the open of an agent read-only connection reads the
 * setting and sends one DELETE on a fresh name. The answers below are the captured ones.
 */
describe("SearchHttpTransport (opensearch) DELETE switch", () => {
  let reply: { status: number; body: string } = { status: 200, body: "{}" };

  beforeEach(() => {
    reply = { status: 200, body: "{}" };
    handler = () => new Response(reply.body, { status: reply.status, headers: { "content-type": "application/json" } });
  });

  function transport(): SearchHttpTransport {
    return new SearchHttpTransport("opensearch", makeConnection("opensearch"));
  }

  test("reads the setting from the cluster settings, defaults included, filtered to the one key", async () => {
    await transport().sqlDeleteSetting();

    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/_cluster/settings");
    expect(url.searchParams.get("include_defaults")).toBe("true");
    expect(url.searchParams.get("filter_path")).toBe("*.plugins.sql.delete.enabled");
    expect(calls[0]?.init?.method ?? "GET").toBe("GET");
  });

  test.each([
    ["3.8.0", "setting-default", null],
    ["3.8.0", "setting-after-on-write", null],
    ["2.19.4", "setting-default", false],
    ["2.19.4", "setting-after-on-write", true],
  ] as const)("%s %s reads %p", async (version, name, value) => {
    reply = deleteSettingCapture(version, name);

    expect(await transport().sqlDeleteSetting()).toEqual({ setting: "plugins.sql.delete.enabled", enabled: value });
  });

  test.each([
    [
      "a transient value over the persistent and the default",
      { transient: "true", persistent: "false", defaults: "false" },
      true,
    ],
    ["a persistent value over the default", { persistent: "true", defaults: "false" }, true],
    ["a transient false over a persistent true", { transient: "false", persistent: "true" }, false],
    ["a JSON boolean", { defaults: false }, false],
  ] as const)("reads %s", async (_name, levels, value) => {
    const body = Object.fromEntries(
      Object.entries(levels).map(([level, enabled]) => [level, { plugins: { sql: { delete: { enabled } } } }]),
    );
    reply = { status: 200, body: JSON.stringify(body) };

    expect(await transport().sqlDeleteSetting()).toEqual({ setting: "plugins.sql.delete.enabled", enabled: value });
  });

  test.each([
    [
      "a value that is not a boolean",
      JSON.stringify({ defaults: { plugins: { sql: { delete: { enabled: "maybe" } } } } }),
    ],
    ["a level that is not an object", JSON.stringify({ defaults: "false" })],
    ["a body that is not an object", "[]"],
  ])("refuses %s as unreadable", async (_name, body) => {
    reply = { status: 200, body };

    const caught = await transport()
      .sqlDeleteSetting()
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(SearchTransportError);
    expect((caught as Error).message).toBe(
      "OpenSearch answered the plugins.sql.delete.enabled setting the client could not read",
    );
  });

  test("a 403 on the settings read is the cluster's refusal, not a value", async () => {
    reply = { status: 403, body: SECURITY_BODY };

    const caught = await transport()
      .sqlDeleteSetting()
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(SearchTransportError);
    expect((caught as SearchTransportError).category).toBe("auth");
  });

  test("sends one DELETE on a fresh name no index holds, to the SQL endpoint", async () => {
    reply = deleteSettingCapture("3.8.0", "missing-index-setting-off");
    const probe = transport();
    await probe.unrefusedSqlDelete();
    await probe.unrefusedSqlDelete();

    const statements = calls.map((call) => (JSON.parse(String(call.init?.body)) as { query: string }).query);
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual(["/_plugins/_sql", "/_plugins/_sql"]);
    for (const statement of statements) expect(statement).toMatch(/^DELETE FROM libredb_delete_probe_[0-9a-f]{32}$/);
    expect(statements[0]).not.toBe(statements[1]);
  });

  test.each([
    ["3.8.0", "missing-index-setting-off"],
    ["3.8.0", "missing-index-setting-on"],
    ["2.19.4", "missing-index-setting-off"],
  ] as const)("%s %s: a measured refusal answers null", async (version, name) => {
    const captured = deleteSettingCapture(version, name);
    // The capture's statement named the capture's index; the probe names its own, and the refusal quotes it.
    handler = (_url) => {
      const statement = (JSON.parse(String(calls.at(-1)?.init?.body)) as { query: string }).query;
      return new Response(captured.body.replaceAll("DELETE FROM libredb_wr_no_such_index", statement), {
        status: captured.status,
        headers: { "content-type": "application/json" },
      });
    };

    expect(await transport().unrefusedSqlDelete()).toBeNull();
  });

  test("2.19.4 with the setting on: the missing-index answer is not a refusal, and is returned", async () => {
    reply = deleteSettingCapture("2.19.4", "missing-index-setting-on");

    expect(await transport().unrefusedSqlDelete()).toContain("IndexNotFoundException");
  });

  test("a DELETE that answered rows is not a refusal, and is returned", async () => {
    reply = deleteSettingCapture("2.19.4", "scratch-index-setting-on");

    expect(await transport().unrefusedSqlDelete()).toContain("deleted_rows");
  });

  test.each([
    ["another fault name", sqlFaultBody("ParserException", "Illegal SQL expression")],
    [
      "the measured fault name with another statement in its detail",
      sqlFaultBody(
        "SQLFeatureNotSupportedException",
        "Query must start with SELECT, DELETE, SHOW or DESCRIBE: DELETE FROM x",
      ),
    ],
    ["a missing index", sqlFaultBody("IndexNotFoundException", "no such index")],
  ])("%s is not a refusal, and is returned", async (_name, body) => {
    reply = { status: 400, body };

    const answer = await transport().unrefusedSqlDelete();

    expect(answer).not.toBeNull();
    expect(answer).toContain(JSON.parse(body).error.type);
  });

  test.each([
    ["a 403", 403, SECURITY_BODY, "auth"],
    ["a 401", 401, SECURITY_BODY, "auth"],
  ] as const)(
    "%s on the DELETE is the cluster's refusal of the request, thrown",
    async (_name, status, body, category) => {
      reply = { status, body };

      const caught = await transport()
        .unrefusedSqlDelete()
        .catch((error: unknown) => error);

      expect(caught).toBeInstanceOf(SearchTransportError);
      expect((caught as SearchTransportError).category).toBe(category);
    },
  );

  test("Elasticsearch, whose grammar holds no DELETE, refuses both before any request", async () => {
    const elasticsearch = new SearchHttpTransport("elasticsearch", makeConnection("elasticsearch"));

    for (const call of [() => elasticsearch.sqlDeleteSetting(), () => elasticsearch.unrefusedSqlDelete()]) {
      const caught = await call().catch((error: unknown) => error);
      expect(caught).toBeInstanceOf(SearchTransportError);
      expect((caught as Error).message).toBe("Elasticsearch SQL holds no DELETE behind a setting");
    }
    expect(calls).toHaveLength(0);
  });
});

/** An OpenSearch SQL plugin fault body. */
function sqlFaultBody(type: string, details: string): string {
  return JSON.stringify({ error: { reason: "Invalid SQL query", details, type }, status: 400 });
}

/**
 * The result limit: OpenSearch's SQL plugin answers at most `plugins.query.size_limit` rows and cuts the rest with no
 * sign of the cut (measured on 3.8.0 with the setting at 1000: a 1,500-row read answers 1,000 rows and a cursor whose
 * next page is empty, and a 1,500-group aggregation answers 1,000 rows and no cursor), so the open of an agent
 * read-only connection reads the limit, and an answer that reaches it is refused rather than returned cut.
 */
describe("SearchHttpTransport (opensearch) result limit", () => {
  let reply: { status: number; body: string } = { status: 200, body: "{}" };

  beforeEach(() => {
    handler = () => new Response(reply.body, { status: reply.status, headers: { "content-type": "application/json" } });
  });

  function transport(): SearchHttpTransport {
    return new SearchHttpTransport("opensearch", makeConnection("opensearch"));
  }

  test("reads the setting from the cluster settings, defaults included, filtered to the one key", async () => {
    reply = { status: 200, body: '{"defaults":{"plugins":{"query":{"size_limit":"10000"}}}}' };

    expect(await transport().sqlResultLimit()).toEqual({ setting: "plugins.query.size_limit", rows: 10_000 });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/_cluster/settings");
    expect(url.searchParams.get("filter_path")).toBe("*.plugins.query.size_limit");
  });

  test("a transient value wins over the default, as a JSON number too", async () => {
    reply = {
      status: 200,
      body: '{"transient":{"plugins":{"query":{"size_limit":1000}}},"defaults":{"plugins":{"query":{"size_limit":"10000"}}}}',
    };

    expect(await transport().sqlResultLimit()).toEqual({ setting: "plugins.query.size_limit", rows: 1_000 });
  });

  test.each([
    ["an empty answer", "{}"],
    ["a value that is not a whole number", '{"defaults":{"plugins":{"query":{"size_limit":"ten"}}}}'],
    ["a value below one", '{"defaults":{"plugins":{"query":{"size_limit":"0"}}}}'],
  ])("refuses %s as unreadable", async (_name, body) => {
    reply = { status: 200, body };

    const caught = await transport()
      .sqlResultLimit()
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(SearchTransportError);
    expect((caught as Error).message).toBe(
      "OpenSearch answered the plugins.query.size_limit setting the client could not read",
    );
  });

  test("Elasticsearch, which declares no such limit, refuses before any request", async () => {
    const caught = await new SearchHttpTransport("elasticsearch", makeConnection("elasticsearch"))
      .sqlResultLimit()
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(SearchTransportError);
    expect((caught as Error).message).toBe("Elasticsearch SQL declares no result limit setting");
    expect(calls).toHaveLength(0);
  });
});

/**
 * A refusal inside a 200: OpenSearch's SQL plugin answers some refusals with HTTP 200 and its error envelope, the
 * refusal's own status in the body. Read as a success, the envelope would be an answer with no rows.
 */
describe("SearchHttpTransport (opensearch) refusal inside a 200", () => {
  /** Measured on 3.8.0 with security on: `DESCRIBE TABLES LIKE %` by a user missing `indices:admin/get` on an index. */
  const SECURITY_IN_200 = JSON.stringify({
    error: {
      reason:
        "Error occurred in OpenSearch engine: no permissions for [indices:admin/get] and User [name=libredb_agent, backend_roles=[], requestedTenant=null]",
      details:
        "OpenSearchSecurityException[no permissions for [indices:admin/get] and User [name=libredb_agent, backend_roles=[], requestedTenant=null]]\nFor more details, please send request for Json format to see the raw response from OpenSearch engine.",
      type: "OpenSearchSecurityException",
    },
    status: 403,
  });

  beforeEach(() => {
    handler = () => new Response(SECURITY_IN_200, { status: 200, headers: { "content-type": "application/json" } });
  });

  const transport = (): SearchHttpTransport => new SearchHttpTransport("opensearch", makeConnection("opensearch"));

  test.each([
    ["query", () => transport().query("DESCRIBE TABLES LIKE %")],
    ["queryBounded", () => transport().queryBounded("DESCRIBE TABLES LIKE %", { maxRows: 10, maxBytes: 1_000 })],
  ] as const)("%s throws the refusal the body carries, by the body's status", async (_name, run) => {
    const caught = await run().catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(SearchTransportError);
    expect((caught as SearchTransportError).category).toBe("auth");
    expect((caught as Error).message).toBe("OpenSearch refused the credentials (HTTP 403)");
  });

  test("a 2.19.4 DELETE with the setting on, answered 200 with a missing-index fault, is that fault", async () => {
    // The body 2.19.4 answered `DELETE FROM libredb_wr_no_such_index` with the setting on (tests/fixtures/opensearch/).
    handler = () =>
      new Response(
        JSON.stringify({
          error: {
            reason: "Error occurred in OpenSearch engine: no such index [x]",
            details: "[x] IndexNotFoundException[no such index [x]]",
            type: "IndexNotFoundException",
          },
          status: 404,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );

    const caught = await transport()
      .query("DELETE FROM x")
      .catch((error: unknown) => error);

    expect((caught as SearchTransportError).category).toBe("unknown-object");
    expect((caught as SearchTransportError).engineType).toBe("IndexNotFoundException");
  });

  test("a 200 whose status member is a success, or whose error member is not an envelope, is an answer", async () => {
    handler = () =>
      new Response(JSON.stringify({ schema: [{ name: "error", type: "keyword" }], datarows: [["x"]], status: 200 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    expect((await transport().query("SELECT error FROM t")).rows).toEqual([{ error: "x" }]);

    handler = () =>
      new Response(
        JSON.stringify({ schema: [{ name: "k", type: "keyword" }], datarows: [], error: "x", status: 500 }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    expect((await transport().query("SELECT k FROM t")).rows).toEqual([]);
  });
});

/**
 * The login check: the server's own `_has_privileges` answer for the login making the request, asked by the open of a
 * handle that sends agent statements, and the server's listing of that login's privileges. Only Elasticsearch declares
 * the restricted system indices it asks about: family patterns, names, and names that carry the release, built from the
 * version the open read.
 */
describe("SearchHttpTransport login check", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  /** The privilege listing of the least-privilege role, as 9.1.4 lists it (measured 2026-11-01). */
  const AGENT_LISTING = {
    cluster: ["cluster:monitor/main"],
    global: [],
    indices: [{ names: ["probe_*"], privileges: ["read", "view_index_metadata"], allow_restricted_indices: false }],
    applications: [],
    run_as: [],
  };
  /** An answer to the asks that reads no restricted index for every name asked. */
  const narrowAnswer = () => {
    const sent = JSON.parse(String(calls.at(-1)?.init?.body)) as { index: { names: string[] }[] };
    return json({
      username: "u",
      has_all_requested: false,
      cluster: { all: false },
      index: Object.fromEntries((sent.index[0]?.names ?? []).map((name) => [name, { read: false }])),
      application: {},
    });
  };
  const elasticsearch = () => new SearchHttpTransport("elasticsearch", makeConnection("elasticsearch"));

  test("Elasticsearch asks one POST naming the cluster privilege all and read on every index, each restricted pattern and name, the release's names included, then lists the login's privileges", async () => {
    // Every asked name is answered, and the one that carries the release reads true.
    handler = (url) => {
      if (new URL(url).pathname === "/_security/user/_privileges") return json(AGENT_LISTING);
      const sent = JSON.parse(String(calls.at(-1)?.init?.body)) as { index: { names: string[] }[] };
      const names = sent.index[0]?.names ?? [];
      return json({
        username: "u",
        has_all_requested: false,
        cluster: { all: false },
        index: Object.fromEntries(names.map((name) => [name, { read: name === ".kibana_9.1.10_001" }])),
        application: {},
      });
    };

    const reach = await elasticsearch().loginReach("9.1.10");

    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/_security/user/_has_privileges");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(new URL(calls[1]?.url ?? "").pathname).toBe("/_security/user/_privileges");
    expect(calls[1]?.init?.method).toBe("GET");
    const body = JSON.parse(String(calls[0]?.init?.body)) as {
      cluster: string[];
      index: { names: string[]; privileges: string[]; allow_restricted_indices: boolean }[];
    };
    expect(body.cluster).toEqual(["all"]);
    expect(body.index).toHaveLength(1);
    expect(body.index[0]?.privileges).toEqual(["read"]);
    expect(body.index[0]?.allow_restricted_indices).toBe(true);
    expect(body.index[0]?.names.slice(0, 4)).toEqual(["*", ".security*", ".kibana*", ".fleet-*"]);
    for (const name of [".ds-*", ".fs-*", ".migrated-*", ".search-app*", ".security-7", ".kibana_security_session_1"]) {
      expect(body.index[0]?.names).toContain(name);
    }
    // The names that carry the release are built from the version the open read.
    expect(body.index[0]?.names.slice(-7)).toEqual([
      ".kibana_9.1.10_001",
      ".kibana_task_manager_9.1.10_001",
      ".kibana_analytics_9.1.10_001",
      ".kibana_ingest_9.1.10_001",
      ".kibana_security_solution_9.1.10_001",
      ".kibana_alerting_cases_9.1.10_001",
      ".kibana_usage_counters_9.1.10_001",
    ]);
    expect(body.index[0]?.names.some((name) => name.includes("{version}"))).toBe(false);
    expect(reach).toEqual({
      user: "u",
      clusterAll: false,
      everyIndex: false,
      restrictedIndices: [".kibana_9.1.10_001"],
      restrictedGrants: [],
    });
  });

  test("Elasticsearch names each index the listing grants with allow_restricted_indices, once, in the order listed", async () => {
    // Measured on 9.1.4: a role granting read with allow_restricted_indices on two Kibana indices of other releases.
    handler = (url) =>
      new URL(url).pathname === "/_security/user/_privileges"
        ? json({
            ...AGENT_LISTING,
            indices: [
              ...AGENT_LISTING.indices,
              {
                names: [".kibana_8.18.0_001", ".kibana_9.1.0_001"],
                privileges: ["read"],
                allow_restricted_indices: true,
              },
              { names: [".kibana_9.1.0_001"], privileges: ["view_index_metadata"], allow_restricted_indices: true },
            ],
          })
        : narrowAnswer();

    const reach = await elasticsearch().loginReach("9.1.4");

    expect(reach?.restrictedIndices).toEqual([]);
    expect(reach?.restrictedGrants).toEqual([".kibana_8.18.0_001", ".kibana_9.1.0_001"]);
  });

  test("Elasticsearch reads the listing's refusal for an API key with role descriptors of its own as no listing", async () => {
    const reason =
      "Cannot retrieve privileges for API keys with assigned role descriptors. Please use the Get API key information API https://ela.st/es-api-get-api-key";
    handler = (url) =>
      new URL(url).pathname === "/_security/user/_privileges"
        ? json(
            {
              error: {
                root_cause: [{ type: "illegal_argument_exception", reason }],
                type: "illegal_argument_exception",
                reason,
                caused_by: {
                  type: "unsupported_operation_exception",
                  reason: "cannot retrieve cluster permission on limited role",
                },
              },
              status: 400,
            },
            400,
          )
        : narrowAnswer();

    const reach = await elasticsearch().loginReach("9.1.4");

    expect(reach?.restrictedGrants).toBeNull();
    expect(calls).toHaveLength(2);
  });

  test.each([
    [
      "another 400",
      json(
        { error: { type: "illegal_argument_exception", reason: "Cannot retrieve privileges for users" }, status: 400 },
        400,
      ),
      "Cannot retrieve privileges for users",
    ],
    [
      "the same reason under another fault",
      json(
        {
          error: {
            type: "security_exception",
            reason:
              "Cannot retrieve privileges for API keys with assigned role descriptors. Please use the Get API key information API https://ela.st/es-api-get-api-key",
          },
          status: 400,
        },
        400,
      ),
      "Cannot retrieve privileges for API keys with assigned role descriptors. Please use the Get API key information API https://ela.st/es-api-get-api-key",
    ],
    [
      "no indices list",
      json({ ...AGENT_LISTING, indices: {} }),
      "Elasticsearch answered a privilege listing the client could not read",
    ],
    [
      "an entry with no flag",
      json({ ...AGENT_LISTING, indices: [{ names: ["probe_*"], privileges: ["read"] }] }),
      "Elasticsearch answered a privilege listing the client could not read",
    ],
    [
      "an entry whose names are not text",
      json({ ...AGENT_LISTING, indices: [{ names: [1], privileges: ["read"], allow_restricted_indices: true }] }),
      "Elasticsearch answered a privilege listing the client could not read",
    ],
    [
      "an entry that is not an object",
      json({ ...AGENT_LISTING, indices: ["probe_*"] }),
      "Elasticsearch answered a privilege listing the client could not read",
    ],
    [
      "a body that is not JSON",
      new Response("nope", { status: 200 }),
      "Elasticsearch answered a privilege listing the client could not read",
    ],
  ])("Elasticsearch fails a listing with %s", async (_name, reply, message) => {
    handler = (url) => (new URL(url).pathname === "/_security/user/_privileges" ? reply : narrowAnswer());

    const caught = await elasticsearch()
      .loginReach("9.1.4")
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(SearchTransportError);
    expect((caught as Error).message).toBe(message);
  });

  test("Elasticsearch with security off answers no login, after the one question it had no endpoint for", async () => {
    handler = () =>
      json({ error: "no handler found for uri [/_security/user/_has_privileges] and method [POST]" }, 400);

    expect(await elasticsearch().loginReach("9.1.4")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  test("Elasticsearch reads an answer that leaves an asked name out as unreadable", async () => {
    handler = (url) =>
      new URL(url).pathname === "/_security/user/_privileges"
        ? json(AGENT_LISTING)
        : json({
            username: "u",
            has_all_requested: false,
            cluster: { all: false },
            index: { "*": { read: false }, ".security-7": { read: true } },
            application: {},
          });

    const caught = await new SearchHttpTransport("elasticsearch", makeConnection("elasticsearch"))
      .loginReach("9.1.4")
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(SearchTransportError);
    expect((caught as Error).message).toBe("Elasticsearch answered a privilege check the client could not read");
  });

  test("OpenSearch declares no restricted indices, and refuses before any request", async () => {
    const caught = await new SearchHttpTransport("opensearch", makeConnection("opensearch"))
      .loginReach("3.8.0")
      .catch((error: unknown) => error);

    expect(caught).toBeInstanceOf(SearchTransportError);
    expect((caught as Error).message).toBe("OpenSearch declares no restricted system indices to check a login against");
    expect(calls).toHaveLength(0);
  });
});

/**
 * The statement check's three questions, each answered in the shape 9.1.4 answers it (measured 2026-11-01): what an
 * index expression resolves to, which aliases are hidden, and the marks of each data stream. A shape that is not the
 * measured one is unreadable, and an asked alias or data stream left out of an answer is too.
 */
describe("SearchHttpTransport index resolution", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const transport = () => new SearchHttpTransport("elasticsearch", makeConnection("elasticsearch"));
  const failure = (run: () => Promise<unknown>) => run().catch((error: unknown) => error);

  test("resolves one expression as a whole, its commas encoded, with the SQL endpoint's wildcard expansion", async () => {
    handler = () =>
      json({
        indices: [
          { name: "probe_orders", aliases: ["porders"], attributes: ["open"] },
          { name: "hidden_logs", attributes: ["hidden", "open"] },
          { name: ".security-7", attributes: ["hidden", "open", "system"] },
        ],
        aliases: [{ name: "logs_view", indices: ["hidden_logs"] }],
        data_streams: [
          { name: "probe_stream", backing_indices: [".ds-probe_stream-1"], timestamp_field: "@timestamp" },
        ],
      });

    const targets = await transport().resolveTargets(["probe_*,-probe_shapes"]);

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/_resolve/index/probe_*%2C-probe_shapes");
    expect(url.search).toBe("?expand_wildcards=open");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(targets).toEqual({
      indices: [
        { name: "probe_orders", hidden: false, system: false },
        { name: "hidden_logs", hidden: true, system: false },
        { name: ".security-7", hidden: true, system: true },
      ],
      aliases: [{ name: "logs_view", indices: ["hidden_logs"] }],
      dataStreams: [{ name: "probe_stream", backingIndices: [".ds-probe_stream-1"] }],
    });
  });

  test("resolves many names in request lines joined by a comma, and merges the answers", async () => {
    const names = Array.from({ length: 300 }, (_, i) => `logs-${String(i).padStart(20, "0")}`);
    handler = (url) => {
      const asked = decodeURIComponent(new URL(url).pathname.slice("/_resolve/index/".length)).split(",");
      return json({ indices: asked.map((name) => ({ name, attributes: ["open"] })), aliases: [], data_streams: [] });
    };

    const targets = await transport().resolveTargets(names);

    expect(calls.length).toBeGreaterThan(1);
    expect(calls.every((call) => call.url.length < 3700)).toBe(true);
    expect(targets.indices.map((index) => index.name)).toEqual(names);
  });

  test.each([
    ["not an object", []],
    ["no indices list", { aliases: [], data_streams: [] }],
    ["no aliases list", { indices: [], data_streams: [] }],
    ["no data streams list", { indices: [], aliases: [] }],
    ["an index with no name", { indices: [{ attributes: ["open"] }], aliases: [], data_streams: [] }],
    ["an index that is not an object", { indices: ["x"], aliases: [], data_streams: [] }],
    ["an index with no attributes", { indices: [{ name: "x" }], aliases: [], data_streams: [] }],
    ["an attribute that is not text", { indices: [{ name: "x", attributes: [true] }], aliases: [], data_streams: [] }],
    ["an alias with no name", { indices: [], aliases: [{ indices: ["x"] }], data_streams: [] }],
    ["an alias that is not an object", { indices: [], aliases: [7], data_streams: [] }],
    ["an alias with no indices", { indices: [], aliases: [{ name: "a" }], data_streams: [] }],
    ["a data stream with no name", { indices: [], aliases: [], data_streams: [{ backing_indices: [] }] }],
    ["a data stream that is not an object", { indices: [], aliases: [], data_streams: [null] }],
    ["a data stream with no backing indices", { indices: [], aliases: [], data_streams: [{ name: "s" }] }],
    [
      "a backing index that is not text",
      { indices: [], aliases: [], data_streams: [{ name: "s", backing_indices: [1] }] },
    ],
  ])("reads a resolution with %s as unreadable", async (_name, body) => {
    handler = () => json(body);

    const caught = await failure(() => transport().resolveTargets(["x"]));

    expect(caught).toBeInstanceOf(SearchTransportError);
    expect((caught as Error).message).toBe("Elasticsearch answered an index resolution the client could not read");
  });

  test("a name the server does not know fails the resolution in the server's words", async () => {
    handler = () =>
      json(
        {
          error: { type: "index_not_found_exception", reason: "no such index [missing]" },
          status: 404,
        },
        404,
      );

    const caught = await failure(() => transport().resolveTargets(["missing"]));

    expect(caught).toBeInstanceOf(SearchTransportError);
    expect((caught as Error).message).toBe("no such index [missing]");
  });

  test("names each hidden alias from the alias listing of the aliases asked about", async () => {
    handler = () =>
      json({
        hidden_logs: { aliases: { logs_view: {} } },
        probe_orders: { aliases: { hidden_view: { is_hidden: true }, porders: { is_hidden: false } } },
      });

    const hidden = await transport().hiddenAliases(["logs_view", "hidden_view", "porders"]);

    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/_alias/logs_view,hidden_view,porders");
    expect(hidden).toEqual(["hidden_view"]);
  });

  test.each([
    ["an asked alias left out", ["logs_view", "hidden_view"], { hidden_logs: { aliases: { logs_view: {} } } }],
    ["a mark that is not a boolean", ["logs_view"], { hidden_logs: { aliases: { logs_view: { is_hidden: "true" } } } }],
    ["a listing that is not an object", ["logs_view"], []],
    ["an entry with no aliases", ["logs_view"], { hidden_logs: {} }],
  ])("reads an alias listing with %s as unreadable", async (_name, asked, body) => {
    handler = () => json(body);

    const caught = await failure(() => transport().hiddenAliases(asked));

    expect(caught).toBeInstanceOf(SearchTransportError);
    expect((caught as Error).message).toBe("Elasticsearch answered an alias listing the client could not read");
  });

  test("reads each asked data stream's marks from the data stream listing", async () => {
    handler = () =>
      json({
        data_streams: [
          { name: "probe_stream", hidden: false, system: false, generation: 1 },
          { name: "hidden_stream", hidden: true, system: false },
        ],
      });

    const marks = await transport().dataStreamMarks(["probe_stream", "hidden_stream"]);

    expect(new URL(calls[0]?.url ?? "").pathname).toBe("/_data_stream/probe_stream,hidden_stream");
    expect(marks).toEqual([
      { name: "probe_stream", hidden: false, system: false },
      { name: "hidden_stream", hidden: true, system: false },
    ]);
  });

  test.each([
    ["an asked data stream left out", { data_streams: [{ name: "probe_stream", hidden: false, system: false }] }],
    ["a mark that is not a boolean", { data_streams: [{ name: "hidden_stream", hidden: "true", system: false }] }],
    ["no system mark", { data_streams: [{ name: "hidden_stream", hidden: false }] }],
    ["an entry with no name", { data_streams: [{ hidden: false, system: false }] }],
    ["an entry that is not an object", { data_streams: ["hidden_stream"] }],
    ["no data stream list", {}],
  ])("reads a data stream listing with %s as unreadable", async (_name, body) => {
    handler = () => json(body);

    const caught = await failure(() => transport().dataStreamMarks(["hidden_stream"]));

    expect(caught).toBeInstanceOf(SearchTransportError);
    expect((caught as Error).message).toBe("Elasticsearch answered a data stream listing the client could not read");
  });
});

/**
 * The indices the SQL endpoint reads for a table, asked the way the endpoint resolves one: a field capabilities request
 * with the index options its resolver sends (measured on 9.1.4, 2026-11-01). Only Elasticsearch declares that request.
 */
describe("SearchHttpTransport SQL table resolution", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const transport = () => new SearchHttpTransport("elasticsearch", makeConnection("elasticsearch"));
  const failure = (run: () => Promise<unknown>) => run().catch((error: unknown) => error);

  test("asks the field capabilities of the expression as a whole, with the SQL resolver's index options", async () => {
    handler = () =>
      json({
        indices: [".ds-probe_stream-1", "hidden_logs", "probe_orders"],
        fields: { _index: { _index: { type: "_index", metadata_field: true, searchable: true, aggregatable: true } } },
      });

    const indices = await transport().sqlTableIndices("probe_*,logs_view");

    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]?.url ?? "");
    expect(url.pathname).toBe("/probe_*%2Clogs_view/_field_caps");
    expect(url.search).toBe("?fields=_index&ignore_unavailable=true&allow_no_indices=true&expand_wildcards=open");
    expect(calls[0]?.init?.method).toBe("GET");
    expect(indices).toEqual([".ds-probe_stream-1", "hidden_logs", "probe_orders"]);
  });

  test("answers no index for an expression that resolves to none", async () => {
    handler = () => json({ indices: [], fields: {} });

    expect(await transport().sqlTableIndices("nomatch*")).toEqual([]);
  });

  test("fails an answer that holds a failure for any index: the indices read are then not all known", async () => {
    handler = () =>
      json({
        indices: ["probe_orders"],
        fields: {},
        failed_indices: 1,
        failures: [{ indices: ["red_logs"], failure: { error: { type: "no_shard_available_action_exception" } } }],
      });

    const caught = await failure(() => transport().sqlTableIndices("probe_orders,red_logs"));

    expect(caught).toBeInstanceOf(SearchTransportError);
    expect((caught as Error).message).toBe(
      "Elasticsearch could not answer the field capabilities of every index the expression resolves to, so the indices its SQL endpoint reads are not all known",
    );
  });

  test.each([
    ["not an object", []],
    ["no indices list", { fields: {} }],
    ["an index that is not text", { indices: [7], fields: {} }],
    ["failures that are not a list", { indices: [], fields: {}, failures: {} }],
  ])("reads an answer with %s as unreadable", async (_name, body) => {
    handler = () => json(body);

    const caught = await failure(() => transport().sqlTableIndices("x"));

    expect(caught).toBeInstanceOf(SearchTransportError);
    expect((caught as Error).message).toBe(
      "Elasticsearch answered a field capabilities request the client could not read",
    );
  });

  test("a refusal fails the call in the server's words", async () => {
    handler = () =>
      json(
        {
          error: { type: "security_exception", reason: "action [indices:data/read/field_caps] is unauthorized" },
          status: 403,
        },
        403,
      );

    const caught = await failure(() => transport().sqlTableIndices("x"));

    expect(caught).toBeInstanceOf(SearchTransportError);
    expect((caught as Error).message).toBe("Elasticsearch refused the credentials (HTTP 403)");
  });

  test("OpenSearch declares no SQL table resolution, and refuses before any request", async () => {
    const caught = await failure(() =>
      new SearchHttpTransport("opensearch", makeConnection("opensearch")).sqlTableIndices("x"),
    );

    expect(caught).toBeInstanceOf(SearchTransportError);
    expect((caught as Error).message).toBe(
      "OpenSearch declares no measured resolution of a SQL table to check an agent statement against",
    );
    expect(calls).toHaveLength(0);
  });
});
