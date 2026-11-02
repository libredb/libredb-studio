/**
 * Live check of MCP's `run_milvus_read` on Milvus 3.0.2, against the two servers
 * tests/fixtures/milvus/3.0.2/mcp-boundary/run.sh starts, written into that run.sh's directory as boundary.json.
 *
 *   tests/fixtures/milvus/3.0.2/mcp-boundary/run.sh
 *
 * WHY THIS EXISTS. `run_milvus_read` serves Milvus through the boundary agent mode uses: the connection is acquired
 * under the agent read-only profile, whose open has the server prove the user read-only, and every request goes
 * through the provider's `queryReadOnly`, which proves the user again, reads the request with the agent's reader,
 * sends only the closed table's metadata reads, and only for a collection the user's own ShowCollections lists, then
 * projects the answer to names, counts and flags. The admission in front of it is defence in depth. So this script
 * drives the MCP tool's own handler (`runStatement`) and `inspect_schema` through the factory's own profiled
 * acquisition, with the admission on and with it removed, against real servers:
 *
 *  - the open, through MCP: a user holding the read groups on two collections, one holding them on a database and one
 *    holding them on a second database only are served; root, a `CollectionReadWrite` user, a custom group's user and
 *    any user of a server with authorization off are refused before any request of the call is sent, each in its own
 *    proof sentence;
 *  - the reads: each admitted route answers, and no answer holds a stored marker or a credential;
 *  - the boundary, with the admission removed: a write, a Load, a query, a get and a search are refused by the
 *    provider's own reader before they are sent; with the admission in place each is refused before anything is
 *    acquired; the same write sent raw as the narrow user is refused PERMISSION_DENIED by the server, and as root it
 *    runs, the positive control; the server's state reads the same before and after the refused calls;
 *  - the data scope: the narrow user is listed its own collections and databases only; a collection outside its
 *    grants, an alias where a collection's name stands and a missing name are refused in one sentence, though the
 *    server answers them apart; an alias of a collection outside the grants and a missing alias read alike; a dbName
 *    naming another database and aliases/list naming no collection are refused before anything is sent; the
 *    one-database user reads only its database;
 *  - the alias repoint: while root repoints an alias between a listed collection and one outside the grants, parallel
 *    describes of the alias are answered only with the listed collection, or refused, never the other;
 *  - inspect_schema, through MCP, as the narrow user: its own collections and their fields, no collection outside its
 *    grants, no stored marker and no user name;
 *  - the limits: a partition list past the 1000-row provider budget is refused, never cut; a read past max_rows is cut
 *    to it; a read at the minimum timeout_ms while the server is paused is answered as the timeout, and a client
 *    cancel while it is paused is answered at once; the server answers the next call once it resumes, and no promise
 *    is left rejected unhandled.
 *
 * The environment names the servers: MILVUS_MCP_AUTH_TARGET and MILVUS_MCP_OPEN_TARGET (host:port, authorization on
 * and off), MILVUS_MCP_CONTAINER (the authorization-on container, paused for the limits), MILVUS_MCP_ROOT_PASSWORD
 * (generated per run by run.sh) and MILVUS_MCP_OUT (the directory to write). Every other user's password is made here
 * for the run and stays in this process; the script refuses to write a capture or print a line that holds one.
 *
 * Run by hand through run.sh, never by `bun run test`, which runs no file under tests/live/.
 */
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: a check records what the server holds then.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import { fromJSON, type MethodDefinition } from "@grpc/proto-loader";
import protobuf from "protobufjs";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import { MILVUS_AGENT_SCOPE_SENTENCES } from "@/lib/db/providers/vector/milvus/metadata-read";
import { MILVUS_AGENT_SENTENCES } from "@/lib/db/providers/vector/milvus/metadata-request";
import { MILVUS_PROOF_SENTENCES } from "@/lib/db/providers/vector/milvus/read-only-proof";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_CANCELLED_TEXT, type ToolResult } from "@/lib/mcp/output";
import { InspectSchemaInputSchema, inspectSchema } from "@/lib/mcp/tools/inspect-schema";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm, type McpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import { loadMilvusDescriptor } from "../../scripts/generate-milvus-descriptor.mjs";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const AUTH = env("MILVUS_MCP_AUTH_TARGET");
const OPEN = env("MILVUS_MCP_OPEN_TARGET");
const CONTAINER = env("MILVUS_MCP_CONTAINER");
const OUT = env("MILVUS_MCP_OUT");
const ROOT_PASSWORD = env("MILVUS_MCP_ROOT_PASSWORD");
const IMAGE = "milvusdb/milvus:v3.0.2@sha256:5f13bf88e110a517911c3e6dd8172454e90042c21e606a868084615a4302c8a0";
const DATE = new Date().toISOString().slice(0, 10);

