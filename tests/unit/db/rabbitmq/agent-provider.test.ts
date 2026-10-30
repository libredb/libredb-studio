/**
 * The agent read path of RabbitMQProvider: `queryReadOnly` on a handle of the agent read-only profile only, the
 * request read with the editor's own parser and refused before anything is sent when it is not one read request or
 * asks for more rows than the budget, the type check before any frame, the AMQP read to a fake broker, and the answer
 * projected to offsets and body sizes, with every stop but the limit and the stream's own end refused rather than cut.
 * Also what an agent-mode handle refuses on the editor's surfaces.
 *
 * Seams only, no module mocks: the management stub answers connect() and the type check, the dial is the real one to
 * a fake AMQP peer on 127.0.0.1 or one that never connects, and the deadline factory hands each D to the test.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { QueryCancelledError, QueryError, RefusedBeforeSendError } from "@/lib/db/errors";
import { byteBudgetSentence, rowBudgetSentence } from "@/lib/db/providers/sql/read-only-budget";
import { RABBITMQ_AGENT_STOP_SENTENCES } from "@/lib/db/providers/stream/rabbitmq/agent-metadata-read";
import { RABBITMQ_AGENT_SENTENCES } from "@/lib/db/providers/stream/rabbitmq/agent-statement";
import { type AmqpDial, type AmqpSocket, DialAborted, dialAmqp } from "@/lib/db/providers/stream/rabbitmq/amqp/dial";
import {
  IDLE_WARNING,
  NEXT_EMPTY_WARNING,
  notAStream,
  PROVIDER_CLOSED,
  unknownRequestKey,
} from "@/lib/db/providers/stream/rabbitmq/errors";
import { RabbitMQProvider } from "@/lib/db/providers/stream/rabbitmq/index";
import { routeTarget } from "@/lib/db/providers/stream/rabbitmq/management/routes";
import { RABBITMQ_STREAM_COLUMNS } from "@/lib/db/providers/stream/rabbitmq/results";
import type { ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { QueryResult } from "@/lib/types";
import { rabbitmqConnection } from "../../../helpers/rabbitmq-connection";
import {
  type FakePeer,
  handshakeSteps,
  message,
  type PeerStep,
  serverFrames,
  startFakePeer,
} from "../../../helpers/rabbitmq-fake-peer";
import { createManagementStub, type ManagementStub, manualDeadlines } from "../../../helpers/rabbitmq-management-stub";

const AGENT: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const OPERATIONS: ProviderExecutionContext = { readOnly: true, sendsStatements: false };
const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 200, maxResultBytes: 262_144, statementTimeoutMs: 10_000 };

const utf8 = (text: string) => new TextEncoder().encode(text);

/** Every stored value of a fake message: none may reach an agent answer. */
const MARKERS = {
  body: "marker-body-value",
  header: "marker-header-value",
  headerName: "x-marker-header-name",
  routingKey: "marker-routing-key",
  exchange: "marker-exchange",
  messageId: "marker-message-id",
  correlationId: "marker-correlation-id",
  appId: "marker-app-id",
  userId: "marker-user-id",
  type: "marker-type",
  contentType: "application/x-marker",
  replyTo: "marker-reply-to",
} as const;

const STREAM_ANSWER = JSON.stringify({ type: "stream", online: ["rabbit@a"], members: ["rabbit@a"] });

function stubKey(target: ReturnType<typeof routeTarget>): string {
  const query = [...(target.params ?? new URLSearchParams())]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  return query === "" ? `GET ${target.pathname}` : `GET ${target.pathname}?${query}`;
}

/** whoami and the version overview, which connect() reads, then the type check of `/` `orders` as `type`. */
function connectedStub(type = "stream"): ManagementStub {
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
    body: type === "stream" ? STREAM_ANSWER : JSON.stringify({ type, online: [], members: [] }),
  });
  return stub;
}

/** One stream delivery carrying every marker: a body, a header, every property and a routing key. */
function markedDelivery(tag: number, offset: bigint, body = utf8(MARKERS.body)): Uint8Array {
  return message({
    deliveryTag: BigInt(tag),
    offset,
    body,
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
      userId: utf8(MARKERS.userId),
      type: utf8(MARKERS.type),
      replyTo: utf8(MARKERS.replyTo),
      timestamp: BigInt(1_700_000_000),
    },
  });
}

