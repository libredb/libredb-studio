/**
 * Live check of MCP's `run_etcd_read` against two fresh etcd v3.7.2 servers, one with authentication on and one with
 * it off, both serving TLS, as tests/fixtures/etcd/v3.7.2/mcp-scope/run.sh starts them.
 *
 * WHY THIS EXISTS. `run_etcd_read` serves etcd through the same boundary agent mode does: the connection is acquired
 * under the agent read-only profile, and every command goes through the provider's `queryReadOnly`, whose closed table
 * names no write and which, before every command, has the server show the connection's user holds no root role and
 * only READ, on no Kubernetes storage prefix and not on every key, then projects the answer to names, counts and
 * sizes. The agent's reader in front of it is defence in depth. So this script drives the MCP tool's own handler
 * (`runStatement`) with a seed connection, with that reader as the tool's fence and with it removed:
 *
 *  - the forms: one accepted read of each command of the table, whose answer holds no seeded key name, value or
 *    member address;
 *  - the boundary, with the fence bypassed: a write and each refused form are refused by the fenced tool before
 *    anything is acquired, and by the provider's reader before anything is sent when the fence is removed; the same
 *    writes sent raw as the reader are refused `permission denied`, the positive control as root is admitted, and the
 *    keys, their revisions and the leases read the same before and after;
 *  - the open, through MCP: root, a user holding the root role, a READWRITE range, READ on every key, READ on
 *    /registry/, on one Secret's key and on `/`, a user on the server with authentication off, and a connection that
 *    names no user are each refused in the tool's sentence before the command is sent; READ on one key of `/app/`
 *    and no role at all are proved;
 *  - the data scope: a user reading `/app/` is refused a Secret's key alike whether it exists or not, in Studio's
 *    words, and lists every lease and member of the cluster, which its grants do not govern; each raw answer is
 *    written to tests/fixtures/etcd/v3.7.2/mcp-scope/;
 *  - the limits: a lease list past the 1000-row provider budget is refused, never cut, and one past max_rows is cut
 *    with advice; through a local proxy that stops forwarding, a read at the minimum timeout_ms is answered as the
 *    timeout and the client's call ends at the time left, and a client cancel is answered at once while the
 *    provider's call stays open until its own deadline ends it at the time left;
 *  - the cost: the server's own gRPC counters show what one call on a held handle sends.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it through run.sh. Each check prints one
 * line, and a line that would carry a password or a token fails instead of printing it; any failure ends the run
 * non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createConnection, createServer, type Socket } from "node:net";
import { posix } from "node:path";
import * as grpc from "@grpc/grpc-js";
import { fromJSON } from "@grpc/proto-loader";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import { ETCD_AGENT_FAILURE_SENTENCES } from "@/lib/db/providers/keyvalue/etcd/agent-metadata-read";
import { ETCD_PROOF_SENTENCES } from "@/lib/db/providers/keyvalue/etcd/agent-read-only-proof";
import { ETCD_DESCRIPTOR } from "@/lib/db/providers/keyvalue/etcd/proto/descriptor";
import type { DatabaseProvider } from "@/lib/db/types";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_CANCELLED_TEXT, type ToolResult } from "@/lib/mcp/output";
import { timeoutText } from "@/lib/mcp/tools/read-query-limits";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm, type McpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`set ${name}: run this through tests/fixtures/etcd/v3.7.2/mcp-scope/run.sh`);
    process.exit(2);
  }
  return value;
}

const AUTH_TARGET = env("ETCD_AUTH_TARGET");
const OPEN_TARGET = env("ETCD_OPEN_TARGET");
const CA = readFileSync(env("ETCD_CA"), "utf8");
const IMAGE = env("ETCD_IMAGE");
const OUT = env("ETCD_OUT").replaceAll("\\", "/");
const DATE = new Date().toISOString().slice(0, 10);

/** Every password and token of the run, in each form it travels; none may reach a printed line or a capture. */
const SECRETS = new Set<string>();
function remember(secret: string): void {
  SECRETS.add(secret);
  SECRETS.add(Buffer.from(secret, "utf8").toString("base64").replace(/=+$/, ""));
}
function password(): string {
  const secret = randomBytes(16).toString("hex");
  remember(secret);
  return secret;
}

