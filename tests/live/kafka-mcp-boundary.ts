/**
 * Live check of MCP's `run_kafka_read` on Apache Kafka, against the broker tests/fixtures/kafka/4.3.1/mcp-boundary/run.sh
 * starts, written into that run.sh's directory as boundary.json.
 *
 *   tests/fixtures/kafka/4.3.1/mcp-boundary/run.sh
 *
 * WHY THIS EXISTS. `run_kafka_read` serves Kafka through the boundary agent mode uses: the connection is acquired under
 * the agent read-only profile, and every read goes through the provider's `queryReadOnly`, whose client holds the
 * Metadata and ListOffsets reads alone and whose answer is the metadata-only projection. The admission in front of it
 * is defence in depth. So this script drives the MCP tool's own handler (`runStatement`) through the factory's own
 * profiled acquisition, with the admission on and with it removed, against a real broker:
 *
 *  - the reads: each of the four forms answers, as a super user, as `mcp-wide` (Describe on every topic and the
 *    cluster) and as `mcp-narrow` (Describe on the topics prefixed `app-` only), and no answer holds a seeded record
 *    marker, a broker address or a credential;
 *  - the data scope: an editor's handle listing every platform topic, the control that the broker marks none of them
 *    internal; the topic listing of each principal, which the broker's Describe grants decide (layer one), and the
 *    platform topics Studio withholds whatever the grants (`_schemas`, `_confluent-metrics`, the three `connect-`
 *    topics) and the internal `__consumer_offsets` (layer two), in `run_kafka_read` and in `inspect_schema`'s listing;
 *    the narrow principal naming a topic it may not describe and a topic that does not exist, whose answers must read
 *    alike;
 *  - the refusals: each request outside the closed table, a write-shaped one among them, refused before anything is
 *    acquired with the admission on, and refused by the provider before anything is sent with it removed, the broker
 *    snapshot unchanged across every call;
 *  - the limits: the largest `limit` a read takes admitted and one past it refused; a read at the minimum `timeout_ms`
 *    while the broker is paused answered as the timeout, and a client cancel while it is paused answered at once, the
 *    broker answering the next call once it resumes.
 *
 * The environment names the broker: KAFKA_MCP_CONTAINER, KAFKA_MCP_IMAGE (with its digest), KAFKA_MCP_OUT (the
 * directory to write), KAFKA_MCP_PLAIN_PORT (the plaintext listener, whose principal is a super user),
 * KAFKA_MCP_SASL_PORT and KAFKA_MCP_CA (the SCRAM-over-TLS listener and its CA). The two SCRAM users' passwords are made
 * here for the run and stay in this process; the script refuses to write a capture or print a line that holds one.
 *
 * Run by hand through run.sh, never by `bun run test`, which runs no file under tests/live/.
 */
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: a capture records what the broker holds then.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import { KafkaProvider } from "@/lib/db/providers/stream/kafka";
import type { McpConnectionContext } from "@/lib/mcp/context";
import type { ToolResult } from "@/lib/mcp/output";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm, type McpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import type { DatabaseConnection } from "@/lib/types";
import { snapshotDiff, snapshotLines } from "./kafka-snapshot";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const CONTAINER = env("KAFKA_MCP_CONTAINER");
const IMAGE = env("KAFKA_MCP_IMAGE");
const OUT = env("KAFKA_MCP_OUT");
const PLAIN_PORT = Number(env("KAFKA_MCP_PLAIN_PORT"));
const SASL_PORT = Number(env("KAFKA_MCP_SASL_PORT"));
const CA = readFileSync(env("KAFKA_MCP_CA"), "utf8");
const DATE = new Date().toISOString().slice(0, 10);
const TOOL_BOOTSTRAP = "localhost:19092";

const USERS = {
  wide: { name: "mcp-wide", password: randomBytes(18).toString("hex") },
  narrow: { name: "mcp-narrow", password: randomBytes(18).toString("hex") },
} as const;
const SECRETS = [USERS.wide.password, USERS.narrow.password];

/** What each seeded record carries in its key and value: none may reach an MCP answer. */
const MARKERS = { key: "mcp-marker-key", value: "mcp-marker-value" } as const;
/** The cluster's own topics, a narrow principal's prefix, and the platform topics Studio withholds. */
const DATA_TOPICS = ["orders", "payroll", "app-orders", "app-audit"] as const;
const PLATFORM_TOPICS = ["_schemas", "_confluent-metrics", "connect-configs", "connect-offsets", "connect-status"];
const MISSING = "missing-mcp-read";

const RUN_KAFKA_READ = mcpStatementArm("run_kafka_read");
const UNFENCED: McpStatementArm = { ...RUN_KAFKA_READ, fence: () => null };

