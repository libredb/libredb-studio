/**
 * Gate 4's evidence harness for the Milvus provider (vector-family spec 7.3, E3, E6, E7, E14, E20, 5.10).
 *
 * It drives @grpc/grpc-js against the live services of docker/milvus/README.md, with the definition the descriptor
 * generator's loadMilvusDescriptor() builds, never an import of provider code or of proto/descriptor.ts, and writes
 * every capture of tests/fixtures/milvus/README.md as tests/fixtures/milvus/<service>/<name>.json. Each capture calls
 * one surface and records a pass or the verbatim failure. The error rows of 5.10 and the TLS rows run under Bun and
 * again in a Node child process, and a row whose two answers differ is written twice, as <name>.bun.json and
 * <name>.node.json.
 *
 * It writes only what it owns: a collection and an alias under PREFIX on `milvus`, and on `milvus-tls`, which no seed
 * writes, a loaded empty collection for the TLS port's waiting queries, all created at the start and dropped at the
 * end; `mutate()` refuses any other name before the wire. It never loads, releases, flushes or writes a seeded object.
 *
 * Run by hand, never by `bun run test` (tests/runner/discover.ts excludes tests/live/):
 *   bun tests/live/milvus-evidence.ts --secrets <dir> --certs <dir> [--only <name,...>]
 *   node tests/live/milvus-evidence.ts --child <name,...> --context <file>    spawned by the capture run
 * <secrets> is a copy of the seed's credentials volume (`docker cp libredb-milvus-seed:/credentials <dir>`) and <certs>
 * of the certificate volume (`docker cp libredb-milvus-certs:/certs <dir>`), both outside the repository. No password,
 * token or key is written into a capture: the authorization metadata is never recorded, and every file is checked for
 * every form of every credential the run sent before it is written. Milvus's default password is the product's own
 * name, which server texts and image names carry, so it is checked as the pair it travels in, never alone.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkServerIdentity } from "node:tls";
import { fileURLToPath } from "node:url";
import * as grpc from "@grpc/grpc-js";
import { fromJSON, type MethodDefinition } from "@grpc/proto-loader";
import protobuf from "protobufjs";
import { loadMilvusDescriptor } from "../../scripts/generate-milvus-descriptor.mjs";

type Service = "milvus" | "milvus-tls" | "milvus-mtls";
type User = "root" | "reader" | "nobody" | "wrong";

const ROOT = path.resolve(import.meta.dirname, "../..");
const FIXTURES = path.join(ROOT, "tests", "fixtures", "milvus");
const EXPECTED_SCORES = path.join(ROOT, "tests", "fixtures", "vector", "expected-scores.json");
const THIS_FILE = fileURLToPath(import.meta.url);
const IS_BUN = typeof Bun !== "undefined";
const RUNTIME = IS_BUN ? `bun ${Bun.version}` : `node ${process.versions.node}`;
const IMAGE = "milvusdb/milvus:v3.0.2@sha256:5f13bf88e110a517911c3e6dd8172454e90042c21e606a868084615a4302c8a0";
const CONTAINERS: Readonly<Record<Service, string>> = {
  milvus: "libredb-milvus",
  "milvus-tls": "libredb-milvus-tls",
  "milvus-mtls": "libredb-milvus-mtls",
};
const PORTS: Readonly<Record<Service, number>> = { milvus: 19530, "milvus-tls": 19531, "milvus-mtls": 19532 };
/** Every collection and alias this harness writes starts with it. */
const PREFIX = "libredb_evidence_";
const OWN_COLLECTION = `${PREFIX}load`;
const OWN_ALIAS = `${PREFIX}alias`;
/** The loaded empty collection on milvus-tls that its waiting queries wait on: that server holds no seeded data. */
const TLS_WAIT_COLLECTION = `${PREFIX}wait`;
/** Milvus's documented default root credential (docker/milvus/README.md): no compose file sets it. */
const ROOT_CREDENTIAL = { user: "root", password: "Milvus" } as const;
/** A stand-in for the refused sign-in, never a realistic value. */
const WRONG_PASSWORD = "password-wrong";
const SYSTEM_INFO = '{"metric_type": "system_info"}';
const SERVICE = "milvus.proto.milvus.MilvusService";
const LOADER = { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true } as const;
const RECEIVE_CAP = 16 * 1024 * 1024;
const ANSWERS_A_STATUS = new Set([
  "LoadCollection",
  "ReleaseCollection",
  "CreateCollection",
  "CreateIndex",
  "CreateAlias",
  "DropAlias",
  "DropCollection",
]);
const ALLOWLIST = [
  "GetVersion",
  "CheckHealth",
  "GetMetrics",
  "ListDatabases",
  "DescribeDatabase",
  "ShowCollections",
  "DescribeCollection",
  "BatchDescribeCollection",
  "DescribeIndex",
  "GetLoadState",
  "GetLoadingProgress",
  "GetCollectionStatistics",
  "ShowPartitions",
  "ListAliases",
  "DescribeAlias",
  "Query",
  "Search",
  "HybridSearch",
  "LoadCollection",
  "ReleaseCollection",
];
const SEEDED: ReadonlyArray<readonly [string, string]> = [
  ["default", "docs_int64"],
  ["default", "docs_varchar"],
  ["default", "fts"],
  ["default", "unloaded_big"],
  ["default", "scratch"],
  ["default", "edge_values"],
  ["default", "pk_partitioned"],
  ["default", "large_topk"],
  ["default", "shadowed"],
  ["default", "wide_768"],
  ["default", "emb_list"],
  ["probe_db", "notes"],
];
const EDGE_FIELDS = ["f32", "f16", "bf16", "bin", "i8", "sp"];

