/**
 * Credentials and broker text never reach a client (R-S5), asserted on the full JSON body three routes answer:
 * `POST /api/db/query`, `POST /api/db/test-connection` and `POST /api/db/objects/source`.
 *
 * The provider is the real RabbitMQProvider; its management transport and its AMQP dial are seams this file writes,
 * and the AMQP peer is the fake peer on 127.0.0.1. Only the session and the provider lookup are replaced, as every
 * route test in this suite does, because the routes take both from modules with no seam: `@/lib/auth` for the
 * session and `@/lib/db` for the provider this file built (Test Connection imports `createDatabaseProvider` from
 * `@/lib/db/factory`, which `@/lib/db` re-exports, and reaches the replaced one too, as its positive control asserts).
 * The runner gives this file its own process, so the two replacements reach no other file.
 *
 * Every case asserts that the route reached the seam it targets (the management path it asked for, or the dial), so
 * a case whose route built some other provider fails instead of passing on an answer it never saw.
 *
 * Node 24's `JSON.parse` quotes the first bytes of the text it refuses, which Bun's does not; the SyntaxError cases
 * raise that exact message from the seams, so the boundary is held to it under Bun too.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { clearRateLimitState } from "@/lib/api/rate-limit";
import * as actualDb from "@/lib/db";
import { TransportError } from "@/lib/db/http/node-transport";
import type { AmqpDial } from "@/lib/db/providers/stream/rabbitmq/amqp/dial";
import { RabbitMQProvider } from "@/lib/db/providers/stream/rabbitmq/index";
import type { ManagementTransportFactory } from "@/lib/db/providers/stream/rabbitmq/management/client";
import type { DatabaseConnection } from "@/lib/types";
import { createMockRequest, parseResponseJSON } from "../../../helpers/mock-next";
import { rabbitmqConnection } from "../../../helpers/rabbitmq-connection";
import {
  type FakePeer,
  handshakeSteps,
  message,
  type PeerStep,
  serverFrames,
  startFakePeer,
} from "../../../helpers/rabbitmq-fake-peer";

const SENTINEL = "PEER-SENTINEL";
const CONNECTION = rabbitmqConnection();
const USERNAME = CONNECTION.user as string;
const PASSWORD = CONNECTION.password as string;

/** The provider the mocked lookup hands out, rebuilt by each test from the seams it needs. */
let current: RabbitMQProvider | undefined;
const providerOf = async () => {
  if (current === undefined) throw new Error("no provider was built for this test");
  return current;
};

const realAuth = await import("@/lib/auth");
mock.module("@/lib/auth", () => ({
  ...realAuth,
  getSession: mock(async () => ({ role: "admin", username: "admin" })),
}));
mock.module("@/lib/db", () => ({
  ...actualDb,
  getOrCreateProvider: mock(providerOf),
  createDatabaseProvider: mock(providerOf),
}));

const { POST: query } = await import("@/app/api/db/query/route");
const { POST: testConnection } = await import("@/app/api/db/test-connection/route");
const { POST: objectSource } = await import("@/app/api/db/objects/source/route");

const peers: FakePeer[] = [];
/** Every management path the provider asked for in this test, the positive control of each case. */
const requested: string[] = [];
beforeEach(() => {
  clearRateLimitState();
  requested.length = 0;
});
afterEach(async () => {
  await current?.disconnect();
  current = undefined;
  await Promise.all(peers.splice(0).map((peer) => peer.stop()));
});

type Answer = { readonly status: number; readonly text: string } | Error;

/**
 * A management transport whose answers the test chooses by path: connect()'s two GETs answer as a 4.3.6 broker
 * unless the test names them, and every other GET answers `rest`.
 */
function transport(answers: {
  readonly whoami?: Answer;
  readonly overview?: Answer;
  readonly rest: Answer;
}): ManagementTransportFactory {
  const respond = (answer: Answer) => {
    if (answer instanceof Error) throw answer;
    return { status: answer.status, contentType: "application/json", retryAfter: null, text: answer.text };
  };
  return () => ({
    async request(request) {
      const path = new URL(request.url).pathname;
      requested.push(path);
      if (path.endsWith("/api/whoami")) {
        return respond(answers.whoami ?? { status: 200, text: `{"name":"${USERNAME}","tags":["management"]}` });
      }
      if (path.endsWith("/api/overview")) {
        return respond(
          answers.overview ?? { status: 200, text: '{"rabbitmq_version":"4.3.6","product_name":"RabbitMQ"}' },
        );
      }
      return respond(answers.rest);
    },
    close() {},
  });
}

const STREAM = { status: 200, text: '{"type":"stream","online":["rabbit@a"],"members":["rabbit@a"]}' };

