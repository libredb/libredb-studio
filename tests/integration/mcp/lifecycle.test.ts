/**
 * What the MCP server promises about its lifecycle (#246), through the route with a token minted at
 * run time: one McpServer for each request the SDK serves and none for a request refused before
 * it; one provider for concurrent first calls on one connection and profile; no deprecated feature
 * used (logging, sampling, roots); one source for the server's version; and a handler that still
 * serves after every earlier test has torn down.
 *
 * Servers are counted by McpServer.prototype.registerTool, which the factory calls three times per
 * server; providers by the real SQLite provider's connect.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SdkErrorCode, SdkHttpError } from "@modelcontextprotocol/client";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import * as route from "@/app/api/mcp/route";
import { SQLiteProvider } from "@/lib/db/providers/sql/sqlite";
import {
  APP_VERSION,
  countMethod,
  createSqliteFile,
  gateMethod,
  holdGate,
  pinMcpTestEnvironment,
  resetMcpTestState,
  waitFor,
  writeSeedFile,
} from "../../helpers/mcp-fixtures";
import {
  connectClient,
  legacyPost,
  mcpPostHeaders,
  MCP_TEST_URL,
  modernPost,
  readJsonRpc,
  routeServe,
  type ServeRequest,
} from "../../helpers/mcp-harness";
import { mintTestToken, useMcpChannel } from "../../helpers/mcp-token";

pinMcpTestEnvironment();

const ROOT = resolve(import.meta.dir, "../../..");
const serve = routeServe(route);
const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-lifecycle-"));
let token = "";
let restoreChannel: () => void = () => {};

beforeAll(() => {
  createSqliteFile(join(dir, "shop.db"), [
    "CREATE TABLE numbers (id INTEGER PRIMARY KEY)",
    "INSERT INTO numbers VALUES (1), (2), (3)",
  ]);
});

beforeEach(async () => {
  restoreChannel = useMcpChannel();
  token = await mintTestToken();
  writeSeedFile(dir, [{ id: "shop", type: "sqlite", database: join(dir, "shop.db") }]);
});

afterEach(async () => {
  restoreChannel();
  delete process.env.RATE_LIMIT_QUERY_MAX;
  await resetMcpTestState();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const runQuery = (id: number) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name: "run_read_query", arguments: { connection_id: "seed:shop", sql: "SELECT id FROM numbers" } },
});

async function serversBuiltBy(send: () => Promise<Response>): Promise<number> {
  const registrations = countMethod(McpServer.prototype, "registerTool");
  try {
    const response = await send();
    await response.text();
    return registrations.calls / 3;
  } finally {
    registrations.restore();
  }
}

describe("one server per served request", () => {
  test("a served request builds exactly one server", async () => {
    expect(
      await serversBuiltBy(() => serve(legacyPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token }))),
    ).toBe(1);
    expect(await serversBuiltBy(() => serve(modernPost("tools/list", {}, { token })))).toBe(1);
  });

  test.each<[string, () => Request | Promise<Request>, () => void]>([
    [
      "a 403 Origin refusal",
      () =>
        legacyPost(
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          { token, headers: { origin: "http://evil.example" } },
        ),
      () => {},
    ],
    ["a 401", () => legacyPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }), () => {}],
    [
      "a 404 while MCP is off",
      () => legacyPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token }),
      () => {
        restoreChannel();
        restoreChannel = useMcpChannel({ enabled: "off" });
      },
    ],
    [
      "a 415",
      () =>
        legacyPost(
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          { token, headers: { "content-type": "text/plain" } },
        ),
      () => {},
    ],
    [
      "a 413",
      () =>
        new Request(MCP_TEST_URL, {
          method: "POST",
          headers: mcpPostHeaders({ token }),
          body: JSON.stringify("x".repeat(4 * 1024 * 1024)),
        }),
      () => {},
    ],
    ["a 400 batch", () => legacyPost([], { token }), () => {}],
    [
      "a -32020 from pre-processing",
      () => legacyPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token, version: null }),
      () => {},
    ],
    [
      "a -32020 from the SDK's header rung",
      () => modernPost("tools/list", {}, { token, headers: { "mcp-method": "tools/call" } }),
      () => {},
    ],
    [
      "a -32022 for a revision this server does not serve",
      () =>
        new Request(MCP_TEST_URL, {
          method: "POST",
          headers: mcpPostHeaders({
            token,
            headers: { "mcp-protocol-version": "2099-01-01", "mcp-method": "tools/list" },
          }),
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {
              _meta: {
                "io.modelcontextprotocol/protocolVersion": "2099-01-01",
                "io.modelcontextprotocol/clientCapabilities": {},
              },
            },
          }),
        }),
      () => {},
    ],
    ["a 405", () => new Request(MCP_TEST_URL, { method: "GET", headers: mcpPostHeaders({ token }) }), () => {}],
  ])("%s builds none", async (_name, build, arrange) => {
    arrange();
    const request = await build();
    expect(await serversBuiltBy(() => serve(request))).toBe(0);
  });

  test("a 429 builds none", async () => {
    process.env.RATE_LIMIT_QUERY_MAX = "1";
    await (await serve(legacyPost({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { token }))).text();
    expect(
      await serversBuiltBy(() => serve(legacyPost({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { token }))),
    ).toBe(0);
  });

  test("tools/list builds no provider, and answers the registration order every time", async () => {
    const connects = countMethod(SQLiteProvider.prototype, "connect");
    try {
      const replies = await Promise.all(
        [1, 2].map(async (id) =>
          readJsonRpc(await serve(legacyPost({ jsonrpc: "2.0", id, method: "tools/list" }, { token }))),
        ),
      );
      for (const reply of replies) {
        expect(reply.result?.tools.map((tool: { name: string }) => tool.name)).toEqual([
          "list_connections",
          "inspect_schema",
          "run_read_query",
        ]);
      }
      expect(connects.calls).toBe(0);
    } finally {
      connects.restore();
    }
  });
});

describe("one provider per connection and profile", () => {
  test("twelve concurrent run_read_query requests with connect held construct one provider, and all twelve succeed", async () => {
    const gate = gateMethod(SQLiteProvider.prototype, "connect");
    try {
      const calls = Array.from({ length: 12 }, (_, index) => serve(legacyPost(runQuery(index + 1), { token })));
      await gate.entered;
      await holdGate();
      expect(gate.calls).toBe(1);
      gate.release();
      const replies = await Promise.all(calls.map(async (call) => readJsonRpc(await call)));
      expect(replies.every((reply) => reply.result?.isError !== true)).toBe(true);
      expect(gate.calls).toBe(1);
    } finally {
      gate.release();
      gate.restore();
    }
  });

  test("inspect_schema and run_read_query on one connection construct two providers, one per profile", async () => {
    const connects = countMethod(SQLiteProvider.prototype, "connect");
    try {
      await readJsonRpc(await serve(legacyPost(runQuery(1), { token })));
      await readJsonRpc(
        await serve(
          legacyPost(
            {
              jsonrpc: "2.0",
              id: 2,
              method: "tools/call",
              params: { name: "inspect_schema", arguments: { connection_id: "seed:shop" } },
            },
            { token },
          ),
        ),
      );
      expect(connects.calls).toBe(2);
    } finally {
      connects.restore();
    }
  });
});

describe("the in-process clients", () => {
  test.each(["legacy", "auto"] as const)(
    "the %s client calls list_connections and run_read_query through the route",
    async (negotiation) => {
      const session = await connectClient(serve, { negotiation, token });
      try {
        expect((await session.client.callTool({ name: "list_connections", arguments: {} })).isError ?? false).toBe(
          false,
        );
        const query = await session.client.callTool({
          name: "run_read_query",
          arguments: { connection_id: "seed:shop", sql: "SELECT id FROM numbers" },
        });
        expect(query.isError ?? false).toBe(false);
        const refused = await session.client.callTool({
          name: "run_read_query",
          arguments: { connection_id: "seed:shop", sql: "DROP TABLE numbers" },
        });
        expect(refused.isError).toBe(true);
      } finally {
        await session.close();
      }
    },
  );

  test.each([
    ["legacy", SdkErrorCode.ClientHttpNotImplemented],
    ["auto", SdkErrorCode.ClientHttpAuthentication],
  ] as const)(
    "a %s client without a token fails to connect with an SDK HTTP error of status 401",
    async (negotiation, code) => {
      const error = await connectClient(serve, { negotiation }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SdkHttpError);
      expect((error as SdkHttpError).status).toBe(401);
      expect((error as SdkHttpError).code).toBe(code);
    },
  );
});

describe("no deprecated feature", () => {
  test("a legacy logging/setLevel gets a JSON-RPC error", async () => {
    const reply = await readJsonRpc(
      await serve(
        legacyPost({ jsonrpc: "2.0", id: 1, method: "logging/setLevel", params: { level: "debug" } }, { token }),
      ),
    );
    expect(reply.error).toBeDefined();
  });

  test("a full tool flow sends a client that declares sampling and roots no sampling or roots request", async () => {
    const session = await connectClient(serve, { token, capabilities: { sampling: {}, roots: {} } });
    let serverRequests = 0;
    session.client.setRequestHandler("sampling/createMessage", async () => {
      serverRequests += 1;
      return { model: "test-model", role: "assistant" as const, content: { type: "text" as const, text: "unused" } };
    });
    session.client.setRequestHandler("roots/list", async () => {
      serverRequests += 1;
      return { roots: [] };
    });
    try {
      await session.client.callTool({ name: "list_connections", arguments: {} });
      await session.client.callTool({
        name: "run_read_query",
        arguments: { connection_id: "seed:shop", sql: "SELECT id FROM numbers" },
      });
      await session.client.callTool({ name: "inspect_schema", arguments: { connection_id: "seed:shop" } });
      expect(serverRequests).toBe(0);
    } finally {
      await session.close();
    }
  });

  test("the control: a handler built only here does send sampling/createMessage, and the same client receives it", async () => {
    const controlHandler = createMcpHandler(
      () => {
        const server = new McpServer({ name: "sampling-control", version: "1.0.0" }, { capabilities: { tools: {} } });
        server.registerTool("ask", { inputSchema: z.object({}) }, async (_args, ctx) => {
          // requestSampling does not tie itself to the tools/call it runs inside; without
          // relatedRequestId the stateless transport routes it to a standalone stream that does
          // not exist, and the client never sees it.
          await ctx.mcpReq.requestSampling(
            { messages: [{ role: "user", content: { type: "text", text: "hello" } }], maxTokens: 5 },
            { relatedRequestId: ctx.mcpReq.id },
          );
          return { content: [{ type: "text", text: "asked" }] };
        });
        return server;
      },
      { legacy: "stateless" },
    );
    const controlServe: ServeRequest = (request) => controlHandler.fetch(request);
    const session = await connectClient(controlServe, { capabilities: { sampling: {} } });
    let received = 0;
    session.client.setRequestHandler("sampling/createMessage", async () => {
      received += 1;
      return { model: "test-model", role: "assistant" as const, content: { type: "text" as const, text: "hi" } };
    });
    const controller = new AbortController();
    const call = session.client.callTool({ name: "ask", arguments: {} }, { signal: controller.signal });
    void call.catch(() => {});
    try {
      await waitFor(() => received === 1);
    } finally {
      // The abort reaches the server through the request's signal, which tears the legacy pair
      // down, so the blocked tool ends before the client and the handler close.
      controller.abort();
      await session.client.close();
      await controlHandler.close();
    }
  });
});

describe("the SDK rules every tool relies on", () => {
  test("a result that violates its output schema becomes an Output validation error", async () => {
    const controlHandler = createMcpHandler(
      () => {
        const server = new McpServer({ name: "output-control", version: "1.0.0" }, { capabilities: { tools: {} } });
        server.registerTool(
          "broken",
          { inputSchema: z.object({}), outputSchema: z.object({ count: z.number() }) },
          async () => ({ content: [{ type: "text", text: "{}" }], structuredContent: { count: "not a number" } }),
        );
        return server;
      },
      { legacy: "stateless" },
    );
    const session = await connectClient((request) => controlHandler.fetch(request));
    try {
      const result = await session.client.callTool({ name: "broken", arguments: {} });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("Output validation error");
    } finally {
      await session.close();
      await controlHandler.close();
    }
  });

  test("every JSON-RPC error code this server writes is one the design allows, and -32000 only in the SDK's two copies", () => {
    const allowed = new Set(["-32700", "-32600", "-32601", "-32602", "-32603", "-32020", "-32000"]);
    const files = [
      ...new Bun.Glob("src/lib/mcp/**/*.ts").scanSync(ROOT),
      ...new Bun.Glob("src/app/api/mcp/**/*.ts").scanSync(ROOT),
    ];
    for (const file of files) {
      for (const [code] of readFileSync(join(ROOT, file), "utf8").matchAll(/-32\d{3}/g)) {
        expect(allowed.has(code)).toBe(true);
        if (code === "-32000") expect(file.replaceAll("\\", "/")).toBe("src/lib/mcp/preprocess.ts");
      }
    }
  });
});

