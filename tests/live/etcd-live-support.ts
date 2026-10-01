/**
 * What the etcd live check (`tests/live/etcd-live-check.ts`) needs besides the provider, kept apart so
 * a scratch reproduction can drive the snapshot and the oracle over captured output without a run,
 * as `tests/live/kafka-snapshot.ts` is kept apart from Kafka's check.
 *
 * Nothing here imports the provider's adapter or `@grpc/grpc-js`: the snapshot reads the servers
 * through `etcdctl` inside their own containers, and the admin writes go through etcd's JSON gateway,
 * so what judges the provider never shares its code (spec E15).
 *
 * No credential is ever placed in an argument list: `etcdctl` reads the root user from an
 * `--env-file` of mode 0600, and the gateway takes the password in a request body.
 */
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/** Every write the live check makes stays under this prefix (spec E15). */
export const SCRATCH_PREFIX = "/libredb-live-check/";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
export const b64 = (value: Uint8Array | string): string =>
  Buffer.from(typeof value === "string" ? bytes(value) : value).toString("base64");
export const fromB64 = (value: string | undefined): Uint8Array => new Uint8Array(Buffer.from(value ?? "", "base64"));

/** Byte order, etcd's own. */
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return a.length - b.length;
}
export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => compareBytes(a, b) === 0;

/** etcd's range convention: no end is the key alone, an end of one 0x00 runs to the end of the key space. */
export interface LiveRange {
  readonly key: Uint8Array;
  readonly rangeEnd?: Uint8Array;
}
export function rangeHolds(range: LiveRange, key: Uint8Array): boolean {
  if (range.rangeEnd === undefined || range.rangeEnd.length === 0) return sameBytes(range.key, key);
  if (compareBytes(key, range.key) < 0) return false;
  if (range.rangeEnd.length === 1 && range.rangeEnd[0] === 0) return true;
  return compareBytes(key, range.rangeEnd) < 0;
}
/** etcd's prefix rule (R06 2.3): the prefix with its last byte below 0xff incremented, else the whole tail. */
export function prefixEnd(prefix: Uint8Array): Uint8Array {
  const end = Uint8Array.from(prefix);
  for (let index = end.length - 1; index >= 0; index--) {
    if (end[index] < 0xff) {
      end[index] += 1;
      return end.slice(0, index + 1);
    }
  }
  return new Uint8Array([0]);
}
export const prefixRange = (prefix: string | Uint8Array): LiveRange => {
  const key = typeof prefix === "string" ? bytes(prefix) : prefix;
  return { key, rangeEnd: prefixEnd(key) };
};

// ============================================================================
// etcdctl inside a fixture's own container
// ============================================================================

export interface EtcdctlTarget {
  readonly container: string;
  /** The endpoint and TLS flags as the container sees itself; never a credential. */
  readonly flags: readonly string[];
  /** A file holding ETCDCTL_USER and ETCDCTL_PASSWORD, mode 0600, or absent where no password is needed. */
  readonly envFile?: string;
}

