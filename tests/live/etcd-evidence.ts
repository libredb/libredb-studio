/**
 * Gate 4's evidence harness for the etcd provider (spec E11, E15, 5.6, 6.1, KE6, gate 4).
 *
 * It drives @grpc/grpc-js against the live services of docker/etcd/README.md, with the definition the
 * descriptor generator's loadEtcdDescriptor() builds, never an import of proto/descriptor.ts, and writes every
 * capture of tests/fixtures/etcd/README.md's catalog as tests/fixtures/etcd/<service>/<name>.json. Each capture
 * calls one surface and records a pass or the verbatim failure. The data captures run under Bun; the error
 * captures, every row of spec 5.6 and each step of spec 6.1's connect sequence, run under Bun and again in a
 * Node child process, and a capture whose two answers differ, or whose row always differs (the TLS rows, the
 * refused socket and the deadlines, whose texts carry elapsed times), is written twice, as <name>.bun.json and
 * <name>.node.json.
 *
 * E15: before and after the whole run it snapshots each server's key space outside SCRATCH (keys, values,
 * create revisions and leases), and the protected subtree and compact_rev_key with their mod revisions and
 * versions, and fails when a snapshot changed. Every key it writes is under SCRATCH, which scratch() holds.
 *
 * Run by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/):
 *   bun tests/live/etcd-evidence.ts --certs <dir> --report <file>     capture every service
 *   bun tests/live/etcd-evidence.ts --only <name,...> --certs <dir> --report <file> --out <dir>
 *                                                                        capture named stand-alone rows only
 *   bun tests/live/etcd-evidence.ts --phase <phase> [--only <name,...>] --certs <dir> --report <file> --out <dir>
 *                                                                        capture one phase alone, with its setup
 *   bun tests/live/etcd-evidence.ts --readme --report <file>           render tests/fixtures/etcd/README.md
 *   node tests/live/etcd-evidence.ts --child <name,...> --context <file>  spawned by the capture run
 * <dir> is a copy of the auth fixtures' certificate volume, `docker cp libredb-etcd-auth:/certs <dir>`, outside
 * the repository. No password, token, private key or certificate is written into a capture: a field named
 * password or token is written as "<password>" or "<token>", and every file is checked before it is written.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import { fromJSON, type MethodDefinition } from "@grpc/proto-loader";
import protobuf from "protobufjs";
import { loadEtcdDescriptor } from "../../scripts/generate-etcd-descriptor.mjs";

type Service = "etcd" | "etcd-cluster" | "etcd-auth" | "etcd-auth-password" | "transport";
type Server = Exclude<Service, "transport">;

const ROOT = path.resolve(import.meta.dirname, "../..");
const FIXTURES = path.join(ROOT, "tests/fixtures/etcd");
const SERVICES: readonly Service[] = ["etcd", "etcd-cluster", "etcd-auth", "etcd-auth-password", "transport"];
/** Every key this harness writes is under it (spec E15). */
const SCRATCH = "/libredb-evidence/";
/** The one lease id this harness grants and revokes, past 2^53 like the seeded ones. */
const SCRATCH_LEASE = "7587863092875085100";
/** A lease id nobody grants, for the answers to an unknown lease. */
const NEVER_GRANTED_LEASE = "7587863092875085199";
/** Spec E8's protected prefixes and key, as the E15 snapshot records them in full. */
const PROTECTED_PREFIXES = ["/registry/", "/kubernetes.io/", "/openshift.io/", "/bootstrap/", "/k3s/"].flatMap(
  (prefix) => [prefix, prefix.slice(1)],
);
const PROTECTED_KEY = "compact_rev_key";
const CONTAINERS: Readonly<Record<Server, string>> = {
  etcd: "libredb-etcd",
  "etcd-cluster": "libredb-etcd-cluster-1",
  "etcd-auth": "libredb-etcd-auth",
  "etcd-auth-password": "libredb-etcd-auth-password",
};
const INT64_TYPES = new Set(["int64", "uint64", "sint64", "fixed64", "sfixed64"]);
/** The length from which bytes that are one repeated value are written as { $filled }. */
const FILLED_FROM = 65536;
/** How often the auth revision row sends reads beside a grant before it gives up, and how many reads each time. */
const AUTH_RACE_ATTEMPTS = 80;
const AUTH_RACE_READS = 16;
const IS_BUN = typeof Bun !== "undefined";
const RUNTIME = IS_BUN ? `bun ${Bun.version}` : `node ${process.versions.node}`;
const THIS_FILE = fileURLToPath(import.meta.url);

// The definition the adapter reads (plan C5's ETCD_LOADER_OPTIONS), and the same descriptor's types, which
// say which fields are bytes and which are 64-bit integers when a message is written into a capture.
const DESCRIPTOR = loadEtcdDescriptor();
const DEFINITION = fromJSON(DESCRIPTOR as Parameters<typeof fromJSON>[0], {
  keepCase: true,
  longs: String,
  enums: String,
  defaults: true,
  oneofs: true,
});
const TYPES = protobuf.Root.fromJSON(DESCRIPTOR as protobuf.INamespace);
TYPES.resolveAll();

interface Method {
  readonly definition: MethodDefinition<object, object>;
  readonly request: protobuf.Type;
  readonly response: protobuf.Type;
}

function method(rpc: string): Method {
  const [serviceName, methodName] = rpc.split("/");
  const service = DEFINITION[`etcdserverpb.${serviceName}`] as Record<string, MethodDefinition<object, object>>;
  const definition = service?.[methodName];
  const described = TYPES.lookupService(`etcdserverpb.${serviceName}`).methods[methodName];
  if (definition === undefined || described?.resolvedRequestType == null || described.resolvedResponseType == null) {
    throw new Error(`etcd's API has no ${rpc}`);
  }
  return {
    definition,
    request: described.resolvedRequestType,
    response: described.resolvedResponseType,
  };
}

// -- what the capture run shares with its Node child ----------------------------------------------------------

interface Context {
  readonly certsDir: string;
  readonly closedPort: number;
  readonly images: Readonly<Record<string, { readonly image: string; readonly digest: string }>>;
  /** The member each endpoint answers as, by "host:port", read with Status at the start of the run. */
  readonly members: Readonly<Record<string, { readonly clusterId: string; readonly memberId: string }>>;
}

let context: Context = { certsDir: "", closedPort: 0, images: {}, members: {} };

/** Every password read and every token received, none of which may appear in a written capture. */
const SECRETS = new Set<string>();

function certificate(file: string): Buffer {
  return readFileSync(path.join(context.certsDir, file));
}

function password(user: "root" | "reader"): string {
  const value = readFileSync(path.join(context.certsDir, `${user}.password`), "utf8").trim();
  SECRETS.add(value);
  return value;
}

// -- channels and calls ---------------------------------------------------------------------------------------

interface Conn {
  readonly service: Service;
  readonly host: string;
  readonly port: number;
  /** File names under the certificate directory; `cert` names the pair `<cert>.crt` and `<cert>.key`. */
  readonly tls?: {
    readonly ca?: string;
    readonly cert?: string;
    readonly serverName: string;
  };
  readonly receiveCap?: number;
  /** A channel of its own, closed after its one call, for a row about a channel's first connection. */
  readonly fresh?: true;
}

const PLAIN: Conn = { service: "etcd", host: "127.0.0.1", port: 2379 };
const member = (n: 1 | 2 | 3): Conn => ({
  service: "etcd-cluster",
  host: `127.0.0.${n + 1}`,
  port: 2379,
});
// The certificate names localhost, so every TLS channel dials 127.0.0.1 and checks the name localhost: an IP
// as the TLS server name is refused by Bun and by Node 25 and later (spec 3.2, E5).
const auth = (cert: string | undefined, ca = "ca.pem", serverName = "localhost"): Conn => ({
  service: "etcd-auth",
  host: "127.0.0.1",
  port: 12379,
  tls: { ca, cert, serverName },
});
const passwordServer = (cert?: string): Conn => ({
  service: "etcd-auth-password",
  host: "127.0.0.1",
  port: 12479,
  tls: { ca: "ca.pem", cert, serverName: "localhost" },
});

const clients = new Map<string, grpc.Client>();

function endpointOf(conn: Conn): string {
  return `${conn.host}:${conn.port}`;
}

function clientFor(conn: Conn): grpc.Client {
  const key = JSON.stringify(conn);
  const cached = conn.fresh ? undefined : clients.get(key);
  if (cached !== undefined) return cached;
  const credentials =
    conn.tls === undefined
      ? grpc.credentials.createInsecure()
      : grpc.credentials.createSsl(
          conn.tls.ca === undefined ? null : certificate(conn.tls.ca),
          conn.tls.cert === undefined ? null : certificate(`${conn.tls.cert}.key`),
          conn.tls.cert === undefined ? null : certificate(`${conn.tls.cert}.crt`),
        );
  // As the adapter will: no service config from DNS (spec E4), and the receive cap where a row sets one.
  const options: grpc.ChannelOptions = {
    "grpc.service_config_disable_resolution": 1,
  };
  if (conn.tls !== undefined) options["grpc.ssl_target_name_override"] = conn.tls.serverName;
  if (conn.receiveCap !== undefined) options["grpc.max_receive_message_length"] = conn.receiveCap;
  const client = new grpc.Client(`dns:${endpointOf(conn)}`, credentials, options);
  if (!conn.fresh) clients.set(key, client);
  return client;
}

function closeClients(): void {
  for (const client of clients.values()) client.close();
  clients.clear();
}

interface Call {
  /** The `hasleader: true` metadata, which the adapter sends on every call but spec 6.1's exemptions. */
  readonly hasleader?: boolean;
  readonly token?: string;
  readonly deadlineMs?: number;
  /** Cancel the call right after it starts, as cancelQuery does. */
  readonly cancelAtStart?: boolean;
}

type Fields = Record<string, unknown>;
type Settled = { readonly ok: true; readonly value: Fields } | { readonly ok: false; readonly error: unknown };

function metadataFor(call: Call): grpc.Metadata {
  const metadata = new grpc.Metadata();
  if (call.hasleader) metadata.set("hasleader", "true");
  if (call.token !== undefined) metadata.set("token", call.token);
  return metadata;
}

function recordedMetadata(call: Call): Record<string, string> {
  const metadata: Record<string, string> = {};
  if (call.hasleader) metadata.hasleader = "true";
  if (call.token !== undefined) metadata.token = "<token>";
  return metadata;
}

function unaryCall(conn: Conn, rpc: string, request: object, call: Call = {}): Promise<Settled> {
  const { definition } = method(rpc);
  const client = clientFor(conn);
  return new Promise<Settled>((resolve) => {
    const pending = client.makeUnaryRequest(
      definition.path,
      definition.requestSerialize,
      definition.responseDeserialize,
      request,
      metadataFor(call),
      { deadline: Date.now() + (call.deadlineMs ?? 5000) },
      (error, value) => {
        if (conn.fresh) client.close();
        resolve(error ? { ok: false, error } : { ok: true, value: value as Fields });
      },
    );
    if (call.cancelAtStart) pending.cancel();
  });
}

/** A call the harness needs to succeed, for its own setup: a failure stops the run. */
async function must(conn: Conn, rpc: string, request: object, call: Call = {}): Promise<Fields> {
  const settled = await unaryCall(conn, rpc, request, call);
  if (!settled.ok) throw new Error(`${rpc} on ${endpointOf(conn)} failed: ${(settled.error as Error).message}`);
  return settled.value;
}

type StreamEnd = "open" | "server-end" | { readonly error: unknown };

interface StreamCall extends Call {
  /** True once the messages so far are the answer; the harness then cancels the stream. */
  readonly until: (messages: readonly Fields[]) => boolean;
  readonly maxWaitMs: number;
  /** Run once, when the first message arrives (a watch's created answer). */
  readonly onFirst?: () => Promise<void>;
}

