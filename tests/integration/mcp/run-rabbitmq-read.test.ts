/**
 * run_rabbitmq_read: MCP's rabbitread arm, run by the statement core over the real RabbitMQ provider, through the real
 * route, seed file and handler, with the management stub of tests/helpers/rabbitmq-management-stub.ts and a fake AMQP
 * peer of tests/helpers/rabbitmq-fake-peer.ts in place of a broker.
 *
 * The provider is the one the factory would hand out, built here only so its management transport and its AMQP dial
 * are the fakes: the agent read-only profile opens it to send statements, which `queryReadOnly` refuses without, and
 * every other profile does not. The request is the agent's own, read and admitted by the agent's own rabbitread
 * adapter: a read answers each message's offset and body size behind the untrusted-content notice, so no body, header,
 * property or routing key reaches the client; a request of any other shape is refused before anything is acquired; a
 * classic or quorum queue is refused by the provider's type check before any frame; a result cut to max_rows says how
 * to read on by offset, since the tool takes no offset; and a timeout or a cancel ends the wait while the provider's
 * own deadline ends the read.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { languageServer } from "@/lib/agent/languages/server";
import { getServerAuditBuffer } from "@/lib/audit";
import type { ExecutionProfile } from "@/lib/db/factory";
import { type AmqpDial, type AmqpSocket, dialAmqp } from "@/lib/db/providers/stream/rabbitmq/amqp/dial";
import { notAStream } from "@/lib/db/providers/stream/rabbitmq/errors";
import { RabbitMQProvider } from "@/lib/db/providers/stream/rabbitmq/index";
import { routeTarget } from "@/lib/db/providers/stream/rabbitmq/management/routes";
import { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_CANCELLED_TEXT, MCP_UNTRUSTED_NOTICE } from "@/lib/mcp/output";
import { timeoutText } from "@/lib/mcp/tools/read-query-limits";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseConnection } from "@/lib/types";
import { pinMcpTestEnvironment, resetMcpTestState, writeSeedFile } from "../../helpers/mcp-fixtures";
import { connectClient, handlerServe, testAuthInfo } from "../../helpers/mcp-harness";
import { RABBITMQ_TEST_PASSWORD } from "../../helpers/rabbitmq-connection";
import {
  type FakePeer,
  handshakeSteps,
  message,
  type PeerStep,
  serverFrames,
  startFakePeer,
  until,
} from "../../helpers/rabbitmq-fake-peer";
import { createManagementStub, type ManagementStub } from "../../helpers/rabbitmq-management-stub";

pinMcpTestEnvironment();

const dir = mkdtempSync(join(tmpdir(), "libredb-mcp-rabbitmq-"));
const serve = handlerServe(testAuthInfo());
const server = languageServer("rabbitread");
const RUN_RABBITMQ_READ_ARM = mcpStatementArm("run_rabbitmq_read");
/** A seed is plain data, so its password is written as the operator writes it. */
const BROKER_SEED = {
  id: "broker",
  type: "rabbitmq",
  host: "127.0.0.1",
  port: 15672,
  user: "studio-reader",
  password: RABBITMQ_TEST_PASSWORD,
  amqpPort: "5672",
  ssl: { mode: "disable" },
};

const utf8 = (text: string) => new TextEncoder().encode(text);

/** Every stored value of a fake message: none may reach an MCP answer. */
const MARKERS = {
  body: "mcp-marker-body-value",
  header: "mcp-marker-header-value",
  headerName: "x-mcp-marker-header-name",
  routingKey: "mcp-marker-routing-key",
  exchange: "mcp-marker-exchange",
  messageId: "mcp-marker-message-id",
  correlationId: "mcp-marker-correlation-id",
  appId: "mcp-marker-app-id",
  type: "mcp-marker-type",
  contentType: "application/x-mcp-marker",
  replyTo: "mcp-marker-reply-to",
} as const;