function run(command: string, args: readonly string[], input?: string): { code: number; out: string } {
  const result = spawnSync(command, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status ?? -1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function must(command: string, args: readonly string[], input?: string): string {
  const result = run(command, args, input);
  if (result.code !== 0) throw new Error(`${command} ${args.slice(0, 4).join(" ")} exited ${result.code}`);
  return result.out;
}

/** One Kafka tool inside the broker's container, as the super user. */
function tool(name: string, args: readonly string[], input?: string): string {
  return must(
    "docker",
    [
      "exec",
      ...(input === undefined ? [] : ["-i"]),
      CONTAINER,
      `/opt/kafka/bin/${name}`,
      "--bootstrap-server",
      TOOL_BOOTSTRAP,
      ...args,
    ],
    input,
  );
}

/** The broker state compared before and after: topics, every partition's offsets, the topic configs and the ACLs. */
function snapshot(): string[] {
  return snapshotLines([
    ["kafka-topics.sh --list", tool("kafka-topics.sh", ["--list"])],
    ["kafka-get-offsets.sh --time -1", tool("kafka-get-offsets.sh", ["--time", "-1"])],
    ["kafka-get-offsets.sh --time -2", tool("kafka-get-offsets.sh", ["--time", "-2"])],
    [
      "kafka-configs.sh --describe --all --entity-type topics",
      tool("kafka-configs.sh", ["--describe", "--all", "--entity-type", "topics"]),
    ],
    ["kafka-acls.sh --list", tool("kafka-acls.sh", ["--list"])],
  ]);
}

function seedBroker(): void {
  for (const topic of [...DATA_TOPICS, ...PLATFORM_TOPICS]) {
    tool("kafka-topics.sh", ["--create", "--topic", topic, "--partitions", "2"]);
  }
  const lines = Array.from({ length: 5 }, (_v, n) => `${MARKERS.key}-${n}|${MARKERS.value}-${n}`).join("\n");
  for (const topic of ["orders", "app-orders", "connect-configs", "_schemas"]) {
    tool(
      "kafka-console-producer.sh",
      ["--topic", topic, "--reader-property", "parse.key=true", "--reader-property", "key.separator=|"],
      `${lines}\n`,
    );
  }
  // A consumer group with a committed offset, so __consumer_offsets holds records the listing must not show.
  tool("kafka-console-consumer.sh", [
    "--topic",
    "orders",
    "--group",
    "mcp-seeded-group",
    "--from-beginning",
    "--max-messages",
    "2",
    "--timeout-ms",
    "20000",
  ]);
  const user = ({ name, password }: { name: string; password: string }) =>
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
      name,
      "--add-config",
      `SCRAM-SHA-512=[iterations=8192,password=${password}]`,
    ]);
  user(USERS.wide);
  user(USERS.narrow);
  const acl = (principal: string, resource: readonly string[]) =>
    tool("kafka-acls.sh", ["--add", "--allow-principal", `User:${principal}`, "--operation", "Describe", ...resource]);
  acl(USERS.wide.name, ["--topic", "*"]);
  acl(USERS.wide.name, ["--cluster"]);
  acl(USERS.narrow.name, ["--topic", "app-", "--resource-pattern-type", "prefixed"]);
}

type Principal = "super" | "wide" | "narrow";

function seed(principal: Principal): ManagedConnection {
  const sasl = principal === "super" ? undefined : USERS[principal];
  return {
    id: `seed:live-kafka-${principal}`,
    name: `kafka ${principal}`,
    seedId: `live-kafka-${principal}`,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "kafka",
    host: "localhost",
    port: sasl === undefined ? PLAIN_PORT : SASL_PORT,
    ...(sasl === undefined
      ? {}
      : {
          saslMechanism: "SCRAM-SHA-512",
          user: sasl.name,
          password: sasl.password,
          ssl: { mode: "verify-full", caCert: CA },
        }),
    createdAt: new Date(0),
  } as unknown as ManagedConnection;
}

/** One MCP call on `principal`'s seed, through the factory's own profiled acquisition, as the route makes it. */
async function mcp(
  principal: Principal,
  statement: string,
  { arm = RUN_KAFKA_READ, timeoutMs = 10_000, signal = new AbortController().signal } = {},
): Promise<{ readonly result: ToolResult; readonly acquired: ExecutionProfile[]; readonly ms: number }> {
  const connection = seed(principal);
  const acquired: ExecutionProfile[] = [];
  const context = {
    caller: { username: "live", role: "admin" },
    visibleConnections: async () => [connection],
    resolve: async () => connection,
    acquire: (target: ManagedConnection, profile: ExecutionProfile) => {
      acquired.push(profile);
      return acquireExecutionProfileProvider(target, profile);
    },
  } as unknown as McpConnectionContext;
  const input = arm.inputSchema.parse({
    connection_id: connection.id,
    statement,
    timeout_ms: timeoutMs,
  }) as McpStatementInput;
  const started = Date.now();
  const result = await runStatement(arm, input, { context, signal });
  return { result, acquired, ms: Date.now() - started };
}

