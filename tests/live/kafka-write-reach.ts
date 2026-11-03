/**
 * Measures Kafka's write reach against the broker tests/fixtures/kafka/4.3.1/write-reach/run.sh started: the broker
 * snapshot is taken before and after every provider surface of a read-only connection and of the agent's two handles,
 * and written with every request Studio sent into that run.sh's directory as write-reach.json.
 *
 *   tests/fixtures/kafka/4.3.1/write-reach/run.sh
 *
 * The environment names the broker: KAFKA_WRITE_REACH_CONTAINER, KAFKA_WRITE_REACH_IMAGE (the image with its digest,
 * recorded), KAFKA_WRITE_REACH_OUT (the directory to write) and KAFKA_WRITE_REACH_PORT (the plaintext listener Studio
 * connects to). The broker has no authentication and automatic topic creation on, so any write Studio sent would land.
 *
 * What the snapshot sees: the snapshot of tests/live/kafka-snapshot.ts, read with the broker's own tools inside its
 * container, holds the topic list, the group list, every group's committed offsets, every partition's earliest and
 * latest offset, and the topic and broker configs. A produce, a topic creation or deletion, a record deletion, an
 * offset commit or deletion and a config change each move it. What it does not see: a group joined and left with
 * nothing committed, a heartbeat, a producer id, a transaction begun and aborted, or a partition reassignment begun,
 * which leave it unchanged. Those are shown absent by the recorded request list instead, `sentByStudio`: every request
 * the client library sent in the run, read at its one request writer (`Connection.prototype.send`, which every API
 * call, the SASL exchange and the adapter's own Fetch go through), as the API key and version it carried.
 * After Studio's surfaces, this script itself produces one record, consumes it under the seeded group and creates a
 * topic with the broker's tools, never through Studio, and takes the snapshot again: the control that shows a write
 * would have been seen.
 *
 * Run by hand through run.sh, never by `bun run test`, which runs no file under tests/live/.
 */
// oxlint-disable no-await-in-loop -- each surface runs after the one before, on purpose: the snapshot is read between handles.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { posix } from "node:path";
import { createDatabaseProvider } from "@/lib/db/factory";
import { KafkaProvider } from "@/lib/db/providers/stream/kafka";
import { loadPlatformatic } from "@/lib/db/providers/stream/kafka/platformatic-client";
import type { DatabaseProvider, ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { snapshotDiff, snapshotLines } from "./kafka-snapshot";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const CONTAINER = env("KAFKA_WRITE_REACH_CONTAINER");
const IMAGE = env("KAFKA_WRITE_REACH_IMAGE");
const OUT = env("KAFKA_WRITE_REACH_OUT");
const PORT = Number(env("KAFKA_WRITE_REACH_PORT"));
const DATE = new Date().toISOString().slice(0, 10);
const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 200, maxResultBytes: 1_000_000, statementTimeoutMs: 10_000 };

const TOPIC = "orders";
const GROUP = "seeded-group";
/** A topic no one created: every handle reads it, and the broker would create it on a Metadata request that allowed it. */
const MISSING = "write-reach-missing";
const CONTROL_TOPIC = "write-reach-control";

const CONNECTION: DatabaseConnection = {
  id: "write-reach",
  name: "write reach",
  type: "kafka",
  host: "localhost",
  port: PORT,
  readOnly: true,
  createdAt: new Date(),
};