function streamCall(
  conn: Conn,
  rpc: string,
  first: object,
  call: StreamCall,
): Promise<{ readonly messages: Fields[]; readonly end: StreamEnd }> {
  const { definition } = method(rpc);
  const client = clientFor(conn);
  return new Promise((resolve, reject) => {
    const stream = client.makeBidiStreamRequest(
      definition.path,
      definition.requestSerialize,
      definition.responseDeserialize,
      metadataFor(call),
      {},
    );
    const messages: Fields[] = [];
    let settled = false;
    const finish = (end: StreamEnd, failure?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Every end cancels the stream: a half-close never ends an etcd watch (spec 5.3, E16).
      stream.cancel();
      if (conn.fresh) client.close();
      if (failure === undefined) resolve({ messages, end });
      else reject(failure);
    };
    const timer = setTimeout(() => finish("open"), call.maxWaitMs);
    stream.on("data", (message: Fields) => {
      messages.push(message);
      if (messages.length === 1 && call.onFirst !== undefined) {
        call.onFirst().catch((error: unknown) => finish("open", error));
      }
      if (call.until(messages)) finish("open");
    });
    stream.on("end", () => finish("server-end"));
    stream.on("error", (error: unknown) => finish({ error }));
    stream.write(first);
  });
}

// -- bytes, requests and the writes E15 allows ----------------------------------------------------------------

const text = (value: string): Buffer => Buffer.from(value, "utf8");
const ZERO = Buffer.from([0]);

/** etcd's prefix rule (R06 2.3): the prefix with its last byte below 0xff incremented. */
function prefixEnd(prefix: Buffer): Buffer {
  const end = Buffer.from(prefix);
  for (let index = end.length - 1; index >= 0; index -= 1) {
    if (end[index] < 0xff) {
      end[index] += 1;
      return end.subarray(0, index + 1);
    }
  }
  return Buffer.from(ZERO);
}

function prefix(value: string): {
  readonly key: Buffer;
  readonly range_end: Buffer;
} {
  return { key: text(value), range_end: prefixEnd(text(value)) };
}

/** A key this harness may write: under SCRATCH, or the run stops (spec E15). */
function scratch(key: string): Buffer {
  if (!key.startsWith(SCRATCH)) throw new Error(`${key} is outside the scratch prefix ${SCRATCH}`);
  return text(key);
}

const putOp = (key: string, value: Buffer) => ({
  request_put: { key: scratch(key), value },
});
const deleteOp = (key: string) => ({
  request_delete_range: { key: scratch(key) },
});
const rangeOp = (key: Buffer) => ({ request_range: { key, limit: "1" } });
const modIs = (key: Buffer, revision: string) => ({
  result: "EQUAL",
  target: "MOD",
  key,
  mod_revision: revision,
});

async function scratchPut(conn: Conn, key: string, value: string, call: Call = {}): Promise<Fields> {
  return must(
    conn,
    "KV/Txn",
    { compare: [], success: [putOp(key, text(value))], failure: [] },
    { ...call, hasleader: true },
  );
}

async function scratchDelete(conn: Conn, key: string, call: Call = {}): Promise<Fields> {
  return must(conn, "KV/Txn", { compare: [], success: [deleteOp(key)], failure: [] }, { ...call, hasleader: true });
}

function header(value: Fields): Fields {
  return value.header as Fields;
}

async function currentRevision(conn: Conn, call: Call = {}): Promise<string> {
  const answer = await must(conn, "KV/Range", { key: text("/app/cfg"), limit: "1" }, { ...call, hasleader: true });
  return String(header(answer).revision);
}

async function createRevisionOf(conn: Conn, key: string): Promise<string> {
  const answer = await must(conn, "KV/Range", { key: text(key), limit: "1" }, { hasleader: true });
  const [kv] = answer.kvs as Fields[];
  if (kv === undefined) throw new Error(`${key} is not seeded on ${endpointOf(conn)}`);
  return String(kv.create_revision);
}

