/**
 * Opt-in live check for the Kafka provider (#1088): does a real `KafkaProvider`, run over every
 * surface it has, leave the broker exactly as it found it, and does each surface answer?
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The seam guard
 * (`tests/unit/db/kafka/seam-guard.test.ts`) is syntactic: it refuses a write the provider's source
 * could name. It cannot see what the installed client does on the wire, and a future client version
 * whose read path joins a group, commits an offset or creates a topic would pass it. Only the broker
 * can say what changed, so this script snapshots the broker's state before and after a run of every
 * provider surface and fails on any line that differs. The same run is the evidence for the
 * Redpanda relative's tier in `src/lib/db/compatibility.ts`.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in
 * `tests/runner/discover.ts`), the arrangement `tests/live/mysql-object-vocabulary.ts` has.
 *
 * WHAT IT CHECKS, in the order it runs:
 *   - with `--tripwire`, on a broker it recreates and seeds with topics and records only: the
 *     fetch, offset and metadata reads leave `__consumer_offsets` absent, which only a
 *     group-coordinator lookup creates, and the group seed that follows makes it (the control);
 *   - the broker snapshot: the topic and group lists, every group's committed offsets and log ends,
 *     every partition's earliest and latest offset, internal topics included, the topic and broker
 *     configs, and on `kafka-auth` the ACLs (`rpk` reads the same state on Redpanda);
 *   - every provider surface: counts, each kind's listing, a description, a batch description, one
 *     source of each kind, a read in every `from` form, each seeded topic, a missing topic, an
 *     out-of-range offset and an internal topic, and the three monitoring panels;
 *   - the consumer-group listing against the broker's own CLI, and each group's lag against the
 *     CLI's describe, since a listing that drops every group raises no error;
 *   - that `metadata([])` reaches the broker on every call (a forwarder counts Metadata frames);
 *   - that a bracket-free IPv6 bootstrap (`::1`) connects, through a forwarder of its own;
 *   - that a provider bootstrapped through a forwarder reads from the advertised address directly
 *     (spec K2), with no Fetch frame through the forwarder;
 *   - that `disconnect()` leaves this process no socket to a broker, and that three reads started
 *     together each answer under 500 ms (spec K8), each partition read from its own leader;
 *   - the snapshot again, which must equal the first, and the broker log since the first, which must
 *     name no automatic topic creation and not the provider's sentinel group; each of those log
 *     searches is paired with a control that must match the broker's whole log.
 *
 * Run it against the compose fixtures (`database-compose.yml`), which are disposable:
 *
 *   bun tests/live/kafka-read-only.ts --tripwire        # recreates and re-seeds `kafka` first
 *   bun tests/live/kafka-read-only.ts                   # `kafka`, localhost:9092
 *   bun tests/live/kafka-read-only.ts --redpanda        # `redpanda`, localhost:29092
 *   bun tests/live/kafka-read-only.ts --bootstrap localhost:9192             # `kafka-cluster`
 *   bun tests/live/kafka-read-only.ts --bootstrap localhost:9192 --failover  # stops and starts node 3
 *   KAFKA_AUTH_PASSWORD=... KAFKA_AUTH_CA=<ca.pem> bun tests/live/kafka-read-only.ts --auth
 *
 * `--auth` connects to `kafka-auth` (localhost:19094) as the principal `reader`, which has no ACL:
 * the listings answer empty, the cluster reads are refused and the panels degrade (spec KM4), and the
 * snapshot adds the ACLs. Its password and CA come from the environment and are never written here.
 *
 * `--failover` runs on `kafka-cluster` only: it stops `libredb-kafka-cluster-3`, waits until the
 * broker reports under-replicated partitions, checks that the provider shows them and still reads
 * every partition of `orders`, starts the node again, waits until nothing is under-replicated, and
 * compares the snapshots taken before the stop and after the restart.
 *
 * It exits non-zero when any check fails, and prints each check with the verbatim error.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { KafkaProvider } from "@/lib/db/providers/stream/kafka";
import type { KafkaReadClient } from "@/lib/db/providers/stream/kafka/client";
import type { DatabaseConnection, QueryResult } from "@/lib/types";

// ============================================================================
// Fixtures and arguments
// ============================================================================

type Flavor = "kafka" | "redpanda";

interface Fixture {
  readonly flavor: Flavor;
  /** Where the broker's own tools run for the snapshot. */
  readonly container: string;
  /**
   * Whose logs are searched after the run. None on Redpanda, which logs neither kind of line the
   * search looks for, and none on `kafka-auth`, whose broker has coordinated no group and created no
   * topic, so no control could show that the search would see one there; its snapshot, ACLs
   * included, is the check.
   */
  readonly logContainers: readonly string[];
  /** The listener the tools inside `container` use. */
  readonly toolBootstrap: string;
  readonly auth: boolean;
  /** On the two-log-dir node of the offline probe: the topic whose partitions went offline, and one that did not. */
  readonly offline?: { readonly topic: string; readonly healthy: string };
}

const FIXTURES: Readonly<Record<string, Fixture>> = {
  "localhost:9092": {
    flavor: "kafka",
    container: "libredb-kafka",
    logContainers: ["libredb-kafka"],
    toolBootstrap: "localhost:19092",
    auth: false,
  },
  "localhost:29092": {
    flavor: "redpanda",
    container: "libredb-redpanda",
    logContainers: [],
    toolBootstrap: "",
    auth: false,
  },
  "localhost:9192": {
    flavor: "kafka",
    container: "libredb-kafka-cluster-1",
    logContainers: ["libredb-kafka-cluster-1", "libredb-kafka-cluster-2", "libredb-kafka-cluster-3"],
    toolBootstrap: "localhost:19092",
    auth: false,
  },
  "localhost:19094": {
    flavor: "kafka",
    container: "libredb-kafka-auth",
    logContainers: [],
    toolBootstrap: "localhost:19092",
    auth: true,
  },
  // A throwaway single node with two log directories, one of them failed, started by hand as
  // docs/providers/kafka.md's offline-partition note shows; it holds no group, so no log search.
  "localhost:9095": {
    flavor: "kafka",
    container: "libredb-kafka-jbod",
    logContainers: [],
    toolBootstrap: "localhost:9095",
    auth: false,
    offline: { topic: "jbod", healthy: "healthy" },
  },
};

