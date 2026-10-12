/**
 * The RabbitMQ capture harness (#1656): runs the real provider against a pinned broker through two recording seams and
 * writes what the broker answered under `tests/fixtures/rabbitmq/<set>/`, where `<set>` is the pinned version or
 * `nightly`; `tests/integration/db/rabbitmq-provider.test.ts` replays those files. It also runs the live steps that
 * only a broker can settle and prints their record as JSON. It is not in `bun run test`: the runner excludes
 * `tests/live/`. The broker is the compose service the environment names (see `tests/helpers/rabbitmq-live.ts`):
 *
 *   bun tests/live/rabbitmq-evidence.ts <step>...
 *
 * Steps:
 *   sessions  the browse and read sessions as studio-reader, studio-wide-read and studio-browse, and every stream read
 *             the integration test replays, poison streams included
 *   errors    the answers of each error row that reads broker wording: 401 not_authorized, 401 "Not management user",
 *             404 not_found and "Object Not Found", both 530 forms, the consume 403
 *   guest     the localhost-only 401, from a throwaway container whose configuration restores guest's localhost rule,
 *             reached at its bridge address so the broker sees a remote client
 *   listing   (4.3.6) a vhost of its own with 520 classic queues that sort before 510 streams and one quorum queue,
 *             listed through the provider; the fill time and the page answers are printed
 *   backstop  R-S2's second layer: the provider's consume sent to a classic queue, with the type check answered as a
 *             stream, must be refused with 406 and deliver nothing
 *   digest    the capture gate: st-orders offsets 7 and 8 read through the provider's no-copy path; the shown cell is
 *             the pattern's first bytes, and the SHA-256 over the body prefix the wire carried and every skipped byte
 *             equals the seed pattern's
 *   wan       the idle stop off localhost: a read of 10 stored messages through a proxy that adds 25 ms each way
 *   nightly   (4.3.6) the conversion-fix build's frames for the poison streams, from a throwaway container
 *   no-plugin Test Connection on a throwaway broker without rabbitmq_stream_management names no queue
 *   no-replica (the rabbitmq-cluster profile) a read through node 1 of a stream whose only replica is on stopped node 2
 *
 * Every vhost, queue and container a step creates is its own and is deleted, or removed by its exact name, before the
 * step ends; the seeded vhosts `/` and `billing` are only read. Throwaway containers bind loopback ports only.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createNodeTransport } from "@/lib/db/http/node-transport";
import { RabbitMQProvider } from "@/lib/db/providers/stream/rabbitmq";
import { dialAmqp } from "@/lib/db/providers/stream/rabbitmq/amqp/dial";
import { RABBITMQ_BODY_PREFIX_BYTES, RABBITMQ_CELL_CHARS } from "@/lib/db/providers/stream/rabbitmq/limits";
import type { ManagementTransportFactory } from "@/lib/db/providers/stream/rabbitmq/management/client";
import type { DatabaseConnection, QueryResult } from "@/lib/types";
import { patternBytes, patternSha256 } from "../helpers/rabbitmq-body-pattern";
import {
  type AmqpRecording,
  type CaptureSet,
  captureSecretHits,
  joinBytes,
  type ManagementExchange,
  RABBITMQ_CAPTURES_ROOT,
  recordingDial,
  recordingTransport,
  splitFrames,
} from "../helpers/rabbitmq-captures";
import { rabbitmqConnection } from "../helpers/rabbitmq-connection";
import {
  AdminApi,
  liveTarget,
  RABBITMQ_FIXTURE_IMAGE,
  RABBITMQ_42_IMAGE,
  RABBITMQ_NIGHTLY_IMAGE,
  RABBITMQ_PINNED_DIGESTS,
  type RabbitMQLiveTarget,
  segment,
} from "../helpers/rabbitmq-live";
import { TestPublisher } from "../helpers/rabbitmq-test-amqp091";
import { seed, seedHash } from "./rabbitmq-seed";

const record: Record<string, unknown> = {};
const target = liveTarget();
const set = RABBITMQ_PINNED_DIGESTS[target.digest] as CaptureSet;
const IMAGES: Readonly<Record<string, string>> = { "4.3.6": RABBITMQ_FIXTURE_IMAGE, "4.2.9": RABBITMQ_42_IMAGE };

function connectionTo(
  base: RabbitMQLiveTarget,
  user: string,
  overrides: Partial<DatabaseConnection> = {},
): DatabaseConnection {
  return rabbitmqConnection({
    host: base.host,
    port: base.managementPort,
    amqpPort: String(base.amqpPort),
    user,
    password: base.fixturePassword,
    ...overrides,
  });
}

/** One recorded run: a provider whose management GETs and AMQP bytes are both kept. */
function recorded(connection: DatabaseConnection, transport: ManagementTransportFactory = createNodeTransport) {
  const exchanges: ManagementExchange[] = [];
  const connections: AmqpRecording[] = [];
  const provider = new RabbitMQProvider(
    connection,
    {},
    {
      managementTransport: recordingTransport(transport, exchanges),
      dial: recordingDial(dialAmqp, connections),
    },
  );
  return { provider, exchanges, connections };
}