async function signIn(user: "root" | "reader"): Promise<string> {
  const answer = await must(
    passwordServer(),
    "Auth/Authenticate",
    { name: user, password: password(user) },
    {
      hasleader: true,
    },
  );
  const token = String(answer.token);
  SECRETS.add(token);
  return token;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function docker(...args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

/** Runs `run` with a container paused, and always unpauses it. */
async function whilePaused<T>(container: string, run: () => Promise<T>): Promise<T> {
  docker("pause", container);
  try {
    return await run();
  } finally {
    docker("unpause", container);
  }
}

/**
 * A local forwarder that, once armed, passes the client's next request on, drops every answer, and closes the
 * client's socket 300 ms later: a request that left the client and whose answer never came back (spec 5.6's
 * "Connection dropped").
 */
async function dropForwarder(target: Conn): Promise<{ port: number; arm: () => void; close: () => Promise<void> }> {
  let armed = false;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const upstream = net.connect(target.port, target.host);
    sockets.add(client);
    sockets.add(upstream);
    client.on("data", (chunk) => {
      upstream.write(chunk);
      if (armed) setTimeout(() => client.destroy(), 300);
    });
    upstream.on("data", (chunk) => {
      if (!armed) client.write(chunk);
    });
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.on("error", () => undefined);
    upstream.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  return {
    port,
    arm: () => {
      armed = true;
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

// -- writing a message into a capture -------------------------------------------------------------------------

/**
 * Bytes as a capture holds them: base64, or, for a run of one repeated byte at or past FILLED_FROM, that byte and
 * the length, so the 1,600,000 and 2,200,000 bytes the size rows send are not megabytes of base64 in the repository.
 */
function encodeBytes(value: Uint8Array): unknown {
  if (value.length >= FILLED_FROM && value.every((byte) => byte === value[0])) {
    return { $filled: { byte: value[0], length: value.length } };
  }
  return { $bytes: Buffer.from(value).toString("base64") };
}

function encodeValue(field: protobuf.Field | undefined, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (field !== undefined && INT64_TYPES.has(field.type)) return { $int64: String(value) };
  if (value instanceof Uint8Array) return encodeBytes(value);
  if (field?.resolvedType instanceof protobuf.Type) return encodeMessage(field.resolvedType, value);
  if (Array.isArray(value)) return value.map((item) => encodeValue(undefined, item));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(undefined, item)]));
  }
  return value;
}

/** A message as a capture holds it: 64-bit integers as { $int64 }, bytes as { $bytes } or { $filled }, secrets replaced. */
function encodeMessage(type: protobuf.Type, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  const encoded: Fields = {};
  for (const [key, item] of Object.entries(value as Fields)) {
    if (key === "password") encoded[key] = "<password>";
    else if (key === "token") encoded[key] = "<token>";
    else {
      const field = type.fields[key];
      encoded[key] =
        field?.repeated && Array.isArray(item)
          ? item.map((element) => encodeValue(field, element))
          : encodeValue(field, item);
    }
  }
  return encoded;
}

/** A failure as the reader revives it: a gRPC status keeps its code and details, a runtime error its code. */
function encodeFailure(error: unknown): Fields {
  if (!(error instanceof Error)) throw new Error(`A failure that is not an Error: ${String(error)}`);
  const { code, details } = error as Error & {
    code?: unknown;
    details?: unknown;
  };
  const encoded: Fields = {
    class: error.constructor.name,
    message: error.message,
    code,
  };
  if (typeof code === "number") encoded.details = details;
  return encoded;
}

// -- one capture ----------------------------------------------------------------------------------------------

interface Measured {
  readonly service: Service;
  readonly rpc: string;
  readonly request: unknown;
  readonly match: unknown;
  readonly metadata: Readonly<Record<string, string>>;
  readonly outcome: "pass" | "fail";
  readonly payload: unknown;
  readonly clusterId: string;
  readonly memberId: string;
  readonly date: string;
  readonly runtime: string;
}

type ExpectedText = string | { readonly bun: string; readonly node: string };

interface Capture {
  /** "<directory>/<file stem>", as tests/helpers/etcd-fixtures.ts names it. */
  readonly name: string;
  readonly surface: string;
  readonly expect: "pass" | "fail";
  /** Text the answer must carry: a failure's details, or a watch's cancel_reason; one per runtime where they differ. */
  readonly text?: ExpectedText;
  readonly runtimes: "bun" | "both";
  /** Always written once per runtime (spec E5's TLS and socket rows, and the deadlines). */
  readonly split?: true;
  readonly run: () => Promise<Measured>;
}

interface Measure extends Call {
  readonly match: object;
  /** No member answered: a connection that never carried a gRPC answer. */
  readonly noAnswer?: true;
}

function answeredBy(conn: Conn, answerHeader: unknown, noAnswer: boolean): { clusterId: string; memberId: string } {
  if (noAnswer || conn.service === "transport") return { clusterId: "none", memberId: "none" };
  const fields = answerHeader as Fields | null | undefined;
  if (fields && typeof fields.member_id === "string" && fields.member_id !== "0") {
    return { clusterId: String(fields.cluster_id), memberId: fields.member_id };
  }
  const known = context.members[endpointOf(conn)];
  if (known === undefined) throw new Error(`No member identity was read for ${endpointOf(conn)}`);
  return known;
}

/** The last unary answer `unary` received, decoded, for a row whose next row reads its revision. */
let lastAnswer: Fields | undefined;

function lastRevision(): string {
  if (lastAnswer === undefined) throw new Error("The row before this one did not answer");
  return String(header(lastAnswer).revision);
}

async function unary(conn: Conn, rpc: string, request: object, options: Measure): Promise<Measured> {
  const types = method(rpc);
  const settled = await unaryCall(conn, rpc, request, options);
  lastAnswer = settled.ok ? settled.value : undefined;
  return {
    service: conn.service,
    rpc,
    request: encodeMessage(types.request, request),
    match: encodeMessage(types.request, options.match),
    metadata: recordedMetadata(options),
    outcome: settled.ok ? "pass" : "fail",
    payload: settled.ok ? encodeMessage(types.response, settled.value) : encodeFailure(settled.error),
    ...answeredBy(conn, settled.ok ? settled.value.header : undefined, options.noAnswer === true),
    date: new Date().toISOString(),
    runtime: RUNTIME,
  };
}

async function stream(conn: Conn, rpc: string, first: object, options: StreamCall & Measure): Promise<Measured> {
  const types = method(rpc);
  const { messages, end } = await streamCall(conn, rpc, first, options);
  return {
    service: conn.service,
    rpc,
    request: encodeMessage(types.request, first),
    match: encodeMessage(types.request, options.match),
    metadata: recordedMetadata(options),
    outcome: typeof end === "object" ? "fail" : "pass",
    payload: {
      messages: messages.map((message) => encodeMessage(types.response, message)),
      end: typeof end === "object" ? { error: encodeFailure(end.error) } : end,
    },
    ...answeredBy(conn, messages[0]?.header, options.noAnswer === true),
    date: new Date().toISOString(),
    runtime: RUNTIME,
  };
}

const eventsIn = (messages: readonly Fields[]) =>
  messages.reduce((count, message) => count + (message.events as unknown[]).length, 0);
const cancelled = (messages: readonly Fields[]) => messages.some((message) => message.canceled === true);

// -- the catalog, service by service, in the order the rows must run -------------------------------------------

interface Phase {
  readonly name: string;
  readonly setup?: () => Promise<void>;
  readonly captures: readonly Capture[];
  readonly teardown?: () => Promise<void>;
}

interface RowOptions {
  readonly expect?: "pass" | "fail";
  readonly text?: ExpectedText;
  readonly runtimes?: "bun" | "both";
  readonly split?: true;
}

/** A data row: a pass, captured under Bun. */
function row(name: string, surface: string, run: () => Promise<Measured>, options: RowOptions = {}): Capture {
  return {
    name,
    surface,
    run,
    expect: options.expect ?? "pass",
    runtimes: options.runtimes ?? "bun",
    ...(options.text === undefined ? {} : { text: options.text }),
    ...(options.split === undefined ? {} : { split: options.split }),
  };
}

/** An error row of spec 5.6 or a connect-sequence step of 6.1: a failure, captured under Bun and Node (KE6). */
function errorRow(
  name: string,
  surface: string,
  text: ExpectedText | undefined,
  run: () => Promise<Measured>,
  split?: true,
) {
  return row(name, surface, run, {
    expect: "fail",
    runtimes: "both",
    text,
    split,
  });
}

/** Every row that changes a server for the rows after it, as the fixtures README records it. */
const moved: string[] = [];

/** What a row found that its outcome and text cannot say, reported with the mismatches. */
const findings: string[] = [];

/** What undoes a phase's setup when the run stops before the phase that undoes it: the NOSPACE alarm. */
const restores: Array<() => Promise<void>> = [];

const readKey = (conn: Conn, key: string, call: Call = { hasleader: true }) =>
  unary(conn, "KV/Range", { key: text(key), limit: "1" }, { ...call, match: { key: text(key) } });

const readPrefix = (conn: Conn, value: string, call: Call = { hasleader: true }) =>
  unary(conn, "KV/Range", { ...prefix(value), limit: "500" }, { ...call, match: prefix(value) });

function etcdPhases(): Phase[] {
  const p = PLAIN;
  const edit = `${SCRATCH}edit`;
  const typed = `${SCRATCH}typed`;
  const history = `${SCRATCH}history`;
  let historyCreated = "";
  let createdMod = "";
  let updatedMod = "";
  const chained = (value: string, what: string) => {
    if (value === "") throw new Error(`${what} runs only after the row before it, in the whole run`);
    return value;
  };
  return [
    {
      name: "etcd reads",
      captures: [
        row("etcd/range-key", "range: the key /app/cfg", () => readKey(p, "/app/cfg")),
        row("etcd/range-missing", "range: the key /no/such/key, which does not exist", () =>
          readKey(p, "/no/such/key"),
        ),
        row("etcd/range-prefix-app", "range: the prefix /app/, limit 500", () => readPrefix(p, "/app/")),
        row("etcd/range-prefix-app-limit-2", "range: the prefix /app/, limit 2, cut by its limit", () =>
          unary(
            p,
            "KV/Range",
            { ...prefix("/app/"), limit: "2" },
            { hasleader: true, match: { ...prefix("/app/"), limit: "2" } },
          ),
        ),
        row(
          "etcd/range-prefix-values",
          "range: the prefix /values/: the values of spec 4.4 and a key that is not UTF-8",
          () => readPrefix(p, "/values/"),
        ),
        row("etcd/range-prefix-registry", "range: the prefix /registry/: the Kubernetes-shaped subtree of spec 9", () =>
          readPrefix(p, "/registry/"),
        ),
        row("etcd/range-prefix-registry-slashless", "range: the prefix registry/: the slash-less secrets root", () =>
          readPrefix(p, "registry/"),
        ),
        row("etcd/range-prefix-tenant-a", "range: the prefix /tenant-a/: the custom-prefix stand-in of spec 9", () =>
          readPrefix(p, "/tenant-a/"),
        ),
        row("etcd/range-compact-rev-key", "range: the key compact_rev_key", () => readKey(p, PROTECTED_KEY)),
        row("etcd/range-serializable", "range: the key /app/cfg, serializable, without hasleader", () =>
          unary(
            p,
            "KV/Range",
            { key: text("/app/cfg"), limit: "1", serializable: true },
            {
              match: { key: text("/app/cfg"), serializable: true },
            },
          ),
        ),
        row("etcd/range-keys-only-all", "range: the whole key space, keys only, limit 500", () =>
          unary(
            p,
            "KV/Range",
            { key: ZERO, range_end: ZERO, limit: "500", keys_only: true },
            {
              hasleader: true,
              match: { key: ZERO, range_end: ZERO, keys_only: true },
            },
          ),
        ),
        row(
          "etcd/range-keys-only-from",
          "range: from /config/ to the end, keys only, limit 5: a page from a cursor",
          () =>
            unary(
              p,
              "KV/Range",
              {
                key: text("/config/"),
                range_end: ZERO,
                limit: "5",
                keys_only: true,
              },
              {
                hasleader: true,
                match: {
                  key: text("/config/"),
                  range_end: ZERO,
                  keys_only: true,
                },
              },
            ),
        ),
        row("etcd/range-count-only-all", "range: the whole key space, count only", () =>
          unary(
            p,
            "KV/Range",
            { key: ZERO, range_end: ZERO, limit: "1", count_only: true },
            {
              hasleader: true,
              match: { key: ZERO, range_end: ZERO, count_only: true },
            },
          ),
        ),
        row("etcd/range-count-only-prefix", "range: the prefix /registry/, count only", () =>
          unary(
            p,
            "KV/Range",
            { ...prefix("/registry/"), limit: "1", count_only: true },
            {
              hasleader: true,
              match: { ...prefix("/registry/"), count_only: true },
            },
          ),
        ),
        row("etcd/range-health", "range: the key health, as etcdctl endpoint health reads it", () =>
          readKey(p, "health"),
        ),
        row("etcd/member-list", "memberList: linearizable", () =>
          unary(p, "Cluster/MemberList", { linearizable: true }, { hasleader: true, match: { linearizable: true } }),
        ),
        row("etcd/member-list-serializable", "memberList: serializable, without hasleader", () =>
          unary(p, "Cluster/MemberList", { linearizable: false }, { match: { linearizable: false } }),
        ),
        row("etcd/status", "status, without hasleader", () => unary(p, "Maintenance/Status", {}, { match: {} })),
        row("etcd/alarm-list-none", "alarmList: Alarm GET, no alarm raised", () =>
          unary(p, "Maintenance/Alarm", { action: "GET" }, { hasleader: true, match: { action: "GET" } }),
        ),
        row("etcd/auth-status-off", "authStatus: RBAC off", () =>
          unary(p, "Auth/AuthStatus", {}, { hasleader: true, match: {} }),
        ),
        row("etcd/lease-leases", "leaseLeases: the two seeded leases, without hasleader", () =>
          unary(p, "Lease/LeaseLeases", {}, { match: {} }),
        ),
        row(
          "etcd/lease-time-to-live-keys",
          "leaseTimeToLive with keys: lease 694d8147df1dc4c9, holding a protected key",
          () =>
            unary(
              p,
              "Lease/LeaseTimeToLive",
              { ID: "7587863092875085001", keys: true },
              {
                hasleader: true,
                match: { ID: "7587863092875085001", keys: true },
              },
            ),
        ),
        row(
          "etcd/lease-time-to-live-unknown",
          `leaseTimeToLive with keys: lease ${NEVER_GRANTED_LEASE}, never granted`,
          () =>
            unary(
              p,
              "Lease/LeaseTimeToLive",
              { ID: NEVER_GRANTED_LEASE, keys: true },
              {
                hasleader: true,
                match: { ID: NEVER_GRANTED_LEASE },
              },
            ),
        ),
      ],
    },
    {
      name: "etcd writes, every one under the scratch prefix",
      // The history the two history rows read is the harness's own, three versions of one scratch key, and not
      // the seeded /history/counter: a run compacts this server, so the seeded history is there only until the
      // first run, and a second run would capture the compaction in its place.
      setup: async () => {
        historyCreated = String(header(await scratchPut(p, history, "1")).revision);
        await scratchPut(p, history, "2");
        await scratchPut(p, history, "3");
      },
      captures: [
        row(
          "etcd/range-history-rev",
          `range: ${history} at its create revision, the first of its three versions`,
          async () => {
            const revision = chained(historyCreated, "etcd/range-history-rev");
            const measured = await unary(
              p,
              "KV/Range",
              { key: scratch(history), limit: "1", revision },
              { hasleader: true, match: { key: scratch(history), revision } },
            );
            const [kv] = (lastAnswer?.kvs ?? []) as Fields[];
            if (kv === undefined || (kv.value as Buffer).toString() !== "1" || String(kv.version) !== "1") {
              findings.push("etcd/range-history-rev: the read at the create revision did not answer the first version");
            }
            return measured;
          },
        ),
        row(
          "etcd/txn-read-targets",
          "txn: E8's read of three single-key targets, read-only, the last one absent",
          () => {
            const keys = [text("/app/cfg"), text("/tenant-a/configmaps/default/cm"), scratch(`${SCRATCH}absent`)];
            return unary(
              p,
              "KV/Txn",
              { compare: [], success: keys.map(rangeOp), failure: [] },
              {
                hasleader: true,
                match: {
                  success: keys.map((key) => ({ request_range: { key } })),
                },
              },
            );
          },
        ),
        row(
          "etcd/txn-guarded-create",
          `txn: E8's guarded put of the absent ${edit}, mod = 0, a range of it on failure`,
          async () => {
            const measured = await unary(
              p,
              "KV/Txn",
              {
                compare: [modIs(scratch(edit), "0")],
                success: [putOp(edit, text('{"v":1}'))],
                failure: [rangeOp(scratch(edit))],
              },
              {
                hasleader: true,
                match: {
                  compare: [{ key: scratch(edit), mod_revision: "0" }],
                  success: [{ request_put: { value: text('{"v":1}') } }],
                },
              },
            );
            createdMod = lastRevision();
            return measured;
          },
        ),
        row(
          "etcd/txn-guarded-put",
          `txn: E8's guarded put of ${edit} at the mod revision the create answered`,
          async () => {
            const mod = chained(createdMod, "etcd/txn-guarded-put");
            const measured = await unary(
              p,
              "KV/Txn",
              {
                compare: [modIs(scratch(edit), mod)],
                success: [putOp(edit, text('{"v":2}'))],
                failure: [rangeOp(scratch(edit))],
              },
              {
                hasleader: true,
                match: {
                  compare: [{ key: scratch(edit), mod_revision: mod }],
                  success: [{ request_put: { value: text('{"v":2}') } }],
                },
              },
            );
            updatedMod = lastRevision();
            return measured;
          },
        ),
        row(
          "etcd/txn-guarded-put-conflict",
          `txn: E8's guarded put of ${edit} at a mod revision it has moved past`,
          () => {
            const stale = chained(createdMod, "etcd/txn-guarded-put-conflict");
            return unary(
              p,
              "KV/Txn",
              {
                compare: [modIs(scratch(edit), stale)],
                success: [putOp(edit, text('{"v":3}'))],
                failure: [rangeOp(scratch(edit))],
              },
              {
                hasleader: true,
                match: {
                  compare: [{ key: scratch(edit), mod_revision: stale }],
                  success: [{ request_put: { value: text('{"v":3}') } }],
                },
              },
            );
          },
        ),
        row("etcd/txn-guarded-delete", `txn: E8's guarded delete of ${edit} at its current mod revision`, () => {
          const mod = chained(updatedMod, "etcd/txn-guarded-delete");
          return unary(
            p,
            "KV/Txn",
            {
              compare: [modIs(scratch(edit), mod)],
              success: [deleteOp(edit)],
              failure: [rangeOp(scratch(edit))],
            },
            {
              hasleader: true,
              match: {
                compare: [{ key: scratch(edit), mod_revision: mod }],
                success: [{ request_delete_range: { key: scratch(edit) } }],
              },
            },
          );
        }),
        row(
          "etcd/txn-typed",
          `txn: typed as mod("${typed}") = "0", then put ${typed} "a\\nb", a blank line, then get ${typed}`,
          () =>
            unary(
              p,
              "KV/Txn",
              {
                compare: [modIs(scratch(typed), "0")],
                success: [putOp(typed, text("a\nb"))],
                failure: [rangeOp(scratch(typed))],
              },
              {
                hasleader: true,
                match: { compare: [{ key: scratch(typed) }] },
              },
            ),
        ),
        row("etcd/lease-grant", `leaseGrant: TTL 60, id ${SCRATCH_LEASE}`, () =>
          unary(p, "Lease/LeaseGrant", { TTL: "60", ID: SCRATCH_LEASE }, { hasleader: true, match: { TTL: "60" } }),
        ),
        row("etcd/lease-keep-alive", `leaseKeepAliveOnce: lease ${SCRATCH_LEASE}, one exchange`, () =>
          stream(
            p,
            "Lease/LeaseKeepAlive",
            { ID: SCRATCH_LEASE },
            {
              hasleader: true,
              until: (messages) => messages.length >= 1,
              maxWaitMs: 5000,
              match: { ID: SCRATCH_LEASE },
            },
          ),
        ),
        row("etcd/lease-revoke", `leaseRevoke: lease ${SCRATCH_LEASE}`, () =>
          unary(p, "Lease/LeaseRevoke", { ID: SCRATCH_LEASE }, { hasleader: true, match: { ID: SCRATCH_LEASE } }),
        ),
        row("etcd/lease-keep-alive-expired", `leaseKeepAliveOnce: lease ${SCRATCH_LEASE} after its revoke, TTL 0`, () =>
          stream(
            p,
            "Lease/LeaseKeepAlive",
            { ID: SCRATCH_LEASE },
            {
              hasleader: true,
              until: (messages) => messages.length >= 1,
              maxWaitMs: 5000,
              match: { ID: SCRATCH_LEASE },
            },
          ),
        ),
        row("etcd/watch-prefix", `watch: the prefix ${SCRATCH}watch/ with prev_kv, over two puts and a delete`, () => {
          const key = `${SCRATCH}watch/a`;
          return stream(
            p,
            "Watch/Watch",
            {
              create_request: {
                ...prefix(`${SCRATCH}watch/`),
                prev_kv: true,
                fragment: true,
              },
            },
            {
              hasleader: true,
              onFirst: async () => {
                await scratchPut(p, key, "1");
                await scratchPut(p, key, "2");
                await scratchDelete(p, key);
              },
              until: (messages) => eventsIn(messages) >= 3,
              maxWaitMs: 10000,
              match: { create_request: prefix(`${SCRATCH}watch/`) },
            },
          );
        }),
        row("etcd/watch-history", `watch: ${history} from its create revision, its three versions`, async () => {
          const start_revision = chained(historyCreated, "etcd/watch-history");
          const measured = await stream(
            p,
            "Watch/Watch",
            { create_request: { key: scratch(history), start_revision, fragment: true } },
            {
              hasleader: true,
              until: (messages) => eventsIn(messages) >= 3,
              maxWaitMs: 10000,
              match: { create_request: { key: scratch(history), start_revision } },
            },
          );
          const { messages } = measured.payload as { messages: Fields[] };
          if (eventsIn(messages) !== 3 || cancelled(messages)) {
            findings.push("etcd/watch-history: the watch did not answer the three versions");
          }
          return measured;
        }),
        row("etcd/watch-quiet", "watch: the prefix /app/ for one second in which nothing changes", () =>
          stream(
            p,
            "Watch/Watch",
            { create_request: { ...prefix("/app/"), fragment: true } },
            {
              hasleader: true,
              until: () => false,
              maxWaitMs: 1000,
              match: { create_request: prefix("/app/") },
            },
          ),
        ),
        row(
          "etcd/delete-range-prefix",
          `deleteRange: the scratch prefix ${SCRATCH}, after two puts under it`,
          async () => {
            await scratchPut(p, `${SCRATCH}del/a`, "1");
            await scratchPut(p, `${SCRATCH}del/b`, "2");
            return unary(
              p,
              "KV/DeleteRange",
              { key: scratch(SCRATCH), range_end: prefixEnd(text(SCRATCH)) },
              {
                hasleader: true,
                match: {
                  key: text(SCRATCH),
                  range_end: prefixEnd(text(SCRATCH)),
                },
              },
            );
          },
        ),
      ],
    },
    {
      name: "etcd errors",
      captures: [
        errorRow(
          "etcd/error-range-future-revision",
          "range: /app/cfg at the current revision plus 1000",
          "future revision",
          async () => {
            const revision = (BigInt(await currentRevision(p)) + BigInt("1000")).toString();
            return unary(
              p,
              "KV/Range",
              { key: text("/app/cfg"), limit: "1", revision },
              {
                hasleader: true,
                match: { key: text("/app/cfg"), revision },
              },
            );
          },
        ),
        errorRow(
          "etcd/error-txn-request-too-large",
          "txn: one put of 1,600,000 bytes, past --max-request-bytes",
          "request is too large",
          () =>
            unary(
              p,
              "KV/Txn",
              {
                compare: [],
                success: [putOp(`${SCRATCH}big`, Buffer.alloc(1600000, 0x78))],
                failure: [],
              },
              {
                hasleader: true,
                match: {
                  success: [{ request_put: { key: scratch(`${SCRATCH}big`) } }],
                },
              },
            ),
        ),
        errorRow(
          "etcd/error-server-receive-cap",
          "txn: one put of 2,200,000 bytes, past the server's receive cap",
          "grpc: received message larger than max",
          () =>
            unary(
              p,
              "KV/Txn",
              {
                compare: [],
                success: [putOp(`${SCRATCH}huge`, Buffer.alloc(2200000, 0x78))],
                failure: [],
              },
              {
                hasleader: true,
                match: {
                  success: [{ request_put: { key: scratch(`${SCRATCH}huge`) } }],
                },
              },
            ),
        ),
        errorRow(
          "etcd/error-client-receive-cap",
          "range: /values/large (300,000 bytes) over a channel whose receive cap is 65,536 bytes",
          "Received message larger than max",
          () =>
            unary(
              { ...PLAIN, receiveCap: 65536, fresh: true },
              "KV/Range",
              { key: text("/values/large"), limit: "1" },
              {
                hasleader: true,
                match: { key: text("/values/large") },
                noAnswer: true,
              },
            ),
        ),
        errorRow(
          "etcd/error-txn-too-many-ops",
          "txn: 129 puts, past --max-txn-ops",
          "too many operations in txn request",
          () =>
            unary(
              p,
              "KV/Txn",
              {
                compare: [],
                success: Array.from({ length: 129 }, (_, index) => putOp(`${SCRATCH}many/${index}`, text("x"))),
                failure: [],
              },
              {
                hasleader: true,
                match: {
                  success: Array.from({ length: 129 }, (_, index) => ({
                    request_put: { key: scratch(`${SCRATCH}many/${index}`) },
                  })),
                },
              },
            ),
        ),
        errorRow("etcd/error-txn-duplicate-key", "txn: two puts of one key", "duplicate key given in txn request", () =>
          unary(
            p,
            "KV/Txn",
            {
              compare: [],
              success: [putOp(`${SCRATCH}dup`, text("1")), putOp(`${SCRATCH}dup`, text("2"))],
              failure: [],
            },
            {
              hasleader: true,
              match: {
                success: [
                  { request_put: { key: scratch(`${SCRATCH}dup`) } },
                  { request_put: { key: scratch(`${SCRATCH}dup`) } },
                ],
              },
            },
          ),
        ),
        errorRow(
          "etcd/error-lease-revoke-not-found",
          `leaseRevoke: lease ${NEVER_GRANTED_LEASE}, never granted`,
          "requested lease not found",
          () =>
            unary(
              p,
              "Lease/LeaseRevoke",
              { ID: NEVER_GRANTED_LEASE },
              { hasleader: true, match: { ID: NEVER_GRANTED_LEASE } },
            ),
        ),
        errorRow(
          "etcd/error-authenticate-not-enabled",
          "authenticate with RBAC off: the connect sequence's step 1 (spec 6.1)",
          "authentication is not enabled",
          () =>
            unary(
              p,
              "Auth/Authenticate",
              { name: "root", password: "not-a-password" },
              { hasleader: true, match: { name: "root" } },
            ),
        ),
        errorRow(
          "etcd/error-tls-to-plaintext",
          "status over TLS to the plaintext port 2379",
          undefined,
          () =>
            unary(
              {
                ...PLAIN,
                tls: { ca: "ca.pem", serverName: "localhost" },
                fresh: true,
              },
              "Maintenance/Status",
              {},
              { match: {}, noAnswer: true },
            ),
          true,
        ),
        errorRow(
          "etcd/error-deadline-after-send",
          "range: /app/cfg with a 1 s deadline, sent to the member paused after its channel was ready",
          "remote_addr=",
          async () => {
            await must(p, "Maintenance/Status", {});
            return whilePaused(CONTAINERS.etcd, () =>
              unary(
                p,
                "KV/Range",
                { key: text("/app/cfg"), limit: "1" },
                {
                  hasleader: true,
                  deadlineMs: 1000,
                  match: { key: text("/app/cfg") },
                  noAnswer: true,
                },
              ),
            );
          },
          true,
        ),
        errorRow(
          "etcd/error-cancelled-on-client",
          "range: /app/cfg, cancelled on the client right after it starts",
          "Cancelled on client",
          () =>
            unary(
              p,
              "KV/Range",
              { key: text("/app/cfg"), limit: "1" },
              {
                hasleader: true,
                cancelAtStart: true,
                match: { key: text("/app/cfg") },
                noAnswer: true,
              },
            ),
        ),
      ],
    },
    {
      name: "etcd maintenance, last on this server",
      captures: [
        row("etcd/defragment", "defragment, without hasleader", () =>
          unary(p, "Maintenance/Defragment", {}, { match: {} }),
        ),
        row("etcd/compact", "compact to the current revision, physical", async () => {
          const revision = await currentRevision(p);
          moved.push(`etcd: compacted to revision ${revision}, so no read or watch before it answers`);
          return unary(p, "KV/Compact", { revision, physical: true }, { hasleader: true, match: { physical: true } });
        }),
      ],
    },
    {
      name: "etcd after the compaction",
      captures: [
        errorRow(
          "etcd/error-range-compacted",
          "range: /history/counter at its create revision, compacted",
          "required revision has been compacted",
          async () => {
            const revision = await createRevisionOf(p, "/history/counter");
            return unary(
              p,
              "KV/Range",
              { key: text("/history/counter"), limit: "1", revision },
              {
                hasleader: true,
                match: { key: text("/history/counter"), revision },
              },
            );
          },
        ),
        row("etcd/watch-compacted", "watch: /history/counter from its create revision, compacted", async () => {
          const start_revision = await createRevisionOf(p, "/history/counter");
          return stream(
            p,
            "Watch/Watch",
            {
              create_request: {
                key: text("/history/counter"),
                start_revision,
                fragment: true,
              },
            },
            {
              hasleader: true,
              until: cancelled,
              maxWaitMs: 5000,
              match: {
                create_request: {
                  key: text("/history/counter"),
                  start_revision,
                },
              },
            },
          );
        }),
      ],
    },
  ];
}

function clusterPhases(): Phase[] {
  const first = member(1);
  let leader: Conn | undefined;
  let follower: Conn | undefined;
  const memberIdOf = (conn: Conn) => {
    const known = context.members[endpointOf(conn)];
    if (known === undefined) throw new Error(`No member identity was read for ${endpointOf(conn)}`);
    return known.memberId;
  };
  const nospace = (memberID: string) => ({
    action: "DEACTIVATE",
    memberID,
    alarm: "NOSPACE",
  });
  const missing = (what: string): never => {
    throw new Error(`The cluster rows find ${what} in their phase's setup: run the whole capture`);
  };
  const leaderOf = async () => String((await must(first, "Maintenance/Status", {})).leader);
  return [
    {
      name: "cluster reads",
      setup: async () => {
        const id = await leaderOf();
        const members = [member(1), member(2), member(3)];
        leader = members.find((conn) => memberIdOf(conn) === id);
        follower = members.find((conn) => memberIdOf(conn) !== id);
        if (leader === undefined || follower === undefined)
          throw new Error(`No member of etcd-cluster is the leader ${id}`);
      },
      captures: [
        row("etcd-cluster/member-list", "memberList: linearizable, three members", () =>
          unary(
            first,
            "Cluster/MemberList",
            { linearizable: true },
            { hasleader: true, match: { linearizable: true } },
          ),
        ),
        row("etcd-cluster/status-leader", "status of the leader", () =>
          unary(leader ?? missing("the leader"), "Maintenance/Status", {}, { match: {} }),
        ),
        row("etcd-cluster/status-follower", "status of a follower", () =>
          unary(follower ?? missing("a follower"), "Maintenance/Status", {}, { match: {} }),
        ),
      ],
    },
    {
      name: "cluster with a NOSPACE alarm",
      setup: async () => {
        await must(
          first,
          "Maintenance/Alarm",
          { action: "ACTIVATE", memberID: memberIdOf(first), alarm: "NOSPACE" },
          { hasleader: true },
        );
        moved.push(
          `etcd-cluster: a NOSPACE alarm raised on member ${memberIdOf(first)} with Alarm ACTIVATE, then disarmed`,
        );
        // Disarms whatever is still raised if the run stops before the disarm row; a no-op after it.
        restores.push(async () => {
          const answer = await must(first, "Maintenance/Alarm", { action: "GET" }, { hasleader: true });
          for (const alarm of answer.alarms as Fields[]) {
            // oxlint-disable-next-line no-await-in-loop -- each raised alarm is disarmed and answered before the next is sent.
            await must(
              first,
              "Maintenance/Alarm",
              { action: "DEACTIVATE", memberID: alarm.memberID, alarm: alarm.alarm },
              {
                hasleader: true,
              },
            );
          }
        });
      },
      captures: [
        row("etcd-cluster/alarm-list-nospace", "alarmList: Alarm GET with a NOSPACE alarm raised", () =>
          unary(first, "Maintenance/Alarm", { action: "GET" }, { hasleader: true, match: { action: "GET" } }),
        ),
        errorRow(
          "etcd-cluster/error-no-space",
          "txn: a put while the NOSPACE alarm is raised",
          "database space exceeded",
          () =>
            unary(
              first,
              "KV/Txn",
              {
                compare: [],
                success: [putOp(`${SCRATCH}nospace`, text("x"))],
                failure: [],
              },
              {
                hasleader: true,
                match: {
                  success: [{ request_put: { key: scratch(`${SCRATCH}nospace`) } }],
                },
              },
            ),
        ),
        row(
          "etcd-cluster/alarm-disarm-member-zero",
          "alarmDisarm: DEACTIVATE NOSPACE with member id 0, which clears nothing",
          () =>
            unary(first, "Maintenance/Alarm", nospace("0"), {
              hasleader: true,
              match: nospace("0"),
            }),
        ),
      ],
    },
    {
      name: "cluster disarm",
      captures: [
        row(
          "etcd-cluster/alarm-disarm",
          "alarmDisarm: DEACTIVATE NOSPACE with the member id Alarm GET named",
          async () => {
            const measured = await unary(first, "Maintenance/Alarm", nospace(memberIdOf(first)), {
              hasleader: true,
              match: nospace(memberIdOf(first)),
            });
            // Its answer lists the alarm it cleared, so one listed alarm is also proof that member id 0 cleared none.
            if ((lastAnswer?.alarms as unknown[] | undefined)?.length !== 1) {
              findings.push("etcd-cluster/alarm-disarm: the DEACTIVATE naming the member cleared no alarm (spec 7.2)");
            }
            return measured;
          },
        ),
      ],
      teardown: async () => {
        const answer = await must(first, "Maintenance/Alarm", { action: "GET" }, { hasleader: true });
        if ((answer.alarms as unknown[]).length !== 0)
          throw new Error("etcd-cluster still lists an alarm after the disarm");
      },
    },
    {
      name: "cluster defragmentation of member 2",
      captures: [
        row("etcd-cluster/status-before-defragment", "status of member 2 before its defragmentation", () =>
          unary(member(2), "Maintenance/Status", {}, { match: {} }),
        ),
        row("etcd-cluster/defragment", "defragment member 2, through its own connection", () =>
          unary(member(2), "Maintenance/Defragment", {}, { match: {} }),
        ),
        row("etcd-cluster/status-after-defragment", "status of member 2 after its defragmentation", () =>
          unary(member(2), "Maintenance/Status", {}, { match: {} }),
        ),
      ],
    },
    {
      name: "cluster transport failures",
      captures: [
        errorRow(
          "etcd-cluster/error-deadline-before-pick",
          "range: /app/cfg with a 1.5 s deadline over a new channel to member 3, paused: Node never gets a ready channel, Bun sends the call",
          // A paused member's kernel still completes the TCP handshake. Node waits for the HTTP/2 settings that
          // never come, so the call is never picked; Bun 1.4.2 takes the channel as ready and sends it.
          { node: "Waiting for LB pick", bun: "remote_addr=" },
          () =>
            whilePaused("libredb-etcd-cluster-3", () =>
              unary(
                { ...member(3), fresh: true },
                "KV/Range",
                { key: text("/app/cfg"), limit: "1" },
                {
                  hasleader: true,
                  deadlineMs: 1500,
                  match: { key: text("/app/cfg") },
                  noAnswer: true,
                },
              ),
            ),
          true,
        ),
        errorRow(
          "etcd-cluster/error-connection-dropped",
          "txn: a put through a forwarder that passes the request to member 1 and drops the connection before the answer",
          "Connection dropped",
          async () => {
            const forwarder = await dropForwarder(first);
            const conn: Conn = {
              service: "etcd-cluster",
              host: "127.0.0.1",
              port: forwarder.port,
            };
            try {
              await must(conn, "Maintenance/Status", {});
              forwarder.arm();
              return await unary(
                conn,
                "KV/Txn",
                {
                  compare: [],
                  success: [putOp(`${SCRATCH}dropped`, text("x"))],
                  failure: [],
                },
                {
                  hasleader: true,
                  match: {
                    success: [{ request_put: { key: scratch(`${SCRATCH}dropped`) } }],
                  },
                  noAnswer: true,
                },
              );
            } finally {
              clients.get(JSON.stringify(conn))?.close();
              clients.delete(JSON.stringify(conn));
              await forwarder.close();
            }
          },
        ),
      ],
    },
    {
      name: "cluster without a quorum",
      setup: async () => {
        docker("stop", "libredb-etcd-cluster-2", "libredb-etcd-cluster-3");
        moved.push("etcd-cluster: members 2 and 3 stopped for the quorum-loss rows, then started again");
        // oxlint-disable-next-line no-await-in-loop -- a poll: each leader probe settles before the next wait.
        for (let waited = 0; (await leaderOf()) !== "0"; waited += 500) {
          if (waited > 30000)
            throw new Error("etcd-cluster member 1 still names a leader 30 s after two members stopped");
          // oxlint-disable-next-line no-await-in-loop -- a poll: each wait ends before the next leader probe.
          await sleep(500);
        }
      },
      captures: [
        row("etcd-cluster/status-no-leader", "status of member 1 with members 2 and 3 stopped, without hasleader", () =>
          unary(first, "Maintenance/Status", {}, { match: {} }),
        ),
        row(
          "etcd-cluster/range-serializable-no-leader",
          "range: /app/cfg, serializable, without hasleader, no leader",
          () =>
            unary(
              first,
              "KV/Range",
              { key: text("/app/cfg"), limit: "1", serializable: true },
              {
                match: { key: text("/app/cfg"), serializable: true },
              },
            ),
        ),
        row(
          "etcd-cluster/member-list-serializable-no-leader",
          "memberList: serializable, without hasleader, no leader",
          () => unary(first, "Cluster/MemberList", { linearizable: false }, { match: { linearizable: false } }),
        ),
        errorRow(
          "etcd-cluster/error-no-leader",
          "range: /app/cfg with hasleader, no leader",
          "etcdserver: no leader",
          () => readKey(first, "/app/cfg"),
        ),
        errorRow(
          "etcd-cluster/error-no-leader-txn-put",
          "txn: E8's guarded put with hasleader, no leader",
          "etcdserver: no leader",
          () =>
            unary(
              first,
              "KV/Txn",
              {
                compare: [modIs(scratch(`${SCRATCH}leaderless`), "0")],
                success: [putOp(`${SCRATCH}leaderless`, text("x"))],
                failure: [rangeOp(scratch(`${SCRATCH}leaderless`))],
              },
              {
                hasleader: true,
                match: { compare: [{ key: scratch(`${SCRATCH}leaderless`) }] },
              },
            ),
        ),
        // KE14's other half: each call spec 6.1 exempts from hasleader, sent with it to the same member, fails with
        // "etcdserver: no leader", which is why the adapter sends them without it (R11 ETCD-3).
        errorRow(
          "etcd-cluster/status-no-leader-hasleader",
          "status of member 1 with members 2 and 3 stopped, with hasleader",
          "etcdserver: no leader",
          () => unary(first, "Maintenance/Status", {}, { hasleader: true, match: {} }),
        ),
        errorRow(
          "etcd-cluster/defragment-no-leader-hasleader",
          "defragment member 1 with members 2 and 3 stopped, with hasleader",
          "etcdserver: no leader",
          () => unary(first, "Maintenance/Defragment", {}, { hasleader: true, match: {} }),
        ),
        errorRow(
          "etcd-cluster/lease-leases-no-leader-hasleader",
          "leaseLeases with hasleader, no leader",
          "etcdserver: no leader",
          () => unary(first, "Lease/LeaseLeases", {}, { hasleader: true, match: {} }),
        ),
        errorRow(
          "etcd-cluster/member-list-serializable-no-leader-hasleader",
          "memberList: serializable, with hasleader, no leader",
          "etcdserver: no leader",
          () =>
            unary(
              first,
              "Cluster/MemberList",
              { linearizable: false },
              { hasleader: true, match: { linearizable: false } },
            ),
        ),
        errorRow(
          "etcd-cluster/range-serializable-no-leader-hasleader",
          "range: /app/cfg, serializable, with hasleader, no leader",
          "etcdserver: no leader",
          () =>
            unary(
              first,
              "KV/Range",
              { key: text("/app/cfg"), limit: "1", serializable: true },
              {
                hasleader: true,
                match: { key: text("/app/cfg"), serializable: true },
              },
            ),
        ),
        errorRow(
          "etcd-cluster/txn-serializable-gets-no-leader-hasleader",
          "txn: read-only, its one request a serializable get of /app/cfg, with hasleader, no leader",
          "etcdserver: no leader",
          () =>
            unary(
              first,
              "KV/Txn",
              {
                compare: [],
                success: [{ request_range: { key: text("/app/cfg"), limit: "1", serializable: true } }],
                failure: [],
              },
              {
                hasleader: true,
                match: {
                  success: [{ request_range: { key: text("/app/cfg"), serializable: true } }],
                },
              },
            ),
        ),
      ],
      teardown: async () => {
        docker("start", "libredb-etcd-cluster-2", "libredb-etcd-cluster-3");
        for (let waited = 0; ; waited += 500) {
          // oxlint-disable-next-line no-await-in-loop -- a poll: each round of leader probes settles before the next wait.
          const answers = await Promise.all(
            [1, 2, 3].map((n) => unaryCall(member(n as 1 | 2 | 3), "Maintenance/Status", {})),
          );
          if (answers.every((answer) => answer.ok && String(answer.value.leader) !== "0")) break;
          if (waited > 60000) throw new Error("etcd-cluster has no leader 60 s after its members started again");
          // oxlint-disable-next-line no-await-in-loop -- a poll: each wait ends before the next round of probes.
          await sleep(500);
        }
      },
    },
  ];
}

function authPhases(): Phase[] {
  const root = auth("root");
  const reader = auth("reader");
  const disarm = () => ({
    action: "DEACTIVATE",
    memberID: context.members[endpointOf(root)]?.memberId ?? "0",
    alarm: "NOSPACE",
  });
  const tlsRow = (name: string, surface: string, conn: Conn) =>
    errorRow(
      name,
      surface,
      undefined,
      () => unary({ ...conn, fresh: true }, "Maintenance/Status", {}, { match: {}, noAnswer: true }),
      true,
    );
  return [
    {
      name: "etcd-auth reads",
      captures: [
        row("etcd-auth/status", "status as root (certificate root.crt), without hasleader", () =>
          unary(root, "Maintenance/Status", {}, { match: {} }),
        ),
        row("etcd-auth/auth-status-on", "authStatus: RBAC on", () =>
          unary(root, "Auth/AuthStatus", {}, { hasleader: true, match: {} }),
        ),
        row("etcd-auth/user-list", "userList as root (certificate root.crt)", () =>
          unary(root, "Auth/UserList", {}, { hasleader: true, match: {} }),
        ),
        row("etcd-auth/role-list", "roleList as root", () =>
          unary(root, "Auth/RoleList", {}, { hasleader: true, match: {} }),
        ),
        row("etcd-auth/user-get-cert-only", "userGet cert-only as root", () =>
          unary(root, "Auth/UserGet", { name: "cert-only" }, { hasleader: true, match: { name: "cert-only" } }),
        ),
        row("etcd-auth/user-get-reader", "userGet reader as reader (certificate reader.crt): a user reads itself", () =>
          unary(reader, "Auth/UserGet", { name: "reader" }, { hasleader: true, match: { name: "reader" } }),
        ),
        row("etcd-auth/role-get-reader", "roleGet reader as reader: a user reads its own role", () =>
          unary(reader, "Auth/RoleGet", { role: "reader" }, { hasleader: true, match: { role: "reader" } }),
        ),
        row("etcd-auth/range-reader-app", "range: the prefix /app/ as reader, which it may read", () =>
          readPrefix(reader, "/app/"),
        ),
        row("etcd-auth/range-reader-config-a", "range: the key /config/a as reader, its single-key grant", () =>
          readKey(reader, "/config/a"),
        ),
        row(
          "etcd-auth/range-health-permission-denied",
          "range: the key health as reader, outside its grants",
          () => readKey(reader, "health"),
          { expect: "fail", text: "permission denied" },
        ),
      ],
    },
    {
      name: "etcd-auth errors",
      captures: [
        errorRow(
          "etcd-auth/error-permission-denied",
          "range: /config/b as reader, outside its grants",
          "etcdserver: permission denied",
          () => readKey(reader, "/config/b"),
        ),
        errorRow(
          "etcd-auth/error-permission-denied-lease-leases",
          "leaseLeases as reader: the leases hold keys outside its grants",
          "permission denied",
          () => unary(reader, "Lease/LeaseLeases", {}, { match: {} }),
        ),
        errorRow("etcd-auth/error-permission-denied-user-list", "userList as reader", "permission denied", () =>
          unary(reader, "Auth/UserList", {}, { hasleader: true, match: {} }),
        ),
        errorRow("etcd-auth/error-permission-denied-role-list", "roleList as reader", "permission denied", () =>
          unary(reader, "Auth/RoleList", {}, { hasleader: true, match: {} }),
        ),
        errorRow(
          "etcd-auth/error-permission-denied-compact",
          "compact as reader: compaction needs the root role",
          "permission denied",
          async () => {
            const revision = await currentRevision(reader);
            return unary(
              reader,
              "KV/Compact",
              { revision, physical: true },
              { hasleader: true, match: { physical: true } },
            );
          },
        ),
        errorRow(
          "etcd-auth/error-permission-denied-defragment",
          "defragment as reader: defragmentation needs the root role",
          "permission denied",
          () => unary(reader, "Maintenance/Defragment", {}, { match: {} }),
        ),
        errorRow(
          "etcd-auth/error-permission-denied-alarm-disarm",
          "alarmDisarm as reader: a DEACTIVATE needs the root role",
          "permission denied",
          () =>
            unary(reader, "Maintenance/Alarm", disarm(), {
              hasleader: true,
              match: { action: "DEACTIVATE" },
            }),
        ),
        // A Range over this certificate answers "permission denied", not "user name is empty" (measured on
        // 3.7.2): the empty user name is an admin check's answer, which userGet of another user meets.
        errorRow(
          "etcd-auth/error-permission-denied-no-common-name",
          "range: /app/cfg with a certificate that has no Common Name (gateway-client.crt) and no token",
          "etcdserver: permission denied",
          () => readKey(auth("gateway-client"), "/app/cfg"),
        ),
        errorRow(
          "etcd-auth/error-user-name-empty",
          "userGet reader with a certificate that has no Common Name (gateway-client.crt) and no token",
          "etcdserver: user name is empty",
          () =>
            unary(
              auth("gateway-client"),
              "Auth/UserGet",
              { name: "reader" },
              { hasleader: true, match: { name: "reader" } },
            ),
        ),
        errorRow(
          "etcd-auth/error-user-name-not-found",
          "userGet unknown-user with the certificate whose Common Name is unknown-user: the connect sequence's step 4",
          "user name not found",
          () =>
            unary(
              auth("unknown-user"),
              "Auth/UserGet",
              { name: "unknown-user" },
              { hasleader: true, match: { name: "unknown-user" } },
            ),
        ),
        tlsRow("etcd-auth/error-plaintext-to-tls", "status in plaintext to the TLS port 12379", {
          service: "etcd-auth",
          host: "127.0.0.1",
          port: 12379,
        }),
        tlsRow(
          "etcd-auth/error-tls-chain",
          "status over TLS trusting another CA (other-ca.pem)",
          auth("root", "other-ca.pem"),
        ),
        tlsRow(
          "etcd-auth/error-tls-name",
          "status over TLS checking the name etcd-wrong-name.test",
          auth("root", "ca.pem", "etcd-wrong-name.test"),
        ),
        tlsRow(
          "etcd-auth/error-tls-client-certificate-required",
          "status over TLS with no client certificate",
          auth(undefined),
        ),
        tlsRow(
          "etcd-auth/error-tls-client-certificate-refused",
          "status over TLS with a client certificate from another CA (other-ca-root.crt)",
          auth("other-ca-root"),
        ),
        row(
          "etcd-auth/watch-permission-denied",
          "watch: /config/b as reader, cancelled in-band",
          () =>
            stream(
              reader,
              "Watch/Watch",
              { create_request: { key: text("/config/b"), fragment: true } },
              {
                hasleader: true,
                until: cancelled,
                maxWaitMs: 5000,
                match: { create_request: { key: text("/config/b") } },
              },
            ),
          { runtimes: "both", text: "permission denied" },
        ),
      ],
    },
    {
      name: "etcd-auth maintenance as root, compaction last",
      captures: [
        row("etcd-auth/alarm-disarm-root", "alarmDisarm as root: DEACTIVATE NOSPACE with no alarm raised", () =>
          unary(root, "Maintenance/Alarm", disarm(), {
            hasleader: true,
            match: { action: "DEACTIVATE" },
          }),
        ),
        row("etcd-auth/defragment-root", "defragment as root", () =>
          unary(root, "Maintenance/Defragment", {}, { match: {} }),
        ),
        row("etcd-auth/compact-root", "compact to the current revision as root, physical", async () => {
          // A compaction to a revision already compacted is refused, and nothing else writes on this server, so
          // the row moves the revision with a scratch key first, which a second run needs.
          await scratchPut(root, `${SCRATCH}compact`, "x");
          await scratchDelete(root, `${SCRATCH}compact`);
          const revision = await currentRevision(root);
          moved.push(`etcd-auth: compacted to revision ${revision} as root`);
          return unary(
            root,
            "KV/Compact",
            { revision, physical: true },
            { hasleader: true, match: { physical: true } },
          );
        }),
      ],
    },
  ];
}

function passwordPhases(): Phase[] {
  const server = passwordServer();
  const authRevision = async () => {
    const token = await signIn("root");
    return String((await must(server, "Auth/AuthStatus", {}, { hasleader: true, token })).authRevision);
  };
  // The reader role's own READ on /config/a, granted again as it is: the role's grants stay what they were, and
  // the auth store's revision moves by one. Granting a user a role it already holds moves nothing (measured on
  // 3.7.2: AuthRevision 10 before and after).
  const readerGrants = async (rootToken: string) =>
    (await must(server, "Auth/RoleGet", { role: "reader" }, { hasleader: true, token: rootToken })).perm as Fields[];
  const grantOnConfigA = async () => {
    const perm = (await readerGrants(await signIn("root"))).find(
      (granted) => (granted.key as Buffer).toString() === "/config/a",
    );
    if (perm === undefined) throw new Error("The reader role holds no grant on /config/a");
    return perm;
  };
  const grantAgain = (perm: Fields, rootToken: string) =>
    must(server, "Auth/RoleGrantPermission", { name: "reader", perm }, { hasleader: true, token: rootToken });
  const encodedGrants = async () => JSON.stringify(encodeValue(undefined, await readerGrants(await signIn("root"))));
  let before = "";
  let grantsBefore = "";
  return [
    {
      name: "etcd-auth-password sign-in",
      captures: [
        row("etcd-auth-password/status", "status with root's token, without hasleader", async () =>
          unary(server, "Maintenance/Status", {}, { token: await signIn("root"), match: {} }),
        ),
        row("etcd-auth-password/authenticate", "authenticate as root with its password", () =>
          unary(
            server,
            "Auth/Authenticate",
            { name: "root", password: password("root") },
            { hasleader: true, match: { name: "root" } },
          ),
        ),
        errorRow(
          "etcd-auth-password/error-authenticate-wrong-password",
          "authenticate as root with a wrong password",
          "authentication failed, invalid user ID or password",
          () =>
            unary(
              server,
              "Auth/Authenticate",
              { name: "root", password: "not-the-root-password" },
              { hasleader: true, match: { name: "root" } },
            ),
        ),
        errorRow(
          "etcd-auth-password/error-authenticate-no-password-user",
          "authenticate as cert-only, a user with no password, with a password",
          "password was given for no password user",
          () =>
            unary(
              server,
              "Auth/Authenticate",
              { name: "cert-only", password: "any-password" },
              {
                hasleader: true,
                match: { name: "cert-only" },
              },
            ),
        ),
        errorRow(
          "etcd-auth-password/error-invalid-auth-token",
          "range: /app/cfg with reader's token 12 s after it was issued (--auth-token-ttl=10)",
          "etcdserver: invalid auth token",
          async () => {
            const token = await signIn("reader");
            await sleep(12000);
            return readKey(server, "/app/cfg", { hasleader: true, token });
          },
        ),
        errorRow(
          "etcd-auth-password/error-range-no-token",
          "range: /app/cfg with no token: spec E4's answer when the token is missing",
          "etcdserver: user name is empty",
          () => readKey(server, "/app/cfg"),
        ),
        errorRow(
          "etcd-auth-password/error-user-name-empty-certificate",
          "userGet reader with reader.crt and no token, on the server without --client-cert-auth: the connect sequence's step 4",
          "etcdserver: user name is empty",
          () =>
            unary(
              passwordServer("reader"),
              "Auth/UserGet",
              { name: "reader" },
              { hasleader: true, match: { name: "reader" } },
            ),
        ),
        row(
          "etcd-auth-password/watch-invalid-auth-token",
          "watch: /app/ with reader's token 12 s after it was issued, cancelled in-band",
          async () => {
            const token = await signIn("reader");
            await sleep(12000);
            return stream(
              server,
              "Watch/Watch",
              { create_request: { ...prefix("/app/"), fragment: true } },
              {
                hasleader: true,
                token,
                until: cancelled,
                maxWaitMs: 5000,
                match: { create_request: prefix("/app/") },
              },
            );
          },
          { runtimes: "both", text: "invalid auth token" },
        ),
      ],
    },
    {
      name: "etcd-auth-password auth revision, last on this server",
      setup: async () => {
        before = await authRevision();
        grantsBefore = await encodedGrants();
      },
      captures: [
        row(
          "etcd-auth-password/range-token-before-auth-change",
          "range: /app/cfg with reader's token issued before root granted the reader role its READ on /config/a again: a simple token still reads",
          async () => {
            const token = await signIn("reader");
            const issuedAt = await authRevision();
            await grantAgain(await grantOnConfigA(), await signIn("root"));
            if (BigInt(await authRevision()) <= BigInt(issuedAt)) {
              findings.push(
                "etcd-auth-password/range-token-before-auth-change: the repeated grant moved no auth revision",
              );
            }
            return readKey(server, "/app/cfg", { hasleader: true, token });
          },
        ),
        // With --auth-token=simple a token carries no revision: etcd reads the auth store's revision when the
        // request arrives, and answers "revision of auth store is old" only when that revision moved while the
        // request was in flight (measured on 3.7.2: about one read in sixteen beside a grant, in one attempt in
        // four). So the row sends reads beside a grant until one meets it.
        errorRow(
          "etcd-auth-password/error-auth-revision-old",
          "range: /app/cfg with reader's token while root grants the reader role its READ on /config/a again, so the auth revision moves during the read",
          "revision of auth store is old",
          async () => {
            const perm = await grantOnConfigA();
            let last: Measured | undefined;
            for (let attempt = 0; attempt < AUTH_RACE_ATTEMPTS; attempt += 1) {
              // oxlint-disable-next-line no-await-in-loop -- each attempt races its own grant against its own reads, so the attempts run one at a time.
              const token = await signIn("reader");
              // oxlint-disable-next-line no-await-in-loop -- each attempt races its own grant against its own reads, so the attempts run one at a time.
              const rootToken = await signIn("root");
              // The grant and the reads leave together, so some reads are in flight when the grant is applied.
              const grant = grantAgain(perm, rootToken);
              // oxlint-disable-next-line no-await-in-loop -- each attempt races its own grant against its own reads, so the attempts run one at a time.
              const reads = await Promise.all(
                Array.from({ length: AUTH_RACE_READS }, () => readKey(server, "/app/cfg", { hasleader: true, token })),
              );
              // oxlint-disable-next-line no-await-in-loop -- each attempt races its own grant against its own reads, so the attempts run one at a time.
              await grant;
              last = reads.find((read) => read.outcome === "fail") ?? reads[0];
              if (last.outcome === "fail") break;
            }
            return last as Measured;
          },
        ),
      ],
      teardown: async () => {
        if ((await encodedGrants()) !== grantsBefore) {
          findings.push("etcd-auth-password: the reader role's grants changed over the auth revision rows");
        }
        moved.push(
          `etcd-auth-password: AuthRevision ${before} to ${await authRevision()}, by granting the reader role its own READ on /config/a again, once per attempt of the two auth revision rows; the role's grants are unchanged`,
        );
      },
    },
  ];
}

function transportPhases(): Phase[] {
  return [
    {
      name: "transport",
      captures: [
        errorRow(
          "transport/error-refused",
          "status to a closed local port",
          "No connection established",
          () =>
            unary(
              {
                service: "transport",
                host: "127.0.0.1",
                port: context.closedPort,
                fresh: true,
              },
              "Maintenance/Status",
              {},
              {
                match: {},
                noAnswer: true,
              },
            ),
          true,
        ),
        errorRow(
          "transport/error-deadline-name-resolution",
          "status to a name that does not resolve, with a deadline that has already passed",
          "waiting for name resolution",
          () =>
            unary(
              {
                service: "transport",
                host: "libredb-etcd-fixture.invalid",
                port: 2379,
                fresh: true,
              },
              "Maintenance/Status",
              {},
              {
                // Not 1 ms: the resolver's "not found" can come back within a millisecond, and the call then
                // fails as UNAVAILABLE "Name resolution failed" (measured under Node 24.14.0).
                deadlineMs: 0,
                match: {},
                noAnswer: true,
              },
            ),
          true,
        ),
      ],
    },
  ];
}

const PHASES: Readonly<Record<Service, () => Phase[]>> = {
  transport: transportPhases,
  etcd: etcdPhases,
  "etcd-cluster": clusterPhases,
  "etcd-auth": authPhases,
  "etcd-auth-password": passwordPhases,
};

function allCaptures(): Capture[] {
  return SERVICES.flatMap((service) => PHASES[service]().flatMap((phase) => phase.captures));
}

// -- E15: the snapshot --------------------------------------------------------------------------------------

interface Snapshot {
  readonly lines: readonly string[];
  readonly keys: number;
  readonly leases: number;
  readonly revision: string;
}

function isProtected(key: Buffer): boolean {
  const asText = key.toString("latin1");
  return asText === PROTECTED_KEY || PROTECTED_PREFIXES.some((value) => asText.startsWith(value));
}

async function snapshot(conn: Conn, token?: string): Promise<Snapshot> {
  const answer = await must(
    conn,
    "KV/Range",
    { key: ZERO, range_end: ZERO, limit: "100000" },
    { hasleader: true, token },
  );
  if (answer.more === true)
    throw new Error(`${endpointOf(conn)} holds more than 100,000 keys: the snapshot would be cut`);
  const lines: string[] = [];
  let keys = 0;
  for (const kv of answer.kvs as Fields[]) {
    const key = kv.key as Buffer;
    if (key.toString("latin1").startsWith(SCRATCH)) continue;
    keys += 1;
    const b64 = key.toString("base64");
    lines.push(
      `key ${b64} value ${(kv.value as Buffer).toString("base64")} create ${kv.create_revision} lease ${kv.lease}`,
    );
    if (isProtected(key)) lines.push(`protected ${b64} mod ${kv.mod_revision} version ${kv.version}`);
  }
  const leases = (await must(conn, "Lease/LeaseLeases", {}, { token })).leases as Fields[];
  for (const lease of leases) lines.push(`lease ${lease.ID}`);
  return {
    lines: lines.sort(),
    keys,
    leases: leases.length,
    revision: String(header(answer).revision),
  };
}

async function rootToken(service: Server): Promise<string | undefined> {
  return service === "etcd-auth-password" ? signIn("root") : undefined;
}

const SNAPSHOT_CONNS: Readonly<Record<Server, Conn>> = {
  etcd: PLAIN,
  "etcd-cluster": member(1),
  "etcd-auth": auth("root"),
  "etcd-auth-password": passwordServer(),
};

/** Removes what an interrupted run left under the scratch prefix, and its lease, before the first snapshot. */
async function clean(service: Server): Promise<void> {
  const conn = SNAPSHOT_CONNS[service];
  const token = await rootToken(service);
  await must(
    conn,
    "KV/DeleteRange",
    { key: scratch(SCRATCH), range_end: prefixEnd(text(SCRATCH)) },
    { hasleader: true, token },
  );
  const revoked = await unaryCall(conn, "Lease/LeaseRevoke", { ID: SCRATCH_LEASE }, { hasleader: true, token });
  if (!revoked.ok && (revoked.error as { details?: string }).details !== "etcdserver: requested lease not found") {
    throw new Error(`Revoking the scratch lease on ${service} failed: ${(revoked.error as Error).message}`);
  }
  const alarms = await must(conn, "Maintenance/Alarm", { action: "GET" }, { hasleader: true, token });
  if ((alarms.alarms as unknown[]).length !== 0) {
    throw new Error(`${service} has an alarm raised before the run: disarm it with etcdctl alarm disarm first`);
  }
}

// -- the capture run ------------------------------------------------------------------------------------------

interface RunReport {
  readonly runtimes: { readonly bun: string; readonly node?: string };
  readonly images: Context["images"];
  readonly members: Context["members"];
  readonly snapshots: Record<
    string,
    {
      readonly before: Omit<Snapshot, "lines">;
      readonly after: Omit<Snapshot, "lines">;
      readonly identical: boolean;
    }
  >;
  readonly moved: readonly string[];
  readonly written: readonly string[];
  readonly split: readonly string[];
  readonly mismatches: readonly string[];
  readonly stale: readonly string[];
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = argument(name);
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} <value> is required`);
  return value;
}

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function readImages(): Record<string, { image: string; digest: string }> {
  const images: Record<string, { image: string; digest: string }> = {};
  for (const [service, container] of Object.entries(CONTAINERS)) {
    const configured = docker("inspect", "--format", "{{.Config.Image}}", container);
    const [image, digest] = configured.split("@");
    if (digest === undefined) throw new Error(`${container} runs ${configured}, which is not pinned by digest`);
    images[service] = { image, digest };
  }
  return images;
}

async function readMembers(): Promise<Record<string, { clusterId: string; memberId: string }>> {
  const members: Record<string, { clusterId: string; memberId: string }> = {};
  const conns: Array<[Conn, Server]> = [
    [PLAIN, "etcd"],
    [member(1), "etcd-cluster"],
    [member(2), "etcd-cluster"],
    [member(3), "etcd-cluster"],
    [auth("root"), "etcd-auth"],
    [passwordServer(), "etcd-auth-password"],
  ];
  for (const [conn, service] of conns) {
    // oxlint-disable-next-line no-await-in-loop -- the servers are read one at a time, in the catalog order the context records.
    const status = header(await must(conn, "Maintenance/Status", {}, { token: await rootToken(service) }));
    members[endpointOf(conn)] = {
      clusterId: String(status.cluster_id),
      memberId: String(status.member_id),
    };
  }
  return members;
}

function answerText(measured: Measured): string {
  const payload = measured.payload as Fields;
  if (Array.isArray(payload.messages)) {
    const end = payload.end as Fields | string;
    if (typeof end === "object") return String((end.error as Fields).details ?? (end.error as Fields).message);
    return (payload.messages as Fields[]).map((message) => String(message.cancel_reason ?? "")).join("\n");
  }
  return measured.outcome === "fail" ? String(payload.details ?? payload.message) : "";
}

function problems(capture: Capture, measured: Measured): string[] {
  const found: string[] = [];
  const where = `${capture.name} (${measured.runtime})`;
  if (measured.outcome !== capture.expect)
    found.push(`${where}: expected ${capture.expect}, got ${measured.outcome}: ${answerText(measured)}`);
  const text =
    typeof capture.text === "object" ? capture.text[measured.runtime.startsWith("bun") ? "bun" : "node"] : capture.text;
  if (text !== undefined && !answerText(measured).includes(text)) {
    found.push(`${where}: the answer does not carry "${text}": ${answerText(measured)}`);
  }
  return found;
}

function record(capture: Capture, measured: Measured, runtime: string): object {
  const pinned =
    measured.service === "transport" ? { image: "none", digest: "none" } : context.images[measured.service];
  return {
    $captured: {
      service: measured.service,
      image: pinned.image,
      digest: pinned.digest,
      clusterId: measured.clusterId,
      memberId: measured.memberId,
      date: measured.date,
      runtime,
      rpc: measured.rpc,
      surface: capture.surface,
      request: measured.request,
      match: measured.match,
      metadata: measured.metadata,
    },
    outcome: measured.outcome,
    payload: measured.payload,
  };
}

function writeFixture(directory: string, name: string, content: object): void {
  const serialised = `${JSON.stringify(content, null, 2)}\n`;
  for (const secret of SECRETS) {
    if (serialised.includes(secret)) throw new Error(`${name} would hold a password or a token: nothing written`);
  }
  if (/-----BEGIN|PRIVATE KEY/.test(serialised))
    throw new Error(`${name} would hold a key or a certificate: nothing written`);
  const file = path.join(directory, `${name}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, serialised);
}