const RUN_MILVUS_READ = mcpStatementArm("run_milvus_read");
const UNFENCED: McpStatementArm = { ...RUN_MILVUS_READ, fence: () => null };

// -- raw gRPC, for the seed, the state and the positive controls ------------------------------------------------------

const SERVICE = "milvus.proto.milvus.MilvusService";
const LOADER = { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true } as const;
const DESCRIPTOR = loadMilvusDescriptor();
const DEFINITION = fromJSON(DESCRIPTOR as Parameters<typeof fromJSON>[0], LOADER);
const TYPES = protobuf.Root.fromJSON(DESCRIPTOR as protobuf.INamespace);
TYPES.resolveAll();
const ANSWERS_A_STATUS = new Set([
  "CreateCollection",
  "CreateAlias",
  "AlterAlias",
  "CreateIndex",
  "CreatePartition",
  "CreateDatabase",
  "CreateCredential",
  "CreateRole",
  "OperateUserRole",
  "OperatePrivilegeV2",
  "CreatePrivilegeGroup",
  "OperatePrivilegeGroup",
  "LoadCollection",
]);

interface Login {
  readonly user: string;
  readonly password: string;
}

const SECRETS: string[] = [ROOT_PASSWORD];
const ROOT: Login = { user: "root", password: ROOT_PASSWORD };
function login(user: string): Login {
  const password = randomBytes(16).toString("hex");
  SECRETS.push(password);
  return { user, password };
}

const USERS = {
  few: login("lmcp_few"),
  dbro: login("lmcp_dbro"),
  onedb: login("lmcp_onedb"),
  rw: login("lmcp_rw"),
  custom: login("lmcp_custom"),
  open: login("lmcp_open"),
} as const;

async function raw(target: string, who: Login, rpc: string, request: object): Promise<Record<string, unknown>> {
  const client = new grpc.Client(`dns:${target}`, grpc.credentials.createInsecure(), {
    "grpc.enable_retries": 0,
    "grpc.use_local_subchannel_pool": 1,
  });
  try {
    const definition = (DEFINITION[SERVICE] as Record<string, MethodDefinition<object, object>>)[rpc];
    if (definition === undefined) throw new Error(`MilvusService has no ${rpc}`);
    const metadata = new grpc.Metadata();
    metadata.set("authorization", Buffer.from(`${who.user}:${who.password}`, "utf8").toString("base64"));
    return await new Promise((resolve, reject) => {
      client.makeUnaryRequest(
        definition.path,
        definition.requestSerialize,
        definition.responseDeserialize,
        request,
        metadata,
        { deadline: Date.now() + 30_000 },
        (error, value) => (error ? reject(error) : resolve(value as Record<string, unknown>)),
      );
    });
  } finally {
    client.close();
  }
}

/** Whether the server answered `rpc` with success. */
function succeeded(rpc: string, answer: Record<string, unknown>): boolean {
  const status = (ANSWERS_A_STATUS.has(rpc) ? answer : answer.status) as { code?: number } | undefined;
  return status?.code === 0;
}

async function must(rpc: string, request: object, target = AUTH): Promise<Record<string, unknown>> {
  const answer = await raw(target, ROOT, rpc, request);
  if (!succeeded(rpc, answer)) throw new Error(`${rpc} failed: ${JSON.stringify(answer).slice(0, 300)}`);
  return answer;
}