function header(surface: string, captureSet: CaptureSet = set, image = IMAGES[set], digest = target.digest) {
  return {
    image,
    digest,
    version: captureSet === "nightly" ? "4.3.x nightly" : captureSet,
    seed: seedHash(),
    date: new Date().toISOString(),
    surface,
  };
}

function write(captureSet: CaptureSet, kind: "management" | "amqp", name: string, body: unknown): void {
  const dir = path.join(RABBITMQ_CAPTURES_ROOT, captureSet, kind);
  mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify(body, null, 1)}\n`;
  if (captureSecretHits(text, [target.adminPassword, target.fixturePassword]).length > 0) {
    throw new Error(`${captureSet}/${kind}/${name} would carry a password; it is not written.`);
  }
  writeFileSync(path.join(dir, `${name}.json`), text);
}

function writeManagement(
  name: string,
  surface: string,
  exchanges: readonly ManagementExchange[],
  captureSet: CaptureSet = set,
  image?: string,
  digest?: string,
): void {
  write(captureSet, "management", name, {
    $captured: header(surface, captureSet, image ?? IMAGES[set], digest ?? target.digest),
    exchanges,
  });
}

function writeAmqp(
  name: string,
  request: string,
  recording: AmqpRecording | undefined,
  captureSet: CaptureSet = set,
  image?: string,
  digest?: string,
): number {
  if (!recording) throw new Error(`${name}: the read opened no AMQP connection`);
  const server = repliedBytes(recording);
  write(captureSet, "amqp", name, {
    $captured: header(request, captureSet, image ?? IMAGES[set], digest ?? target.digest),
    request,
    serverBytes: Buffer.from(server).toString("base64"),
  });
  return server.length;
}

/**
 * The server bytes a replay needs: every whole frame that arrived before the client sent `connection.close`, then
 * only the connection's own method frames (its `close-ok`). Deliveries in flight after the client's close are frames
 * the provider discards, and a large body among them would only grow the capture.
 */
function repliedBytes(recording: AmqpRecording): Uint8Array {
  const server = joinBytes(recording.server);
  const closedAt = recording.clientClosedAt;
  if (closedAt === null) return server;
  return joinBytes(
    splitFrames(server)
      .filter((frame) => frame.end <= closedAt || (frame.type === 1 && frame.channel === 0))
      .map((frame) => server.subarray(frame.start, frame.end)),
  );
}

async function attempt<T>(run: () => Promise<T>): Promise<{ readonly value?: T; readonly error?: Error }> {
  try {
    return { value: await run() };
  } catch (error) {
    return { error: error as Error };
  }
}

/** The streams the integration test replays, each read once as studio-reader, by request. */
export const RECORDED_READS: Readonly<Record<string, string>> = {
  "read-st-orders-first-7": '{"vhost": "/", "stream": "st-orders", "from": "first", "limit": 7}',
  "read-st-orders-offset-9-limit-4": '{"vhost": "/", "stream": "st-orders", "from": {"offset": 9}, "limit": 4}',
  "read-st-events-last": '{"vhost": "/", "stream": "st-events", "from": "last", "limit": 50}',
  "read-st-routes": '{"vhost": "/", "stream": "st-routes", "from": "first", "limit": 50}',
  "read-st-amqp10": '{"vhost": "/", "stream": "st-amqp10", "from": "first", "limit": 50}',
  "read-st-spoof": '{"vhost": "/", "stream": "st-spoof", "from": "first", "limit": 50}',
  "read-st-uuid-key": '{"vhost": "/", "stream": "st-uuid-key", "from": "first", "limit": 50}',
  "read-st-hostile-headers": '{"vhost": "/", "stream": "st-hostile-headers", "from": "first", "limit": 50}',
  "read-st-buffer-shape": '{"vhost": "/", "stream": "st-buffer-shape", "from": "first", "limit": 50}',
  "read-st-g2-poison-mid-first": '{"vhost": "/", "stream": "st-g2-poison-mid", "from": "first", "limit": 50}',
  "read-st-g2-poison-mid-offset-2-limit-1":
    '{"vhost": "/", "stream": "st-g2-poison-mid", "from": {"offset": 2}, "limit": 1}',
  "read-g9-poison-first": '{"vhost": "/", "stream": "g9-poison", "from": "first", "limit": 50}',
  "read-h1-props-offset-1-limit-1": '{"vhost": "/", "stream": "h1-props", "from": {"offset": 1}, "limit": 1}',
  "read-h3-solo-offset-2-limit-1": '{"vhost": "/", "stream": "h3-solo", "from": {"offset": 2}, "limit": 1}',
  "read-h3-wide-first": '{"vhost": "/", "stream": "h3-wide", "from": "first", "limit": 50}',
};

/** The reads whose outcome the conversion-fix build changes. */
const NIGHTLY_READS = [
  "read-st-uuid-key",
  "read-st-g2-poison-mid-first",
  "read-g9-poison-first",
  "read-h1-props-offset-1-limit-1",
  "read-h3-solo-offset-2-limit-1",
];

async function readAll(
  provider: RabbitMQProvider,
  connections: AmqpRecording[],
  names: readonly string[],
  captureSet: CaptureSet,
  image?: string,
  digest?: string,
) {
  const outcomes: Record<string, string> = {};
  for (const name of names) {
    const before = connections.length;
    const result = await attempt(() => provider.query(RECORDED_READS[name]));
    const kept = writeAmqp(name, RECORDED_READS[name], connections[before], captureSet, image, digest);
    outcomes[name] = `${
      result.error ? `${result.error.name}: ${result.error.message}` : `${result.value?.rows.length} rows`
    }; ${kept} server bytes kept`;
  }
  return outcomes;
}

async function sessions(): Promise<void> {
  const reader = recorded(connectionTo(target, "studio-reader"));
  const p = reader.provider;
  await p.connect();
  await p.listContainers();
  for (const vhost of ["/", "billing"]) {
    await p.countObjects([vhost]);
    for (const kind of ["stream", "queue", "exchange"]) await p.listObjects([vhost], kind);
  }
  await p.describeObject(["/", "st-orders"], "stream");
  for (const [objectPath, kind] of [
    [["/", "st-orders"], "stream"],
    [["/", "q-classic-orders"], "queue"],
    [["/", "q-quorum-payments"], "queue"],
    [["/", "ex-direct"], "exchange"],
    [["/", ""], "exchange"],
    [["/", "st-invoices"], "exchange"],
  ] as const) {
    await p.readObjectSource?.(objectPath, kind);
  }
  await p.getHealth();
  await p.getOverview();
  await p.testConnectionWarnings?.();
  record.sessionReads = await readAll(p, reader.connections, Object.keys(RECORDED_READS), set);
  await p.disconnect();
  writeManagement(
    "session-studio-reader",
    "the tree, every listing, details, sources, monitoring, Test Connection and the reads' type checks as studio-reader",
    reader.exchanges,
  );

  const wide = recorded(connectionTo(target, "studio-wide-read"));
  await wide.provider.connect();
  record.wideReadCautions = ((await wide.provider.testConnectionWarnings?.()) ?? []).map((w) => w.message);
  await wide.provider.disconnect();
  writeManagement("session-studio-wide-read", "connect() and Test Connection as studio-wide-read", wide.exchanges);

  const browse = recorded(connectionTo(target, "studio-browse", { amqpPort: "" }));
  await browse.provider.connect();
  await browse.provider.listContainers();
  await browse.provider.countObjects(["/"]);
  await browse.provider.disconnect();
  writeManagement(
    "session-studio-browse",
    "connect(), the tree and the counts of / as studio-browse, AMQP port empty",
    browse.exchanges,
  );
}

/** A transport factory whose type check answers "stream" for every name, so a read reaches the AMQP side of a refusal. */
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

async function errors(): Promise<void> {
  const outcomes: Record<string, string> = {};
  const wrong = recorded(connectionTo(target, "studio-reader", { password: `${target.fixturePassword}-not` }));
  outcomes.notAuthorized = String((await attempt(() => wrong.provider.connect())).error?.message);
  writeManagement("error-401-not-authorized", "connect() as studio-reader with a wrong password", wrong.exchanges);

  const untagged = recorded(connectionTo(target, "studio-untagged"));
  outcomes.notManagementUser = String((await attempt(() => untagged.provider.connect())).error?.message);
  writeManagement(
    "error-401-not-management-user",
    "connect() as studio-untagged, a user without a tag",
    untagged.exchanges,
  );

  const missing = recorded(connectionTo(target, "studio-reader"));
  await missing.provider.connect();
  outcomes.vhostNotFound = JSON.stringify(
    (await attempt(() => missing.provider.countObjects(["evidence-missing"]))).value,
  );
  outcomes.objectNotFound = String(
    (await attempt(() => missing.provider.readObjectSource?.(["/", "q-missing"], "queue") ?? Promise.resolve())).error
      ?.message,
  );
  outcomes.streamNotFound = String(
    (await attempt(() => missing.provider.query('{"vhost": "/", "stream": "st-missing", "from": "first", "limit": 1}')))
      .error?.message,
  );
  await missing.provider.disconnect();
  writeManagement(
    "error-404",
    "countObjects of a vhost that does not exist, the source of a missing queue and the type check of a missing stream",
    missing.exchanges,
  );

  const restricted = recorded(connectionTo(target, "studio-reader"));
  await restricted.provider.connect();
  outcomes.consume403 = String(
    (
      await attempt(() =>
        restricted.provider.query('{"vhost": "/", "stream": "st-restricted", "from": "first", "limit": 1}'),
      )
    ).error?.message,
  );
  writeAmqp("error-403-consume", "st-restricted as studio-reader", restricted.connections[0]);
  await restricted.provider.disconnect();
  writeManagement(
    "error-403-consume",
    "connect() and the type check of st-restricted as studio-reader",
    restricted.exchanges,
  );

  // A vhost of this step's own on which studio-reader, a management user, has no permissions: connect() passes and the
  // read's connection.open is refused.
  const admin = new AdminApi(target);
  await admin.call("PUT", "/api/vhosts/evidence-refused", {});
  try {
    await admin.call("PUT", `/api/permissions/evidence-refused/${segment(target.adminUser)}`, {
      configure: ".*",
      write: ".*",
      read: ".*",
    });
    const refusedVhost = recorded(connectionTo(target, "studio-reader"), streamTypeCheck(createNodeTransport));
    await refusedVhost.provider.connect();
    outcomes.vhostRefused530 = String(
      (
        await attempt(() =>
          refusedVhost.provider.query('{"vhost": "evidence-refused", "stream": "s", "from": "first", "limit": 1}'),
        )
      ).error?.message,
    );
    await refusedVhost.provider.disconnect();
    writeAmqp(
      "error-530-access-refused",
      "evidence-refused as studio-reader, which has no permissions there; type check answered as a stream",
      refusedVhost.connections[0],
    );
  } finally {
    await admin.call("DELETE", "/api/vhosts/evidence-refused", undefined, [204, 404]);
  }

  const absentVhost = recorded(connectionTo(target, "studio-reader"), streamTypeCheck(createNodeTransport));
  await absentVhost.provider.connect();
  outcomes.vhostAbsent530 = String(
    (
      await attempt(() =>
        absentVhost.provider.query('{"vhost": "evidence-missing", "stream": "s", "from": "first", "limit": 1}'),
      )
    ).error?.message,
  );
  await absentVhost.provider.disconnect();
  writeAmqp(
    "error-530-vhost-not-found",
    "a vhost that does not exist; type check answered as a stream",
    absentVhost.connections[0],
  );
  record.errors = outcomes;
}

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", timeout: 120_000 }).trim();
}

/** Starts a throwaway broker by exact name, waits for its management API, runs `inside`, and removes it by that name. */
async function throwaway<T>(
  name: string,
  image: string,
  ports: { amqp: number; http: number },
  extra: string[],
  inside: (t: RabbitMQLiveTarget, bridge: string) => Promise<T>,
): Promise<T> {
  docker("rm", "-f", name);
  docker(
    "run",
    "-d",
    "--name",
    name,
    "--ulimit",
    "nofile=65536:65536",
    "--memory",
    "1g",
    "--memory-swap",
    "1g",
    "-e",
    "RABBITMQ_DEFAULT_USER=libredb-admin",
    "-e",
    `RABBITMQ_DEFAULT_PASS=${target.adminPassword}`,
    "-p",
    `127.0.0.1:${ports.amqp}:5672`,
    "-p",
    `127.0.0.1:${ports.http}:15672`,
    ...extra,
    image,
  );
  try {
    const local: RabbitMQLiveTarget = {
      ...target,
      host: "127.0.0.1",
      amqpPort: ports.amqp,
      managementPort: ports.http,
    };
    const admin = new AdminApi(local);
    for (let waited = 0; ; waited += 1000) {
      const ready = await attempt(() => admin.call("GET", "/api/overview?columns=rabbitmq_version"));
      if (!ready.error) break;
      if (waited > 120_000) throw new Error(`${name} did not answer its management API within 120 s`);
      await sleep(1000);
    }
    const bridge = docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", name);
    return await inside(local, bridge);
  } finally {
    docker("rm", "-f", name);
  }
}

async function guest(): Promise<void> {
  const conf = path.resolve(import.meta.dir, "../../docker/rabbitmq/evidence/guest-loopback.conf");
  record.guest = await throwaway(
    "libredb-rabbitmq-evidence-guest",
    IMAGES[set],
    { amqp: 35673, http: 45673 },
    ["-v", `${conf}:/etc/rabbitmq/conf.d/30-guest.conf:ro`],
    async (_local, bridge) => {
      const run = recorded(
        rabbitmqConnection({
          host: bridge,
          port: 15672,
          amqpPort: "5672",
          user: "guest",
          password: ["gu", "est"].join(""),
          allowInsecureAuth: true,
        }),
      );
      const outcome = await attempt(() => run.provider.connect());
      writeManagement(
        "error-401-localhost-only",
        "connect() as guest from outside the container, with guest's localhost rule restored",
        run.exchanges,
      );
      return String(outcome.error?.message);
    },
  );
}

async function listing(): Promise<void> {
  const admin = new AdminApi(target);
  const vhost = "evidence-listing";
  await admin.call("PUT", `/api/vhosts/${vhost}`, {});
  try {
    await admin.call("PUT", `/api/permissions/${vhost}/${segment(target.adminUser)}`, {
      configure: ".*",
      write: ".*",
      read: ".*",
    });
    await admin.call("PUT", `/api/permissions/${vhost}/studio-reader`, { configure: "^$", write: "^$", read: "^$" });
    const started = performance.now();
    const declare = (name: string, type: string) =>
      admin.call("PUT", `/api/queues/${vhost}/${name}`, { durable: true, arguments: { "x-queue-type": type } });
    for (let n = 0; n < 520; n++) await declare(`a-c-${String(n).padStart(3, "0")}`, "classic");
    await declare("b-q-0", "quorum");
    for (let n = 0; n < 510; n++) await declare(`c-s-${String(n).padStart(3, "0")}`, "stream");
    const fillMs = Math.round(performance.now() - started);
    const run = recorded(connectionTo(target, "studio-reader"));
    await run.provider.connect();
    const counts = await run.provider.countObjects([vhost]);
    const streams = await run.provider.listObjects([vhost], "stream");
    const queues = await run.provider.listObjects([vhost], "queue");
    await run.provider.disconnect();
    writeManagement(
      "listing-500-plus",
      "the three pages of a vhost with 520 classic queues, one quorum queue and 510 streams",
      run.exchanges,
    );
    record.listing = {
      fillMs,
      counts,
      streams: streams.length,
      firstStream: streams[0]?.name,
      lastStream: streams.at(-1)?.name,
      queues: queues.length,
    };
  } finally {
    await admin.call("DELETE", `/api/vhosts/${vhost}`, undefined, [204, 404]);
  }
}

async function backstop(): Promise<void> {
  const admin = new AdminApi(target);
  const vhost = "evidence-backstop";
  await admin.call("PUT", `/api/vhosts/${vhost}`, {});
  try {
    await admin.call("PUT", `/api/permissions/${vhost}/${segment(target.adminUser)}`, {
      configure: ".*",
      write: ".*",
      read: ".*",
    });
    await admin.call("PUT", `/api/permissions/${vhost}/studio-wide-read`, { configure: "^$", write: "^$", read: ".*" });
    await admin.call("PUT", `/api/queues/${vhost}/rs2-backstop`, {
      durable: true,
      arguments: { "x-queue-type": "classic" },
    });
    const publisher = await TestPublisher.open({
      host: target.host,
      port: target.amqpPort,
      vhost,
      username: target.adminUser,
      password: target.adminPassword,
    });
    await publisher.publish("", "rs2-backstop", new TextEncoder().encode("backstop"));
    await publisher.close();
    const run = recorded(connectionTo(target, "studio-wide-read"), streamTypeCheck(createNodeTransport));
    await run.provider.connect();
    const outcome = await attempt(() =>
      run.provider.query(`{"vhost": "${vhost}", "stream": "rs2-backstop", "from": "first", "limit": 1}`),
    );
    await run.provider.disconnect();
    await sleep(6000);
    const left = await admin.json<{ messages?: number }>(`/api/queues/${vhost}/rs2-backstop?columns=messages`);
    const server = joinBytes(run.connections[0]?.server ?? []);
    record.backstop = {
      refused: outcome.error?.name ?? "not refused",
      rows: outcome.value?.rows.length ?? 0,
      channelClose406: Buffer.from(server).includes(Buffer.from([0x00, 0x14, 0x00, 0x28, 0x01, 0x96])),
      messagesLeft: left.messages,
    };
    if (outcome.error === undefined || left.messages !== 1)
      throw new Error(`the backstop failed: ${JSON.stringify(record.backstop)}`);
  } finally {
    await admin.call("DELETE", `/api/vhosts/${vhost}`, undefined, [204, 404]);
  }
}

/** The first `length` body bytes of the first delivery in a server byte stream, read from its body frames. */
function deliveredBodyPrefix(bytes: Uint8Array, length: number): Uint8Array {
  const frames = splitFrames(bytes);
  const deliver = frames.findIndex((frame) => frame.classId === 60 && frame.methodId === 60);
  if (deliver === -1) throw new Error("the recording holds no basic.deliver");
  const parts: Uint8Array[] = [];
  let have = 0;
  for (const frame of frames.slice(deliver + 1)) {
    if (frame.type === 1 || have >= length) break;
    if (frame.type !== 3) continue;
    const payload = bytes.subarray(frame.start + 7, frame.end - 1);
    parts.push(payload.subarray(0, length - have));
    have += Math.min(payload.length, length - have);
  }
  return joinBytes(parts);
}

/**
 * How many body bytes of each delivery in a server byte stream lie past the kept prefix, in delivery order: the bytes
 * the frame reader hands to onSkippedBytes. The read acks the message it keeps before it closes, so the broker may
 * deliver the next message while the close is under way, and the reader steps over that body too.
 */
function skippedPerDelivery(bytes: Uint8Array, prefix: number): number[] {
  const counts: number[] = [];
  let received: number | null = null;
  const settle = () => {
    if (received !== null) counts.push(Math.max(0, received - prefix));
  };
  for (const frame of splitFrames(bytes)) {
    if (frame.type === 1) {
      settle();
      received = frame.classId === 60 && frame.methodId === 60 ? 0 : null;
    } else if (frame.type === 3 && received !== null) received += frame.end - frame.start - 8;
  }
  settle();
  return counts;
}

async function digest(): Promise<void> {
  const proofs: Record<string, unknown> = {};
  for (const [offset, size] of [
    [7, 1_048_576],
    [8, 15_728_640],
  ] as const) {
    const label = `st-orders/${offset}`;
    // The provider keeps the body's first RABBITMQ_BODY_PREFIX_BYTES and hands every later byte to onSkippedBytes in
    // arrival order. The proof: the shown cell is the pattern's first bytes; the prefix the wire carried, followed by
    // the skipped bytes of this delivery, hashes to the pattern's SHA-256; this delivery's skipped count is the size
    // less the prefix; and every skipped byte is accounted for by a delivery the wire carried, since the next message
    // can arrive while the read closes.
    const skippedParts: Uint8Array[] = [];
    const connections: AmqpRecording[] = [];
    const provider = new RabbitMQProvider(
      connectionTo(target, "studio-reader"),
      {},
      {
        dial: recordingDial(dialAmqp, connections),
        onSkippedBytes: (view) => {
          skippedParts.push(view.slice());
        },
      },
    );
    await provider.connect();
    const result: QueryResult = await provider.query(
      `{"vhost": "/", "stream": "st-orders", "from": {"offset": ${offset}}, "limit": 1}`,
    );
    await provider.disconnect();
    const row = result.rows[0] as { payload: string; payload_encoding: string; payload_bytes: number };
    // A binary payload is shown as "<base64> (<n> bytes)", n being the declared size, cut to whole 3-byte groups.
    const suffix = ` (${size} bytes)`;
    const shown = Buffer.from(row.payload.slice(0, row.payload.lastIndexOf(" (")), "base64");
    const server = joinBytes(connections[0]?.server ?? []);
    const wirePrefix = deliveredBodyPrefix(server, RABBITMQ_BODY_PREFIX_BYTES);
    const perDelivery = skippedPerDelivery(server, RABBITMQ_BODY_PREFIX_BYTES);
    const total = skippedParts.reduce((sum, part) => sum + part.length, 0);
    const skipped = Math.min(total, perDelivery[0] ?? 0);
    const hash = createHash("sha256").update(wirePrefix);
    let hashed = 0;
    for (const part of skippedParts) {
      if (hashed >= skipped) break;
      const take = part.subarray(0, skipped - hashed);
      hash.update(take);
      hashed += take.length;
    }
    const proof = {
      payloadEncoding: row.payload_encoding,
      payloadBytes: row.payload_bytes,
      shown: shown.length,
      wirePrefix: wirePrefix.length,
      skipped,
      skippedOfLaterDeliveries: total - skipped,
      laterDeliveries: perDelivery.length - 1,
      everySkippedByteAccounted: total === perDelivery.reduce((sum, count) => sum + count, 0),
      shownLengthIsCellRoom: shown.length === Math.floor((RABBITMQ_CELL_CHARS - suffix.length) / 4) * 3,
      shownEqualsPattern: Buffer.compare(shown, Buffer.from(patternBytes(label, shown.length))) === 0,
      digestEqualsPattern: hash.digest("hex") === patternSha256(label, size),
    };
    proofs[`offset ${offset}`] = proof;
    if (
      !proof.shownLengthIsCellRoom ||
      !proof.shownEqualsPattern ||
      !proof.digestEqualsPattern ||
      !proof.everySkippedByteAccounted ||
      proof.payloadBytes !== size ||
      proof.wirePrefix !== RABBITMQ_BODY_PREFIX_BYTES ||
      proof.skipped !== size - RABBITMQ_BODY_PREFIX_BYTES
    ) {
      throw new Error(`the capture gate failed for st-orders offset ${offset}: ${JSON.stringify(proof)}`);
    }
  }
  record.digest = proofs;
}

async function wan(): Promise<void> {
  const admin = new AdminApi(target);
  const vhost = "evidence-wan";
  await admin.call("PUT", `/api/vhosts/${vhost}`, {});
  const proxy = net.createServer((client) => {
    const upstream = net.connect({ host: target.host, port: target.amqpPort });
    const delayed = (from: net.Socket, to: net.Socket) =>
      from.on("data", (chunk) => {
        from.pause();
        setTimeout(() => {
          to.write(chunk);
          from.resume();
        }, 25);
      });
    delayed(client, upstream);
    delayed(upstream, client);
    const end = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("close", end);
    upstream.on("close", end);
    client.on("error", end);
    upstream.on("error", end);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  try {
    await admin.call("PUT", `/api/permissions/${vhost}/${segment(target.adminUser)}`, {
      configure: ".*",
      write: ".*",
      read: ".*",
    });
    await admin.call("PUT", `/api/permissions/${vhost}/studio-wide-read`, { configure: "^$", write: "^$", read: ".*" });
    await admin.call("PUT", `/api/queues/${vhost}/st-wan`, { durable: true, arguments: { "x-queue-type": "stream" } });
    const publisher = await TestPublisher.open({
      host: target.host,
      port: target.amqpPort,
      vhost,
      username: target.adminUser,
      password: target.adminPassword,
    });
    for (let n = 0; n < 10; n++) await publisher.publish("", "st-wan", new TextEncoder().encode(JSON.stringify({ n })));
    await publisher.close();
    const port = (proxy.address() as net.AddressInfo).port;
    const provider = new RabbitMQProvider(connectionTo(target, "studio-wide-read", { amqpPort: String(port) }), {});
    await provider.connect();
    const started = performance.now();
    const result = await provider.query(`{"vhost": "${vhost}", "stream": "st-wan", "from": "first", "limit": 50}`);
    const elapsedMs = Math.round(performance.now() - started);
    await provider.disconnect();
    record.wan = {
      rttMs: 50,
      rows: result.rows.length,
      elapsedMs,
      warnings: (result.warnings ?? []).map((w) => w.message),
    };
    if (result.rows.length !== 10)
      throw new Error(`the read through a 50 ms link stopped after ${result.rows.length} of 10 messages`);
  } finally {
    proxy.close();
    await admin.call("DELETE", `/api/vhosts/${vhost}`, undefined, [204, 404]);
  }
}

async function nightly(): Promise<void> {
  const plugins = path.resolve(import.meta.dir, "../../docker/rabbitmq/enabled_plugins");
  record.nightly = await throwaway(
    "libredb-rabbitmq-evidence-nightly",
    RABBITMQ_NIGHTLY_IMAGE,
    { amqp: 35675, http: 45675 },
    ["-v", `${plugins}:/etc/rabbitmq/enabled_plugins:ro`],
    async (local) => {
      await seed(local);
      const run = recorded(connectionTo(local, "studio-reader"));
      await run.provider.connect();
      const outcomes = await readAll(
        run.provider,
        run.connections,
        NIGHTLY_READS,
        "nightly",
        RABBITMQ_NIGHTLY_IMAGE,
        RABBITMQ_NIGHTLY_IMAGE.split("@")[1],
      );
      await run.provider.disconnect();
      writeManagement(
        "session-studio-reader",
        "connect() and the type checks of the poison reads as studio-reader",
        run.exchanges,
        "nightly",
        RABBITMQ_NIGHTLY_IMAGE,
        RABBITMQ_NIGHTLY_IMAGE.split("@")[1],
      );
      return outcomes;
    },
  );
}

async function noPlugin(): Promise<void> {
  record.noPlugin = await throwaway(
    "libredb-rabbitmq-evidence-noplugin",
    IMAGES[set],
    { amqp: 35674, http: 45674 },
    [],
    async (local) => {
      await seed(local);
      const provider = new RabbitMQProvider(connectionTo(local, "studio-wide-read"), {});
      await provider.connect();
      const cautions = ((await provider.testConnectionWarnings?.()) ?? []).map((w) => w.message);
      await provider.disconnect();
      if (cautions.some((m) => m.includes("can read classic or quorum")))
        throw new Error(`a queue caution without the plugin: ${cautions.join(" | ")}`);
      return cautions;
    },
  );
}

async function noReplica(): Promise<void> {
  const node1: RabbitMQLiveTarget = { ...target, managementPort: 15695, amqpPort: 5695 };
  const admin = new AdminApi(node1);
  const vhost = "evidence-cluster";
  await admin.call("PUT", `/api/vhosts/${vhost}`, {});
  try {
    await admin.call("PUT", `/api/permissions/${vhost}/${segment(target.adminUser)}`, {
      configure: ".*",
      write: ".*",
      read: ".*",
    });
    await admin.call("PUT", `/api/users/studio-reader`, { password: target.fixturePassword, tags: "management" });
    await admin.call("PUT", `/api/permissions/${vhost}/studio-reader`, {
      configure: "^$",
      write: "^$",
      read: "^st-solo$",
    });
    // Declared through node 2's management API, so its one replica is placed on node 2, the node then stopped.
    const node2 = new AdminApi({ ...target, managementPort: 15696, amqpPort: 5696 });
    await node2.call("PUT", `/api/queues/${vhost}/st-solo`, {
      durable: true,
      arguments: { "x-queue-type": "stream", "x-initial-cluster-size": 1 },
    });
    docker("stop", "libredb-rabbitmq-cluster-2");
    try {
      await sleep(5000);
      const run = recorded(connectionTo(node1, "studio-reader"));
      await run.provider.connect();
      const outcome = await attempt(() =>
        run.provider.query(`{"vhost": "${vhost}", "stream": "st-solo", "from": "first", "limit": 1}`),
      );
      await run.provider.disconnect();
      writeManagement(
        "no-replica",
        "the type check of a stream whose only replica is on a stopped node, through node 1",
        run.exchanges,
      );
      writeAmqp(
        "error-406-no-replica",
        "st-solo through node 1 while its only replica's node is stopped",
        run.connections[0],
      );
      record.noReplica = String(outcome.error?.message);
    } finally {
      docker("start", "libredb-rabbitmq-cluster-2");
    }
  } finally {
    await admin.call("DELETE", `/api/vhosts/${vhost}`, undefined, [204, 404]);
  }
}

const STEPS: Readonly<Record<string, () => Promise<void>>> = {
  sessions,
  errors,
  guest,
  listing,
  backstop,
  digest,
  wan,
  nightly,
  "no-plugin": noPlugin,
  "no-replica": noReplica,
};

const steps = process.argv.slice(2);
if (steps.length === 0 || steps.some((step) => !(step in STEPS))) {
  throw new Error(`Name one or more steps: ${Object.keys(STEPS).join(", ")}.`);
}
for (const step of steps) {
  record[`${step} started`] = new Date().toISOString();
  await STEPS[step]();
}
record.set = set;
record.seed = seedHash();
console.log(JSON.stringify(record, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 1));