function runChild(names: readonly string[], contextFile: string): Map<string, Measured> {
  const child = spawnSync("node", [THIS_FILE, "--child", names.join(","), "--context", contextFile], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (child.status !== 0) throw new Error(`The Node child exited with ${child.status} for ${names.join(", ")}`);
  return new Map(Object.entries(JSON.parse(child.stdout) as Record<string, Measured>));
}

interface RunLog {
  written: string[];
  split: string[];
  mismatches: string[];
  node?: string;
}

async function runPhase(phase: Phase, directory: string, contextFile: string, log: RunLog): Promise<void> {
  console.error(`-- ${phase.name}`);
  await phase.setup?.();
  try {
    const bun = new Map<string, Measured>();
    for (const capture of phase.captures) {
      // oxlint-disable-next-line no-await-in-loop -- captures run one at a time: a capture may change the server state the next one reads.
      bun.set(capture.name, await capture.run());
      console.error(`   ${capture.name}: ${bun.get(capture.name)?.outcome}`);
    }
    const twice = phase.captures.filter((capture) => capture.runtimes === "both").map((capture) => capture.name);
    const node = twice.length > 0 ? runChild(twice, contextFile) : new Map<string, Measured>();
    for (const capture of phase.captures) {
      const onBun = bun.get(capture.name) as Measured;
      const onNode = node.get(capture.name);
      log.mismatches.push(...problems(capture, onBun), ...(onNode ? problems(capture, onNode) : []));
      if (onNode === undefined) {
        writeFixture(directory, capture.name, record(capture, onBun, onBun.runtime));
        log.written.push(capture.name);
        continue;
      }
      log.node = onNode.runtime;
      const same = JSON.stringify([onBun.outcome, onBun.payload]) === JSON.stringify([onNode.outcome, onNode.payload]);
      if (same && !capture.split) {
        writeFixture(directory, capture.name, record(capture, onBun, `${onBun.runtime} and ${onNode.runtime}`));
        log.written.push(capture.name);
      } else {
        writeFixture(directory, `${capture.name}.bun`, record(capture, onBun, onBun.runtime));
        writeFixture(directory, `${capture.name}.node`, record(capture, onNode, onNode.runtime));
        log.written.push(`${capture.name}.bun`, `${capture.name}.node`);
        log.split.push(capture.name);
      }
    }
  } finally {
    await phase.teardown?.();
  }
}

function fixtureNames(directory: string): string[] {
  return SERVICES.flatMap((service) => {
    const dir = path.join(directory, service);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => `${service}/${file.slice(0, -".json".length)}`);
  }).sort();
}