const textOf = (result: ToolResult): string =>
  result.content.map((part) => ("text" in part ? part.text : "")).join("\n");

const rowsOf = (result: ToolResult): Record<string, unknown>[] =>
  (result.structuredContent as { rows?: Record<string, unknown>[] } | undefined)?.rows ?? [];

const topicsOf = (result: ToolResult): string[] => rowsOf(result).map((row) => String(row.topic));

interface Check {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: unknown;
}
const checks: Check[] = [];
const answers: string[] = [];

function check(name: string, ok: boolean, detail: unknown): void {
  const line = JSON.stringify(detail);
  if (SECRETS.some((secret) => line.includes(secret) || name.includes(secret))) {
    checks.push({ check: name, ok: false, detail: "a credential reached this check, and is not recorded" });
    console.log(`FAIL ${name}: a credential reached it`);
    return;
  }
  checks.push({ check: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
}

const FORMS = [
  '{"read": "topics", "limit": 500}',
  '{"read": "brokers"}',
  '{"read": "partitions", "topic": "app-orders"}',
  '{"read": "offsets", "topic": "app-orders"}',
];

/** Requests outside the closed table: none may reach the broker, with the admission or without it. */
const REFUSED = [
  ["a fetch", '{"read": "fetch", "topic": "orders"}'],
  ["a produce", '{"read": "produce", "topic": "orders", "value": "x"}'],
  ["the editor's record read", '{"topic": "orders", "from": "earliest"}'],
  ["a timestamp lookup", '{"read": "offsets", "topic": "orders", "timestamp": "2026-11-01T00:00:00Z"}'],
  ["an auto-creation flag", `{"read": "partitions", "topic": "${MISSING}", "allowAutoTopicCreation": true}`],
  ["a group read", '{"read": "groups"}'],
  ["an internal topic", '{"read": "offsets", "topic": "__consumer_offsets"}'],
  ["a platform topic", '{"read": "offsets", "topic": "connect-configs"}'],
  ["a platform topic", '{"read": "partitions", "topic": "_schemas"}'],
  ["a key written twice", '{"read": "topics", "read": "brokers"}'],
  ["a limit past 500", '{"read": "topics", "limit": 501}'],
] as const;

async function reads(): Promise<void> {
  for (const principal of ["super", "wide", "narrow"] as const) {
    for (const statement of FORMS) {
      const { result, acquired } = await mcp(principal, statement);
      answers.push(textOf(result));
      check(`${principal}: ${statement} answers`, result.isError !== true && acquired.join() === "agent-read-only", {
        rows: rowsOf(result),
      });
    }
  }
}

async function dataScope(): Promise<void> {
  const listed: Record<Principal, string[]> = { super: [], wide: [], narrow: [] };
  for (const principal of ["super", "wide", "narrow"] as const) {
    listed[principal] = topicsOf((await mcp(principal, '{"read": "topics", "limit": 500}')).result);
  }
  const withheld = [...PLATFORM_TOPICS, "__consumer_offsets"];
  // The control: the broker marks no platform topic internal, so an editor's handle, which withholds nothing, lists
  // every one of them to the super user, and only __consumer_offsets is left out by the broker's own mark.
  const editor = new KafkaProvider(seed("super") as unknown as DatabaseConnection, { queryTimeout: 15_000 });
  await editor.connect();
  const editorListed = (await editor.listObjects([], "topic")).map((object) => object.name);
  await editor.disconnect();
  check(
    "control: the broker lists every platform topic to an editor's handle, and only __consumer_offsets is internal",
    PLATFORM_TOPICS.every((topic) => editorListed.includes(topic)) && !editorListed.includes("__consumer_offsets"),
    { listed: editorListed },
  );
  for (const principal of ["super", "wide"] as const) {
    check(
      `${principal}: the listing holds every data topic and no platform or internal topic`,
      DATA_TOPICS.every((topic) => listed[principal].includes(topic)) &&
        listed[principal].every((topic) => !withheld.includes(topic)),
      { listed: listed[principal] },
    );
  }
  check(
    "narrow: the listing holds only the app- topics it may describe",
    listed.narrow.join() === "app-audit,app-orders",
    { listed: listed.narrow },
  );

  // inspect_schema's listing runs over the agent-operations profile, through the same agent client.
  for (const principal of ["super", "narrow"] as const) {
    const provider = await acquireExecutionProfileProvider(seed(principal), "agent-operations");
    const names = (await provider.listObjects([], "topic")).map((object) => object.name);
    check(
      `${principal}: inspect_schema's topic listing withholds the platform and internal topics`,
      names.every((name) => !withheld.includes(name)) &&
        (principal === "narrow" ? names.join() === "app-audit,app-orders" : names.includes("payroll")),
      { listed: names },
    );
  }

  // A topic the narrow principal may not describe, and one that does not exist, must answer alike.
  for (const read of ["partitions", "offsets"]) {
    const hit = textOf((await mcp("narrow", `{"read": "${read}", "topic": "payroll"}`)).result);
    const miss = textOf((await mcp("narrow", `{"read": "${read}", "topic": "${MISSING}"}`)).result);
    answers.push(hit, miss);
    check(`narrow: ${read} of a topic it may not describe reads as one that does not exist`, hit === miss, {
      hit,
      miss,
    });
  }
  const created = tool("kafka-topics.sh", ["--list"]).split("\n").includes(MISSING);
  check("no read created the missing topic", !created, { created });
}

async function refusals(): Promise<void> {
  for (const [what, statement] of REFUSED) {
    const before = snapshot();
    const fenced = await mcp("super", statement);
    const unfenced = await mcp("super", statement, { arm: UNFENCED });
    const after = snapshot();
    answers.push(textOf(fenced.result), textOf(unfenced.result));
    const diff = snapshotDiff(before, after);
    check(
      `${what}: ${statement} is refused by the admission before anything is acquired, and by the provider without it`,
      fenced.result.isError === true &&
        fenced.acquired.length === 0 &&
        textOf(fenced.result).startsWith("The read request was refused before it reached the broker") &&
        unfenced.result.isError === true &&
        textOf(unfenced.result).includes("The statement was refused before it reached the database") &&
        diff === "",
      { fenced: textOf(fenced.result), unfenced: textOf(unfenced.result), snapshotDiff: diff },
    );
  }
}

async function limits(): Promise<void> {
  must("docker", ["pause", CONTAINER]);
  try {
    const timed = await mcp("super", '{"read": "topics"}', { timeoutMs: 500 });
    check(
      "a read at the minimum timeout_ms while the broker is paused is answered as the timeout",
      timed.result.isError === true && textOf(timed.result).includes("500 ms") && timed.ms < 3_000,
      { answer: textOf(timed.result), ms: timed.ms },
    );
    const controller = new AbortController();
    const cancelled = mcp("super", '{"read": "brokers"}', { timeoutMs: 10_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    const answered = await cancelled;
    check("a client cancel while the broker is paused ends the wait at once", answered.ms < 3_000, {
      answer: textOf(answered.result),
      isError: answered.result.isError === true,
      ms: answered.ms,
    });
  } finally {
    must("docker", ["unpause", CONTAINER]);
  }
  const next = await mcp("super", '{"read": "brokers"}');
  check("the broker answers the next call once it resumes", next.result.isError !== true, {
    rows: rowsOf(next.result),
    ms: next.ms,
  });
}

async function main(): Promise<void> {
  seedBroker();
  const seeded = snapshot();
  await reads();
  await dataScope();
  await refusals();
  await limits();
  const after = snapshot();
  check("the broker snapshot is unchanged across every MCP call", snapshotDiff(seeded, after) === "", {
    snapshotDiff: snapshotDiff(seeded, after),
  });
  const joined = answers.join("\n");
  const leaks = [...Object.values(MARKERS), `localhost:${PLAIN_PORT}`, `localhost:${SASL_PORT}`, "mcp-seeded-group"]
    .concat(PLATFORM_TOPICS)
    .filter((marker) => joined.includes(marker));
  check("no MCP answer holds a record marker, a broker address, a group id or a platform topic", leaks.length === 0, {
    leaks,
  });
  await clearProviderCache();

  const capture = {
    $captured: {
      image: IMAGE,
      date: DATE,
      runtime: `bun ${Bun.version}`,
      principals:
        "super: the plaintext listener's ANONYMOUS principal, a super user; mcp-wide: SCRAM-SHA-512 over TLS, Describe on every topic and the cluster; mcp-narrow: SCRAM-SHA-512 over TLS, Describe on the topics prefixed app- only",
      note: "Each check drives run_kafka_read's handler through the factory's agent read-only acquisition, with the admission on and, for the refusals, removed. Passwords are made for the run and never recorded.",
    },
    checks,
  };
  const text = `${JSON.stringify(capture, null, 2)}\n`;
  if (SECRETS.some((secret) => text.includes(secret))) throw new Error("the capture holds a credential; not written");
  writeFileSync(path.join(OUT, "boundary.json"), text);
  const failed = checks.filter((entry) => !entry.ok).length;
  console.log(`${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