let failures = 0;
function check(ok: boolean, line: string): void {
  if ([...SECRETS].some((secret) => line.includes(secret))) {
    console.log("FAIL a check line carried a password or a token, and is not printed");
    failures++;
    return;
  }
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

// ============================================================================
// Raw gRPC, past every Studio check
// ============================================================================

const definition = fromJSON(ETCD_DESCRIPTOR as Parameters<typeof fromJSON>[0], {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a generic client built from the descriptor at run time.
const pkg = grpc.loadPackageDefinition(definition).etcdserverpb as any;
type Service = "KV" | "Lease" | "Cluster" | "Maintenance" | "Auth";
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a generic client built from the descriptor at run time.
const clients = new Map<string, any>();
const credentials = grpc.credentials.createSsl(Buffer.from(CA));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a generic client built from the descriptor at run time.
function client(target: string, service: Service): any {
  const id = `${target} ${service}`;
  let found = clients.get(id);
  if (found === undefined) {
    // Bun refuses an IP as a TLS server name, so the raw client names the certificate's DNS name instead.
    found = new pkg[service](target, credentials, { "grpc.ssl_target_name_override": "localhost" });
    clients.set(id, found);
  }
  return found;
}

type Answer =
  | { readonly outcome: "ok"; readonly answer: unknown }
  | { readonly outcome: "error"; readonly code: number; readonly details: string };

/** Bytes as a capture shows them: the text where it is printable, else base64. */
function show(value: unknown): unknown {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    const text = bytes.toString("utf8");
    return /^[\x20-\x7e]*$/.test(text) && Buffer.from(text, "utf8").equals(bytes)
      ? { $text: text }
      : { $bytes: bytes.toString("base64") };
  }
  if (Array.isArray(value)) return value.map(show);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, show(inner)]));
  }
  return value;
}

function unary(target: string, service: Service, method: string, request: unknown, token?: string): Promise<Answer> {
  const metadata = new grpc.Metadata();
  if (token !== undefined) metadata.set("token", token);
  return new Promise((resolve) => {
    client(target, service)[method](
      request,
      metadata,
      { deadline: new Date(Date.now() + 5_000) },
      (error: grpc.ServiceError | null, answer: unknown) => {
        if (error) resolve({ outcome: "error", code: error.code, details: error.details });
        else resolve({ outcome: "ok", answer: show(answer) });
      },
    );
  });
}

async function must(answer: Promise<Answer>, what: string): Promise<unknown> {
  const settled = await answer;
  if (settled.outcome !== "ok") throw new Error(`${what} failed: ${settled.details}`);
  return settled.answer;
}

async function signIn(target: string, user: string, secret: string): Promise<string> {
  const answer = (await must(unary(target, "Auth", "Authenticate", { name: user, password: secret }), "sign-in")) as {
    token: string;
  };
  remember(answer.token);
  return answer.token;
}

const bytes = (text: string) => Buffer.from(text);
function prefixEnd(prefix: string): Buffer {
  const out = Buffer.from(prefix);
  out[out.length - 1] += 1;
  return out;
}
/** The whole key space as one byte range: from the 0x00 key to the end. */
const ALL = { key: Buffer.from([0]), range_end: Buffer.from([0]) };

// ============================================================================
// The cluster: keys, roles and users
// ============================================================================

const KEYS = {
  config: "/app/config",
  feature: "/app/feature",
  missing: "/app/missing",
  secret: "/registry/secrets/default/present",
  absentSecret: "/registry/secrets/default/absent",
  pod: "/registry/pods/default/web",
  event: "/registry/events/default/web.1",
  outside: "/other/credential",
} as const;

/** Fixture values only; none may reach an MCP answer. */
const SEED: ReadonlyArray<readonly [string, string]> = [
  [KEYS.config, "fixture-config-value"],
  [KEYS.feature, "fixture-feature-flag"],
  [KEYS.secret, "fixture-secret-value"],
  [KEYS.pod, "fixture-pod-object"],
  [KEYS.outside, "fixture-outside-value"],
];
/** What a seeded key name, value or member address holds; none of it may reach an answer. */
const SEEDED = /\/app\/|\/registry\/|\/other\/|fixture-|127\.0\.0\.1|https?:/;

