/**
 * Live check of MCP's `run_opcua_read` on the pinned OPC UA fixture (Microsoft OPC PLC 2.15.10), captured into
 * `boundary.json` beside `tests/fixtures/opcua/2.15.10/mcp-boundary/run.sh`, which starts one container of the pinned
 * image on a port Docker picks, with a non-privileged user and an administrator whose passwords it makes for the run.
 *
 * WHY THIS EXISTS. `run_opcua_read` serves OPC UA through the boundary agent mode uses: the connection is acquired under
 * the agent read-only profile by the factory itself, and every request goes through the provider's `queryReadOnly`,
 * one session per read, which proves the nodes beneath the seed's read roots before it answers. The MCP fence in front
 * of it, the agent's own admission, is defence in depth. So this script drives the tool's own handler
 * (`runStatement`) with seed connections whose read roots are the Telemetry folder, the DataAccess folder (its
 * namespace URI read from the fixture's own NamespaceArray) and Server.ServerStatus, fenced as MCP registers it and
 * with the fence removed:
 *
 *   reads      a value read with units, a history read, and browses of the Objects folder, a member and a
 *              namespace-0 root, through the tool, as each identity;
 *   outside    for every read kind and each identity, ids the server holds outside the roots (its configuration,
 *              the session diagnostics, the Server object, RoleSet, the folder above a root, other namespaces) beside a
 *              missing twin: their answers compared, and, for the administrator, another client's session object
 *              opened raw with a planted application name, compared the same way;
 *   rootless   a seed with no read roots is refused when the tool opens it, with READ_ROOTS_REQUIRED;
 *   refused    every form the agent refuses, fenced (nothing acquired) and unfenced (refused before anything is sent),
 *              and the over-budget read;
 *   writes     a raw anonymous Write of a writable variable succeeds, the positive control, while the same write
 *              through the unfenced tool sends nothing and changes nothing;
 *   limits     a read at the least timeout_ms of a server that stopped answering after the acquisition, and a client
 *              cancel: when MCP answered and when the provider's own read ended.
 *
 * The vendor namespace shapes a real plant server may hang beneath a root are replayed in process by
 * `tests/integration/db/opcua-vendor-namespaces.test.ts`, which runs in `bun run test`.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. The capture records no password, no account
 * name and no planted value: an answer is recorded as its figures and as whether it carried any of them. Each is
 * checked before the file is written; any failed check ends the run non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import "@/lib/db/providers/industrial/opcua/hostname-guard";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPCUACertificateManager } from "node-opcua-certificate-manager";
import {
  AttributeIds,
  BrowseDirection,
  type ClientSession,
  DataType,
  MessageSecurityMode,
  OPCUAClient,
  SecurityPolicy,
  UserTokenType,
  Variant,
} from "node-opcua-client";
import { AGENT_LANGUAGE_COPY } from "@/lib/agent/agent-manifest";
import { languageServer } from "@/lib/agent/languages/server";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import { OPCUA_ROOTS_WARNING } from "@/lib/db/providers/industrial/opcua/agent-roots";
import { OPCUA_PKI_ROOT_ENV } from "@/lib/db/providers/industrial/opcua/pki";
import type { DatabaseProvider } from "@/lib/db/types";
import { assertReadRootsWhereRequired, type McpConnectionContext } from "@/lib/mcp/context";
import { MCP_CANCELLED_TEXT, type ToolResult } from "@/lib/mcp/output";
import { timeoutText } from "@/lib/mcp/tools/read-query-limits";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm, type McpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";

const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set; run this through run.sh`);
  return value;
};

const PORT = Number(required("OPCUA_MCP_PORT"));
const OUT = required("OPCUA_MCP_OUT");
const CONTAINER = required("OPCUA_MCP_CONTAINER");
const IMAGE = required("OPCUA_MCP_IMAGE");
const USER_SECRET = required("OPCUA_MCP_USER_SECRET");
const ADMIN_SECRET = required("OPCUA_MCP_ADMIN_SECRET");
const ENDPOINT = `opc.tcp://127.0.0.1:${PORT}/`;
const USERS = { user: "probe-user", administrator: "probe-admin" } as const;
const SECRETS = [USER_SECRET, ADMIN_SECRET];
/** Every planted name and value starts with this word, which neither an answer nor the capture may carry. */
const PLANTED = "planted";
const ANALOG = "ns=6;s=DataAccess_AnalogType_Int32";
const PLAIN = "ns=3;s=SlowUInt1";
const HISTORIAN = "ns=3;s=HistorianInt32";
/** The missing twin every outside id is compared with: an id in the process namespace the server does not hold. */
const MISSING = "ns=3;s=NoSuchNodeAtAll";
/**
 * Ids the server holds outside the read roots: the server's configuration, the session diagnostics summary and its
 * array, the Server object, the folder above Telemetry, a node of namespaces 2 and 4, and RoleSet.
 */
