/**
 * Live check of MCP's `run_redis_read` on Redis or Valkey, against a server of the operator's choosing.
 *
 * WHY THIS EXISTS. `run_redis_read` serves Redis through the same boundary agent mode does: the connection is acquired
 * under the agent read-only profile, whose open refuses a connection naming no ACL user or `default` before any socket
 * and proves the user read-only with fifteen write probes the server must refuse it, and every command goes through the
 * provider's `queryReadOnly`, which reads it against the closed table of metadata reads and proves the user again on
 * the command's own connection. The MCP fence in front of it is defence in depth. So this script replays that boundary
 * through the MCP tool's own handler (`runStatement`), against a real server:
 *
 *  - the open, through MCP: a `+@read` user is served; a connection naming no user, one naming `default`, a full user,
 *    a key-pattern writer and a reader granted `+del` are each refused before any command runs, in the tool's sentence;
 *  - the forms: one read per command of the closed table answers one row that never names its key;
 *  - the boundary, with the MCP fence bypassed: each write, key listing, value read, `INFO`, `SELECT` and second
 *    command is refused by the provider before it is sent; the same writes sent raw as the reader are refused NOPERM by
 *    the server, the writable admin runs them on a control key (the positive control), and a hash of every key, value,
 *    time to live, ACL user and function is the same before and after;
 *  - the data scope: a reader whose key pattern is `~app:*` reads its own keys and is refused a key outside the pattern
 *    in the same words whether that key exists or not, words that never name the key; DBSIZE still counts every key of
 *    the database; a `~*` reader answers whether any key exists; inspect_schema, which takes the operations profile,
 *    lists the leading segments of the key groupings for any user, `default` included;
 *  - the limits: a read past `timeout_ms` (the server held by `DEBUG SLEEP`) is answered as the timeout, and a cancelled
 *    call is answered as the cancel at once while the provider's read runs on: each of its steps, the connection's AUTH,
 *    the proof's round trip and the command, takes the call's time left as its own command timeout.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it against a server you may write to,
 * whose `default` user is the stock `nopass +@all` and which allows `DEBUG` (`--enable-debug-command yes`):
 *
 *   docker run -d --name pr420-redis -p 127.0.0.1:16391:6379 redis:8.10.2 redis-server --enable-debug-command yes
 *   LIBREDB_LIVE_REDIS_PORT=16391 bun tests/live/redis-mcp-boundary.ts
 *
 * With `--relative`, against a Redis-wire relative (KeyDB, Garnet), it checks only that a `+@read` user is refused at
 * the open through MCP.
 *
 * Every key and ACL user it creates carries the `libredb_lm_` or `app:`/`secret:` prefix in database 0 and is removed
 * on exit. Each check prints one line, no credential among them, and any failure ends the run non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import { createHash, randomBytes } from "node:crypto";
import Redis from "ioredis";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import type { DatabaseProvider } from "@/lib/db/types";
import type { McpConnectionContext } from "@/lib/mcp/context";
import type { ToolResult } from "@/lib/mcp/output";
import { InspectSchemaInputSchema, inspectSchema } from "@/lib/mcp/tools/inspect-schema";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm, type McpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";

const PREFIX = "libredb_lm_";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`set ${name}: this script writes to the server it is pointed at, so it has no default`);
    process.exit(2);
  }
  return value;
}

const HOST = process.env.LIBREDB_LIVE_REDIS_HOST ?? "127.0.0.1";
const PORT = Number(env("LIBREDB_LIVE_REDIS_PORT"));
/** One password for every seeded user, made for the run. */
const SEEDED_PASSWORD = randomBytes(12).toString("hex");

/** The tool as MCP registers it, and the same tool with its fence removed: the boundary under test. */
const RUN_REDIS_READ = mcpStatementArm("run_redis_read");
const UNFENCED: McpStatementArm = { ...RUN_REDIS_READ, fence: () => null };

/** The ACL users the run creates, by short name, with their rules. */
const USERS = {
  reader: "~* +@read",
  scoped: "~app:* +@read",
  full: "~* &* +@all",
  scopedwriter: "~app:* +@read +@write",
  readdel: "~* +@read +del",
} as const;
type UserName = keyof typeof USERS;