function markedDelivery(tag: number, offset: bigint): Uint8Array {
  return message({
    deliveryTag: BigInt(tag),
    offset,
    body: utf8(MARKERS.body),
    exchange: MARKERS.exchange,
    routingKey: MARKERS.routingKey,
    properties: {
      headers: [
        { name: utf8("x-stream-offset"), value: { tag: "l", value: offset } },
        { name: utf8(MARKERS.headerName), value: { tag: "S", bytes: utf8(MARKERS.header) } },
      ],
      contentType: utf8(MARKERS.contentType),
      messageId: utf8(MARKERS.messageId),
      correlationId: utf8(MARKERS.correlationId),
      appId: utf8(MARKERS.appId),
      type: utf8(MARKERS.type),
      replyTo: utf8(MARKERS.replyTo),
      timestamp: BigInt(1_700_000_000),
    },
  });
}

const CLOSING: readonly PeerStep[] = [
  { expect: { classId: 10, methodId: 50 } },
  { send: serverFrames.closeOk() },
  { end: "close" },
];

function stubKey(target: ReturnType<typeof routeTarget>): string {
  const query = [...(target.params ?? new URLSearchParams())]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  return query === "" ? `GET ${target.pathname}` : `GET ${target.pathname}?${query}`;
}

/** whoami and the version overview, which connect() reads, then the type check of `/` `orders` and `/` `jobs`. */
function brokerStub(): ManagementStub {
  const stub = createManagementStub();
  stub.answer(stubKey(routeTarget("whoami", {}, "")), {
    status: 200,
    body: '{"name":"studio-reader","tags":["management"]}',
  });
  stub.answer(stubKey(routeTarget("overview-version", {}, "")), {
    status: 200,
    body: '{"rabbitmq_version":"4.3.6","product_name":"RabbitMQ"}',
  });
  stub.answer(stubKey(routeTarget("stream-type", { vhost: "/", name: "orders" }, "")), {
    status: 200,
    body: JSON.stringify({ type: "stream", online: ["rabbit@a"], members: ["rabbit@a"] }),
  });
  stub.answer(stubKey(routeTarget("stream-type", { vhost: "/", name: "jobs" }, "")), {
    status: 200,
    body: JSON.stringify({ type: "classic", online: [], members: [] }),
  });
  return stub;
}

let stub = brokerStub();
let peer: FakePeer | undefined;
let dials = 0;
const sockets: AmqpSocket[] = [];
/** Whether the next acquisition hands out a provider opened under the profile it asked for, or an editor's. */
let honourProfile = true;

/** The AMQP dial: to the peer the test started, counted. */
const dial: AmqpDial = async (endpoint, signal) => {
  dials += 1;
  if (peer === undefined) throw new Error("no fake broker was started for this test");
  const socket = await dialAmqp({ ...endpoint, port: peer.port }, signal);
  sockets.push(socket);
  return socket;
};

/** The factory's provider, with only its management transport and its AMQP dial replaced. */
async function brokerProvider(connection: ManagedConnection, profile: ExecutionProfile): Promise<RabbitMQProvider> {
  const agent = honourProfile && profile === "agent-read-only";
  const provider = new RabbitMQProvider(
    connection as DatabaseConnection,
    {},
    { readOnly: agent, sendsStatements: agent },
    { managementTransport: stub.factory, dial },
  );
  await provider.connect();
  return provider;
}

beforeEach(() => {
  stub = brokerStub();
  peer = undefined;
  dials = 0;
  sockets.splice(0);
  honourProfile = true;
  writeSeedFile(dir, [BROKER_SEED, { id: "shop", type: "sqlite", database: join(dir, "absent.db") }]);
  spyOn(McpConnectionContext.prototype, "acquire").mockImplementation(brokerProvider);
});