describe("one version source", () => {
  test("the legacy InitializeResult, server/discover and a modern tools/call report package.json's version", async () => {
    const initialize = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "version-test", version: "1.0.0" },
      },
    };
    const legacyInit = (await readJsonRpc(await serve(legacyPost(initialize, { token, version: null })))).result;
    expect(legacyInit?.serverInfo.version).toBe(APP_VERSION);
    const discover = (await readJsonRpc(await serve(modernPost("server/discover", {}, { token })))).result;
    expect(discover?._meta?.["io.modelcontextprotocol/serverInfo"]?.version).toBe(APP_VERSION);
    const modernCall = (
      await readJsonRpc(
        await serve(
          modernPost("tools/call", { name: "list_connections", arguments: {} }, { token, name: "list_connections" }),
        ),
      )
    ).result;
    expect(modernCall?._meta?.["io.modelcontextprotocol/serverInfo"]?.version).toBe(APP_VERSION);
  });

  test("a legacy tools/call carries no server identity", async () => {
    const legacyCall = (
      await readJsonRpc(
        await serve(
          legacyPost(
            { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_connections", arguments: {} } },
            { token },
          ),
        ),
      )
    ).result;
    expect(legacyCall?._meta?.["io.modelcontextprotocol/serverInfo"]).toBeUndefined();
  });

  test("no MCP source file writes a version literal or the old contract comment", () => {
    const files = [
      ...new Bun.Glob("src/lib/mcp/**/*.ts").scanSync(ROOT),
      ...new Bun.Glob("src/app/api/mcp/**/*.ts").scanSync(ROOT),
    ];
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source).not.toMatch(/["'`]\d+\.\d+\.\d+["'`]/);
      expect(source).not.toContain("Contract 0.16");
    }
  });
});

describe("the module-scope handler", () => {
  test("still serves after every earlier test in this file has torn down its clients", async () => {
    const response = await serve(legacyPost({ jsonrpc: "2.0", id: 99, method: "tools/list" }, { token }));
    expect(response.status).toBe(200);
    expect((await readJsonRpc(response)).result?.tools).toHaveLength(3);
  });
});