/** The keys the run seeds: `app:*` inside the scoped users' pattern, `secret:*` outside it. */
const KEYS = {
  hash: "app:profile",
  string: "app:greeting",
  list: "app:queue",
  set: "app:tags",
  zset: "app:scores",
  stream: "app:events",
  ttl: "app:session",
  secret: "secret:token",
} as const;
const CONTROL = `${PREFIX}control`;

const admin = new Redis({ host: HOST, port: PORT, lazyConnect: true, enableReadyCheck: false });

function seed(id: string, user: string | undefined, password = SEEDED_PASSWORD): ManagedConnection {
  return {
    id: `seed:live-${id}`,
    name: id,
    seedId: `live-${id}`,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "redis",
    host: HOST,
    port: PORT,
    ...(user === undefined ? {} : { user }),
    ...(password === "" ? {} : { password }),
    createdAt: new Date(),
  } as ManagedConnection;
}

const userSeed = (name: UserName) => seed(name, `${PREFIX}${name}`);

let failures = 0;
function check(ok: boolean, line: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

interface Called {
  readonly result: ToolResult;
  readonly acquired: ExecutionProfile[];
  /** When the provider's own read settled, in ms from the call's start, or null when no read was sent. */
  readonly readSettled: Promise<number | null>;
  readonly elapsed: number;
}

/** One MCP call on `connection`, through the factory's own profiled acquisition, as the route makes it. */
async function mcp(
  connection: ManagedConnection,
  args: Partial<McpStatementInput> & { readonly statement: string },
  arm: McpStatementArm = RUN_REDIS_READ,
  signal: AbortSignal = new AbortController().signal,
): Promise<Called> {
  const acquired: ExecutionProfile[] = [];
  const started = Date.now();
  let settled: Promise<number | null> = Promise.resolve(null);
  const context = {
    caller: { username: "live", role: "admin" },
    visibleConnections: async () => [connection],
    resolve: async () => connection,
    acquire: async (target: ManagedConnection, profile: ExecutionProfile) => {
      acquired.push(profile);
      const provider = await acquireExecutionProfileProvider(target, profile);
      // Records when the provider's read itself settles, which a cancel or the deadline does not wait for.
      return new Proxy(provider, {
        get(subject, key, receiver) {
          const value = Reflect.get(subject, key, receiver);
          if (key !== "queryReadOnly" || typeof value !== "function") return value;
          return (...params: unknown[]) => {
            const read = (value as (...a: unknown[]) => Promise<unknown>).apply(subject, params);
            settled = read.then(
              () => Date.now() - started,
              () => Date.now() - started,
            );
            return read;
          };
        },
      }) as DatabaseProvider;
    },
  } as unknown as McpConnectionContext;
  const input = arm.inputSchema.parse({ connection_id: connection.id, ...args }) as McpStatementInput;
  const result = await runStatement(arm, input, { context, signal });
  return { result, acquired, readSettled: Promise.resolve().then(() => settled), elapsed: Date.now() - started };
}

const textOf = (result: ToolResult): string =>
  result.content.map((part) => ("text" in part ? part.text : "")).join(" ");
const rowsOf = (result: ToolResult): string => JSON.stringify(result.structuredContent?.rows);

/** Every key's type, value, time to live (rounded to the minute), the ACL users and the function libraries. */
async function stateHash(): Promise<string> {
  const hash = createHash("sha256");
  const keys = (await admin.keys("*")).sort();
  for (const key of keys) {
    const type = await admin.type(key);
    const ttl = await admin.ttl(key);
    const dump = await admin.dumpBuffer(key);
    hash.update(`${key}|${type}|${ttl < 0 ? ttl : Math.round(ttl / 60)}|${dump?.toString("base64")}`);
  }
  hash.update(JSON.stringify(((await admin.call("ACL", "LIST")) as string[]).filter((rule) => rule.includes(PREFIX))));
  hash.update(JSON.stringify(await admin.call("FUNCTION", "LIST")));
  return hash.digest("hex");
}

async function seedServer(): Promise<void> {
  await cleanup();
  await admin.hset(KEYS.hash, "email", "not-a-real-address");
  await admin.set(KEYS.string, "hello");
  await admin.rpush(KEYS.list, "a", "b");
  await admin.sadd(KEYS.set, "x");
  await admin.zadd(KEYS.zset, 1, "m");
  await admin.xadd(KEYS.stream, "*", "f", "v");
  await admin.set(KEYS.ttl, "s", "EX", 3600);
  await admin.set(KEYS.secret, "not-a-real-token");
  for (const [name, rules] of Object.entries(USERS)) {
    await admin.call("ACL", "SETUSER", `${PREFIX}${name}`, "on", `>${SEEDED_PASSWORD}`, ...rules.split(" "));
  }
}

async function cleanup(): Promise<void> {
  const keys = [...Object.values(KEYS), CONTROL, `${CONTROL}:moved`];
  await admin.del(...keys);
  for (const name of Object.keys(USERS)) await admin.call("ACL", "DELUSER", `${PREFIX}${name}`);
}

/** The writes a reader must never make, each also sent raw as the reader and as the admin on the control key. */
const WRITES: readonly string[] = [
  "SET {k} x",
  "DEL {k}",
  "EXPIRE {k} 1",
  "HSET {k} f v",
  "LPUSH {k} v",
  "RENAME {k} {k}:moved",
];

/** Commands the closed table leaves out, each refused by the provider before it is sent. */
const REFUSED_FORMS: readonly string[] = [
  ...WRITES.map((write) => write.replaceAll("{k}", KEYS.hash)),
  "SCAN 0",
  "KEYS *",
  "RANDOMKEY",
  `GET ${KEYS.string}`,
  `HGETALL ${KEYS.hash}`,
  "INFO keyspace",
  "SELECT 1",
  "CONFIG GET *",
  "OBJECT FREQ app:profile",
  `MEMORY USAGE ${KEYS.hash} SAMPLES 0`,
  `DBSIZE\nDEL ${KEYS.hash}`,
  'EVAL_RO "return 1" 0',
];

async function main(): Promise<void> {
  await admin.connect();
  const hello = (await admin.call("HELLO", "2")) as unknown[];
  console.log(`server: ${hello[1]} ${hello[3]}`);
  await seedServer();
  const reader = userSeed("reader");

  // The open, through MCP.
  const served = await mcp(reader, { statement: "DBSIZE" });
  check(
    served.result.isError === undefined &&
      rowsOf(served.result) === '[{"keys":8}]' &&
      served.acquired.join() === "agent-read-only",
    `open: ${PREFIX}reader (${USERS.reader}) is served under agent-read-only -> ${rowsOf(served.result)}`,
  );
  const refusedOpens: readonly [string, ManagedConnection, string][] = [
    ["a connection naming no user", seed("stock", undefined, ""), "names no user"],
    ["a connection naming default", seed("named-default", "default", ""), "refuses Redis's default user"],
    ["the full user", userSeed("full"), "may run DEL"],
    ["the key-pattern writer", userSeed("scopedwriter"), "refused it only by its key or channel permissions"],
    ["a reader granted +del", userSeed("readdel"), "may run DEL"],
  ];
  for (const [what, connection, says] of refusedOpens) {
    const { result } = await mcp(connection, { statement: "DBSIZE" });
    const text = textOf(result);
    check(
      result.isError === true &&
        text.startsWith("run_redis_read cannot run on this connection: ") &&
        text.endsWith("It runs on Redis.") &&
        text.includes(says),
      `open: ${what} is refused through MCP -> ${text}`,
    );
  }

  // The forms: one read per command of the closed table.
  const FORMS: readonly [string, string][] = [
    ["DBSIZE", '[{"keys":8}]'],
    [`TYPE ${KEYS.hash}`, '[{"type":"hash"}]'],
    [`EXISTS ${KEYS.hash}`, '[{"exists":true}]'],
    [`TTL ${KEYS.ttl}`, ""],
    [`PTTL ${KEYS.ttl}`, ""],
    [`STRLEN ${KEYS.string}`, '[{"length":5}]'],
    [`LLEN ${KEYS.list}`, '[{"length":2}]'],
    [`HLEN ${KEYS.hash}`, '[{"length":1}]'],
    [`SCARD ${KEYS.set}`, '[{"length":1}]'],
    [`ZCARD ${KEYS.zset}`, '[{"length":1}]'],
    [`XLEN ${KEYS.stream}`, '[{"length":1}]'],
    [`OBJECT ENCODING ${KEYS.hash}`, '[{"encoding":"listpack"}]'],
    [`MEMORY USAGE ${KEYS.hash} SAMPLES 5`, ""],
  ];
  for (const [statement, expected] of FORMS) {
    const { result } = await mcp(reader, { statement });
    const rows = rowsOf(result);
    const key = statement.split(" ").find((word) => word.includes(":"));
    check(
      result.isError === undefined &&
        result.structuredContent?.row_count === 1 &&
        (expected === "" || rows === expected) &&
        (key === undefined || !JSON.stringify(result).includes(key)),
      `form: ${statement.replace(/app:\S+/, "<key>")} answers one row that never names its key -> ${rows}`,
    );
  }

  // The boundary: the MCP fence refuses each form; bypassed, the provider refuses it before it is sent.
  const before = await stateHash();
  for (const statement of REFUSED_FORMS) {
    const fenced = await mcp(reader, { statement });
    const bypassed = await mcp(reader, { statement }, UNFENCED);
    const shown = statement.replace("\n", "\\n");
    check(
      textOf(fenced.result).startsWith("The command was refused before it reached the server (") &&
        fenced.acquired.length === 0 &&
        textOf(bypassed.result).startsWith("The statement was refused before it reached the database: ") &&
        !textOf(bypassed.result).includes("app:") &&
        !textOf(fenced.result).includes("app:"),
      `boundary: the MCP fence refuses ${shown}; bypassed, the provider refuses it before it is sent`,
    );
  }
  const raw = new Redis({
    host: HOST,
    port: PORT,
    username: `${PREFIX}reader`,
    password: SEEDED_PASSWORD,
    lazyConnect: true,
    enableReadyCheck: false,
  });
  await raw.connect();
  for (const template of WRITES) {
    const [command, ...args] = template.replaceAll("{k}", KEYS.hash).split(" ");
    const refused = await raw.call(command, ...args).then(
      () => "answered",
      (error: Error) => error.message,
    );
    check(
      refused.startsWith(
        `NOPERM User ${PREFIX}reader has no permissions to run the '${command.toLowerCase()}' command`,
      ),
      `boundary: sent raw as the reader, the server refuses ${command} -> ${refused}`,
    );
  }
  raw.disconnect();
  const after = await stateHash();
  check(before === after, `boundary: the state hash is the same before and after -> ${before} / ${after}`);
  // The positive control: the admin runs every write on the control key, set up for each so it applies.
  for (const template of WRITES) {
    const [command, ...args] = template.replaceAll("{k}", CONTROL).split(" ");
    await admin.del(CONTROL, `${CONTROL}:moved`);
    if (["DEL", "EXPIRE", "RENAME"].includes(command)) await admin.set(CONTROL, "v");
    const outcome = await admin.call(command, ...args).then(
      () => "answered",
      (error: Error) => error.message,
    );
    check(outcome === "answered", `control: the writable admin runs ${command} on the control key -> ${outcome}`);
  }
  await admin.del(CONTROL, `${CONTROL}:moved`);

  // The data scope.
  const scoped = userSeed("scoped");
  const own = await mcp(scoped, { statement: `TYPE ${KEYS.hash}` });
  check(
    rowsOf(own.result) === '[{"type":"hash"}]',
    `scope: the ~app:* reader reads its own key -> ${rowsOf(own.result)}`,
  );
  const hit = await mcp(scoped, { statement: `TYPE ${KEYS.secret}` });
  const miss = await mcp(scoped, { statement: "TYPE secret:absent" });
  check(
    hit.result.isError === true &&
      textOf(hit.result) === textOf(miss.result) &&
      textOf(hit.result).includes("may not read the key this request names") &&
      !textOf(hit.result).includes("secret:") &&
      !textOf(hit.result).includes("No permissions to access a key"),
    `scope: a key outside ~app:* is refused alike whether it exists or not, without its name -> ${textOf(hit.result)}`,
  );
  const scopedCount = await mcp(scoped, { statement: "DBSIZE" });
  check(
    rowsOf(scopedCount.result) === '[{"keys":8}]',
    `scope: DBSIZE as the ~app:* reader counts every key of the database, its pattern's or not -> ${rowsOf(scopedCount.result)}`,
  );
  const oracle = await mcp(reader, { statement: `EXISTS ${KEYS.secret}` });
  check(
    rowsOf(oracle.result) === '[{"exists":true}]',
    `scope: the ~* reader answers whether any key it names exists -> ${rowsOf(oracle.result)}`,
  );
  const inspected = await inspectSchemaOf(seed("named-default", "default", ""));
  check(
    inspected.includes("app:*") && inspected.includes("secret:*") && !inspected.includes(KEYS.secret),
    `scope: inspect_schema on a connection naming default lists the leading segments under the operations profile -> ${inspected}`,
  );

  // The limits.
  const sleeper = new Redis({ host: HOST, port: PORT, lazyConnect: true, enableReadyCheck: false });
  await sleeper.connect();
  const held = sleeper.call("DEBUG", "SLEEP", "3");
  await Bun.sleep(100);
  const slow = await mcp(reader, { statement: "DBSIZE", timeout_ms: 500 });
  check(
    textOf(slow.result) ===
      "The statement did not finish within timeout_ms (500 ms). Narrow it, or raise timeout_ms up to 30000." &&
      slow.elapsed < 1_500,
    `limits: past timeout_ms 500 while the server sleeps -> ${textOf(slow.result)} (${slow.elapsed} ms)`,
  );
  await held;
  // Long enough that no step of the read is answered before each one's own timeout.
  const cancelHeld = sleeper.call("DEBUG", "SLEEP", "8");
  await Bun.sleep(100);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 300);
  const cancelled = await mcp(reader, { statement: "DBSIZE", timeout_ms: 2_000 }, RUN_REDIS_READ, controller.signal);
  const settledAt = await await cancelled.readSettled;
  check(
    textOf(cancelled.result) === "The call was cancelled before it finished." && cancelled.elapsed < 1_000,
    `limits: a cancel answers at once -> ${textOf(cancelled.result)} (${cancelled.elapsed} ms)`,
  );
  // Each step of the read (the connection's AUTH, the proof's round trip, the command) takes the time left as its own
  // command timeout, so a server that answers none of them holds the read past the time left, never past three times it.
  check(
    settledAt !== null && settledAt >= 1_500 && settledAt < 6_500,
    `limits: the provider's read settles after the cancel, each of its steps bounded by the call's time left -> ${settledAt} ms`,
  );
  await cancelHeld;
  sleeper.disconnect();
}