const peers: FakePeer[] = [];
const providers: RabbitMQProvider[] = [];
afterEach(async () => {
  await Promise.all(providers.splice(0).map((provider) => provider.disconnect()));
  await Promise.all(peers.splice(0).map((peer) => peer.stop()));
});

async function peer(steps: readonly PeerStep[]): Promise<FakePeer> {
  const started = await startFakePeer(steps);
  peers.push(started);
  return started;
}

interface Handle {
  readonly provider: RabbitMQProvider;
  readonly stub: ManagementStub;
  readonly dials: () => number;
  readonly deadlines: ReturnType<typeof manualDeadlines>;
  readonly sockets: readonly AmqpSocket[];
}

/** A connected provider under `execution`, its AMQP port the peer's (or a dial that never connects). */
async function handle(
  execution: ProviderExecutionContext,
  options: { readonly target?: FakePeer; readonly type?: string } = {},
): Promise<Handle> {
  const stub = connectedStub(options.type);
  const deadlines = manualDeadlines();
  const sockets: AmqpSocket[] = [];
  let dials = 0;
  const dial: AmqpDial = async (endpoint, signal) => {
    dials += 1;
    if (options.target === undefined) {
      return new Promise((_, reject) =>
        signal.addEventListener("abort", () => reject(new DialAborted("connecting")), { once: true }),
      );
    }
    const socket = await dialAmqp(endpoint, signal);
    sockets.push(socket);
    return socket;
  };
  const provider = new RabbitMQProvider(
    rabbitmqConnection(options.target === undefined ? {} : { amqpPort: String(options.target.port) }),
    {},
    execution,
    { managementTransport: stub.factory, dial, deadlineSignal: deadlines.factory },
  );
  providers.push(provider);
  await provider.connect();
  return { provider, stub, dials: () => dials, deadlines, sockets };
}

