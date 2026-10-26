/**
 * RabbitMQ provider, end to end (issue #1656).
 *
 * The real provider runs whole: the connection options, the management client and its decoders, the object surface,
 * the type check, the AMQP 0-9-1 client, the read loop, the renderer and the error table. Only the broker is fake, and
 * it is fake in recorded form: the management API's answers are replayed through the management API stub
 * (`tests/helpers/rabbitmq-management-stub.ts`), keyed by method, path and sorted query, and the broker's AMQP bytes
 * after `basic.consume-ok` through the replay peer (`tests/helpers/rabbitmq-fake-peer.ts`). No `mock.module()`.
 *
 * Every answer was captured by `tests/live/rabbitmq-evidence.ts` from the pinned brokers of `database-compose.yml`,
 * seeded by `tests/live/rabbitmq-seed.ts`; each file's `$captured` names the image, digest, broker version and seed
 * content hash, and the expected outcomes below are keyed by the capture set, the pinned version or `nightly`, never
 * by a version the broker reports. Two answers are built rather than recorded, and each says so where it is built:
 * the type check answered as a stream for the two 530 captures, whose reads the harness forced past that check the
 * same way, and the handshake the scripted peer plays before a captured close.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { classifyValue } from "@/components/results-grid/renderers/classify";
import { AuthenticationError, QueryError } from "@/lib/db/errors";
import { RabbitMQProvider } from "@/lib/db/providers/stream/rabbitmq";
import {
  amqpCloseError,
  conversionAfter,
  conversionNoRowNumeric,
  endpointText,
  managementStatusError,
  queuesSampledFrom,
  streamsSampledFrom,
  vhostUnavailableSentence,
} from "@/lib/db/providers/stream/rabbitmq/errors";
import { RABBITMQ_PREFETCH_MAX } from "@/lib/db/providers/stream/rabbitmq/limits";
import { MANAGEMENT_ROUTES } from "@/lib/db/providers/stream/rabbitmq/management/routes";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import {
  type AmqpCapture,
  bytesAfterConsumeOk,
  type CaptureSet,
  captureBytes,
  lastMethodFrame,
  loadAmqpCapture,
  loadManagementCapture,
  splitFrames,
  stubAnswers,
} from "../../helpers/rabbitmq-captures";
import { rabbitmqConnection } from "../../helpers/rabbitmq-connection";
import {
  closedPort,
  type FakePeer,
  handshakeSteps,
  message,
  type PeerStep,
  serverFrames,
  startFakePeer,
  startReplayPeer,
} from "../../helpers/rabbitmq-fake-peer";
import { createManagementStub, requestKey } from "../../helpers/rabbitmq-management-stub";
import { ByteReader } from "../../helpers/rabbitmq-test-amqp091";
import { RABBITMQ_SEED_EXCHANGES, RABBITMQ_SEED_TABLE } from "../../live/rabbitmq-seed";

const PINNED: readonly CaptureSet[] = ["4.3.6", "4.2.9"];
// The default vhost also holds amq.rabbitmq.log, which the broker declares there alone; billing has the other seven.
const BUILT_IN_EXCHANGES = [
  "",
  "amq.direct",
  "amq.fanout",
  "amq.headers",
  "amq.match",
  "amq.rabbitmq.log",
  "amq.rabbitmq.trace",
  "amq.topic",
];
const peers: FakePeer[] = [];

afterEach(async () => {
  for (const peer of peers.splice(0)) await peer.stop();
});

function connectionFor(amqpPort: number | null, user = "studio-reader"): DatabaseConnection {
  return rabbitmqConnection({ amqpPort: amqpPort === null ? "" : String(amqpPort), user });
}

/** A provider whose management API is the capture `name` of `set`. */
function replayed(
  set: CaptureSet,
  name: string,
  amqpPort: number | null,
  user?: string,
  extra: Record<string, { status: number; body: string; contentType?: string }> = {},
) {
  const stub = createManagementStub({ ...stubAnswers(loadManagementCapture(set, name)), ...extra });
  const provider = new RabbitMQProvider(connectionFor(amqpPort, user), {}, { managementTransport: stub.factory });
  return { provider, stub };
}

/**
 * The broker's bytes after basic.consume-ok, without the connection.close-ok that answered the client's close: the
 * replay peer sends these at once and answers the client's close itself, so a recorded close-ok would arrive before
 * the close it answers whenever a read ends by going idle short of its limit.
 */
function replayBytes(capture: AmqpCapture): Uint8Array {
  const bytes = bytesAfterConsumeOk(captureBytes(capture));
  const last = splitFrames(bytes).at(-1);
  return last?.classId === 10 && last.methodId === 51 ? bytes.slice(0, last.start) : bytes;
}