/** The group id the adapter's Consumer is built with and never sends (spec 3.2 M-A). */
const SENTINEL_GROUP = "libredb-studio-never-joined";
const CODEC_TOPICS = ["codec-gzip", "codec-snappy", "codec-lz4", "codec-zstd"];
const QUERY_TIMEOUT_MS = 20_000;
const CONCURRENT_READ_BOUND_MS = 500;
const MIB = 1024 * 1024;

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
function option(name: string): string | undefined {
  const at = argv.indexOf(name);
  return at === -1 ? undefined : argv[at + 1];
}

const BOOTSTRAP = flag("--redpanda")
  ? "localhost:29092"
  : flag("--auth")
    ? "localhost:19094"
    : (option("--bootstrap") ?? "localhost:9092");
const fixture = FIXTURES[BOOTSTRAP];
if (fixture === undefined) {
  throw new Error(
    `No fixture is known at ${BOOTSTRAP}: the snapshot needs the container its tools run in. Known: ${Object.keys(FIXTURES).join(", ")}`,
  );
}
const [BOOTSTRAP_HOST, BOOTSTRAP_PORT_TEXT] = BOOTSTRAP.split(":") as [string, string];
const BOOTSTRAP_PORT = Number(BOOTSTRAP_PORT_TEXT);
const TRIPWIRE = flag("--tripwire");
const FAILOVER = flag("--failover");
if (TRIPWIRE && BOOTSTRAP !== "localhost:9092")
  throw new Error("--tripwire recreates the single-node `kafka` service only");
if (FAILOVER && BOOTSTRAP !== "localhost:9192") throw new Error("--failover runs on `kafka-cluster` only");

// ============================================================================
// Outcomes
// ============================================================================

const outcomes: { readonly check: string; readonly ok: boolean; readonly detail: string }[] = [];

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/** Runs one check and records its verbatim outcome; the run goes on either way. */
async function check(name: string, body: () => Promise<string> | string): Promise<void> {
  try {
    const detail = await body();
    outcomes.push({ check: name, ok: true, detail });
    console.log(`PASS ${name}${detail ? `: ${detail}` : ""}`);
  } catch (error) {
    outcomes.push({ check: name, ok: false, detail: describeError(error) });
    console.log(`FAIL ${name}: ${describeError(error)}`);
  }
}

function must(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** A check whose surface must refuse, with this error class and a message holding `text`. */
async function refusal(name: string, className: string, text: string, body: () => Promise<unknown>): Promise<void> {
  await check(name, async () => {
    let answered: unknown;
    try {
      answered = await body();
    } catch (error) {
      const said = describeError(error);
      must(error instanceof Error && error.name === className, `expected ${className}, got ${said}`);
      must(error.message.includes(text), `expected a message holding "${text}", got ${said}`);
      return `refused as expected, ${said}`;
    }
    throw new Error(`expected a ${className} refusal, got an answer: ${JSON.stringify(answered).slice(0, 200)}`);
  });
}

// ============================================================================
// Shell, snapshot and logs
// ============================================================================

function sh(command: string, args: readonly string[], input?: string): string {
  return execFileSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * MIB,
    ...(input === undefined ? { stdio: ["ignore", "pipe", "pipe"] } : { input }),
  });
}

function tool(container: string, name: string, ...args: string[]): string {
  return sh("docker", [
    "exec",
    container,
    `/opt/kafka/bin/${name}`,
    "--bootstrap-server",
    fixture.toolBootstrap,
    ...args,
  ]);
}

function rpk(...args: string[]): string {
  return sh("docker", ["exec", fixture.container, "rpk", ...args]);
}

const sortedLines = (text: string) =>
  text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .sort()
    .join("\n");

/** Rows of a whitespace-aligned CLI table, the header line skipped. */
function tableRows(text: string): string[][] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(1)
    .map((line) => line.split(/\s+/));
}

function cliTopics(): string[] {
  if (fixture.flavor === "redpanda") return tableRows(rpk("topic", "list")).map((row) => row[0] ?? "");
  return sortedLines(tool(fixture.container, "kafka-topics.sh", "--list"))
    .split("\n")
    .filter(Boolean);
}

function cliGroups(): string[] {
  if (fixture.flavor === "redpanda") return tableRows(rpk("group", "list")).map((row) => row[1] ?? "");
  return sortedLines(tool(fixture.container, "kafka-consumer-groups.sh", "--list"))
    .split("\n")
    .filter(Boolean);
}

/** The broker state spec K4 lists, one sorted section per tool. */
function snapshot(): string {
  if (fixture.flavor === "redpanda") {
    const parts: [string, string][] = [
      ["rpk topic list", rpk("topic", "list")],
      ["rpk group list", rpk("group", "list")],
    ];
    for (const group of cliGroups()) parts.push([`rpk group describe ${group}`, rpk("group", "describe", group)]);
    // -a prints the partitions with their log start and high watermark (what -p prints) and the configs.
    for (const topic of cliTopics())
      parts.push([`rpk topic describe -a ${topic}`, rpk("topic", "describe", "-a", topic)]);
    return parts.map(([title, text]) => `## ${title}\n${sortedLines(text)}`).join("\n");
  }
  const c = fixture.container;
  const parts: [string, string][] = [
    ["kafka-topics.sh --list", tool(c, "kafka-topics.sh", "--list")],
    ["kafka-consumer-groups.sh --list --type", tool(c, "kafka-consumer-groups.sh", "--list", "--type")],
    [
      "kafka-consumer-groups.sh --describe --all-groups --offsets",
      tool(c, "kafka-consumer-groups.sh", "--describe", "--all-groups", "--offsets"),
    ],
    ["kafka-get-offsets.sh --time -1", tool(c, "kafka-get-offsets.sh", "--time", "-1")],
    ["kafka-get-offsets.sh --time -2", tool(c, "kafka-get-offsets.sh", "--time", "-2")],
    [
      "kafka-configs.sh --describe --all --entity-type topics",
      tool(c, "kafka-configs.sh", "--describe", "--all", "--entity-type", "topics"),
    ],
    [
      "kafka-configs.sh --describe --all --entity-type brokers --entity-name 1",
      tool(c, "kafka-configs.sh", "--describe", "--all", "--entity-type", "brokers", "--entity-name", "1"),
    ],
  ];
  if (fixture.auth) parts.push(["kafka-acls.sh --list", tool(c, "kafka-acls.sh", "--list")]);
  return parts.map(([title, text]) => `## ${title}\n${sortedLines(text)}`).join("\n");
}

