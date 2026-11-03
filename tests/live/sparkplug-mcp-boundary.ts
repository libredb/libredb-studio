/**
 * Live check of MCP's `run_sparkplug_read` on the pinned fixture broker, captured into `boundary.json` beside
 * `tests/fixtures/sparkplug/mosquitto-2.0.22/mcp-boundary/run.sh`, which starts the fixture's own Mosquitto 2.0.22
 * (anonymous, as the fixture is) and a second one whose anonymous ACL reads one group alone, each with the fixture's
 * own publisher on it, and removes them all after.
 *
 * WHY THIS EXISTS. `run_sparkplug_read` serves Sparkplug through the boundary agent mode uses: the connection is
 * acquired under the agent read-only profile by the factory itself, and every request goes through the provider's
 * `queryReadOnly`, one fresh session over the closed encoder, answered as one window's totals or one named object's
 * counts. The MCP fence in front of it, the agent's own admission, is defence in depth. So this script drives the
 * tool's own handler (`runStatement`) with a seed connection, fenced as MCP registers it and with the fence removed:
 *
 *   reads      the window, a group read and a device read, through the tool: rows, notes, and whether the answer
 *              carried a seeded id or metric name;
 *   sessions   the broker's own log of the clients one call connected: two, each with a client id of its own;
 *   scope      the data scope behind a broker ACL that reads one group (layer one): the window counts that group
 *              alone, and a group outside it that publishes answers alike with a group that does not exist; and on the
 *              open broker a named group that does not exist beside one that does, answered by counts alone (layer
 *              two, the projection, which never names an id); and on a connection that names a group, a read of
 *              another group refused after the handshake alone;
 *   refused    every form the agent refuses, fenced (nothing acquired) and unfenced (the provider refuses it before
 *              anything is sent);
 *   limits     a read at the least timeout_ms, a timeout_ms one below it, and a client cancel;
 *   inspect    inspect_schema's empty page, which lists no group, edge node or device.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. This provider sends no credential; the
 * capture records no seeded id and no metric name, checked before the file is written; any failed check ends the run
 * non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the broker holds after the one before.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { posix } from "node:path";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_CANCELLED_TEXT, type ToolResult } from "@/lib/mcp/output";
import { inspectSchema, InspectSchemaInputSchema } from "@/lib/mcp/tools/inspect-schema";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm, type McpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set; run this through run.sh`);
  return value;
};

const PORT = Number(required("SPARKPLUG_PORT"));
const ACL_PORT = Number(required("SPARKPLUG_ACL_PORT"));
const BROKER = required("SPARKPLUG_BROKER");
const IMAGE = required("SPARKPLUG_IMAGE");
const OUT = required("SPARKPLUG_OUT");

/** Every id and metric name the fixture's publisher seeds; none may reach an answer. */
const SEEDED = [
  "SekoyaPlant",
  "AnkaraPlant",
  "Line1",
  "Line2",
  "Line3",
  "Line4",
  "Press01",
  "Mixer1",
  "sparkplug-fixture-publisher",
  "BatchName",
  "CycleCount",
  "GripperClosed",
  "Humidity",
  "MixerSpeed",
  "MotorRunning",
  "PressForce",
  "RecipeName",
  "ShiftName",
  "StrokeCount",
  "Temperature",
];

