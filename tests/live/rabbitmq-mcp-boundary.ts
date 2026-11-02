/**
 * Live check of MCP's `run_rabbitmq_read` against the broker a <version>/mcp-boundary/run.sh started: it seeds two
 * virtual hosts, drives the MCP tool's own handler (`runStatement`) with the factory's own profiled acquisition, and
 * writes what each call answered into that run.sh's directory as `mcp-boundary.json`.
 *
 *   bun tests/live/rabbitmq-mcp-boundary.ts
 *
 * The environment names the broker: RABBITMQ_MCP_HOST, RABBITMQ_MCP_MANAGEMENT_PORT, RABBITMQ_MCP_AMQP_PORT,
 * RABBITMQ_MCP_ADMIN_PASSWORD (the password run.sh made for the container's administrator), RABBITMQ_MCP_IMAGE (the
 * image with its digest) and RABBITMQ_MCP_OUT (the directory to write). The narrow user's password is made here for
 * the run and stays in this process; the script refuses to write a capture that holds either password.
 *
 * WHY THIS EXISTS. `run_rabbitmq_read` serves RabbitMQ through the boundary agent mode uses: the connection is acquired
 * under the agent read-only profile and every request goes through the provider's `queryReadOnly`, whose structural
 * closed table (a read client that encodes no take, publish, purge or declare, the stream-only type check and the
 * `x-stream-offset` 406 backstop) is the boundary, and whose metadata-only projection answers each message's offset and
 * body size alone. The admission in front of it is defence in depth. So the script replays, through MCP:
 *
 *  - one accepted read per admitted start, the cut at max_rows, and each request the admission refuses before
 *    anything is acquired, then the same requests with the admission removed, refused by the provider's own reader;
 *  - the boundary with the admission removed: a classic queue refused at the type check, and a classic and a quorum
 *    queue declared under a stream's name, with the type check answered as a stream, refused by the broker's 406; the
 *    positive control is the administrator's raw `basic.get`, which removes a message from the same kind of queue;
 *  - the data scope: a user with read permission on one stream of `/` alone, naming a stream of another virtual host
 *    (one that exists and one that does not) and a stream of `/` outside its read pattern, each refused by the broker,
 *    with the wording that reaches the client recorded; the administrator, which the broker lets read every virtual
 *    host, reading the other one, answered offsets and sizes only; and no message marker in any answer;
 *  - the limits: a read past timeout_ms at its 500 ms minimum, and a client cancel of a read fed a message every 400
 *    ms, with the time the cancel was answered and the time the read itself settled;
 *  - every queue's message count, read with a passive queue.declare, the same before and after.
 *
 * Run by hand through run.sh, never by `bun run test`, which runs no file under tests/live/.
 */