function snapshotDiff(before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  const gone = a.filter((line) => !b.includes(line)).map((line) => `- ${line}`);
  const added = b.filter((line) => !a.includes(line)).map((line) => `+ ${line}`);
  return [...gone, ...added].join("\n");
}

/**
 * The broker log lines that would show a write the snapshot can miss: an empty group with no
 * offsets is deleted on the broker's cleanup tick, and an automatic topic creation of a name this
 * run reads is refused by the snapshot only if the topic survives. Each search is paired with a
 * control over the container's whole log, which must match, so a renamed logger cannot pass it.
 */
async function logChecks(since: string): Promise<void> {
  if (fixture.logContainers.length === 0) return;
  // The controls read the fixture's logs together: on a cluster only the node that coordinated a
  // group or created a topic logged it.
  const whole = fixture.logContainers.map((container) => dockerLogs(container)).join("");
  await check("log controls: the whole log shows both kinds of line the window searches for", () => {
    must(whole.includes("DefaultAutoTopicCreationManager"), "no DefaultAutoTopicCreationManager line in the whole log");
    must(/GroupCoordinator.*lag-classic/.test(whole), "no GroupCoordinator line naming lag-classic in the whole log");
    // And --since reads what it is given: the window from the container's start holds that start.
    for (const container of fixture.logContainers) {
      const started = sh("docker", ["inspect", "-f", "{{.State.StartedAt}}", container]).trim();
      must(dockerLogs(container, started).trim() !== "", `the log of ${container} since its start ${started} is empty`);
    }
    return "the automatic creation of __consumer_offsets, lag-classic's coordination, and each log since its start";
  });
  for (const container of fixture.logContainers) {
    const window = dockerLogs(container, since);
    const lines = window.split("\n").filter((line) => line !== "");
    // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time, in order, so each socket census and log window sees one step
    await check(`log ${container}: no automatic topic creation since the first snapshot`, () => {
      const hits = lines.filter((line) => line.includes("DefaultAutoTopicCreationManager"));
      must(hits.length === 0, `the broker logged ${hits.length} automatic topic creation(s): ${hits.join(" | ")}`);
      return `none in ${lines.length} line(s)`;
    });
    // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time, in order, so each socket census and log window sees one step
    await check(`log ${container}: no line names ${SENTINEL_GROUP} since the first snapshot`, () => {
      const hits = lines.filter((line) => line.includes(SENTINEL_GROUP));
      must(hits.length === 0, `the broker logged the sentinel group: ${hits.join(" | ")}`);
      return `none in ${lines.length} line(s)`;
    });
  }
}

/** A container's log, stdout and stderr together, the broker's whole log or since an instant. */
function dockerLogs(container: string, since?: string): string {
  const args = since === undefined ? ["logs", container] : ["logs", "--since", since, container];
  // `docker logs` replays the container's stderr on its own stderr, so both halves are read.
  const answer = spawnSync("docker", args, { encoding: "utf8", maxBuffer: 256 * MIB });
  if (answer.status !== 0) throw new Error(`docker ${args.join(" ")} exited ${answer.status}: ${answer.stderr}`);
  return `${answer.stdout}${answer.stderr}`;
}

// ============================================================================
// Sockets and forwarders
// ============================================================================

/** The remote ports of this process's established TCP sockets, one entry per socket. */
function ownSocketPeerPorts(): number[] {
  const marker = `pid=${process.pid},`;
  return sh("ss", ["-tnpH", "state", "established"])
    .split("\n")
    .filter((line) => line.includes(marker))
    .map((line) => {
      const peer = line.trim().split(/\s+/)[3] ?? "";
      return Number(peer.slice(peer.lastIndexOf(":") + 1));
    });
}

interface ForwarderStats {
  readonly accepts: number;
  /** Request frames seen from the client side, by API key (3 is Metadata, 1 is Fetch). */
  readonly requests: Readonly<Record<string, number>>;
}

interface Forwarder {
  readonly port: number;
  stats(): Promise<ForwarderStats>;
  close(): void;
}

/**
 * A TCP forwarder in a child process, so its upstream sockets belong to the child and never to
 * this process's socket census. It counts the connections it accepts and each Kafka request frame
 * (a 4-byte size, then the 2-byte API key) the client side sends through it.
 */
const FORWARDER_SOURCE = `
const net = require("node:net");
const counts = { accepts: 0, requests: {} };
const server = net.createServer((client) => {
  counts.accepts += 1;
  const upstream = net.connect(Number(process.env.FWD_TARGET_PORT), process.env.FWD_TARGET_HOST);
  let pending = Buffer.alloc(0);
  client.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 6 && pending.length >= 4 + pending.readInt32BE(0)) {
      const key = pending.readInt16BE(4);
      counts.requests[key] = (counts.requests[key] ?? 0) + 1;
      pending = pending.subarray(4 + pending.readInt32BE(0));
    }
    upstream.write(chunk);
  });
  upstream.on("data", (chunk) => client.write(chunk));
  client.on("close", () => upstream.destroy());
  upstream.on("close", () => client.destroy());
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
});
server.on("error", (error) => {
  process.stdout.write(JSON.stringify({ error: error.code + ": " + error.message }) + "\\n");
  process.exit(1);
});
server.listen(0, process.env.FWD_LISTEN, () => process.stdout.write(JSON.stringify({ port: server.address().port }) + "\\n"));
process.stdin.on("data", () => process.stdout.write(JSON.stringify(counts) + "\\n"));
`;