/** Runs one recorded read: the replay peer sends the broker's bytes after its own handshake. */
async function replayRead(
  set: CaptureSet,
  name: string,
): Promise<{ result?: QueryResult; error?: Error; request: string }> {
  const capture = loadAmqpCapture(set, name);
  const peer = await startReplayPeer(replayBytes(capture));
  peers.push(peer);
  const { provider } = replayed(set, "session-studio-reader", peer.port);
  await provider.connect();
  try {
    return { result: await provider.query(capture.request), request: capture.request };
  } catch (error) {
    return { error: error as Error, request: capture.request };
  } finally {
    await provider.disconnect();
  }
}

/** The steps from the protocol header to the client's `method`, then the captured close and the end. */
function stepsToClose(until: "connection.open" | "basic.consume", close: Uint8Array): PeerStep[] {
  const opening: PeerStep[] = [
    { expect: "protocol-header" },
    { send: serverFrames.connectionStart() },
    { expect: { classId: 10, methodId: 11 } },
    { send: serverFrames.tune({ frameMax: 131_072, heartbeat: 60 }) },
    { expect: { classId: 10, methodId: 31 } },
    { expect: { classId: 10, methodId: 40 } },
  ];
  const channel: PeerStep[] = [
    { send: serverFrames.openOk() },
    { expect: { classId: 20, methodId: 10 } },
    { send: serverFrames.channelOpenOk() },
    { expect: { classId: 60, methodId: 10 } },
    { send: serverFrames.qosOk() },
    { expect: { classId: 60, methodId: 20 } },
  ];
  return [
    ...opening,
    ...(until === "basic.consume" ? channel : []),
    { send: close },
    { waitMs: 100 },
    { end: "close" },
  ];
}

/** The reply code and text of a captured connection.close or channel.close frame. */
function closeOf(frame: Uint8Array): {
  readonly replyCode: number;
  readonly replyText: string;
  readonly classId: number;
  readonly methodId: number;
  readonly scope: "connection" | "channel";
} {
  const reader = new ByteReader(frame.subarray(7));
  const classOfClose = reader.u16();
  reader.u16();
  const replyCode = reader.u16();
  const replyText = new TextDecoder().decode(reader.shortstr());
  return {
    replyCode,
    replyText,
    classId: reader.u16(),
    methodId: reader.u16(),
    scope: classOfClose === 10 ? "connection" : "channel",
  };
}

const offsets = (result: QueryResult | undefined): string[] => (result?.rows ?? []).map((row) => String(row.offset));
const warnings = (result: QueryResult | undefined): string[] => (result?.warnings ?? []).map((w) => w.message);

