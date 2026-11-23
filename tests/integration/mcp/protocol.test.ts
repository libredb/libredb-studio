/**
 * The MCP protocol layer (#246), served by the SDK's createMcpHandler and driven by the SDK's
 * own client in process: both eras, the revisions served, the capability objects, GET and
 * DELETE, ping, notifications, how a cancel reaches a running call, and the cells of an answer
 * as a client reads them.
 *
 * Everything here calls the production handler directly with an identity built in the test;
 * the route's own admission is tested through the route.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeValue, MAX_VALUE_DEPTH } from "@libredb/provider-sdk/values";
import { getServerAuditBuffer } from "@/lib/audit";
import { providerAuthor } from "@/lib/db/operations/provider-text";
import { DuckDBProvider } from "@/lib/db/providers/sql/duckdb";
import type { QueryResult } from "@/lib/types";
import { logger } from "@/lib/logger";
import { databaseContentNotice, MCP_CELL_FORM, MCP_CELL_REFUSED_PREFIX } from "@/lib/mcp/output";
import { listedStatementArms } from "@/lib/mcp/tools/statement-arms";
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
import { listedMcpToolNames, registeredMcpToolNames } from "../../helpers/mcp-tool-names";

pinMcpTestEnvironment();

const { mcpHandler, mcpListHandler, MCP_SERVER_NAME, MCP_INSTRUCTIONS, MCP_SUPPORTED_PROTOCOL_VERSIONS } = await import(
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
    "CREATE TABLE blobs (data BLOB)",
    "INSERT INTO blobs VALUES (x'00ff10')",
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

const TOOL_NAMES = registeredMcpToolNames();
/** The admin token's list: this file seeds a SQLite and a DuckDB connection offered to admins. */
const LISTED = listedMcpToolNames(new Set(["sqlite", "duckdb"]));
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
  test("connects on 2025-11-25, lists the tools in registration order and calls one", async () => {
    const warn = spyOn(logger, "warn");
    const session = await connectClient(serve);
    try {
      expect(session.client.getProtocolEra()).toBe("legacy");
      expect(session.client.getNegotiatedProtocolVersion()).toBe("2025-11-25");
      const listed = (await session.client.listTools()).tools.map((tool) => tool.name);
      expect(listed).toEqual(LISTED);
      // The wire order against the records themselves: the metadata tools first, then each serving arm in record order.
      expect(listed.slice(0, 2)).toEqual(["list_connections", "inspect_schema"]);
      expect(listed.slice(2)).toEqual(listedStatementArms(new Set(["sqlite", "duckdb"])).map((arm) => arm.tool));

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
      expect((await session.client.listTools()).tools).toHaveLength(LISTED.length);
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
  test("names the tools and nothing an object inherits, so no other name reaches a tool's schema", () => {
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

  test("the list handler refuses a tools/list that arrives without a verified identity", async () => {
    const response = await mcpListHandler.fetch(legacyPost({ jsonrpc: "2.0", id: 9, method: "tools/list" }));
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

describe("an error answer's record", () => {
  const clients: [string, Parameters<typeof connectClient>[1]][] = [
    ["default legacy (2025-11-25)", {}],
    ["2025-06-18 only", { supportedProtocolVersions: ["2025-06-18"] }],
    ["modern pinned (2026-07-28)", { negotiation: "pinned" }],
  ];

  test.each(clients)("a %s client reads a failure's record in structuredContent", async (_label, options) => {
    const session = await connectClient(serve, options);
    try {
      const result = await session.client.callTool({
        name: "run_read_query",
        arguments: { connection_id: "seed:shop", sql: "SELECT id FROM no_such_table" },
      });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        error: { kind: "query", code: "QUERY_ERROR", outcome: "unknown" },
      });
    } finally {
      await session.close();
    }
  });

  test.each(clients)(
    "a %s client reads no record on a refusal Studio makes with no failure",
    async (_label, options) => {
      const session = await connectClient(serve, options);
      try {
        const result = await session.client.callTool({
          name: "run_read_query",
          arguments: { connection_id: "seed:no-such-connection", sql: "SELECT 1" },
        });
        expect(result.isError).toBe(true);
        expect(result.structuredContent).toBeUndefined();
      } finally {
        await session.close();
      }
    },
  );
});

describe("the cells of an answer", () => {
  /** One run_read_query call through the SDK's own client, answered as the client reads it. */
  const callRows = async (connection: string, sql: string, extra: Record<string, unknown> = {}) => {
    const session = await connectClient(serve);
    try {
      return await session.client.callTool({
        name: "run_read_query",
        arguments: { connection_id: connection, sql, ...extra },
      });
    } finally {
      await session.close();
    }
  };

  /** Runs `run` while DuckDB's queryReadOnly answers `rows`, as a driver that hands those values would. */
  const withDuckdbRows = async <T>(rows: Record<string, unknown>[], run: () => Promise<T>): Promise<T> => {
    const original = DuckDBProvider.prototype.queryReadOnly;
    DuckDBProvider.prototype.queryReadOnly = async (): Promise<QueryResult> => ({
      rows,
      fields: Object.keys(rows[0]),
      rowCount: rows.length,
      executionTime: 1,
    });
    try {
      return await run();
    } finally {
      DuckDBProvider.prototype.queryReadOnly = original;
    }
  };

  const lastRunEvent = () =>
    getServerAuditBuffer()
      .getAll()
      .filter((event) => event.action === "run_read_query")
      .at(-1);

  test("a real SQLite BLOB and infinite REAL reach the client as bytes and nf tagged values", async () => {
    const result = await callRows("seed:shop", "SELECT data, 1e999 AS p, -1e999 AS n FROM blobs");
    expect(result.isError ?? false).toBe(false);
    const rows = (result.structuredContent as { rows: unknown }).rows;
    expect(rows).toEqual([
      { data: { $: "bytes", v: "AP8Q" }, p: { $: "nf", v: "Infinity" }, n: { $: "nf", v: "-Infinity" } },
    ]);
    const content = result.content as { type: string; text: string }[];
    expect(content[1].text).toBe(JSON.stringify(result.structuredContent));
    expect(decodeValue(rows)).toEqual([
      { data: new Uint8Array([0, 255, 16]), p: Number.POSITIVE_INFINITY, n: Number.NEGATIVE_INFINITY },
    ]);
  });

  test("a row whose columns are exactly $ and v reaches the client in the obj escape", async () => {
    const result = await callRows("seed:shop", `SELECT 'i64' AS "$", '9' AS v`);
    expect(result.isError ?? false).toBe(false);
    const rows = (result.structuredContent as { rows: unknown }).rows;
    expect(rows).toEqual([{ $: "obj", v: { $: "i64", v: "9" } }]);
    expect(decodeValue(rows)).toEqual([{ $: "i64", v: "9" }]);
  });

  test("every tag reaches the client as the codec writes it, and decodes to the value the provider handed", async () => {
    const row = {
      big: BigInt("9007199254740993"),
      at: new Date("2026-09-20T21:00:00.000Z"),
      u8: new Uint8Array([1, 2]),
      buf: Buffer.from([0, 255]),
      nan: Number.NaN,
      negzero: -0,
      doc: { a: [1, { b: new Date(0) }] },
      lookalike: { $: "x", v: 1 },
      absent: undefined,
    };
    const result = await withDuckdbRows([row], () => callRows("seed:slow", "SELECT answer FROM answers"));
    expect(result.isError ?? false).toBe(false);
    const rows = (result.structuredContent as { rows: unknown }).rows;
    expect(rows).toEqual([
      {
        big: { $: "i64", v: "9007199254740993" },
        at: { $: "ts", v: "2026-09-20T21:00:00.000Z" },
        u8: { $: "bytes", v: "AQI=" },
        buf: { $: "bytes", v: "AP8=" },
        nan: { $: "nf", v: "NaN" },
        negzero: 0,
        doc: { a: [1, { b: { $: "ts", v: "1970-01-01T00:00:00.000Z" } }] },
        lookalike: { $: "obj", v: { $: "x", v: 1 } },
      },
    ]);
    expect(Object.keys((rows as object[])[0])).not.toContain("absent");
    expect(decodeValue(rows)).toEqual([
      {
        big: BigInt("9007199254740993"),
        at: new Date("2026-09-20T21:00:00.000Z"),
        u8: new Uint8Array([1, 2]),
        buf: new Uint8Array([0, 255]),
        nan: Number.NaN,
        negzero: 0,
        doc: { a: [1, { b: new Date(0) }] },
        lookalike: { $: "x", v: 1 },
      },
    ]);
  });

  class Point {
    constructor(
      readonly x: number,
      readonly y: number,
    ) {}
  }
  class Stamp {
    toJSON(): string {
      return "stamp-text";
    }
  }
  const outsideTheCodec: [string, () => unknown, string][] = [
    ["a class instance", () => new Point(1, 2), "an instance of the class Point"],
    ["a class instance with toJSON", () => new Stamp(), "an instance of the class Stamp"],
    ["a typed array other than bytes", () => new Float32Array([0.5]), "a Float32Array"],
    ["a Map", () => new Map(), "a Map"],
    ["an invalid Date", () => new Date(Number.NaN), "an invalid Date"],
  ];

  /** The refusal of an answer whose cell at `path` is `kind`: the notice, the prefix and the codec's sentence, and the record. */
  const expectRefused = (result: Awaited<ReturnType<typeof callRows>>, kind: string, path: string) => {
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: "text", text: databaseContentNotice(providerAuthor("duckdb")) },
      { type: "text", text: `${MCP_CELL_REFUSED_PREFIX}The value codec cannot encode ${kind}, at "${path}".` },
    ]);
    expect(result.structuredContent).toEqual({
      error: { kind: "internal", code: "INTERNAL_ERROR", outcome: "unknown" },
    });
    expect(lastRunEvent()).toMatchObject({ result: "failure", reason: "mcp_execution_failed" });
  };

  test("a class instance, with or without toJSON, a typed array, a Map and an invalid Date each refuse the answer by name behind the notice, with its record", async () => {
    for (const [, make, kind] of outsideTheCodec) {
      // oxlint-disable-next-line no-await-in-loop -- each case swaps the DuckDB prototype's rows and reads the last audit event, so the cases run one at a time.
      const result = await withDuckdbRows([{ c: make() }], () => callRows("seed:slow", "SELECT answer FROM answers"));
      expectRefused(result, kind, "/0/c");
    }
  });

  test("a document nested deeper than MAX_VALUE_DEPTH refuses the answer by the depth rule", async () => {
    let doc: unknown = 1;
    for (let level = 0; level < 300; level++) doc = { a: doc };
    const result = await withDuckdbRows([{ c: doc }], () => callRows("seed:slow", "SELECT answer FROM answers"));
    // The rows and the row are the first two of the arrays and objects the bound counts.
    expectRefused(
      result,
      `a value nested deeper than ${MAX_VALUE_DEPTH} arrays and objects`,
      `/0/c${"/a".repeat(MAX_VALUE_DEPTH - 2)}`,
    );
  });

  test("a value in a row past max_rows is never encoded", async () => {
    const rows = [{ c: 1 }, { c: new Point(1, 2) }, { c: 3 }];
    const result = await withDuckdbRows(rows, () =>
      callRows("seed:slow", "SELECT answer FROM answers", { max_rows: 1 }),
    );
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent).toMatchObject({ rows: [{ c: 1 }], row_count: 1, truncated_by: "max_rows" });
  });

  test.each([
    ["default legacy (2025-11-25)", {}],
    ["modern pinned (2026-07-28)", { negotiation: "pinned" }],
  ] as [string, Parameters<typeof connectClient>[1]][])(
    "tools/list states the cell form on the statement tools' rows (%s)",
    async (_label, options) => {
      const session = await connectClient(serve, options);
      try {
        const tools = (await session.client.listTools()).tools;
        const tool = tools.find((listed) => listed.name === "run_read_query");
        const rows = (tool?.outputSchema?.properties as Record<string, { description?: string }> | undefined)?.rows;
        expect(rows?.description).toBe(MCP_CELL_FORM);
      } finally {
        await session.close();
      }
    },
  );
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