function startForwarder(listen: string, targetHost: string, targetPort: number): Promise<Forwarder> {
  const child = spawn(process.execPath, ["-e", FORWARDER_SOURCE], {
    env: { ...process.env, FWD_LISTEN: listen, FWD_TARGET_HOST: targetHost, FWD_TARGET_PORT: String(targetPort) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const waiting: ((line: string) => void)[] = [];
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffered += chunk;
    for (let at = buffered.indexOf("\n"); at !== -1; at = buffered.indexOf("\n")) {
      const line = buffered.slice(0, at);
      buffered = buffered.slice(at + 1);
      waiting.shift()?.(line);
    }
  });
  const nextLine = () => new Promise<string>((resolve) => waiting.push(resolve));
  return nextLine().then((line) => {
    const first = JSON.parse(line) as { port?: number; error?: string };
    if (first.error !== undefined || first.port === undefined) {
      throw new Error(`the forwarder could not listen on ${listen}: ${first.error ?? line}`);
    }
    return {
      port: first.port,
      stats: () => {
        const answer = nextLine();
        child.stdin.write("\n");
        return answer.then((text) => JSON.parse(text) as ForwarderStats);
      },
      close: () => child.kill(),
    };
  });
}

// ============================================================================
// Providers
// ============================================================================

function connectionTo(host: string, port: number): DatabaseConnection {
  const base = {
    id: `live-${host}-${port}`,
    name: "kafka live check",
    type: "kafka",
    host,
    port,
    createdAt: new Date(),
  };
  if (!fixture.auth) return base as unknown as DatabaseConnection;
  const password = process.env.KAFKA_AUTH_PASSWORD;
  const caPath = process.env.KAFKA_AUTH_CA;
  if (!password || !caPath) throw new Error("--auth needs KAFKA_AUTH_PASSWORD and KAFKA_AUTH_CA from the environment");
  return {
    ...base,
    saslMechanism: "SCRAM-SHA-512",
    user: "reader",
    password,
    ssl: { mode: "verify-full", caCert: readFileSync(caPath, "utf8") },
  } as unknown as DatabaseConnection;
}

async function connected(host: string, port: number): Promise<KafkaProvider> {
  const provider = new KafkaProvider(connectionTo(host, port), { queryTimeout: QUERY_TIMEOUT_MS });
  await provider.connect();
  return provider;
}

/** The provider's own client, which the live check reads to count what one call sends. */
function clientOf(provider: KafkaProvider): KafkaReadClient {
  return (provider as unknown as { client: KafkaReadClient }).client;
}

const read = (provider: KafkaProvider, request: object): Promise<QueryResult> =>
  provider.query(JSON.stringify(request));

function sourceText(parts: readonly { readonly id: string; readonly text?: string }[], id: string): string {
  const part = parts.find((candidate) => candidate.id === id);
  must(part?.text !== undefined, `the source has no "${id}" part with text`);
  return part.text;
}

interface PartitionRow {
  readonly partition: number;
  readonly leader: number;
  /** Null on a topic with a leaderless partition, whose offsets are not read. */
  readonly earliestOffset?: string | null;
  readonly latestOffset?: string | null;
}

async function topicPartitions(provider: KafkaProvider, topic: string): Promise<PartitionRow[]> {
  const source = await provider.readObjectSource([topic], "topic");
  return JSON.parse(sourceText(source.parts, "partitions")) as PartitionRow[];
}

// ============================================================================
// The surfaces
// ============================================================================

/** The reads of the tripwire pass and of item 2: every `from` form on `orders`, and each seeded topic. */
async function readSurfaces(provider: KafkaProvider): Promise<void> {
  const partitions = await topicPartitions(provider, "orders");
  const span = partitions.reduce((sum, p) => sum + Number(p.latestOffset) - Number(p.earliestOffset), 0);

  let firstTimestamp = "";
  await check("query orders from earliest", async () => {
    const result = await read(provider, { topic: "orders", from: "earliest", limit: 500 });
    must(
      result.rowCount === Math.min(span, 500),
      `expected ${Math.min(span, 500)} rows, the offset span, got ${result.rowCount}`,
    );
    firstTimestamp = String(result.rows[0]?.timestamp);
    return `${result.rowCount} rows`;
  });
  await check("query orders from latest (default limit)", async () => {
    const result = await read(provider, { topic: "orders" });
    must(result.rowCount === Math.min(span, 50), `expected ${Math.min(span, 50)} rows, got ${result.rowCount}`);
    return `${result.rowCount} rows`;
  });
  await check("query orders partition 0 from an offset", async () => {
    const start = Number(partitions.find((p) => p.partition === 0)?.earliestOffset ?? 0) + 5;
    const result = await read(provider, { topic: "orders", partition: 0, from: { offset: String(start) }, limit: 3 });
    const offsets = result.rows.map((row) => `${row.partition}@${row.offset}`);
    must(offsets.join(",") === [0, 1, 2].map((n) => `0@${start + n}`).join(","), `got ${offsets.join(",")}`);
    const first = result.rows[0] as { key_encoding?: string; headers?: Record<string, unknown> };
    must(first.key_encoding === "text", `expected a text key, got ${first.key_encoding}`);
    must(
      Array.isArray(first.headers?.trace),
      `expected the repeated trace header as an array, got ${JSON.stringify(first.headers)}`,
    );
    return offsets.join(", ");
  });
  await check("query orders from a timestamp", async () => {
    must(firstTimestamp !== "", "the earliest read gave no timestamp to start from");
    const result = await read(provider, { topic: "orders", from: { timestamp: firstTimestamp }, limit: 500 });
    must(result.rowCount > 0, "no rows at or after the first record's timestamp");
    must(
      result.rows.every((row) => String(row.timestamp) >= firstTimestamp),
      "a row lies before the requested timestamp",
    );
    return `${result.rowCount} rows at or after ${firstTimestamp}`;
  });
  for (const topic of CODEC_TOPICS) {
    // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time, in order, so each socket census and log window sees one step
    await check(`query ${topic}`, async () => {
      const result = await read(provider, { topic, from: "earliest", limit: 50 });
      const codec = topic.slice("codec-".length);
      must(result.rowCount === 20, `expected 20 rows, got ${result.rowCount}`);
      must(
        result.rows.every((row) => row.value_encoding === "json" && (row.value as { codec?: string }).codec === codec),
        "a row is not the seeded JSON of its codec",
      );
      return "20 JSON rows";
    });
  }
  await check("query big (one 900,000-byte record)", async () => {
    const result = await read(provider, { topic: "big", from: "earliest", limit: 1 });
    must(result.rowCount === 1, `expected 1 row, got ${result.rowCount}`);
    const warnings = (result.warnings ?? []).map((w) => w.message).join(" | ");
    must(/cut/.test(warnings), `expected a cell-cut warning, got "${warnings}"`);
    must(result.pagination?.wasLimited === true, "wasLimited is not set");
    return `value cut to ${String(result.rows[0]?.value).length} characters, warning "${warnings}"`;
  });
  await check("query bytes (a Confluent frame and a non-UTF-8 value)", async () => {
    const result = await read(provider, { topic: "bytes", from: "earliest" });
    const encodings = result.rows.map((row) => row.value_encoding).join(",");
    must(encodings === "confluent,base64", `expected confluent,base64, got ${encodings}`);
    return result.rows.map((row) => String(row.value)).join(" | ");
  });
  await check("query ts-append (LogAppendTime)", async () => {
    const result = await read(provider, { topic: "ts-append", from: "earliest" });
    must(result.rowCount === 2, `expected 2 rows, got ${result.rowCount}`);
    must(
      result.rows.every((row) => typeof row.timestamp === "string"),
      "a row has no timestamp",
    );
    return result.rows.map((row) => String(row.timestamp)).join(", ");
  });
  await check("query txn (committed rows only, no marker)", async () => {
    const result = await read(provider, { topic: "txn", from: "earliest" });
    const values = result.rows.map((row) => JSON.stringify(row.value));
    must(
      values.join(",") === '{"txn":"committed","n":1},{"txn":"committed","n":2}',
      `expected the two committed records only, got ${values.join(",")}`,
    );
    return values.join(", ");
  });
}

async function refusalSurfaces(provider: KafkaProvider): Promise<void> {
  const missing = `libredb-live-missing-${process.pid}`;
  await refusal("query a missing topic", "QueryError", "does not exist", () => read(provider, { topic: missing }));
  await check("the missing topic was not created", () => {
    must(!cliTopics().includes(missing), `${missing} now exists on the broker`);
    return "absent from the broker's own topic list";
  });
  await refusal("query an out-of-range offset", "QueryError", "range", () =>
    read(provider, { topic: "orders", partition: 0, from: { offset: "999999999" } }),
  );
  await refusal("query __consumer_offsets", "QueryError", "internal", () =>
    read(provider, { topic: "__consumer_offsets" }),
  );
}

async function objectSurfaces(provider: KafkaProvider): Promise<{ brokerPorts: number[] }> {
  const brokerPorts: number[] = [];
  await check("countObjects", async () => {
    const counts = await provider.countObjects([]);
    const topics = cliTopics().filter((name) => !name.startsWith("__"));
    const topicCount = counts.topic as { count?: number };
    const groupCount = counts.consumer_group as { count?: number };
    must(topicCount.count === topics.length, `topics ${JSON.stringify(counts.topic)}, the CLI lists ${topics.length}`);
    must(
      groupCount.count === cliGroups().length,
      `groups ${JSON.stringify(counts.consumer_group)}, the CLI lists ${cliGroups().length}`,
    );
    return JSON.stringify(counts);
  });
  for (const kind of ["topic", "consumer_group", "broker"]) {
    // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time, in order, so each socket census and log window sees one step
    await check(`listObjects ${kind}`, async () => {
      const rows = await provider.listObjects([], kind);
      must(rows.length > 0, "no rows");
      if (kind === "broker") {
        for (const row of rows) brokerPorts.push(Number(row.name.slice(row.name.lastIndexOf(":") + 1)));
      }
      if (kind === "topic") {
        const flagged = rows.filter((row) => row.status !== undefined).map((row) => `${row.name}: ${row.status}`);
        must(flagged.length === 0, `topics with a status on a healthy broker: ${flagged.join(", ")}`);
      }
      return rows.map((row) => row.name).join(", ");
    });
  }
  await check("describeObject orders", async () => {
    const detail = await provider.describeObject(["orders"], "topic");
    return detail.columns.map((column) => column.name).join(", ");
  });
  await check("describeObjects topics", async () => {
    const batch = await provider.describeObjects([], "topic");
    must(batch.details.length > 0, "no details");
    return `${batch.details.length} topics described${batch.truncated ? `, truncated: ${batch.truncated.reason}` : ""}`;
  });
  await check("readObjectSource topic orders", async () => {
    const source = await provider.readObjectSource(["orders"], "topic");
    const partitions = JSON.parse(sourceText(source.parts, "partitions")) as PartitionRow[];
    must(
      partitions.every((p) => typeof p.latestOffset === "string"),
      "a partition has no latest offset",
    );
    return `${partitions.length} partitions, parts ${source.parts.map((p) => p.id).join(", ")}`;
  });
  await check("readObjectSource consumer_group lag-classic", async () => {
    const source = await provider.readObjectSource(["lag-classic"], "consumer_group");
    return `parts ${source.parts.map((p) => p.id).join(", ")}`;
  });
  await check("readObjectSource broker", async () => {
    const [broker] = await provider.listObjects([], "broker");
    must(broker !== undefined, "no broker listed");
    const source = await provider.readObjectSource(broker.path, "broker");
    const text = source.parts.map((part) => ("text" in part ? String(part.text) : "")).join("\n");
    const redacted = (text.match(/redacted by the broker/g) ?? []).length;
    return `broker ${broker.name}, ${redacted} value(s) redacted by the broker`;
  });
  return { brokerPorts };
}

async function monitoringSurfaces(provider: KafkaProvider): Promise<void> {
  await check("getOverview", async () => JSON.stringify(await provider.getOverview()));
  await check("getHealth", async () => JSON.stringify(await provider.getHealth()));
  await check("getStorageStats", async () => JSON.stringify(await provider.getStorageStats()));
}

// ============================================================================
// Groups against the CLI
// ============================================================================

interface CliLagRow {
  readonly group: string;
  readonly topic: string;
  readonly partition: number;
  readonly committed: string | null;
  readonly logEnd: string;
  readonly lag: string | null;
}

const dash = (cell: string | undefined): string | null => (cell === undefined || cell === "-" ? null : cell);

/** Each group's committed offsets, log ends and lag as the broker's own tool reports them. */
function cliLag(group: string): CliLagRow[] {
  if (fixture.flavor === "redpanda") {
    const text = rpk("group", "describe", group);
    const table = text.slice(text.indexOf("TOPIC"));
    return tableRows(table).map((row) => ({
      group,
      topic: row[0] ?? "",
      partition: Number(row[1]),
      committed: dash(row[2]),
      logEnd: row[4] ?? "",
      lag: dash(row[5]),
    }));
  }
  const text = tool(fixture.container, "kafka-consumer-groups.sh", "--describe", "--group", group, "--offsets");
  return text
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((row) => row[0] === group && row[1] !== "TOPIC")
    .map((row) => ({
      group,
      topic: row[1] ?? "",
      partition: Number(row[2]),
      committed: dash(row[3]),
      logEnd: row[4] ?? "",
      lag: dash(row[5]),
    }));
}

async function groupSurfaces(provider: KafkaProvider): Promise<void> {
  const listed = (await provider.listObjects([], "consumer_group")).map((row) => row.name).sort();
  await check("consumer_group listing equals the broker's own", () => {
    const cli = [...cliGroups()].sort();
    must(listed.length > 0, "the provider listed no group");
    must(JSON.stringify(listed) === JSON.stringify(cli), `provider [${listed.join(", ")}], CLI [${cli.join(", ")}]`);
    return listed.join(", ");
  });
  for (const group of listed) {
    // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time, in order, so each socket census and log window sees one step
    await check(`lag of ${group} equals the CLI's describe`, async () => {
      const source = await provider.readObjectSource([group], "consumer_group");
      const rows = JSON.parse(sourceText(source.parts, "offsets")) as {
        topic: string;
        partition: number;
        committedOffset: string | null;
        latestOffset: string | null;
        lag: string | null;
      }[];
      const cli = cliLag(group);
      must(cli.length > 0, "the CLI describes no partition for the group");
      for (const expected of cli) {
        const row = rows.find((r) => r.topic === expected.topic && r.partition === expected.partition);
        must(row !== undefined, `the provider shows no row for ${expected.topic}/${expected.partition}`);
        const got = `${row.committedOffset}/${row.latestOffset}/${row.lag}`;
        const want = `${expected.committed}/${expected.logEnd}/${expected.lag}`;
        must(
          got === want,
          `${expected.topic}/${expected.partition}: provider ${got}, CLI ${want} (committed/log end/lag)`,
        );
      }
      // A row the CLI does not print is a partition with no committed offset, which the provider shows as null.
      const extra = rows.filter((r) => !cli.some((c) => c.topic === r.topic && c.partition === r.partition));
      must(
        extra.every((r) => r.committedOffset === null && r.lag === null),
        `rows the CLI does not print carry an offset: ${JSON.stringify(extra)}`,
      );
      return rows
        .map((r) => `${r.topic}/${r.partition} ${r.committedOffset ?? "-"}/${r.latestOffset ?? "-"}/${r.lag ?? "-"}`)
        .join(", ");
    });
  }
}

// ============================================================================
// Wire checks: items 3, 4, 6 and 7
// ============================================================================

async function forwardedSurfaces(): Promise<void> {
  let forwarder: Forwarder | undefined;
  let provider: KafkaProvider | undefined;
  try {
    forwarder = await startForwarder(
      "127.0.0.1",
      BOOTSTRAP_HOST === "localhost" ? "127.0.0.1" : BOOTSTRAP_HOST,
      BOOTSTRAP_PORT,
    );
    provider = await connected("127.0.0.1", forwarder.port);
    const through = forwarder;
    const client = clientOf(provider);
    await check("metadata([]) answers brokers and no topics, and reaches the broker on each call", async () => {
      const before = (await through.stats()).requests["3"] ?? 0;
      for (let call = 0; call < 2; call += 1) {
        // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time, in order, so each socket census and log window sees one step
        const metadata = await client.metadata([]);
        must(metadata.brokers.length > 0, "no broker in the answer");
        must(metadata.topics.length === 0, `topics in the answer: ${metadata.topics.map((t) => t.name).join(", ")}`);
      }
      const after = (await through.stats()).requests["3"] ?? 0;
      must(after - before === 2, `the forwarder counted ${after - before} Metadata frame(s) for two calls`);
      return "two calls, two Metadata frames through the bootstrap";
    });
    await check("K2: a read reaches the advertised address directly, not through the bootstrap forwarder", async () => {
      const result = await read(provider as KafkaProvider, { topic: "orders", from: "latest", limit: 5 });
      must(result.rowCount > 0, "the read answered no rows");
      const stats = await through.stats();
      must((stats.requests["1"] ?? 0) === 0, `${stats.requests["1"]} Fetch frame(s) went through the forwarder`);
      const peers = ownSocketPeerPorts();
      const direct = peers.filter((port) => port !== through.port);
      must(direct.length > 0, `no socket of this process reaches a broker directly; peers ${peers.join(", ")}`);
      const toForwarder = peers.filter((port) => port === through.port).length;
      must(
        toForwarder === stats.accepts,
        `the forwarder accepted ${stats.accepts} connection(s), and this process holds ${toForwarder} to it`,
      );
      return `forwarder accepted ${stats.accepts} bootstrap connection(s) and no Fetch frame; direct sockets to ports ${[...new Set(direct)].join(", ")}`;
    });
  } catch (error) {
    await check("forwarded provider", () => {
      throw error;
    });
  } finally {
    await provider?.disconnect();
    forwarder?.close();
  }
}

async function ipv6Bootstrap(): Promise<void> {
  let forwarder: Forwarder | undefined;
  let provider: KafkaProvider | undefined;
  await check("a bracket-free IPv6 bootstrap (::1) connects", async () => {
    try {
      forwarder = await startForwarder("::1", "127.0.0.1", BOOTSTRAP_PORT);
      provider = await connected("::1", forwarder.port);
      const brokers = await provider.listObjects([], "broker");
      const names = brokers.map((row) => row.name);
      must(names.length > 0 && names.every((name) => name.includes(" localhost:")), `brokers ${names.join(", ")}`);
      const stats = await forwarder.stats();
      must(stats.accepts > 0, "the IPv6 forwarder accepted no connection");
      return `brokers ${names.join(", ")}; the IPv6 forwarder accepted ${stats.accepts} bootstrap connection(s)`;
    } finally {
      await provider?.disconnect();
      forwarder?.close();
    }
  });
}

async function concurrencyAndLeaders(): Promise<void> {
  const provider = await connected(BOOTSTRAP_HOST, BOOTSTRAP_PORT);
  try {
    await check("K8: three reads started together each answer under 500 ms", async () => {
      const request = { topic: "orders", from: "latest", limit: 50 };
      const timed = () => {
        const started = performance.now();
        return read(provider, request).then((result) => ({ rows: result.rowCount, ms: performance.now() - started }));
      };
      const answers = await Promise.all([timed(), timed(), timed()]);
      const text = answers.map((a) => `${a.rows} rows in ${a.ms.toFixed(1)} ms`).join(", ");
      must(
        answers.every((a) => a.rows > 0 && a.ms < CONCURRENT_READ_BOUND_MS),
        text,
      );
      return text;
    });
    await check(
      "each partition of orders is read from its own leader, and only bootstrap and leaders are reached",
      async () => {
        const partitions = await topicPartitions(provider, "orders");
        const brokers = await provider.listObjects([], "broker");
        const portOf = new Map(
          brokers.map((row) => [Number(row.path[0]), Number(row.name.slice(row.name.lastIndexOf(":") + 1))]),
        );
        for (const p of partitions) {
          // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time, in order, so each socket census and log window sees one step
          const result = await read(provider, { topic: "orders", partition: p.partition, from: "earliest", limit: 5 });
          must(result.rowCount > 0, `partition ${p.partition} answered no rows`);
          must(
            result.rows.every((row) => row.partition === p.partition),
            `partition ${p.partition} answered another partition's rows`,
          );
        }
        const leaderPorts = new Set(partitions.map((p) => portOf.get(p.leader)));
        const allowed = new Set([BOOTSTRAP_PORT, ...leaderPorts]);
        const peers = ownSocketPeerPorts();
        const stray = peers.filter((port) => !allowed.has(port));
        must(stray.length === 0, `sockets to ports outside the bootstrap and the leaders: ${stray.join(", ")}`);
        for (const port of leaderPorts) must(peers.includes(port as number), `no socket to leader port ${port}`);
        return `leaders ${partitions.map((p) => `${p.partition}->${p.leader}`).join(", ")}; sockets to ports ${[...new Set(peers)].sort().join(", ")}`;
      },
    );
  } finally {
    await provider.disconnect();
  }
}

async function noSocketLeft(label: string): Promise<void> {
  await check(`K8: after disconnect() (${label}), no socket of this process is open to a broker`, () => {
    const peers = ownSocketPeerPorts();
    must(peers.length === 0, `still connected to ports ${peers.join(", ")}`);
    return "none";
  });
}

// ============================================================================
// Tripwire and failover
// ============================================================================

function compose(...args: string[]): void {
  sh("docker", ["compose", "-f", "database-compose.yml", ...args]);
}

/** The seed in a throwaway container, bounded as the fixture containers are. */
function seed(part: "topics" | "groups"): void {
  sh("docker", [
    "run",
    "--rm",
    "--network",
    "host",
    "--cpus",
    "1.5",
    "--memory",
    "1g",
    "--memory-swap",
    "1g",
    "-v",
    `${process.cwd()}/docker/kafka/seed.sh:/seed.sh:ro`,
    "--entrypoint",
    "bash",
    "apache/kafka:4.3.1",
    "/seed.sh",
    "localhost:9092",
    part,
  ]);
}

async function tripwire(): Promise<void> {
  console.log("tripwire: recreating the kafka service and seeding topics and records only");
  compose("rm", "-sf", "kafka", "kafka-init");
  compose("up", "-d", "--wait", "kafka");
  seed("topics");
  sh("bun", ["docker/kafka/seed-binary.ts", "localhost:9092"]);
  const provider = await connected(BOOTSTRAP_HOST, BOOTSTRAP_PORT);
  try {
    await readSurfaces(provider);
  } finally {
    await provider.disconnect();
  }
  await check("tripwire: the reads left __consumer_offsets absent", () => {
    const topics = cliTopics();
    must(
      topics.includes("orders"),
      `control failed: the topic list does not hold the seeded orders: ${topics.join(", ")}`,
    );
    must(!topics.includes("__consumer_offsets"), "__consumer_offsets exists: something asked for a group coordinator");
    return `${topics.length} topics, no __consumer_offsets`;
  });
  seed("groups");
  await check("tripwire control: the group seed creates __consumer_offsets", () => {
    must(
      cliTopics().includes("__consumer_offsets"),
      "the group seed did not create __consumer_offsets, so its absence proves nothing",
    );
    return "present after the group seed";
  });
}

async function waitFor(what: string, done: () => boolean, timeoutMs: number): Promise<number> {
  const started = Date.now();
  while (!done()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out after ${timeoutMs} ms waiting until ${what}`);
    // oxlint-disable-next-line no-await-in-loop -- polls the broker until the state holds
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return Date.now() - started;
}

const underReplicated = () =>
  tool(fixture.container, "kafka-topics.sh", "--describe", "--under-replicated-partitions").trim();

async function failover(): Promise<void> {
  const before = snapshot();
  sh("docker", ["stop", "libredb-kafka-cluster-3"]);
  try {
    const waited = await waitFor(
      "the cluster reports under-replicated partitions",
      () => underReplicated() !== "",
      120_000,
    );
    console.log(`failover: node 3 stopped, under-replicated after ${waited} ms`);
    const provider = await connected(BOOTSTRAP_HOST, BOOTSTRAP_PORT);
    try {
      await check("failover: orders reads as under-replicated", async () => {
        const orders = (await provider.listObjects([], "topic")).find((row) => row.name === "orders");
        must(orders?.status === "under-replicated", `orders status ${orders?.status}`);
        return "under-replicated";
      });
      await check("failover: the Brokers folder lists nodes 1 and 2 only", async () => {
        const names = (await provider.listObjects([], "broker")).map((row) => row.name);
        must(names.join(",") === "1 localhost:9192,2 localhost:9193", names.join(", "));
        return names.join(", ");
      });
      await check("failover: every partition of orders still reads", async () => {
        const partitions = await topicPartitions(provider, "orders");
        const answered: string[] = [];
        for (const p of partitions) {
          // oxlint-disable-next-line no-await-in-loop -- the checks run one at a time, in order, so each socket census and log window sees one step
          const result = await read(provider, { topic: "orders", partition: p.partition, from: "earliest", limit: 5 });
          must(result.rowCount > 0, `partition ${p.partition} answered no rows`);
          answered.push(`${p.partition} (leader ${p.leader}) ${result.rowCount} rows`);
        }
        return answered.join(", ");
      });
      await monitoringSurfaces(provider);
    } finally {
      await provider.disconnect();
    }
  } finally {
    sh("docker", ["start", "libredb-kafka-cluster-3"]);
  }
  const waited = await waitFor("nothing is under-replicated", () => underReplicated() === "", 300_000);
  console.log(`failover: node 3 started, fully replicated after ${waited} ms`);
  const provider = await connected(BOOTSTRAP_HOST, BOOTSTRAP_PORT);
  try {
    await check("failover: after the restart every topic is ok again", async () => {
      const flagged = (await provider.listObjects([], "topic")).filter((row) => row.status !== undefined);
      must(flagged.length === 0, flagged.map((row) => `${row.name}: ${row.status}`).join(", "));
      const names = (await provider.listObjects([], "broker")).map((row) => row.name);
      must(names.length === 3, `brokers ${names.join(", ")}`);
      return `no topic status; brokers ${names.join(", ")}`;
    });
  } finally {
    await provider.disconnect();
  }
  await check("K4 failover: the snapshot after the restart equals the one before the stop", () => {
    const after = snapshot();
    const diff = snapshotDiff(before, after);
    must(diff === "", `the broker state changed:\n${diff}`);
    return `${before.split("\n").length} lines identical`;
  });
}

// ============================================================================
// Auth: the principal with no ACL
// ============================================================================

async function offlineSurfaces(provider: KafkaProvider, offline: { topic: string; healthy: string }): Promise<void> {
  await check(
    `offline: the Topics listing shows ${offline.topic} offline and ${offline.healthy} with no status`,
    async () => {
      const rows = await provider.listObjects([], "topic");
      const status = (name: string) => rows.find((row) => row.name === name)?.status;
      must(status(offline.topic) === "offline", `${offline.topic} status ${status(offline.topic)}`);
      must(status(offline.healthy) === undefined, `${offline.healthy} status ${status(offline.healthy)}`);
      return rows.map((row) => `${row.name}${row.status ? ` (${row.status})` : ""}`).join(", ");
    },
  );
  await check(`offline: the source of ${offline.topic} shows its partitions without offsets`, async () => {
    const partitions = await topicPartitions(provider, offline.topic);
    must(partitions.length > 0, "no partitions");
    must(
      partitions.every((p) => p.latestOffset == null && p.earliestOffset == null),
      "a partition carries offsets",
    );
    const leaderless = partitions.filter((p) => p.leader === -1).map((p) => p.partition);
    must(leaderless.length > 0, "no partition without a leader");
    return `${partitions.length} partitions, no offsets, leaderless ${leaderless.join(", ")}`;
  });
  await refusal(`offline: a read of ${offline.topic} is refused naming its partitions`, "QueryError", "partition", () =>
    read(provider, { topic: offline.topic }),
  );
  await check(`offline: a read of ${offline.healthy} still answers`, async () => {
    const result = await read(provider, { topic: offline.healthy, from: "earliest" });
    must(result.rowCount > 0, "no rows");
    return `${result.rowCount} rows`;
  });
  await monitoringSurfaces(provider);
}

async function authSurfaces(provider: KafkaProvider): Promise<void> {
  await check("auth: a principal with no ACL lists no topic and no group, with no error", async () => {
    const counts = await provider.countObjects([]);
    const topics = counts.topic as { count?: number };
    const groups = counts.consumer_group as { count?: number };
    must(topics.count === 0 && groups.count === 0, JSON.stringify(counts));
    return JSON.stringify(counts);
  });
  await refusal("auth: a read of orders is refused", "AuthenticationError", "", () =>
    read(provider, { topic: "orders" }),
  );
  await monitoringSurfaces(provider);
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
  console.log(`Kafka live read-only check against ${BOOTSTRAP} (${fixture.flavor}, snapshot in ${fixture.container})`);
  if (TRIPWIRE) await tripwire();
  if (FAILOVER) {
    await failover();
  } else {
    const since = new Date().toISOString();
    const before = snapshot();
    console.log(`snapshot taken at ${since}: ${before.split("\n").length} lines`);
    const provider = await connected(BOOTSTRAP_HOST, BOOTSTRAP_PORT);
    try {
      if (fixture.auth) {
        await authSurfaces(provider);
      } else if (fixture.offline !== undefined) {
        await offlineSurfaces(provider, fixture.offline);
      } else {
        await objectSurfaces(provider);
        await readSurfaces(provider);
        await refusalSurfaces(provider);
        await monitoringSurfaces(provider);
        await groupSurfaces(provider);
      }
    } finally {
      await provider.disconnect();
    }
    await noSocketLeft("the surfaces' provider");
    if (!fixture.auth && fixture.offline === undefined) {
      await forwardedSurfaces();
      await ipv6Bootstrap();
      await concurrencyAndLeaders();
      await noSocketLeft("every provider");
    }
    await check("K4: the snapshot after the run equals the one before it", () => {
      const after = snapshot();
      const diff = snapshotDiff(before, after);
      must(diff === "", `the broker state changed:\n${diff}`);
      return `${before.split("\n").length} lines identical`;
    });
    await logChecks(since);
  }
  const failed = outcomes.filter((outcome) => !outcome.ok);
  console.log(`\n${outcomes.length - failed.length} of ${outcomes.length} checks passed against ${BOOTSTRAP}`);
  if (failed.length > 0) {
    for (const outcome of failed) console.log(`FAILED ${outcome.check}: ${outcome.detail}`);
    process.exitCode = 1;
  }
}

await main();