type Grant = { readonly type: "READ" | "READWRITE"; readonly key: Buffer; readonly end?: Buffer };
const ROLES: Readonly<Record<string, readonly Grant[]>> = {
  mcp_read_app: [{ type: "READ", key: bytes("/app/"), end: prefixEnd("/app/") }],
  mcp_read_app_key: [{ type: "READ", key: bytes(KEYS.config) }],
  mcp_read_all: [{ type: "READ", key: ALL.key, end: ALL.range_end }],
  mcp_read_registry: [{ type: "READ", key: bytes("/registry/"), end: prefixEnd("/registry/") }],
  mcp_read_secret_key: [{ type: "READ", key: bytes(KEYS.secret) }],
  mcp_read_slash: [{ type: "READ", key: bytes("/"), end: prefixEnd("/") }],
  mcp_readwrite_app: [{ type: "READWRITE", key: bytes("/app/"), end: prefixEnd("/app/") }],
};

interface User {
  readonly user: string;
  readonly password: string;
  readonly roles: readonly string[];
}
const USERS = {
  root: { user: "root", password: password(), roles: ["root"] },
  app: { user: "mcp_reader_app", password: password(), roles: ["mcp_read_app"] },
  appKey: { user: "mcp_reader_app_key", password: password(), roles: ["mcp_read_app_key"] },
  all: { user: "mcp_reader_all", password: password(), roles: ["mcp_read_all"] },
  registry: { user: "mcp_reader_registry", password: password(), roles: ["mcp_read_registry"] },
  secretKey: { user: "mcp_reader_secret_key", password: password(), roles: ["mcp_read_secret_key"] },
  slash: { user: "mcp_reader_slash", password: password(), roles: ["mcp_read_slash"] },
  readwrite: { user: "mcp_readwrite_app", password: password(), roles: ["mcp_readwrite_app"] },
  rootRole: { user: "mcp_root_role", password: password(), roles: ["root"] },
  noRoles: { user: "mcp_no_roles", password: password(), roles: [] },
} satisfies Record<string, User>;

let rootToken = "";

async function seedCluster(): Promise<{ registryLease: string; appLease: string }> {
  for (const [key, value] of SEED) {
    await must(unary(AUTH_TARGET, "KV", "Put", { key: bytes(key), value: bytes(value) }), `seed ${key}`);
  }
  const lease = async () =>
    ((await must(unary(AUTH_TARGET, "Lease", "LeaseGrant", { TTL: "3600", ID: "0" }), "lease")) as { ID: string }).ID;
  const registryLease = await lease();
  await must(
    unary(AUTH_TARGET, "KV", "Put", { key: bytes(KEYS.event), value: bytes("fixture-event"), lease: registryLease }),
    "leased event",
  );
  const appLease = await lease();
  await must(
    unary(AUTH_TARGET, "KV", "Put", { key: bytes("/app/session"), value: bytes("fixture-session"), lease: appLease }),
    "leased session",
  );
  for (const [role, grants] of Object.entries(ROLES)) {
    await must(unary(AUTH_TARGET, "Auth", "RoleAdd", { name: role }), `role ${role}`);
    for (const grant of grants) {
      await must(
        unary(AUTH_TARGET, "Auth", "RoleGrantPermission", {
          name: role,
          perm: { permType: grant.type, key: grant.key, range_end: grant.end ?? Buffer.alloc(0) },
        }),
        `grant ${role}`,
      );
    }
  }
  for (const entry of Object.values(USERS)) {
    await must(
      unary(AUTH_TARGET, "Auth", "UserAdd", { name: entry.user, password: entry.password, options: {} }),
      `user ${entry.user}`,
    );
    for (const role of entry.roles) {
      await must(unary(AUTH_TARGET, "Auth", "UserGrantRole", { user: entry.user, role }), `grant ${entry.user}`);
    }
  }
  await must(unary(AUTH_TARGET, "Auth", "AuthEnable", {}), "auth enable");
  rootToken = await signIn(AUTH_TARGET, USERS.root.user, USERS.root.password);
  // The open server: one key, so a read there would answer something.
  await must(
    unary(OPEN_TARGET, "KV", "Put", { key: bytes(KEYS.config), value: bytes("fixture-config-value") }),
    "open",
  );
  return { registryLease, appLease };
}

/** Everything a write could change, read as root: every key with its revisions, and every lease. */
async function clusterState(): Promise<string> {
  const keys = (await must(
    unary(AUTH_TARGET, "KV", "Range", { ...ALL, keys_only: true, limit: "0" }, rootToken),
    "state keys",
  )) as { kvs: Array<{ key: unknown; mod_revision: string; version: string }> };
  const leases = (await must(unary(AUTH_TARGET, "Lease", "LeaseLeases", {}, rootToken), "state leases")) as {
    leases: Array<{ ID: string }>;
  };
  return JSON.stringify({
    keys: keys.kvs.map((kv) => [kv.key, kv.mod_revision, kv.version]),
    leases: leases.leases.map((entry) => entry.ID).sort(),
  });
}

