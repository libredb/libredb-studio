/**
 * Seeds the broker a <version>/agent-boundary/run.sh started, sends every call the agent's closed table refuses raw,
 * as a user that may read every queue of the virtual host, runs the agent's own reads through the provider, and
 * writes what the broker answered into that run.sh's directory.
 *
 *   bun tests/live/rabbitmq-agent-boundary.ts
 *
 * The environment names the broker: RABBITMQ_AGENT_HOST, RABBITMQ_AGENT_MANAGEMENT_PORT, RABBITMQ_AGENT_AMQP_PORT,
 * RABBITMQ_AGENT_ADMIN_PASSWORD (the password run.sh made for the container's administrator), RABBITMQ_AGENT_IMAGE
 * (the image with its digest) and RABBITMQ_AGENT_OUT (the directory to write). The reader's password is made here for
 * the run and stays in this process; the script refuses to write a capture that holds either password.
 *
 * The refused calls are sent with the test-only AMQP client of tests/helpers and with plain HTTP, never through the
 * provider: no Studio check stands in front of them, which is the point, since what is measured is what the broker
 * does on its own with each one. Every queue's message count is read before and after each call with a passive
 * queue.declare, which the broker answers from the queue itself rather than from sampled statistics.
 *
 * Run by hand through run.sh, never by `bun run test`, which runs no file under tests/live/.
 */
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: a capture records what the broker holds then.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createNodeTransport } from "@/lib/db/http/node-transport";
import { RabbitMQProvider } from "@/lib/db/providers/stream/rabbitmq";
import type { ManagementTransportFactory } from "@/lib/db/providers/stream/rabbitmq/management/client";
import type { ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { rabbitmqConnection } from "../helpers/rabbitmq-connection";
import { AdminApi, type RabbitMQLiveTarget, segment } from "../helpers/rabbitmq-live";
import {
  ByteReader,
  contentFrames,
  methodFrame,
  methodId,
  type TestAmqpTarget,
  TestAmqpConnection,
  TestPublisher,
} from "../helpers/rabbitmq-test-amqp091";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const HOST = env("RABBITMQ_AGENT_HOST");
const MANAGEMENT_PORT = Number(env("RABBITMQ_AGENT_MANAGEMENT_PORT"));
const AMQP_PORT = Number(env("RABBITMQ_AGENT_AMQP_PORT"));
const ADMIN_PASSWORD = env("RABBITMQ_AGENT_ADMIN_PASSWORD");
const IMAGE = env("RABBITMQ_AGENT_IMAGE");
const OUT = env("RABBITMQ_AGENT_OUT");
const DATE = new Date().toISOString().slice(0, 10);
const VERSION = IMAGE.slice(IMAGE.indexOf(":") + 1, IMAGE.indexOf("-management"));

const ADMIN = "libredb-admin";
/** The agent's user: management tag, and on `/` no configure and no write, and a read pattern of every name. */
const READER = "agent-reader";
const READER_PASSWORD = randomBytes(18).toString("hex");
const SECRETS: readonly string[] = [ADMIN_PASSWORD, READER_PASSWORD];

const target: RabbitMQLiveTarget = {
  host: HOST,
  managementPort: MANAGEMENT_PORT,
  amqpPort: AMQP_PORT,
  prometheusPort: 0,
  adminUser: ADMIN,
  adminPassword: ADMIN_PASSWORD,
  fixturePassword: READER_PASSWORD,
  digest: IMAGE.slice(IMAGE.indexOf("@") + 1),
};
const admin = new AdminApi(target);
const reader = admin.as(READER, READER_PASSWORD);
const amqpAs = (username: string, password: string): TestAmqpTarget => ({
  host: HOST,
  port: AMQP_PORT,
  vhost: "/",
  username,
  password,
});
const ADMIN_AMQP = amqpAs(ADMIN, ADMIN_PASSWORD);
const READER_AMQP = amqpAs(READER, READER_PASSWORD);

/** The stream every stored value of the fixture sits in, each a marker no metadata answer may hold. */
const STREAM = "st-agent";
const EXCHANGE = "ex-agent";
const MARKERS = {
  body: "agent-marker-body",
  header: "agent-marker-header",
  headerName: "x-agent-marker-name",
  routingKey: "agent-marker-routing-key",
  messageId: "agent-marker-message-id",
  correlationId: "agent-marker-correlation-id",
  appId: "agent-marker-app-id",
  type: "agent-marker-type",
  contentType: "application/x-agent-marker",
  replyTo: "agent-marker-reply-to",
} as const;
const QUEUES = {
  classic: "q-classic",
  quorum: "q-quorum",
  purge: "q-purge",
  swapClassic: "st-swap-classic",
  swapQuorum: "st-swap-quorum",
} as const;

const encoder = new TextEncoder();

/** Every queue's message count, read with a passive queue.declare as the administrator. */
async function counts(): Promise<Record<string, number>> {
  const connection = await TestAmqpConnection.open(ADMIN_AMQP);
  const found: Record<string, number> = {};
  try {
    for (const queue of Object.values(QUEUES)) {
      connection.send(methodFrame(1, 50, 10, (w) => w.u16(0).shortstr(queue).u8(1).table([])));
      const ok = new ByteReader((await connection.expect(50, 11)).payload).skip(4);
      ok.shortstr();
      found[queue] = ok.u32();
    }
  } finally {
    await connection.close();
  }
  return found;
}

type Outcome =
  | { readonly outcome: "ok"; readonly detail: Record<string, unknown> }
  | { readonly outcome: "closed"; readonly replyCode: number; readonly scope: string }
  | { readonly outcome: "error"; readonly message: string };

/** One raw AMQP call as the reader: its outcome, by reply code when the broker closed the channel or connection. */
async function amqpCall(run: (connection: TestAmqpConnection) => Promise<Record<string, unknown>>): Promise<Outcome> {
  let connection: TestAmqpConnection | undefined;
  try {
    connection = await TestAmqpConnection.open(READER_AMQP);
    return { outcome: "ok", detail: await run(connection) };
  } catch (error) {
    const replyCode = (error as { replyCode?: number }).replyCode;
    if (replyCode !== undefined) {
      const scope = (error as Error).message.includes("channel") ? "channel" : "connection";
      return { outcome: "closed", replyCode, scope };
    }
    return { outcome: "error", message: (error as Error).message };
  } finally {
    await connection?.close().catch(() => undefined);
  }
}

/** The next frame within `ms`, or undefined when none arrives: a consume that delivers nothing ends here. */
async function nextWithin(connection: TestAmqpConnection, ms: number) {
  return Promise.race([connection.next(), sleep(ms).then(() => undefined)]);
}

/** basic.consume of `queue` with prefetch 1, with or without `x-stream-offset: first`; acks the one delivery. */
async function consumeOne(connection: TestAmqpConnection, queue: string, streamOffset: boolean) {
  connection.send(methodFrame(1, 60, 10, (w) => w.u32(0).u16(1).u8(0)));
  await connection.expect(60, 11);
  const args = streamOffset ? [["x-stream-offset", { t: "S", v: "first" }] as const] : [];
  connection.send(methodFrame(1, 60, 20, (w) => w.u16(0).shortstr(queue).shortstr("agent-probe").u8(0).table(args)));
  await connection.expect(60, 21);
  const deliver = await nextWithin(connection, 3_000);
  if (deliver === undefined) return { delivered: 0 };
  const id = methodId(deliver.payload);
  if (id.classId !== 60 || id.methodId !== 60) return { delivered: 0, frame: `${id.classId}.${id.methodId}` };
  const fields = new ByteReader(deliver.payload).skip(4);
  fields.shortstr();
  const tag = fields.u64();
  await connection.next();
  await connection.next();
  connection.send(methodFrame(1, 60, 80, (w) => w.u64(tag).u8(0)));
  await sleep(500);
  return { delivered: 1, acked: true };
}

/** basic.get with no-ack: the broker removes the message it hands over. */
async function getOne(connection: TestAmqpConnection, queue: string) {
  connection.send(methodFrame(1, 60, 70, (w) => w.u16(0).shortstr(queue).u8(1)));
  const answer = await connection.next();
  const id = methodId(answer.payload);
  if (id.classId === 60 && id.methodId === 72) return { answer: "get-empty" };
  await connection.next();
  await connection.next();
  return { answer: "get-ok" };
}

/** One HTTP call to the management API as the reader: its status, never its body, which can echo a message. */
async function httpCall(method: "DELETE" | "POST", pathname: string, body?: unknown) {
  const answer = await reader.call(method, pathname, body, [200, 201, 204, 400, 401, 403, 404, 405]);
  return { outcome: "http", status: answer.status };
}

async function refusedCall(name: string, call: () => Promise<unknown>) {
  const before = await counts();
  const outcome = await call();
  // A take settles within the call; the wait covers an acknowledgement still in flight when the call returned.
  await sleep(500);
  const after = await counts();
  return { name, before, outcome, after };
}

/** A provider for the reader under `execution`, its type check optionally answering "stream" for every name. */
function readerProvider(execution: ProviderExecutionContext, liarTypeCheck = false): RabbitMQProvider {
  const connection: DatabaseConnection = rabbitmqConnection({
    host: HOST,
    port: MANAGEMENT_PORT,
    amqpPort: String(AMQP_PORT),
    user: READER,
    password: READER_PASSWORD,
  });
  const transport: ManagementTransportFactory = liarTypeCheck
    ? streamTypeCheck(createNodeTransport)
    : createNodeTransport;
  return new RabbitMQProvider(connection, {}, execution, { managementTransport: transport });
}

/** A transport whose type check answers "stream" for every name, so a read reaches the AMQP side of its refusal. */
function streamTypeCheck(inner: ManagementTransportFactory): ManagementTransportFactory {
  return (options) => {
    const transport = inner(options);
    return {
      async request(request) {
        const url = new URL(request.url);
        if (url.searchParams.get("columns") === "type,online,members") {
          return {
            status: 200,
            contentType: "application/json",
            retryAfter: null,
            text: '{"type":"stream","online":["n"],"members":["n"]}',
          };
        }
        return transport.request(request);
      },
      close: () => transport.close(),
    };
  };
}

const AGENT: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 200, maxResultBytes: 1_048_576, statementTimeoutMs: 15_000 };

