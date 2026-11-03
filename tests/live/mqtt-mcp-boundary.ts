/**
 * Live check of MCP's `run_mqtt_read` on the pinned brokers, captured into `boundary.json` beside
 * `tests/fixtures/mqtt/mosquitto-2.1.2/mcp-boundary/run.sh`, which starts a Mosquitto 2.1.2 broker with authentication
 * on and an ACL file (a user that may read every topic, one that may read factory/# alone, one that may read and
 * write) and a stock EMQX 5.8.9, makes the credentials for the run, and removes everything after.
 *
 * WHY THIS EXISTS. `run_mqtt_read` serves MQTT through the boundary agent mode uses: the connection is acquired under
 * the agent read-only profile by the factory itself, and every request goes through the provider's `queryReadOnly`,
 * one fresh session over the closed five-packet encoder and the valve, answered as one window's totals or one named
 * topic's counts and flags. The MCP fence in front of it, the agent's own admission, is defence in depth. So this
 * script drives the tool's own handler (`runStatement`) with a seed connection, fenced as MCP registers it and with
 * the fence removed:
 *
 *   reads      the window and a topic read under the broad login, through the tool: rows, notes, and whether the
 *              answer carried a seeded topic name, a payload or a credential;
 *   sessions   the broker's own log of the clients one call connected: two, each with a client id of its own;
 *   scope      the data scope with the narrow login (layer one, the broker's ACL): the window, a topic it may read, and
 *              a topic outside its ACL that holds a retained message beside one that does not exist, answered alike;
 *              and under the broad login an idle topic beside a missing one, answered alike (layer two, the
 *              projection, which never names a topic);
 *   refused    every form the agent refuses, fenced (nothing acquired) and unfenced (the provider refuses it before
 *              anything is sent);
 *   writes     a raw PUBLISH with the writer's login, the positive control, changes the retained set, while the same
 *              request through the unfenced tool sends nothing and changes nothing;
 *   limits     a read at the least timeout_ms, a timeout_ms one below it, and a client cancel: when MCP answered and
 *              when the provider's own read ended;
 *   collision  a live client holding its own id stays connected through every call;
 *   emqx       the window and a topic read on a stock EMQX, which refuses a subscription to # by its default ACL.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. The capture records no credential, not even
 * a user name, no seeded topic name and no payload: an answer is recorded as its figures and as whether it carried any
 * of them. Each is checked before the file is written; any failed check ends the run non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the broker holds after the one before.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { posix } from "node:path";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import type { DatabaseProvider } from "@/lib/db/types";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_CANCELLED_TEXT, type ToolResult } from "@/lib/mcp/output";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm, type McpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set; run this through run.sh`);
  return value;
};

const PORT = Number(required("MQTT_PORT"));
const EMQX_PORT = Number(required("MQTT_EMQX_PORT"));
const BROKER = required("MQTT_BROKER");
const EMQX = required("MQTT_EMQX");
const OUT = required("MQTT_OUT");
const IMAGE = required("MQTT_IMAGE");
const EMQX_IMAGE = required("MQTT_EMQX_IMAGE");
const BROAD = { user: required("MQTT_BROAD_USER"), password: required("MQTT_BROAD_SECRET") };
const NARROW = { user: required("MQTT_NARROW_USER"), password: required("MQTT_NARROW_SECRET") };
const WRITER = { user: required("MQTT_WRITER_USER"), password: required("MQTT_WRITER_SECRET") };
const SECRETS = [BROAD, NARROW, WRITER].flatMap((login) => [login.user, login.password]);

/** Retained topics whose names stand for the people and devices behind them; none may reach an answer. */
const SEEDED = [
  ["homes/ayse-yilmaz/door", "door-payload-open"],
  ["people/alice/heart-rate", "heart-payload-71"],
  ["factory/press-7/temp", "temp-payload-21"],
] as const;
/** A topic outside the narrow login's ACL with no message on it, and one that names no topic anyone published. */
const IDLE = "homes/ayse-yilmaz/window";
const MISSING = "homes/nobody-here/door";
/** The live client's own id, which Studio must never take over. */
const LIVE_ID = "device-ayse-yilmaz-01";
const WITHHELD = [...SEEDED.flat(), IDLE, MISSING, "ayse", "alice", "press-7", LIVE_ID];

let failures = 0;
function check(ok: boolean, line: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

/** A docker call's output; a client that ends on its own timeout exits non-zero, and its output is still the answer. */
const docker = (...args: string[]): string => {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const out = error as { stdout?: string; stderr?: string };
    if (typeof out.stdout === "string") return out.stdout + (out.stderr ?? "");
    throw error;
  }
};
const as = (login: { user: string; password: string }) => ["-u", login.user, "-P", login.password];
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** The retained set, read raw with the writer's login: how many, and a digest of every topic and payload. */
function retained(): { readonly count: number; readonly sha256: string } {
  const lines = docker("exec", BROKER, "mosquitto_sub", ...as(WRITER), "-v", "-t", "#", "--retained-only", "-W", "2")
    .split("\n")
    .filter((line) => line !== "" && !line.startsWith("Timed out"))
    .sort();
  return { count: lines.length, sha256: sha(lines.join("\n")) };
}

