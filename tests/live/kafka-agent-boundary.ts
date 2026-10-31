/**
 * Seeds the broker a <version>/agent-boundary/run.sh started, sends every call the agent's closed table refuses raw,
 * runs the agent's own reads and every agent-mode surface through the provider, and writes what the broker answered,
 * with the broker snapshot before and after, into that run.sh's directory.
 *
 *   bun tests/live/kafka-agent-boundary.ts
 *
 * The environment names the broker: KAFKA_AGENT_FLAVOR (kafka or redpanda), KAFKA_AGENT_CONTAINER, KAFKA_AGENT_IMAGE
 * (the image with its digest), KAFKA_AGENT_OUT (the directory to write) and KAFKA_AGENT_PLAIN_PORT (the plaintext
 * listener, whose principal may create topics); on Apache Kafka also KAFKA_AGENT_SASL_PORT and KAFKA_AGENT_CA, the
 * SCRAM-over-TLS listener and its CA, and on Redpanda KAFKA_AGENT_TOOLS, the container Apache Kafka's tools run in.
 *
 * The refused calls are sent with the broker's own Java tools, never through the provider: no Studio check stands in
 * front of them, which is the point, since what is measured is what the broker does on its own with each one. On
 * Apache Kafka each is sent as `agent-reader`, a SCRAM user holding Describe on every topic, group and the cluster and
 * nothing else, and then as the ANONYMOUS super user, the writable positive control; Redpanda runs with no
 * authentication, so each is sent once. The broker snapshot of tests/live/kafka-snapshot.ts (the topic and group
 * lists, every group's committed offsets, every partition's earliest and latest offset, the topic and broker configs,
 * and the ACLs on Apache Kafka) is taken before and after each principal's calls and around the agent's reads.
 *
 * The reader's password is made here for the run and stays in this process and in one file inside the container; the
 * script refuses to write a capture that holds it.
 *
 * Run by hand through run.sh, never by `bun run test`, which runs no file under tests/live/.
 */
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: a capture records what the broker holds then.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { KafkaProvider } from "@/lib/db/providers/stream/kafka";
import type { ProviderExecutionContext, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { snapshotDiff, snapshotLines } from "./kafka-snapshot";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const FLAVOR = env("KAFKA_AGENT_FLAVOR");
if (FLAVOR !== "kafka" && FLAVOR !== "redpanda") throw new Error("KAFKA_AGENT_FLAVOR is kafka or redpanda");
const KAFKA = FLAVOR === "kafka";
const CONTAINER = env("KAFKA_AGENT_CONTAINER");
const TOOLS = KAFKA ? CONTAINER : env("KAFKA_AGENT_TOOLS");
const IMAGE = env("KAFKA_AGENT_IMAGE");
const OUT = env("KAFKA_AGENT_OUT");
const PLAIN_PORT = Number(env("KAFKA_AGENT_PLAIN_PORT"));
const SASL_PORT = KAFKA ? Number(env("KAFKA_AGENT_SASL_PORT")) : 0;
const CA = KAFKA ? readFileSync(env("KAFKA_AGENT_CA"), "utf8") : "";
const DATE = new Date().toISOString().slice(0, 10);

/** Where the tools reach the broker from inside their container, as a super user. */
const TOOL_BOOTSTRAP = KAFKA ? "localhost:19092" : "localhost:9092";
const READER = "agent-reader";
const READER_PASSWORD = randomBytes(18).toString("hex");
/** The reader's client config, inside the broker's container only. */
const READER_CONFIG = "/tmp/agent-reader.properties";

const BUDGET: ReadOnlyStatementBudget = { maxResultRows: 200, maxResultBytes: 1_000_000, statementTimeoutMs: 10_000 };
const READ_ONLY: ProviderExecutionContext = { readOnly: true, sendsStatements: true };
const OPERATIONS: ProviderExecutionContext = { readOnly: true, sendsStatements: false };

/** What each seeded record carries in its key, value and header: none may reach an agent answer. */
const MARKERS = { key: "agent-marker-key", value: "agent-marker-value", header: "agent-marker-header" } as const;
const TOPICS = { orders: "orders", audit: "audit", disposable: "disposable" } as const;
/** A topic no one created: the agent reads it, and a producer's Metadata, auto-creation allowed, is the control. */
const MISSING = { agent: "missing-agent-read", control: "missing-producer-control" } as const;

function run(command: string, args: readonly string[], input?: string): { code: number; out: string } {
  const result = spawnSync(command, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function must(command: string, args: readonly string[], input?: string): string {
  const result = run(command, args, input);
  if (result.code !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.code}: ${result.out}`);
  return result.out;
}

/** One Kafka tool in the tools container, as the super user, or as the reader with its client config. */
function tool(name: string, args: readonly string[], as: "super" | "reader" = "super", input?: string) {
  const bootstrap = as === "reader" ? ["--bootstrap-server", "localhost:9095", "--command-config", READER_CONFIG] : [];
  const full = [
    "exec",
    ...(input === undefined ? [] : ["-i"]),
    TOOLS,
    `/opt/kafka/bin/${name}`,
    ...(as === "reader" ? bootstrap : ["--bootstrap-server", TOOL_BOOTSTRAP]),
    ...args,
  ];
  return run("docker", full, input);
}

function rpk(...args: string[]): string {
  return must("docker", ["exec", CONTAINER, "rpk", ...args]);
}

/** The broker state the read-only live check compares, as kafka-read-only.ts reads it. */
function snapshot(): string[] {
  if (!KAFKA) {
    const tableRows = (text: string) =>
      text
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(1)
        .map((line) => line.split(/\s+/));
    const parts: [string, string][] = [
      ["rpk topic list", rpk("topic", "list")],
      ["rpk group list", rpk("group", "list")],
    ];
    for (const [, group] of tableRows(rpk("group", "list"))) {
      if (group !== undefined) parts.push([`rpk group describe ${group}`, rpk("group", "describe", group)]);
    }
    for (const [name] of tableRows(rpk("topic", "list"))) {
      if (name !== undefined) parts.push([`rpk topic describe -a ${name}`, rpk("topic", "describe", "-a", name)]);
    }
    return snapshotLines(parts);
  }
  const ok = (name: string, args: string[]) => {
    const result = tool(name, args);
    if (result.code !== 0) throw new Error(`${name} failed: ${result.out}`);
    return result.out;
  };
  return snapshotLines([
    ["kafka-topics.sh --list", ok("kafka-topics.sh", ["--list"])],
    ["kafka-consumer-groups.sh --list --type", ok("kafka-consumer-groups.sh", ["--list", "--type"])],
    [
      "kafka-consumer-groups.sh --describe --all-groups --offsets",
      ok("kafka-consumer-groups.sh", ["--describe", "--all-groups", "--offsets"]),
    ],
    ["kafka-get-offsets.sh --time -1", ok("kafka-get-offsets.sh", ["--time", "-1"])],
    ["kafka-get-offsets.sh --time -2", ok("kafka-get-offsets.sh", ["--time", "-2"])],
    [
      "kafka-configs.sh --describe --all --entity-type topics",
      ok("kafka-configs.sh", ["--describe", "--all", "--entity-type", "topics"]),
    ],
    [
      "kafka-configs.sh --describe --all --entity-type brokers --entity-name 1",
      ok("kafka-configs.sh", ["--describe", "--all", "--entity-type", "brokers", "--entity-name", "1"]),
    ],
    ["kafka-acls.sh --list", ok("kafka-acls.sh", ["--list"])],
  ]);
}

/** The topic names the broker holds, internal ones included. */
function topicNames(): string[] {
  const result = tool("kafka-topics.sh", ["--list"]);
  if (result.code !== 0) throw new Error(`kafka-topics.sh --list failed: ${result.out}`);
  return result.out
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

/** The lines of a tool's output that say what happened: errors and exceptions, without stack frames or timestamps. */
function outcomeLines(out: string): string[] {
  return out
    .split("\n")
    .map((line) => line.replace(/^\[[^\]]*\]\s*/, "").trim())
    .filter((line) => /error|exception|denied|authoriz|not authorized|refused|unknown|failed/i.test(line))
    .filter((line) => !/^at /.test(line))
    .map((line) => line.replace(/\(.*?\.java:\d+\)/g, "").slice(0, 300))
    .slice(0, 6);
}

const recordLine = (n: number) => `h:${MARKERS.header}-${n}#${MARKERS.key}-${n}|${MARKERS.value}-${n}`;

function seed(): void {
  const create = (topic: string, partitions: number) => {
    const result = tool("kafka-topics.sh", ["--create", "--topic", topic, "--partitions", String(partitions)]);
    if (result.code !== 0) throw new Error(`creating ${topic} failed: ${result.out}`);
  };
  create(TOPICS.orders, 3);
  create(TOPICS.audit, 1);
  create(TOPICS.disposable, 1);
  const lines = Array.from({ length: 9 }, (_v, n) => recordLine(n)).join("\n");
  const produced = tool(
    "kafka-console-producer.sh",
    [
      "--topic",
      TOPICS.orders,
      "--reader-property",
      "parse.key=true",
      "--reader-property",
      "key.separator=|",
      "--reader-property",
      "parse.headers=true",
      "--reader-property",
      "headers.delimiter=#",
      "--reader-property",
      "headers.key.separator=:",
    ],
    "super",
    `${lines}\n`,
  );
  if (produced.code !== 0) throw new Error(`seeding orders failed: ${produced.out}`);
  // A committed group, so the snapshot holds one whose offsets a raw OffsetCommit would move.
  const consumed = tool("kafka-console-consumer.sh", [
    "--topic",
    TOPICS.orders,
    "--group",
    "seeded-group",
    "--from-beginning",
    "--max-messages",
    "9",
    "--timeout-ms",
    "15000",
  ]);
  if (!consumed.out.includes(MARKERS.value)) throw new Error(`the seeded group read nothing: ${consumed.out}`);
}

function createReader(): void {
  must("docker", [
    "exec",
    CONTAINER,
    "/opt/kafka/bin/kafka-configs.sh",
    "--bootstrap-server",
    TOOL_BOOTSTRAP,
    "--alter",
    "--entity-type",
    "users",
    "--entity-name",
    READER,
    "--add-config",
    `SCRAM-SHA-512=[iterations=8192,password=${READER_PASSWORD}]`,
  ]);
  for (const resource of [["--topic", "*"], ["--group", "*"], ["--cluster"]]) {
    must("docker", [
      "exec",
      CONTAINER,
      "/opt/kafka/bin/kafka-acls.sh",
      "--bootstrap-server",
      TOOL_BOOTSTRAP,
      "--add",
      "--allow-principal",
      `User:${READER}`,
      "--operation",
      "Describe",
      ...resource,
    ]);
  }
  const config = [
    "security.protocol=SASL_SSL",
    "sasl.mechanism=SCRAM-SHA-512",
    `sasl.jaas.config=org.apache.kafka.common.security.scram.ScramLoginModule required username="${READER}" password="${READER_PASSWORD}";`,
    "ssl.truststore.type=PEM",
    "ssl.truststore.location=/certs/ca.pem",
    "",
  ].join("\n");
  must("docker", ["exec", "-i", CONTAINER, "sh", "-c", `cat > ${READER_CONFIG}`], config);
}

/** Every call the agent's closed table never sends, each as one tool run. */
function refusedCalls(): {
  readonly call: string;
  readonly tool: string;
  readonly args: string[];
  readonly input?: string;
}[] {
  const now = Date.now() - 60_000;
  return [
    {
      call: "Produce",
      tool: "kafka-console-producer.sh",
      args: ["--topic", TOPICS.orders],
      input: "raw-produce\n",
    },
    {
      call: "Fetch (an assigned partition, no group)",
      tool: "kafka-console-consumer.sh",
      args: [
        "--topic",
        TOPICS.orders,
        "--partition",
        "0",
        "--offset",
        "earliest",
        "--max-messages",
        "1",
        "--timeout-ms",
        "8000",
      ],
    },
    {
      call: "CreateTopics",
      tool: "kafka-topics.sh",
      args: ["--create", "--topic", "raw-created", "--partitions", "1"],
    },
    { call: "DeleteTopics", tool: "kafka-topics.sh", args: ["--delete", "--topic", TOPICS.disposable] },
    {
      call: "DeleteRecords",
      tool: "kafka-delete-records.sh",
      args: ["--offset-json-file", "/dev/stdin"],
      input: JSON.stringify({ partitions: [{ topic: TOPICS.orders, partition: 0, offset: 1 }], version: 1 }),
    },
    {
      call: "OffsetCommit (a group's offsets reset)",
      tool: "kafka-consumer-groups.sh",
      args: ["--reset-offsets", "--group", "seeded-group", "--topic", TOPICS.orders, "--to-latest", "--execute"],
    },
    {
      call: "IncrementalAlterConfigs",
      tool: "kafka-configs.sh",
      args: [
        "--alter",
        "--entity-type",
        "topics",
        "--entity-name",
        TOPICS.orders,
        "--add-config",
        "retention.ms=86400001",
      ],
    },
    {
      call: "ListOffsets by timestamp",
      tool: "kafka-get-offsets.sh",
      args: ["--topic", TOPICS.orders, "--time", String(now)],
    },
    {
      call: "ListOffsets at the max-timestamp sentinel (-3)",
      tool: "kafka-get-offsets.sh",
      args: ["--topic", TOPICS.orders, "--time", "-3"],
    },
    {
      call: "Metadata with auto-creation allowed (a producer's, to a missing topic)",
      tool: "kafka-console-producer.sh",
      args: ["--topic", MISSING.control, "--command-property", "max.block.ms=8000"],
      input: "raw-auto-create\n",
    },
  ];
}

function sendRaw(as: "super" | "reader") {
  const before = snapshot();
  const calls = refusedCalls().map((call) => {
    const result = tool(call.tool, call.args, as, call.input);
    return {
      call: call.call,
      command: `${call.tool} ${call.args.join(" ")}`,
      exitCode: result.code,
      answered: outcomeLines(result.out),
      // A fetch's records, counted by marker, so the capture says what came back without holding it.
      recordsReturned: (result.out.match(new RegExp(MARKERS.value, "g")) ?? []).length,
      // An offset lookup's answer, as the number of partition offsets it printed.
      offsetsAnswered: result.out.split("\n").filter((line) => /^orders:\d+:\d+$/.test(line.trim())).length,
    };
  });
  const after = snapshot();
  return { as, calls, snapshotDiff: snapshotDiff(before, after).split("\n").filter(Boolean) };
}

function connection(port: number, sasl: boolean): DatabaseConnection {
  return {
    id: `agent-boundary-${port}`,
    name: "kafka agent boundary",
    type: "kafka",
    host: "localhost",
    port,
    createdAt: new Date(0),
    ...(sasl
      ? {
          saslMechanism: "SCRAM-SHA-512",
          user: READER,
          password: READER_PASSWORD,
          ssl: { mode: "verify-full", caCert: CA },
        }
      : {}),
  } as unknown as DatabaseConnection;
}

async function settle(body: () => Promise<unknown>): Promise<unknown> {
  try {
    return { answered: await body() };
  } catch (error) {
    return { refused: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}

const AGENT_READS = [
  '{"read": "topics"}',
  '{"read": "topics", "after": "audit", "limit": 1}',
  '{"read": "brokers"}',
  '{"read": "partitions", "topic": "orders"}',
  '{"read": "offsets", "topic": "orders"}',
  `{"read": "offsets", "topic": "${MISSING.agent}"}`,
  `{"read": "partitions", "topic": "${MISSING.agent}"}`,
];

const REFUSED_REQUESTS = [
  '{"read": "fetch", "topic": "orders"}',
  '{"read": "offsets", "topic": "orders", "timestamp": "2026-10-31T00:00:00Z"}',
  '{"read": "offsets", "topic": "orders", "time": -3}',
  '{"read": "partitions", "topic": "__consumer_offsets"}',
  '{"read": "groups"}',
  '{"read": "configs", "topic": "orders"}',
  '{"read": "topics", "allowAutoTopicCreation": true}',
  '{"read": "offsets", "topic": ".."}',
];

async function agentRun(port: number, sasl: boolean) {
  const before = snapshot();
  const topicsBefore = topicNames();
  const reads = [];
  const handle = new KafkaProvider(connection(port, sasl), { queryTimeout: 15_000 }, READ_ONLY);
  await handle.connect();
  for (const statement of [...AGENT_READS, ...REFUSED_REQUESTS]) {
    reads.push({ statement, answer: await settle(() => handle.queryReadOnly(statement, BUDGET)) });
  }
  await handle.disconnect();
  const operations = new KafkaProvider(connection(port, sasl), { queryTimeout: 15_000 }, OPERATIONS);
  await operations.connect();
  const surfaces = {
    countObjects: await settle(() => operations.countObjects([])),
    listBrokers: await settle(() => operations.listObjects([], "broker")),
    listGroups: await settle(() => operations.listObjects([], "consumer_group")),
    describeTopic: await settle(() => operations.describeObject([TOPICS.orders], "topic")),
    topicSource: await settle(() => operations.readObjectSource([TOPICS.orders], "topic")),
    health: await settle(() => operations.getHealth()),
    storage: await settle(() => operations.getStorageStats()),
    sessions: await settle(() => operations.getActiveSessions()),
    editorRead: await settle(() => operations.query(`{"topic": "${TOPICS.orders}"}`)),
  };
  await operations.disconnect();
  const after = snapshot();
  const topicsAfter = topicNames();
  return {
    principal: sasl
      ? `${READER} over SCRAM-SHA-512 and TLS`
      : "the plaintext listener's principal, which may create topics",
    reads,
    surfaces,
    missingTopicCreated: topicsAfter.includes(MISSING.agent),
    topicsAdded: topicsAfter.filter((name) => !topicsBefore.includes(name)),
    snapshotDiff: snapshotDiff(before, after).split("\n").filter(Boolean),
  };
}

async function main(): Promise<void> {
  if (KAFKA) createReader();
  seed();
  const seeded = snapshot();
  const agent = [await agentRun(PLAIN_PORT, false), ...(KAFKA ? [await agentRun(SASL_PORT, true)] : [])];
  const raw = KAFKA ? [sendRaw("reader"), sendRaw("super")] : [sendRaw("super")];
  const answers = JSON.stringify(agent);
  const leaks = [
    ...Object.values(MARKERS),
    `localhost:${PLAIN_PORT}`,
    ...(KAFKA ? [`localhost:${SASL_PORT}`] : []),
    "/var/lib/kafka",
    "/var/lib/redpanda",
    "seeded-group",
  ].filter((marker) => answers.includes(marker));

  const capture = {
    $captured: {
      image: IMAGE,
      date: DATE,
      runtime: `bun ${Bun.version}`,
      autoCreateTopics: true,
      principals: KAFKA
        ? `${READER}: SCRAM-SHA-512 over TLS, Describe on every topic, every group and the cluster, nothing else; the plaintext listener's ANONYMOUS principal is a super user, the writable positive control`
        : "no authentication: every call is the writable positive control",
      note: "`agent` runs the provider's agent reads and every agent-mode surface, with the broker snapshot and the topic list before and after. `raw` sends each call the agent's closed table never sends, with the broker's own tools, past every Studio check, with the snapshot before and after each principal's calls. `leaks` lists every seeded record marker, broker address, log-directory root and group id an agent answer holds, and must be empty.",
    },
    markers: MARKERS,
    seededSnapshot: seeded.length,
    agent,
    raw,
    leaks,
  };
  const text = `${JSON.stringify(capture, (_key, value) => (typeof value === "bigint" ? value.toString() : value), 2)}\n`;
  if (text.includes(READER_PASSWORD)) throw new Error("a capture would hold a password");
  writeFileSync(path.join(OUT, "boundary.json"), text);
  console.log(`wrote ${path.join(OUT, "boundary.json")}; leaks: ${leaks.length === 0 ? "none" : leaks.join(", ")}`);
  if (leaks.length > 0) process.exitCode = 1;
}

await main();
// The provider's sockets are closed; anything else the run left is the tools' own, so the process ends here.
process.exit(process.exitCode ?? 0);