async function settle<T>(run: () => Promise<T>): Promise<{ readonly value?: T; readonly error?: string }> {
  try {
    return { value: await run() };
  } catch (error) {
    return { error: `${(error as Error).name}: ${(error as Error).message}` };
  }
}

async function seed(): Promise<void> {
  await admin.call("PUT", `/api/users/${READER}`, { password: READER_PASSWORD, tags: "management" });
  await admin.call("PUT", `/api/permissions/%2F/${READER}`, { configure: "^$", write: "^$", read: ".*" });
  const declare = (name: string, type: string) =>
    admin.call("PUT", `/api/queues/%2F/${segment(name)}`, { durable: true, arguments: { "x-queue-type": type } });
  await declare(STREAM, "stream");
  await declare(QUEUES.classic, "classic");
  await declare(QUEUES.quorum, "quorum");
  await declare(QUEUES.purge, "classic");
  await declare(QUEUES.swapClassic, "stream");
  await declare(QUEUES.swapQuorum, "stream");
  await admin.call("PUT", `/api/exchanges/%2F/${EXCHANGE}`, { type: "direct", durable: true });
  await admin.call("POST", `/api/bindings/%2F/e/${EXCHANGE}/q/${STREAM}`, { routing_key: MARKERS.routingKey });
  const publisher = await TestPublisher.open(ADMIN_AMQP);
  try {
    for (let n = 0; n < 5; n += 1) {
      await publisher.publish(EXCHANGE, MARKERS.routingKey, encoder.encode(`${MARKERS.body}-${n}`), {
        contentType: MARKERS.contentType,
        headers: [[MARKERS.headerName, { t: "S", v: `${MARKERS.header}-${n}` }]],
        messageId: `${MARKERS.messageId}-${n}`,
        correlationId: MARKERS.correlationId,
        appId: MARKERS.appId,
        type: MARKERS.type,
        replyTo: MARKERS.replyTo,
        userId: ADMIN,
        timestamp: BigInt(1_700_000_000 + n),
        deliveryMode: 2,
      });
    }
    for (const queue of [QUEUES.classic, QUEUES.quorum, QUEUES.purge]) {
      for (let n = 0; n < 3; n += 1)
        await publisher.publish("", queue, encoder.encode(`${MARKERS.body}-${queue}-${n}`));
    }
  } finally {
    await publisher.close();
  }
}

