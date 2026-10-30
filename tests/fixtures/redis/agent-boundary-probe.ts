/**
 * Seeds the server a <version>/agent-boundary/run.sh started, sends the agent boundary plan as every principal the
 * agent read-only profile may meet, and writes what the server answered into that run.sh's directory.
 *
 *   bun tests/fixtures/redis/agent-boundary-probe.ts
 *
 * The environment carries REDIS_TARGET (host:port of a server whose `default` user is the stock `nopass`), REDIS_IMAGE
 * (the image with its digest) and REDIS_OUT (the directory to write). Every ACL user's password is generated here for
 * the run. A capture records a principal's name and its rules with the password left out, never a password, and the
 * script refuses to write a file that holds any form of any password it sent. It drives ioredis directly and sends
 * every command raw: no Studio check stands in front of it, which is the point, since what is measured is what the
 * server does on its own.
 *
 * Run by hand through run.sh, never by `bun run test`, which runs only `*.test.ts` files.
 */
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: a capture records what the server holds then.
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import Redis from "ioredis";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const [HOST, PORT] = env("REDIS_TARGET").split(":");
const IMAGE = env("REDIS_IMAGE");
const OUT = env("REDIS_OUT");
const DATE = new Date().toISOString().slice(0, 10);

/** Every form of every password the run sent; none may appear in a written capture. */
const SECRETS = new Set<string>();

function password(): string {
  const secret = randomBytes(16).toString("hex");
  SECRETS.add(secret);
  SECRETS.add(Buffer.from(secret, "utf8").toString("base64").replace(/=+$/, ""));
  return secret;
}

/** A principal: its ACL user (none for the stock `default nopass`), its rules as a capture states them. */
interface Principal {
  readonly user?: string;
  readonly password?: string;
  readonly rules: string;
}

const RULES: Readonly<Record<string, string>> = {
  full: "on ~* &* +@all",
  reader: "on ~* +@read",
  "reader-info": "on ~* +@read +info",
  "read-keys": "on %R~* &* +@all",
  "read-keys-read": "on %R~* +@read +info",
  "read-del": "on ~* +@read +info +del",
  "read-set": "on ~* +@read +info +set",
  prefix: "on ~app:* +@read +info",
  "scoped-writer": "on ~app:* &* +@read +info +@write",
  "channel-scoped": "on ~* resetchannels +@read +info +spublish",
  midrun: "on ~* +@read +info",
};

const PRINCIPALS: Record<string, Principal> = {
  "default-nopass": { rules: "the stock default user: on nopass ~* &* +@all" },
};
for (const [name, rules] of Object.entries(RULES)) {
  PRINCIPALS[name] = { user: `agent_${name.replace(/-/g, "_")}`, password: password(), rules };
}

const KEYS = {
  string: "agent:string",
  hash: "agent:hash",
  list: "agent:list",
  set: "agent:set",
  zset: "agent:zset",
  stream: "agent:stream",
  ttl: "agent:ttl",
  hll: "agent:hll",
  missing: "agent:missing",
} as const;

/** The no-op write probes: each changes nothing even when the server admits it. */
const PROBES: ReadonlyArray<readonly string[]> = [
  ["DEL", "agent-probe:missing"],
  ["UNLINK", "agent-probe:missing"],
  ["SET", "agent-probe:missing", "x", "XX"],
  ["EXPIRE", "agent-probe:missing", "1"],
  ["HDEL", "agent-probe:missing", "f"],
  ["LREM", "agent-probe:missing", "0", "x"],
  ["SREM", "agent-probe:missing", "x"],
  ["ZREM", "agent-probe:missing", "x"],
  ["XDEL", "agent-probe:missing", "0-1"],
  ["MOVE", "agent-probe:missing", "1"],
  ["RESTORE", "agent-probe:missing", "0", "not-a-dump-payload"],
  ["CONFIG", "SET", "agent-probe-no-such-parameter", "x"],
  ["EVALSHA", "0000000000000000000000000000000000000000", "0"],
  ["FUNCTION", "DELETE", "agent_probe_no_such_library"],
  ["SPUBLISH", "agent-probe:channel", "x"],
];

/** The metadata reads the agent may send, each against the key its request names. */
const TABLE: ReadonlyArray<readonly string[]> = [
  ["DBSIZE"],
  ["TYPE", KEYS.hash],
  ["TYPE", KEYS.missing],
  ["EXISTS", KEYS.hash],
  ["EXISTS", KEYS.missing],
  ["TTL", KEYS.ttl],
  ["TTL", KEYS.hash],
  ["TTL", KEYS.missing],
  ["PTTL", KEYS.ttl],
  ["STRLEN", KEYS.string],
  ["STRLEN", KEYS.hash],
  ["LLEN", KEYS.list],
  ["HLEN", KEYS.hash],
  ["SCARD", KEYS.set],
  ["ZCARD", KEYS.zset],
  ["XLEN", KEYS.stream],
  ["OBJECT", "ENCODING", KEYS.hash],
  ["OBJECT", "ENCODING", KEYS.missing],
  ["MEMORY", "USAGE", KEYS.hash],
  ["MEMORY", "USAGE", KEYS.hash, "SAMPLES", "5"],
  ["MEMORY", "USAGE", KEYS.missing],
];

