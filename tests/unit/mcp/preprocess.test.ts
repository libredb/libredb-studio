/**
 * The pre-processing of an authenticated POST to /api/mcp (#246): step 0 spends one slot of the
 * query bucket per POST, keyed on the user the token was minted for, before the body is read;
 * steps 1 to 8 read the body under the SDK's bound and answer what the SDK does not enforce.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import { getServerAuditBuffer } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { preprocessMcpPost, recordInvalidArguments } from "@/lib/mcp/preprocess";
import { MCP_TEST_URL, testAuthInfo } from "../../helpers/mcp-harness";

const alice = testAuthInfo({ username: "alice", role: "admin" });
const bob = testAuthInfo({ username: "bob", role: "user" });

function post(): Request {
  return new Request(MCP_TEST_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-protocol-version": "2025-11-25" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
}

/** A POST whose body stream fails the moment anything reads it. */
function unreadablePost(): Request {
  const body = new ReadableStream({
    pull() {
      throw new Error("the body was read");
    },
  });
  return new Request(MCP_TEST_URL, { method: "POST", headers: { "content-type": "application/json" }, body });
}

const lines = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);

beforeEach(() => {
  clearRateLimitState();
  process.env.RATE_LIMIT_QUERY_MAX = "1";
});

afterEach(() => {
  clearRateLimitState();
  delete process.env.RATE_LIMIT_QUERY_MAX;
});

describe("step 0, the query budget", () => {
  test("dispatches an allowed POST with its parsed body", async () => {
    expect(await preprocessMcpPost(post(), alice)).toEqual({
      kind: "dispatch",
      parsedBody: { jsonrpc: "2.0", id: 1, method: "tools/list" },
      invalidArgumentsTool: null,
    });
  });

  test("answers the POST after the budget with the repository's 429 and Retry-After, without reading the body", async () => {
    await preprocessMcpPost(post(), alice);
    const request = unreadablePost();
    const outcome = await preprocessMcpPost(request, alice);
    if (outcome.kind !== "refused") throw new Error("the second POST should have been refused");
    expect(outcome.response.status).toBe(429);
    expect(Number(outcome.response.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await outcome.response.json()).toMatchObject({ code: "RATE_LIMITED", statusCode: 429, retryable: true });
    expect(request.bodyUsed).toBe(false);
  });

  test("writes one rate_limit_exceeded event on the trip, and none for the 429s after it", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (let i = 0; i < 4; i += 1) await preprocessMcpPost(post(), alice);
      const trips = lines(spy).filter((line) => line.event === "rate_limit_exceeded");
      expect(trips).toHaveLength(1);
      expect(trips[0]).toMatchObject({
        actor: "alice",
        bucket: "query",
        route: "POST /api/mcp",
        reason: "rate_limited",
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("still answers 429 when the audit sink throws, and logs the failure once", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      await preprocessMcpPost(post(), alice);
      const outcome = await preprocessMcpPost(post(), alice);
      expect(outcome.kind === "refused" ? outcome.response.status : 0).toBe(429);
      expect(errorLog).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      errorLog.mockRestore();
    }
  });

  test("is kept per user", async () => {
    await preprocessMcpPost(post(), alice);
    expect((await preprocessMcpPost(post(), alice)).kind).toBe("refused");
    expect((await preprocessMcpPost(post(), bob)).kind).toBe("dispatch");
  });

  test("RATE_LIMIT_QUERY_MAX=0 means unlimited", async () => {
    process.env.RATE_LIMIT_QUERY_MAX = "0";
    for (let i = 0; i < 10; i += 1) expect((await preprocessMcpPost(post(), alice)).kind).toBe("dispatch");
  });
});

const rpcError = (code: number, message: string, id: string | number | null = null) => ({
  jsonrpc: "2.0",
  error: { code, message },
  id,
});
const VERSION_REQUIRED =
  "Header mismatch: MCP-Protocol-Version is required on every request after initialize; this server does not serve protocol version 2025-03-26";
const ENVELOPE = {
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientCapabilities": {},
};

function postWith(body: BodyInit | null, headers: Record<string, string> = {}): Request {
  return new Request(MCP_TEST_URL, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}
const legacy = (
  message: Record<string, unknown>,
  headers: Record<string, string> = { "mcp-protocol-version": "2025-11-25" },
) => postWith(JSON.stringify({ jsonrpc: "2.0", ...message }), headers);
const modern = (method: string, params: Record<string, unknown>, headers: Record<string, string> = {}) =>
  postWith(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: ENVELOPE } }), {
    "mcp-protocol-version": "2026-07-28",
    "mcp-method": method,
    ...headers,
  });

