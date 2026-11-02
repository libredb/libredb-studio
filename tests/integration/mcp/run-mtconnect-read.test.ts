/**
 * run_mtconnect_read: MCP's mtconnectread arm, run by the statement core over the real MTConnect provider, through the
 * real route, seed file and handler, with a transport stand-in that answers the compose fixture's own captures
 * (`tests/fixtures/mtconnect/`, taken from `mtconnect/agent:2.8.0.4`) in place of an agent.
 *
 * The provider is the one the factory would hand out, built here only so its transport is the stand-in: the agent
 * read-only profile opens it under `readOnly` and `sendsStatements`, which `queryReadOnly` refuses without, and every
 * other profile does not. The line is the agent's own, read and admitted by the agent's own mtconnectread adapter: a
 * read sends `GET /probe` and then one GET of a route of the closed table, and answers behind the untrusted-content
 * notice with the agent's adapter connections left out; a PUT, a POST, `/cancel`, a streaming parameter and a second
 * line are refused before anything is acquired; a path value only a withheld item holds is refused after the model
 * read, in the same words as a value no item holds; a read past the row budget is refused with the language's own
 * advice; a timeout and a client cancel end the wait, and the provider's own budget, the time left, ends the read.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { languageServer } from "@/lib/agent/languages/server";
import { getServerAuditBuffer } from "@/lib/audit";
import type { ExecutionProfile } from "@/lib/db/factory";
import { TransportError, type NodeRequest, type NodeResponse, type NodeTransport } from "@/lib/db/http/node-transport";
import { MTConnectProvider } from "@/lib/db/providers/industrial/mtconnect/index";
import { MTC_ROUTES } from "@/lib/db/providers/industrial/mtconnect/routes";
import { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_CANCELLED_TEXT, MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { timeoutText } from "@/lib/mcp/tools/read-query-limits";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseConnection } from "@/lib/types";
import { pinMcpTestEnvironment, resetMcpTestState, waitFor, writeSeedFile } from "../../helpers/mcp-fixtures";
import { connectClient, handlerServe, testAuthInfo } from "../../helpers/mcp-harness";

pinMcpTestEnvironment();

const FIXTURES = join(import.meta.dir, "..", "..", "fixtures", "mtconnect");
const capture = (name: string): string => readFileSync(join(FIXTURES, `${name}.xml`), "utf8");

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-mtconnect-"));
const serve = handlerServe(testAuthInfo());
const server = languageServer("mtconnectread");
const RUN_MTCONNECT_READ_ARM = mcpStatementArm("run_mtconnect_read");
const LATHE = "LIBREDB-LATHE-1722";
/** The adapter's address as the agent writes it into its own Agent device, which no MCP answer may carry. */
const ADAPTER = /mtconnect-adapter/i;
const LATHE_SEED = { id: "lathe", type: "mtconnect", host: "127.0.0.1", port: 17322 };