describe.each([...PINNED])("RabbitMQ %s, replayed", (set) => {
  test("the tree: both fixture vhosts, / marked as the walk default, and the counts the seed table implies", async () => {
    const { provider } = replayed(set, "session-studio-reader", null);
    await provider.connect();
    const containers = await provider.listContainers();
    expect(containers.map((c) => c.name)).toEqual(["/", "billing"]);
    expect(containers.find((c) => c.name === "/")?.isSessionDefault).toBe(true);
    const counts = await provider.countObjects(["/"]);
    const inRoot = RABBITMQ_SEED_TABLE.filter((q) => q.vhost === "/");
    expect(counts.stream).toEqual({ count: inRoot.filter((q) => q.type === "stream").length });
    expect(counts.queue).toEqual({ count: inRoot.filter((q) => q.type !== "stream").length });
    expect(counts.exchange).toEqual({
      count: BUILT_IN_EXCHANGES.length + RABBITMQ_SEED_EXCHANGES.filter((x) => x.vhost === "/").length,
    });
    await provider.disconnect();
  });

  test("the Streams folder lists every seeded stream of / in the broker's byte order", async () => {
    const { provider } = replayed(set, "session-studio-reader", null);
    await provider.connect();
    const streams = await provider.listObjects(["/"], "stream");
    const expected = RABBITMQ_SEED_TABLE.filter((q) => q.vhost === "/" && q.type === "stream").map((q) => q.name);
    expect(streams.map((s) => s.name)).toEqual(
      [...expected].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))),
    );
    await provider.disconnect();
  });

  test("the default exchange opens through the object source path, with its bindings read from amq.default", async () => {
    const { provider, stub } = replayed(set, "session-studio-reader", null);
    await provider.connect();
    const source = await provider.readObjectSource?.(["/", ""], "exchange");
    expect(source?.parts.length).toBeGreaterThan(0);
    expect(stub.requests.some((request) => request.path.includes("/exchanges/%2F/amq.default/"))).toBe(true);
    await provider.disconnect();
  });

  test("st-orders 0 to 6: JSON, binary, empty, and the large bodies 7 and 8 left to the capture gate", async () => {
    const { result } = await replayRead(set, "read-st-orders-first-7");
    expect(offsets(result)).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
    const rows = result?.rows ?? [];
    expect(rows[0]).toMatchObject({
      payload_encoding: "json",
      payload: { orderId: 0, item: "widget", qty: 1 },
      exchange: "",
      routing_key: "st-orders",
    });
    expect(rows[5]).toMatchObject({ payload_encoding: "base64", payload_bytes: 64 });
    expect(
      String(rows[5].payload).startsWith(Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64").slice(0, 4)),
    ).toBe(true);
    expect(rows[6]).toMatchObject({ payload: "", payload_encoding: "text", payload_bytes: 0 });
  });

  test("st-orders 9 to 12: markup and escapes as text, invalid UTF-8 as base64, every property and the stored headers", async () => {
    const { result } = await replayRead(set, "read-st-orders-offset-9-limit-4");
    expect(offsets(result)).toEqual(["9", "10", "11", "12"]);
    const [html, escapes, invalid, all] = result?.rows ?? [];
    expect(html).toMatchObject({ payload_encoding: "text", payload: "<script>alert(1)</script><b>x</b>" });
    expect(escapes).toMatchObject({
      payload_encoding: "text",
      payload: "\u001b[31mred\u001b[0m and \u001b]0;title\u0007",
    });
    expect(invalid).toMatchObject({
      payload_encoding: "base64",
      payload: `${Buffer.from("fffec328a0a1", "hex").toString("base64")} (6 bytes)`,
      payload_bytes: 6,
    });
    expect(all).toMatchObject({ payload_encoding: "json", payload: { allProps: true } });
    const headers = all.headers as Record<string, unknown>;
    expect(Object.keys(headers)).toContain("h_html");
    // A stream stores no header whose value is a table or an array unless its name starts with x-.
    expect(Object.keys(headers)).not.toContain("h_table");
    expect(Object.keys(headers)).not.toContain("h_array");
    expect(Object.keys(headers)).not.toContain("x-stream-offset");
    expect(all.properties).toMatchObject({
      content_type: "application/json",
      message_id: "msg-all-props-1",
      app_id: "libredb-fixture-seed",
    });
  });

  test("st-routes: the exchange and routing key each message was published through", async () => {
    const { result } = await replayRead(set, "read-st-routes");
    expect((result?.rows ?? []).map((row) => [row.exchange, row.routing_key])).toEqual([
      ["", "st-routes"],
      ["ex-routes-direct", "rk-a"],
      ["ex-routes-topic", "orders.eu.created"],
      ["ex-routes-direct", "rk-x"],
      ["", "st-routes"],
      ["", "st-routes"],
      ["", "st-routes"],
    ]);
  });

  test("st-amqp10: AMQP 1.0 value and sequence bodies are labelled, data sections are plain bytes", async () => {
    const { result } = await replayRead(set, "read-st-amqp10");
    expect((result?.rows ?? []).map((row) => row.payload_encoding)).toEqual([
      "amqp-1.0",
      "amqp-1.0",
      "amqp-1.0",
      "text",
      "text",
      "text",
      "amqp-1.0",
      "amqp-1.0",
      "text",
    ]);
    expect(result?.rows[3]).toMatchObject({ payload: "part1-part2" });
  });

  test("st-spoof: a type property alone never makes a body AMQP 1.0", async () => {
    const { result } = await replayRead(set, "read-st-spoof");
    expect((result?.rows ?? []).map((row) => row.payload_encoding)).toEqual(["amqp-1.0", "text", "text"]);
    expect(result?.rows[1]).toMatchObject({ payload: "plain data" });
  });

  test("st-hostile-headers: prototype names are own keys, and the deep and wide tables are bounded", async () => {
    const { result } = await replayRead(set, "read-st-hostile-headers");
    const [names, deep, wide, markup] = result?.rows ?? [];
    const headers = names.headers as Record<string, unknown>;
    for (const key of ["__proto__", "constructor", ""]) expect(Object.hasOwn(headers, key)).toBe(true);
    expect(Object.getPrototypeOf(headers)).toBe(Object.prototype);
    expect(JSON.stringify(deep.headers)).toContain("nested deeper than");
    expect(JSON.stringify(wide.headers).length).toBeLessThan(70_000);
    expect(markup).toMatchObject({ payload_encoding: "text", payload: "<img src=x onerror=alert(1)>" });
  });

  test("st-buffer-shape: a JSON payload shaped like a Node Buffer reaches the grid as JSON, which shows it as bytes", async () => {
    const { result } = await replayRead(set, "read-st-buffer-shape");
    const [row] = result?.rows ?? [];
    expect(row).toMatchObject({ payload_encoding: "json", payload: { type: "Buffer", data: [1, 2, 3], note: "json" } });
    // Today's grid behaviour, pinned as the spec asks: U119 in docs/BACKLOG.md. When U119 lands this becomes "json".
    expect(classifyValue(row.payload)).toBe("binary");
  });

  test("st-events last: the broker's last chunk, ascending, ending at offset 999", async () => {
    const { result } = await replayRead(set, "read-st-events-last");
    const read = offsets(result).map(Number);
    expect(read.length).toBeGreaterThan(0);
    expect(read.at(-1)).toBe(999);
    expect(read).toEqual([...read].sort((a, b) => a - b));
  });

  test("st-g2-poison-mid from first: offsets 0 and 1, then the conversion warning naming offset 1", async () => {
    const { result } = await replayRead(set, "read-st-g2-poison-mid-first");
    expect(offsets(result)).toEqual(["0", "1"]);
    expect(warnings(result)).toContain(conversionAfter(BigInt(1), RABBITMQ_PREFETCH_MAX, "/", "st-g2-poison-mid"));
  });

  test("a read that starts at a poison message returns no result presented as complete", async () => {
    for (const [name, stream, start] of [
      ["read-st-g2-poison-mid-offset-2-limit-1", "st-g2-poison-mid", 2],
      ["read-h1-props-offset-1-limit-1", "h1-props", 1],
      ["read-h3-solo-offset-2-limit-1", "h3-solo", 2],
    ] as const) {
      const { error } = await replayRead(set, name);
      expect(error).toBeInstanceOf(QueryError);
      expect(error?.message).toBe(conversionNoRowNumeric(BigInt(start), 1, "/", stream));
    }
  });

  test("g9-poison and h3-wide: the rows before the poison, then a warning naming the last offset delivered", async () => {
    for (const [name, stream] of [
      ["read-g9-poison-first", "g9-poison"],
      ["read-h3-wide-first", "h3-wide"],
    ] as const) {
      const { result } = await replayRead(set, name);
      const read = offsets(result);
      expect(read).toEqual(read.map((_offset, index) => String(index)));
      const last = BigInt(read.length - 1);
      expect(warnings(result)).toContain(conversionAfter(last, RABBITMQ_PREFETCH_MAX, "/", stream));
    }
  });

  test("401 not_authorized at /api/whoami is the authentication sentence, with no broker text and no password", async () => {
    const { provider } = replayed(set, "error-401-not-authorized", null);
    const error = await provider.connect().catch((e: Error) => e);
    const capture = loadManagementCapture(set, "error-401-not-authorized");
    const whoami = capture.exchanges.find((e) => e.path === "/api/whoami");
    expect(error).toBeInstanceOf(AuthenticationError);
    expect((error as Error).message).toBe(
      managementStatusError(401, whoami?.body ?? "", {
        endpoint: endpointText("127.0.0.1", 15672),
        route: MANAGEMENT_ROUTES.whoami.label,
        scope: "whoami",
        site: "connect",
      }).message,
    );
    expect((error as Error).message).not.toContain("not_authorized");
  });

  test("401 Not management user and the localhost-only 401 each have their own sentence", async () => {
    for (const name of ["error-401-not-management-user", "error-401-localhost-only"]) {
      const { provider } = replayed(set, name, null);
      const error = await provider.connect().catch((e: Error) => e);
      const whoami = loadManagementCapture(set, name).exchanges.find((e) => e.path === "/api/whoami");
      expect((error as Error).message).toBe(
        managementStatusError(401, whoami?.body ?? "", {
          endpoint: endpointText("127.0.0.1", 15672),
          route: MANAGEMENT_ROUTES.whoami.label,
          scope: "whoami",
          site: "connect",
        }).message,
      );
    }
  });

  test("a vhost that does not exist counts as unavailable, never 0", async () => {
    const { provider } = replayed(set, "error-404", null);
    await provider.connect();
    const counts = await provider.countObjects(["evidence-missing"]);
    for (const kind of ["stream", "queue", "exchange"]) {
      expect(counts[kind]).toEqual({ unavailable: vhostUnavailableSentence("evidence-missing") });
    }
    await provider.disconnect();
  });

  test("a queue the source asks for that is gone is the missing-object sentence, with no broker text", async () => {
    const { provider } = replayed(set, "error-404", null);
    await provider.connect();
    const error = await (provider.readObjectSource?.(["/", "q-missing"], "queue") ?? Promise.resolve()).catch(
      (e: Error) => e,
    );
    await provider.disconnect();
    const detail = loadManagementCapture(set, "error-404").exchanges.find(
      (e) => e.path === "/api/queues/%2F/q-missing",
    );
    expect(detail?.status).toBe(404);
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe(
      managementStatusError(404, detail?.body ?? "", {
        endpoint: endpointText("127.0.0.1", 15672),
        route: MANAGEMENT_ROUTES.queue.label,
        scope: "object",
        site: "browse",
        vhost: "/",
        name: "q-missing",
      }).message,
    );
    expect((error as Error).message).not.toContain("Object Not Found");
  });

  test("a read of a stream that is gone ends at the type check with the missing-object sentence", async () => {
    // A closed port: the type check answers first, so the read never dials it.
    const { provider } = replayed(set, "error-404", await closedPort());
    await provider.connect();
    const error = await provider
      .query('{"vhost": "/", "stream": "st-missing", "from": "first", "limit": 1}')
      .catch((e: Error) => e);
    await provider.disconnect();
    const detail = loadManagementCapture(set, "error-404").exchanges.find(
      (e) => e.path === "/api/queues/%2F/st-missing",
    );
    expect(detail?.status).toBe(404);
    expect(error).toBeInstanceOf(QueryError);
    expect((error as Error).message).toBe(
      managementStatusError(404, detail?.body ?? "", {
        endpoint: endpointText("127.0.0.1", 15672),
        route: MANAGEMENT_ROUTES["stream-type"].label,
        scope: "object",
        site: "read",
        vhost: "/",
        name: "st-missing",
      }).message,
    );
    expect((error as Error).message).not.toContain("Object Not Found");
  });

  test("both 530 forms and the consume 403 each end the read with the close's own sentence", async () => {
    const typeCheck = {
      status: 200,
      body: '{"type":"stream","online":["n"],"members":["n"]}',
      contentType: "application/json",
    };
    for (const [name, until, vhost, stream] of [
      ["error-530-access-refused", "connection.open", "evidence-refused", "s"],
      ["error-530-vhost-not-found", "connection.open", "evidence-missing", "s"],
      ["error-403-consume", "basic.consume", "/", "st-restricted"],
    ] as const) {
      const capture = loadAmqpCapture(set, name);
      const close = lastMethodFrame(captureBytes(capture));
      const peer = await startFakePeer(stepsToClose(until, close));
      peers.push(peer);
      // Built: the 530 captures were taken with the type check answered as a stream, so it is answered so here too.
      const typeCheckUrl = `http://127.0.0.1:15672/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(stream)}?columns=type,online,members&disable_stats=true`;
      const built =
        name === "error-403-consume" ? {} : { [requestKey({ method: "GET", url: typeCheckUrl })]: typeCheck };
      const { provider } = replayed(
        set,
        name === "error-403-consume" ? "error-403-consume" : "session-studio-reader",
        peer.port,
        undefined,
        built,
      );
      await provider.connect();
      const error = await provider
        .query(`{"vhost": ${JSON.stringify(vhost)}, "stream": ${JSON.stringify(stream)}, "from": "first", "limit": 1}`)
        .catch((e: Error) => e);
      await provider.disconnect();
      expect((error as Error).message).toBe(
        amqpCloseError(closeOf(close), {
          endpoint: endpointText("127.0.0.1", peer.port),
          vhost,
          stream,
          online: ["n"],
          members: ["n"],
        }).message,
      );
      expect((error as Error).message).not.toContain("studio-reader");
    }
  });
});

