/**
 * Seeds the two servers a v3.7.2/agent-boundary/run.sh started, sends the agent boundary plan as every principal the
 * agent read-only profile may meet, and writes what each server answered into that run.sh's directory.
 *
 *   bun tests/live/etcd-agent-boundary.ts
 *
 * The environment carries ETCD_AUTH_TARGET (host:port of a server this script turns authentication on for),
 * ETCD_OPEN_TARGET (host:port of a server left with authentication off), ETCD_IMAGE (the image with its digest) and
 * ETCD_OUT (the directory to write). Every user's password is generated here for the run, and every token stays in this
 * process. A capture records a principal's name and its roles' permissions, never a password or a token, and the script
 * refuses to write a file that holds any form of either. It drives grpc-js directly over the vendored descriptor and
 * sends every request raw: no Studio check stands in front of it, which is the point, since what is measured is what
 * the server does on its own.
 *
 * Run by hand through run.sh, never by `bun run test`, which runs no file under tests/live/.
 */
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: a capture records what the server holds then.
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import { fromJSON } from "@grpc/proto-loader";
import { ETCD_DESCRIPTOR } from "@/lib/db/providers/keyvalue/etcd/proto/descriptor";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const AUTH_TARGET = env("ETCD_AUTH_TARGET");
const OPEN_TARGET = env("ETCD_OPEN_TARGET");
const IMAGE = env("ETCD_IMAGE");
const OUT = env("ETCD_OUT");
const DATE = new Date().toISOString().slice(0, 10);

/** Every form of every password and token the run sent or received; none may appear in a written capture. */
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