// ============================================================================
// Through MCP
// ============================================================================

function seed(id: string, target: string, entry: User | undefined): ManagedConnection {
  const [host, port] = target.split(":");
  return {
    id: `seed:live-${id}`,
    name: id,
    seedId: `live-${id}`,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "etcd",
    host,
    port: Number(port),
    ...(entry === undefined ? {} : { user: entry.user, password: entry.password }),
    ssl: { mode: "verify-full", caCert: CA },
    createdAt: new Date(),
  } as ManagedConnection;
}

const RUN_ETCD_READ = mcpStatementArm("run_etcd_read");
/** The tool with its reader removed as a fence: the boundary under test. */
const UNFENCED: McpStatementArm = { ...RUN_ETCD_READ, fence: () => null };
const NOT_SENT = "The statement was refused before it reached the database: ";

/** When the last provider handed out settled its `queryReadOnly`, measured from the call. */
let lastSettledAt: number | null = null;

async function mcp(
  connection: ManagedConnection,
  args: Partial<McpStatementInput> & { readonly statement: string },
  arm: McpStatementArm = RUN_ETCD_READ,
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
  return { result, acquired };
}

const textOf = (result: ToolResult): string =>
  result.content.map((part) => ("text" in part ? part.text : "")).join(" ");

interface Answered {
  readonly rows: Record<string, unknown>[];
  readonly row_count: number;
  readonly truncated: boolean;
  readonly hint: string | null;
}
const answerOf = (result: ToolResult): Answered => result.structuredContent as unknown as Answered;
const openRefusal = (sentence: string) =>
  `run_etcd_read cannot run on this connection: ${sentence.replace(/\.+$/, "")}. It runs on etcd.`;

/** One raw scope answer, written as a capture that names the principal and its grants, never a secret. */
function capture(name: string, principal: User, request: Record<string, unknown>, answer: Answer): void {
  const text = `${JSON.stringify(
    {
      $captured: { image: IMAGE, version: "3.7.2", date: DATE, runtime: `bun ${Bun.version}` },
      principal: principal.user,
      grants: principal.roles.map((role) => ({ role, permissions: show(ROLES[role] ?? []) })),
      request: show(request),
      ...answer,
    },
    null,
    2,
  )}\n`;
  for (const secret of SECRETS) {
    if (text.includes(secret)) throw new Error(`capture ${name} would carry a password or a token`);
  }
  writeFileSync(posix.join(OUT, `${name}.json`), text);
}

/** The server's own count of each gRPC method it has answered, from its metrics endpoint. */
async function handled(): Promise<Record<string, number>> {
  const response = await fetch(`https://${AUTH_TARGET}/metrics`, { tls: { ca: CA } } as RequestInit);
  const counts: Record<string, number> = {};
  for (const line of (await response.text()).split("\n")) {
    const match = /^grpc_server_handled_total\{.*grpc_method="([^"]+)".*\} (\d+)/.exec(line);
    if (match) counts[match[1]] = (counts[match[1]] ?? 0) + Number(match[2]);
  }
  return counts;
}
function delta(before: Record<string, number>, after: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [method, count] of Object.entries(after)) {
    const sent = count - (before[method] ?? 0);
    if (sent > 0) out[method] = sent;
  }
  return out;
}

/**
 * A TCP proxy in front of the authenticated server that stops forwarding while `hold` is set, so a call waits as it
 * would on a stalled server; it records when Studio's side last sent a frame after the hold began, which is the gRPC
 * cancel of a call whose deadline or signal ended it.
 */
function stallingProxy(): Promise<{
  port: number;
  hold: (on: boolean) => void;
  lastSent: () => number | null;
  close: () => void;
}> {
  let holding = false;
  let heldAt = 0;
  let lastSent: number | null = null;
  const sockets = new Set<Socket>();
  const [host, port] = AUTH_TARGET.split(":");
  const server = createServer((socket) => {
    sockets.add(socket);
    const upstream = createConnection({ host, port: Number(port) });
    sockets.add(upstream);
    socket.on("data", (chunk) => {
      if (holding) {
        lastSent = Date.now() - heldAt;
        return;
      }
      upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      if (!holding) socket.write(chunk);
    });
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: typeof address === "object" && address !== null ? address.port : 0,
        hold: (on) => {
          holding = on;
          heldAt = Date.now();
          lastSent = null;
        },
        lastSent: () => lastSent,
        close: () => {
          for (const socket of sockets) socket.destroy();
          server.close();
        },
      });
    });
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