/**
 * One phase alone, as the whole run takes it: its setup, its rows (or the --only ones among them) under their own
 * runtimes, and its teardown, between two E15 snapshots of its server. It takes rows after the whole run, which
 * compacts etcd and etcd-auth, without running it again.
 */
async function phaseRun(
  name: string,
  only: readonly string[] | undefined,
  directory: string,
  contextFile: string,
  log: RunLog,
): Promise<number> {
  const found = SERVICES.flatMap((service) => PHASES[service]().map((phase) => ({ service, phase }))).find(
    ({ phase }) => phase.name === name,
  );
  if (found === undefined) throw new Error(`No phase is named ${name}`);
  const { service, phase } = found;
  const captures =
    only === undefined
      ? phase.captures
      : only.map((row) => {
          const capture = phase.captures.find((candidate) => candidate.name === row);
          if (capture === undefined) throw new Error(`The phase ${name} has no capture named ${row}`);
          return capture;
        });
  const server = service === "transport" ? undefined : service;
  // The transport rows reach no server, so they have no key space to snapshot.
  const keySpace = async (): Promise<readonly string[]> => {
    if (server === undefined) return [];
    await clean(server);
    return (await snapshot(SNAPSHOT_CONNS[server], await rootToken(server))).lines;
  };
  const before = await keySpace();
  try {
    await runPhase({ ...phase, captures }, directory, contextFile, log);
  } finally {
    // oxlint-disable-next-line no-await-in-loop -- each restore finishes before the next one starts.
    for (const restore of restores) await restore();
  }
  const after = await keySpace();
  closeClients();
  const changed = [
    ...before.filter((line) => !after.includes(line)).map((line) => `- ${line}`),
    ...after.filter((line) => !before.includes(line)).map((line) => `+ ${line}`),
  ];
  console.error(
    `E15: ${server ?? "no server"} ${changed.length === 0 ? "identical" : `CHANGED\n${changed.join("\n")}`}`,
  );
  console.error(`wrote ${log.written.join(", ")}`);
  console.error(log.mismatches.join("\n") || "no mismatches");
  return log.mismatches.length === 0 && changed.length === 0 ? 0 : 1;
}