describe("RabbitMQ 4.3.6, a vhost above 500 queues and 500 streams", () => {
  test("the Streams folder is full and holds the 500 streams that sort last; the Queues total is a sample", async () => {
    const { provider } = replayed("4.3.6", "listing-500-plus", null);
    await provider.connect();
    const counts = await provider.countObjects(["evidence-listing"]);
    expect(counts.stream).toEqual({ count: 500, sampledFrom: streamsSampledFrom(1031, 500) });
    expect(counts.queue).toEqual({ count: 500, sampledFrom: queuesSampledFrom(1031, null) });
    const streams = await provider.listObjects(["evidence-listing"], "stream");
    expect(streams.map((s) => s.name)).toEqual(
      Array.from({ length: 500 }, (_, n) => `c-s-${String(n + 10).padStart(3, "0")}`),
    );
    await provider.disconnect();
  });
});

describe("RabbitMQ 4.3.6, the stream read with no running replica", () => {
  test("the 406 no-replica close names the stream's members", async () => {
    const capture = loadAmqpCapture("4.3.6", "error-406-no-replica");
    const close = lastMethodFrame(captureBytes(capture));
    const peer = await startFakePeer(stepsToClose("basic.consume", close));
    peers.push(peer);
    const { provider } = replayed("4.3.6", "no-replica", peer.port);
    await provider.connect();
    const error = await provider
      .query('{"vhost": "evidence-cluster", "stream": "st-solo", "from": "first", "limit": 1}')
      .catch((e: Error) => e);
    await provider.disconnect();
    const detail = loadManagementCapture("4.3.6", "no-replica").exchanges.find(
      (e) => e.path === "/api/queues/evidence-cluster/st-solo" && e.query.startsWith("columns=type,online,members"),
    );
    expect(detail).toBeDefined();
    const answer = JSON.parse(detail?.body ?? "") as { online: string[]; members: string[] };
    expect((error as Error).message).toBe(
      amqpCloseError(closeOf(close), {
        endpoint: endpointText("127.0.0.1", peer.port),
        vhost: "evidence-cluster",
        stream: "st-solo",
        online: answer.online,
        members: answer.members,
      }).message,
    );
  });
});

