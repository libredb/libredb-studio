/**
 * The Druid HTTP transport's agent path: the one request an agent statement goes out on, its byte cap, and the cancel
 * of its query id. Every request is pinned in full, body text included, because the context it carries is the
 * boundary: the native engine, the query id and the timeout are written here and nowhere else, and nothing one request
 * names reaches the next. The answers replayed are those `tests/fixtures/druid/37.0.0/agent-boundary/` records.
 *
 * globalThis.fetch is replaced per test and restored in afterEach; mock.module() is not used, since it is process-wide
 * in bun.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DruidHttpTransport } from "@/lib/db/providers/sql/druid/http-transport";
import {
  DruidAnswerTooLargeError,
  DRUID_TRANSPORT_FAILURE,
  DruidTransportError,
} from "@/lib/db/providers/sql/druid/transport";
import { ConnectionError } from "@/lib/db/errors";
import type { DatabaseConnection } from "@/lib/db/types";

interface FetchCall {
  url: string;
  init: RequestInit | undefined;
}

const originalFetch = globalThis.fetch;
let calls: FetchCall[] = [];
let handler: (url: string, init?: RequestInit) => Response | Promise<Response>;

const ROWS_BODY = '[["n"],["LONG"],["BIGINT"],[1000000]]';

function respond(body: string | ReadableStream<Uint8Array> | null, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function makeTransport(overrides: Partial<DatabaseConnection> = {}): DruidHttpTransport {
  return new DruidHttpTransport({
    id: "druid-1",
    name: "Druid",
    type: "druid",
    host: "127.0.0.1",
    port: 8888,
    createdAt: new Date(),
    ...overrides,
  });
}

function options(overrides: Partial<{ queryId: string; timeoutMs: number; maxResponseBytes: number }> = {}) {
  return {
    queryId: "11111111-2222-4333-8444-555555555555",
    timeoutMs: 30000,
    maxResponseBytes: 1024,
    signal: new AbortController().signal,
    ...overrides,
  };
}

function only(): FetchCall {
  expect(calls).toHaveLength(1);
  return calls[0];
}

beforeEach(() => {
  calls = [];
  handler = () => respond(ROWS_BODY);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return await handler(url, init);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("the agent statement's request", () => {
  test("is one POST to the SQL endpoint whose body pins the native engine, the query id and the timeout, in that order and nothing else", async () => {
    const transport = makeTransport();
    const result = await transport.agentQuery('SELECT COUNT(*) AS n FROM "libredb_agent_data"', options());
    const call = only();
    expect(call.url).toBe("http://127.0.0.1:8888/druid/v2/sql");
    expect(call.init?.method).toBe("POST");
    expect(call.init?.redirect).toBe("manual");
    expect(call.init?.headers).toEqual({ "content-type": "application/json" });
    expect(String(call.init?.body)).toBe(
      '{"query":"SELECT COUNT(*) AS n FROM \\"libredb_agent_data\\"","resultFormat":"array","header":true,"typesHeader":true,"sqlTypesHeader":true,"context":{"engine":"native","sqlQueryId":"11111111-2222-4333-8444-555555555555","timeout":30000}}',
    );
    expect(result.rows).toEqual([{ n: 1000000 }]);
    expect(result.fieldNames).toEqual(["n"]);
  });

  test("carries the connection's credential, and the caller's signal", async () => {
    const signal = new AbortController().signal;
    await makeTransport({ user: "agent_ro", password: "not-a-real-password" }).agentQuery("SELECT 1", {
      ...options(),
      signal,
    });
    const call = only();
    expect(call.init?.headers).toEqual({
      "content-type": "application/json",
      authorization: `Basic ${Buffer.from("agent_ro:not-a-real-password").toString("base64")}`,
    });
    expect(call.init?.signal).toBe(signal);
  });

  test("each request names only its own query id and timeout: nothing from the one before", async () => {
    const transport = makeTransport();
    await transport.agentQuery("SELECT 1", options({ queryId: "first-id", timeoutMs: 1000 }));
    await transport.agentQuery("SELECT 2", options({ queryId: "second-id", timeoutMs: 2000 }));
    expect(calls.map((call) => JSON.parse(String(call.init?.body)).context)).toEqual([
      { engine: "native", sqlQueryId: "first-id", timeout: 1000 },
      { engine: "native", sqlQueryId: "second-id", timeout: 2000 },
    ]);
  });

  test("the server's refusal leaves as the classified error", async () => {
    handler = () =>
      respond(
        '{"error":"druidException","errorCode":"invalidInput","persona":"USER","category":"INVALID_INPUT","errorMessage":"INSERT operations are not supported by requested SQL engine [native], consider using MSQ.","context":{"sourceType":"sql"}}',
        400,
      );
    const error = await makeTransport()
      .agentQuery("INSERT INTO t SELECT 1", options())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DruidTransportError);
    expect((error as DruidTransportError).category).toBe("INVALID_INPUT");
    expect((error as DruidTransportError).message).toBe(
      "INSERT operations are not supported by requested SQL engine [native], consider using MSQ.",
    );
  });

  test("a 403 with no envelope, the authorizer's refusal of what the statement names, leaves as FORBIDDEN", async () => {
    handler = () => respond('{"Access-Check-Result":"Unauthorized"}', 403);
    const error = await makeTransport()
      .agentQuery('SELECT COUNT(*) AS n FROM "other"', options())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DruidTransportError);
    expect((error as DruidTransportError).category).toBe("FORBIDDEN");
    expect((error as DruidTransportError).message).toBe("Druid refused the statement with HTTP 403: Unauthorized");
  });

  test("a 403 whose body says nothing still leaves as FORBIDDEN", async () => {
    handler = () => respond("", 403);
    const error = await makeTransport()
      .agentQuery("SELECT 1", options())
      .catch((caught: unknown) => caught);
    expect((error as DruidTransportError).category).toBe("FORBIDDEN");
    expect((error as DruidTransportError).message).toBe("Druid refused the statement with HTTP 403");
  });

  test("a failure to reach the server leaves as the stand-in category", async () => {
    handler = () => {
      throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    };
    const error = await makeTransport()
      .agentQuery("SELECT 1", options())
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DruidTransportError);
    expect((error as DruidTransportError).category).toBe(DRUID_TRANSPORT_FAILURE);
  });

  test("a redirect is refused, not followed", async () => {
    handler = () => new Response(null, { status: 307, headers: { location: "http://elsewhere/" } });
    await expect(makeTransport().agentQuery("SELECT 1", options())).rejects.toBeInstanceOf(ConnectionError);
  });
});

describe("the agent statement's byte cap", () => {
  function streamOf(chunks: string[]): {
    stream: ReadableStream<Uint8Array>;
    cancelled: () => boolean;
    pulled: () => number;
  } {
    let index = 0;
    let wasCancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < chunks.length) controller.enqueue(new TextEncoder().encode(chunks[index++]));
        else controller.close();
      },
      cancel() {
        wasCancelled = true;
      },
    });
    return { stream, cancelled: () => wasCancelled, pulled: () => index };
  }

  test("reads an answer of exactly the cap", async () => {
    const body = '[["n"],["LONG"],["BIGINT"],[1]]';
    handler = () => respond(body);
    const result = await makeTransport().agentQuery("SELECT 1", options({ maxResponseBytes: body.length }));
    expect(result.rows).toEqual([{ n: 1 }]);
  });

  test("stops reading the moment the answer passes the cap, and says how many bytes it allowed", async () => {
    const body = streamOf(['[["n"],["LONG"],["BIGINT"]', ",[1],[2]", ",[3]]", ",never read"]);
    handler = () => respond(body.stream);
    const error = await makeTransport()
      .agentQuery("SELECT 1", options({ maxResponseBytes: 30 }))
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DruidAnswerTooLargeError);
    expect((error as DruidAnswerTooLargeError).maxResponseBytes).toBe(30);
    expect((error as DruidAnswerTooLargeError).message).toBe(
      "Druid's answer passed 30 bytes, so it was not read further",
    );
    expect(body.cancelled()).toBe(true);
    expect(body.pulled()).toBeLessThan(4);
  });

  test("counts bytes, not characters", async () => {
    const body = '[["s"],["STRING"],["VARCHAR"],["éé"]]';
    handler = () => respond(body);
    await expect(
      makeTransport().agentQuery("SELECT 1", options({ maxResponseBytes: body.length })),
    ).rejects.toBeInstanceOf(DruidAnswerTooLargeError);
    const result = await makeTransport().agentQuery("SELECT 1", options({ maxResponseBytes: Buffer.byteLength(body) }));
    expect(result.rows).toEqual([{ s: "éé" }]);
  });

  test("a body cut off mid-value is an incomplete result, not a short one", async () => {
    handler = () => respond('[["n"],["LONG"],["BIGINT"],[1],[2');
    await expect(makeTransport().agentQuery("SELECT 1", options())).rejects.toThrow(
      "Druid ended the response before it was complete, so the result is incomplete",
    );
  });

  test("an answer with no body reads as an incomplete result", async () => {
    handler = () => respond(null);
    await expect(makeTransport().agentQuery("SELECT 1", options())).rejects.toThrow(
      "Druid ended the response before it was complete, so the result is incomplete",
    );
  });
});

describe("the cancel of an agent statement", () => {
  test("is one DELETE of the query id on the SQL endpoint, answered 202 as cancelled", async () => {
    handler = () => respond(null, 202);
    const signal = new AbortController().signal;
    const outcome = await makeTransport({ user: "agent_ro", password: "not-a-real-password" }).cancel(
      "11111111-2222-4333-8444-555555555555",
      signal,
    );
    expect(outcome).toBe("cancelled");
    const call = only();
    expect(call.url).toBe("http://127.0.0.1:8888/druid/v2/sql/11111111-2222-4333-8444-555555555555");
    expect(call.init?.method).toBe("DELETE");
    expect(call.init?.redirect).toBe("manual");
    expect(call.init?.body).toBeUndefined();
    expect(call.init?.headers).toEqual({
      authorization: `Basic ${Buffer.from("agent_ro:not-a-real-password").toString("base64")}`,
    });
    expect(call.init?.signal).toBe(signal);
  });

  test("answers not-found for 404, an id no statement holds any longer", async () => {
    handler = () => respond(null, 404);
    await expect(makeTransport().cancel("gone", new AbortController().signal)).resolves.toBe("not-found");
  });

  test("escapes the id into one path segment", async () => {
    handler = () => respond(null, 202);
    await makeTransport().cancel("a/b?c", new AbortController().signal);
    expect(only().url).toBe("http://127.0.0.1:8888/druid/v2/sql/a%2Fb%3Fc");
  });

  test("any other answer is the server's refusal, its own words carried", async () => {
    handler = () => respond('{"Access-Check-Result":"Unauthorized"}', 403);
    const error = await makeTransport()
      .cancel("id", new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DruidTransportError);
    expect((error as DruidTransportError).message).toBe("Druid refused the cancel with HTTP 403");
  });

  test("a failure to reach the server leaves as the stand-in category", async () => {
    handler = () => {
      throw new DOMException("The operation timed out.", "TimeoutError");
    };
    const error = await makeTransport()
      .cancel("id", new AbortController().signal)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DruidTransportError);
    expect((error as DruidTransportError).category).toBe(DRUID_TRANSPORT_FAILURE);
  });

  test("a redirect is refused, not followed", async () => {
    handler = () => new Response(null, { status: 302, headers: { location: "http://elsewhere/" } });
    await expect(makeTransport().cancel("id", new AbortController().signal)).rejects.toBeInstanceOf(ConnectionError);
  });
});