const DESCRIPTOR = loadMilvusDescriptor();
const DEFINITION = fromJSON(DESCRIPTOR as Parameters<typeof fromJSON>[0], LOADER);
const TYPES = protobuf.Root.fromJSON(DESCRIPTOR as protobuf.INamespace);
TYPES.resolveAll();

function method(rpc: string): MethodDefinition<object, object> {
  const found = (DEFINITION[SERVICE] as Record<string, MethodDefinition<object, object>>)[rpc];
  if (found === undefined) throw new Error(`MilvusService has no ${rpc}`);
  return found;
}

const kebab = (rpc: string) => rpc.replace(/([a-z])([A-Z])/g, "$1-$2").toLowerCase();
const keyValues = (record: Readonly<Record<string, string>>) =>
  Object.entries(record).map(([key, value]) => ({ key, value }));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// -- what the capture run shares with its Node child ------------------------------------------------------------

interface Context {
  readonly secretsDir: string;
  readonly certsDir: string;
  readonly date: string;
  readonly version: string;
  readonly docsIds: readonly string[];
  readonly varcharPk: string;
  readonly edgeId: string;
}

let context: Context = { secretsDir: "", certsDir: "", date: "", version: "", docsIds: [], varcharPk: "", edgeId: "" };

/** Every form of every credential the run sent; none may appear in a written capture. */
const SECRETS = new Set<string>();

function remember(secret: string): void {
  SECRETS.add(secret);
  SECRETS.add(Buffer.from(secret, "utf8").toString("base64").replace(/=+$/, ""));
}

function password(user: User): string {
  if (user === "root") return ROOT_CREDENTIAL.password;
  if (user === "wrong") return WRONG_PASSWORD;
  const value = readFileSync(path.join(context.secretsDir, `${user}.password`), "utf8").trim();
  remember(value);
  return value;
}

function authorization(user: User): string {
  const pair = `${user === "wrong" ? ROOT_CREDENTIAL.user : user}:${password(user)}`;
  remember(pair);
  return Buffer.from(pair, "utf8").toString("base64");
}

// -- channels and calls ---------------------------------------------------------------------------------------------

interface TlsConn {
  /** False: no CA, the runtime's roots. */
  readonly ca?: boolean;
  /** `<cert>.pem` and `<key ?? cert>.key` under the certificate directory. */
  readonly cert?: string;
  readonly key?: string;
  /** Dial 127.0.0.1 with the IP rule: a non-IP override and the IP verified (E6). */
  readonly ipIdentity?: boolean;
}

interface Conn {
  readonly service: Service;
  readonly user?: User;
  readonly port?: number;
  readonly tls?: TlsConn;
  readonly options?: grpc.ChannelOptions;
}

function clientFor(conn: Conn): grpc.Client {
  const tls = conn.tls;
  const host = tls !== undefined && tls.ipIdentity !== true ? "localhost" : "127.0.0.1";
  const target = `dns:${host}:${conn.port ?? PORTS[conn.service]}`;
  const options: grpc.ChannelOptions = {
    "grpc.service_config_disable_resolution": 1,
    "grpc.enable_http_proxy": 0,
    "grpc.enable_retries": 0,
    "grpc.max_receive_message_length": RECEIVE_CAP,
    "grpc.use_local_subchannel_pool": 1,
    ...conn.options,
  };
  if (tls === undefined) return new grpc.Client(target, grpc.credentials.createInsecure(), options);
  const file = (name: string) => readFileSync(path.join(context.certsDir, name));
  const ca = tls.ca === false ? null : file("ca.pem");
  const cert = tls.cert === undefined ? null : file(`${tls.cert}.pem`);
  const key = tls.cert === undefined ? null : file(`${tls.key ?? tls.cert}.key`);
  if (tls.ipIdentity !== true) return new grpc.Client(target, grpc.credentials.createSsl(ca, key, cert), options);
  return new grpc.Client(
    target,
    grpc.credentials.createSsl(ca, key, cert, {
      checkServerIdentity: (_name, certificate) => checkServerIdentity("127.0.0.1", certificate),
    }),
    { ...options, "grpc.ssl_target_name_override": "milvus.invalid" },
  );
}

interface CallOptions {
  readonly deadlineMs?: number;
  /** A method path in place of the RPC's, for the UNIMPLEMENTED row. */
  readonly path?: string;
  /** A client the caller owns and closes, for the rows that need two calls on one channel. */
  readonly client?: grpc.Client;
  readonly onCall?: (pending: grpc.ClientUnaryCall) => void;
}

/** One call; resolves the decoded answer, rejects grpc-js's error or the runtime's. */
async function rawCall(conn: Conn, rpc: string, request: object, options: CallOptions = {}): Promise<object> {
  const owned = options.client === undefined;
  const client = options.client ?? clientFor(conn);
  try {
    const definition = method(rpc);
    const metadata = new grpc.Metadata();
    if (conn.user !== undefined) metadata.set("authorization", authorization(conn.user));
    return await new Promise<object>((resolve, reject) => {
      const pending = client.makeUnaryRequest(
        options.path ?? definition.path,
        definition.requestSerialize,
        definition.responseDeserialize,
        request,
        metadata,
        { deadline: Date.now() + (options.deadlineMs ?? 15_000) },
        (error, value) => (error ? reject(error) : resolve(value as object)),
      );
      options.onCall?.(pending);
    });
  } finally {
    if (owned) client.close();
  }
}