function run(command: string, args: readonly string[], input?: string): { code: number; out: string } {
  const result = spawnSync(command, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** One Kafka tool inside the broker's container, through its in-container listener, which must succeed. */
function tool(name: string, args: readonly string[], input?: string): string {
  const full = [
    "exec",
    ...(input === undefined ? [] : ["-i"]),
    CONTAINER,
    `/opt/kafka/bin/${name}`,
    "--bootstrap-server",
    "localhost:19092",
    ...args,
  ];
  const result = run("docker", full, input);
  if (result.code !== 0) throw new Error(`${name} ${args.join(" ")} exited ${result.code}: ${result.out}`);
  return result.out;
}

/** The broker state the read-only live check compares, as tests/live/kafka-read-only.ts reads it. */
function snapshot(): string[] {
  return snapshotLines([
    ["kafka-topics.sh --list", tool("kafka-topics.sh", ["--list"])],
    ["kafka-consumer-groups.sh --list --type", tool("kafka-consumer-groups.sh", ["--list", "--type"])],
    [
      "kafka-consumer-groups.sh --describe --all-groups --offsets",
      tool("kafka-consumer-groups.sh", ["--describe", "--all-groups", "--offsets"]),
    ],
    ["kafka-get-offsets.sh --time -1", tool("kafka-get-offsets.sh", ["--time", "-1"])],
    ["kafka-get-offsets.sh --time -2", tool("kafka-get-offsets.sh", ["--time", "-2"])],
    [
      "kafka-configs.sh --describe --all --entity-type topics",
      tool("kafka-configs.sh", ["--describe", "--all", "--entity-type", "topics"]),
    ],
    [
      "kafka-configs.sh --describe --all --entity-type brokers --entity-name 1",
      tool("kafka-configs.sh", ["--describe", "--all", "--entity-type", "brokers", "--entity-name", "1"]),
    ],
  ]);
}

/** A topic with records and a group that committed part of them, so an offset commit or a produce would show. */
function seed(): void {
  tool("kafka-topics.sh", ["--create", "--topic", TOPIC, "--partitions", "3"]);
  const lines = Array.from({ length: 9 }, (_v, n) => `key-${n}|value-${n}`).join("\n");
  tool(
    "kafka-console-producer.sh",
    ["--topic", TOPIC, "--reader-property", "parse.key=true", "--reader-property", "key.separator=|"],
    `${lines}\n`,
  );
  consume(6);
}

/** Reads `count` records of the topic under the seeded group, which commits their offsets. */
function consume(count: number): void {
  const out = tool("kafka-console-consumer.sh", [
    "--topic",
    TOPIC,
    "--group",
    GROUP,
    "--max-messages",
    String(count),
    "--timeout-ms",
    "20000",
    ...(count === 6 ? ["--from-beginning"] : []),
  ]);
  if (!out.includes("value-")) throw new Error(`the seeded group read nothing: ${out}`);
}

interface SentRecord {
  readonly apiKey: number;
  readonly apiVersion: number;
}

const sent: SentRecord[] = [];

/**
 * Records every request the library sends, at the one method every request goes through. The provider loads the same
 * module through the same loader, so its connections are instances of this class.
 */
async function recordRequests(): Promise<void> {
  const lib = await loadPlatformatic();
  const prototype = (lib.Connection as unknown as { prototype: Record<string, unknown> }).prototype;
  const original = prototype.send as (this: unknown, ...args: unknown[]) => unknown;
  prototype.send = function recorded(this: unknown, apiKey: number, apiVersion: number, ...rest: unknown[]) {
    sent.push({ apiKey, apiVersion });
    return original.call(this, apiKey, apiVersion, ...rest);
  };
}

interface Measured {
  readonly surface: string;
  readonly ok: boolean;
  readonly error?: string;
}

async function attempt(measured: Measured[], surface: string, call: () => Promise<unknown>): Promise<unknown> {
  try {
    const answer = await call();
    measured.push({ surface, ok: true });
    return answer;
  } catch (failure) {
    measured.push({ surface, ok: false, error: (failure as Error).name });
    return undefined;
  }
}

/** Every surface a handle offers, each object kind listed, described and read as source. */
async function surfaces(provider: DatabaseProvider, measured: Measured[]): Promise<void> {
  await attempt(measured, "connect", () => provider.connect());
  for (const kind of provider.getCapabilities().objectKinds ?? []) {
    const objects = await attempt(measured, `listObjects ${kind.id}`, () => provider.listObjects([], kind.id));
    await attempt(measured, `describeObjects ${kind.id}`, () => provider.describeObjects([], kind.id, 5));
    for (const object of Array.isArray(objects) ? (objects as { path: readonly string[] }[]).slice(0, 3) : []) {
      await attempt(measured, `describeObject ${kind.id}`, () => provider.describeObject(object.path, kind.id));
      await attempt(measured, `readObjectSource ${kind.id}`, async () =>
        provider.readObjectSource?.(object.path, kind.id),
      );
    }
  }
  await attempt(measured, `describeObject topic ${MISSING}`, () => provider.describeObject([MISSING], "topic"));
  await attempt(measured, "listContainers", () => provider.listContainers());
  await attempt(measured, "countObjects", () => provider.countObjects([]));
  await attempt(measured, "getHealth", () => provider.getHealth());
  await attempt(measured, "getOverview", () => provider.getOverview());
  await attempt(measured, "getPerformanceMetrics", () => provider.getPerformanceMetrics());
  await attempt(measured, "getSlowQueries", () => provider.getSlowQueries());
  await attempt(measured, "getActiveSessions", () => provider.getActiveSessions());
  await attempt(measured, "getTableStats", () => provider.getTableStats());
  await attempt(measured, "getIndexStats", () => provider.getIndexStats());
  await attempt(measured, "getStorageStats", () => provider.getStorageStats());
  await attempt(measured, "getMonitoringData", () => provider.getMonitoringData());
  for (const type of ["vacuum", "analyze", "reindex", "optimize", "check", "kill"] as const) {
    await attempt(measured, `runMaintenance ${type}`, () => provider.runMaintenance(type, "1"));
  }
}

/** The editor's read requests: every `from` form, a missing topic and an internal one. */
const EDITOR_READS = [
  { topic: TOPIC, from: "earliest", limit: 50 },
  { topic: TOPIC, from: "latest", limit: 5 },
  { topic: TOPIC, partition: 0, from: { offset: "1" }, limit: 5 },
  { topic: TOPIC, from: { timestamp: "2026-01-01T00:00:00Z" }, limit: 5 },
  { topic: MISSING },
  { topic: "__consumer_offsets" },
].map((request) => JSON.stringify(request));

/** The agent's read requests, its closed table's reads and two it refuses. */
const AGENT_READS = [
  '{"read": "topics"}',
  '{"read": "brokers"}',
  `{"read": "partitions", "topic": "${TOPIC}"}`,
  `{"read": "offsets", "topic": "${TOPIC}"}`,
  `{"read": "offsets", "topic": "${MISSING}"}`,
  `{"read": "partitions", "topic": "${MISSING}"}`,
  '{"read": "groups"}',
  '{"read": "topics", "allowAutoTopicCreation": true}',
];

interface HandleRun {
  readonly handle: string;
  readonly surfaces: readonly Measured[];
  readonly snapshotDiff: readonly string[];
  readonly missingTopicCreated: boolean;
}

async function measureHandle(
  handle: string,
  open: () => Promise<DatabaseProvider>,
  statements: (provider: DatabaseProvider, measured: Measured[]) => Promise<void>,
): Promise<HandleRun> {
  const before = snapshot();
  const measured: Measured[] = [];
  const provider = await open();
  await surfaces(provider, measured);
  await statements(provider, measured);
  await provider.disconnect();
  const after = snapshot();
  return {
    handle,
    surfaces: measured,
    snapshotDiff: snapshotDiff(before, after).split("\n").filter(Boolean),
    missingTopicCreated: after.some((line) => line.endsWith(`| ${MISSING}`)),
  };
}

async function main(): Promise<void> {
  seed();
  await recordRequests();

  // The factory's own check: a read-only Kafka connection is accepted, not refused.
  const accepted = await createDatabaseProvider(CONNECTION).then(
    () => true,
    () => false,
  );

  const runs = [
    await measureHandle(
      "read-only connection",
      () => createDatabaseProvider(CONNECTION),
      async (provider, measured) => {
        for (const text of EDITOR_READS) await attempt(measured, `query ${text}`, () => provider.query(text));
      },
    ),
    await measureHandle(
      "agent read-only profile",
      async () =>
        new KafkaProvider(CONNECTION, {}, { readOnly: true, sendsStatements: true } as ProviderExecutionContext),
      async (provider, measured) => {
        for (const text of AGENT_READS) {
          await attempt(measured, `queryReadOnly ${text}`, () => provider.queryReadOnly(text, BUDGET));
        }
      },
    ),
    await measureHandle(
      "agent operations profile",
      async () => new KafkaProvider(CONNECTION, {}, { readOnly: true, sendsStatements: false }),
      async (provider, measured) => {
        await attempt(measured, "query", () => provider.query(EDITOR_READS[0]));
      },
    ),
  ];

  // The control, by this script and never through Studio: one record produced, the seeded group's offsets moved
  // past it, and a topic created. Each moves a part of the snapshot that a Studio write would have moved.
  const beforeControl = snapshot();
  tool("kafka-console-producer.sh", ["--topic", TOPIC], "control\n");
  consume(4);
  tool("kafka-topics.sh", ["--create", "--topic", CONTROL_TOPIC, "--partitions", "1"]);
  const controlDiff = snapshotDiff(beforeControl, snapshot()).split("\n").filter(Boolean);
  const moved = (title: string) => controlDiff.some((line) => line.slice(2).startsWith(`${title} | `));

  const requests = [...new Set(sent.map((request) => `${request.apiKey} v${request.apiVersion}`))].sort(
    (a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10) || a.localeCompare(b),
  );
  const capture = {
    $captured: {
      image: IMAGE,
      date: DATE,
      runtime: `bun ${Bun.version}`,
      broker: "one KRaft node, no authentication, no authorizer, auto.create.topics.enable=true",
      note: "`handles` runs every provider surface of each handle between two broker snapshots; `snapshotDiff` is what moved, and must be empty. `sentByStudio` is every request the client library sent in those runs, as `<API key> v<version>`. `control` is the snapshot diff of the script's own produce, group commit and topic creation.",
    },
    measured: DATE,
    readOnlyConnectionAccepted: accepted,
    handles: runs,
    studioLeftStateUnchanged: runs.every((entry) => entry.snapshotDiff.length === 0),
    requestsByStudio: sent.length,
    sentByStudio: requests,
    control: {
      topicList: moved("kafka-topics.sh --list"),
      endOffsets: moved("kafka-get-offsets.sh --time -1"),
      committedOffsets: moved("kafka-consumer-groups.sh --describe --all-groups --offsets"),
      diffLines: controlDiff.length,
    },
  };
  const out = posix.join(OUT.replaceAll("\\", "/"), "write-reach.json");
  writeFileSync(out, `${JSON.stringify(capture, null, 2)}\n`);
  console.log(`wrote ${out}`);
}

await main();
// The provider's sockets are closed; anything else the run left is the tools' own, so the process ends here.
process.exit(0);