try {
  mkdirSync(OUT, { recursive: true });
  for (const file of readdirSync(OUT)) if (file.endsWith(".json")) rmSync(posix.join(OUT, file));
  const { registryLease, appLease } = await seedCluster();
  const reader = seed("app", AUTH_TARGET, USERS.app);

  // The forms: one accepted read of each command of the table, metadata only.
  const FORMS: readonly (readonly [string, (answer: Answered) => boolean])[] = [
    ["endpoint status", (a) => a.rows[0]?.version === "3.7.2"],
    ["member list", (a) => a.row_count === 1 && a.rows[0]?.peer_urls === 1 && a.rows[0]?.client_urls === 1],
    ["alarm list", (a) => a.row_count === 0],
    ["auth status", (a) => a.rows[0]?.enabled === true],
    [`lease timetolive ${BigInt(appLease).toString(16).padStart(16, "0")}`, (a) => a.rows[0]?.exists === true],
    [`get ${KEYS.config}`, (a) => a.rows[0]?.exists === true && a.rows[0]?.value_bytes === 20],
    [`get ${KEYS.missing}`, (a) => a.rows[0]?.exists === false],
  ];
  for (const [statement, holds] of FORMS) {
    const { result, acquired } = await mcp(reader, { statement });
    const ok =
      result.isError !== true && holds(answerOf(result)) && !SEEDED.test(JSON.stringify(answerOf(result).rows));
    check(
      ok && acquired.join() === "agent-read-only",
      `form: ${statement} answers metadata only through MCP${ok ? "" : `: ${textOf(result).slice(0, 300)}`}`,
    );
  }
  // The count of every key: no user the proof admits may read every key, so the server refuses it.
  {
    const { result } = await mcp(reader, { statement: 'get "" --prefix --count-only' });
    check(
      result.isError === true && textOf(result).includes(ETCD_AGENT_FAILURE_SENTENCES.refused("permission-denied")),
      "form: the count of every key is refused by the server for a user that may not read every key",
    );
  }

  // The boundary: a write and every refused form, fenced and unfenced, and the writes sent raw.
  const before = await clusterState();
  const REFUSED: readonly (readonly [string, string])[] = [
    ["a put", `put ${KEYS.config} written`],
    ["a delete", `del ${KEYS.config}`],
    ["a prefix delete", "del /app/ --prefix"],
    ["a txn", `txn`],
    ["a lease grant", "lease grant 60"],
    ["a lease revoke", `lease revoke ${BigInt(appLease).toString(16)}`],
    ["a compaction", "compaction 1"],
    ["a defragmentation", "defrag"],
    ["a prefix get", "get /app/ --prefix"],
    ["a keys-only get", `get ${KEYS.config} --keys-only`],
    ["a prefix count", "get /registry/ --prefix --count-only"],
    ["a lease's keys", `lease timetolive ${BigInt(registryLease).toString(16)} --keys`],
    ["a watch", `watch ${KEYS.config}`],
    ["a user list", "user list"],
    ["a role read", "role get mcp_read_app"],
  ];
  for (const [what, statement] of REFUSED) {
    const fenced = await mcp(reader, { statement });
    check(
      fenced.result.isError === true &&
        textOf(fenced.result).startsWith("The command was refused before it reached the cluster (") &&
        fenced.acquired.length === 0,
      `boundary: ${what} is refused by the tool's fence before anything is acquired`,
    );
    const bypassed = await mcp(reader, { statement }, UNFENCED);
    check(
      bypassed.result.isError === true && textOf(bypassed.result).startsWith(NOT_SENT),
      `boundary: ${what}, the fence removed, is refused by the provider's reader before it is sent`,
    );
  }
  const readerToken = await signIn(AUTH_TARGET, USERS.app.user, USERS.app.password);
  const RAW_WRITES: readonly (readonly [string, Service, string, Record<string, unknown>])[] = [
    ["a put", "KV", "Put", { key: bytes(KEYS.config), value: bytes("written") }],
    ["a delete", "KV", "DeleteRange", { key: bytes(KEYS.config) }],
    ["a compaction", "KV", "Compact", { revision: "1" }],
    ["a defragmentation", "Maintenance", "Defragment", {}],
  ];
  for (const [what, service, method, request] of RAW_WRITES) {
    const answer = await unary(AUTH_TARGET, service, method, request, readerToken);
    check(
      answer.outcome === "error" && answer.details === "etcdserver: permission denied",
      `boundary: ${what} sent raw as the /app/ reader is refused: ${answer.outcome === "error" ? answer.details : "admitted"}`,
    );
  }
  {
    const control = await unary(
      AUTH_TARGET,
      "KV",
      "Put",
      { key: bytes("/scratch/control"), value: bytes("x") },
      rootToken,
    );
    check(control.outcome === "ok", "boundary: the positive control, a put as root, is admitted");
    await must(unary(AUTH_TARGET, "KV", "DeleteRange", { key: bytes("/scratch/control") }, rootToken), "control undo");
  }
  {
    // The control's put and delete move the revision; the keys the probes could reach read the same.
    const after = await clusterState();
    check(after === before, "boundary: every key, its revisions and every lease read the same after");
  }

  // The open, through MCP: each principal the proof refuses, refused in the tool's sentence before the command.
  const OPENS: readonly (readonly [string, ManagedConnection, string])[] = [
    ["root", seed("root", AUTH_TARGET, USERS.root), ETCD_PROOF_SENTENCES.rootUser],
    ["a user holding the root role", seed("root-role", AUTH_TARGET, USERS.rootRole), ETCD_PROOF_SENTENCES.rootRole],
    ["a READWRITE range on /app/", seed("readwrite", AUTH_TARGET, USERS.readwrite), ETCD_PROOF_SENTENCES.writer],
    ["READ on every key", seed("all", AUTH_TARGET, USERS.all), ETCD_PROOF_SENTENCES.everyKey],
    [
      "READ on /registry/",
      seed("registry", AUTH_TARGET, USERS.registry),
      ETCD_PROOF_SENTENCES.kubernetes("/registry/"),
    ],
    [
      "READ on one Secret's key",
      seed("secret-key", AUTH_TARGET, USERS.secretKey),
      ETCD_PROOF_SENTENCES.kubernetes("/registry/"),
    ],
    ["READ on /", seed("slash", AUTH_TARGET, USERS.slash), ETCD_PROOF_SENTENCES.kubernetes("/registry/")],
    ["no user", seed("no-user", AUTH_TARGET, undefined), ETCD_PROOF_SENTENCES.noUser],
    ["no user, authentication off", seed("open-no-user", OPEN_TARGET, undefined), ETCD_PROOF_SENTENCES.noUser],
  ];
  for (const [what, connection, sentence] of OPENS) {
    const counted = await handled();
    const { result } = await mcp(connection, { statement: "member list" });
    const sent = delta(counted, await handled());
    check(
      result.isError === true && textOf(result) === openRefusal(sentence) && sent.MemberList === undefined,
      `open: ${what} is refused in the tool's sentence, and no command is sent (${JSON.stringify(sent)})`,
    );
  }
  {
    const { result } = await mcp(seed("open-user", OPEN_TARGET, USERS.app), { statement: "member list" });
    check(
      result.isError === true &&
        textOf(result).includes(
          "Authentication is not enabled on this etcd, so the User and Password would not be used",
        ),
      "open: a user and password on the server with authentication off are refused when the connection opens",
    );
  }
  {
    const appKey = await mcp(seed("app-key", AUTH_TARGET, USERS.appKey), { statement: `get ${KEYS.config}` });
    const appKeyOther = await mcp(seed("app-key", AUTH_TARGET, USERS.appKey), { statement: `get ${KEYS.feature}` });
    check(
      appKey.result.isError !== true &&
        answerOf(appKey.result).rows[0]?.exists === true &&
        appKeyOther.result.isError === true &&
        textOf(appKeyOther.result).includes(ETCD_AGENT_FAILURE_SENTENCES.refused("permission-denied")),
      "open: READ on one key of /app/ is proved, reads that key and is refused its neighbour",
    );
    const none = await mcp(seed("no-roles", AUTH_TARGET, USERS.noRoles), { statement: "endpoint status" });
    const noneKey = await mcp(seed("no-roles", AUTH_TARGET, USERS.noRoles), { statement: `get ${KEYS.config}` });
    check(
      none.result.isError !== true && noneKey.result.isError === true,
      "open: a user with no role is proved, reads the cluster's metadata and is refused every key",
    );
  }
  await clearProviderCache();

  // The data scope: the /app/ reader against a Kubernetes Secret, the leases and the members, through MCP and raw.
  {
    const hit = await mcp(reader, { statement: `get ${KEYS.secret}` });
    const miss = await mcp(reader, { statement: `get ${KEYS.absentSecret}` });
    const hitText = textOf(hit.result);
    check(
      hit.result.isError === true &&
        hitText === textOf(miss.result) &&
        hitText.includes(ETCD_AGENT_FAILURE_SENTENCES.refused("permission-denied")) &&
        !SEEDED.test(hitText.replace(KEYS.secret, "")),
      "scope: the /app/ reader is refused a Secret's key alike whether it exists or not, in Studio's words",
    );
    // etcd refuses a lease read to a user that may not read every key the lease holds, the lease list included.
    const registryHex = BigInt(registryLease).toString(16).padStart(16, "0");
    const refusedRead = ETCD_AGENT_FAILURE_SENTENCES.refused("permission-denied");
    const leases = await mcp(reader, { statement: "lease list" });
    check(
      leases.result.isError === true && textOf(leases.result).includes(refusedRead),
      "scope: the /app/ reader is refused the lease list while a lease holds a /registry/ key, by the server",
    );
    const ttl = await mcp(reader, { statement: `lease timetolive ${registryHex}` });
    // Without its keys, a lease's time to live is answered to any authenticated user: ids and seconds, no key.
    check(
      ttl.result.isError !== true &&
        answerOf(ttl.result).rows[0]?.exists === true &&
        !SEEDED.test(JSON.stringify(answerOf(ttl.result).rows)),
      "scope: it reads that lease's time to live by id, which names no key it holds",
    );
    const members = await mcp(reader, { statement: "member list" });
    check(
      !SEEDED.test(JSON.stringify(answerOf(members.result).rows)),
      "scope: it reads the member list with the addresses counted, never named",
    );
  }
  const RAW: readonly (readonly [string, Service, string, Record<string, unknown>])[] = [
    ["secret-present-reader-app", "KV", "Range", { key: bytes(KEYS.secret), limit: "1" }],
    ["secret-absent-reader-app", "KV", "Range", { key: bytes(KEYS.absentSecret), limit: "1" }],
    ["outside-reader-app", "KV", "Range", { key: bytes(KEYS.outside), limit: "1" }],
    ["lease-list-reader-app", "Lease", "LeaseLeases", {}],
    ["lease-keys-registry-reader-app", "Lease", "LeaseTimeToLive", { ID: registryLease, keys: true }],
    ["member-list-reader-app", "Cluster", "MemberList", { linearizable: true }],
    ["status-reader-app", "Maintenance", "Status", {}],
    ["alarm-list-reader-app", "Maintenance", "Alarm", { action: "GET", memberID: "0", alarm: "NONE" }],
  ];
  for (const [name, service, method, request] of RAW) {
    capture(
      name,
      USERS.app,
      { rpc: `${service}/${method}`, ...request },
      await unary(AUTH_TARGET, service, method, request, readerToken),
    );
  }
  for (const [name, entry] of [
    ["role-read-all", USERS.all],
    ["role-read-registry", USERS.registry],
    ["role-read-secret-key", USERS.secretKey],
    ["role-read-slash", USERS.slash],
    ["role-read-app-key", USERS.appKey],
  ] as const) {
    const token = await signIn(AUTH_TARGET, entry.user, entry.password);
    capture(
      name,
      entry,
      { rpc: "Auth/RoleGet", role: entry.roles[0] },
      await unary(AUTH_TARGET, "Auth", "RoleGet", { role: entry.roles[0] }, token),
    );
  }
  check(true, `scope: ${RAW.length + 5} raw answers written to tests/fixtures/etcd/v3.7.2/mcp-scope/`);
  // With that lease gone, every lease holds keys the reader may read, and the list answers lease ids alone.
  await must(unary(AUTH_TARGET, "Lease", "LeaseRevoke", { ID: registryLease }, rootToken), "revoke registry lease");
  {
    const { result } = await mcp(reader, { statement: "lease list" });
    check(
      result.isError !== true &&
        answerOf(result).row_count === 1 &&
        !SEEDED.test(JSON.stringify(answerOf(result).rows)),
      "form: lease list answers metadata only through MCP once no lease holds a key outside the reader's ranges",
    );
  }

  // The limits: max_rows, the row budget, the timeout and the cancel.
  const granted: string[] = [];
  const grant = async (count: number) => {
    for (let i = 0; i < count; i++) {
      const answer = (await must(
        unary(AUTH_TARGET, "Lease", "LeaseGrant", { TTL: "600", ID: "0" }, rootToken),
        "grant",
      )) as {
        ID: string;
      };
      granted.push(answer.ID);
    }
  };
  await grant(150);
  {
    const cut = await mcp(reader, { statement: "lease list", max_rows: 100 });
    check(
      cut.result.isError !== true &&
        answerOf(cut.result).row_count === 100 &&
        answerOf(cut.result).truncated &&
        (answerOf(cut.result).hint ?? "").includes("this tool does not page with offset"),
      "limits: a lease list past max_rows is cut to it with advice",
    );
  }
  await grant(1_001 - 150);
  {
    const over = await mcp(reader, { statement: "lease list" });
    check(
      over.result.isError === true &&
        textOf(over.result).startsWith("The result has more than 1000 rows, the most this server reads for one call."),
      "limits: 1003 leases are refused past the 1000-row provider budget, never cut",
    );
  }
  for (const id of granted) await unary(AUTH_TARGET, "Lease", "LeaseRevoke", { ID: id }, rootToken);

  const proxy = await stallingProxy();
  try {
    const stalled = seed("stalled", `127.0.0.1:${proxy.port}`, USERS.app);
    check(
      (await mcp(stalled, { statement: "endpoint status" })).result.isError !== true,
      "limits: served while it forwards",
    );
    proxy.hold(true);
    let started = Date.now();
    const timedOut = await mcp(stalled, { statement: "endpoint status", timeout_ms: 500 });
    const answeredIn = Date.now() - started;
    await sleep(300);
    check(
      textOf(timedOut.result) === timeoutText(500) && answeredIn < 1_000,
      `limits: a stalled read at the minimum timeout_ms 500 is answered as the timeout in ${answeredIn} ms`,
    );
    check(
      lastSettledAt !== null && lastSettledAt <= 700,
      `limits: the provider's call ended ${lastSettledAt} ms after it began, at the time left, and sent its last frame ${proxy.lastSent()} ms after the hold`,
    );
    proxy.hold(false);
    await clearProviderCache();
    const cancelled = seed("cancelled", `127.0.0.1:${proxy.port}`, USERS.app);
    check((await mcp(cancelled, { statement: "endpoint status" })).result.isError !== true, "limits: warm again");
    proxy.hold(true);
    const controller = new AbortController();
    started = Date.now();
    const pending = mcp(
      cancelled,
      { statement: "endpoint status", timeout_ms: 3_000 },
      RUN_ETCD_READ,
      controller.signal,
    );
    await sleep(200);
    controller.abort();
    const cancelAnswer = await pending;
    const cancelIn = Date.now() - started;
    const settledAtCancel = lastSettledAt;
    await sleep(3_300);
    check(
      textOf(cancelAnswer.result) === MCP_CANCELLED_TEXT && cancelIn < 1_000,
      `limits: a client cancel at 200 ms is answered as cancelled in ${cancelIn} ms`,
    );
    check(
      settledAtCancel === null && lastSettledAt !== null && lastSettledAt >= 2_500 && lastSettledAt <= 3_500,
      `limits: after the cancel the provider's call stayed open, and ended ${lastSettledAt} ms after it began, at the time left`,
    );
    proxy.hold(false);
  } finally {
    proxy.close();
  }
  await clearProviderCache();

  // The cost: the server's own counters around one call on a held handle, and around the open.
  {
    const cold = await handled();
    await mcp(reader, { statement: "endpoint status" });
    const coldSent = delta(cold, await handled());
    const warm = await handled();
    await mcp(reader, { statement: "endpoint status" });
    const warmSent = delta(warm, await handled());
    check(
      JSON.stringify(warmSent) === JSON.stringify({ AuthStatus: 1, RoleGet: 1, Status: 1, UserGet: 1 }),
      `cost: one call on a held handle sends ${JSON.stringify(warmSent)}: the proof's three reads, one RoleGet per role, then the read`,
    );
    check(true, `cost: the first call also opens the handle: ${JSON.stringify(coldSent)}`);
  }
} finally {
  await clearProviderCache();
  for (const found of clients.values()) found.close();
}

console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