interface WireStatus {
  readonly code: number;
  readonly error_code: string;
  readonly reason: string;
}

function statusOf(rpc: string, answer: object): WireStatus | undefined {
  return ANSWERS_A_STATUS.has(rpc)
    ? (answer as WireStatus)
    : ((answer as { status?: WireStatus | null }).status ?? undefined);
}

function succeeded(rpc: string, answer: object): boolean {
  const status = statusOf(rpc, answer);
  return status !== undefined && status.code === 0 && status.error_code === "Success";
}

/** JSON-safe: bytes as { $bytes }, a float JSON cannot hold as { $float }. */
function encode(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (typeof value === "number" && !Number.isFinite(value)) return { $float: String(value) };
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, encode(inner)]));
  }
  return value;
}

function failureOf(error: unknown): Readonly<Record<string, unknown>> {
  if (error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code !== "string") {
    const status = error as Error & { code?: number; details?: string };
    return { code: status.code ?? null, details: status.details ?? null, message: status.message };
  }
  return {
    name: error instanceof Error ? error.name : "Thrown",
    message: error instanceof Error ? error.message : String(error),
  };
}

interface Measured {
  readonly outcome: "pass" | "fail";
  readonly payload: unknown;
  readonly ms: number;
  /** Set when the row could not be observed as its capture describes; the run reports it and fails. */
  readonly problem?: string;
}

async function call(conn: Conn, rpc: string, request: object, options: CallOptions = {}): Promise<Measured> {
  const started = Date.now();
  try {
    const answer = await rawCall(conn, rpc, request, options);
    return { outcome: succeeded(rpc, answer) ? "pass" : "fail", payload: encode(answer), ms: Date.now() - started };
  } catch (error) {
    return { outcome: "fail", payload: { error: failureOf(error) }, ms: Date.now() - started };
  }
}

async function must(conn: Conn, rpc: string, request: object): Promise<Record<string, unknown>> {
  const answer = await rawCall(conn, rpc, request);
  if (!succeeded(rpc, answer)) throw new Error(`${rpc} failed: ${JSON.stringify(encode(answer))}`);
  return answer as Record<string, unknown>;
}

/** One column of a query answer, as decimal strings or strings. */
function column(answer: Record<string, unknown>, field: string): string[] {
  const fields = answer.fields_data as ReadonlyArray<{
    field_name: string;
    scalars: { long_data?: { data: string[] } | null; string_data?: { data: string[] } | null } | null;
  }>;
  const found = fields.find((candidate) => candidate.field_name === field);
  return found?.scalars?.long_data?.data ?? found?.scalars?.string_data?.data ?? [];
}

// -- requests -------------------------------------------------------------------------------------------------------

const ROOT_CONN: Conn = { service: "milvus", user: "root" };
const TLS_ROOT_CONN: Conn = { service: "milvus-tls", user: "root", tls: {} };
const own = { db_name: "default", collection_name: OWN_COLLECTION };
const tlsWait = { db_name: "default", collection_name: TLS_WAIT_COLLECTION };

/**
 * A Query that waits on a guarantee timestamp two minutes ahead, so its deadline fires first (R41 M6): on `milvus`
 * over the seeded docs_int64, on `milvus-tls` over the harness's own loaded empty collection.
 */
function waitingQuery(service: Service = "milvus"): object {
  const ahead = (BigInt(Date.now() + 120_000) * BigInt(262_144)).toString();
  return {
    db_name: "default",
    collection_name: service === "milvus" ? "docs_int64" : TLS_WAIT_COLLECTION,
    expr: service === "milvus" ? "seq >= 0" : "id >= 0",
    output_fields: [service === "milvus" ? "seq" : "id"],
    query_params: keyValues({ limit: "1" }),
    guarantee_timestamp: ahead,
    consistency_level: "Customized",
    use_default_consistency: false,
  };
}

function floatPlaceholder(values: readonly number[]): Buffer {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  const type = TYPES.lookupType("milvus.proto.common.PlaceholderGroup");
  return Buffer.from(
    type.encode(type.fromObject({ placeholders: [{ tag: "$0", type: "FloatVector", values: [bytes] }] })).finish(),
  );
}

function searchByIds(
  collection: string,
  field: string,
  ids: object,
  params = "{}",
  extra: Readonly<Record<string, string>> = {},
  output: readonly string[] = [],
): object {
  return {
    db_name: "default",
    collection_name: collection,
    dsl: "",
    dsl_type: "BoolExprV1",
    ids,
    nq: "1",
    output_fields: output,
    use_default_consistency: true,
    search_params: keyValues({ anns_field: field, topk: "3", params, round_decimal: "-1", ...extra }),
  };
}

function hybridSearch(): object {
  const sub = (field: string) => ({
    dsl: "",
    dsl_type: "BoolExprV1",
    placeholder_group: floatPlaceholder([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]),
    nq: "1",
    search_params: keyValues({ anns_field: field, topk: "3", params: "{}" }),
  });
  return {
    db_name: "default",
    collection_name: "docs_varchar",
    requests: [sub("f16"), sub("bf16")],
    rank_params: keyValues({ strategy: "rrf", params: '{"k":60}', limit: "3", offset: "0", round_decimal: "-1" }),
    output_fields: ["label"],
    use_default_consistency: true,
  };
}