describe("the conversion-fix build, replayed", () => {
  test("the poison messages arrive with the values the broker could not convert removed", async () => {
    const { result } = await replayRead("nightly", "read-st-g2-poison-mid-first");
    expect(offsets(result)).toEqual(["0", "1", "2", "3"]);
    expect(Object.keys((result?.rows[2]?.headers ?? {}) as object)).not.toContain("p_uuid");
    expect(warnings(result).some((w) => w.includes("541"))).toBe(false);
  });

  test("a nested map whose key was a uuid arrives as an empty table, shown and not hidden", async () => {
    const { result } = await replayRead("nightly", "read-st-uuid-key");
    const headers = (result?.rows[0]?.headers ?? {}) as Record<string, unknown>;
    expect(headers["x-map"]).toEqual({});
  });
});

describe("the three routes' full JSON bodies on Node (R-S5, R-S7)", () => {
  // tests/unit/db/rabbitmq/query-route.test.ts holds these bodies under Bun, the runner's runtime; production serves
  // the routes on Node, whose JSON.parse quotes the first bytes of a body it refuses and whose JSON.stringify has its
  // own depth limit. So the same cases run here in a Node child, as tests/unit/db/http/node-transport-runtimes.test.ts
  // runs the transport: Bun.build({ target: "node" }) bundles the three route modules and the real provider, with the
  // session and the provider lookup swapped at build time for small modules this block writes (a Node child cannot
  // use mock.module), and the child dials fake peers this process runs. NODE_TRANSPORT_NODES names the Node binaries
  // as that file reads it; otherwise the node on PATH runs them, Node 24 in CI.
  const ROOT = join(import.meta.dir, "../../..");
  const SENTINEL = "PEER-SENTINEL";
  const CONNECTION = rabbitmqConnection();
  const USERNAME = CONNECTION.user as string;
  const PASSWORD = CONNECTION.password as string;
  const READ = JSON.stringify({ vhost: "/", stream: "orders" });
  const MARKUP = { status: 200, text: `<html>${SENTINEL}` };
  const STREAM = { status: 200, text: '{"type":"stream","online":["rabbit@a"],"members":["rabbit@a"]}' };
  const VHOST_REFUSED = "NOT_ALLOWED - access to vhost '/' refused for user";
  const nested = (depth: number) => `${"[".repeat(depth)}${"]".repeat(depth)}`;
  const DEEP: Readonly<Record<string, string>> = {
    "an 8,920-byte [[[...]]] body": nested(4460),
    "a 262,144-byte [[[...]]] body": nested(131072),
    "a 4,000-character string of ] and } then nesting to depth 4,460": `["${"]}".repeat(2000)}",${nested(4459)}]`,
  };

  interface Answer {
    readonly status: number;
    readonly text: string;
  }
  interface RouteCase {
    readonly route: "query" | "test-connection" | "objects/source";
    readonly body: Record<string, unknown>;
    readonly rest: Answer;
    readonly whoami?: Answer;
    readonly amqpPort?: number;
    readonly connect: boolean;
  }
  interface RouteOutcome {
    readonly status: number;
    readonly text: string;
    readonly requested: readonly string[];
  }

  const routePeers: Record<string, FakePeer> = {};
  const cases: Record<string, RouteCase> = {};
  let dir = "";

  /** The Node binaries NODE_TRANSPORT_NODES lists, or the node on PATH, as node-transport-runtimes.test.ts reads them. */
  function nodeBinaries(): string[] {
    const listed = process.env.NODE_TRANSPORT_NODES;
    if (listed !== undefined) return listed.split(delimiter).filter((entry) => entry !== "");
    const onPath = Bun.which("node");
    if (onPath === null)
      throw new Error("No node on PATH: the three routes run on Node in production; install Node 24");
    return [onPath];
  }

  beforeAll(async () => {
    // Inside the checkout's node_modules, so the packages production keeps out of the server bundle resolve as there.
    mkdirSync(join(ROOT, "node_modules", ".cache"), { recursive: true });
    dir = mkdtempSync(join(ROOT, "node_modules", ".cache", "rabbitmq-routes-node-"));
    const at = (name: string) => join(dir, name);
    const source = (relative: string) => JSON.stringify(join(ROOT, relative));
    const listed = /serverExternalPackages:\s*\[([^\]]*)\]/.exec(readFileSync(join(ROOT, "next.config.ts"), "utf8"));
    const external = [...(listed?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((match) => match[1] as string);
    expect(external).toContain("@duckdb/node-api");

    routePeers["530 at open"] = await startFakePeer([
      { expect: "protocol-header" },
      { send: serverFrames.connectionStart() },
      { expect: { classId: 10, methodId: 11 } },
      { send: serverFrames.tune() },
      { expect: { classId: 10, methodId: 31 } },
      { expect: { classId: 10, methodId: 40 } },
      { send: serverFrames.connectionClose(530, `${VHOST_REFUSED} '${USERNAME}'`, 10, 40) },
    ]);
    await Promise.all(
      Object.entries(DEEP).map(async ([name, text]) => {
        const body = new TextEncoder().encode(text);
        const steps: PeerStep[] = [
          ...handshakeSteps(),
          { send: message({ deliveryTag: BigInt(1), offset: BigInt(3), body, routingKey: "orders" }) },
          { expect: { classId: 60, methodId: 80 } },
          { expect: { classId: 10, methodId: 50 } },
          { send: serverFrames.closeOk() },
          { end: "close" },
        ];
        routePeers[name] = await startFakePeer(steps);
      }),
    );
    cases["query: the type check answering markup"] = {
      route: "query",
      body: { sql: READ },
      rest: MARKUP,
      connect: true,
    };
    cases["query: 530 at open naming the user"] = {
      route: "query",
      body: { sql: READ },
      rest: STREAM,
      amqpPort: routePeers["530 at open"]?.port,
      connect: true,
    };
    for (const name of Object.keys(DEEP)) {
      cases[`query: ${name}`] = {
        route: "query",
        body: { sql: READ },
        rest: STREAM,
        amqpPort: routePeers[name]?.port,
        connect: true,
      };
    }
    cases["test-connection: whoami answering markup"] = {
      route: "test-connection",
      body: {},
      rest: STREAM,
      whoami: MARKUP,
      connect: false,
    };
    cases["objects/source: the detail GET answering markup"] = {
      route: "objects/source",
      body: { path: ["/", "orders"], kind: "stream" },
      rest: MARKUP,
      connect: true,
    };
    writeFileSync(at("cases.json"), JSON.stringify(cases));

    writeFileSync(
      at("auth-seam.ts"),
      `export * from ${source("src/lib/auth.ts")};\nexport async function getSession() { return { role: "admin", username: "admin" }; }\nexport async function readSession() { return { kind: "authenticated", session: { role: "admin", username: "admin" } }; }\n`,
    );
    // One provider slot behind both lookups the routes use: `@/lib/db` (query, object source) and `@/lib/db/factory`
    // (Test Connection). A module's own export wins over a name `export *` brings.
    writeFileSync(
      at("provider-slot.ts"),
      [
        "let current: unknown;",
        "export function useProvider(provider: unknown) { current = provider; }",
        "export async function getOrCreateProvider() { return current; }",
        "export async function createDatabaseProvider() { return current; }",
        "",
      ].join("\n"),
    );
    for (const [file, real] of [
      ["db-seam.ts", "src/lib/db/index.ts"],
      ["factory-seam.ts", "src/lib/db/factory.ts"],
    ] as const) {
      writeFileSync(
        at(file),
        `export * from ${source(real)};\nexport { createDatabaseProvider, getOrCreateProvider } from "./provider-slot.ts";\n`,
      );
    }
    writeFileSync(
      at("child.ts"),
      [
        'import { readFileSync, writeFileSync } from "node:fs";',
        `import { POST as query } from ${source("src/app/api/db/query/route.ts")};`,
        `import { POST as testConnection } from ${source("src/app/api/db/test-connection/route.ts")};`,
        `import { POST as objectSource } from ${source("src/app/api/db/objects/source/route.ts")};`,
        `import { clearRateLimitState } from ${source("src/lib/api/rate-limit.ts")};`,
        `import { RabbitMQProvider } from ${source("src/lib/db/providers/stream/rabbitmq/index.ts")};`,
        `import { rabbitmqConnection } from ${source("tests/helpers/rabbitmq-connection.ts")};`,
        'import { useProvider } from "./provider-slot.ts";',
        'const routes = { query, "test-connection": testConnection, "objects/source": objectSource };',
        'const cases = JSON.parse(readFileSync(process.argv[2], "utf8"));',
        "const outcomes = {};",
        "for (const [name, each] of Object.entries(cases)) {",
        "  clearRateLimitState();",
        "  const requested = [];",
        "  const connection = rabbitmqConnection(each.amqpPort === undefined ? {} : { amqpPort: String(each.amqpPort) });",
        "  const answer = (path) => {",
        '    if (path.endsWith("/api/whoami"))',
        '      return each.whoami ?? { status: 200, text: JSON.stringify({ name: connection.user, tags: ["management"] }) };',
        '    if (path.endsWith("/api/overview"))',
        '      return { status: 200, text: JSON.stringify({ rabbitmq_version: "4.3.6", product_name: "RabbitMQ" }) };',
        "    return each.rest;",
        "  };",
        "  const managementTransport = () => ({",
        "    async request(request) {",
        "      const path = new URL(request.url).pathname;",
        "      requested.push(path);",
        "      const { status, text } = answer(path);",
        '      return { status, contentType: "application/json", retryAfter: null, text };',
        "    },",
        "    close() {},",
        "  });",
        "  const provider = new RabbitMQProvider(connection, {}, { managementTransport });",
        "  if (each.connect) await provider.connect();",
        "  useProvider(provider);",
        "  const request = new Request(`http://localhost:3000/api/db/${each.route}`, {",
        '    method: "POST",',
        '    headers: { "content-type": "application/json" },',
        "    body: JSON.stringify({ connection, ...each.body }),",
        "  });",
        "  const response = await routes[each.route](request);",
        "  outcomes[name] = { status: response.status, text: await response.text(), requested };",
        "  await provider.disconnect();",
        "}",
        "writeFileSync(process.argv[3], JSON.stringify({ runtime: process.version, outcomes }));",
        "process.exit(0);",
        "",
      ].join("\n"),
    );
    const build = await Bun.build({
      entrypoints: [at("child.ts")],
      target: "node",
      format: "esm",
      outdir: dir,
      external,
      plugins: [
        {
          name: "route-seams",
          setup(builder) {
            builder.onResolve({ filter: /^@\/lib\/auth$/ }, () => ({ path: at("auth-seam.ts") }));
            builder.onResolve({ filter: /^@\/lib\/db$/ }, () => ({ path: at("db-seam.ts") }));
            builder.onResolve({ filter: /^@\/lib\/db\/factory$/ }, () => ({ path: at("factory-seam.ts") }));
          },
        },
      ],
    });
    if (!build.success) throw new Error(`Bun.build could not bundle the route child: ${build.logs.join("\n")}`);
  }, 120_000);

  afterAll(async () => {
    await Promise.all(Object.values(routePeers).map((peer) => peer.stop()));
    rmSync(dir, { recursive: true, force: true });
  });

  for (const binary of nodeBinaries()) {
    describe(`in a Node child, ${binary}`, () => {
      let outcomes: Record<string, RouteOutcome> = {};
      let runtime = "";

      beforeAll(async () => {
        const out = join(dir, `report-${Bun.hash(binary)}.json`);
        const env: Record<string, string> = {};
        for (const [name, value] of Object.entries(process.env)) {
          if (value !== undefined && name !== "DB_HTTP_BLOCK_PRIVATE_HOSTS") env[name] = value;
        }
        const child = Bun.spawn([binary, join(dir, "child.js"), join(dir, "cases.json"), out], {
          cwd: dir,
          env,
          stdout: "ignore",
          stderr: "pipe",
        });
        const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited]);
        if (exitCode !== 0) throw new Error(`The route child ${binary} exited ${exitCode}: ${stderr}`);
        const report = JSON.parse(readFileSync(out, "utf8")) as {
          runtime: string;
          outcomes: Record<string, RouteOutcome>;
        };
        outcomes = report.outcomes;
        runtime = report.runtime;
      }, 120_000);

      test("the child ran on the Node binary it was asked for", () => {
        expect(runtime).toBe(Bun.spawnSync([binary, "--version"]).stdout.toString().trim());
      });

      test("every case reached its seam, and no body holds the account, the broker's text or a parser's quote", () => {
        expect(Object.keys(outcomes).sort()).toEqual(Object.keys(cases).sort());
        for (const [name, outcome] of Object.entries(outcomes)) {
          const target = cases[name]?.route === "test-connection" ? "/api/whoami" : "/api/queues/%2F/orders";
          expect({ name, reached: outcome.requested.some((path) => path.endsWith(target)) }).toEqual({
            name,
            reached: true,
          });
          for (const banned of [USERNAME, PASSWORD, SENTINEL, VHOST_REFUSED, "Unexpected token", "<html"]) {
            expect({ name, banned, found: outcome.text.includes(banned) }).toEqual({ name, banned, found: false });
          }
        }
        expect(routePeers["530 at open"]?.dials).toBe(1);
        expect(outcomes["query: 530 at open naming the user"]?.status).toBe(401);
      });

      test("each body nested past the depth rule answers 200 with one base64 row of its exact size", () => {
        for (const [name, text] of Object.entries(DEEP)) {
          const outcome = outcomes[`query: ${name}`];
          const rows = (JSON.parse(outcome?.text ?? "{}") as { rows?: Record<string, unknown>[] }).rows ?? [];
          expect({ name, status: outcome?.status, rows: rows.length }).toEqual({ name, status: 200, rows: 1 });
          expect({ name, encoding: rows[0]?.payload_encoding, bytes: rows[0]?.payload_bytes }).toEqual({
            name,
            encoding: "base64",
            bytes: new TextEncoder().encode(text).length,
          });
        }
      });
    });
  }
});
