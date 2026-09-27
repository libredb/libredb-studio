/**
 * The MCP protocol layer (#246), served by the SDK's createMcpHandler and driven by the SDK's
 * own client in process: both eras, the revisions served, the capability objects, GET and
 * DELETE, ping, notifications, and how a cancel reaches a running call.
 *
 * Everything here calls the production handler directly with an identity built in the test;
 * the route's own admission is tested through the route.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { getServerAuditBuffer } from "@/lib/audit";
import { DuckDBProvider } from "@/lib/db/providers/sql/duckdb";
import { logger } from "@/lib/logger";
import {
  APP_VERSION,
  createDuckdbFile,
  createSqliteFile,
  gateMethod,
  pinMcpTestEnvironment,
  resetMcpTestState,
  waitFor,
  writeSeedFile,
} from "../../helpers/mcp-fixtures";
import {
  MCP_TEST_URL,
  connectClient,
  handlerServe,
  legacyPost,
  modernNotification,
  modernPost,
  readJsonRpc,
  testAuthInfo,
} from "../../helpers/mcp-harness";

pinMcpTestEnvironment();

const { mcpHandler, MCP_SERVER_NAME, MCP_INSTRUCTIONS, MCP_SUPPORTED_PROTOCOL_VERSIONS } = await import(
  "@/lib/mcp/server"
);
const { isMcpToolName } = await import("@/lib/mcp/tools");
const ROOT = resolve(import.meta.dir, "../../..");
const serve = handlerServe();
const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-protocol-"));
const SDK_ONERROR = "MCP request refused or failed inside the SDK";

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

beforeEach(() => {
  writeSeedFile(dir, [
    { id: "shop", type: "sqlite", database: join(dir, "shop.db") },
    { id: "slow", type: "duckdb", database: join(dir, "slow.duckdb") },
  ]);
});

afterEach(async () => {
  await resetMcpTestState();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TOOL_NAMES = ["list_connections", "inspect_schema", "run_read_query"];
const legacyInitialize = (protocolVersion: string) =>
  legacyPost(
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion, capabilities: {}, clientInfo: { name: "hand-built-client", version: "1.0.0" } },
    },
    { version: null },
  );

describe("the default legacy client", () => {
  test("connects on 2025-11-25, lists the three tools in registration order and calls one", async () => {
    const warn = spyOn(logger, "warn");
    const session = await connectClient(serve);
    try {
      expect(session.client.getProtocolEra()).toBe("legacy");
      expect(session.client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
      expect((await session.client.listTools()).tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);

      const result = await session.client.callTool({ name: "list_connections", arguments: {} });
      expect(result.isError ?? false).toBe(false);
      expect(JSON.stringify(result.content)).toContain("seed:shop");

      // Its GET after initialize reached the handler and got the SDK's 405, which the client
      // treats as benign; on this happy path the handler's onerror was never called.
      const get = session.http.requests.find((request) => request.method === "GET");
      expect(get).toBeDefined();
      expect(warn.mock.calls.filter(([message]) => message === SDK_ONERROR)).toEqual([]);
    } finally {
      await session.close();
      warn.mockRestore();
    }
  });

  test("that supports only 2025-06-18 negotiates it", async () => {
    const session = await connectClient(serve, { supportedProtocolVersions: ["2025-06-18"] });
    try {
      expect(session.client.getNegotiatedProtocolVersion()).toBe("2025-06-18");
      expect((await session.client.listTools()).tools).toHaveLength(3);
    } finally {
      await session.close();
    }
  });
});

describe("a modern client", () => {
  test.each([
    ["auto", "modern"],
    ["pinned", "modern"],
  ] as const)("negotiating %s connects in the %s era and calls a tool", async (negotiation, era) => {
    const session = await connectClient(serve, { negotiation });
    try {
      expect(session.client.getProtocolEra()).toBe(era);
      const result = await session.client.callTool({ name: "list_connections", arguments: {} });
      expect(JSON.stringify(result.content)).toContain("seed:shop");
    } finally {
      await session.close();
    }
  });
});

describe("the revisions served", () => {
  test("are 2026-07-28 for modern requests, then 2025-11-25 and 2025-06-18 for legacy ones, in that order", () => {
    expect(MCP_SUPPORTED_PROTOCOL_VERSIONS).toEqual(["2026-07-28", "2025-11-25", "2025-06-18"]);
  });

  test.each(["2025-03-26", "2024-11-05"])(
    "an initialize asking for %s gets the counter-offer 2025-11-25",
    async (asked) => {
      const response = await serve(legacyInitialize(asked));
      expect(response.status).toBe(200);
      expect((await readJsonRpc(response)).result?.protocolVersion).toBe("2025-11-25");
    },
  );

  test("a legacy tools/call carrying MCP-Protocol-Version 2025-03-26 gets 400 and -32000", async () => {
    const response = await serve(
      legacyPost({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { version: "2025-03-26" }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32000);
    expect(body.error.message.startsWith("Bad Request: Unsupported protocol version: 2025-03-26")).toBe(true);
  });

  test("server/discover advertises 2026-07-28 alone and names this server", async () => {
    const response = await serve(modernPost("server/discover", {}));
    expect(response.status).toBe(200);
    const result = (await readJsonRpc(response)).result;
    expect(result?.supportedVersions).toEqual(["2026-07-28"]);
    expect(result?._meta?.["io.modelcontextprotocol/serverInfo"]).toMatchObject({
      name: MCP_SERVER_NAME,
      version: APP_VERSION,
    });
    expect(result?.instructions).toBe(MCP_INSTRUCTIONS);
  });
});

describe("the capability objects", () => {
  test("of the legacy initialize and of server/discover are tools.listChanged false and nothing else", async () => {
    const initialize = (await readJsonRpc(await serve(legacyInitialize("2025-11-25")))).result;
    const discover = (await readJsonRpc(await serve(modernPost("server/discover", {})))).result;

    expect(initialize?.capabilities).toEqual({ tools: { listChanged: false } });
    expect(discover?.capabilities).toEqual({ tools: { listChanged: false } });
  });
});

describe("the tool map", () => {
  test("names the three tools and nothing an object inherits, so no other name reaches a tool's schema", () => {
    for (const name of TOOL_NAMES) expect(isMcpToolName(name)).toBe(true);
    for (const name of ["toString", "constructor", "__proto__", "no_such_tool", 42, undefined]) {
      expect(isMcpToolName(name)).toBe(false);
    }
  });
});

describe("notifications", () => {
  test("a legacy notifications/initialized carrying the header gets 202 and an empty body", async () => {
    const response = await serve(legacyPost({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  test("a modern custom notification carrying the 2026-07-28 headers gets 202", async () => {
    const response = await serve(modernNotification("notifications/libredb-test", {}));
    expect(response.status).toBe(202);
  });
});

describe("GET, DELETE and ping", () => {
  test.each(["GET", "DELETE"])("%s gets the SDK's 405 before any server is built", async (method) => {
    const response = await mcpHandler.fetch(
      new Request(MCP_TEST_URL, { method, headers: { accept: "text/event-stream" } }),
      { authInfo: testAuthInfo() },
    );
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed." },
      id: null,
    });
  });

  test("a legacy ping carrying the header gets an empty result", async () => {
    expect((await readJsonRpc(await serve(legacyPost({ jsonrpc: "2.0", id: 5, method: "ping" })))).result).toEqual({});
  });

  test("a modern ping gets 404 and -32601, because 2026-07-28 removed ping", async () => {
    const response = await serve(modernPost("ping", {}));
    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32601);
  });
});

describe("the legacy answer to a tools/call", () => {
  test("is an event stream that proxies must not buffer or transform", async () => {
    const response = await serve(
      legacyPost({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_connections", arguments: {} } }),
    );
    expect(response.headers.get("content-type")).toStartWith("text/event-stream");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");
    expect((await readJsonRpc(response)).id).toBe(3);
  });
});

describe("the server factory", () => {
  test("refuses a request that arrives without a verified identity", async () => {
    const response = await mcpHandler.fetch(legacyPost({ jsonrpc: "2.0", id: 9, method: "tools/list" }));
    expect(response.status).toBe(500);
    expect(((await response.json()) as { error: { code: number } }).error.code).toBe(-32603);
  });

  test("refuses when NEXT_PUBLIC_APP_VERSION is unset, and serves again once it is set", async () => {
    delete process.env.NEXT_PUBLIC_APP_VERSION;
    try {
      expect((await serve(legacyPost({ jsonrpc: "2.0", id: 10, method: "tools/list" }))).status).toBe(500);
    } finally {
      pinMcpTestEnvironment();
    }
    expect((await serve(legacyPost({ jsonrpc: "2.0", id: 11, method: "tools/list" }))).status).toBe(200);
  });
});

describe("a cancel of a running call", () => {
  const slowCall = {
    name: "run_read_query",
    arguments: { connection_id: "seed:slow", sql: "SELECT answer FROM answers" },
  };
  const failedRunEvents = () =>
    getServerAuditBuffer()
      .getAll()
      .filter(
        (event) => event.action === "run_read_query" && event.result === "failure" && event.reason === "mcp_cancelled",
      );

  test("in the modern era reaches the handler through the request's signal, and no answer is delivered", async () => {
    const gate = gateMethod(DuckDBProvider.prototype, "queryReadOnly");
    const session = await connectClient(serve, { negotiation: "auto" });
    try {
      const controller = new AbortController();
      const call = session.client.callTool(slowCall, { signal: controller.signal });
      await gate.entered;
      controller.abort();

      await expect(call).rejects.toThrow();
      await waitFor(() => failedRunEvents().length === 1);
      gate.release();
    } finally {
      gate.release();
      // The held statement runs to its end before afterEach closes the provider under it.
      await gate.finished;
      gate.restore();
      await session.close();
    }
  });

  test("the control: the same call without an abort returns its result", async () => {
    const gate = gateMethod(DuckDBProvider.prototype, "queryReadOnly");
    const session = await connectClient(serve, { negotiation: "auto" });
    try {
      const call = session.client.callTool(slowCall);
      await gate.entered;
      gate.release();

      expect(JSON.stringify((await call).content)).toContain("42");
      expect(failedRunEvents()).toEqual([]);
    } finally {
      gate.restore();
      await session.close();
    }
  });

  test("in the legacy era reaches the handler when the request's signal aborts", async () => {
    const gate = gateMethod(DuckDBProvider.prototype, "queryReadOnly");
    try {
      const controller = new AbortController();
      const response = await serve(
        legacyPost({ jsonrpc: "2.0", id: 4, method: "tools/call", params: slowCall }, { signal: controller.signal }),
      );
      expect(response.headers.get("content-type")).toStartWith("text/event-stream");
      await gate.entered;
      controller.abort();

      await waitFor(() => failedRunEvents().length === 1);
    } finally {
      gate.release();
      // The held statement runs to its end before afterEach closes the provider under it.
      await gate.finished;
      gate.restore();
    }
  });
});

describe("the protocol layer's source", () => {
  test("names no 2024-11-05 revision, and the hand-written dispatcher is gone", () => {
    // One pattern per tree: Bun's glob matches no brace alternative that contains a slash.
    const files: string[] = [];
    for (const pattern of ["src/lib/mcp/**/*.ts", "src/app/api/mcp/**/*.ts"]) {
      // Windows yields backslash-separated paths, and the assertions below name POSIX ones.
      for (const file of new Bun.Glob(pattern).scanSync(ROOT)) files.push(file.replaceAll("\\", "/"));
    }
    // The control: the scan found the protocol layer.
    expect(files).toContain("src/lib/mcp/server.ts");
    expect(files).toContain("src/app/api/mcp/route.ts");
    for (const file of files) expect(readFileSync(join(ROOT, file), "utf8")).not.toContain("2024-11-05");
    expect(existsSync(join(ROOT, "src/lib/mcp/dispatcher.ts"))).toBe(false);
  });
});