afterEach(async () => {
  mock.restore();
  await resetMcpTestState();
  await peer?.stop();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Answered {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}

async function call(name: string, args: Record<string, unknown>): Promise<Answered> {
  const session = await connectClient(serve, { negotiation: "legacy" });
  try {
    return (await session.client.callTool({ name, arguments: args })) as Answered;
  } finally {
    await session.close();
  }
}

const READ = (limit: number, from: unknown = "first", stream = "orders") =>
  JSON.stringify({ vhost: "/", stream, from, limit });

const rabbit = (statement: string, extra: Record<string, unknown> = {}) =>
  call("run_rabbitmq_read", { connection_id: "seed:broker", statement, ...extra });

const mcpEvents = () =>
  getServerAuditBuffer()
    .getAll()
    .filter((event) => event.type === "mcp_operation");

/** The management requests past connect()'s two, by path. */
const typeChecks = () => stub.requests.filter((request) => request.path.startsWith("/api/queues/"));

function holdsNoMarker(answer: unknown): void {
  const text = JSON.stringify(answer);
  for (const value of Object.values(MARKERS)) {
    expect({ value, answered: text.includes(value) }).toEqual({ value, answered: false });
  }
}

describe("the tool", () => {
  test("is listed with the statement schema and no offset or database, read-only", async () => {
    const session = await connectClient(serve, { negotiation: "legacy" });
    try {
      const tools = (await session.client.listTools()).tools;
      const tool = tools.find((candidate) => candidate.name === "run_rabbitmq_read");
      expect(tool?.description).toBe(RUN_RABBITMQ_READ_ARM.description);
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

  test("describes RabbitMQ as the engine it runs on", () => {
    expect(RUN_RABBITMQ_READ_ARM.engines).toBe("RabbitMQ");
  });

  test("list_connections names it as the RabbitMQ connection's read tool", async () => {
    const result = await call("list_connections", {});
    const connections = (result.structuredContent?.connections ?? []) as Array<{
      id: string;
      read_tool: string | null;
    }>;
    expect(connections.map((connection) => [connection.id, connection.read_tool])).toEqual([
      ["seed:broker", "run_rabbitmq_read"],
      ["seed:shop", "run_read_query"],
    ]);
  });
});

describe("a read", () => {
  test("answers each message's offset and body size behind the notice, recorded under run_rabbitmq_read", async () => {
    peer = await startFakePeer([
      ...handshakeSteps(),
      { send: markedDelivery(1, BigInt(40)) },
      { send: markedDelivery(2, BigInt(41)) },
      ...CLOSING,
    ]);
    const result = await rabbit(READ(2));
    expect(result.isError ?? false).toBe(false);
    expect(result.content[0]).toEqual({ type: "text", text: MCP_UNTRUSTED_NOTICE });
    expect(result.content[1].text).toBe(JSON.stringify(result.structuredContent));
    expect(result.structuredContent).toMatchObject({
      connection_id: "seed:broker",
      columns: [{ name: "offset" }, { name: "body_bytes" }],
      rows: [
        { offset: 40, body_bytes: MARKERS.body.length },
        { offset: 41, body_bytes: MARKERS.body.length },
      ],
      row_count: 2,
      truncated: false,
      pagination: { offset: 0, limit: 100, hasMore: false, nextOffset: null, wasLimited: false },
      hint: null,
    });
    holdsNoMarker(result);
    expect(typeChecks().map((request) => request.path)).toEqual(["/api/queues/%2F/orders"]);
    expect(dials).toBe(1);
    expect(mcpEvents().map((event) => [event.action, event.target, event.result])).toEqual([
      ["run_rabbitmq_read", "mcp/decision", "success"],
      ["run_rabbitmq_read", "mcp/execution", "success"],
    ]);
  });

  test("a read past max_rows is cut to it, and the hint reads on by offset rather than paging", async () => {
    peer = await startFakePeer([
      ...handshakeSteps(),
      { send: markedDelivery(1, BigInt(7)) },
      { send: markedDelivery(2, BigInt(8)) },
      { send: markedDelivery(3, BigInt(9)) },
      ...CLOSING,
    ]);
    const statement = READ(3);
    const result = await rabbit(statement, { max_rows: 2 });
    expect(result.structuredContent).toMatchObject({
      rows: [
        { offset: 7, body_bytes: MARKERS.body.length },
        { offset: 8, body_bytes: MARKERS.body.length },
      ],
      row_count: 2,
      truncated: true,
      truncated_by: "max_rows",
      pagination: { offset: 0, limit: 2, hasMore: true, nextOffset: null, wasLimited: false },
      hint: RUN_RABBITMQ_READ_ARM.moreRows(statement, "rabbitmq", { maxRows: 2, shown: 2, cut: "max_rows" }),
    });
    expect(result.structuredContent?.hint as string).toContain('{"offset": n}');
    holdsNoMarker(result);
  });
});

describe("a refusal", () => {
  test.each([
    ["a key the request does not take", JSON.stringify({ vhost: "/", stream: "orders", filter: { a: "b" } })],
    ["a limit past the language's own 500", READ(501)],
    ["text that is no read request", "basic.get orders"],
    ["a request longer than the agent takes", JSON.stringify({ vhost: "/", stream: "o".repeat(4_100) })],
  ])("%s is refused by the agent's admission before anything is acquired", async (_shape, statement) => {
    const acquire = McpConnectionContext.prototype.acquire as unknown as ReturnType<typeof mock>;
    const result = await rabbit(statement);
    const refusal = server.admit?.(statement);
    expect(refusal).not.toBeNull();
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: `The read request was refused before it reached the broker (${refusal?.code}). ${refusal?.message}`,
        },
      ],
    });
    expect(acquire).not.toHaveBeenCalled();
    expect(stub.requests).toEqual([]);
    expect(dials).toBe(0);
    expect(mcpEvents()).toEqual([
      expect.objectContaining({
        action: "run_rabbitmq_read",
        target: "mcp/decision",
        result: "failure",
        reason: "mcp_statement_refused",
      }),
    ]);
  });

  test("a classic queue is refused by the provider's type check, with no frame sent", async () => {
    const result = await rabbit(READ(1, "first", "jobs"));
    expect(result.isError).toBe(true);
    expect(result.content.map((block) => block.text).join("\n")).toContain(notAStream("jobs", "classic").message);
    expect(typeChecks().map((request) => request.path)).toEqual(["/api/queues/%2F/jobs"]);
    expect(dials).toBe(0);
  });

  test("a provider not opened under the agent read-only profile refuses the read, with no frame sent", async () => {
    honourProfile = false;
    const result = await rabbit(READ(1));
    expect(result.isError).toBe(true);
    expect(result.content.map((block) => block.text).join("\n")).toContain(
      "Read-only execution requires a provider opened under the agent read-only profile",
    );
    expect(typeChecks()).toEqual([]);
    expect(dials).toBe(0);
  });

  test("a SQL engine is refused before anything is acquired, naming the tool that reads it", async () => {
    const result = await call("run_rabbitmq_read", { connection_id: "seed:shop", statement: READ(1) });
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "run_rabbitmq_read cannot run on this connection: this tool does not serve SQLite; use run_read_query there. It runs on RabbitMQ.",
        },
      ],
    });
  });

  test("run_read_query refuses a RabbitMQ connection, naming run_rabbitmq_read", async () => {
    const result = await call("run_read_query", { connection_id: "seed:broker", sql: "SELECT 1" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("this tool does not serve RabbitMQ; use run_rabbitmq_read there");
    expect(stub.requests).toEqual([]);
  });

  test.each([
    ["an offset", { offset: 100 }],
    ["a database", { database: "/" }],
  ])("%s is an argument this tool does not take", async (_what, extra) => {
    const result = await rabbit(READ(1), extra);
    expect(result.isError).toBe(true);
    expect(stub.requests).toEqual([]);
    expect(dials).toBe(0);
  });
});