async function refusal(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("the read answered");
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 500; tries++) {
    if (condition()) return;
    // oxlint-disable-next-line no-await-in-loop -- one poll at a time is the point.
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const READ = (from: unknown = "first", limit = 3) => JSON.stringify({ vhost: "/", stream: "orders", from, limit });
const ACK = { classId: 60, methodId: 80 } as const;
const CONNECTION_CLOSE = { classId: 10, methodId: 50 } as const;
const frames = (target: FakePeer, method: { readonly classId: number; readonly methodId: number }) =>
  target.received.filter((frame) => frame.classId === method.classId && frame.methodId === method.methodId);

/** The client frames as `class.method` names, the protocol header and content frames by their type. */
const sent = (target: FakePeer) =>
  target.received.map((frame) => (frame.type === 1 ? `${frame.classId}.${frame.methodId}` : `type ${frame.type}`));

function holdsNoMarker(result: unknown): void {
  const text = JSON.stringify(result, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
  for (const marker of Object.values(MARKERS)) expect(text).not.toContain(marker);
}

describe("who may call queryReadOnly", () => {
  test.each([
    ["an editor handle", {}],
    ["an operations handle, which sends no statement", OPERATIONS],
    ["a read-only handle that does not say it sends statements", { readOnly: true }],
  ])("%s is refused before anything is sent", async (_name, execution) => {
    const h = await handle(execution);
    const before = h.stub.requests.length;
    const error = await refusal(h.provider.queryReadOnly(READ(), BUDGET));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect(error.message).toBe("Read-only execution requires a provider opened under the agent read-only profile");
    expect(h.stub.requests).toHaveLength(before);
    expect(h.dials()).toBe(0);
  });

  test("an estimate is refused, and a budget out of range is refused by the shared check", async () => {
    const h = await handle(AGENT);
    const estimate = await refusal(h.provider.queryReadOnly(READ(), BUDGET, "estimate-plan"));
    expect(estimate).toBeInstanceOf(RefusedBeforeSendError);
    expect(estimate.message).toBe("RabbitMQ composes no estimating plan for the agent");
    expect(await refusal(h.provider.queryReadOnly(READ(), { ...BUDGET, maxResultRows: 0 }))).toBeInstanceOf(Error);
    expect(h.dials()).toBe(0);
  });

  test("before connect() and after disconnect() the call is refused with the provider's own sentences", async () => {
    const provider = new RabbitMQProvider(rabbitmqConnection(), {}, AGENT, {
      managementTransport: connectedStub().factory,
    });
    expect((await refusal(provider.queryReadOnly(READ(), BUDGET))).message).toBe(
      "Provider is not connected. Call connect() first.",
    );
    await provider.connect();
    await provider.disconnect();
    const closed = await refusal(provider.queryReadOnly(READ(), BUDGET));
    expect(closed).toBeInstanceOf(QueryCancelledError);
    expect(closed.message).toBe(PROVIDER_CLOSED);
  });
});

describe("refused before anything is sent", () => {
  test.each([
    ["", RABBITMQ_AGENT_SENTENCES.empty],
    [
      JSON.stringify({ vhost: "/", stream: "orders", filter: { routing_key: "a" } }),
      RABBITMQ_AGENT_SENTENCES.request(unknownRequestKey("filter")),
    ],
    [
      JSON.stringify({ vhost: "/", stream: "orders", headers: { "x-a": "b" } }),
      RABBITMQ_AGENT_SENTENCES.request(unknownRequestKey("headers")),
    ],
  ])("%p", async (statement, sentence) => {
    const h = await handle(AGENT);
    const before = h.stub.requests.length;
    const error = await refusal(h.provider.queryReadOnly(statement, BUDGET));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect(error.message).toBe(sentence);
    expect(h.stub.requests).toHaveLength(before);
    expect(h.dials()).toBe(0);
  });

  test.each([
    [READ("first", 201), 201, 200],
    [JSON.stringify({ vhost: "/", stream: "orders" }), 50, 10],
  ])("a request whose limit %p passes the row budget is refused, never cut", async (statement, rows, allowed) => {
    const h = await handle(AGENT);
    const before = h.stub.requests.length;
    const error = await refusal(h.provider.queryReadOnly(statement, { ...BUDGET, maxResultRows: allowed }));
    expect(error).toBeInstanceOf(RefusedBeforeSendError);
    expect(error.message).toBe(rowBudgetSentence(rows, allowed));
    expect(h.stub.requests).toHaveLength(before);
    expect(h.dials()).toBe(0);
  });
});

describe("the type check before any frame", () => {
  test.each(["classic", "quorum"])("a %s queue is refused after the one type check GET, with no dial", async (type) => {
    const h = await handle(AGENT, { type });
    const before = h.stub.requests.length;
    const error = await refusal(h.provider.queryReadOnly(READ(), BUDGET));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(notAStream("orders", type).message);
    expect(h.stub.requests.slice(before).map((request) => request.path)).toEqual(["/api/queues/%2F/orders"]);
    expect(h.dials()).toBe(0);
  });

  test("a queue declared under the stream's name after the check is refused by the broker's 406, nothing acked", async () => {
    const target = await peer([
      ...handshakeSteps().slice(0, -1),
      { send: serverFrames.channelClose(406, "PRECONDITION_FAILED - not a stream", 60, 20) },
      { waitMs: 2_000 },
    ]);
    const h = await handle(AGENT, { target });
    const error = await refusal(h.provider.queryReadOnly(READ(), BUDGET));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(notAStream("orders", "").message);
    expect(frames(target, ACK)).toHaveLength(0);
  });
});

describe("an admitted read, against a fake broker", () => {
  test("answers each message's offset and body size alone, from the request the editor would send", async () => {
    const target = await peer([
      ...handshakeSteps(),
      { send: markedDelivery(1, BigInt(40)) },
      { send: markedDelivery(2, BigInt(41), utf8("x".repeat(1_000))) },
      { send: markedDelivery(3, BigInt(42), new Uint8Array(0)) },
      { expect: CONNECTION_CLOSE },
      { send: serverFrames.closeOk() },
      { end: "close" },
    ]);
    const h = await handle(AGENT, { target });
    const result = await h.provider.queryReadOnly(READ(), BUDGET);
    expect(result).toEqual({
      fields: ["offset", "body_bytes"],
      rows: [
        { offset: 40, body_bytes: MARKERS.body.length },
        { offset: 41, body_bytes: 1_000 },
        { offset: 42, body_bytes: 0 },
      ],
      rowCount: 3,
      executionTime: expect.any(Number) as unknown as number,
    } as QueryResult);
    holdsNoMarker(result);
    // The whole conversation: the handshake, one qos, one consume, an ack per message and the close, nothing else.
    expect(sent(target)).toEqual([
      "type 0",
      "10.11",
      "10.31",
      "10.40",
      "20.10",
      "60.10",
      "60.20",
      "60.80",
      "60.80",
      "60.80",
      "10.50",
    ]);
    const consume = frames(target, { classId: 60, methodId: 20 })[0]?.payload as Uint8Array;
    const text = new TextDecoder().decode(consume);
    expect(text).toContain("orders");
    expect(text).toContain("x-stream-offset");
  });

  test("an idle stop is the stream's own end: what was read, with the one fixed warning", async () => {
    const target = await peer([...handshakeSteps(), { send: markedDelivery(1, BigInt(7)) }, { waitMs: 5_000 }]);
    const h = await handle(AGENT, { target });
    const result = await h.provider.queryReadOnly(READ("first", 10), BUDGET);
    expect(result.rows).toEqual([{ offset: 7, body_bytes: MARKERS.body.length }]);
    expect(result.warnings).toEqual([{ message: IDLE_WARNING }]);
    holdsNoMarker(result);
  });

  test('a read from "next" that read nothing says why', async () => {
    const target = await peer([...handshakeSteps(), { waitMs: 5_000 }]);
    const h = await handle(AGENT, { target });
    const result = await h.provider.queryReadOnly(READ("next", 10), BUDGET);
    expect(result.rows).toEqual([]);
    expect(result.warnings).toEqual([{ message: NEXT_EMPTY_WARNING }]);
  });

  test("each call opens its own connection, so nothing of one read reaches the next", async () => {
    const target = await peer([
      ...handshakeSteps(),
      { send: markedDelivery(1, BigInt(1)) },
      { expect: CONNECTION_CLOSE },
      { send: serverFrames.closeOk() },
      { end: "close" },
    ]);
    const h = await handle(AGENT, { target });
    await h.provider.queryReadOnly(READ("first", 1), BUDGET);
    await h.provider.queryReadOnly(READ("first", 1), BUDGET);
    expect(target.dials).toBe(2);
    expect(h.sockets.every((socket) => socket.destroyed)).toBe(true);
  });

  test("the answer past the byte budget is refused, never cut", async () => {
    const target = await peer([
      ...handshakeSteps(),
      { send: markedDelivery(1, BigInt(1)) },
      { expect: CONNECTION_CLOSE },
      { send: serverFrames.closeOk() },
      { end: "close" },
    ]);
    const h = await handle(AGENT, { target });
    const error = await refusal(h.provider.queryReadOnly(READ("first", 1), { ...BUDGET, maxResultBytes: 4 }));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe(byteBudgetSentence(30, 4));
  });

  test("an offset no number holds exactly refuses the whole answer", async () => {
    const target = await peer([...handshakeSteps(), { send: markedDelivery(1, BigInt(2) ** BigInt(60)) }]);
    const h = await handle(AGENT, { target });
    const error = await refusal(h.provider.queryReadOnly(READ("first", 1), BUDGET));
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toStartWith('The answer\'s "offset" is not a whole number from 0');
  });
});

describe("a stop the editor would answer in part is refused", () => {
  test("the broker's cancel after one message", async () => {
    const target = await peer([
      ...handshakeSteps(),
      { send: markedDelivery(1, BigInt(1)) },
      { send: serverFrames.basicCancel() },
      { waitMs: 2_000 },
    ]);
    const h = await handle(AGENT, { target });
    const error = await refusal(h.provider.queryReadOnly(READ(), BUDGET));
    expect(error.message).toBe(RABBITMQ_AGENT_STOP_SENTENCES.ended);
  });

  test("the 541 close at a message the broker cannot convert, after one message", async () => {
    const target = await peer([
      ...handshakeSteps(),
      { send: markedDelivery(1, BigInt(1)) },
      { send: serverFrames.connectionClose(541, "INTERNAL_ERROR") },
      { waitMs: 2_000 },
    ]);
    const h = await handle(AGENT, { target });
    const error = await refusal(h.provider.queryReadOnly(READ(), BUDGET));
    expect(error.message).toBe(RABBITMQ_AGENT_STOP_SENTENCES.conversion(1));
    holdsNoMarker(error.message);
  });

  test("the deadline after the broker started the read is the time budget's refusal", async () => {
    const target = await peer([...handshakeSteps(), { send: markedDelivery(1, BigInt(1)) }, { waitMs: 5_000 }]);
    const h = await handle(AGENT, { target });
    const pending = h.provider.queryReadOnly(READ(), BUDGET);
    await until(() => frames(target, ACK).length === 1, "the ack");
    h.deadlines.fire();
    const error = await refusal(pending);
    expect(error.message).toBe(RABBITMQ_AGENT_STOP_SENTENCES.deadline(10_000));
  });

  test("the deadline before the broker started the read is the time budget's refusal, D the budget's time", async () => {
    const h = await handle(AGENT);
    const pending = h.provider.queryReadOnly(READ(), { ...BUDGET, statementTimeoutMs: 4_000 });
    await until(() => h.dials() === 1, "the dial");
    expect(h.deadlines.asked.at(-1)).toBe(4_000);
    h.deadlines.fire();
    const error = await refusal(pending);
    expect(error).toBeInstanceOf(QueryError);
    expect(error.message).toBe("Read-only execution exceeded the time budget: no answer within 4000ms");
  });

  test("D is at most the read's own 30 s, whatever the budget allows", async () => {
    const h = await handle(AGENT);
    const pending = h.provider.queryReadOnly(READ(), { ...BUDGET, statementTimeoutMs: 120_000 });
    await until(() => h.dials() === 1, "the dial");
    expect(h.deadlines.asked.at(-1)).toBe(30_000);
    h.deadlines.fire();
    expect((await refusal(pending)).message).toBe(
      "Read-only execution exceeded the time budget: no answer within 30000ms",
    );
  });

  test("disconnect() during the read ends it with the cancel's refusal", async () => {
    const target = await peer([...handshakeSteps(), { send: markedDelivery(1, BigInt(1)) }, { waitMs: 5_000 }]);
    const h = await handle(AGENT, { target });
    const pending = h.provider.queryReadOnly(READ(), BUDGET);
    await until(() => frames(target, ACK).length === 1, "the ack");
    await h.provider.disconnect();
    expect((await refusal(pending)).message).toBe(RABBITMQ_AGENT_STOP_SENTENCES.cancel);
  });
});

describe("the editor's surfaces on an agent-mode handle", () => {
  test.each([
    ["the agent read-only profile", AGENT],
    ["the operations profile", OPERATIONS],
  ])(
    "%s refuses the editor's read and an object's source, and describes a stream by the agent's columns",
    async (_name, execution) => {
      const h = await handle(execution);
      const before = h.stub.requests.length;
      const read = await refusal(h.provider.query(READ()));
      expect(read).toBeInstanceOf(RefusedBeforeSendError);
      expect(read.message).toStartWith(
        "A RabbitMQ handle opened for agent mode answers only the agent's metadata reads",
      );
      for (const kind of ["stream", "queue", "exchange"]) {
        const source = await refusal(h.provider.readObjectSource(["/", "orders"], kind));
        expect(source).toBeInstanceOf(QueryError);
        expect(source.message).toBe(read.message);
      }
      expect(h.stub.requests).toHaveLength(before);
      expect(h.dials()).toBe(0);
      const detail = await h.provider.describeObject(["/", "orders"], "stream");
      expect(detail.columns.map((column) => [column.name, column.type])).toEqual([
        ["offset", "integer"],
        ["body_bytes", "integer"],
      ]);
    },
  );

  test("an editor handle keeps the editor's columns", async () => {
    const h = await handle({});
    const detail = await h.provider.describeObject(["/", "orders"], "stream");
    expect(detail.columns).toEqual(RABBITMQ_STREAM_COLUMNS);
  });

  test("an agent-mode handle's object source is refused even before connect()", async () => {
    const provider = new RabbitMQProvider(rabbitmqConnection(), {}, AGENT, {
      managementTransport: connectedStub().factory,
    });
    expect((await refusal(provider.readObjectSource(["/", "orders"], "queue"))).message).toBe(
      "Provider is not connected. Call connect() first.",
    );
  });

  test("the capability states the one metadata operation's columns and kinds", () => {
    expect(new RabbitMQProvider(rabbitmqConnection()).getCapabilities().metadataOnly).toEqual({
      "stream messages": [
        { column: "offset", kind: "count" },
        { column: "body_bytes", kind: "count" },
      ],
    });
  });
});