async function provider(
  management: ManagementTransportFactory,
  options: {
    readonly dial?: AmqpDial;
    readonly connection?: Partial<DatabaseConnection>;
    readonly connect?: boolean;
  } = {},
): Promise<RabbitMQProvider> {
  current = new RabbitMQProvider(
    { ...CONNECTION, ...options.connection },
    {},
    { managementTransport: management, ...(options.dial === undefined ? {} : { dial: options.dial }) },
  );
  if (options.connect !== false) await current.connect();
  return current;
}

async function peer(steps: readonly PeerStep[]): Promise<FakePeer> {
  const started = await startFakePeer(steps);
  peers.push(started);
  return started;
}

/** The whole answer as the client receives it, status and serialised body. */
async function post(
  route: typeof query,
  path: string,
  body: Record<string, unknown>,
  connection: Partial<DatabaseConnection> = {},
): Promise<{ readonly status: number; readonly text: string }> {
  const res = await route(
    createMockRequest(path, {
      method: "POST",
      body: { connection: { ...CONNECTION, ...connection }, ...body },
    }) as never,
  );
  return { status: res.status, text: JSON.stringify(await parseResponseJSON<unknown>(res)) };
}

/** Nothing of the account and nothing the broker or a seam wrote reaches the body. */
function expectClean(text: string, ...brokerTexts: string[]): void {
  expect(text).not.toContain(USERNAME);
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain(SENTINEL);
  for (const brokerText of brokerTexts) expect(text).not.toContain(brokerText);
}

/** The case reached the management API at this path, so its answer is the one the case wrote. */
function expectRequested(path: string): void {
  expect(requested.some((each) => each.endsWith(path))).toBe(true);
}
const TYPE_CHECK_PATH = "/api/queues/%2F/orders";

/** The message Node 24's JSON.parse gives for a body of markup, which quotes the body's first bytes. */
const nodeSyntaxError = () => new SyntaxError(`Unexpected token '<', "<html>${SENTINEL}" is not valid JSON`);

const READ = JSON.stringify({ vhost: "/", stream: "orders" });
const start = (steps: readonly PeerStep[]) => [
  { expect: "protocol-header" } as const,
  { send: serverFrames.connectionStart() },
  ...steps,
];
const START_OK = { expect: { classId: 10, methodId: 11 } } as const;

describe("POST /api/db/query", () => {
  const login = "ACCESS_REFUSED - Login was refused using authentication mechanism PLAIN";
  const vhostRefused = "NOT_ALLOWED - access to vhost '/' refused for user";
  const readRefused = "ACCESS_REFUSED - read access to queue 'orders' in vhost '/' refused for user";

  test.each([
    [
      "403 at the handshake",
      [START_OK, { send: serverFrames.connectionClose(403, `${login} user '${USERNAME}'`) }],
      login,
    ],
    [
      "530 at open",
      [
        START_OK,
        { send: serverFrames.tune() },
        { expect: { classId: 10, methodId: 31 } },
        { expect: { classId: 10, methodId: 40 } },
        { send: serverFrames.connectionClose(530, `${vhostRefused} '${USERNAME}'`, 10, 40) },
      ],
      vhostRefused,
    ],
    [
      "403 at consume",
      [
        START_OK,
        { send: serverFrames.tune() },
        { expect: { classId: 10, methodId: 31 } },
        { expect: { classId: 10, methodId: 40 } },
        { send: serverFrames.openOk() },
        { expect: { classId: 20, methodId: 10 } },
        { send: serverFrames.channelOpenOk() },
        { expect: { classId: 60, methodId: 10 } },
        { send: serverFrames.qosOk() },
        { expect: { classId: 60, methodId: 20 } },
        { send: serverFrames.channelClose(403, `${readRefused} '${USERNAME}'`, 60, 20) },
      ],
      readRefused,
    ],
  ] as const)("%s: a refusal sentence of Studio's own", async (_, steps, brokerText) => {
    const target = await peer(start(steps));
    await provider(transport({ rest: STREAM }), { connection: { amqpPort: String(target.port) } });
    const { status, text } = await post(query, "/api/db/query", { sql: READ }, { amqpPort: String(target.port) });
    expectRequested(TYPE_CHECK_PATH);
    expect(target.dials).toBe(1);
    expect(status).toBeGreaterThanOrEqual(400);
    expectClean(text, brokerText);
  });

  test('a queue whose type is "<script>" gets the fixed sentence', async () => {
    await provider(transport({ rest: { status: 200, text: '{"type":"<script>","online":[],"members":[]}' } }));
    const { status, text } = await post(query, "/api/db/query", { sql: READ });
    expectRequested(TYPE_CHECK_PATH);
    expect(status).toBe(400);
    expect(text).not.toContain("<script>");
    expectClean(text);
  });

  test.each([
    ["a dial seam throwing an Error", new Error(SENTINEL)],
    ["a dial seam throwing a TypeError", new TypeError(`bad ${SENTINEL} value`)],
    ["a dial seam throwing Node 24's SyntaxError for markup", nodeSyntaxError()],
  ])("%s", async (_, thrown) => {
    let dials = 0;
    await provider(transport({ rest: STREAM }), {
      dial: async () => {
        dials += 1;
        throw thrown;
      },
    });
    const { text } = await post(query, "/api/db/query", { sql: READ });
    expect(dials).toBe(1);
    expectClean(text, "Unexpected token");
  });

  test.each([
    ["a 200 whose body is markup", { status: 200, text: `<html>${SENTINEL}` }],
    ["an encoded body", new TransportError("encoding", `The server sent content-encoding PEERSENTINEL`)],
    ["a refused redirect", new TransportError("redirect", `Redirected to https://${SENTINEL}.example/`)],
    ["Node 24's SyntaxError for markup", nodeSyntaxError()],
  ])("the type check answering %s", async (_, answer) => {
    await provider(transport({ rest: answer }));
    const { text } = await post(query, "/api/db/query", { sql: READ });
    expectRequested(TYPE_CHECK_PATH);
    expectClean(text, "PEERSENTINEL", "Unexpected token");
  });
});