/** Replaces the stream `name` with a queue of `type` holding one message: a queue declared under a stream's name. */
async function swap(name: string, type: "classic" | "quorum"): Promise<void> {
  await admin.call("DELETE", `/api/queues/%2F/${segment(name)}`);
  await admin.call("PUT", `/api/queues/%2F/${segment(name)}`, { durable: true, arguments: { "x-queue-type": type } });
  const publisher = await TestPublisher.open(ADMIN_AMQP);
  try {
    await publisher.publish("", name, encoder.encode(`${MARKERS.body}-${name}`));
  } finally {
    await publisher.close();
  }
}

async function main(): Promise<void> {
  await seed();
  const before = await counts();

  const editorRead = readerProvider({});
  await editorRead.connect();
  const editor = await settle(() =>
    editorRead.query(JSON.stringify({ vhost: "/", stream: STREAM, from: "first", limit: 2 })),
  );
  await editorRead.disconnect();

  const refused = [];
  refused.push(await refusedCall("basic.get no-ack, classic", () => amqpCall((c) => getOne(c, QUEUES.classic))));
  refused.push(await refusedCall("basic.get no-ack, quorum", () => amqpCall((c) => getOne(c, QUEUES.quorum))));
  refused.push(
    await refusedCall("basic.consume and ack, no x-stream-offset, classic", () =>
      amqpCall((c) => consumeOne(c, QUEUES.classic, false)),
    ),
  );
  refused.push(
    await refusedCall("basic.consume and ack, no x-stream-offset, quorum", () =>
      amqpCall((c) => consumeOne(c, QUEUES.quorum, false)),
    ),
  );
  refused.push(
    await refusedCall("basic.consume with x-stream-offset, classic", () =>
      amqpCall((c) => consumeOne(c, QUEUES.classic, true)),
    ),
  );
  refused.push(
    await refusedCall("basic.consume with x-stream-offset, quorum", () =>
      amqpCall((c) => consumeOne(c, QUEUES.quorum, true)),
    ),
  );
  refused.push(
    await refusedCall("queue.purge over AMQP", () =>
      amqpCall(async (c) => {
        c.send(methodFrame(1, 50, 30, (w) => w.u16(0).shortstr(QUEUES.purge).u8(0)));
        const ok = new ByteReader((await c.expect(50, 31)).payload).skip(4);
        return { purged: ok.u32() };
      }),
    ),
  );
  const publisher = await TestPublisher.open(ADMIN_AMQP);
  for (let n = 0; n < 3; n += 1)
    await publisher.publish("", QUEUES.purge, encoder.encode(`${MARKERS.body}-refill-${n}`));
  await publisher.close();
  refused.push(
    await refusedCall("DELETE /api/queues/{vhost}/{name}/contents", () =>
      httpCall("DELETE", `/api/queues/%2F/${QUEUES.purge}/contents`),
    ),
  );
  refused.push(
    await refusedCall("POST /api/queues/{vhost}/{name}/get, ack_requeue_false", () =>
      httpCall("POST", `/api/queues/%2F/${QUEUES.classic}/get`, {
        count: 1,
        ackmode: "ack_requeue_false",
        encoding: "auto",
      }),
    ),
  );
  refused.push(
    await refusedCall("basic.publish", () =>
      amqpCall(async (c) => {
        c.send(
          methodFrame(1, 60, 40, (w) => w.u16(0).shortstr("").shortstr(QUEUES.classic).u8(0)),
          ...contentFrames(1, {}, encoder.encode("agent-probe-publish"), c.frameMax),
        );
        const answer = await nextWithin(c, 3_000);
        return { answer: answer === undefined ? "no answer" : "frame" };
      }),
    ),
  );
  refused.push(
    await refusedCall("POST /api/exchanges/{vhost}/amq.default/publish", () =>
      httpCall("POST", "/api/exchanges/%2F/amq.default/publish", {
        properties: {},
        routing_key: QUEUES.classic,
        payload: "agent-probe-publish",
        payload_encoding: "string",
      }),
    ),
  );
  refused.push(
    await refusedCall("queue.declare of a new queue", () =>
      amqpCall(async (c) => {
        c.send(methodFrame(1, 50, 10, (w) => w.u16(0).shortstr("agent-probe-declared").u8(0).table([])));
        await c.expect(50, 11);
        return { declared: true };
      }),
    ),
  );

  await swap(QUEUES.swapClassic, "classic");
  await swap(QUEUES.swapQuorum, "quorum");

  const agentReads = [];
  const handle = readerProvider(AGENT);
  await handle.connect();
  for (const request of [
    { vhost: "/", stream: STREAM, from: "first", limit: 10 },
    { vhost: "/", stream: STREAM, from: { offset: 3 }, limit: 1 },
    { vhost: "/", stream: QUEUES.classic, from: "first", limit: 1 },
    { vhost: "/", stream: QUEUES.quorum, from: "first", limit: 1 },
  ]) {
    const statement = JSON.stringify(request);
    const countsBefore = await counts();
    const answer = await settle(() => handle.queryReadOnly(statement, BUDGET));
    agentReads.push({ statement, countsBefore, answer, countsAfter: await counts() });
  }
  await handle.disconnect();

  const backstop = [];
  for (const queue of [QUEUES.swapClassic, QUEUES.swapQuorum]) {
    const liar = readerProvider(AGENT, true);
    await liar.connect();
    const statement = JSON.stringify({ vhost: "/", stream: queue, from: "first", limit: 1 });
    const countsBefore = await counts();
    const answer = await settle(() => liar.queryReadOnly(statement, BUDGET));
    await liar.disconnect();
    backstop.push({ statement, typeCheckAnswered: "stream", countsBefore, answer, countsAfter: await counts() });
  }

  const capture = {
    $captured: {
      image: IMAGE,
      version: VERSION,
      date: DATE,
      runtime: `bun ${Bun.version}`,
      user: `${READER}: tag management; on / configure ^$, write ^$, read .*`,
      note: "`refused` lists calls the agent's closed table never sends, each sent raw as the reader with every queue's message count read before and after, so each shows what the broker would do with it. `agent` is the provider's agent read, and `backstop` the same read with the type check answered as a stream for a classic and a quorum queue declared under a stream's name.",
    },
    markers: MARKERS,
    queues: QUEUES,
    before,
    editor,
    refused,
    agent: agentReads,
    backstop,
  };
  const text = `${JSON.stringify(capture, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`;
  for (const secret of SECRETS) if (text.includes(secret)) throw new Error("a capture would hold a password");
  writeFileSync(path.join(OUT, "boundary.json"), text);
}

await main();