describe("the wait", () => {
  /** One call through the statement core with the route's acquisition, under `signal`. */
  async function direct(
    statement: string,
    timeoutMs: number,
    signal: AbortSignal,
    acquire: typeof brokerProvider = brokerProvider,
  ) {
    const connection = {
      ...BROKER_SEED,
      id: "seed:broker",
      seedId: "broker",
      name: "broker",
      managed: true,
      mcp: true,
      roles: ["*"],
      createdAt: new Date(0),
    } as unknown as ManagedConnection;
    const context = {
      caller: { username: "mcp-test", role: "admin" },
      visibleConnections: async () => [connection],
      resolve: async () => connection,
      acquire,
    } as unknown as McpConnectionContext;
    const input = RUN_RABBITMQ_READ_ARM.inputSchema.parse({
      connection_id: "seed:broker",
      statement,
      timeout_ms: timeoutMs,
    }) as McpStatementInput;
    return runStatement(RUN_RABBITMQ_READ_ARM, input, { context, signal });
  }

  test("a read still running at timeout_ms is answered as the timeout, and the provider closes its connection", async () => {
    peer = await startFakePeer([...handshakeSteps(), { waitMs: 5_000 }]);
    const result = await direct(READ(10, "next"), 500, new AbortController().signal);
    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: "text",
          text: "The statement did not finish within timeout_ms (500 ms). Narrow it, or raise timeout_ms up to 30000.",
        },
      ],
    });
    await until(() => sockets.length === 1 && sockets[0].destroyed, "the read's connection to close");
  });

  test("a cancel ends the wait at once, and the read runs on until the provider's own deadline ends it", async () => {
    // A message every 600 ms: the read neither reaches its limit nor idles for 1 s before the 1,500 ms deadline.
    const trickle = Array.from({ length: 8 }, (_, index): PeerStep[] => [
      { waitMs: 600 },
      { send: markedDelivery(index + 1, BigInt(index)) },
    ]).flat();
    peer = await startFakePeer([...handshakeSteps(), ...trickle]);
    const controller = new AbortController();
    const started = Date.now();
    const answered = direct(READ(10), 1_500, controller.signal);
    await until(() => sockets.length === 1, "the read's connection to open");
    controller.abort();
    expect(await answered).toEqual({ isError: true, content: [{ type: "text", text: MCP_CANCELLED_TEXT }] });
    expect(sockets[0].destroyed).toBe(false);
    await until(() => sockets[0].destroyed, "the read's connection to close", 3_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
  });

  test("a cancelled read keeps the seed's one read slot until its deadline, and a later call on that seed waits for it", async () => {
    // The factory hands every call on one seed and profile the same provider, whose read limiter holds one read.
    let shared: Promise<RabbitMQProvider> | undefined;
    const sameProvider: typeof brokerProvider = (connection, profile) => {
      shared ??= brokerProvider(connection, profile);
      return shared;
    };
    const trickle = Array.from({ length: 8 }, (_, index): PeerStep[] => [
      { waitMs: 600 },
      { send: markedDelivery(index + 1, BigInt(index)) },
    ]).flat();
    peer = await startFakePeer([...handshakeSteps(), ...trickle]);
    const controller = new AbortController();
    const started = Date.now();
    const cancelled = direct(READ(10), 1_500, controller.signal, sameProvider);
    await until(() => sockets.length === 1, "the read's connection to open");
    controller.abort();
    expect(await cancelled).toEqual({ isError: true, content: [{ type: "text", text: MCP_CANCELLED_TEXT }] });
    const waiting = await direct(READ(1), 500, new AbortController().signal, sameProvider);
    expect(waiting).toEqual({ isError: true, content: [{ type: "text", text: timeoutText(500) }] });
    expect(dials).toBe(1);
    await until(() => sockets[0].destroyed, "the cancelled read's connection to close", 3_000);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_400);
    const after = await direct(READ(1), 3_000, new AbortController().signal, sameProvider);
    expect(after.isError ?? false).toBe(false);
    expect(after.structuredContent).toMatchObject({ rows: [{ offset: 0, body_bytes: MARKERS.body.length }] });
    expect(dials).toBe(2);
  });
});