/** The client ids the broker logged as connected since `from` lines of its log, Studio's only. */
function studioClients(from: number): { readonly lines: number; readonly ids: string[] } {
  const log = docker("logs", BROKER).split("\n");
  const ids = log
    .slice(from)
    .filter((line) => line.includes("New client connected"))
    .map((line) => / as (libredb-[0-9a-f]+) /.exec(line)?.[1])
    .filter((id): id is string => id !== undefined);
  return { lines: log.length, ids };
}

function seed(name: string, port: number, login?: { user: string; password: string }): ManagedConnection {
  return {
    id: `seed:live-${name}`,
    name,
    seedId: `live-${name}`,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "mqtt",
    host: "127.0.0.1",
    port,
    ...(login === undefined ? {} : { user: login.user, password: login.password }),
    createdAt: new Date(),
  } as unknown as ManagedConnection;
}

const RUN_MQTT_READ = mcpStatementArm("run_mqtt_read");
/** The tool with its reader removed as a fence: the boundary under test. */
const UNFENCED: McpStatementArm = { ...RUN_MQTT_READ, fence: () => null };
const NOT_SENT = "The statement was refused before it reached the database: ";

/** When the last provider handed out settled its `queryReadOnly`, measured from the call. */
let lastSettledAt: number | null = null;

async function mcp(
  connection: ManagedConnection,
  args: Partial<McpStatementInput> & { readonly statement: string },
  arm: McpStatementArm = RUN_MQTT_READ,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ readonly result: ToolResult; readonly acquired: ExecutionProfile[] }> {
  const acquired: ExecutionProfile[] = [];
  const context = {
    caller: { username: "live", role: "admin" },
    visibleConnections: async () => [connection],
    resolve: async () => connection,
    acquire: async (target: ManagedConnection, profile: ExecutionProfile) => {
      acquired.push(profile);
      const provider: DatabaseProvider = await acquireExecutionProfileProvider(target, profile);
      return new Proxy(provider, {
        get(base, name, receiver) {
          const value = Reflect.get(base, name, receiver);
          if (name !== "queryReadOnly" || typeof value !== "function") return value;
          return (...callArgs: unknown[]) => {
            lastSettledAt = null;
            const started = Date.now();
            const settled = (value as (...a: unknown[]) => Promise<unknown>).apply(base, callArgs);
            void settled.then(
              () => (lastSettledAt = Date.now() - started),
              () => (lastSettledAt = Date.now() - started),
            );
            return settled;
          };
        },
      });
    },
  } as unknown as McpConnectionContext;
  const input = arm.inputSchema.parse({ connection_id: connection.id, ...args }) as McpStatementInput;
  const result = await runStatement(arm, input, { context, signal });
  clearProviderCache();
  return { result, acquired };
}

const textOf = (result: ToolResult): string =>
  result.content.map((part) => ("text" in part ? part.text : "")).join(" ");
const carries = (text: string, words: readonly string[]) => words.some((word) => text.includes(word));

interface Answered {
  readonly rows: Record<string, unknown>[];
  readonly notes?: string[];
}
const answerOf = (result: ToolResult): Answered => result.structuredContent as unknown as Answered;

/** An answer as the capture records it: its row and notes, and whether it carried anything withheld. */
function recorded(result: ToolResult) {
  const text = JSON.stringify(result);
  const answered = answerOf(result);
  return {
    isError: result.isError === true,
    ...(result.isError === true ? { text: textOf(result) } : { rows: answered.rows, notes: answered.notes ?? [] }),
    carriesWithheld: carries(text, WITHHELD),
    carriesCredential: carries(text, SECRETS),
  };
}

/** An answer with the clock's own figures taken out, so two reads of one broker compare. */
const untimed = (result: ToolResult) =>
  JSON.stringify(result.structuredContent ?? result.content)
    .replace(/"(window_ms|listened_ms|last_seen_ms|execution_time_ms|byte_size)":\d+/g, '"$1":0')
    .replace(/\d[\d,]* ms/g, "N ms");