function rpcRequest(rpc: string): object {
  switch (rpc) {
    case "GetVersion":
    case "CheckHealth":
    case "ListDatabases":
      return {};
    case "GetMetrics":
      return { request: SYSTEM_INFO };
    case "DescribeDatabase":
    case "ShowCollections":
      return { db_name: "default" };
    case "BatchDescribeCollection":
      return { db_name: "default", collection_name: ["docs_int64", "docs_varchar"] };
    case "ListAliases":
      return own;
    case "DescribeAlias":
      return { db_name: "default", alias: OWN_ALIAS };
    case "Query":
      return {
        db_name: "default",
        collection_name: "docs_int64",
        expr: "seq < 3",
        output_fields: ["seq", "title"],
        query_params: keyValues({ limit: "3" }),
      };
    case "Search":
      return searchByIds("docs_int64", "vec", { int_id: { data: [context.docsIds[0]] } }, "{}", {}, ["seq"]);
    case "HybridSearch":
      return hybridSearch();
    case "LoadCollection":
    case "ReleaseCollection":
      return own;
    default:
      return { db_name: "default", collection_name: "docs_int64" };
  }
}

// -- the catalog ----------------------------------------------------------------------------------------------------

interface Capture {
  readonly name: string;
  readonly service: Service;
  readonly rpc: string;
  readonly user: User | "none";
  readonly surface: string;
  readonly request: object;
  readonly bothRuntimes: boolean;
  readonly expect?: "pass" | "fail";
  readonly run: () => Promise<Measured>;
}

function row(
  name: string,
  conn: Conn,
  rpc: string,
  request: object,
  surface: string,
  options: { readonly expect?: "pass" | "fail"; readonly bothRuntimes?: boolean; readonly call?: CallOptions } = {},
): Capture {
  return {
    name,
    service: conn.service,
    rpc,
    user: conn.user ?? "none",
    surface,
    request,
    bothRuntimes: options.bothRuntimes ?? false,
    ...(options.expect === undefined ? {} : { expect: options.expect }),
    run: () => call(conn, rpc, request, options.call),
  };
}

const errorCode = (measured: Measured) => ((measured.payload as { error?: { code?: number | null } }).error ?? {}).code;
const statusCode = (measured: Measured) => ((measured.payload as { status?: { code?: number } }).status ?? {}).code;

/** A deadline shape (R41 F7): the waiting Query, up to 16 times, until the shape appears. */
function deadlineShape(name: string, service: Service, observed: (measured: Measured) => boolean): Capture {
  const conn: Conn = service === "milvus" ? ROOT_CONN : { service, user: "root", tls: {} };
  return {
    name,
    service,
    rpc: "Query",
    user: "root",
    surface: "a Query waiting on a guarantee timestamp two minutes ahead, with a 3 s deadline",
    request: waitingQuery(service),
    bothRuntimes: true,
    expect: "fail",
    run: async () => {
      const seen: unknown[] = [];
      for (let attempt = 0; attempt < 16; attempt++) {
        // oxlint-disable-next-line no-await-in-loop -- one waiting call at a time, until the shape appears.
        const measured = await call(conn, "Query", waitingQuery(service), { deadlineMs: 3000 });
        if (observed(measured)) return measured;
        seen.push(measured.payload);
      }
      return { outcome: "fail", payload: { seen }, ms: 0, problem: `the shape ${name} did not appear in 16 attempts` };
    },
  };
}