/** A page of the buffer holding `count` observations of the lathe's X position, one past the row budget at 1001. */
function sampleOf(count: number): string {
  const observations = Array.from(
    { length: count },
    (_, index) =>
      `<Position dataItemId="x1722-pos" name="Xposition" sequence="${index + 1}" subType="ACTUAL" timestamp="2026-10-14T23:58:21.027Z">${index}</Position>`,
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><MTConnectStreams xmlns="urn:mtconnect.org:MTConnectStreams:2.0"><Header creationTime="2026-10-14T23:58:36Z" instanceId="1" version="2.8.0.4" bufferSize="131072" nextSequence="${count + 1}" firstSequence="1" lastSequence="${count}"/><Streams><DeviceStream name="${LATHE}" uuid="LIBREDB-1722"><ComponentStream component="Linear" name="X" componentId="x1722"><Samples>${observations}</Samples></ComponentStream></DeviceStream></Streams></MTConnectStreams>`;
}

/** A request that waits until its own signal ends it, recording when it did. */
let endedAt: number | null = null;
const hang = (request: NodeRequest) =>
  new Promise<NodeResponse>((_resolve, reject) => {
    request.signal.addEventListener(
      "abort",
      () => {
        endedAt = Date.now();
        reject(new TransportError("aborted", "aborted"));
      },
      { once: true },
    );
  });

type Answer = string | ((request: NodeRequest) => Promise<NodeResponse>);

const ANSWERS: Readonly<Record<string, Answer>> = Object.freeze({
  "/probe": capture("probe"),
  "/current": capture("current"),
  [`/${LATHE}/current`]: capture("current"),
  "/sample?count=-5": capture("sample-count-minus"),
  "/sample?count=1000": sampleOf(1_001),
  "/sample?count=7": hang,
  "/assets": capture("assets"),
  "/asset/TOOL-1722": capture("asset-tool"),
});

let recorded: NodeRequest[] = [];
/** Whether the next acquisition hands out a provider opened under the profile it asked for, or an editor's. */
let honourProfile = true;

function standIn(): NodeTransport {
  return {
    async request(request: NodeRequest): Promise<NodeResponse> {
      recorded.push(request);
      const url = new URL(request.url);
      const answer = ANSWERS[`${url.pathname}${url.search}`];
      if (answer === undefined) throw new Error(`the stand-in holds no answer for ${url.pathname}${url.search}`);
      if (typeof answer === "function") return answer(request);
      return { status: 200, contentType: "application/xml", retryAfter: null, text: answer };
    },
    close() {},
  };
}

/** The factory's provider, with only its transport replaced: opened to send statements for agent-read-only alone. */
async function acquireOver(connection: ManagedConnection, profile: ExecutionProfile): Promise<MTConnectProvider> {
  const agent = honourProfile && profile === "agent-read-only";
  const provider = new MTConnectProvider(
    connection as DatabaseConnection,
    {},
    agent ? { readOnly: true, sendsStatements: true } : {},
    () => standIn(),
  );
  await provider.connect();
  return provider;
}

/** Each route of the table as a pattern over a request path, a parameter being one encoded segment. */
const ROUTE_PATTERNS = MTC_ROUTES.map((route) => new RegExp(`^/${route.template.replace(/\{[A-Za-z]+\}/g, "[^/]+")}$`));

beforeEach(() => {
  recorded = [];
  endedAt = null;
  honourProfile = true;
  writeSeedFile(dir, [LATHE_SEED, { id: "shop", type: "sqlite", database: join(dir, "absent.db") }]);
  spyOn(McpConnectionContext.prototype, "acquire").mockImplementation(acquireOver);
});

afterEach(async () => {
  // Whatever a case did, every request MCP made the provider send was a GET of a route of the table, with no body.
  for (const request of recorded) {
    expect(request.method).toBe("GET");
    expect(ROUTE_PATTERNS.some((pattern) => pattern.test(new URL(request.url).pathname))).toBe(true);
    expect(request.body).toBeUndefined();
    expect(request.form).toBeUndefined();
  }
  mock.restore();
  await resetMcpTestState();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Answered {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, any>;
}

async function call(name: string, args: Record<string, unknown>): Promise<Answered> {
  const session = await connectClient(serve, { negotiation: "legacy" });
  try {
    return (await session.client.callTool({ name, arguments: args })) as Answered;
  } finally {
    await session.close();
  }
}

const mtconnect = (statement: string, extra: Record<string, unknown> = {}) =>
  call("run_mtconnect_read", { connection_id: "seed:lathe", statement, ...extra });

/** The request lines the stand-in saw, as `METHOD path?query`. */
const lines = (): string[] =>
  recorded.map((request) => {
    const url = new URL(request.url);
    return `${request.method} ${url.pathname}${url.search}`;
  });

const mcpEvents = () =>
  getServerAuditBuffer()
    .getAll()
    .filter((event) => event.type === "mcp_operation");

describe("the tool", () => {
  test("is listed read-only, with the statement schema and no offset or database", async () => {
    const session = await connectClient(serve, { negotiation: "legacy" });
    try {
      const tools = (await session.client.listTools()).tools;
      const tool = tools.find((candidate) => candidate.name === "run_mtconnect_read");
      expect(tool?.description).toBe(RUN_MTCONNECT_READ_ARM.description);
      expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
      expect(Object.keys(tool?.inputSchema.properties ?? {})).toEqual([
        "connection_id",
        "statement",
        "max_rows",
        "timeout_ms",
      ]);
    } finally {
      await session.close();
    }
  });

  test("describes MTConnect as the engine it runs on", () => {
    expect(RUN_MTCONNECT_READ_ARM.engines).toBe("MTConnect");
  });

  test("list_connections names it as the MTConnect connection's read tool", async () => {
    const result = await call("list_connections", {});
    const connections = (result.structuredContent?.connections ?? []) as Array<{
      id: string;
      read_tool: string | null;
    }>;
    expect(connections.map((connection) => [connection.id, connection.read_tool])).toEqual([
      ["seed:lathe", "run_mtconnect_read"],
      ["seed:shop", "run_read_query"],
    ]);
  });
});

describe("a read", () => {
  test("/current answers its rows behind the notice, the adapter connections left out, recorded under the tool", async () => {
    const result = await mtconnect("/current");
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0]).toEqual({ type: "text", text: MCP_UNTRUSTED_NOTICE });
    expect(result.content[1].text).toBe(JSON.stringify(result.structuredContent));
    expect(result.structuredContent).toMatchObject({
      connection_id: "seed:lathe",
      truncated: false,
      pagination: { offset: 0, limit: 100, hasMore: false, nextOffset: null, wasLimited: false },
      hint: null,
    });
    expect(result.structuredContent?.row_count).toBeGreaterThan(0);
    expect(JSON.stringify(result.structuredContent?.rows)).toContain("x1722-pos");
    expect(ADAPTER.test(JSON.stringify(result))).toBe(false);
    // The connection's open, then the read's own model read and the request itself.
    expect(lines()).toEqual(["GET /probe", "GET /probe", "GET /current"]);
    expect(mcpEvents().map((event) => [event.action, event.target, event.result])).toEqual([
      ["run_mtconnect_read", "mcp/decision", "success"],
      ["run_mtconnect_read", "mcp/execution", "success"],
    ]);
  });

  test("/probe answers one row per data item, with no adapter connection among them", async () => {
    const result = await mtconnect("/probe");
    expect(result.isError ?? false).toBe(false);
    const rows = JSON.stringify(result.structuredContent?.rows);
    expect(rows).toContain("x1722-pos");
    expect(ADAPTER.test(rows)).toBe(false);
  });

  test("an asset read answers the asset's document as XML text", async () => {
    const result = await mtconnect("/asset/TOOL-1722");
    expect(result.isError ?? false).toBe(false);
    expect(result.structuredContent?.row_count).toBe(1);
    const [row] = (result.structuredContent?.rows ?? []) as Array<Record<string, unknown>>;
    expect(row).toMatchObject({ assetId: "TOOL-1722", type: "CuttingTool" });
    expect(String(row.document)).toStartWith('<CuttingTool assetId="TOOL-1722"');
  });

  test("a read past max_rows is cut to it, and the hint narrows the read rather than paging", async () => {
    const result = await mtconnect("/current", { max_rows: 1 });
    expect(result.structuredContent).toMatchObject({
      row_count: 1,
      truncated: true,
      truncated_by: "max_rows",
      pagination: { offset: 0, limit: 1, hasMore: true, nextOffset: null, wasLimited: false },
      hint: RUN_MTCONNECT_READ_ARM.moreRows("/current", "mtconnect", { maxRows: 1, shown: 1, cut: "max_rows" }),
    });
  });
});

describe("a refusal", () => {
  test.each([
    ["a PUT", "PUT /probe"],
    ["a POST", `POST /${LATHE}?x1722-pos=9999`],
    ["/cancel", "/cancel/id=1"],
    ["a streaming parameter", "/sample?interval=1000"],
    ["a second request line", "/current\n/sample"],
    ["a path function", '/current?path=//DataItem[contains(@id,"adapter")]'],
  ])("%s is refused by the agent's admission before anything is acquired", async (_shape, line) => {
    const acquire = McpConnectionContext.prototype.acquire as unknown as ReturnType<typeof mock>;
    const result = await mtconnect(line);
    const refusal = server.admit?.(line);
    expect(refusal).not.toBeNull();
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: `The request was refused before it reached the agent (${refusal?.code}). ${refusal?.message}`,
        },
      ],
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
    expect(mcpEvents()).toEqual([
      expect.objectContaining({
        action: "run_mtconnect_read",
        target: "mcp/decision",
        result: "failure",
        reason: "mcp_statement_refused",
      }),
    ]);
  });

  test("a path value only a withheld adapter item holds is refused like one no item holds, after the model read alone", async () => {
    const hit = await mtconnect('/current?path=//DataItem[@id="_mtconnect-adapter_7878_adapter_uri"]');
    const hitLines = lines();
    recorded = [];
    const miss = await mtconnect('/current?path=//DataItem[@id="_mtconnect-adapter_7879_adapter_uri"]');
    expect(hit.isError).toBe(true);
    expect(miss.isError).toBe(true);
    const words = (answer: Answered, literal: string) =>
      answer.content
        .map((block) => block.text)
        .join("\n")
        .replaceAll(literal, "{}");
    expect(words(hit, "_mtconnect-adapter_7878_adapter_uri")).toBe(words(miss, "_mtconnect-adapter_7879_adapter_uri"));
    expect(hitLines).toEqual(["GET /probe", "GET /probe"]);
    expect(lines()).toEqual(["GET /probe", "GET /probe"]);
  });

  test("a provider not opened under the agent read-only profile refuses the read, and nothing is read", async () => {
    honourProfile = false;
    const result = await mtconnect("/current");
    expect(result.isError).toBe(true);
    expect(result.content.map((block) => block.text).join("\n")).toContain(
      "Read-only execution requires a provider opened under the agent read-only profile",
    );
    expect(lines()).toEqual(["GET /current"]);
  });

  test("a count past the provider's row budget is refused before the request is sent", async () => {
    const result = await mtconnect("/sample?count=1001");
    expect(result.isError).toBe(true);
    expect(lines()).toEqual(["GET /probe"]);
  });

  test("a read whose answer passes the provider's row budget is refused with the language's own advice", async () => {
    const result = await mtconnect("/sample?count=1000");
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: `The result has more than 1000 rows, the most this server reads for one call. ${server.rowCapAdvice("/sample?count=1000", "1000")}`,
        },
      ],
    });
    expect(mcpEvents().at(-1)).toMatchObject({ target: "mcp/execution", reason: "mcp_result_too_large" });
  });

  test("a SQL engine is refused before anything is acquired, naming the tool that reads it", async () => {
    const result = await call("run_mtconnect_read", { connection_id: "seed:shop", statement: "/current" });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "run_mtconnect_read cannot run on this connection: this tool does not serve SQLite; use run_read_query there. It runs on MTConnect.",
        },
      ],
    });
  });

  test("run_read_query refuses an MTConnect connection, naming run_mtconnect_read", async () => {
    const result = await call("run_read_query", { connection_id: "seed:lathe", sql: "SELECT 1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("this tool does not serve MTConnect; use run_mtconnect_read there");
    expect(recorded).toEqual([]);
  });

  test.each([
    ["an offset", { offset: 100 }],
    ["a database", { database: LATHE }],
  ])("%s is an argument this tool does not take", async (_what, extra) => {
    const result = await mtconnect("/current", extra);
    expect(result.isError).toBe(true);
    expect(recorded).toEqual([]);
  });
});

describe("the wait", () => {
  const connection = {
    ...LATHE_SEED,
    id: "seed:lathe",
    name: "lathe",
    seedId: "lathe",
    managed: true,
    mcp: true,
    roles: ["admin"],
    createdAt: new Date(),
  } as unknown as ManagedConnection;

  function direct(statement: string, timeoutMs: number, signal: AbortSignal) {
    const context = {
      caller: { username: "alice", role: "admin" },
      resolve: async () => connection,
      acquire: acquireOver,
    } as unknown as McpConnectionContext;
    const input = RUN_MTCONNECT_READ_ARM.inputSchema.parse({
      connection_id: connection.id,
      statement,
      timeout_ms: timeoutMs,
    }) as McpStatementInput;
    return runStatement(RUN_MTCONNECT_READ_ARM, input, { context, signal });
  }

  test("a read still waiting at timeout_ms is answered as the timeout, and the provider ended its request", async () => {
    const result = await direct("/sample?count=7", 500, new AbortController().signal);
    expect(result.content).toEqual([{ type: "text", text: timeoutText(500) }]);
    expect(mcpEvents().at(-1)).toMatchObject({ reason: "mcp_timeout" });
    await waitFor(() => endedAt !== null);
  });

  test("a client cancel ends the wait at once, and the read runs on until the provider's own budget ends it", async () => {
    const controller = new AbortController();
    const pending = direct("/sample?count=7", 1_500, controller.signal);
    await waitFor(() => lines().includes("GET /sample?count=7"));
    const cancelledAt = Date.now();
    controller.abort();
    const result = await pending;
    expect(result.content).toEqual([{ type: "text", text: MCP_CANCELLED_TEXT }]);
    expect(mcpEvents().at(-1)).toMatchObject({ target: "mcp/execution", reason: "mcp_cancelled" });
    // The cancel did not reach the request: it ended only when the read's own time budget, the time left, ran out.
    expect(endedAt).toBeNull();
    await waitFor(() => endedAt !== null);
    expect((endedAt ?? 0) - cancelledAt).toBeGreaterThan(200);
  });
});