/** Reads outside the table, for the record of what the server would do with them. */
const OUTSIDE: ReadonlyArray<readonly string[]> = [
  ["INFO", "server"],
  ["INFO", "keyspace"],
  ["HELLO", "2"],
  ["KEYS", "*"],
  ["SCAN", "0"],
  ["RANDOMKEY"],
  ["GET", KEYS.string],
  ["HGETALL", KEYS.hash],
  ["OBJECT", "FREQ", KEYS.hash],
  ["MEMORY", "DOCTOR"],
  ["CLIENT", "LIST"],
  ["SORT_RO", KEYS.list],
  ["EVAL_RO", "return 1", "0"],
  ["FCALL_RO", "agent_no_such_function", "0"],
  ["PFCOUNT", KEYS.hll],
  ["DEBUG", "OBJECT", KEYS.hash],
  ["NOSUCHCOMMAND", KEYS.string],
];

/** The commands whose COMMAND INFO is recorded: the table, the probes and the reads a reviewer would try. */
const COMMAND_INFO: readonly string[] = [
  "dbsize",
  "type",
  "exists",
  "ttl",
  "pttl",
  "strlen",
  "llen",
  "hlen",
  "scard",
  "zcard",
  "xlen",
  "object|encoding",
  "object|freq",
  "object|idletime",
  "object|refcount",
  "memory|usage",
  "memory|doctor",
  "memory|stats",
  "info",
  "hello",
  "keys",
  "scan",
  "randomkey",
  "sort_ro",
  "eval_ro",
  "evalsha_ro",
  "fcall_ro",
  "pfcount",
  "debug",
  "flushall",
  "config|set",
  "config|get",
  "eval",
  "client|list",
  "acl|whoami",
  "del",
  "unlink",
  "set",
  "expire",
  "hdel",
  "lrem",
  "srem",
  "zrem",
  "xdel",
  "move",
  "restore",
  "evalsha",
  "function|delete",
  "publish",
  "spublish",
];

interface Step {
  readonly argv: readonly string[];
  readonly outcome: "ok" | "error";
  readonly reply?: unknown;
  readonly error?: string;
}

function connect(principal: Principal | "admin"): Redis {
  const options = {
    host: HOST,
    port: Number(PORT),
    lazyConnect: true,
    enableReadyCheck: false,
    maxRetriesPerRequest: 0,
    stringNumbers: true,
  };
  if (principal === "admin" || principal.user === undefined) return new Redis(options);
  return new Redis({ ...options, username: principal.user, password: principal.password });
}

async function send(client: Redis, argv: readonly string[]): Promise<Step> {
  try {
    const reply: unknown = await client.call(argv[0], ...argv.slice(1));
    return { argv, outcome: "ok", reply };
  } catch (error) {
    return { argv, outcome: "error", error: error instanceof Error ? error.message : String(error) };
  }
}

/** One fresh connection per command, so no command leaves state for the next. */
async function run(principal: Principal | "admin", argv: readonly string[]): Promise<Step> {
  const client = connect(principal);
  try {
    await client.connect();
    return await send(client, argv);
  } finally {
    client.disconnect();
  }
}

function assertNoSecret(text: string, file: string): void {
  for (const secret of SECRETS) {
    if (text.includes(secret)) throw new Error(`${file} would hold a password; nothing was written`);
  }
}

let version = "unknown";

function write(name: string, header: Record<string, unknown>, body: Record<string, unknown>): void {
  const file = path.join(OUT, `${name}.json`);
  const text = `${JSON.stringify(
    {
      $captured: { image: IMAGE, version, date: DATE, runtime: `bun ${Bun.version}`, ...header },
      ...body,
    },
    null,
    2,
  )}\n`;
  assertNoSecret(text, file);
  writeFileSync(file, text);
}

async function admin(...argv: string[]): Promise<unknown> {
  const step = await run("admin", argv);
  if (step.outcome === "error") throw new Error(`admin ${argv.join(" ")}: ${step.error}`);
  return step.reply;
}

async function seed(): Promise<void> {
  await admin("FLUSHALL");
  await admin("SET", KEYS.string, "not-a-real-stored-value");
  await admin("HSET", KEYS.hash, "agent-field", "not-a-real-field-value");
  await admin("RPUSH", KEYS.list, "agent-member-a", "agent-member-b");
  await admin("SADD", KEYS.set, "agent-member-a");
  await admin("ZADD", KEYS.zset, "1", "agent-member-a");
  await admin("XADD", KEYS.stream, "1-1", "agent-stream-field", "not-a-real-stream-value");
  await admin("SET", KEYS.ttl, "not-a-real-stored-value", "EX", "3600");
  await admin("PFADD", KEYS.hll, "agent-member-a");
  for (const principal of Object.values(PRINCIPALS)) {
    if (principal.user === undefined) continue;
    await admin("ACL", "SETUSER", principal.user, "reset", ...principal.rules.split(" "), `>${principal.password}`);
  }
}