/** What `who` is answered for a raw call: success, the server's status code, or the gRPC code it was refused with. */
async function rawOutcome(who: Login, rpc: string, request: object): Promise<string> {
  try {
    const answer = await raw(AUTH, who, rpc, request);
    const status = (ANSWERS_A_STATUS.has(rpc) ? answer : answer.status) as { code?: number } | undefined;
    return status?.code === 0 ? "success" : `status ${status?.code}`;
  } catch (error) {
    return `grpc ${(error as { code?: number }).code}`;
  }
}

const kv = (record: Readonly<Record<string, string>>) => Object.entries(record).map(([key, value]) => ({ key, value }));

function schema(name: string): Buffer {
  const type = TYPES.lookupType("milvus.proto.schema.CollectionSchema");
  return Buffer.from(
    type
      .encode(
        type.fromObject({
          name,
          fields: [
            { name: "id", is_primary_key: true, data_type: "Int64" },
            { name: "vec", data_type: "FloatVector", type_params: kv({ dim: "4" }) },
            { name: "title", data_type: "VarChar", type_params: kv({ max_length: "64" }) },
          ],
        }),
      )
      .finish(),
  );
}

/** A stored value no metadata answer may carry; a plain marker, not a secret. */
const MARKER = "lmcp-stored-marker";
const DB = "default";
const DB_A = "lmcp_db_a";
const DB_B = "lmcp_db_b";
const C1 = "lmcp_c1";
const C2 = "lmcp_c2";
const C3 = "lmcp_c3";
const MANY = "lmcp_many";
const SCRATCH = "lmcp_scratch";
const A1 = "lmcp_a1";
const B1 = "lmcp_b1";
const ALIAS_C1 = "lmcp_alias_c1";
const ALIAS_C3 = "lmcp_alias_c3";
const ALIAS_MOVING = "lmcp_alias_moving";
const MISSING = "lmcp_missing";

async function collection(db: string, name: string): Promise<void> {
  await must("CreateCollection", { db_name: db, collection_name: name, schema: schema(name), shards_num: 1 });
  await must("CreateIndex", {
    db_name: db,
    collection_name: name,
    field_name: "vec",
    index_name: "vec_idx",
    extra_params: kv({ index_type: "FLAT", metric_type: "L2", params: "{}" }),
  });
  await must("Insert", {
    db_name: db,
    collection_name: name,
    num_rows: 2,
    fields_data: [
      { type: "Int64", field_name: "id", scalars: { long_data: { data: ["1", "2"] } } },
      {
        type: "FloatVector",
        field_name: "vec",
        vectors: { dim: "4", float_vector: { data: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] } },
      },
      { type: "VarChar", field_name: "title", scalars: { string_data: { data: [MARKER, MARKER] } } },
    ],
  });
}

async function grant(role: string, privilege: string, db: string, name = "*"): Promise<void> {
  await must("OperatePrivilegeV2", {
    role: { name: role },
    grantor: { privilege: { name: privilege } },
    type: "Grant",
    db_name: db,
    collection_name: name,
  });
}

async function user(who: Login, role: string): Promise<void> {
  await must("CreateCredential", {
    username: who.user,
    password: Buffer.from(who.password, "utf8").toString("base64"),
  });
  await must("CreateRole", { entity: { name: role } });
  await must("OperateUserRole", { username: who.user, role_name: role, type: "AddUserToRole" });
}