const definition = fromJSON(ETCD_DESCRIPTOR as Parameters<typeof fromJSON>[0], {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a generic client built from the descriptor at run time.
const pkg = grpc.loadPackageDefinition(definition).etcdserverpb as any;

type Service = "KV" | "Lease" | "Cluster" | "Maintenance" | "Auth" | "Watch";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- a generic client built from the descriptor at run time.
type AnyClient = any;

const clients = new Map<string, AnyClient>();

function client(target: string, service: Service): AnyClient {
  const id = `${target} ${service}`;
  let found = clients.get(id);
  if (found === undefined) {
    found = new pkg[service](target, grpc.credentials.createInsecure());
    clients.set(id, found);
  }
  return found;
}

/** One answer as a capture records it: its outcome, and the answer or the gRPC status. */
type Answer =
  | { readonly outcome: "ok"; readonly answer: unknown }
  | { readonly outcome: "error"; readonly code: number; readonly details: string };

/** A principal on the authenticated server: its user, its password, and the token it signed in with. */
interface Principal {
  readonly user: string;
  readonly password: string;
  readonly roles: readonly string[];
  token?: string;
}

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

function metadataFor(token: string | undefined): grpc.Metadata {
  const metadata = new grpc.Metadata();
  if (token !== undefined) metadata.set("token", token);
  return metadata;
}

/** One unary call, answered as a capture records it. */
function unary(target: string, service: Service, method: string, request: unknown, token?: string): Promise<Answer> {
  const deadline = new Date(Date.now() + 5_000);
  return new Promise((resolve) => {
    client(target, service)[method](
      request,
      metadataFor(token),
      { deadline },
      (error: grpc.ServiceError | null, answer: unknown) => {
        if (error) resolve({ outcome: "error", code: error.code, details: error.details });
        else resolve({ outcome: "ok", answer: show(answer) });
      },
    );
  });
}

/** One watch: the create request, the first answer or the stream's error, then a cancel. */
function watchOnce(target: string, key: string, token?: string): Promise<Answer> {
  return new Promise((resolve) => {
    const call = client(target, "Watch").Watch(metadataFor(token));
    const timer = setTimeout(() => {
      call.cancel();
      resolve({ outcome: "error", code: -1, details: "no answer within 3 s" });
    }, 3_000);
    call.on("data", (answer: unknown) => {
      clearTimeout(timer);
      call.cancel();
      resolve({ outcome: "ok", answer: show(answer) });
    });
    call.on("error", (error: grpc.ServiceError) => {
      clearTimeout(timer);
      if (error.code !== grpc.status.CANCELLED) resolve({ outcome: "error", code: error.code, details: error.details });
    });
    call.write({ create_request: { key: Buffer.from(key), start_revision: "0" } });
  });
}

/** One snapshot: the first chunk's size, never its bytes, or the stream's error, then a cancel. */
function snapshotOnce(target: string, token?: string): Promise<Answer> {
  return new Promise((resolve) => {
    const call = client(target, "Maintenance").Snapshot({}, metadataFor(token));
    call.on("data", (chunk: { blob?: Uint8Array; remaining_bytes?: string }) => {
      call.cancel();
      resolve({ outcome: "ok", answer: { firstChunkBytes: chunk.blob?.length ?? 0 } });
    });
    call.on("error", (error: grpc.ServiceError) => {
      if (error.code !== grpc.status.CANCELLED) resolve({ outcome: "error", code: error.code, details: error.details });
    });
  });
}

/** The whole key space as one byte range: from the 0x00 key to the end. */
const ALL = { key: Buffer.from([0]), range_end: Buffer.from([0]) };

const KEYS = {
  config: "/app/config",
  feature: "/app/feature",
  leased: "/app/session",
  missing: "/app/missing",
  outside: "/other/credential",
  scratch: "/scratch/",
} as const;

/** The seed, put as root before authentication is on. Fixture values only. */
const SEED: ReadonlyArray<readonly [string, string]> = [
  [KEYS.config, "fixture-config-value"],
  [KEYS.feature, "fixture-feature-flag"],
  [KEYS.outside, "fixture-outside-value"],
];

function prefixEnd(prefix: string): Buffer {
  const bytes = Buffer.from(prefix);
  bytes[bytes.length - 1] += 1;
  return bytes;
}

/** The roles and the permissions each holds; a principal's capture names them. */
const ROLES: Readonly<
  Record<string, ReadonlyArray<{ type: "READ" | "WRITE" | "READWRITE"; key: Buffer; end: Buffer }>>
> = {
  agent_read_all: [{ type: "READ", key: ALL.key, end: ALL.range_end }],
  agent_read_app: [{ type: "READ", key: Buffer.from("/app/"), end: prefixEnd("/app/") }],
  agent_readwrite_scratch: [
    { type: "READ", key: Buffer.from("/app/"), end: prefixEnd("/app/") },
    { type: "READWRITE", key: Buffer.from(KEYS.scratch), end: prefixEnd(KEYS.scratch) },
  ],
  agent_write_scratch: [
    { type: "READ", key: Buffer.from("/app/"), end: prefixEnd("/app/") },
    { type: "WRITE", key: Buffer.from(KEYS.scratch), end: prefixEnd(KEYS.scratch) },
  ],
  agent_midrun: [{ type: "READ", key: Buffer.from("/app/"), end: prefixEnd("/app/") }],
};

const PRINCIPALS: Readonly<Record<string, Principal>> = {
  root: { user: "root", password: password(), roles: ["root"] },
  "root-role": { user: "agent_root_role", password: password(), roles: ["root"] },
  "reader-all": { user: "agent_reader_all", password: password(), roles: ["agent_read_all"] },
  "reader-range": { user: "agent_reader_range", password: password(), roles: ["agent_read_app"] },
  "readwrite-range": { user: "agent_readwrite_range", password: password(), roles: ["agent_readwrite_scratch"] },
  "write-range": { user: "agent_write_range", password: password(), roles: ["agent_write_scratch"] },
  "no-roles": { user: "agent_no_roles", password: password(), roles: [] },
  midrun: { user: "agent_midrun", password: password(), roles: ["agent_midrun"] },
};

/** Writes one capture, refusing one that holds any form of a password or token of the run. */
function write(name: string, captured: Record<string, unknown>, body: Record<string, unknown>): void {
  const text = `${JSON.stringify(
    { $captured: { image: IMAGE, version: "3.7.2", date: DATE, runtime: `bun ${Bun.version}`, ...captured }, ...body },
    null,
    2,
  )}\n`;
  for (const secret of SECRETS) {
    if (text.includes(secret)) throw new Error(`The capture ${name} holds a password or token of the run; not written`);
  }
  writeFileSync(path.join(OUT, `${name}.json`), text);
}

async function must(answer: Promise<Answer>, what: string): Promise<unknown> {
  const settled = await answer;
  if (settled.outcome !== "ok") throw new Error(`${what} failed: ${settled.details}`);
  return settled.answer;
}

async function signIn(target: string, principal: Principal): Promise<void> {
  const deadline = new Date(Date.now() + 5_000);
  const token = await new Promise<string>((resolve, reject) => {
    client(target, "Auth").Authenticate(
      { name: principal.user, password: principal.password },
      { deadline },
      (error: grpc.ServiceError | null, answer: { token: string }) => (error ? reject(error) : resolve(answer.token)),
    );
  });
  remember(token);
  principal.token = token;
}

/** What the server holds, read as root (or with no token where authentication is off), before and after the probes. */
async function state(target: string, token?: string): Promise<Record<string, unknown>> {
  const keys = (await must(
    unary(target, "KV", "Range", { ...ALL, keys_only: true, limit: "0" }, token),
    "key list",
  )) as { kvs: Array<{ key: unknown; mod_revision: unknown }>; header: { revision: unknown } };
  const leases = await must(unary(target, "Lease", "LeaseLeases", {}, token), "lease list");
  const auth = await must(unary(target, "Auth", "AuthStatus", {}, token), "auth status");
  return {
    revision: keys.header.revision,
    keys: keys.kvs.map((kv) => ({ key: kv.key, modRevision: kv.mod_revision })),
    leases: (leases as { leases: unknown[] }).leases,
    auth,
  };
}

/** The reads the agent's table and its proof would send, each with what the server answered. */
async function reads(
  target: string,
  self: string | undefined,
  roles: readonly string[],
  lease: string,
  token?: string,
): Promise<Record<string, Answer>> {
  const out: Record<string, Answer> = {
    authStatus: await unary(target, "Auth", "AuthStatus", {}, token),
  };
  if (self !== undefined) {
    out.userGetSelf = await unary(target, "Auth", "UserGet", { name: self }, token);
    out.userGetRoot = await unary(target, "Auth", "UserGet", { name: "root" }, token);
    for (const role of roles) out[`roleGet:${role}`] = await unary(target, "Auth", "RoleGet", { role }, token);
    out["roleGet:agent_read_all(not held)"] = roles.includes("agent_read_all")
      ? { outcome: "ok", answer: "held" }
      : await unary(target, "Auth", "RoleGet", { role: "agent_read_all" }, token);
    out.userList = await unary(target, "Auth", "UserList", {}, token);
    out.roleList = await unary(target, "Auth", "RoleList", {}, token);
  }
  out.status = await unary(target, "Maintenance", "Status", {}, token);
  out.memberListLinearizable = await unary(target, "Cluster", "MemberList", { linearizable: true }, token);
  out.memberListSerializable = await unary(target, "Cluster", "MemberList", { linearizable: false }, token);
  out.alarmGet = await unary(target, "Maintenance", "Alarm", { action: "GET", memberID: "0", alarm: "NONE" }, token);
  out.leaseLeases = await unary(target, "Lease", "LeaseLeases", {}, token);
  out.leaseTimeToLive = await unary(target, "Lease", "LeaseTimeToLive", { ID: lease, keys: false }, token);
  out.leaseTimeToLiveKeys = await unary(target, "Lease", "LeaseTimeToLive", { ID: lease, keys: true }, token);
  out.rangeKey = await unary(target, "KV", "Range", { key: Buffer.from(KEYS.config), limit: "1" }, token);
  out.rangeKeyLeased = await unary(target, "KV", "Range", { key: Buffer.from(KEYS.leased), limit: "1" }, token);
  out.rangeKeyMissing = await unary(target, "KV", "Range", { key: Buffer.from(KEYS.missing), limit: "1" }, token);
  out.rangeKeyOutside = await unary(target, "KV", "Range", { key: Buffer.from(KEYS.outside), limit: "1" }, token);
  out.rangeCountAll = await unary(target, "KV", "Range", { ...ALL, count_only: true, limit: "1" }, token);
  out.rangeCountApp = await unary(
    target,
    "KV",
    "Range",
    { key: Buffer.from("/app/"), range_end: prefixEnd("/app/"), count_only: true, limit: "1" },
    token,
  );
  out.rangeKeysOnlyAll = await unary(target, "KV", "Range", { ...ALL, keys_only: true, limit: "10" }, token);
  out.rangeSerializableKey = await unary(
    target,
    "KV",
    "Range",
    { key: Buffer.from(KEYS.config), limit: "1", serializable: true },
    token,
  );
  out.txnReadOnly = await unary(
    target,
    "KV",
    "Txn",
    { compare: [], success: [{ request_range: { key: Buffer.from(KEYS.config), limit: "1" } }], failure: [] },
    token,
  );
  out.watchKey = await watchOnce(target, KEYS.config, token);
  return out;
}

/** The write probes, each against a name that exists nowhere unless the probe's own text says otherwise. */
async function probes(target: string, nonce: string, token?: string): Promise<Record<string, Answer>> {
  const probeKey = Buffer.from(`/libredb-agent-probe/${nonce}`);
  const scratchKey = Buffer.from(`${KEYS.scratch}${nonce}`);
  const out: Record<string, Answer> = {};
  out.put = await unary(target, "KV", "Put", { key: probeKey, value: Buffer.from("x") }, token);
  out.putInScratchRange = await unary(target, "KV", "Put", { key: scratchKey, value: Buffer.from("x") }, token);
  out.deleteRange = await unary(target, "KV", "DeleteRange", { key: probeKey }, token);
  out.deleteRangeInScratchRange = await unary(target, "KV", "DeleteRange", { key: scratchKey }, token);
  out.txnPut = await unary(
    target,
    "KV",
    "Txn",
    { compare: [], success: [{ request_put: { key: probeKey, value: Buffer.from("x") } }], failure: [] },
    token,
  );
  out.txnDeleteProbe = await unary(
    target,
    "KV",
    "Txn",
    { compare: [], success: [{ request_delete_range: { key: probeKey } }], failure: [] },
    token,
  );
  out.compactRevisionOne = await unary(target, "KV", "Compact", { revision: "1", physical: false }, token);
  const grant = await unary(target, "Lease", "LeaseGrant", { TTL: "5", ID: "0" }, token);
  out.leaseGrant = grant;
  if (grant.outcome === "ok") {
    // Revoked at once, so the next principal's state reads no lease of a probe.
    const id = (grant.answer as { ID: string }).ID;
    out.leaseRevokeGranted = await unary(target, "Lease", "LeaseRevoke", { ID: id }, token);
  }
  out.leaseRevokeUnknown = await unary(target, "Lease", "LeaseRevoke", { ID: "7" }, token);
  out.alarmDeactivateNone = await unary(
    target,
    "Maintenance",
    "Alarm",
    { action: "DEACTIVATE", memberID: "1", alarm: "NOSPACE" },
    token,
  );
  out.defragment = await unary(target, "Maintenance", "Defragment", {}, token);
  out.hashKV = await unary(target, "Maintenance", "HashKV", { revision: "0" }, token);
  out.snapshot = await snapshotOnce(target, token);
  out.memberRemoveUnknown = await unary(target, "Cluster", "MemberRemove", { ID: "1" }, token);
  out.userAdd = await unary(
    target,
    "Auth",
    "UserAdd",
    { name: `agent_probe_${nonce}`, options: { no_password: true } },
    token,
  );
  if (out.userAdd.outcome === "ok") {
    out.userDeleteAdded = await unary(target, "Auth", "UserDelete", { name: `agent_probe_${nonce}` }, token);
  }
  out.roleRevokeUnknown = await unary(
    target,
    "Auth",
    "RoleRevokePermission",
    { role: `agent_probe_${nonce}`, key: probeKey },
    token,
  );
  return out;
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  for (const file of readdirSync(OUT)) if (file.endsWith(".json")) rmSync(path.join(OUT, file));

  // The server with authentication off: seeded, read and probed with no token.
  for (const [key, value] of SEED) {
    await must(unary(OPEN_TARGET, "KV", "Put", { key: Buffer.from(key), value: Buffer.from(value) }), "seed");
  }
  const openLease = (await must(unary(OPEN_TARGET, "Lease", "LeaseGrant", { TTL: "3600", ID: "0" }), "lease")) as {
    ID: string;
  };
  await must(
    unary(OPEN_TARGET, "KV", "Put", {
      key: Buffer.from(KEYS.leased),
      value: Buffer.from("fixture-session"),
      lease: openLease.ID,
    }),
    "leased seed",
  );
  {
    const before = await state(OPEN_TARGET);
    const answered = await reads(OPEN_TARGET, undefined, [], openLease.ID);
    const probed = await probes(OPEN_TARGET, randomBytes(4).toString("hex"));
    const after = await state(OPEN_TARGET);
    write(
      "auth-off",
      { principal: "none", surface: "authentication off: every request is answered with no token" },
      { reads: answered, probes: probed, stateBefore: before, stateAfter: after },
    );
  }

  // The server with authentication on: users, roles and the seed made before AuthEnable, with no token.
  for (const [key, value] of SEED) {
    await must(unary(AUTH_TARGET, "KV", "Put", { key: Buffer.from(key), value: Buffer.from(value) }), "seed");
  }
  const lease = (await must(unary(AUTH_TARGET, "Lease", "LeaseGrant", { TTL: "3600", ID: "0" }), "lease")) as {
    ID: string;
  };
  await must(
    unary(AUTH_TARGET, "KV", "Put", {
      key: Buffer.from(KEYS.leased),
      value: Buffer.from("fixture-session"),
      lease: lease.ID,
    }),
    "leased seed",
  );
  for (const [role, permissions] of Object.entries(ROLES)) {
    await must(unary(AUTH_TARGET, "Auth", "RoleAdd", { name: role }), `role ${role}`);
    for (const permission of permissions) {
      await must(
        unary(AUTH_TARGET, "Auth", "RoleGrantPermission", {
          name: role,
          perm: { permType: permission.type, key: permission.key, range_end: permission.end },
        }),
        `grant on ${role}`,
      );
    }
  }
  for (const principal of Object.values(PRINCIPALS)) {
    await must(
      unary(AUTH_TARGET, "Auth", "UserAdd", {
        name: principal.user,
        password: principal.password,
        options: { no_password: false },
      }),
      `user ${principal.user}`,
    );
    for (const role of principal.roles) {
      await must(unary(AUTH_TARGET, "Auth", "UserGrantRole", { user: principal.user, role }), `grant ${role}`);
    }
  }
  await must(unary(AUTH_TARGET, "Auth", "AuthEnable", {}), "auth enable");
  for (const principal of Object.values(PRINCIPALS)) await signIn(AUTH_TARGET, principal);
  const rootToken = PRINCIPALS.root.token;

  const noToken = await reads(AUTH_TARGET, undefined, [], lease.ID);
  write(
    "auth-on-no-token",
    { principal: "none", surface: "authentication on: requests sent with no token" },
    { reads: noToken },
  );

  for (const [name, principal] of Object.entries(PRINCIPALS)) {
    if (name === "midrun") continue;
    const before = await state(AUTH_TARGET, rootToken);
    const answered = await reads(AUTH_TARGET, principal.user, principal.roles, lease.ID, principal.token);
    const probed = await probes(AUTH_TARGET, randomBytes(4).toString("hex"), principal.token);
    const after = await state(AUTH_TARGET, rootToken);
    write(
      name,
      {
        principal: principal.user,
        roles: principal.roles.map((role) => ({
          role,
          permissions: (ROLES[role] ?? []).map((permission) => ({
            type: permission.type,
            key: show(permission.key),
            rangeEnd: show(permission.end),
          })),
        })),
      },
      { reads: answered, probes: probed, stateBefore: before, stateAfter: after },
    );
  }

  // A grant made during the run: the user's roles read READ only, then root grants the role WRITE on the scratch
  // range, and the same token reads the role again and writes there.
  const midrun = PRINCIPALS.midrun;
  const nonce = randomBytes(4).toString("hex");
  const roleBefore = await unary(AUTH_TARGET, "Auth", "RoleGet", { role: "agent_midrun" }, midrun.token);
  const putBefore = await unary(
    AUTH_TARGET,
    "KV",
    "Put",
    { key: Buffer.from(`${KEYS.scratch}${nonce}`), value: Buffer.from("x") },
    midrun.token,
  );
  const grant = await unary(
    AUTH_TARGET,
    "Auth",
    "RoleGrantPermission",
    {
      name: "agent_midrun",
      perm: { permType: "WRITE", key: Buffer.from(KEYS.scratch), range_end: prefixEnd(KEYS.scratch) },
    },
    rootToken,
  );
  const authAfterGrant = await unary(AUTH_TARGET, "Auth", "AuthStatus", {}, midrun.token);
  const roleAfter = await unary(AUTH_TARGET, "Auth", "RoleGet", { role: "agent_midrun" }, midrun.token);
  const putAfter = await unary(
    AUTH_TARGET,
    "KV",
    "Put",
    { key: Buffer.from(`${KEYS.scratch}${nonce}`), value: Buffer.from("x") },
    midrun.token,
  );
  const cleanup = await unary(
    AUTH_TARGET,
    "KV",
    "DeleteRange",
    { key: Buffer.from(KEYS.scratch), range_end: prefixEnd(KEYS.scratch) },
    rootToken,
  );
  write(
    "midrun",
    { principal: midrun.user, roles: ["agent_midrun"], grantedMidRun: "WRITE on the /scratch/ prefix" },
    { roleBefore, putBefore, grantAsRoot: grant, authStatusAfterGrant: authAfterGrant, roleAfter, putAfter, cleanup },
  );

  for (const found of clients.values()) found.close();
}

await main();