describe("POST /api/db/query with payloads nested past the depth rule (R-S7)", () => {
  const utf8 = (text: string) => new TextEncoder().encode(text);
  const nested = (depth: number) => `${"[".repeat(depth)}${"]".repeat(depth)}`;

  /** One delivery as RabbitMQ sends it from a stream: deliver, a content header carrying x-stream-offset, the body. */
  function delivery(body: Uint8Array): Uint8Array {
    return message({ deliveryTag: BigInt(1), offset: BigInt(3), body, routingKey: "orders" });
  }

  test.each([
    ["an 8,920-byte [[[...]]] body", nested(4460)],
    ["a 262,144-byte [[[...]]] body", nested(131072)],
    ["a 4,000-character string of ] and } then nesting to depth 4,460", `["${"]}".repeat(2000)}",${nested(4459)}]`],
  ])("%s: 200, base64, payload_bytes exact", async (_, text) => {
    const body = utf8(text);
    const target = await peer([
      ...handshakeSteps(),
      { send: delivery(body) },
      { expect: { classId: 60, methodId: 80 } },
      { expect: { classId: 10, methodId: 50 } },
      { send: serverFrames.closeOk() },
      { end: "close" },
    ]);
    await provider(transport({ rest: STREAM }), { connection: { amqpPort: String(target.port) } });
    const { status, text: answer } = await post(
      query,
      "/api/db/query",
      { sql: READ },
      { amqpPort: String(target.port) },
    );
    expect(status).toBe(200);
    const rows = (JSON.parse(answer) as { rows: Record<string, unknown>[] }).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload_encoding).toBe("base64");
    expect(rows[0].payload_bytes).toBe(body.length);
  });
});

describe("POST /api/db/test-connection", () => {
  test.each([
    ["whoami answering markup", { whoami: { status: 200, text: `<html>${SENTINEL}` } }],
    ["whoami answering an encoded body", { whoami: new TransportError("encoding", "content-encoding PEERSENTINEL") }],
    ["a 60 KiB version", { overview: { status: 200, text: `{"rabbitmq_version":"${"9".repeat(61440)}"}` } }],
    ["a version holding markup", { overview: { status: 200, text: `{"rabbitmq_version":"<b>${SENTINEL}</b>"}` } }],
    ["whoami raising Node 24's SyntaxError for markup", { whoami: nodeSyntaxError() }],
  ])("%s", async (_, answers) => {
    await provider(transport({ rest: STREAM, ...answers }), { connect: false });
    const { text } = await post(testConnection, "/api/db/test-connection", {});
    expectRequested("/api/whoami");
    expectClean(text, "PEERSENTINEL", "9".repeat(64), "Unexpected token");
  });
});

describe("POST /api/db/objects/source", () => {
  test.each([
    ["markup", { status: 200, text: `<html>${SENTINEL}` }],
    ["an encoded body", new TransportError("encoding", "content-encoding PEERSENTINEL")],
    ["a thrown TypeError", new TypeError(SENTINEL)],
    ["Node 24's SyntaxError for markup", nodeSyntaxError()],
  ])("a detail GET answering %s", async (_, rest) => {
    await provider(transport({ rest }));
    const before = requested.length;
    const { text } = await post(objectSource, "/api/db/objects/source", { path: ["/", "orders"], kind: "stream" });
    // The detail GET of the stream, asked by this route after connect()'s two GETs.
    expect(requested.slice(before).some((each) => each.includes(TYPE_CHECK_PATH))).toBe(true);
    expectClean(text, "PEERSENTINEL", "Unexpected token");
  });
});