export function etcdctl(target: EtcdctlTarget, args: readonly string[]): string {
  const env = target.envFile === undefined ? [] : ["--env-file", target.envFile];
  return execFileSync("docker", ["exec", ...env, target.container, "etcdctl", ...target.flags, ...args], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
}

/** Writes the root user's env file for `docker exec --env-file`, readable by this user only. */
export function rootEnvFile(directory: string, password: string): string {
  const file = path.join(directory, "etcdctl-root.env");
  writeFileSync(file, `ETCDCTL_USER=root\nETCDCTL_PASSWORD=${password}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
}

/** etcdctl's JSON with every integer of 15 or more digits quoted, so an id past 2^53 keeps its digits. */
export function parseEtcdctlJson<T>(text: string): T {
  return JSON.parse(text.replace(/:(-?\d{15,})([,}\]])/g, ':"$1"$2')) as T;
}

interface EtcdctlKv {
  readonly key: string;
  readonly value?: string;
  readonly create_revision: number | string;
  readonly mod_revision: number | string;
  readonly version: number | string;
  readonly lease?: number | string;
}

/** Every key of the key space, as etcdctl's JSON gives it (base64 key and value). */
export function readAllKeys(target: EtcdctlTarget): EtcdctlKv[] {
  const answer = parseEtcdctlJson<{ kvs?: EtcdctlKv[] }>(etcdctl(target, ["get", "", "--prefix", "-w", "json"]));
  return answer.kvs ?? [];
}

/**
 * The E15 snapshot: every key outside the scratch prefix with its value, create and mod revisions,
 * version and lease, then every lease with its granted TTL and keys, then (on an auth server) every
 * user and role that is not the check's own. Sorted, so two snapshots compare line for line.
 */
export function snapshot(target: EtcdctlTarget, auth: boolean): string[] {
  const scratch = bytes(SCRATCH_PREFIX);
  const lines: string[] = [];
  for (const kv of readAllKeys(target)) {
    const key = fromB64(kv.key);
    if (key.length >= scratch.length && sameBytes(key.slice(0, scratch.length), scratch)) continue;
    lines.push(
      `kv ${kv.key} ${kv.value ?? ""} c=${kv.create_revision} m=${kv.mod_revision} v=${kv.version} l=${kv.lease ?? 0}`,
    );
  }
  const leases = etcdctl(target, ["lease", "list"])
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{1,16}$/.test(line));
  for (const lease of leases) {
    const answer = etcdctl(target, ["lease", "timetolive", lease, "--keys"]).trim();
    // "lease <id> granted with TTL(<n>s), remaining(<n>s), attached keys([...])": the remaining TTL moves.
    const granted = /granted with TTL\((\d+)s\)/.exec(answer)?.[1] ?? "?";
    // etcd keeps a lease's keys in a Go map, so their order varies from one answer to the next (measured
    // on 3.7.2: the two keys of 694d8147df1dc4c9 swapped between two snapshots); sorted, they compare.
    // A lease with no key reads as [""], which is not the check's own, so it stays in the snapshot.
    const keys = (/attached keys\(\[(.*)\]\)/.exec(answer)?.[1] ?? "").split(" ").sort();
    if (keys.every((key) => key.startsWith(SCRATCH_PREFIX))) continue;
    lines.push(`lease ${lease} granted=${granted} keys=${keys.join(" ")}`);
  }
  if (auth) {
    for (const user of etcdctl(target, ["user", "list"])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)) {
      if (!user.startsWith("libredb-live-"))
        lines.push(`user ${user} ${etcdctl(target, ["user", "get", user]).trim().replace(/\n/g, " ")}`);
    }
    for (const role of etcdctl(target, ["role", "list"])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)) {
      if (!role.startsWith("libredb-live-"))
        lines.push(`role ${role} ${etcdctl(target, ["role", "get", role]).trim().replace(/\n/g, " ")}`);
    }
  }
  return lines.sort();
}

/** The lines whose presence differs, as "- line" and "+ line"; "" when equal. */
export function snapshotDiff(before: readonly string[], after: readonly string[]): string {
  const a = new Set(before);
  const b = new Set(after);
  return [
    ...before.filter((line) => !b.has(line)).map((line) => `- ${line}`),
    ...after.filter((line) => !a.has(line)).map((line) => `+ ${line}`),
  ].join("\n");
}

// ============================================================================
// The gateway, for the check's own admin writes and seeding
// ============================================================================

export interface Gateway {
  readonly origin: string;
  readonly tls?: { readonly ca: string; readonly cert?: string; readonly key?: string };
  token?: string;
  /** Who `token` signs in, kept so a call that meets an expired token signs in once more. */
  credentials?: { readonly name: string; readonly password: string };
}

async function gatewayRequest(
  gateway: Gateway,
  route: string,
  body: unknown,
): Promise<{ readonly status: number; readonly text: string }> {
  // `connection: close`, so no keep-alive socket of this process to the endpoint outlives the call and
  // blurs the socket checks of E3 and E16.
  const headers: Record<string, string> = { "content-type": "application/json", connection: "close" };
  if (gateway.token !== undefined) headers.authorization = gateway.token;
  // Bun's fetch takes `tls` for a private CA and a client certificate; the cast is Bun's extension of RequestInit.
  const init = { method: "POST", headers, body: JSON.stringify(body), tls: gateway.tls } as RequestInit;
  const response = await fetch(`${gateway.origin}${route}`, init);
  return { status: response.status, text: await response.text() };
}

export async function gatewayCall(gateway: Gateway, route: string, body: unknown): Promise<Record<string, unknown>> {
  let answer = await gatewayRequest(gateway, route, body);
  // The fixtures expire a token after 10 seconds of disuse (--auth-token-ttl=10), which a check's own waits
  // pass, so this exact answer signs in once more and resends the call; any other failure is raised.
  if (
    answer.status === 401 &&
    answer.text.includes("etcdserver: invalid auth token") &&
    gateway.credentials !== undefined
  ) {
    await gatewaySignIn(gateway, gateway.credentials.name, gateway.credentials.password);
    answer = await gatewayRequest(gateway, route, body);
  }
  if (answer.status < 200 || answer.status > 299)
    throw new Error(`gateway ${route} answered HTTP ${answer.status}: ${answer.text.slice(0, 300)}`);
  return answer.text === "" ? {} : (JSON.parse(answer.text) as Record<string, unknown>);
}

export async function gatewaySignIn(gateway: Gateway, name: string, password: string): Promise<void> {
  gateway.token = undefined;
  const answer = await gatewayRequest(gateway, "/v3/auth/authenticate", { name, password });
  if (answer.status !== 200)
    throw new Error(`gateway /v3/auth/authenticate answered HTTP ${answer.status}: ${answer.text.slice(0, 300)}`);
  gateway.token = String((JSON.parse(answer.text) as Record<string, unknown>).token);
  gateway.credentials = { name, password };
}

export async function gatewayPut(
  gateway: Gateway,
  key: Uint8Array | string,
  value: Uint8Array | string,
): Promise<void> {
  await gatewayCall(gateway, "/v3/kv/put", { key: b64(key), value: b64(value) });
}

/**
 * Puts in Txns of `batch` requests: at most 128, etcd's default --max-txn-ops, and small enough that one
 * Txn stays under etcd's default --max-request-bytes of 1.5 MiB (16 values of 64 KiB, 64 of 16 KiB).
 */
export async function gatewayPutMany(
  gateway: Gateway,
  pairs: ReadonlyArray<readonly [string | Uint8Array, string | Uint8Array]>,
  batch = 128,
): Promise<void> {
  for (let start = 0; start < pairs.length; start += batch) {
    const success = pairs
      .slice(start, start + batch)
      .map(([key, value]) => ({ requestPut: { key: b64(key), value: b64(value) } }));
    // oxlint-disable-next-line no-await-in-loop -- one Txn at a time, so the batches land in order and each stays within etcd's request limits.
    await gatewayCall(gateway, "/v3/kv/txn", { success });
  }
}

export async function gatewayDeletePrefix(gateway: Gateway, prefix: string): Promise<void> {
  const range = prefixRange(prefix);
  await gatewayCall(gateway, "/v3/kv/deleterange", {
    key: b64(range.key),
    range_end: b64(range.rangeEnd ?? new Uint8Array()),
  });
}

export async function gatewayGet(gateway: Gateway, key: Uint8Array | string): Promise<Uint8Array | undefined> {
  const answer = await gatewayCall(gateway, "/v3/kv/range", { key: b64(key) });
  const kvs = answer.kvs as Array<{ value?: string }> | undefined;
  return kvs?.[0] === undefined ? undefined : fromB64(kvs[0].value);
}

export type LivePermission = {
  readonly type: "READ" | "WRITE" | "READWRITE";
  readonly key: Uint8Array;
  readonly rangeEnd?: Uint8Array;
};

export async function gatewayRoleWith(
  gateway: Gateway,
  role: string,
  permissions: readonly LivePermission[],
): Promise<void> {
  await gatewayCall(gateway, "/v3/auth/role/add", { name: role });
  for (const permission of permissions) {
    const perm: Record<string, string> = { permType: permission.type, key: b64(permission.key) };
    if (permission.rangeEnd !== undefined) perm.range_end = b64(permission.rangeEnd);
    // oxlint-disable-next-line no-await-in-loop -- each grant is a request of its own, sent in order once the role exists.
    await gatewayCall(gateway, "/v3/auth/role/grant", { name: role, perm });
  }
}

export async function gatewayUserWith(
  gateway: Gateway,
  user: string,
  password: string,
  roles: readonly string[],
): Promise<void> {
  await gatewayCall(gateway, "/v3/auth/user/add", { name: user, password });
  // oxlint-disable-next-line no-await-in-loop -- each role is granted in order, once the user exists.
  for (const role of roles) await gatewayCall(gateway, "/v3/auth/user/grant", { user, role });
}

/**
 * Removes the check's own users and roles. Only etcd's answer that one is absent passes (a setup that
 * stopped part way); any other failure is raised, so a user the check made is never left behind unseen.
 */
export async function gatewayRemove(
  gateway: Gateway,
  users: readonly string[],
  roles: readonly string[],
): Promise<void> {
  const absent = (error: unknown) => {
    if (!(error instanceof Error && /etcdserver: (?:user|role) name not found/.test(error.message))) throw error;
  };
  // oxlint-disable-next-line no-await-in-loop -- one removal at a time, so a failure names the user or role it met.
  for (const user of users) await gatewayCall(gateway, "/v3/auth/user/delete", { name: user }).catch(absent);
  // oxlint-disable-next-line no-await-in-loop -- one removal at a time, so a failure names the user or role it met.
  for (const role of roles) await gatewayCall(gateway, "/v3/auth/role/delete", { role }).catch(absent);
}

// ============================================================================
// Sockets: a forwarder in a child process, and this process's established peers
// ============================================================================

const FORWARDER = `
const net = require("node:net");
let accepted = 0;
const server = net.createServer((client) => {
  accepted++;
  const upstream = net.connect(Number(process.env.FWD_PORT), process.env.FWD_HOST);
  client.pipe(upstream); upstream.pipe(client);
  const end = () => { client.destroy(); upstream.destroy(); };
  client.on("error", end); upstream.on("error", end); client.on("close", end); upstream.on("close", end);
});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: server.address().port }) + "\\n"));
process.stdin.on("data", () => process.stdout.write(JSON.stringify({ accepted }) + "\\n"));
`;

export interface Forwarder {
  readonly port: number;
  /** How many connections it has accepted so far. */
  accepted(): Promise<number>;
  close(): void;
}

/** A TCP forwarder to host:port in a child process, so its upstream sockets are never this process's. */
export async function startForwarder(host: string, port: number): Promise<Forwarder> {
  const child = spawn(process.execPath, ["-e", FORWARDER], {
    env: { ...process.env, FWD_HOST: host, FWD_PORT: String(port) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf8");
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const waiter = waiters.shift();
      if (waiter) waiter(line);
      else lines.push(line);
    }
  });
  const next = () =>
    new Promise<string>((resolve) => (lines.length > 0 ? resolve(lines.shift() as string) : waiters.push(resolve)));
  const listening = JSON.parse(await next()) as { port: number };
  return {
    port: listening.port,
    async accepted() {
      child.stdin.write("report\n");
      return (JSON.parse(await next()) as { accepted: number }).accepted;
    },
    close() {
      child.stdin.end();
      child.kill("SIGTERM");
    },
  };
}

/** The peers ("host:port") of this process's established TCP sockets, from `ss -tnpH`. */
export function establishedPeers(pid: number = process.pid): string[] {
  const out = execFileSync("ss", ["-tnpH", "state", "established"], { encoding: "utf8" });
  return out
    .split("\n")
    .filter((line) => line.includes(`pid=${pid},`))
    .map((line) => line.trim().split(/\s+/)[3] ?? "")
    .filter(Boolean);
}

export function readCertificateDirectory(directory: string): Record<string, string> {
  const names = [
    "ca.pem",
    "root.crt",
    "root.key",
    "reader.crt",
    "reader.key",
    "cert-only.crt",
    "cert-only.key",
    "other-ca-root.crt",
    "other-ca-root.key",
    "gateway-client.crt",
    "gateway-client.key",
    "root.password",
    "reader.password",
  ];
  return Object.fromEntries(names.map((name) => [name, readFileSync(path.join(directory, name), "utf8").trim()]));
}
