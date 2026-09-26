/**
 * POST, GET and DELETE /api/mcp through the route module (#246), driven by the official SDK
 * client in process.
 *
 * Every request carries a scoped bearer token minted at run time; the Studio session opens nothing here.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/server";
import { signJWT } from "@/lib/auth";
import { logger } from "@/lib/logger";
import {
  countMethod,
  createDuckdbFile,
  createSqliteFile,
  gateMethod,
  pinMcpTestEnvironment,
  resetMcpTestState,
  writeSeedFile,
} from "../../helpers/mcp-fixtures";
import {
  connectClient,
  legacyPost,
  MCP_TEST_URL,
  mcpPostHeaders,
  modernPost,
  readJsonRpc,
  routeServe,
} from "../../helpers/mcp-harness";
import { mintTestToken, useMcpChannel } from "../../helpers/mcp-token";

pinMcpTestEnvironment();

const route = await import("@/app/api/mcp/route");
const { DuckDBProvider } = await import("@/lib/db/providers/sql/duckdb");
const { SQLiteProvider } = await import("@/lib/db/providers/sql/sqlite");
const { getServerAuditBuffer } = await import("@/lib/audit");
const serve = routeServe(route);
const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-route-"));

let restoreChannel: () => void = () => {};
let token = "";

beforeAll(async () => {
  createSqliteFile(join(dir, "shop.db"), [
    "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)",
    "INSERT INTO users VALUES (1, 'Ada'), (2, 'Grace')",
  ]);
  await createDuckdbFile(join(dir, "slow.duckdb"), [
    "CREATE TABLE answers (answer INTEGER)",
    "INSERT INTO answers VALUES (42)",
  ]);
});

beforeEach(async () => {
  restoreChannel = useMcpChannel();
  token = await mintTestToken();
  writeSeedFile(dir, [
    { id: "shop", type: "sqlite", database: join(dir, "shop.db") },
    { id: "slow", type: "duckdb", database: join(dir, "slow.duckdb") },
  ]);
});

afterEach(async () => {
  restoreChannel();
  await resetMcpTestState();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("a cancel sent in its own POST", () => {
  test("does not stop the call it names, because the SDK serves every POST on a server of its own", async () => {
    const gate = gateMethod(DuckDBProvider.prototype, "queryReadOnly");
    try {
      const call = serve(
        legacyPost(
          {
            jsonrpc: "2.0",
            id: 7,
            method: "tools/call",
            params: {
              name: "run_read_query",
              arguments: { connection_id: "seed:slow", sql: "SELECT answer FROM answers" },
            },
          },
          { token },
        ),
      );
      await gate.entered;
      const cancel = await serve(
        legacyPost(
          {
            jsonrpc: "2.0",
            method: "notifications/cancelled",
            params: { requestId: 7, reason: "stopped by the test" },
          },
          { token },
        ),
      );
      expect(cancel.status).toBe(202);

      gate.release();
      const reply = await readJsonRpc(await call);
      expect(reply.result?.isError ?? false).toBe(false);
      expect(JSON.stringify(reply.result?.content)).toContain("42");
    } finally {
      gate.release();
      // The held statement runs to its end before afterEach closes the provider under it.
      await gate.finished;
      gate.restore();
    }
  });
});

describe("a client pinned to revision 2026-07-28", () => {
  test("discovers the server, connects in the modern era and calls a tool", async () => {
    const session = await connectClient(serve, { negotiation: "pinned", token });
    try {
      expect(session.client.getProtocolEra()).toBe("modern");
      const result = await session.client.callTool({ name: "list_connections", arguments: {} });
      expect(JSON.stringify(result.content)).toContain("seed:shop");
    } finally {
      await session.close();
    }
  });
});

describe("the route in front of the SDK", () => {
  test("lets the default client connect and list the three tools", async () => {
    const session = await connectClient(serve, { token });
    try {
      expect((await session.client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "list_connections",
        "inspect_schema",
        "run_read_query",
      ]);
    } finally {
      await session.close();
    }
  });

  test.each(["GET", "DELETE"])("answers %s with the SDK's 405 and Allow: POST", async (method) => {
    const response = await serve(
      new Request("http://localhost:3000/api/mcp", {
        method,
        headers: { host: "localhost:3000", authorization: `Bearer ${token}` },
      }),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  test("answers a legacy notification with 202, not 204", async () => {
    const response = await serve(legacyPost({ jsonrpc: "2.0", method: "notifications/initialized" }, { token }));
    expect(response.status).toBe(202);
  });

  test("answers 401 with the bearer challenge for a POST without a token, and for a random one", async () => {
    for (const options of [{}, { token: "random-bearer-written-in-words" }]) {
      const response = await serve(legacyPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, options));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toStartWith('Bearer error="invalid_token"');
      expect(((await response.json()) as { error: string }).error).toBe("invalid_token");
    }
  });

  test("hands the token's user to the tools as their caller", async () => {
    const session = await connectClient(serve, { token });
    try {
      await session.client.callTool({
        name: "run_read_query",
        arguments: { connection_id: "seed:shop", sql: "SELECT id FROM users" },
      });
      const users = getServerAuditBuffer()
        .getAll()
        .filter((event) => event.action === "run_read_query")
        .map((event) => event.user);
      // At least one event, and every one names the caller, however many events the tool writes
      // for one call.
      expect([...new Set(users)]).toEqual(["alice"]);
    } finally {
      await session.close();
    }
  });
});

describe("the session cookie opens nothing on /api/mcp", () => {
  const runQuery = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "run_read_query", arguments: { connection_id: "seed:shop", sql: "SELECT id FROM users" } },
  };

  test("a valid session cookie without a bearer gets 401 and constructs no provider", async () => {
    const connects = countMethod(SQLiteProvider.prototype, "connect");
    try {
      const cookie = await signJWT({ username: "alice", role: "admin" });
      const response = await serve(legacyPost(runQuery, { headers: { cookie: `auth-token=${cookie}` } }));
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toStartWith('Bearer error="invalid_token"');
      expect(connects.calls).toBe(0);
    } finally {
      connects.restore();
    }
  });

  test("one user's cookie with another user's token acts as the token's user", async () => {
    const cookie = await signJWT({ username: "alice", role: "admin" });
    const bobToken = await mintTestToken({ username: "bob", role: "user" });
    await readJsonRpc(
      await serve(legacyPost(runQuery, { token: bobToken, headers: { cookie: `auth-token=${cookie}` } })),
    );
    const users = getServerAuditBuffer()
      .getAll()
      .filter((event) => event.action === "run_read_query")
      .map((event) => event.user);
    expect([...new Set(users)]).toEqual(["bob"]);
  });
});

describe("the server version, checked after the kill switch", () => {
  test("unset answers an authenticated request with 500 naming the variable, and a request without a token with 401", async () => {
    const saved = process.env.NEXT_PUBLIC_APP_VERSION;
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const response = await serve(legacyPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token }));
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: "server version unavailable: NEXT_PUBLIC_APP_VERSION is not set",
      });
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect((await serve(legacyPost({ jsonrpc: "2.0", id: 2, method: "tools/list" }))).status).toBe(401);
      restoreChannel();
      restoreChannel = useMcpChannel({ enabled: "off" });
      expect((await serve(legacyPost({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { token }))).status).toBe(404);
    } finally {
      process.env.NEXT_PUBLIC_APP_VERSION = saved;
      errorLog.mockRestore();
    }
  });
});

describe("the query budget at the route", () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT_QUERY_MAX;
  });

  test("initialize, tools/list, a ping, a list_connections call and a notification each spend one slot", async () => {
    process.env.RATE_LIMIT_QUERY_MAX = "5";
    const bodies = [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          clientInfo: { name: "budget-test", version: "1.0.0" },
        },
      },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "ping" },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "list_connections", arguments: {} } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
    ];
    for (const body of bodies) {
      const response = await serve(legacyPost(body, { token }));
      expect(response.status).not.toBe(429);
      await response.text();
    }
    expect((await serve(legacyPost({ jsonrpc: "2.0", id: 6, method: "tools/list" }, { token }))).status).toBe(429);
  });

  test("GET and DELETE spend nothing, and are still answered once the budget is spent", async () => {
    process.env.RATE_LIMIT_QUERY_MAX = "1";
    const bodiless = (method: string) =>
      serve(
        new Request(MCP_TEST_URL, { method, headers: { host: "localhost:3000", authorization: `Bearer ${token}` } }),
      );
    for (const method of ["GET", "DELETE", "GET"]) expect((await bodiless(method)).status).toBe(405);
    expect((await serve(legacyPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token }))).status).not.toBe(429);
    for (const method of ["GET", "DELETE"]) expect((await bodiless(method)).status).toBe(405);
    expect((await serve(legacyPost({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { token }))).status).toBe(429);
  });
});

const VERSION_REQUIRED =
  "Header mismatch: MCP-Protocol-Version is required on every request after initialize; this server does not serve protocol version 2025-03-26";
const call = (name: string, args: Record<string, unknown>, id: number | string = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});

describe("pre-processing at the route", () => {
  afterEach(() => {
    delete process.env.RATE_LIMIT_QUERY_MAX;
  });

  test("the default client's header-less initialize connects, and every later POST carries the header", async () => {
    const session = await connectClient(serve, { token });
    try {
      const posts = session.http.requests.filter((request) => request.method === "POST");
      expect(posts[0].headers.get("mcp-protocol-version")).toBeNull();
      for (const later of posts.slice(1)) expect(later.headers.get("mcp-protocol-version")).toBe("2025-11-25");
      expect((await session.client.listTools()).tools).toHaveLength(3);
    } finally {
      await session.close();
    }
  });

  test("a header-less legacy tools/call and notifications/initialized get 400 -32020, the notification with the header 202", async () => {
    const refused = await serve(legacyPost(call("list_connections", {}, 9), { token, version: null }));
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ jsonrpc: "2.0", error: { code: -32020, message: VERSION_REQUIRED }, id: 9 });
    const initialized = { jsonrpc: "2.0", method: "notifications/initialized" };
    expect((await serve(legacyPost(initialized, { token, version: null }))).status).toBe(400);
    expect((await serve(legacyPost(initialized, { token }))).status).toBe(202);
  });

  test("a wrong Content-Type spends a slot and gets 415", async () => {
    process.env.RATE_LIMIT_QUERY_MAX = "1";
    const wrong = await serve(
      legacyPost(call("list_connections", {}), { token, headers: { "content-type": "text/plain" } }),
    );
    expect(wrong.status).toBe(415);
    expect((await serve(legacyPost({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { token }))).status).toBe(429);
  });

  test("malformed JSON with a JSON Content-Type gets 400 -32700 and spends a slot", async () => {
    process.env.RATE_LIMIT_QUERY_MAX = "1";
    const malformed = await serve(
      new Request(MCP_TEST_URL, { method: "POST", headers: mcpPostHeaders({ token }), body: "{not json" }),
    );
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error: Invalid JSON" },
      id: null,
    });
    expect((await serve(legacyPost({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { token }))).status).toBe(429);
  });

  test("a batch of any size, one holding a modern claim included, gets the route's 400 -32600 with id null and builds no provider", async () => {
    const connects = countMethod(SQLiteProvider.prototype, "connect");
    try {
      for (const batch of [
        [],
        [{ jsonrpc: "2.0", id: 1, method: "ping" }],
        [
          call("list_connections", {}, 1),
          call("run_read_query", { connection_id: "seed:shop", sql: "SELECT id FROM users" }, 2),
        ],
        [
          {
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
          },
        ],
      ]) {
        const response = await serve(legacyPost(batch, { token }));
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({
          jsonrpc: "2.0",
          error: { code: -32600, message: "Bad Request: JSON-RPC batches are not supported by this endpoint" },
          id: null,
        });
      }
      expect(connects.calls).toBe(0);
    } finally {
      connects.restore();
    }
  });

  test("a batch spends one slot, like every authenticated POST", async () => {
    process.env.RATE_LIMIT_QUERY_MAX = "1";
    expect((await serve(legacyPost([{ jsonrpc: "2.0", id: 1, method: "ping" }], { token }))).status).toBe(400);
    expect((await serve(legacyPost({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { token }))).status).toBe(429);
  });

  test("a body one byte over 4 MiB gets the route's 413 with the SDK's exact body", async () => {
    const response = await serve(
      new Request(MCP_TEST_URL, {
        method: "POST",
        headers: mcpPostHeaders({ token }),
        body: JSON.stringify("x".repeat(4 * 1024 * 1024 - 1)),
      }),
    );
    expect(response.status).toBe(413);
    expect(await response.text()).toBe(
      '{"jsonrpc":"2.0","error":{"code":-32000,"message":"Payload Too Large: Request body must not exceed 4194304 bytes"},"id":null}',
    );
  });

  test("a modern subscriptions/listen gets 404 -32601, and no server is built for it", async () => {
    const registrations = countMethod(McpServer.prototype, "registerTool");
    try {
      const response = await serve(modernPost("subscriptions/listen", {}, { token, id: 4 }));
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        jsonrpc: "2.0",
        error: { code: -32601, message: "Method not found" },
        id: 4,
      });
      expect(registrations.calls).toBe(0);
      // The control: a modern tools/list builds one server, which registers the three tools.
      await readJsonRpc(await serve(modernPost("tools/list", {}, { token })));
      expect(registrations.calls).toBe(3);
    } finally {
      registrations.restore();
    }
  });

  test("a body that is not a JSON-RPC message gets the SDK's 400 -32600", async () => {
    for (const body of [
      { jsonrpc: "2.0", id: { nested: true }, method: "ping" },
      { jsonrpc: "2.0", id: 1 },
      { jsonrpc: "1.0", id: 1, method: "ping" },
    ]) {
      const response = await serve(legacyPost(body, { token }));
      expect(response.status).toBe(400);
      expect(((await readJsonRpc(response)).error as { code: number }).code).toBe(-32600);
    }
  });
});

describe("the standard header rules, through the route", () => {
  async function codeOf(request: Request): Promise<[number, number | undefined]> {
    const response = await serve(request);
    return [response.status, (await readJsonRpc(response)).error?.code];
  }

  test("a modern tools/call without Mcp-Name gets 400 -32020", async () => {
    expect(await codeOf(modernPost("tools/call", { name: "list_connections", arguments: {} }, { token }))).toEqual([
      400, -32020,
    ]);
  });

  test("a modern request without MCP-Protocol-Version gets 400 -32020", async () => {
    const request = modernPost("tools/list", {}, { token, headers: { "mcp-protocol-version": null } });
    expect(await codeOf(request)).toEqual([400, -32020]);
  });

  test("a mismatched Mcp-Method gets 400 -32020", async () => {
    const request = modernPost("tools/list", {}, { token, headers: { "mcp-method": "tools/call" } });
    expect(await codeOf(request)).toEqual([400, -32020]);
  });

  test("an MCP-Protocol-Version that disagrees with the envelope gets 400 -32020", async () => {
    const request = modernPost("tools/list", {}, { token, headers: { "mcp-protocol-version": "2025-11-25" } });
    expect(await codeOf(request)).toEqual([400, -32020]);
  });

  test("an Mcp-Name with an invalid Base64 sentinel gets 400 -32020", async () => {
    const request = modernPost(
      "tools/call",
      { name: "list_connections", arguments: {} },
      { token, name: "=?base64?not base64?=" },
    );
    expect(await codeOf(request)).toEqual([400, -32020]);
  });

  test("a raw Mcp-Name equal to a name outside ASCII gets 400 -32020, and its Base64 form reaches the unknown-tool -32602", async () => {
    const params = { name: "tést", arguments: {} };
    expect(await codeOf(modernPost("tools/call", params, { token, name: "tést" }))).toEqual([400, -32020]);
    expect(await codeOf(modernPost("tools/call", params, { token, name: "=?base64?dMOpc3Q=?=" }))).toEqual([
      200, -32602,
    ]);
  });

  test("a modern request with a null id and every standard header gets 400 -32600", async () => {
    expect(await codeOf(modernPost("tools/list", {}, { token, id: null }))).toEqual([400, -32600]);
  });

  test("a legacy tools/call with only MCP-Protocol-Version is served", async () => {
    const response = await serve(legacyPost(call("list_connections", {}), { token }));
    expect(response.status).toBe(200);
    expect((await readJsonRpc(response)).result).toBeDefined();
  });

  test("an unknown tool gets -32602 on HTTP 200 in both eras", async () => {
    const legacyReply = await readJsonRpc(await serve(legacyPost(call("no_such_tool", {}), { token })));
    expect(legacyReply.error).toMatchObject({ code: -32602, message: "Tool no_such_tool not found" });
    const modernResponse = await serve(
      modernPost("tools/call", { name: "no_such_tool", arguments: {} }, { token, name: "no_such_tool" }),
    );
    expect(modernResponse.status).toBe(200);
    expect((await readJsonRpc(modernResponse)).error).toMatchObject({
      code: -32602,
      message: "Tool no_such_tool not found",
    });
  });

  test("a tools/call without a name gets a JSON-RPC error from the SDK", async () => {
    const nameless = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { arguments: {} } };
    const reply = await readJsonRpc(await serve(legacyPost(nameless, { token })));
    expect(reply.error).toBeDefined();
  });
});

describe("an argument refusal the SDK answers is recorded by the route", () => {
  const mcpEvents = () =>
    getServerAuditBuffer()
      .getAll()
      .filter((event) => event.type === "mcp_operation");

  test.each([
    ["run_read_query", { connection_id: "seed:shop", sql: "SELECT 1", max_rows: 999 }],
    ["inspect_schema", {}],
  ])(
    "%s with invalid arguments writes one decision event, and the client still gets the SDK's Input validation error",
    async (tool, args) => {
      const reply = await readJsonRpc(await serve(legacyPost(call(tool, args), { token })));
      expect(reply.result?.isError).toBe(true);
      expect(JSON.stringify(reply.result?.content)).toContain("Input validation error");
      expect(mcpEvents()).toEqual([
        expect.objectContaining({
          action: tool,
          target: "mcp/decision",
          user: "alice",
          result: "failure",
          reason: "mcp_invalid_arguments",
        }),
      ]);
      expect(mcpEvents()[0].connectionName).toBeUndefined();
    },
  );

  test("a throwing sink leaves the Input validation error unchanged", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {
      throw new Error("audit sink unavailable");
    });
    const errorLog = spyOn(logger, "error").mockImplementation(() => {});
    try {
      const invalid = call("run_read_query", { connection_id: "seed:shop", sql: "SELECT 1", max_rows: 999 });
      const reply = await readJsonRpc(await serve(legacyPost(invalid, { token })));
      expect(JSON.stringify(reply.result?.content)).toContain("Input validation error");
      expect(errorLog).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
      errorLog.mockRestore();
    }
  });

  test("an unknown tool and a call an SDK gate refused write no mcp_operation event", async () => {
    await readJsonRpc(await serve(legacyPost(call("no_such_tool", { max_rows: 999 }), { token })));
    const gated = await serve(
      modernPost("tools/call", { name: "run_read_query", arguments: { max_rows: 999 } }, { token }),
    );
    expect(gated.status).toBe(400);
    expect(mcpEvents()).toEqual([]);
  });

  test.each([
    ["run_read_query", null],
    ["run_read_query", "SELECT 1"],
    ["inspect_schema", []],
    ["list_connections", null],
  ])(
    "%s with arguments %p is refused by the SDK's request schema on HTTP 200, and writes no event for any tool",
    async (tool, args) => {
      const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } };
      const reply = await readJsonRpc(await serve(legacyPost(body, { token })));
      expect(reply.error?.code).toBe(-32602);
      expect(mcpEvents()).toEqual([]);
    },
  );
});