const OUTSIDE = ["i=12637", "i=3706", "i=3707", "i=2253", "ns=3;s=OpcPlc", "ns=2;i=5001", "ns=4;i=5", "i=15606"];
/** The read roots every seed declares, filled from the fixture's own NamespaceArray before the first call. */
let ROOTS: readonly string[] = [];
const SCRATCH: string[] = [];
const scratch = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  SCRATCH.push(root);
  return root;
};

let failures = 0;
function check(ok: boolean, line: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

const docker = (...args: string[]): string =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

type Who = "anonymous" | "user" | "administrator";
const passwordOf = (who: Who): string | undefined =>
  who === "user" ? USER_SECRET : who === "administrator" ? ADMIN_SECRET : undefined;

/** A raw client of the script's own, with a PKI root of its own, never Studio's, under a planted application name. */
async function rawSession(
  who: Who,
  port = PORT,
  path = "/",
): Promise<{ session: ClientSession; close: () => Promise<void> }> {
  const manager = new OPCUACertificateManager({
    rootFolder: scratch("opcua-mcp-raw-pki-"),
    automaticallyAcceptUnknownCertificate: true,
  });
  await manager.initialize();
  const client = OPCUAClient.create({
    applicationName: `${PLANTED}-client-application`,
    clientCertificateManager: manager,
    securityMode: MessageSecurityMode.None,
    securityPolicy: SecurityPolicy.None,
    endpointMustExist: false,
    connectionStrategy: { maxRetry: 0 },
  });
  await client.connect(`opc.tcp://127.0.0.1:${port}${path}`);
  const password = passwordOf(who);
  const session = await client.createSession(
    who === "anonymous"
      ? { type: UserTokenType.Anonymous }
      : { type: UserTokenType.UserName, userName: USERS[who], password: password ?? "" },
  );
  return {
    session,
    close: async () => {
      await session.close().catch(() => undefined);
      await client.disconnect();
    },
  };
}

const browseRaw = (session: ClientSession, nodeId: string) =>
  session.browse({
    nodeId,
    browseDirection: BrowseDirection.Forward,
    referenceTypeId: "i=33",
    includeSubtypes: true,
    nodeClassMask: 0,
    resultMask: 63,
  });

/** The fixture's NamespaceArray, read raw; entry 1 names the host and is never written. */
async function namespaceTable(): Promise<readonly string[]> {
  const raw = await rawSession("anonymous");
  try {
    const table = (await raw.session.read({ nodeId: "i=2255", attributeId: AttributeIds.Value })).value.value;
    if (!Array.isArray(table) || table.length < 7) throw new Error("the fixture's namespace table is short");
    return table as string[];
  } finally {
    await raw.close();
  }
}

function seed(who: Who, roots: readonly string[] | null = ROOTS): ManagedConnection {
  const password = passwordOf(who);
  return {
    id: `seed:live-${who}`,
    name: who,
    seedId: `live-${who}`,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "opcua",
    host: ENDPOINT,
    securityMode: "None",
    ...(who === "anonymous" ? {} : { user: USERS[who], password }),
    ...(roots === null ? {} : { agentReadRoots: roots }),
    createdAt: new Date(),
  } as unknown as ManagedConnection;
}

const RUN_OPCUA_READ = mcpStatementArm("run_opcua_read");
/** The tool with its reader removed as a fence: the boundary under test. */
const UNFENCED: McpStatementArm = { ...RUN_OPCUA_READ, fence: () => null };
const NOT_SENT = "The statement was refused before it reached the database: ";
const reader = languageServer("opcuaread");

/** When the last provider handed out settled its `queryReadOnly`, measured from the call. */
let lastSettledAt: number | null = null;
/** Run once, after the next acquisition and before its read: the server stops answering. */
let afterAcquire: (() => void) | null = null;

async function mcp(
  connection: ManagedConnection,
  statement: unknown,
  args: Partial<McpStatementInput> = {},
  arm: McpStatementArm = RUN_OPCUA_READ,
  signal: AbortSignal = new AbortController().signal,
): Promise<{ readonly result: ToolResult; readonly acquired: ExecutionProfile[] }> {
  const acquired: ExecutionProfile[] = [];
  const context = {
    caller: { username: "live", role: "admin" },
    visibleConnections: async () => [connection],
    resolve: async () => connection,
    acquire: async (target: ManagedConnection, profile: ExecutionProfile) => {
      // The open's own check, as McpConnectionContext.acquire makes it before anything is acquired.
      assertReadRootsWhereRequired(target);
      acquired.push(profile);
      const provider: DatabaseProvider = await acquireExecutionProfileProvider(target, profile);
      const hook = afterAcquire;
      afterAcquire = null;
      hook?.();
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
  const text = typeof statement === "string" ? statement : JSON.stringify(statement);
  const input = arm.inputSchema.parse({ connection_id: connection.id, statement: text, ...args }) as McpStatementInput;
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
const rowsOf = (result: ToolResult) => answerOf(result)?.rows ?? [];

/** An answer as the capture records it: its row count, its notes' kinds, and whether it carried anything withheld. */
function recorded(result: ToolResult) {
  const text = JSON.stringify(result);
  const answered = answerOf(result);
  return {
    isError: result.isError === true,
    ...(result.isError === true
      ? { text: textOf(result).slice(0, 240) }
      : {
          rows: answered.rows.length,
          statuses: [...new Set(answered.rows.map((row) => String(row.statusCode ?? row.nodeClass)))],
          notes: (answered.notes ?? []).map((note) => note.slice(0, 120)),
        }),
    carriesPlanted: text.includes(PLANTED),
    carriesAccount: carries(text, Object.values(USERS)) || carries(text, SECRETS),
  };
}

/** Trust the fixture's certificate in Studio's PKI root, the way a reader would, so a user token can be sent. */
async function trustServer(): Promise<void> {
  const root = process.env[OPCUA_PKI_ROOT_ENV] as string;
  const first = await mcp(seed("user"), { read: ["i=2256"] });
  if (!textOf(first.result).includes("BadCertificateUntrusted") && first.result.isError !== true) return;
  mkdirSync(join(root, "trusted", "certs"), { recursive: true });
  for (const file of readdirSync(join(root, "rejected")))
    renameSync(join(root, "rejected", file), join(root, "trusted", "certs", file));
}

/** An answer as two answers compare: its error text, or its rows and notes, with `id` put back to one spelling. */
function compared(result: ToolResult, id: string): string {
  const answered = answerOf(result);
  const shape =
    result.isError === true
      ? { isError: true, text: textOf(result) }
      : { isError: false, rows: answered.rows, notes: answered.notes ?? [] };
  return JSON.stringify(shape).replaceAll(id, "<id>");
}

const KINDS = {
  read: (id: string) => ({ read: [id] }),
  history: (id: string) => ({ history: id }),
  browse: (id: string) => ({ browse: id }),
} as const;

/** Each id beside the missing twin through the tool, for every read kind: how many answered alike, as counts only. */
async function alikeWithMissing(connection: ManagedConnection, ids: readonly string[]) {
  const kinds: Record<string, { pairs: number; alike: number; carriesPlanted: boolean; carriesAccount: boolean }> = {};
  for (const [kind, statement] of Object.entries(KINDS)) {
    const missing = compared((await mcp(connection, statement(MISSING))).result, MISSING);
    let alike = 0;
    let planted = false;
    let account = false;
    for (const id of ids) {
      const outside = (await mcp(connection, statement(id))).result;
      if (compared(outside, id) === missing) alike += 1;
      planted ||= recorded(outside).carriesPlanted;
      account ||= recorded(outside).carriesAccount;
    }
    kinds[kind] = { pairs: ids.length, alike, carriesPlanted: planted, carriesAccount: account };
  }
  return kinds;
}

async function main(): Promise<void> {
  process.env[OPCUA_PKI_ROOT_ENV] = scratch("opcua-mcp-studio-pki-");
  const table = await namespaceTable();
  ROOTS = [`nsu=${table[3]};s=Telemetry`, `nsu=${table[6]};s=DataAccess`, "i=2256"];
  await trustServer();
  const anonymous = seed("anonymous");
  const user = seed("user");
  const administrator = seed("administrator");

  // The reads, as each identity.
  const reads: Record<string, Record<string, ReturnType<typeof recorded>>> = {};
  const outside: Record<string, unknown> = {};
  for (const [who, connection] of [
    ["anonymous", anonymous],
    ["user", user],
    ["administrator", administrator],
  ] as const) {
    reads[who] = {};
    for (const statement of [
      { read: [ANALOG, PLAIN] },
      { history: HISTORIAN, limit: 5 },
      { browse: "i=85" },
      { browse: "ns=3;s=Telemetry" },
      { browse: "i=2256" },
    ]) {
      const read = await mcp(connection, statement);
      const key = Object.keys(statement)[0] as string;
      reads[who][key === "browse" ? `browse ${statement.browse}` : key] = recorded(read.result);
      check(
        !read.result.isError && rowsOf(read.result).length > 0 && read.acquired.join(",") === "agent-read-only",
        `reads: ${who} ${JSON.stringify(statement)} answers ${rowsOf(read.result).length} rows under agent-read-only`,
      );
    }
    const values = await mcp(connection, { read: [ANALOG, PLAIN] });
    check(
      rowsOf(values.result)[0]?.units === "mV" &&
        rowsOf(values.result)[0]?.euRange === "0 to 100" &&
        rowsOf(values.result)[1]?.units === "no units published",
      `reads: ${who} every value carries its units, or no units published`,
    );
    const roots = await mcp(connection, { browse: "i=85" });
    check(
      JSON.stringify(answerOf(roots.result).notes) === JSON.stringify([OPCUA_ROOTS_WARNING]) &&
        rowsOf(roots.result).length === ROOTS.length,
      `reads: ${who} a browse of the Objects folder lists the ${ROOTS.length} read roots and says so`,
    );
    outside[who] = await alikeWithMissing(connection, OUTSIDE);
    for (const [kind, counted] of Object.entries(outside[who] as Record<string, { pairs: number; alike: number }>))
      check(
        counted.alike === counted.pairs,
        `outside: ${who} ${kind} of ${counted.alike} of ${counted.pairs} outside ids answers as the missing twin`,
      );
  }

  // Another client's session, opened raw with a planted application name, as the administrator is shown it.
  const other = await rawSession("administrator");
  try {
    const summary = await browseRaw(other.session, "i=3706");
    const sessions = (summary.references ?? []).map((reference) => reference.nodeId.toString());
    check(sessions.length > 0, `outside: the administrator's raw browse found ${sessions.length} session objects`);
    outside.administratorSessionObjects = await alikeWithMissing(administrator, sessions);
    for (const [kind, counted] of Object.entries(
      outside.administratorSessionObjects as Record<string, { pairs: number; alike: number }>,
    ))
      check(
        counted.alike === counted.pairs,
        `outside: a session object's ${kind} answers as the missing twin (${counted.alike} of ${counted.pairs})`,
      );
  } finally {
    await other.close();
  }

  // A seed with no read roots is refused when the tool opens it, before anything is read.
  const rootless = await mcp(seed("anonymous", null), { read: [PLAIN] });
  const rootlessText = textOf(rootless.result);
  check(
    rootless.result.isError === true && rootlessText.includes("agentReadRoots") && rootless.acquired.length === 0,
    "rootless: a seed without read roots is refused at open, naming agentReadRoots, and nothing is acquired",
  );

  // The refused forms: fenced, nothing is acquired and the agent reader's own refusal answers in its words; unfenced,
  // the provider refuses before anything is sent.
  const forms: readonly (readonly [string, unknown])[] = [
    ["a write", { write: PLAIN, value: 1 }],
    ["a call", { call: "i=11492", arguments: [0] }],
    ["an index range", { read: [PLAIN], indexRange: "0:1" }],
    ["a data encoding", { read: [PLAIN], dataEncoding: "Default Binary" }],
    ["a subscription", { subscribe: PLAIN }],
    ["two reads in one request", { read: [PLAIN], browse: "i=85" }],
  ];
  const refused = [];
  for (const [what, statement] of forms) {
    const text = JSON.stringify(statement);
    const refusal = reader.admit?.(text);
    const fenced = await mcp(anonymous, statement);
    const unfenced = await mcp(anonymous, statement, {}, UNFENCED);
    const ownWords =
      refusal !== null &&
      refusal !== undefined &&
      textOf(fenced.result) ===
        `The ${AGENT_LANGUAGE_COPY.opcuaread.noun} was refused before it reached the server (${refusal.code}). ${refusal.message}`;
    check(
      fenced.result.isError === true && fenced.acquired.length === 0 && ownWords,
      `refused: ${what} fenced, in its own words (${refusal?.code}), nothing acquired`,
    );
    check(textOf(unfenced.result).includes(NOT_SENT), `refused: ${what} unfenced, refused before anything was sent`);
    refused.push({
      request: what,
      code: refusal?.code,
      ownWords,
      unfencedNotSent: textOf(unfenced.result).includes(NOT_SENT),
    });
  }
  // The over-budget read: the historized node with no limit holds more values than MCP's 1000-row budget, so it is
  // refused with the way to narrow it, never cut.
  const overStatement = JSON.stringify({ history: HISTORIAN });
  const overBudget = await mcp(anonymous, overStatement);
  check(
    overBudget.result.isError === true &&
      textOf(overBudget.result).startsWith(
        "The result has more than 1000 rows, the most this server reads for one call.",
      ) &&
      textOf(overBudget.result).includes(reader.rowCapAdvice(overStatement, "1000")),
    "refused: a history read past the 1000-row budget is refused with the way to narrow it",
  );

  // The positive control: a raw anonymous Write of the analog variable's own value back is accepted; the same write
  // through the unfenced tool sends nothing.
  const raw = await rawSession("anonymous");
  let writes: Record<string, unknown> = {};
  try {
    const before = await raw.session.read({ nodeId: ANALOG, attributeId: AttributeIds.Value });
    const written = await raw.session.write({
      nodeId: ANALOG,
      attributeId: AttributeIds.Value,
      value: { value: new Variant({ dataType: DataType.Int32, value: Number(before.value.value) + 1 }) },
    });
    const afterRaw = await raw.session.read({ nodeId: ANALOG, attributeId: AttributeIds.Value });
    const unfencedWrite = await mcp(anonymous, { write: ANALOG, value: 7 }, {}, UNFENCED);
    const afterTool = await raw.session.read({ nodeId: ANALOG, attributeId: AttributeIds.Value });
    await raw.session.write({ nodeId: ANALOG, attributeId: AttributeIds.Value, value: before.value });
    writes = {
      rawWriteStatus: written.name,
      rawWriteChangedTheValue: String(afterRaw.value.value) !== String(before.value.value),
      unfencedToolSentNothing: textOf(unfencedWrite.result).includes(NOT_SENT),
      unfencedToolChangedTheValue: String(afterTool.value.value) !== String(afterRaw.value.value),
    };
    check(written.name === "Good", "writes: the raw anonymous Write was accepted");
    check(
      writes.unfencedToolSentNothing === true && writes.unfencedToolChangedTheValue === false,
      "writes: the same write through the unfenced tool sent nothing and changed nothing",
    );
  } finally {
    await raw.close();
  }

  // The limits: the server stops answering after the acquisition, so the read itself meets the deadline.
  const pause = () => docker("pause", CONTAINER);
  const unpause = () => docker("unpause", CONTAINER);
  afterAcquire = pause;
  const leastStarted = Date.now();
  const least = await mcp(anonymous, { read: [PLAIN] }, { timeout_ms: 500 });
  const leastMs = Date.now() - leastStarted;
  await Bun.sleep(300);
  const leastReadEndedMs = lastSettledAt;
  unpause();
  check(
    textOf(least.result) === timeoutText(500) && leastMs < 1_000,
    `limits: at the least timeout_ms a silent server is the timeout answer (${leastMs} ms)`,
  );
  check(
    leastReadEndedMs !== null && leastReadEndedMs < 1_000,
    `limits: the provider's own read ended at the time left (${leastReadEndedMs} ms)`,
  );
  afterAcquire = pause;
  const controller = new AbortController();
  const cancelStarted = Date.now();
  const pending = mcp(anonymous, { read: [PLAIN] }, { timeout_ms: 3_000 }, RUN_OPCUA_READ, controller.signal);
  setTimeout(() => controller.abort(), 1_000);
  const cancelled = await pending;
  const cancelIn = Date.now() - cancelStarted;
  await Bun.sleep(3_000);
  const cancelReadEndedMs = lastSettledAt;
  unpause();
  check(
    textOf(cancelled.result) === MCP_CANCELLED_TEXT && cancelIn < 1_500,
    `limits: a cancel answers (${cancelIn} ms)`,
  );
  check(
    cancelReadEndedMs !== null && cancelReadEndedMs >= 1_500 && cancelReadEndedMs < 3_500,
    `limits: the cancelled read still ended at its own time left, not at the cancel (${cancelReadEndedMs} ms)`,
  );
  // After both, the server answers a read again: nothing the deadline left behind holds it.
  await Bun.sleep(2_000);
  const after = await mcp(anonymous, { read: [PLAIN] });
  check(!after.result.isError, "limits: after the pauses the server answers a read through the tool");

  const capture = {
    $captured: {
      image: IMAGE,
      date: new Date().toISOString().slice(0, 10),
      runtime: `bun ${Bun.version}`,
      identities:
        "anonymous; user: a non-privileged user; administrator: the fixture's administrator (names and passwords made per run, not recorded)",
      roots: ROOTS,
      outside: OUTSIDE,
      missingTwin: MISSING,
    },
    reads,
    outside,
    rootless: { isError: rootless.result.isError === true, acquired: rootless.acquired, text: rootlessText },
    refused,
    overBudget: textOf(overBudget.result).slice(0, 200),
    writes,
    limits: { leastTimeoutAnsweredMs: leastMs, leastReadEndedMs, cancelAnsweredMs: cancelIn, cancelReadEndedMs },
  };
  const text = `${JSON.stringify(capture, null, 2)}\n`;
  check(!carries(text, SECRETS), "capture: no password");
  check(!carries(text, Object.values(USERS)), "capture: no account name");
  check(!text.includes(PLANTED), "capture: no planted value");
  check(!text.includes(table[1] ?? "\u0000"), "capture: no host name");
  if (failures === 0) writeFileSync(join(OUT, "boundary.json"), text);
  for (const root of SCRATCH) rmSync(root, { recursive: true, force: true });
  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

await main();