async function seedServer(): Promise<void> {
  // A user of the server with authorization off, which answers it whatever it may do.
  await must(
    "CreateCredential",
    { username: USERS.open.user, password: Buffer.from(USERS.open.password, "utf8").toString("base64") },
    OPEN,
  );
  await must("CreateDatabase", { db_name: DB_A });
  await must("CreateDatabase", { db_name: DB_B });
  for (const name of [C1, C2, C3, MANY, SCRATCH]) await collection(DB, name);
  await collection(DB_A, A1);
  await collection(DB_B, B1);
  await must("CreateAlias", { db_name: DB, collection_name: C1, alias: ALIAS_C1 });
  await must("CreateAlias", { db_name: DB, collection_name: C3, alias: ALIAS_C3 });
  await must("CreateAlias", { db_name: DB, collection_name: C1, alias: ALIAS_MOVING });
  // 1,001 partitions besides _default: past the provider's 1000-row budget for one call.
  for (let n = 0; n < 1_001; n++) {
    await must("CreatePartition", { db_name: DB, collection_name: MANY, partition_name: `p${n}` });
  }
  await must("LoadCollection", { db_name: DB, collection_name: C1 });
  // Loaded before the first check, so the state the boundary check compares does not move under it.
  for (let waited = 0; ; waited += 500) {
    const progress = await must("GetLoadingProgress", { db_name: DB, collection_name: C1 });
    if (progress.progress === "100") break;
    if (waited > 120_000) throw new Error(`${C1} did not load within 120 s`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await user(USERS.few, "lmcp_few_role");
  for (const name of [C1, C2, MANY]) await grant("lmcp_few_role", "CollectionReadOnly", DB, name);
  await grant("lmcp_few_role", "ShowCollections", DB);
  await grant("lmcp_few_role", "DescribeDatabase", DB);
  await user(USERS.dbro, "lmcp_dbro_role");
  await grant("lmcp_dbro_role", "DatabaseReadOnly", DB);
  await grant("lmcp_dbro_role", "CollectionReadOnly", DB);
  await user(USERS.onedb, "lmcp_onedb_role");
  await grant("lmcp_onedb_role", "DatabaseReadOnly", DB_A);
  await grant("lmcp_onedb_role", "CollectionReadOnly", DB_A);
  await user(USERS.rw, "lmcp_rw_role");
  await grant("lmcp_rw_role", "CollectionReadWrite", DB);
  await must("CreatePrivilegeGroup", { group_name: "lmcp_read_group" });
  await must("OperatePrivilegeGroup", {
    group_name: "lmcp_read_group",
    privileges: [{ name: "Query" }, { name: "DescribeCollection" }, { name: "GetLoadState" }],
    type: "AddPrivilegesToGroup",
  });
  await user(USERS.custom, "lmcp_custom_role");
  await grant("lmcp_custom_role", "lmcp_read_group", DB);
}

/** What root reads of the server's state: databases, collections, aliases, partitions and load states. */
async function state(): Promise<string> {
  const parts: unknown[] = [];
  parts.push((await must("ListDatabases", {})).db_names);
  for (const db of [DB, DB_A, DB_B]) {
    const names = ((await must("ShowCollections", { db_name: db })).collection_names as string[]).sort();
    parts.push(db, names, ((await must("ListAliases", { db_name: db })).aliases as string[]).sort());
    for (const name of names) {
      parts.push(
        name,
        ((await must("ShowPartitions", { db_name: db, collection_name: name })).partition_names as string[]).length,
        (await must("GetLoadState", { db_name: db, collection_name: name })).state,
      );
    }
  }
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

// -- MCP ---------------------------------------------------------------------------------------------------------------

type Principal = keyof typeof USERS | "root";

function seed(principal: Principal, database = principal === "onedb" ? DB_A : DB): ManagedConnection {
  const who = principal === "root" ? ROOT : USERS[principal];
  const [host, port] = (principal === "open" ? OPEN : AUTH).split(":");
  return {
    id: `seed:live-milvus-${principal}`,
    name: `milvus ${principal}`,
    seedId: `live-milvus-${principal}`,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "milvus",
    host,
    port: Number(port),
    user: who.user,
    password: who.password,
    database,
    createdAt: new Date(0),
  } as unknown as ManagedConnection;
}

function contextFor(connection: ManagedConnection, acquired: ExecutionProfile[]): McpConnectionContext {
  return {
    caller: { username: "live", role: "admin" },
    visibleConnections: async () => [connection],
    resolve: async () => connection,
    acquire: (target: ManagedConnection, profile: ExecutionProfile) => {
      acquired.push(profile);
      return acquireExecutionProfileProvider(target, profile);
    },
  } as unknown as McpConnectionContext;
}

/** One run_milvus_read call on `principal`'s seed, through the factory's own profiled acquisition. */
async function mcp(
  principal: Principal,
  statement: string,
  { arm = RUN_MILVUS_READ, timeoutMs = 10_000, maxRows = 100, signal = new AbortController().signal } = {},
): Promise<{ readonly result: ToolResult; readonly acquired: ExecutionProfile[]; readonly ms: number }> {
  const connection = seed(principal);
  const acquired: ExecutionProfile[] = [];
  const input = arm.inputSchema.parse({
    connection_id: connection.id,
    statement,
    timeout_ms: timeoutMs,
    max_rows: maxRows,
  }) as McpStatementInput;
  const started = Date.now();
  const result = await runStatement(arm, input, { context: contextFor(connection, acquired), signal });
  answers.push(JSON.stringify(result));
  return { result, acquired, ms: Date.now() - started };
}

async function inspect(principal: Principal, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const connection = seed(principal);
  const input = InspectSchemaInputSchema.parse({ connection_id: connection.id, ...args });
  const result = await inspectSchema(input, {
    context: contextFor(connection, []),
    signal: new AbortController().signal,
  });
  answers.push(JSON.stringify(result));
  return result;
}

const request = (route: string, body?: unknown) =>
  body === undefined ? `POST /v2/vectordb/${route}` : `POST /v2/vectordb/${route}\n${JSON.stringify(body)}`;

const textOf = (result: ToolResult): string =>
  result.content.map((part) => ("text" in part ? part.text : "")).join("\n");
const rowsOf = (result: ToolResult): Record<string, unknown>[] =>
  (result.structuredContent as { rows?: Record<string, unknown>[] } | undefined)?.rows ?? [];
const column = (result: ToolResult, name: string): string[] => rowsOf(result).map((row) => String(row[name]));
const ours = (names: string[]): string[] => names.filter((name) => name.startsWith("lmcp_")).sort();

interface Check {
  readonly check: string;
  readonly ok: boolean;
  readonly detail: unknown;
}
const checks: Check[] = [];
const answers: string[] = [];

function check(name: string, ok: boolean, detail: unknown): void {
  const line = `${ok ? "PASS" : "FAIL"} ${name}`;
  if (SECRETS.some((secret) => line.includes(secret) || JSON.stringify(detail).includes(secret))) {
    throw new Error("a check would carry a credential; nothing was printed");
  }
  console.log(line);
  checks.push({ check: name, ok, detail });
}

function docker(args: readonly string[]): void {
  const result = spawnSync("docker", args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`docker ${args[0]} exited ${result.status}`);
}

// -- the checks ----------------------------------------------------------------------------------------------------------

async function opens(): Promise<void> {
  for (const principal of ["few", "dbro", "onedb"] as const) {
    const answered = await mcp(principal, request("collections/list"));
    check(`${principal} passes the read-only proof and is served`, answered.result.isError !== true, {
      acquired: answered.acquired,
      rows: rowsOf(answered.result),
    });
  }
  const refusals: ReadonlyArray<readonly [Principal, string]> = [
    ["root", MILVUS_PROOF_SENTENCES.root],
    ["rw", MILVUS_PROOF_SENTENCES.grant("CollectionReadWrite")],
    ["custom", MILVUS_PROOF_SENTENCES.grant("lmcp_read_group")],
    ["open", MILVUS_PROOF_SENTENCES.unenforced],
  ];
  for (const [principal, sentence] of refusals) {
    const answered = await mcp(principal, request("collections/list"));
    check(
      `${principal} is refused at the open in its proof sentence`,
      answered.result.isError === true && textOf(answered.result).includes(sentence),
      { answer: textOf(answered.result), acquired: answered.acquired },
    );
  }
}

async function reads(): Promise<void> {
  const forms: ReadonlyArray<readonly [string, string]> = [
    ["databases/list", request("databases/list")],
    ["databases/describe", request("databases/describe", { dbName: DB })],
    ["collections/list", request("collections/list")],
    ["collections/describe", request("collections/describe", { collectionName: C1 })],
    ["collections/get_stats", request("collections/get_stats", { collectionName: C1 })],
    ["collections/get_load_state", request("collections/get_load_state", { collectionName: C1 })],
    ["partitions/list", request("partitions/list", { collectionName: C1 })],
    ["indexes/list", request("indexes/list", { collectionName: C1 })],
    ["indexes/describe", request("indexes/describe", { collectionName: C1, indexName: "vec_idx" })],
    ["aliases/list", request("aliases/list", { collectionName: C1 })],
    ["aliases/describe", request("aliases/describe", { aliasName: ALIAS_C1 })],
  ];
  for (const [route, statement] of forms) {
    const answered = await mcp("few", statement);
    check(`${route} answers the narrow user`, answered.result.isError !== true && rowsOf(answered.result).length > 0, {
      rows: rowsOf(answered.result),
      answer: answered.result.isError === true ? textOf(answered.result) : undefined,
    });
  }
}

async function boundary(): Promise<void> {
  const before = await state();
  const refused: ReadonlyArray<readonly [string, string]> = [
    ["a collection drop", request("collections/drop", { collectionName: SCRATCH })],
    ["a Load", request("collections/load", { collectionName: C2 })],
    ["a query of stored values", request("entities/query", { collectionName: C1, filter: "id > 0" })],
    ["a get", request("entities/get", { collectionName: C1, id: 1 })],
    [
      "a search",
      request("entities/search", { collectionName: C1, annsField: "vec", data: [[0.1, 0.2, 0.3, 0.4]], limit: 1 }),
    ],
  ];
  for (const [what, statement] of refused) {
    const fenced = await mcp("few", statement);
    const unfenced = await mcp("few", statement, { arm: UNFENCED });
    check(
      `${what} is refused by the admission before anything is acquired, and by the provider's reader with it removed`,
      fenced.result.isError === true &&
        fenced.acquired.length === 0 &&
        textOf(fenced.result).includes("The request was refused before it reached the server") &&
        unfenced.result.isError === true &&
        textOf(unfenced.result).includes("The statement was refused before it reached the database"),
      { fenced: textOf(fenced.result), unfenced: textOf(unfenced.result), acquired: unfenced.acquired },
    );
  }
  const partition = { db_name: DB, collection_name: SCRATCH, partition_name: "lmcp_control" };
  const narrow = await rawOutcome(USERS.few, "CreatePartition", partition);
  check("the same write sent raw as the narrow user is refused by the server", narrow === "grpc 7", { narrow });
  const after = await state();
  check("the server's state reads the same before and after the refused calls", before === after, { before, after });
  const control = await rawOutcome(ROOT, "CreatePartition", partition);
  check("the write runs as root, the positive control", control === "success", { control });
}

async function dataScope(): Promise<void> {
  const listed = await mcp("few", request("collections/list"));
  check(
    "the narrow user is listed only its own collections",
    ours(column(listed.result, "collection")).join() === [C1, C2, MANY].join(),
    {
      collections: column(listed.result, "collection"),
    },
  );
  const databases = await mcp("onedb", request("databases/list"));
  check("the one-database user is listed only its database", column(databases.result, "database").join() === DB_A, {
    databases: column(databases.result, "database"),
  });
  const own = await mcp("onedb", request("collections/list"));
  check("the one-database user's collections are its database's", column(own.result, "collection").join() === A1, {
    collections: column(own.result, "collection"),
  });
  const rawAnswers = {
    ungranted: await rawOutcome(USERS.few, "DescribeCollection", { db_name: DB, collection_name: C3 }),
    missing: await rawOutcome(USERS.few, "DescribeCollection", { db_name: DB, collection_name: MISSING }),
    alias: await rawOutcome(USERS.few, "DescribeCollection", { db_name: DB, collection_name: ALIAS_C3 }),
    otherDb: await rawOutcome(USERS.onedb, "DescribeCollection", { db_name: DB_B, collection_name: B1 }),
  };
  check(
    "raw, the server describes a collection outside the grants, an alias and another database's collection, and refuses a missing one",
    rawAnswers.ungranted === "success" &&
      rawAnswers.alias === "success" &&
      rawAnswers.otherDb === "success" &&
      rawAnswers.missing !== "success",
    rawAnswers,
  );
  const sentences: string[] = [];
  for (const name of [C3, ALIAS_C3, ALIAS_C1, MISSING]) {
    const answered = await mcp("few", request("collections/describe", { collectionName: name }));
    const text = textOf(answered.result);
    check(
      `${name} in a collection's place is refused in the scope sentence, naming no user`,
      answered.result.isError === true &&
        text.includes(MILVUS_AGENT_SCOPE_SENTENCES.collection(name)) &&
        !text.includes(USERS.few.user),
      { answer: text },
    );
    sentences.push(text.replaceAll(name, "<name>"));
  }
  check("those refusals read alike", new Set(sentences).size === 1, { sentences });
  const outsideAlias = await mcp("few", request("aliases/describe", { aliasName: ALIAS_C3 }));
  const missingAlias = await mcp("few", request("aliases/describe", { aliasName: MISSING }));
  check(
    "an alias of a collection outside the grants and a missing alias read alike",
    textOf(outsideAlias.result).replaceAll(ALIAS_C3, "<a>") ===
      textOf(missingAlias.result).replaceAll(MISSING, "<a>") &&
      textOf(outsideAlias.result).includes(MILVUS_AGENT_SCOPE_SENTENCES.alias(ALIAS_C3)),
    { outside: textOf(outsideAlias.result), missing: textOf(missingAlias.result) },
  );
  const otherDb = await mcp("onedb", request("collections/describe", { dbName: DB_B, collectionName: B1 }));
  check(
    "a dbName naming another database is refused before anything is sent",
    otherDb.result.isError === true && textOf(otherDb.result).includes(MILVUS_AGENT_SENTENCES.database),
    { answer: textOf(otherDb.result) },
  );
  const otherDbUnfenced = await mcp("onedb", request("collections/describe", { dbName: DB_B, collectionName: B1 }), {
    arm: UNFENCED,
  });
  check(
    "with the admission removed, the provider still refuses the other database",
    otherDbUnfenced.result.isError === true && textOf(otherDbUnfenced.result).includes(MILVUS_AGENT_SENTENCES.database),
    { answer: textOf(otherDbUnfenced.result) },
  );
  const allAliases = await mcp("few", request("aliases/list"));
  const allAliasesUnfenced = await mcp("few", request("aliases/list"), { arm: UNFENCED });
  check(
    "aliases/list naming no collection is refused, with the admission and without it",
    allAliases.acquired.length === 0 &&
      textOf(allAliases.result).includes(MILVUS_AGENT_SENTENCES.aliasList) &&
      textOf(allAliasesUnfenced.result).includes(MILVUS_AGENT_SENTENCES.aliasList),
    { fenced: textOf(allAliases.result), unfenced: textOf(allAliasesUnfenced.result) },
  );
}

async function repoint(): Promise<void> {
  const moving = { on: true };
  const mover = (async () => {
    let target = C3;
    while (moving.on) {
      await must("AlterAlias", { db_name: DB, collection_name: target, alias: ALIAS_MOVING });
      target = target === C3 ? C1 : C3;
    }
  })();
  const seen = new Set<string>();
  for (let round = 0; round < 6; round++) {
    const reads = await Promise.all(
      Array.from({ length: 4 }, () => mcp("few", request("aliases/describe", { aliasName: ALIAS_MOVING }))),
    );
    for (const answered of reads) {
      seen.add(answered.result.isError === true ? "refused" : column(answered.result, "collection").join());
    }
    const describes = await Promise.all(
      Array.from({ length: 4 }, () => mcp("few", request("collections/describe", { collectionName: ALIAS_MOVING }))),
    );
    for (const answered of describes) {
      seen.add(
        answered.result.isError === true ? "describe refused" : `describe ${column(answered.result, "name")[0]}`,
      );
    }
  }
  moving.on = false;
  await mover;
  check(
    "while the alias moves, reads through it answer only the listed collection, or are refused, never the other",
    ![...seen].some((outcome) => outcome.includes(C3)),
    { seen: [...seen].sort() },
  );
}

async function inspected(): Promise<void> {
  const result = await inspect("few");
  const text = JSON.stringify(result);
  const tables = ((result.structuredContent as { tables?: { name: string; columns?: { name: string }[] }[] })?.tables ??
    []) as { name: string; columns?: { name: string }[] }[];
  check(
    "inspect_schema lists the narrow user its own collections and their fields, nothing else, no value and no user name",
    result.isError !== true &&
      ours(tables.map((table) => table.name)).join() === [C1, C2, MANY].join() &&
      tables.every((table) => (table.columns ?? []).some((col) => col.name === "vec")) &&
      !text.includes(MARKER) &&
      !text.includes(USERS.few.user),
    { tables: tables.map((table) => [table.name, (table.columns ?? []).map((col) => col.name)]) },
  );
}

async function limits(): Promise<void> {
  const many = await mcp("few", request("partitions/list", { collectionName: MANY }));
  check(
    "a partition list past the 1000-row provider budget is refused, never cut",
    many.result.isError === true && textOf(many.result).includes("1000 rows"),
    { answer: textOf(many.result) },
  );
  const cut = await mcp("few", request("collections/list"), { maxRows: 1 });
  check(
    "a read past max_rows is cut to it and says how to read a narrower route",
    rowsOf(cut.result).length === 1 &&
      String((cut.result.structuredContent as { hint?: string }).hint).includes("since a Milvus read is never paged"),
    { structured: cut.result.structuredContent },
  );
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(String(reason));
  process.on("unhandledRejection", onUnhandled);
  docker(["pause", CONTAINER]);
  try {
    const timed = await mcp("few", request("collections/list"), { timeoutMs: 500 });
    check(
      "a read at the minimum timeout_ms while the server is paused is answered as the timeout",
      timed.result.isError === true && textOf(timed.result).includes("500 ms") && timed.ms < 3_000,
      { answer: textOf(timed.result), ms: timed.ms },
    );
    const controller = new AbortController();
    const cancelled = mcp("few", request("collections/list"), { timeoutMs: 5_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    const answered = await cancelled;
    check(
      "a client cancel while the server is paused ends the wait at once, answered as the cancellation",
      answered.result.isError === true && textOf(answered.result) === MCP_CANCELLED_TEXT && answered.ms < 2_000,
      { answer: textOf(answered.result), ms: answered.ms },
    );
    // The provider's own calls end at the time left of timeout_ms; wait past it for anything left unhandled.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
  } finally {
    docker(["unpause", CONTAINER]);
  }
  const next = await mcp("few", request("collections/list"));
  check("the server answers the next call once it resumes", next.result.isError !== true, {
    rows: rowsOf(next.result),
    ms: next.ms,
  });
  process.off("unhandledRejection", onUnhandled);
  check("no promise was left rejected unhandled by the timeout or the cancel", unhandled.length === 0, { unhandled });
}

async function main(): Promise<void> {
  await seedServer();
  await opens();
  await reads();
  await boundary();
  await dataScope();
  await repoint();
  await inspected();
  await limits();
  const joined = answers.join("\n");
  const leaks = [MARKER, ...SECRETS].filter((marker) => joined.includes(marker));
  check("no MCP answer holds a stored marker or a credential", leaks.length === 0, {
    leaks: leaks.map((leak) => (leak === MARKER ? leak : "(a credential)")),
  });
  await clearProviderCache();
  const capture = {
    $captured: {
      image: IMAGE,
      version: "3.0.2",
      date: DATE,
      runtime: `bun ${Bun.version}`,
      principals:
        "few: CollectionReadOnly on default/lmcp_c1, lmcp_c2 and lmcp_many with ShowCollections and DescribeDatabase on default/*; dbro: DatabaseReadOnly and CollectionReadOnly on default/*; onedb: both groups on lmcp_db_a/* only; rw: CollectionReadWrite on default/*; custom: a custom group on default/*; open: any user of a server with authorization off; root",
      note: "Each check drives run_milvus_read's handler, or inspect_schema's, through the factory's agent acquisition, with the admission on and, where it says so, removed. Passwords are made for the run and never recorded.",
    },
    checks,
  };
  const text = `${JSON.stringify(capture, null, 2)}\n`;
  if (SECRETS.some((secret) => text.includes(secret))) throw new Error("the capture holds a credential; not written");
  writeFileSync(path.join(OUT, "boundary.json"), text);
  const failed = checks.filter((entry) => !entry.ok).length;
  console.log(`${checks.length - failed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

await main();