async function refusal(request: Request): Promise<{ status: number; body: unknown }> {
  const outcome = await preprocessMcpPost(request, alice);
  if (outcome.kind !== "refused") throw new Error(`expected a refusal, got ${JSON.stringify(outcome)}`);
  return { status: outcome.response.status, body: await outcome.response.json() };
}

async function dispatched(request: Request): Promise<{ parsedBody: unknown; invalidArgumentsTool: string | null }> {
  const outcome = await preprocessMcpPost(request, alice);
  if (outcome.kind !== "dispatch") throw new Error(`expected a dispatch, got a ${outcome.response.status}`);
  return { parsedBody: outcome.parsedBody, invalidArgumentsTool: outcome.invalidArgumentsTool };
}

describe("steps 1 to 8", () => {
  beforeEach(() => {
    process.env.RATE_LIMIT_QUERY_MAX = "0";
  });

  test("step 1 refuses a Content-Type that is not JSON with the SDK's 415, and passes JSON with parameters", async () => {
    expect(await refusal(postWith("{}", { "content-type": "text/plain" }))).toEqual({
      status: 415,
      body: rpcError(-32000, "Unsupported Media Type: Content-Type must be application/json"),
    });
    const ping = legacy(
      { id: 1, method: "ping" },
      { "content-type": "application/json; charset=utf-8", "mcp-protocol-version": "2025-11-25" },
    );
    expect((await dispatched(ping)).parsedBody).toEqual({ jsonrpc: "2.0", id: 1, method: "ping" });
  });

  test("step 2 refuses a body one byte over 4 MiB with the SDK's 413, and passes one of exactly 4 MiB", async () => {
    const over = JSON.stringify("x".repeat(4 * 1024 * 1024 - 1));
    expect(over.length).toBe(4 * 1024 * 1024 + 1);
    expect(await refusal(postWith(over))).toEqual({
      status: 413,
      body: rpcError(-32000, "Payload Too Large: Request body must not exceed 4194304 bytes"),
    });
    const exact = JSON.stringify("x".repeat(4 * 1024 * 1024 - 2));
    expect((await dispatched(postWith(exact))).parsedBody).toBe("x".repeat(4 * 1024 * 1024 - 2));
  });

  test("step 2 refuses a declared Content-Length over the bound without reading the body", async () => {
    const request = unreadablePost();
    request.headers.set("content-length", String(4 * 1024 * 1024 + 1));
    expect((await refusal(request)).status).toBe(413);
    expect(request.bodyUsed).toBe(false);
  });

  test("step 2 answers a body stream that fails with 400 -32700", async () => {
    expect(await refusal(unreadablePost())).toEqual({
      status: 400,
      body: rpcError(-32700, "Parse error: the request body could not be read"),
    });
  });

  test.each(["", "{not json"])("step 3 refuses the body %p with 400 -32700", async (body) => {
    expect(await refusal(postWith(body))).toEqual({ status: 400, body: rpcError(-32700, "Parse error: Invalid JSON") });
  });

  test("step 3 passes JSON that is not an object on to the SDK, which answers it", async () => {
    expect((await dispatched(postWith("42"))).parsedBody).toBe(42);
  });

  test.each([
    "[]",
    JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "ping" }]),
    JSON.stringify([
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]),
    JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: ENVELOPE } }]),
  ])("step 4 refuses the batch %p with 400 -32600 and id null", async (body) => {
    expect(await refusal(postWith(body))).toEqual({
      status: 400,
      body: rpcError(-32600, "Bad Request: JSON-RPC batches are not supported by this endpoint"),
    });
  });

  test("step 5 refuses a modern MCP-Protocol-Version outside visible ASCII, echoing the id, with no Base64 advice", async () => {
    expect(await refusal(modern("tools/list", {}, { "mcp-protocol-version": "2026-07-2é" }))).toEqual({
      status: 400,
      body: rpcError(
        -32020,
        "Header mismatch: the MCP-Protocol-Version header holds a character outside visible ASCII, space and tab",
        1,
      ),
    });
  });

  test("step 5 refuses a modern Mcp-Method outside visible ASCII even when it equals the body's method", async () => {
    expect(await refusal(modern("tést/list", {}))).toEqual({
      status: 400,
      body: rpcError(
        -32020,
        "Header mismatch: the Mcp-Method header holds a character outside visible ASCII, space and tab",
        1,
      ),
    });
  });

  test("step 5 names MCP-Protocol-Version first when both headers are outside visible ASCII", async () => {
    const both = await refusal(modern("tést/list", {}, { "mcp-protocol-version": "2026-07-2é" }));
    expect((both.body as { error: { message: string } }).error.message).toContain("the MCP-Protocol-Version header");
  });

  test("step 5 refuses a raw Mcp-Name outside visible ASCII with the Base64 advice, and passes its Base64 form", async () => {
    expect(await refusal(modern("tools/call", { name: "tést", arguments: {} }, { "mcp-name": "tést" }))).toEqual({
      status: 400,
      body: rpcError(
        -32020,
        "Header mismatch: the Mcp-Name header holds a character outside visible ASCII, space and tab; send it Base64-encoded as =?base64?...?=",
        1,
      ),
    });
    await dispatched(modern("tools/call", { name: "tést", arguments: {} }, { "mcp-name": "=?base64?dMOpc3Q=?=" }));
  });

  test("step 5 passes a modern tools/call whose standard headers are all visible ASCII", async () => {
    await dispatched(
      modern("tools/call", { name: "list_connections", arguments: {} }, { "mcp-name": "list_connections" }),
    );
  });

  test("step 5 leaves a legacy body's headers alone", async () => {
    await dispatched(
      legacy({ id: 1, method: "tools/list" }, { "mcp-protocol-version": "2025-11-25", "mcp-method": "tést" }),
    );
  });

  test.each([
    ["a tools/call", { id: 9, method: "tools/call", params: { name: "list_connections", arguments: {} } }, 9],
    ["notifications/initialized", { method: "notifications/initialized" }, null],
    ["a posted response", { id: 5, result: {} }, 5],
    [
      "a tools/call carrying only _meta.progressToken",
      {
        id: 3,
        method: "tools/call",
        params: { name: "list_connections", arguments: {}, _meta: { progressToken: "p" } },
      },
      3,
    ],
  ])("step 6 refuses %s without MCP-Protocol-Version with 400 -32020", async (_name, message, id) => {
    expect(await refusal(legacy(message, {}))).toEqual({ status: 400, body: rpcError(-32020, VERSION_REQUIRED, id) });
  });

  test("step 6 passes a header-less initialize, the default client's first request", async () => {
    const initialize = {
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "c", version: "1" } },
    };
    await dispatched(legacy(initialize, {}));
  });

  test("step 7 refuses a subscriptions/listen request with 404 -32601, echoing the id, and passes tools/list", async () => {
    expect(await refusal(modern("subscriptions/listen", {}))).toEqual({
      status: 404,
      body: rpcError(-32601, "Method not found", 1),
    });
    await dispatched(modern("tools/list", {}));
  });

  test.each([
    ["run_read_query", { connection_id: "seed:shop", sql: "SELECT 1", max_rows: 999 }],
    ["inspect_schema", {}],
  ])("step 8 keeps the verdict that %s's arguments fail its input schema", async (tool, args) => {
    const call = legacy({ id: 1, method: "tools/call", params: { name: tool, arguments: args } });
    expect((await dispatched(call)).invalidArgumentsTool).toBe(tool);
  });

  test.each([
    ["valid arguments", { name: "run_read_query", arguments: { connection_id: "seed:shop", sql: "SELECT 1" } }],
    ["an unknown tool", { name: "no_such_tool", arguments: { max_rows: 999 } }],
    ["no arguments for a tool that needs none", { name: "list_connections" }],
    [
      "arguments that are null, which the SDK's request schema refuses first",
      { name: "run_read_query", arguments: null },
    ],
    ["arguments that are a string", { name: "run_read_query", arguments: "SELECT 1" }],
    ["arguments that are an array", { name: "inspect_schema", arguments: [] }],
    ["null arguments to a tool that needs none", { name: "list_connections", arguments: null }],
  ])("step 8 records nothing for %s", async (_name, params) => {
    expect((await dispatched(legacy({ id: 1, method: "tools/call", params }))).invalidArgumentsTool).toBeNull();
  });
});

describe("recordInvalidArguments", () => {
  test("writes one mcp_operation decision event for the token's user, with no connection", () => {
    getServerAuditBuffer().clear();
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      recordInvalidArguments("run_read_query", alice);
      const [event] = getServerAuditBuffer().getAll();
      expect(event).toMatchObject({
        type: "mcp_operation",
        action: "run_read_query",
        target: "mcp/decision",
        user: "alice",
        result: "failure",
        reason: "mcp_invalid_arguments",
      });
      expect(event.connectionName).toBeUndefined();
      expect(event.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    } finally {
      spy.mockRestore();
    }
  });

  test("logs a sink failure and never throws, because nothing ran", () => {
    const spy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      expect(() => recordInvalidArguments("inspect_schema", alice)).not.toThrow();
      expect(errorLog).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      errorLog.mockRestore();
    }
  });
});