/** inspect_schema's answer text on `connection`, through the factory's own profiled acquisition. */
async function inspectSchemaOf(connection: ManagedConnection): Promise<string> {
  const context = {
    caller: { username: "live", role: "admin" },
    visibleConnections: async () => [connection],
    resolve: async () => connection,
    acquire: (target: ManagedConnection, profile: ExecutionProfile) => acquireExecutionProfileProvider(target, profile),
  } as unknown as McpConnectionContext;
  const args = InspectSchemaInputSchema.parse({ connection_id: connection.id });
  const result = await inspectSchema(args, { context, signal: new AbortController().signal });
  return JSON.stringify(result.structuredContent ?? textOf(result));
}

/**
 * On a Redis-wire relative (`--relative`): a `+@read` user is refused at the open through MCP, by the identity check
 * or by the proof's exact wording, and no command is sent.
 */
async function relative(): Promise<void> {
  await admin.connect();
  const created = await admin
    .call("ACL", "SETUSER", `${PREFIX}reader`, "on", `>${SEEDED_PASSWORD}`, "~*", "+@read")
    .then(
      () => "created",
      (error: Error) => error.message,
    );
  console.log(`server: a +@read ACL user -> ${created}`);
  const { result, acquired } = await mcp(userSeed("reader"), { statement: "DBSIZE" });
  check(
    result.isError === true &&
      textOf(result).startsWith("run_redis_read cannot run on this connection: ") &&
      acquired.join() === "agent-read-only",
    `relative: a +@read user is refused at the open through MCP -> ${textOf(result)}`,
  );
  await admin.call("ACL", "DELUSER", `${PREFIX}reader`).catch(() => undefined);
}

try {
  if (process.argv.includes("--relative")) await relative();
  else await main();
} finally {
  await clearProviderCache();
  if (!process.argv.includes("--relative")) await cleanup();
  admin.disconnect();
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