async function captureRun(): Promise<number> {
  if (!IS_BUN)
    throw new Error("Run the capture under Bun: bun tests/live/etcd-evidence.ts --certs <dir> --report <file>");
  const reportFile = path.resolve(required("--report"));
  const only = argument("--only")?.split(",");
  const phaseName = argument("--phase");
  const directory = only === undefined && phaseName === undefined ? FIXTURES : path.resolve(required("--out"));
  context = {
    certsDir: path.resolve(required("--certs")),
    closedPort: await closedPort(),
    images: readImages(),
    members: {},
  };
  context = { ...context, members: await readMembers() };
  const contextFile = `${reportFile}.context.json`;
  writeFileSync(contextFile, `${JSON.stringify(context, null, 2)}\n`);
  const log: RunLog = { written: [], split: [], mismatches: [] };

  if (phaseName !== undefined) return phaseRun(phaseName, only, directory, contextFile, log);
  if (only !== undefined) {
    const byName = new Map(allCaptures().map((capture) => [capture.name, capture]));
    await runPhase(
      {
        name: "only",
        // oxlint-disable-next-line no-map-spread -- a capture is readonly and shared by its phase, so the one-row run takes a changed copy.
        captures: only.map((name) => {
          const capture = byName.get(name);
          if (capture === undefined) throw new Error(`No capture is named ${name}`);
          return { ...capture, runtimes: "bun" as const, split: undefined };
        }),
      },
      directory,
      contextFile,
      log,
    );
    closeClients();
    console.error(log.mismatches.join("\n") || "no mismatches");
    return log.mismatches.length === 0 ? 0 : 1;
  }

  const servers = Object.keys(CONTAINERS) as Server[];
  const before: Record<string, Snapshot> = {};
  for (const service of servers) {
    // oxlint-disable-next-line no-await-in-loop -- each server is cleaned and then snapshotted before any capture runs.
    await clean(service);
    // oxlint-disable-next-line no-await-in-loop -- each server is cleaned and then snapshotted before any capture runs.
    before[service] = await snapshot(SNAPSHOT_CONNS[service], await rootToken(service));
  }
  try {
    for (const service of SERVICES) {
      // oxlint-disable-next-line no-await-in-loop -- phases run in order: a phase reads the server state the phases before it left.
      for (const phase of PHASES[service]()) await runPhase(phase, directory, contextFile, log);
    }
  } finally {
    // oxlint-disable-next-line no-await-in-loop -- each restore finishes before the next one starts.
    for (const restore of restores) await restore();
  }
  const snapshots: RunReport["snapshots"] = {};
  const differences: string[] = [];
  for (const service of servers) {
    // oxlint-disable-next-line no-await-in-loop -- each server is cleaned and then compared with its snapshot, one at a time.
    await clean(service);
    // oxlint-disable-next-line no-await-in-loop -- each server is cleaned and then compared with its snapshot, one at a time.
    const after = await snapshot(SNAPSHOT_CONNS[service], await rootToken(service));
    const identical = JSON.stringify(before[service].lines) === JSON.stringify(after.lines);
    if (!identical) {
      const gone = before[service].lines.filter((line) => !after.lines.includes(line));
      const added = after.lines.filter((line) => !before[service].lines.includes(line));
      differences.push(
        `${service}: ${gone
          .map((line) => `- ${line}`)
          .concat(added.map((line) => `+ ${line}`))
          .join("\n")}`,
      );
    }
    const counts = ({ keys, leases, revision }: Snapshot) => ({ keys, leases, revision });
    snapshots[service] = {
      before: counts(before[service]),
      after: counts(after),
      identical,
    };
  }
  closeClients();
  const written = new Set(log.written);
  const report: RunReport = {
    runtimes: { bun: RUNTIME, node: log.node },
    images: context.images,
    members: context.members,
    snapshots,
    moved,
    written: [...written].sort(),
    split: log.split.sort(),
    mismatches: [...log.mismatches, ...findings],
    stale: fixtureNames(directory).filter((name) => !written.has(name)),
  };
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  console.error(
    `E15: ${servers.map((service) => `${service} ${snapshots[service].identical ? "identical" : "CHANGED"}`).join(", ")}`,
  );
  console.error(`wrote ${report.written.length} files; split: ${report.split.join(", ") || "none"}`);
  if (report.stale.length > 0) console.error(`stale, not written by this run: ${report.stale.join(", ")}`);
  if (report.mismatches.length > 0) console.error(`mismatches:\n${report.mismatches.join("\n")}`);
  if (differences.length > 0) console.error(`E15 differences:\n${differences.join("\n")}`);
  return report.mismatches.length === 0 && differences.length === 0 && report.stale.length === 0 ? 0 : 1;
}