/** What the server holds, read as the admin: the probes' target never exists, and the seeded keys are unchanged. */
async function state(): Promise<Record<string, unknown>> {
  return {
    dbsize: await admin("DBSIZE"),
    probeKeyExists: await admin("EXISTS", "agent-probe:missing"),
    functions: await admin("FUNCTION", "LIST"),
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  for (const file of readdirSync(OUT)) if (file.endsWith(".json")) rmSync(path.join(OUT, file));
  const hello = (await admin("HELLO", "2")) as unknown[];
  version = String(hello[hello.indexOf("version") + 1]);
  await seed();

  const info: Record<string, unknown> = {};
  for (const name of COMMAND_INFO) info[name] = ((await admin("COMMAND", "INFO", name)) as unknown[])[0];
  write(
    "command-info",
    { surface: "COMMAND INFO of every command the table, the probes and a reviewer name" },
    { commands: info },
  );

  write(
    "identity",
    { surface: "what the server says it is, asked as the admin" },
    { hello: await admin("HELLO", "2"), infoServer: await admin("INFO", "server") },
  );

  for (const [who, principal] of Object.entries(PRINCIPALS)) {
    if (who === "midrun") continue;
    const before = await state();
    const probes: Step[] = [];
    for (const argv of PROBES) probes.push(await run(principal, argv));
    const after = await state();
    const table: Step[] = [];
    for (const argv of TABLE) table.push(await run(principal, argv));
    const outside: Step[] = [];
    for (const argv of OUTSIDE) outside.push(await run(principal, argv));
    write(
      who,
      { principal: principal.user ?? "default", rules: principal.rules },
      {
        probes,
        stateBeforeProbes: before,
        stateAfterProbes: after,
        table,
        outside,
      },
    );
  }

  // A user whose write commands reach only its own key pattern: refused every probe by key permission, yet it deletes
  // a key inside the pattern.
  const scoped = PRINCIPALS["scoped-writer"];
  await admin("SET", "app:in-pattern", "not-a-real-stored-value");
  const inPattern = await run(scoped, ["DEL", "app:in-pattern"]);
  const existsAfter = await admin("EXISTS", "app:in-pattern");
  write(
    "scoped-writer-in-pattern",
    { principal: scoped.user, rules: scoped.rules },
    { inPatternWrite: inPattern, existsAfterWrite: existsAfter },
  );

  // A grant made during the run: the probes pass, then the admin grants DEL, then the probes run again.
  const midrun = PRINCIPALS.midrun;
  const first: Step[] = [];
  for (const argv of PROBES) first.push(await run(midrun, argv));
  await admin("ACL", "SETUSER", midrun.user as string, "+del");
  const second: Step[] = [];
  for (const argv of PROBES) second.push(await run(midrun, argv));
  write(
    "midrun",
    { principal: midrun.user, rules: midrun.rules, grantedMidRun: "+del" },
    {
      probesBeforeGrant: first,
      probesAfterGrant: second,
    },
  );

  // Keyspace notifications: what a table read or a refused probe publishes on a server that notifies every class.
  await admin("CONFIG", "SET", "notify-keyspace-events", "KEAmn");
  const listener = connect("admin");
  await listener.connect();
  const heard: string[] = [];
  listener.on("pmessage", (_pattern: string, channel: string, message: string) => heard.push(`${channel} ${message}`));
  await listener.psubscribe("__key*@*__:*");
  const notifications: Array<{ argv: readonly string[]; outcome: string; published: string[] }> = [];
  for (const argv of [...TABLE, ...PROBES]) {
    heard.length = 0;
    const step = await run(PRINCIPALS["reader-info"], argv);
    await new Promise((resolve) => setTimeout(resolve, 50));
    notifications.push({ argv, outcome: step.outcome, published: [...heard] });
  }
  listener.disconnect();
  await admin("CONFIG", "SET", "notify-keyspace-events", "");
  write(
    "notifications",
    { principal: PRINCIPALS["reader-info"].user, rules: PRINCIPALS["reader-info"].rules, notify: "KEAmn" },
    { steps: notifications },
  );

  // A server that reports itself as another: Valkey's compatibility switch, where the server has it.
  const compat = await run("admin", ["CONFIG", "SET", "extended-redis-compatibility", "yes"]);
  write(
    "identity-compatibility",
    { surface: "what the server says it is with extended-redis-compatibility on, where it has the switch" },
    {
      configSet: compat,
      hello: compat.outcome === "ok" ? await admin("HELLO", "2") : null,
      infoServer: compat.outcome === "ok" ? await admin("INFO", "server") : null,
    },
  );
}

await main();