let failures = 0;
function check(ok: boolean, line: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

const docker = (...args: string[]): string => {
  try {
    return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const out = error as { stdout?: string; stderr?: string };
    if (typeof out.stdout === "string") return out.stdout + (out.stderr ?? "");
    throw error;
  }
};

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

function seed(name: string, port: number, group = ""): ManagedConnection {
  return {
    id: `seed:live-${name}`,
    name,
    seedId: `live-${name}`,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "sparkplug",
    host: "127.0.0.1",
    port,
    database: group,
    createdAt: new Date(),
  } as unknown as ManagedConnection;
}

const RUN_SPARKPLUG_READ = mcpStatementArm("run_sparkplug_read");
/** The tool with its reader removed as a fence: the boundary under test. */
const UNFENCED: McpStatementArm = { ...RUN_SPARKPLUG_READ, fence: () => null };
const NOT_SENT = "The statement was refused before it reached the database: ";

function contextFor(connection: ManagedConnection, acquired: ExecutionProfile[]): McpConnectionContext {
  return {
    caller: { username: "live", role: "admin" },
    visibleConnections: async () => [connection],
    resolve: async () => connection,
    acquire: async (target: ManagedConnection, profile: ExecutionProfile) => {
      acquired.push(profile);
      return acquireExecutionProfileProvider(target, profile);
    },
  } as unknown as McpConnectionContext;
}

async function mcp(
  connection: ManagedConnection,
  args: Partial<McpStatementInput> & { readonly statement: string },
  arm: McpStatementArm = RUN_SPARKPLUG_READ,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ readonly result: ToolResult; readonly acquired: ExecutionProfile[] }> {
  const acquired: ExecutionProfile[] = [];
  const input = arm.inputSchema.parse({ connection_id: connection.id, ...args }) as McpStatementInput;
  const result = await runStatement(arm, input, { context: contextFor(connection, acquired), signal });
  clearProviderCache();
  return { result, acquired };
}

const textOf = (result: ToolResult): string =>
  result.content.map((part) => ("text" in part ? part.text : "")).join(" ");
const carriesSeeded = (value: unknown) => SEEDED.some((id) => JSON.stringify(value).includes(id));
const rowOf = (result: ToolResult) =>
  (result.structuredContent as { rows?: Record<string, unknown>[] } | undefined)?.rows?.[0] ?? {};
const notesOf = (result: ToolResult) => (result.structuredContent as { notes?: string[] } | undefined)?.notes ?? [];

function recorded(result: ToolResult) {
  return {
    isError: result.isError === true,
    ...(result.isError === true ? { text: textOf(result) } : { row: rowOf(result), notes: notesOf(result) }),
    carriesSeeded: carriesSeeded(result),
  };
}

/** A row by its counts alone: the clock's own figures taken out, so two reads of one plant compare. */
const counts = (result: ToolResult) =>
  JSON.stringify(rowOf(result)).replace(/"(window_ms|listened_ms|last_seen_ms)":\d+/g, '"$1":0');

async function main(): Promise<void> {
  const open = seed("open", PORT);
  const acl = seed("acl", ACL_PORT);
  const scoped = seed("scoped", PORT, "SekoyaPlant");

  const logAt = studioClients(0).lines;
  const window = await mcp(open, { statement: '{"read": "window"}' });
  const clients = studioClients(logAt);
  check(!window.result.isError && !carriesSeeded(window.result), "reads: the window answers, naming no id");
  check(window.acquired.join(",") === "agent-read-only", "reads: acquired under agent-read-only alone");
  check(Number(rowOf(window.result).groups_seen) === 2, "reads: the window counted both groups");
  check(
    notesOf(window.result).at(-1)?.startsWith("An edge node or device not seen in the window may still exist") === true,
    "reads: the notes carry the window and the completeness sentence",
  );
  check(
    clients.ids.length === 2 && new Set(clients.ids).size === 2,
    `sessions: one call connected two clients, each with its own id (${clients.ids.length})`,
  );
  const group = await mcp(open, { statement: '{"read": "group", "group": "SekoyaPlant"}' });
  const device = await mcp(open, {
    statement: '{"read": "device", "group": "SekoyaPlant", "edgeNode": "Line1", "device": "Press01"}',
  });
  check(rowOf(group.result).seen === true && !carriesSeeded(group.result), "reads: a group read names nothing");
  check(rowOf(device.result).seen === true && !carriesSeeded(device.result), "reads: a device read names nothing");

  // Layer one: the ACL that reads one group.
  const aclWindow = await mcp(acl, { statement: '{"read": "window"}' });
  const outsidePublishing = await mcp(acl, { statement: '{"read": "group", "group": "AnkaraPlant"}' });
  const outsideMissing = await mcp(acl, { statement: '{"read": "group", "group": "NoSuchPlant"}' });
  check(Number(rowOf(aclWindow.result).groups_seen) === 1, "scope: the ACL's window counts its one group alone");
  check(
    counts(outsidePublishing.result) === counts(outsideMissing.result),
    "scope: a group outside the ACL that publishes answers alike with one that does not exist",
  );
  // Layer two: the projection names no id, so a missing group answers by counts alone.
  const missing = await mcp(open, { statement: '{"read": "group", "group": "NoSuchPlant"}' });
  check(rowOf(missing.result).seen === false && !carriesSeeded(missing.result), "scope: a missing group is not seen");
  const otherAt = studioClients(0).lines;
  const other = await mcp(scoped, { statement: '{"read": "group", "group": "AnkaraPlant"}' });
  check(
    other.result.isError === true &&
      textOf(other.result).includes("This connection names one group") &&
      studioClients(otherAt).ids.length === 1,
    "scope: a connection that names a group refuses another after the handshake alone",
  );

  // Fenced, nothing is acquired and the agent reader's own refusal answers, its code and its words; unfenced, the
  // provider refuses before anything is sent.
  const forms: readonly (readonly [string, string, string, string])[] = [
    [
      "an id with a wildcard",
      '{"read": "group", "group": "Sekoya#"}',
      "metadata-only",
      "An id is named in full, with no + and no #",
    ],
    [
      "an id with a level separator",
      '{"read": "edgeNode", "group": "SekoyaPlant/NBIRTH", "edgeNode": "Line1"}',
      "request",
      "An id is one topic level and holds no /",
    ],
    [
      "the host state group",
      '{"read": "group", "group": "STATE"}',
      "metadata-only",
      "A group named STATE is never read in agent mode",
    ],
    [
      "a rebirth command",
      '{"read": "rebirth", "group": "SekoyaPlant", "edgeNode": "Line1"}',
      "metadata-only",
      "never sends a command or a rebirth request",
    ],
    [
      "a filter of the model's",
      '{"read": "window", "filter": "spBv1.0/#"}',
      "request",
      "The request holds a key agent mode does not read",
    ],
  ];
  const refused = [];
  for (const [what, statement, code, words] of forms) {
    const fenced = await mcp(open, { statement });
    const at = studioClients(0).lines;
    const unfenced = await mcp(open, { statement }, UNFENCED);
    const opened = studioClients(at).ids.length;
    const ownWords =
      textOf(fenced.result).startsWith(`The read request was refused before it reached the broker (${code}). `) &&
      textOf(fenced.result).includes(words);
    check(
      fenced.result.isError === true && fenced.acquired.length === 0 && ownWords,
      `refused: ${what} fenced, in its own words (${code}), nothing acquired`,
    );
    check(
      textOf(unfenced.result).includes(NOT_SENT) && opened === 1,
      `refused: ${what} unfenced, refused after the handshake alone (${opened} session)`,
    );
    refused.push({ request: what, code, ownWords, sessionsUnfenced: opened });
  }

  const started = Date.now();
  const least = await mcp(open, { statement: '{"read": "window"}', timeout_ms: 5000 });
  const leastMs = Date.now() - started;
  check(least.result.isError !== true && leastMs < 5000, `limits: the least timeout_ms answers (${leastMs} ms)`);
  let belowMessage = "";
  try {
    await mcp(open, { statement: '{"read": "window"}', timeout_ms: 4999 });
  } catch (error) {
    belowMessage = (error as Error).message;
  }
  check(belowMessage.includes("timeout_ms must be at least 5000 for run_sparkplug_read"), "limits: 4999 ms is refused");
  const controller = new AbortController();
  const cancelStarted = Date.now();
  const pending = mcp(open, { statement: '{"read": "window"}' }, RUN_SPARKPLUG_READ, controller.signal);
  setTimeout(() => controller.abort(), 1_000);
  const cancelled = await pending;
  const cancelIn = Date.now() - cancelStarted;
  check(
    textOf(cancelled.result) === MCP_CANCELLED_TEXT && cancelIn < 1_500,
    `limits: a cancel answers (${cancelIn} ms)`,
  );
  await Bun.sleep(3_500);

  const inspected = await inspectSchema(InspectSchemaInputSchema.parse({ connection_id: open.id }), {
    context: contextFor(open, []),
    signal: new AbortController().signal,
  });
  clearProviderCache();
  const page = inspected.structuredContent as { total_tables?: number; tables?: unknown[] } | undefined;
  check(page?.total_tables === 0 && !carriesSeeded(inspected), "inspect: inspect_schema lists no id");

  const capture = {
    $captured: {
      image: IMAGE,
      date: new Date().toISOString().slice(0, 10),
      runtime: `bun ${Bun.version}`,
      brokers: "open: the fixture's anonymous broker; acl: anonymous, reads one of the two groups alone",
    },
    reads: { window: recorded(window.result), group: recorded(group.result), device: recorded(device.result) },
    sessions: { perCall: clients.ids.length, distinctIds: new Set(clients.ids).size },
    scope: {
      aclWindow: recorded(aclWindow.result),
      aclOutsidePublishing: recorded(outsidePublishing.result),
      aclOutsidePublishingVsMissingAlike: counts(outsidePublishing.result) === counts(outsideMissing.result),
      openMissingGroup: recorded(missing.result),
      scopedOtherGroup: recorded(other.result),
    },
    refused,
    limits: { leastTimeoutAnsweredMs: leastMs, belowLeast: belowMessage.slice(0, 400), cancelAnsweredMs: cancelIn },
    inspect: { totalTables: page?.total_tables ?? null, isError: inspected.isError === true },
  };
  const text = `${JSON.stringify(capture, null, 2)}\n`;
  check(!carriesSeeded(text), "capture: no seeded id or metric name");
  if (failures === 0) writeFileSync(posix.join(OUT, "boundary.json"), text);
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