/** A forwarder that stops forwarding when armed and keeps both sockets open, as an expired NAT mapping does (R41 M6). */
async function blackholeForwarder(port: number) {
  let armed = false;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    const upstream = net.connect(port, "127.0.0.1");
    for (const end of [socket, upstream]) {
      sockets.add(end);
      end.on("error", () => undefined);
    }
    socket.on("data", (chunk) => {
      if (!armed) upstream.write(chunk);
    });
    upstream.on("data", (chunk) => {
      if (!armed) socket.write(chunk);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    arm: () => {
      armed = true;
    },
    close: () => {
      for (const socket of sockets) socket.destroy();
      server.close();
    },
  };
}

async function droppedConnection(): Promise<Measured> {
  const forwarder = await blackholeForwarder(PORTS.milvus);
  const conn: Conn = {
    service: "milvus",
    user: "root",
    port: forwarder.port,
    options: { "grpc.keepalive_time_ms": 10_000, "grpc.keepalive_timeout_ms": 6_000 },
  };
  const client = clientFor(conn);
  try {
    const first = await call(conn, "GetVersion", {}, { client });
    if (first.outcome !== "pass") return { ...first, problem: "the call before the drop did not answer" };
    forwarder.arm();
    await sleep(11_000);
    return await call(conn, "GetVersion", {}, { client, deadlineMs: 20_000 });
  } finally {
    client.close();
    forwarder.close();
  }
}

async function waitLoaded(): Promise<void> {
  for (let waited = 0; waited < 30_000; waited += 1000) {
    // oxlint-disable-next-line no-await-in-loop -- a poll: each read waits for the one before it.
    const progress = await must(ROOT_CONN, "GetLoadingProgress", own);
    if (progress.progress === "100") return;
    // oxlint-disable-next-line no-await-in-loop -- the poll's interval.
    await sleep(1000);
  }
  throw new Error(`${OWN_COLLECTION} did not load within 30 s`);
}

function catalog(): Capture[] {
  const captures: Capture[] = [];
  const reads = ALLOWLIST.filter((rpc) => rpc !== "LoadCollection" && rpc !== "ReleaseCollection");
  for (const rpc of reads)
    captures.push(row(`${kebab(rpc)}-root`, ROOT_CONN, rpc, rpcRequest(rpc), `${rpc} as root`, { expect: "pass" }));
  captures.push(
    row(
      "load-collection-root",
      ROOT_CONN,
      "LoadCollection",
      own,
      "LoadCollection of the harness's own collection as root",
      { expect: "pass" },
    ),
  );
  captures.push({
    name: "get-load-state-loaded",
    service: "milvus",
    rpc: "GetLoadState",
    user: "root",
    surface: "GetLoadState of the harness's own collection once its load reached 100",
    request: own,
    bothRuntimes: false,
    expect: "pass",
    run: async () => {
      await waitLoaded();
      return call(ROOT_CONN, "GetLoadState", own);
    },
  });
  captures.push(
    row(
      "release-collection-root",
      ROOT_CONN,
      "ReleaseCollection",
      own,
      "ReleaseCollection of the harness's own collection as root",
      { expect: "pass" },
    ),
  );
  for (const user of ["reader", "nobody"] as const) {
    for (const rpc of ALLOWLIST)
      captures.push(
        row(`${kebab(rpc)}-${user}`, { service: "milvus", user }, rpc, rpcRequest(rpc), `${rpc} as ${user}`),
      );
  }
  for (const [db, name] of SEEDED) {
    captures.push(
      row(
        `describe-collection-${db}-${name}`,
        ROOT_CONN,
        "DescribeCollection",
        { db_name: db, collection_name: name },
        `DescribeCollection of ${db}.${name}`,
        { expect: "pass" },
      ),
    );
  }
  captures.push(
    row(
      "get-load-state-unloaded-big",
      ROOT_CONN,
      "GetLoadState",
      { db_name: "default", collection_name: "unloaded_big" },
      "GetLoadState of the released unloaded_big",
      { expect: "pass" },
    ),
  );
  captures.push(
    row(
      "query-count",
      ROOT_CONN,
      "Query",
      { db_name: "default", collection_name: "docs_int64", expr: "", output_fields: ["count(*)"], query_params: [] },
      "a lone count(*) with no limit",
      { expect: "pass" },
    ),
  );
  captures.push(
    row(
      "query-edge-values",
      ROOT_CONN,
      "Query",
      {
        db_name: "default",
        collection_name: "edge_values",
        expr: "id >= 0",
        output_fields: ["id", "label", ...EDGE_FIELDS],
        query_params: keyValues({ limit: "16" }),
      },
      "every edge row with every vector field",
      { expect: "pass" },
    ),
  );
  for (const field of EDGE_FIELDS) {
    captures.push(
      row(
        `search-edge-values-${field}`,
        ROOT_CONN,
        "Search",
        searchByIds("edge_values", field, { int_id: { data: [context.edgeId] } }, "{}", {}, ["id"]),
        `a self-search by id on edge_values.${field}`,
        { expect: "pass" },
      ),
    );
  }
  const error = (name: string, conn: Conn, rpc: string, request: object, surface: string, options: CallOptions = {}) =>
    row(name, conn, rpc, request, surface, { expect: "fail", bothRuntimes: true, call: options });
  const custom = (
    name: string,
    service: Service,
    rpc: string,
    surface: string,
    request: object,
    run: () => Promise<Measured>,
  ): Capture => ({
    name,
    service,
    rpc,
    user: "root",
    surface,
    request,
    bothRuntimes: true,
    expect: "fail",
    run,
  });
  captures.push(
    error(
      "error-unauthenticated",
      { service: "milvus", user: "wrong" },
      "ListDatabases",
      {},
      "ListDatabases with a wrong password",
    ),
    error(
      "error-permission-denied",
      { service: "milvus", user: "nobody" },
      "Query",
      rpcRequest("Query"),
      "Query as nobody",
    ),
    error("error-unimplemented", ROOT_CONN, "GetVersion", {}, "a method path the server does not serve", {
      path: `/${SERVICE}/NoSuchMethod`,
    }),
    custom(
      "error-connection-dropped",
      "milvus",
      "GetVersion",
      "GetVersion 11 s after a forwarder silently dropped the connection",
      {},
      droppedConnection,
    ),
    deadlineShape("error-deadline-exceeded", "milvus", (measured) => errorCode(measured) === 4),
    deadlineShape("error-deadline-status-10001", "milvus", (measured) => statusCode(measured) === 10_001),
    custom(
      "error-cancelled-on-client",
      "milvus",
      "Query",
      "a waiting Query the client cancels after 300 ms",
      waitingQuery(),
      () =>
        call(ROOT_CONN, "Query", waitingQuery(), {
          deadlineMs: 30_000,
          onCall: (pending) => setTimeout(() => pending.cancel(), 300),
        }),
    ),
    error(
      "error-receive-cap",
      { ...ROOT_CONN, options: { "grpc.max_receive_message_length": 1000 } },
      "Query",
      {
        db_name: "default",
        collection_name: "docs_int64",
        expr: "seq >= 0",
        output_fields: ["seq", "title"],
        query_params: keyValues({ limit: "100" }),
      },
      "a Query past a 1,000-byte receive cap",
    ),
    error(
      "error-receive-cap-decompressed",
      {
        ...ROOT_CONN,
        options: { "grpc.max_receive_message_length": 100_000, "grpc.default_compression_algorithm": 2 },
      },
      "Query",
      {
        db_name: "default",
        collection_name: "docs_int64",
        expr: "seq >= 0",
        output_fields: ["seq", "title", "meta", "tags", "vec"],
        query_params: keyValues({ limit: "1000" }),
      },
      "a gzip-requested Query whose answer inflates past a 100,000-byte cap",
    ),
    error(
      "error-not-loaded",
      ROOT_CONN,
      "Query",
      {
        db_name: "default",
        collection_name: "unloaded_big",
        expr: "id >= 0",
        output_fields: ["id"],
        query_params: keyValues({ limit: "1" }),
      },
      "a Query on the released unloaded_big",
    ),
    error(
      "error-input",
      ROOT_CONN,
      "Query",
      {
        db_name: "default",
        collection_name: "docs_int64",
        expr: "seq >>> 3",
        output_fields: ["seq"],
        query_params: keyValues({ limit: "1" }),
      },
      "a Query whose filter does not parse",
    ),
    error(
      "error-collection-not-exists",
      ROOT_CONN,
      "DescribeCollection",
      { db_name: "default", collection_name: `${PREFIX}absent` },
      "DescribeCollection of a collection that does not exist",
    ),
    error(
      "error-database-not-exists",
      ROOT_CONN,
      "ShowCollections",
      { db_name: `${PREFIX}no_db` },
      "ShowCollections of a database that does not exist",
    ),
    error(
      "error-query-node-2000",
      ROOT_CONN,
      "Search",
      {
        db_name: "default",
        collection_name: "docs_int64",
        dsl: "",
        dsl_type: "BoolExprV1",
        placeholder_group: floatPlaceholder([0.1, 0.2, 0.3, 0.4]),
        nq: "1",
        output_fields: [],
        search_params: keyValues({ anns_field: "vec", topk: "3", params: "{}" }),
      },
      "a Search with 4 floats on an 8-dimension field",
      { deadlineMs: 30_000 },
    ),
    error(
      "error-query-node-2001",
      ROOT_CONN,
      "Search",
      searchByIds("docs_varchar", "f16", { str_id: { data: [context.varcharPk] } }, "{}", { group_by_field: "bin" }),
      "a Search grouped by a vector field",
      { deadlineMs: 30_000 },
    ),
    error(
      "error-query-node-2099",
      ROOT_CONN,
      "Search",
      searchByIds("docs_int64", "vec", { int_id: { data: [context.docsIds[0]] } }, '{"radius":"abc"}'),
      "a Search whose radius is a string",
      { deadlineMs: 30_000 },
    ),
    error(
      "error-tls-to-plaintext",
      { service: "milvus", user: "root", tls: {} },
      "GetVersion",
      {},
      "TLS to the plaintext port",
    ),
    row(
      "get-version-tls-localhost",
      { service: "milvus-tls", user: "root", tls: {} },
      "GetVersion",
      {},
      "GetVersion over TLS by name, with the CA",
      { expect: "pass", bothRuntimes: true },
    ),
    row(
      "get-version-tls-ip-rule",
      { service: "milvus-tls", user: "root", tls: { ipIdentity: true } },
      "GetVersion",
      {},
      "GetVersion over TLS to 127.0.0.1 under the IP rule",
      { expect: "pass", bothRuntimes: true },
    ),
    error(
      "error-tls-chain",
      { service: "milvus-tls", user: "root", tls: { ca: false } },
      "GetVersion",
      {},
      "TLS with no CA, the runtime's roots",
    ),
    error(
      "error-plaintext-to-tls",
      { service: "milvus-tls", user: "root" },
      "GetVersion",
      {},
      "plaintext to the TLS port",
    ),
    deadlineShape("error-deadline-cancelled", "milvus-tls", (measured) => errorCode(measured) === 1),
    custom(
      "error-ping-goaway",
      "milvus-tls",
      "Query",
      "a waiting Query on a channel pinging every second, with pings while idle",
      waitingQuery("milvus-tls"),
      () =>
        call(
          {
            service: "milvus-tls",
            user: "root",
            tls: {},
            options: { "grpc.keepalive_time_ms": 1000, "grpc.keepalive_permit_without_calls": 1 },
          },
          "Query",
          waitingQuery("milvus-tls"),
          { deadlineMs: 30_000 },
        ),
    ),
    row(
      "get-version-mtls",
      { service: "milvus-mtls", user: "root", tls: { cert: "client" } },
      "GetVersion",
      {},
      "GetVersion over mutual TLS with a clientAuth certificate",
      { expect: "pass", bothRuntimes: true },
    ),
    error(
      "error-tls-client-certificate-required",
      { service: "milvus-mtls", user: "root", tls: {} },
      "GetVersion",
      {},
      "mutual TLS with no client certificate",
    ),
    error(
      "error-tls-client-certificate-refused",
      { service: "milvus-mtls", user: "root", tls: { cert: "client-serverauth" } },
      "GetVersion",
      {},
      "a serverAuth-only client certificate",
    ),
    error(
      "error-tls-client-certificate-expired",
      { service: "milvus-mtls", user: "root", tls: { cert: "client-expired" } },
      "GetVersion",
      {},
      "an expired client certificate",
    ),
    error(
      "error-tls-client-key-mismatch",
      { service: "milvus-mtls", user: "root", tls: { cert: "client", key: "client-mismatched" } },
      "GetVersion",
      {},
      "a client key that is not the certificate's",
    ),
  );
  return captures;
}

// -- its own objects ------------------------------------------------------------------------------------------------

/** Every write the harness makes; a target outside PREFIX is refused before the wire. */
async function mutate(
  rpc: string,
  target: string,
  request: object,
  tolerate = false,
  conn: Conn = ROOT_CONN,
): Promise<void> {
  if (!target.startsWith(PREFIX))
    throw new Error(`${rpc} would write ${target}, outside ${PREFIX}: refused before the wire`);
  const answer = await rawCall(conn, rpc, request).catch((error: unknown) => {
    if (tolerate) return undefined;
    throw error;
  });
  if (answer !== undefined && !succeeded(rpc, answer) && !tolerate) {
    throw new Error(`${rpc} on ${target} failed: ${JSON.stringify(encode(answer))}`);
  }
}

function schemaBytes(name: string): Buffer {
  const type = TYPES.lookupType("milvus.proto.schema.CollectionSchema");
  const schema = type.fromObject({
    name,
    fields: [
      { name: "id", is_primary_key: true, data_type: "Int64" },
      { name: "vec", data_type: "FloatVector", type_params: [{ key: "dim", value: "2" }] },
    ],
  });
  return Buffer.from(type.encode(schema).finish());
}

async function tearDown(): Promise<void> {
  await mutate("DropAlias", OWN_ALIAS, { db_name: "default", alias: OWN_ALIAS }, true);
  await mutate("ReleaseCollection", OWN_COLLECTION, own, true);
  await mutate("DropCollection", OWN_COLLECTION, own, true);
  await mutate("ReleaseCollection", TLS_WAIT_COLLECTION, tlsWait, true, TLS_ROOT_CONN);
  await mutate("DropCollection", TLS_WAIT_COLLECTION, tlsWait, true, TLS_ROOT_CONN);
}

const FLAT_INDEX = {
  field_name: "vec",
  index_name: "vec",
  extra_params: keyValues({ index_type: "FLAT", metric_type: "L2", params: "{}" }),
};

/** The TLS server's waiting collection, empty, indexed and loaded, so a Query on it waits on its timestamp. */
async function setUpTlsWait(): Promise<void> {
  await mutate(
    "CreateCollection",
    TLS_WAIT_COLLECTION,
    { ...tlsWait, schema: schemaBytes(TLS_WAIT_COLLECTION), shards_num: 1 },
    false,
    TLS_ROOT_CONN,
  );
  await mutate("CreateIndex", TLS_WAIT_COLLECTION, { ...tlsWait, ...FLAT_INDEX }, false, TLS_ROOT_CONN);
  await mutate("LoadCollection", TLS_WAIT_COLLECTION, tlsWait, false, TLS_ROOT_CONN);
  for (let waited = 0; waited < 60_000; waited += 1000) {
    // oxlint-disable-next-line no-await-in-loop -- a poll: each read waits for the one before it.
    const progress = await must(TLS_ROOT_CONN, "GetLoadingProgress", tlsWait);
    if (progress.progress === "100") return;
    // oxlint-disable-next-line no-await-in-loop -- the poll's interval.
    await sleep(1000);
  }
  throw new Error(`${TLS_WAIT_COLLECTION} on milvus-tls did not load within 60 s`);
}

async function setUp(): Promise<void> {
  await tearDown();
  await mutate("CreateCollection", OWN_COLLECTION, { ...own, schema: schemaBytes(OWN_COLLECTION), shards_num: 1 });
  await mutate("CreateIndex", OWN_COLLECTION, { ...own, ...FLAT_INDEX });
  await mutate("CreateAlias", OWN_ALIAS, { ...own, alias: OWN_ALIAS });
  await setUpTlsWait();
}

// -- writing --------------------------------------------------------------------------------------------------------

function assertNoSecret(text: string, file: string): void {
  for (const secret of SECRETS) {
    if (text.includes(secret))
      throw new Error(`${file} would hold a form of a credential the run sent; nothing was written`);
  }
  if (text.includes("-----BEGIN")) throw new Error(`${file} would hold a PEM block; nothing was written`);
}

function record(capture: Capture, measured: Measured, runtime: string): object {
  return {
    $captured: {
      service: capture.service,
      image: IMAGE,
      version: context.version,
      date: context.date,
      runtime,
      rpc: capture.rpc,
      user: capture.user,
      surface: capture.surface,
      request: encode(capture.request),
    },
    outcome: measured.outcome,
    payload: measured.payload,
  };
}

function writeFixture(file: string, content: object): void {
  const text = `${JSON.stringify(content, null, 2)}\n`;
  assertNoSecret(text, file);
  writeFileSync(file, text);
}

function problemsOf(capture: Capture, measured: Measured, runtime: string): string[] {
  if (measured.problem !== undefined) return [`${capture.name} (${runtime}): ${measured.problem}`];
  if (capture.expect !== undefined && measured.outcome !== capture.expect) {
    return [
      `${capture.name} (${runtime}): expected ${capture.expect}, got ${measured.outcome}: ${JSON.stringify(measured.payload).slice(0, 400)}`,
    ];
  }
  return [];
}

function write(
  capture: Capture,
  bun: Measured,
  node: { readonly runtime: string; readonly measured: Measured } | undefined,
): string[] {
  const directory = path.join(FIXTURES, capture.service);
  mkdirSync(directory, { recursive: true });
  for (const suffix of [".json", ".bun.json", ".node.json"])
    rmSync(path.join(directory, `${capture.name}${suffix}`), { force: true });
  const problems = problemsOf(capture, bun, RUNTIME);
  if (node === undefined) {
    if (capture.bothRuntimes) problems.push(`${capture.name}: the Node child did not run it`);
    writeFixture(path.join(directory, `${capture.name}.json`), record(capture, bun, RUNTIME));
    return problems;
  }
  problems.push(...problemsOf(capture, node.measured, node.runtime));
  const same =
    bun.outcome === node.measured.outcome && JSON.stringify(bun.payload) === JSON.stringify(node.measured.payload);
  if (same) {
    writeFixture(path.join(directory, `${capture.name}.json`), record(capture, bun, `${RUNTIME} and ${node.runtime}`));
  } else {
    writeFixture(path.join(directory, `${capture.name}.bun.json`), record(capture, bun, RUNTIME));
    writeFixture(path.join(directory, `${capture.name}.node.json`), record(capture, node.measured, node.runtime));
  }
  return problems;
}

// -- the runs -------------------------------------------------------------------------------------------------------

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function required(name: string): string {
  const value = argument(name);
  if (value === undefined) throw new Error(`${name} <value> is required`);
  return value;
}

function checkService(service: Service): void {
  const run = spawnSync(
    "docker",
    [
      "inspect",
      "-f",
      "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}} {{.Config.Image}}",
      CONTAINERS[service],
    ],
    { encoding: "utf8" },
  );
  const seen = run.stdout.trim();
  if (run.status !== 0 || seen !== `running healthy ${IMAGE}`) {
    throw new Error(
      `${CONTAINERS[service]} is not a healthy ${IMAGE}: ${seen || run.stderr.trim()}; bring it up as docker/milvus/README.md says, and run again`,
    );
  }
}

async function readFacts(): Promise<Pick<Context, "version" | "docsIds" | "varcharPk" | "edgeId">> {
  const version = await must(ROOT_CONN, "GetVersion", {});
  const docs = await must(ROOT_CONN, "Query", {
    db_name: "default",
    collection_name: "docs_int64",
    expr: "seq in [0, 1, 2]",
    output_fields: ["id", "seq"],
    query_params: keyValues({ limit: "3" }),
  });
  const varchar = await must(ROOT_CONN, "Query", {
    db_name: "default",
    collection_name: "docs_varchar",
    expr: 'pk != ""',
    output_fields: ["pk"],
    query_params: keyValues({ limit: "1" }),
  });
  const scores = JSON.parse(readFileSync(EXPECTED_SCORES, "utf8")) as { milvus: { id: number | string } };
  const docsIds = column(docs, "id");
  const varcharPk = column(varchar, "pk")[0];
  if (docsIds.length === 0 || varcharPk === undefined)
    throw new Error("the seeded docs_int64 or docs_varchar rows were not found; seed milvus first");
  return { version: String(version.version), docsIds, varcharPk, edgeId: String(scores.milvus.id) };
}

function runChild(names: readonly string[]): Map<string, { readonly runtime: string; readonly measured: Measured }> {
  const results = new Map<string, { readonly runtime: string; readonly measured: Measured }>();
  if (names.length === 0) return results;
  const directory = mkdtempSync(path.join(tmpdir(), "milvus-evidence-"));
  try {
    const contextFile = path.join(directory, "context.json");
    writeFileSync(contextFile, JSON.stringify(context));
    const child = spawnSync("node", [THIS_FILE, "--child", names.join(","), "--context", contextFile], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      timeout: 60 * 60 * 1000,
    });
    if (child.status !== 0) throw new Error(`the Node child exited ${child.status}: ${child.stderr}`);
    const report = JSON.parse(child.stdout.trim().split("\n").at(-1) as string) as {
      runtime: string;
      results: Record<string, Measured>;
    };
    for (const [name, measured] of Object.entries(report.results))
      results.set(name, { runtime: report.runtime, measured });
    return results;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function captureRun(): Promise<number> {
  const only = argument("--only")?.split(",");
  for (const service of Object.keys(CONTAINERS) as Service[]) checkService(service);
  context = {
    ...context,
    secretsDir: required("--secrets"),
    certsDir: required("--certs"),
    date: new Date().toISOString().slice(0, 10),
  };
  if (
    !existsSync(path.join(context.secretsDir, "reader.password")) ||
    !existsSync(path.join(context.certsDir, "ca.pem"))
  ) {
    throw new Error(
      "--secrets must hold reader.password and nobody.password, and --certs ca.pem and the client certificates",
    );
  }
  context = { ...context, ...(await readFacts()) };
  const selected = catalog().filter((capture) => only === undefined || only.includes(capture.name));
  if (only !== undefined && selected.length !== only.length)
    throw new Error(`--only names a capture the catalog does not hold: ${only.join(",")}`);
  const measured = new Map<string, Measured>();
  const problems: string[] = [];
  await setUp();
  try {
    for (const capture of selected) {
      // oxlint-disable-next-line no-await-in-loop -- one capture at a time, so each measures its own call alone.
      const result = await capture.run();
      measured.set(capture.name, result);
      console.log(`${capture.name}: ${result.outcome} in ${result.ms} ms`);
    }
    const children = runChild(selected.filter((capture) => capture.bothRuntimes).map((capture) => capture.name));
    for (const capture of selected)
      problems.push(...write(capture, measured.get(capture.name) as Measured, children.get(capture.name)));
  } finally {
    await tearDown();
  }
  for (const problem of problems) console.error(`PROBLEM ${problem}`);
  console.log(
    `${selected.length} captures written under ${path.relative(ROOT, FIXTURES)}; ${problems.length} problems`,
  );
  return problems.length === 0 ? 0 : 1;
}

async function childRun(): Promise<number> {
  const names = required("--child").split(",");
  context = JSON.parse(readFileSync(required("--context"), "utf8")) as Context;
  const results: Record<string, Measured> = {};
  for (const capture of catalog().filter((candidate) => names.includes(candidate.name))) {
    // oxlint-disable-next-line no-await-in-loop -- one capture at a time, as the Bun run makes them.
    results[capture.name] = await capture.run();
  }
  process.stdout.write(`${JSON.stringify({ runtime: RUNTIME, results })}\n`);
  return 0;
}

const main = argument("--child") === undefined ? captureRun : childRun;
main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  },
);