async function childRun(): Promise<number> {
  context = JSON.parse(readFileSync(required("--context"), "utf8")) as Context;
  const byName = new Map(allCaptures().map((capture) => [capture.name, capture]));
  const results: Record<string, Measured> = {};
  for (const name of required("--child").split(",")) {
    const capture = byName.get(name);
    if (capture === undefined || capture.runtimes !== "both")
      throw new Error(`${name} is not a row the Node child runs`);
    // oxlint-disable-next-line no-await-in-loop -- the Node child runs its rows one at a time, as the Bun run does.
    results[name] = await capture.run();
  }
  closeClients();
  // A pipe's write is asynchronous under Node on Linux, so the exit waits for it: an answer past the pipe's
  // buffer was otherwise cut in the middle.
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(JSON.stringify(results), (error) => (error ? reject(error) : resolve())),
  );
  return 0;
}

// -- the README's generated blocks --------------------------------------------------------------------------

function replaceBlock(readme: string, block: string, content: string): string {
  const start = `<!-- generated:${block} -->`;
  const end = `<!-- /generated:${block} -->`;
  const from = readme.indexOf(start);
  const to = readme.indexOf(end);
  if (from === -1 || to < from) throw new Error(`tests/fixtures/etcd/README.md has no ${start} ... ${end} block`);
  return `${readme.slice(0, from + start.length)}\n${content}\n${readme.slice(to)}`;
}