// oxlint-disable no-await-in-loop -- each call runs after the one before, on purpose: a capture records what the broker holds then.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import { createNodeTransport } from "@/lib/db/http/node-transport";
import { RabbitMQProvider } from "@/lib/db/providers/stream/rabbitmq";
import type { ManagementTransportFactory } from "@/lib/db/providers/stream/rabbitmq/management/client";
import type { McpConnectionContext } from "@/lib/mcp/context";
import type { ToolResult } from "@/lib/mcp/output";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { type McpStatementArm, mcpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseConnection } from "@/lib/types";
import { AdminApi, type RabbitMQLiveTarget, segment } from "../helpers/rabbitmq-live";
import {
  ByteReader,
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

const HOST = env("RABBITMQ_MCP_HOST");
const MANAGEMENT_PORT = Number(env("RABBITMQ_MCP_MANAGEMENT_PORT"));
const AMQP_PORT = Number(env("RABBITMQ_MCP_AMQP_PORT"));
const ADMIN_PASSWORD = env("RABBITMQ_MCP_ADMIN_PASSWORD");
const IMAGE = env("RABBITMQ_MCP_IMAGE");
const OUT = env("RABBITMQ_MCP_OUT");
const DATE = new Date().toISOString().slice(0, 10);
const VERSION = IMAGE.slice(IMAGE.indexOf(":") + 1, IMAGE.indexOf("-management"));

const ADMIN = "libredb-admin";
/** The narrow user: management tag, and on `/` alone no configure, no write, and a read pattern of one stream. */
const NARROW = "mcp-narrow";
const NARROW_PASSWORD = randomBytes(18).toString("hex");
const SECRETS: readonly string[] = [ADMIN_PASSWORD, NARROW_PASSWORD];

const OTHER_VHOST = "tenant-b";
const STREAM = "st-mcp";
const PRIVATE_STREAM = "st-private";
const OTHER_STREAM = "st-other";
/** The stream the cancel probe publishes to while it reads, kept out of the counts. */
const TRICKLE_STREAM = "st-trickle";
const EXCHANGE = "ex-mcp";
const QUEUES = { classic: "q-classic", swapClassic: "st-swap-classic", swapQuorum: "st-swap-quorum" } as const;
const MARKERS = {
  body: "mcp-live-marker-body",
  header: "mcp-live-marker-header",
  headerName: "x-mcp-live-marker-name",
  routingKey: "mcp-live-marker-routing-key",
  messageId: "mcp-live-marker-message-id",
  correlationId: "mcp-live-marker-correlation-id",
  appId: "mcp-live-marker-app-id",
  type: "mcp-live-marker-type",
  contentType: "application/x-mcp-live-marker",
  replyTo: "mcp-live-marker-reply-to",
} as const;

const target: RabbitMQLiveTarget = {
  host: HOST,
  managementPort: MANAGEMENT_PORT,
  amqpPort: AMQP_PORT,
  prometheusPort: 0,
  adminUser: ADMIN,
  adminPassword: ADMIN_PASSWORD,
  fixturePassword: NARROW_PASSWORD,
  digest: IMAGE.slice(IMAGE.indexOf("@") + 1),
};
const admin = new AdminApi(target);
const amqpAs = (vhost: string): TestAmqpTarget => ({
  host: HOST,
  port: AMQP_PORT,
  vhost,
  username: ADMIN,
  password: ADMIN_PASSWORD,
});
const encoder = new TextEncoder();

const ARM = mcpStatementArm("run_rabbitmq_read");
/** The tool with its admission removed: what stands behind it is the boundary under test. */
const UNFENCED: McpStatementArm = { ...ARM, fence: () => null };

function seed(user: string, password: string): ManagedConnection {
  return {
    id: `seed:live-${user}`,
    name: user,
    seedId: `live-${user}`,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "rabbitmq",
    host: HOST,
    port: MANAGEMENT_PORT,
    amqpPort: String(AMQP_PORT),
    user,
    password,
    ssl: { mode: "disable" },
    createdAt: new Date(),
  } as ManagedConnection;
}

const narrow = seed(NARROW, NARROW_PASSWORD);
const broad = seed(ADMIN, ADMIN_PASSWORD);

/** A provider for `connection` under the agent profile whose type check answers "stream" for every name. */
async function liarProvider(connection: ManagedConnection): Promise<RabbitMQProvider> {
  const liar: ManagementTransportFactory = (options) => {
    const transport = createNodeTransport(options);
    return {
      async request(request) {
        if (new URL(request.url).searchParams.get("columns") === "type,online,members") {
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
  const provider = new RabbitMQProvider(
    connection as DatabaseConnection,
    {},
    { readOnly: true, sendsStatements: true },
    { managementTransport: liar },
  );
  await provider.connect();
  return provider;
}

interface Recorded {
  readonly acquired: readonly ExecutionProfile[];
  readonly isError: boolean;
  /** The answer's text blocks after the untrusted-content notice, or its one refusal. */
  readonly text: string;
  readonly rows?: unknown;
  readonly truncated?: unknown;
  readonly hint?: unknown;
}

function recorded(result: ToolResult, acquired: readonly ExecutionProfile[]): Recorded {
  const texts = result.content.map((part) => ("text" in part ? part.text : ""));
  const structured = result.structuredContent as Record<string, unknown> | undefined;
  return {
    acquired,
    isError: result.isError === true,
    text: structured === undefined ? texts.join(" ") : "<structured>",
    ...(structured === undefined
      ? {}
      : { rows: structured.rows, truncated: structured.truncated_by ?? null, hint: structured.hint }),
  };
}

/** One MCP call on `connection`, as the route makes it, under `signal`. */
async function mcp(
  connection: ManagedConnection,
  args: { readonly statement: string; readonly max_rows?: number; readonly timeout_ms?: number },
  options: {
    readonly arm?: McpStatementArm;
    readonly signal?: AbortSignal;
    readonly acquire?: (connection: ManagedConnection) => Promise<RabbitMQProvider>;
  } = {},
): Promise<Recorded> {
  const acquired: ExecutionProfile[] = [];
  const context = {
    caller: { username: "live", role: "admin" },
    visibleConnections: async () => [connection],
    resolve: async () => connection,
    acquire: (seeded: ManagedConnection, profile: ExecutionProfile) => {
      acquired.push(profile);
      return options.acquire === undefined ? acquireExecutionProfileProvider(seeded, profile) : options.acquire(seeded);
    },
  } as unknown as McpConnectionContext;
  const arm = options.arm ?? ARM;
  const input = arm.inputSchema.parse({ connection_id: connection.id, ...args }) as McpStatementInput;
  const result = await runStatement(arm, input, { context, signal: options.signal ?? new AbortController().signal });
  return recorded(result, acquired);
}

const request = (vhost: string, stream: string, from: unknown, limit: number) =>
  JSON.stringify({ vhost, stream, from, limit });

/** Every queue's message count, read with a passive queue.declare as the administrator. */
async function counts(): Promise<Record<string, number>> {
  const found: Record<string, number> = {};
  for (const [vhost, queue] of [
    ["/", STREAM],
    ["/", PRIVATE_STREAM],
    ["/", QUEUES.classic],
    ["/", QUEUES.swapClassic],
    ["/", QUEUES.swapQuorum],
    [OTHER_VHOST, OTHER_STREAM],
  ] as const) {
    const connection = await TestAmqpConnection.open(amqpAs(vhost));
    try {
      connection.send(methodFrame(1, 50, 10, (w) => w.u16(0).shortstr(queue).u8(1).table([])));
      const ok = new ByteReader((await connection.expect(50, 11)).payload).skip(4);
      ok.shortstr();
      found[`${vhost === "/" ? "" : vhost}/${queue}`] = ok.u32();
    } finally {
      await connection.close();
    }
  }
  return found;
}

/** What the seed published: a stream's count reaches it once the broker has written the chunk. */
const PUBLISHED: Readonly<Record<string, number>> = {
  [`/${STREAM}`]: 5,
  [`/${PRIVATE_STREAM}`]: 2,
  [`/${QUEUES.classic}`]: 3,
  [`/${QUEUES.swapClassic}`]: 1,
  [`/${QUEUES.swapQuorum}`]: 1,
  [`${OTHER_VHOST}/${OTHER_STREAM}`]: 2,
};

/** The counts, once every queue holds what the seed published: a stream reports its count a moment after a publish. */
async function settledCounts(): Promise<Record<string, number>> {
  for (let tries = 0; tries < 120; tries += 1) {
    const found = await counts();
    if (JSON.stringify(found) === JSON.stringify(PUBLISHED)) return found;
    await sleep(250);
  }
  throw new Error("the seeded queues never reported what was published");
}

async function publish(vhost: string, exchange: string, routingKey: string, count: number, tag: string) {
  const publisher = await TestPublisher.open(amqpAs(vhost));
  try {
    for (let n = 0; n < count; n += 1) {
      await publisher.publish(exchange, routingKey, encoder.encode(`${MARKERS.body}-${tag}-${n}`), {
        contentType: MARKERS.contentType,
        headers: [[MARKERS.headerName, { t: "S", v: `${MARKERS.header}-${n}` }]],
        messageId: `${MARKERS.messageId}-${n}`,
        correlationId: MARKERS.correlationId,
        appId: MARKERS.appId,
        type: MARKERS.type,
        replyTo: MARKERS.replyTo,
        timestamp: BigInt(1_700_000_000 + n),
        deliveryMode: 2,
      });
    }
  } finally {
    await publisher.close();
  }
}

async function declare(vhost: string, name: string, type: string): Promise<void> {
  await admin.call("PUT", `/api/queues/${segment(vhost)}/${segment(name)}`, {
    durable: true,
    arguments: { "x-queue-type": type },
  });
}

async function seedBroker(): Promise<void> {
  await admin.call("PUT", `/api/vhosts/${OTHER_VHOST}`, {});
  await admin.call("PUT", `/api/permissions/${OTHER_VHOST}/${ADMIN}`, { configure: ".*", write: ".*", read: ".*" });
  await admin.call("PUT", `/api/users/${NARROW}`, { password: NARROW_PASSWORD, tags: "management" });
  await admin.call("PUT", `/api/permissions/%2F/${NARROW}`, {
    configure: "^$",
    write: "^$",
    read: `^(${STREAM}|${TRICKLE_STREAM})$`,
  });
  await declare("/", STREAM, "stream");
  await declare("/", PRIVATE_STREAM, "stream");
  await declare("/", QUEUES.classic, "classic");
  await declare(OTHER_VHOST, OTHER_STREAM, "stream");
  await declare("/", TRICKLE_STREAM, "stream");
  await admin.call("PUT", `/api/exchanges/%2F/${EXCHANGE}`, { type: "direct", durable: true });
  await admin.call("POST", `/api/bindings/%2F/e/${EXCHANGE}/q/${STREAM}`, { routing_key: MARKERS.routingKey });
  await publish("/", EXCHANGE, MARKERS.routingKey, 5, "mcp");
  await publish("/", "", PRIVATE_STREAM, 2, "private");
  await publish("/", "", QUEUES.classic, 3, "classic");
  await publish(OTHER_VHOST, "", OTHER_STREAM, 2, "other");
  // A classic and a quorum queue declared under a stream's name, one message each.
  await declare("/", QUEUES.swapClassic, "classic");
  await declare("/", QUEUES.swapQuorum, "quorum");
  await publish("/", "", QUEUES.swapClassic, 1, "swap");
  await publish("/", "", QUEUES.swapQuorum, 1, "swap");
}

/** The administrator's raw no-ack basic.get of `queue`: the take the closed table never sends. */
async function adminTake(queue: string): Promise<string> {
  const connection = await TestAmqpConnection.open(amqpAs("/"));
  try {
    connection.send(methodFrame(1, 60, 70, (w) => w.u16(0).shortstr(queue).u8(1)));
    const answer = await connection.next();
    const id = methodId(answer.payload);
    if (id.classId === 60 && id.methodId === 72) return "get-empty";
    await connection.next();
    await connection.next();
    return "get-ok";
  } finally {
    await connection.close();
  }
}

async function main() {
  await seedBroker();
  const before = await settledCounts();
  const startedAt = new Date().toISOString();

  const accepted: Record<string, Recorded> = {};
  for (const [name, from, limit] of [
    ["first", "first", 10],
    ["last", "last", 10],
    ["offset", { offset: 2 }, 2],
    ["timestamp", { timestamp: "2000-01-01T00:00:00Z" }, 3],
    ["age", { age: "1h" }, 3],
    ["next", "next", 3],
  ] as const) {
    accepted[name] = await mcp(narrow, { statement: request("/", STREAM, from, limit) });
  }
  const cut = await mcp(narrow, { statement: request("/", STREAM, "first", 5), max_rows: 2 });

  const shapes: Record<string, string> = {
    "a key the request does not take": JSON.stringify({ vhost: "/", stream: STREAM, filter: { routing_key: "a" } }),
    "a purge-shaped request": JSON.stringify({ vhost: "/", stream: STREAM, purge: true }),
    "a limit past 500": request("/", STREAM, "first", 501),
    "text that is no read request": `queue.purge ${STREAM}`,
  };
  const admission: Record<string, { fenced: Recorded; unfenced: Recorded }> = {};
  for (const [name, statement] of Object.entries(shapes)) {
    admission[name] = {
      fenced: await mcp(narrow, { statement }),
      unfenced: await mcp(narrow, { statement }, { arm: UNFENCED }),
    };
  }

  const boundary = {
    classic: await mcp(narrow, { statement: request("/", QUEUES.classic, "first", 1) }, { arm: UNFENCED }),
    swapClassic: await mcp(
      broad,
      { statement: request("/", QUEUES.swapClassic, "first", 1) },
      { arm: UNFENCED, acquire: liarProvider },
    ),
    swapQuorum: await mcp(
      broad,
      { statement: request("/", QUEUES.swapQuorum, "first", 1) },
      { arm: UNFENCED, acquire: liarProvider },
    ),
  };

  const scope = {
    otherVhostStream: await mcp(narrow, { statement: request(OTHER_VHOST, OTHER_STREAM, "first", 2) }),
    otherVhostMissing: await mcp(narrow, { statement: request(OTHER_VHOST, "st-missing", "first", 2) }),
    privateStream: await mcp(narrow, { statement: request("/", PRIVATE_STREAM, "first", 2) }),
    missingStream: await mcp(narrow, { statement: request("/", "st-missing", "first", 2) }),
    broadOtherVhost: await mcp(broad, { statement: request(OTHER_VHOST, OTHER_STREAM, "first", 2) }),
  };

  const timeout = await mcp(narrow, { statement: request("/", STREAM, "next", 10), timeout_ms: 500 });

  // The cancel: a message every 400 ms keeps the read from idling for 1 s and from reaching its limit of 10, so only
  // the provider's deadline, the time left of timeout_ms, ends it. The read runs on a provider of the production class
  // built for this probe, whose queryReadOnly is wrapped to time when the read itself settles.
  let readSettled: { readonly afterMs: number; readonly outcome: string } | null = null;
  const controller = new AbortController();
  const cancelStarted = Date.now();
  const timed = async (connection: ManagedConnection) => {
    const provider = new RabbitMQProvider(
      connection as DatabaseConnection,
      {},
      { readOnly: true, sendsStatements: true },
    );
    await provider.connect();
    const read = provider.queryReadOnly.bind(provider);
    provider.queryReadOnly = async (...args) => {
      try {
        const result = await read(...args);
        readSettled = { afterMs: Date.now() - cancelStarted, outcome: `answered ${result.rowCount} rows` };
        return result;
      } catch (error) {
        readSettled = { afterMs: Date.now() - cancelStarted, outcome: (error as Error).message };
        throw error;
      }
    };
    return provider;
  };
  const trickle = (async () => {
    for (let n = 0; n < 10; n += 1) {
      await sleep(400);
      await publish("/", "", TRICKLE_STREAM, 1, `trickle-${n}`);
    }
  })();
  const pending = mcp(
    narrow,
    { statement: request("/", TRICKLE_STREAM, "next", 10), timeout_ms: 2_000 },
    {
      signal: controller.signal,
      acquire: timed,
    },
  );
  await sleep(300);
  controller.abort();
  const cancelled = await pending;
  const answeredAfterMs = Date.now() - cancelStarted;
  await trickle;
  const settledBy = readSettled as { readonly afterMs: number; readonly outcome: string } | null;

  const after = await counts();
  const control = { take: await adminTake(QUEUES.classic), after: await counts() };

  const capture = {
    $captured: {
      image: IMAGE,
      version: VERSION,
      date: DATE,
      startedAt,
      runtime: `bun ${Bun.version}`,
      narrow: `${NARROW}: tag management; on / configure ^$, write ^$, read ^${STREAM}$; no permission on ${OTHER_VHOST}`,
      broad: `${ADMIN}: tag administrator; configure, write and read .* on / and ${OTHER_VHOST}`,
      note: "Each call runs through runStatement with the factory's agent read-only acquisition, the way the MCP route makes it. `admission` holds each request the rabbitread admission refuses, sent through the tool and again with the admission removed. `boundary` has the admission removed: a classic queue at the type check, and a classic and a quorum queue declared under a stream's name with the type check answered as a stream. `control` is the administrator's raw no-ack basic.get after every MCP call, the take the closed table never sends.",
    },
    markers: MARKERS,
    before,
    accepted,
    cut,
    admission,
    boundary,
    scope,
    timeout,
    cancel: { answer: cancelled, answeredAfterMs, timeoutMs: 2_000, readSettled: settledBy },
    after,
    control,
  };
  const text = `${JSON.stringify(capture, null, 2)}\n`;
  for (const secret of SECRETS) if (text.includes(secret)) throw new Error("a capture would hold a password");
  writeFileSync(path.join(OUT, "mcp-boundary.json"), text);
  console.log(`wrote ${path.join(OUT, "mcp-boundary.json")}`);
}

try {
  await main();
} finally {
  await clearProviderCache();
}