async function main(): Promise<void> {
  for (const [topic, payload] of SEEDED) {
    docker("exec", BROKER, "mosquitto_pub", ...as(WRITER), "-r", "-t", topic, "-m", payload);
  }
  // A live client holding its own id for the whole run, which no call may take over.
  docker("exec", "-d", BROKER, "mosquitto_sub", "-i", LIVE_ID, ...as(WRITER), "-t", "keep/alive", "-W", "600");
  await Bun.sleep(500);
  const before = retained();
  const broad = seed("broad", PORT, BROAD);
  const narrow = seed("narrow", PORT, NARROW);

  // The reads, under the broad login.
  const logBefore = studioClients(0).lines;
  const window = await mcp(broad, { statement: '{"read": "window"}' });
  const clients = studioClients(logBefore);
  const windowAnswer = recorded(window.result);
  check(!window.result.isError && windowAnswer.carriesWithheld === false, "reads: the window answers, naming nothing");
  check(windowAnswer.carriesCredential === false, "reads: the window answer carries no credential");
  check(window.acquired.join(",") === "agent-read-only", "reads: acquired under agent-read-only alone");
  const notes = answerOf(window.result).notes ?? [];
  check(
    notes.length >= 2 && notes.at(-1)?.startsWith("A topic not seen in the window may still exist") === true,
    "reads: the notes carry the window and the completeness sentence",
  );
  check(Number(answerOf(window.result).rows[0]?.topics_seen) >= SEEDED.length, "reads: the window counted the topics");
  check(
    clients.ids.length === 2 && new Set(clients.ids).size === 2,
    `sessions: one call connected two clients, each with its own id (${clients.ids.length})`,
  );
  const topicRead = await mcp(broad, { statement: JSON.stringify({ read: "topic", topic: SEEDED[0][0] }) });
  check(answerOf(topicRead.result).rows[0]?.seen === true, "reads: a retained topic the request names is seen");
  check(!recorded(topicRead.result).carriesWithheld, "reads: the topic read names nothing");

  // Layer two: under the broad login an idle topic and a missing one answer alike.
  const idle = await mcp(broad, { statement: JSON.stringify({ read: "topic", topic: IDLE }) });
  const missing = await mcp(broad, { statement: JSON.stringify({ read: "topic", topic: MISSING }) });
  check(untimed(idle.result) === untimed(missing.result), "scope: an idle topic and a missing one answer alike");

  // Layer one: the narrow login's ACL.
  const narrowWindow = await mcp(narrow, { statement: '{"read": "window"}' });
  const narrowAllowed = await mcp(narrow, { statement: JSON.stringify({ read: "topic", topic: SEEDED[2][0] }) });
  const deniedPresent = await mcp(narrow, { statement: JSON.stringify({ read: "topic", topic: SEEDED[0][0] }) });
  const deniedMissing = await mcp(narrow, { statement: JSON.stringify({ read: "topic", topic: MISSING }) });
  check(answerOf(narrowAllowed.result).rows[0]?.seen === true, "scope: the narrow login reads a topic its ACL grants");
  check(
    answerOf(deniedPresent.result).rows[0]?.seen === false,
    "scope: the narrow login does not see a retained topic outside its ACL",
  );
  check(
    untimed(deniedPresent.result) === untimed(deniedMissing.result),
    "scope: a topic outside the ACL answers alike whether it holds a message or does not exist",
  );
  check(
    Number(answerOf(narrowWindow.result).rows[0]?.topics_seen ?? 0) <= 1,
    "scope: the narrow login's window counts no topic outside its ACL",
  );

  // The refused forms: fenced, nothing is acquired; unfenced, the provider refuses before anything is sent.
  const forms: readonly (readonly [string, string])[] = [
    ["a publish", '{"read": "publish", "topic": "homes/ayse-yilmaz/door", "payload": "x"}'],
    ["a will", '{"read": "window", "will": {"topic": "homes/ayse-yilmaz/door", "payload": "x"}}'],
    ["a wildcard below the root", '{"read": "topic", "topic": "homes/+/door"}'],
    ["a multi-level wildcard below the root", '{"read": "topic", "topic": "homes/#"}'],
    ["a shared subscription", '{"read": "topic", "topic": "$share/g/factory/#"}'],
    ["a $SYS topic", '{"read": "topic", "topic": "$SYS/broker/clients/connected"}'],
    ["a filter of the model's", '{"read": "window", "filter": "homes/#"}'],
  ];
  const refused = [];
  for (const [what, statement] of forms) {
    const fenced = await mcp(broad, { statement });
    const logAt = studioClients(0).lines;
    const unfenced = await mcp(broad, { statement }, UNFENCED);
    const opened = studioClients(logAt).ids.length;
    check(fenced.result.isError === true && fenced.acquired.length === 0, `refused: ${what} fenced, nothing acquired`);
    check(
      textOf(unfenced.result).includes(NOT_SENT) && opened === 1,
      `refused: ${what} unfenced, refused after the handshake alone (${opened} session)`,
    );
    refused.push({ request: what, fenced: textOf(fenced.result).slice(0, 80), sessionsUnfenced: opened });
  }

  // The positive control: a raw PUBLISH by the writer changes the retained set, the agent's read changes nothing.
  const beforeWrite = retained();
  check(beforeWrite.sha256 === before.sha256, "writes: every read left the retained set as it was");
  docker("exec", BROKER, "mosquitto_pub", ...as(WRITER), "-r", "-t", "factory/press-7/state", "-m", "written");
  const afterRaw = retained();
  check(afterRaw.count === beforeWrite.count + 1, "writes: the writer's raw PUBLISH added a retained message");
  await mcp(broad, { statement: '{"read": "publish", "topic": "factory/press-7/state", "payload": "x"}' }, UNFENCED);
  check(retained().sha256 === afterRaw.sha256, "writes: the same request through the unfenced tool changed nothing");

  // The limits.
  const started = Date.now();
  const least = await mcp(broad, { statement: '{"read": "window"}', timeout_ms: 5000 });
  const leastMs = Date.now() - started;
  check(least.result.isError !== true && leastMs < 5000, `limits: the least timeout_ms answers (${leastMs} ms)`);
  let belowMessage = "";
  try {
    await mcp(broad, { statement: '{"read": "window"}', timeout_ms: 4999 });
  } catch (error) {
    belowMessage = (error as Error).message;
  }
  check(belowMessage.includes("timeout_ms must be at least 5000 for run_mqtt_read"), "limits: 4999 ms is refused");
  const controller = new AbortController();
  const cancelStarted = Date.now();
  const pending = mcp(broad, { statement: '{"read": "window"}' }, RUN_MQTT_READ, controller.signal);
  setTimeout(() => controller.abort(), 1_000);
  const cancelled = await pending;
  const cancelIn = Date.now() - cancelStarted;
  check(
    textOf(cancelled.result) === MCP_CANCELLED_TEXT && cancelIn < 1_500,
    `limits: a cancel answers (${cancelIn} ms)`,
  );
  await Bun.sleep(3_500);
  const cancelReadEndedMs = lastSettledAt;
  check(
    cancelReadEndedMs !== null,
    `limits: the cancelled read still ended on its own window (${cancelReadEndedMs} ms)`,
  );

  // The live client kept its id through every call.
  const live = docker("exec", BROKER, "sh", "-c", `ps | grep -c "[m]osquitto_sub -i ${LIVE_ID}"`).trim();
  check(live === "1", "collision: the live client is still connected under its own id");

  // A stock EMQX: anonymous, its default ACL refuses a subscription to # with 135.
  const emqx = seed("emqx", EMQX_PORT);
  docker("exec", EMQX, "emqx", "ctl", "status");
  const emqxWindow = await mcp(emqx, { statement: '{"read": "window"}' });
  const emqxTopic = await mcp(emqx, { statement: JSON.stringify({ read: "topic", topic: MISSING }) });
  check(
    answerOf(emqxWindow.result).rows[0]?.stop_reason === "subscription-refused" &&
      answerOf(emqxWindow.result).rows[0]?.broker_reason_code === 135,
    "emqx: the default ACL refuses the window's # with reason code 135",
  );
  check(answerOf(emqxTopic.result).rows[0]?.seen === false, "emqx: a topic read answers");

  const capture = {
    $captured: {
      images: [IMAGE, EMQX_IMAGE],
      date: new Date().toISOString().slice(0, 10),
      runtime: `bun ${Bun.version}`,
      logins:
        "broad: topic read #; narrow: topic read factory/#; writer: topic readwrite # (names and passwords made per run, not recorded)",
    },
    reads: { window: windowAnswer, topic: recorded(topicRead.result) },
    sessions: { perCall: clients.ids.length, distinctIds: new Set(clients.ids).size },
    scope: {
      broadIdleVsMissingAlike: untimed(idle.result) === untimed(missing.result),
      narrowWindow: recorded(narrowWindow.result),
      narrowAllowed: recorded(narrowAllowed.result),
      narrowDeniedPresent: recorded(deniedPresent.result),
      narrowDeniedPresentVsMissingAlike: untimed(deniedPresent.result) === untimed(deniedMissing.result),
    },
    refused,
    writes: { retainedBefore: before.count, afterRawPublish: afterRaw.count, afterUnfencedRequest: retained().count },
    limits: {
      leastTimeoutAnsweredMs: leastMs,
      belowLeast: belowMessage.slice(0, 400),
      cancelAnsweredMs: cancelIn,
      cancelReadEndedMs,
    },
    collision: { liveClientStillConnected: live === "1" },
    emqx: { window: recorded(emqxWindow.result), topic: recorded(emqxTopic.result) },
  };
  const text = `${JSON.stringify(capture, null, 2)}\n`;
  check(!carries(text, SECRETS), "capture: no credential");
  check(!carries(text, WITHHELD), "capture: no seeded topic name or payload");
  if (failures === 0) writeFileSync(posix.join(OUT, "boundary.json"), text);
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