function renderReadme(): number {
  const report = JSON.parse(readFileSync(required("--report"), "utf8")) as RunReport;
  const captures = fixtureNames(FIXTURES).map((name) => ({
    name,
    record: JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")) as {
      $captured: {
        service: string;
        image: string;
        digest: string;
        clusterId: string;
        memberId: string;
        date: string;
        runtime: string;
        rpc: string;
        surface: string;
      };
      outcome: string;
    },
  }));
  const provenance = [
    "| Service | Image | Digest | Cluster id | Members that answered | Captured | Runtimes |",
    "|---|---|---|---|---|---|---|",
    ...SERVICES.map((service) => {
      const own = captures
        .filter(({ record: r }) => r.$captured.service === service)
        .map(({ record: r }) => r.$captured);
      const distinct = (values: string[]) =>
        [...new Set(values.filter((value) => value !== "none"))].sort().join(", ") || "none";
      const dates = own.map((c) => c.date).sort();
      return `| \`${service}\` | \`${own[0]?.image}\` | \`${own[0]?.digest}\` | ${distinct(own.map((c) => c.clusterId))} | ${distinct(own.map((c) => c.memberId))} | ${dates[0]} to ${dates.at(-1)} | ${distinct(own.map((c) => c.runtime))} |`;
    }),
  ].join("\n");
  const run = [
    "| Server | Keys before | Keys after | Leases | Revision before | Revision after | E15 |",
    "|---|---|---|---|---|---|---|",
    ...Object.entries(report.snapshots).map(
      ([service, s]) =>
        `| \`${service}\` | ${s.before.keys} | ${s.after.keys} | ${s.before.leases} | ${s.before.revision} | ${s.after.revision} | ${s.identical ? "identical" : "changed"} |`,
    ),
    "",
    ...report.moved.map((line) => `- ${line}.`),
  ].join("\n");
  const catalog = [
    "| File | Outcome | RPC | Runtime | Surface |",
    "|---|---|---|---|---|",
    ...captures.map(
      ({ name, record: r }) =>
        `| \`${name}.json\` | ${r.outcome} | \`${r.$captured.rpc}\` | ${r.$captured.runtime} | ${r.$captured.surface} |`,
    ),
  ].join("\n");
  const file = path.join(FIXTURES, "README.md");
  let readme = readFileSync(file, "utf8");
  readme = replaceBlock(readme, "provenance", provenance);
  readme = replaceBlock(readme, "run", run);
  readme = replaceBlock(readme, "catalog", catalog);
  writeFileSync(file, readme);
  console.error(`rendered ${captures.length} captures into ${path.relative(ROOT, file)}`);
  return 0;
}

async function main(): Promise<number> {
  if (process.argv.includes("--child")) return childRun();
  if (process.argv.includes("--readme")) return renderReadme();
  return captureRun();
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    closeClients();
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exit(1);
  },
);
