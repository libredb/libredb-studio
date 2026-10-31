/**
 * Seeds the Milvus servers 3.0.2/agent-boundary/run.sh started, sends the agent boundary plan, and writes one capture
 * per call into 3.0.2/agent-boundary/.
 *
 *   bun tests/fixtures/milvus/agent-boundary-probe.ts
 *
 * The environment carries MILVUS_AUTH_TARGET (authorization on), MILVUS_OPEN_TARGET (authorization off) and
 * MILVUS_ROOT_PASSWORD, root's password on both, generated per run by run.sh. Every other user's password is generated
 * here for the run. A capture records the principal's name and rights, never a password or a token, and the script
 * refuses to write a file that holds any form of any credential it sent. It drives @grpc/grpc-js with the definition
 * the descriptor generator builds, as tests/live/milvus-evidence.ts does, and sends every call raw: no Studio check
 * stands in front of it, which is the point, since what is measured is what the server does on its own.
 *
 * Run by hand through run.sh, never by `bun run test`, which runs only `*.test.ts` files.
 */
// oxlint-disable no-await-in-loop -- each step runs after the one before, on purpose: a capture records what the server holds then.
import { randomBytes } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as grpc from "@grpc/grpc-js";
import { fromJSON, type MethodDefinition } from "@grpc/proto-loader";
import protobuf from "protobufjs";
import { loadMilvusDescriptor } from "../../../scripts/generate-milvus-descriptor.mjs";

const VERSION = "3.0.2";
const IMAGE = "milvusdb/milvus:v3.0.2@sha256:5f13bf88e110a517911c3e6dd8172454e90042c21e606a868084615a4302c8a0";
const OUT = path.join(import.meta.dir, VERSION, "agent-boundary");
const DATE = new Date().toISOString().slice(0, 10);
const SERVICE = "milvus.proto.milvus.MilvusService";
const LOADER = { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true } as const;
const DESCRIPTOR = loadMilvusDescriptor();
const DEFINITION = fromJSON(DESCRIPTOR as Parameters<typeof fromJSON>[0], LOADER);
const TYPES = protobuf.Root.fromJSON(DESCRIPTOR as protobuf.INamespace);
TYPES.resolveAll();

/** The RPCs whose answer is a `common.Status` itself. */
const ANSWERS_A_STATUS = new Set([
  "CreateCollection",
  "DropCollection",
  "CreateAlias",
  "DropAlias",
  "LoadCollection",
  "ReleaseCollection",
  "CreateIndex",
  "CreatePartition",
  "CreateDatabase",
  "CreateCredential",
  "CreateRole",
  "OperateUserRole",
  "OperatePrivilegeV2",
  "CreatePrivilegeGroup",
  "OperatePrivilegeGroup",
]);

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const TARGETS = { auth: env("MILVUS_AUTH_TARGET"), open: env("MILVUS_OPEN_TARGET") } as const;
type Server = keyof typeof TARGETS;

/** Every form of every credential the run sent; none may appear in a written capture. */
const SECRETS = new Set<string>();
function remember(secret: string): void {
  SECRETS.add(secret);
  SECRETS.add(Buffer.from(secret, "utf8").toString("base64").replace(/=+$/, ""));
}

const ROOT_PASSWORD = env("MILVUS_ROOT_PASSWORD");
remember(ROOT_PASSWORD);

/** A principal: its server, its user (none for an anonymous call) and the rights a capture states. */
interface Principal {
  readonly server: Server;
  readonly user?: string;
  readonly password?: string;
  readonly rights: string;
}

function generated(): string {
  const value = randomBytes(16).toString("hex");
  remember(value);
  return value;
}

const USERS = {
  reader: "agent_reader",
  dbro: "agent_dbro",
  rw: "agent_rw",
  admin: "agent_admin",
  custom: "agent_custom",
  clusterro: "agent_clusterro",
  nobody: "agent_nobody",
  midrun: "agent_midrun",
  elsewhere: "agent_elsewhere",
  rwother: "agent_rwother",
} as const;

const PASSWORDS: Readonly<Record<keyof typeof USERS, string>> = Object.fromEntries(
  Object.keys(USERS).map((key) => [key, generated()]),
) as Record<keyof typeof USERS, string>;

const PRINCIPALS: Readonly<Record<string, Principal>> = {
  root: { server: "auth", user: "root", password: ROOT_PASSWORD, rights: "the built-in root user" },
  reader: {
    server: "auth",
    user: USERS.reader,
    password: PASSWORDS.reader,
    rights:
      "role agent_reader_role: the CollectionReadOnly group and the ShowCollections and DescribeDatabase privileges on default/*",
  },
  dbro: {
    server: "auth",
    user: USERS.dbro,
    password: PASSWORDS.dbro,
    rights: "role agent_dbro_role: the DatabaseReadOnly group on default/*",
  },
  rw: {
    server: "auth",
    user: USERS.rw,
    password: PASSWORDS.rw,
    rights: "role agent_rw_role: the CollectionReadWrite group on default/*",
  },
  admin: { server: "auth", user: USERS.admin, password: PASSWORDS.admin, rights: "the built-in role admin" },
  custom: {
    server: "auth",
    user: USERS.custom,
    password: PASSWORDS.custom,
    rights:
      "role agent_custom_role: the custom group agent_read_group (Query, DescribeCollection, GetLoadState) on default/*",
  },
  clusterro: {
    server: "auth",
    user: USERS.clusterro,
    password: PASSWORDS.clusterro,
    rights: "role agent_clusterro_role: the ClusterReadOnly group on */*",
  },
  nobody: { server: "auth", user: USERS.nobody, password: PASSWORDS.nobody, rights: "no role" },
  midrun: {
    server: "auth",
    user: USERS.midrun,
    password: PASSWORDS.midrun,
    rights: "role agent_midrun_role: the CollectionReadOnly group on default/*, then Insert granted during the run",
  },
  elsewhere: {
    server: "auth",
    user: USERS.elsewhere,
    password: PASSWORDS.elsewhere,
    rights:
      "role agent_elsewhere_role: the CollectionReadOnly group on default/* and the Insert privilege on agent_other_db/*",
  },
  rwother: {
    server: "auth",
    user: USERS.rwother,
    password: PASSWORDS.rwother,
    rights:
      "role agent_rwother_role: the CollectionReadWrite group on agent_other_db/*, the database its connection would name",
  },
  "open-reader": {
    server: "open",
    user: USERS.reader,
    password: PASSWORDS.reader,
    rights: "agent_reader with the same role, on a server with authorization off",
  },
  "open-anonymous": { server: "open", rights: "no authorization metadata, on a server with authorization off" },
};

const ROOT: Principal = PRINCIPALS.root as Principal;
const OPEN_ROOT: Principal = { server: "open", user: "root", password: ROOT_PASSWORD, rights: "root" };

function method(rpc: string): MethodDefinition<object, object> {
  const found = (DEFINITION[SERVICE] as Record<string, MethodDefinition<object, object>>)[rpc];
  if (found === undefined) throw new Error(`MilvusService has no ${rpc}`);
  return found;
}

/** One call: resolves the decoded answer, rejects grpc-js's error. */
async function rawCall(principal: Principal, rpc: string, request: object): Promise<object> {
  const client = new grpc.Client(`dns:${TARGETS[principal.server]}`, grpc.credentials.createInsecure(), {
    "grpc.enable_retries": 0,
    "grpc.max_receive_message_length": 16 * 1024 * 1024,
    "grpc.use_local_subchannel_pool": 1,
  });
  try {
    const definition = method(rpc);
    const metadata = new grpc.Metadata();
    if (principal.user !== undefined && principal.password !== undefined) {
      const pair = `${principal.user}:${principal.password}`;
      remember(pair);
      metadata.set("authorization", Buffer.from(pair, "utf8").toString("base64"));
    }
    return await new Promise<object>((resolve, reject) => {
      client.makeUnaryRequest(
        definition.path,
        definition.requestSerialize,
        definition.responseDeserialize,
        request,
        metadata,
        { deadline: Date.now() + 30_000 },
        (error, value) => (error ? reject(error) : resolve(value as object)),
      );
    });
  } finally {
    client.close();
  }
}

interface Status {
  readonly code: number;
  readonly error_code: string;
}

function statusOf(rpc: string, answer: object): Status | undefined {
  return ANSWERS_A_STATUS.has(rpc) ? (answer as Status) : ((answer as { status?: Status | null }).status ?? undefined);
}

function succeeded(rpc: string, answer: object): boolean {
  const status = statusOf(rpc, answer);
  return status !== undefined && status.code === 0 && status.error_code === "Success";
}

/** JSON-safe: bytes as { $bytes }. */
function encode(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === "object") {
    // A request's password is never recorded, not even the write probe's placeholder, so no capture holds one.
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, key === "password" ? "(not recorded)" : encode(inner)]),
    );
  }
  return value;
}

interface Measured {
  readonly outcome: "pass" | "fail";
  readonly payload: unknown;
}

async function call(principal: Principal, rpc: string, request: object): Promise<Measured> {
  try {
    const answer = await rawCall(principal, rpc, request);
    return { outcome: succeeded(rpc, answer) ? "pass" : "fail", payload: encode(answer) };
  } catch (error) {
    const failed = error as Error & { code?: number; details?: string };
    return {
      outcome: "fail",
      payload: { error: { code: failed.code ?? null, details: failed.details ?? null, message: failed.message } },
    };
  }
}

async function must(principal: Principal, rpc: string, request: object): Promise<Record<string, unknown>> {
  const measured = await call(principal, rpc, request);
  if (measured.outcome !== "pass") throw new Error(`${rpc} failed: ${JSON.stringify(measured.payload)}`);
  return measured.payload as Record<string, unknown>;
}

function assertNoSecret(text: string, file: string): void {
  for (const secret of SECRETS) {
    if (text.includes(secret)) throw new Error(`${file} would hold a form of a credential; nothing was written`);
  }
}

/** Writes one capture: what was sent, by whom, and what the server answered. */
async function capture(name: string, who: string, rpc: string, request: object, surface: string): Promise<Measured> {
  const principal = PRINCIPALS[who] ?? (who === "open-root" ? OPEN_ROOT : undefined);
  if (principal === undefined) throw new Error(`no principal ${who}`);
  // Milvus admits one Flush per collection every 10 seconds, so a Flush waits out the last one's window.
  if (rpc === "Flush") await sleep(11_000);
  const measured = await call(principal, rpc, request);
  const file = path.join(OUT, `${name}-${who}.json`);
  const text = `${JSON.stringify(
    {
      $captured: {
        server: principal.server === "auth" ? "authorization on" : "authorization off",
        image: IMAGE,
        version: VERSION,
        date: DATE,
        runtime: `bun ${Bun.version}`,
        rpc,
        principal: who,
        rights: principal.rights,
        surface,
        request: encode(request),
      },
      outcome: measured.outcome,
      payload: measured.payload,
    },
    null,
    2,
  )}\n`;
  assertNoSecret(text, file);
  writeFileSync(file, text);
  return measured;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const kv = (record: Readonly<Record<string, string>>) => Object.entries(record).map(([key, value]) => ({ key, value }));

// -- the seed ---------------------------------------------------------------------------------------------------------

const DB = "default";
/** A second database, where two principals that read `default` only, or nothing there, may write. */
const OTHER_DB = "agent_other_db";
const OTHER_DOCS = "agent_other_docs";
/** The principals whose grants lie outside `default`: only the proof's reads and their writes there are sent as them. */
const ELSEWHERE = ["elsewhere", "rwother"];
const DOCS = "agent_docs";
const SCRATCH = "agent_scratch";
const ALIAS = "agent_alias";

/** Stored values a metadata-only answer must never carry; each is a plain marker, not a secret. */
const STORED = {
  title: "stored-title-value",
  label: "stored-label-value",
  defaultLabel: "stored-default-value",
  dynamic: "stored-dynamic-value",
  text: "stored text about vectors",
} as const;

function schemaBytes(schema: object): Buffer {
  const type = TYPES.lookupType("milvus.proto.schema.CollectionSchema");
  return Buffer.from(type.encode(type.fromObject(schema)).finish());
}

function docsSchema(): Buffer {
  return schemaBytes({
    name: DOCS,
    description: "agent boundary documents",
    enable_dynamic_field: true,
    fields: [
      { name: "id", is_primary_key: true, data_type: "Int64" },
      { name: "vec", data_type: "FloatVector", type_params: kv({ dim: "4" }) },
      { name: "title", data_type: "VarChar", type_params: kv({ max_length: "128" }) },
      {
        name: "label",
        data_type: "VarChar",
        type_params: kv({ max_length: "128" }),
        default_value: { string_data: STORED.defaultLabel },
      },
      {
        name: "text",
        data_type: "VarChar",
        type_params: kv({ max_length: "256", enable_analyzer: "true" }),
      },
      { name: "sparse", data_type: "SparseFloatVector", is_function_output: true },
    ],
    functions: [{ name: "text_bm25", type: "BM25", input_field_names: ["text"], output_field_names: ["sparse"] }],
  });
}

function scratchSchema(name: string = SCRATCH): Buffer {
  return schemaBytes({
    name,
    fields: [
      { name: "id", is_primary_key: true, data_type: "Int64" },
      { name: "vec", data_type: "FloatVector", type_params: kv({ dim: "4" }) },
      { name: "title", data_type: "VarChar", type_params: kv({ max_length: "128" }) },
    ],
  });
}

const floats = (rows: number) => Array.from({ length: rows * 4 }, (_, index) => ((index % 7) + 1) / 10);

function docsRows(): object {
  const ids = ["1", "2", "3"];
  return {
    db_name: DB,
    collection_name: DOCS,
    num_rows: ids.length,
    fields_data: [
      { type: "Int64", field_name: "id", scalars: { long_data: { data: ids } } },
      { type: "FloatVector", field_name: "vec", vectors: { dim: "4", float_vector: { data: floats(3) } } },
      {
        type: "VarChar",
        field_name: "title",
        scalars: { string_data: { data: ids.map((id) => `${STORED.title}-${id}`) } },
      },
      {
        type: "VarChar",
        field_name: "label",
        scalars: { string_data: { data: ids.map((id) => `${STORED.label}-${id}`) } },
      },
      { type: "VarChar", field_name: "text", scalars: { string_data: { data: ids.map(() => STORED.text) } } },
      {
        type: "JSON",
        field_name: "$meta",
        is_dynamic: true,
        scalars: {
          json_data: { data: ids.map(() => Buffer.from(JSON.stringify({ note: STORED.dynamic }), "utf8")) },
        },
      },
    ],
  };
}

function scratchRows(ids: readonly string[], db = DB, collection = SCRATCH): object {
  return {
    db_name: db,
    collection_name: collection,
    num_rows: ids.length,
    fields_data: [
      { type: "Int64", field_name: "id", scalars: { long_data: { data: ids } } },
      { type: "FloatVector", field_name: "vec", vectors: { dim: "4", float_vector: { data: floats(ids.length) } } },
      {
        type: "VarChar",
        field_name: "title",
        scalars: { string_data: { data: ids.map((id) => `${STORED.title}-${id}`) } },
      },
    ],
  };
}

async function waitLoaded(principal: Principal, collection: string): Promise<void> {
  for (let waited = 0; waited < 120_000; waited += 1000) {
    const progress = await must(principal, "GetLoadingProgress", { db_name: DB, collection_name: collection });
    if (progress.progress === "100") return;
    await sleep(1000);
  }
  throw new Error(`${collection} did not load within 120 s`);
}

async function seedData(root: Principal): Promise<void> {
  await must(root, "CreateCollection", { db_name: DB, collection_name: DOCS, schema: docsSchema(), shards_num: 1 });
  await must(root, "Insert", docsRows());
  await must(root, "CreateIndex", {
    db_name: DB,
    collection_name: DOCS,
    field_name: "vec",
    index_name: "vec_idx",
    extra_params: kv({ index_type: "FLAT", metric_type: "L2", params: "{}" }),
  });
  await must(root, "CreateIndex", {
    db_name: DB,
    collection_name: DOCS,
    field_name: "sparse",
    index_name: "sparse_idx",
    extra_params: kv({ index_type: "SPARSE_INVERTED_INDEX", metric_type: "BM25", params: "{}" }),
  });
  await must(root, "CreatePartition", { db_name: DB, collection_name: DOCS, partition_name: "part_a" });
  await must(root, "CreateAlias", { db_name: DB, collection_name: DOCS, alias: ALIAS });
  await must(root, "LoadCollection", { db_name: DB, collection_name: DOCS });
  await waitLoaded(root, DOCS);
  await must(root, "CreateCollection", {
    db_name: DB,
    collection_name: SCRATCH,
    schema: scratchSchema(),
    shards_num: 1,
  });
  await must(root, "Insert", scratchRows(["1", "2"]));
  await must(root, "CreateIndex", {
    db_name: DB,
    collection_name: SCRATCH,
    field_name: "vec",
    index_name: "vec_idx",
    extra_params: kv({ index_type: "FLAT", metric_type: "L2", params: "{}" }),
  });
  await must(root, "LoadCollection", { db_name: DB, collection_name: SCRATCH });
  await waitLoaded(root, SCRATCH);
}

async function grant(root: Principal, role: string, privilege: string, db = DB, collection = "*"): Promise<void> {
  await must(root, "OperatePrivilegeV2", {
    role: { name: role },
    grantor: { privilege: { name: privilege } },
    type: "Grant",
    db_name: db,
    collection_name: collection,
  });
}

async function user(root: Principal, name: string, password: string, role?: string): Promise<void> {
  await must(root, "CreateCredential", { username: name, password: Buffer.from(password, "utf8").toString("base64") });
  if (role === undefined) return;
  if (role !== "admin") await must(root, "CreateRole", { entity: { name: role } });
  await must(root, "OperateUserRole", { username: name, role_name: role, type: "AddUserToRole" });
}

async function seedUsers(root: Principal, all: boolean): Promise<void> {
  // The role a principal with none tries to grant itself Insert through, so no positive control widens public.
  await must(root, "CreateRole", { entity: { name: "agent_unused_role" } });
  await user(root, USERS.reader, PASSWORDS.reader, "agent_reader_role");
  await grant(root, "agent_reader_role", "CollectionReadOnly");
  await grant(root, "agent_reader_role", "ShowCollections");
  await grant(root, "agent_reader_role", "DescribeDatabase");
  if (!all) return;
  await user(root, USERS.dbro, PASSWORDS.dbro, "agent_dbro_role");
  await grant(root, "agent_dbro_role", "DatabaseReadOnly");
  await user(root, USERS.rw, PASSWORDS.rw, "agent_rw_role");
  await grant(root, "agent_rw_role", "CollectionReadWrite");
  await user(root, USERS.admin, PASSWORDS.admin, "admin");
  await must(root, "CreatePrivilegeGroup", { group_name: "agent_read_group" });
  await must(root, "OperatePrivilegeGroup", {
    group_name: "agent_read_group",
    privileges: [{ name: "Query" }, { name: "DescribeCollection" }, { name: "GetLoadState" }],
    type: "AddPrivilegesToGroup",
  });
  await user(root, USERS.custom, PASSWORDS.custom, "agent_custom_role");
  await grant(root, "agent_custom_role", "agent_read_group");
  await user(root, USERS.clusterro, PASSWORDS.clusterro, "agent_clusterro_role");
  await grant(root, "agent_clusterro_role", "ClusterReadOnly", "*", "*");
  await user(root, USERS.nobody, PASSWORDS.nobody);
  await user(root, USERS.midrun, PASSWORDS.midrun, "agent_midrun_role");
  await grant(root, "agent_midrun_role", "CollectionReadOnly");
  await must(root, "CreateDatabase", { db_name: OTHER_DB });
  await must(root, "CreateCollection", {
    db_name: OTHER_DB,
    collection_name: OTHER_DOCS,
    schema: scratchSchema(OTHER_DOCS),
    shards_num: 1,
  });
  await user(root, USERS.elsewhere, PASSWORDS.elsewhere, "agent_elsewhere_role");
  await grant(root, "agent_elsewhere_role", "CollectionReadOnly");
  await grant(root, "agent_elsewhere_role", "Insert", OTHER_DB);
  await user(root, USERS.rwother, PASSWORDS.rwother, "agent_rwother_role");
  await grant(root, "agent_rwother_role", "CollectionReadWrite", OTHER_DB);
}

// -- the plan ---------------------------------------------------------------------------------------------------------

const ROLE_OF: Readonly<Record<string, string | undefined>> = {
  root: undefined,
  reader: "agent_reader_role",
  dbro: "agent_dbro_role",
  rw: "agent_rw_role",
  admin: "admin",
  custom: "agent_custom_role",
  clusterro: "agent_clusterro_role",
  nobody: undefined,
  midrun: "agent_midrun_role",
  elsewhere: "agent_elsewhere_role",
  rwother: "agent_rwother_role",
  "open-reader": "agent_reader_role",
  "open-anonymous": undefined,
};

/** The reads the read-only proof may send: who the principal is, what its roles grant, and reads it must be refused. */
async function proofReads(who: string): Promise<void> {
  const name = PRINCIPALS[who]?.user ?? "";
  await capture(
    "select-user-self",
    who,
    "SelectUser",
    { user: { name }, include_role_info: true },
    "SelectUser of the principal itself with its roles",
  );
  const role = ROLE_OF[who];
  if (role !== undefined) {
    await capture(
      "select-grant-own-role",
      who,
      "SelectGrant",
      { entity: { role: { name: role }, db_name: "*" } },
      `SelectGrant of its own role ${role}, in every database`,
    );
    // The same read naming no database, which 3.0.2 answers with the grants on default and * alone.
    await capture(
      "select-grant-own-role-default-only",
      who,
      "SelectGrant",
      { entity: { role: { name: role } } },
      `SelectGrant of its own role ${role}, naming no database`,
    );
  }
  await capture(
    "select-grant-public",
    who,
    "SelectGrant",
    { entity: { role: { name: "public" }, db_name: "*" } },
    "SelectGrant of the role public, in every database",
  );
  await capture(
    "select-grant-admin",
    who,
    "SelectGrant",
    { entity: { role: { name: "admin" }, db_name: "*" } },
    "SelectGrant of the role admin, which it does not hold, in every database",
  );
  await capture("list-cred-users", who, "ListCredUsers", {}, "ListCredUsers, the user list");
  await capture("select-role-all", who, "SelectRole", { include_user_info: false }, "SelectRole of every role");
  await capture("list-privilege-groups", who, "ListPrivilegeGroups", {}, "ListPrivilegeGroups");
  await capture(
    "select-user-other",
    who,
    "SelectUser",
    { user: { name: "root" }, include_role_info: true },
    "SelectUser of another user, root",
  );
}

/** The console's metadata reads, and the value reads an agent request is refused. */
async function metadataReads(who: string): Promise<void> {
  const named = { db_name: DB, collection_name: DOCS };
  await capture("list-databases", who, "ListDatabases", {}, "ListDatabases");
  await capture("describe-database", who, "DescribeDatabase", { db_name: DB }, "DescribeDatabase default");
  await capture("show-collections", who, "ShowCollections", { db_name: DB }, "ShowCollections default");
  await capture("describe-collection", who, "DescribeCollection", named, "DescribeCollection agent_docs");
  await capture("describe-index", who, "DescribeIndex", named, "DescribeIndex agent_docs, every index");
  await capture("collection-statistics", who, "GetCollectionStatistics", named, "GetCollectionStatistics agent_docs");
  await capture("load-state", who, "GetLoadState", named, "GetLoadState agent_docs");
  await capture("loading-progress", who, "GetLoadingProgress", named, "GetLoadingProgress agent_docs");
  await capture("show-partitions", who, "ShowPartitions", named, "ShowPartitions agent_docs");
  await capture("list-aliases", who, "ListAliases", { db_name: DB }, "ListAliases default");
  await capture("describe-alias", who, "DescribeAlias", { db_name: DB, alias: ALIAS }, "DescribeAlias agent_alias");
  await capture(
    "query-values",
    who,
    "Query",
    {
      ...named,
      expr: "id > 0",
      output_fields: ["title", "label", "note"],
      query_params: kv({ limit: "3" }),
      use_default_consistency: true,
    },
    "Query of stored values, scalar and dynamic",
  );
  await capture(
    "search-text",
    who,
    "Search",
    {
      ...named,
      dsl: "",
      dsl_type: "BoolExprV1",
      placeholder_group: textPlaceholder("vectors"),
      nq: "1",
      output_fields: ["title"],
      search_params: kv({ anns_field: "sparse", topk: "3", metric_type: "BM25", params: "{}" }),
      use_default_consistency: true,
    },
    "Search with a text input against the BM25 function's output field: the server runs the function",
  );
}

function textPlaceholder(text: string): Buffer {
  const type = TYPES.lookupType("milvus.proto.common.PlaceholderGroup");
  return Buffer.from(
    type
      .encode(type.fromObject({ placeholders: [{ tag: "$0", type: "VarChar", values: [Buffer.from(text, "utf8")] }] }))
      .finish(),
  );
}

/** Every write and server-side state change, each one a principal could try. */
function writes(who: string): ReadonlyArray<readonly [string, string, object, string]> {
  const suffix = who.replace(/-/g, "_");
  const scratch = { db_name: DB, collection_name: SCRATCH };
  return [
    [
      "write-create-collection",
      "CreateCollection",
      {
        db_name: DB,
        collection_name: `agent_new_${suffix}`,
        schema: scratchSchema(`agent_new_${suffix}`),
        shards_num: 1,
      },
      "CreateCollection of a new collection",
    ],
    [
      "write-drop-missing-collection",
      "DropCollection",
      { db_name: DB, collection_name: "agent_never_exists" },
      "DropCollection of a name no collection has",
    ],
    [
      "write-create-alias",
      "CreateAlias",
      { db_name: DB, collection_name: SCRATCH, alias: `agent_alias_${suffix}` },
      "CreateAlias on agent_scratch",
    ],
    [
      "write-drop-missing-alias",
      "DropAlias",
      { db_name: DB, alias: "agent_never_alias" },
      "DropAlias of a name no alias has",
    ],
    [
      "write-insert",
      "Insert",
      scratchRows([String(100 + Object.keys(PRINCIPALS).indexOf(who))]),
      "Insert of one row into agent_scratch",
    ],
    ["write-delete-none", "Delete", { ...scratch, expr: "id in [-1]" }, "Delete of no row from agent_scratch"],
    ["write-upsert", "Upsert", scratchRows(["1"]), "Upsert of row 1 of agent_scratch"],
    ["write-flush", "Flush", { db_name: DB, collection_names: [SCRATCH] }, "Flush of agent_scratch"],
    ["write-compact", "ManualCompaction", { ...scratch, majorCompaction: false }, "ManualCompaction of agent_scratch"],
    [
      "write-create-index",
      "CreateIndex",
      { ...scratch, field_name: "title", index_name: `title_${suffix}`, extra_params: kv({ index_type: "INVERTED" }) },
      "CreateIndex on agent_scratch.title",
    ],
    [
      "write-create-partition",
      "CreatePartition",
      { ...scratch, partition_name: `part_${suffix}` },
      "CreatePartition on agent_scratch",
    ],
    ["write-create-database", "CreateDatabase", { db_name: `agent_db_${suffix}` }, "CreateDatabase"],
    [
      "write-create-credential",
      "CreateCredential",
      { username: `agent_new_${suffix}`, password: Buffer.from("not-a-real-password", "utf8").toString("base64") },
      "CreateCredential of a new user",
    ],
    [
      "write-grant-self",
      "OperatePrivilegeV2",
      {
        role: { name: ROLE_OF[who] ?? "agent_unused_role" },
        grantor: { privilege: { name: "Insert" } },
        type: "Grant",
        db_name: DB,
        collection_name: "*",
      },
      "OperatePrivilegeV2 granting Insert to its own role",
    ],
    [
      "write-import",
      "Import",
      { ...scratch, files: ["agent-never-exists.json"] },
      "Import of a file that does not exist into agent_scratch",
    ],
    ["write-release", "ReleaseCollection", scratch, "ReleaseCollection of agent_scratch"],
    ["write-load", "LoadCollection", scratch, "LoadCollection of agent_scratch"],
  ];
}

async function state(tag: string, who: "root" | "open-root"): Promise<void> {
  const scratch = { db_name: DB, collection_name: SCRATCH };
  await capture(
    `state-${tag}-count`,
    who,
    "Query",
    {
      ...scratch,
      expr: "",
      output_fields: ["count(*)"],
      query_params: kv({}),
      consistency_level: "Strong",
      use_default_consistency: false,
    },
    "the row count of agent_scratch, strong consistency",
  );
  await capture(`state-${tag}-collections`, who, "ShowCollections", { db_name: DB }, "the collections of default");
  await capture(`state-${tag}-aliases`, who, "ListAliases", { db_name: DB }, "the aliases of default");
  await capture(`state-${tag}-partitions`, who, "ShowPartitions", scratch, "the partitions of agent_scratch");
  await capture(`state-${tag}-databases`, who, "ListDatabases", {}, "the databases");
  await capture(`state-${tag}-load`, who, "GetLoadState", scratch, "the load state of agent_scratch");
  await capture(`state-${tag}-indexes`, who, "DescribeIndex", scratch, "the indexes of agent_scratch");
}

async function run(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  for (const file of readdirSync(OUT)) if (file.endsWith(".json")) rmSync(path.join(OUT, file));

  await seedData(ROOT);
  await seedUsers(ROOT, true);
  await seedData(OPEN_ROOT);
  await seedUsers(OPEN_ROOT, false);
  // The proxy reads grants from its cache, which follows the meta store.
  await sleep(3000);

  for (const who of Object.keys(PRINCIPALS)) {
    await proofReads(who);
    if (!ELSEWHERE.includes(who)) await metadataReads(who);
  }
  // The writes the principals with grants outside default may make there: what the proof must refuse them for.
  for (const who of ELSEWHERE) {
    await capture(
      "write-insert-other-db",
      who,
      "Insert",
      scratchRows(["400"], OTHER_DB, OTHER_DOCS),
      `Insert of one row into ${OTHER_DB}.${OTHER_DOCS}`,
    );
  }

  await state("before", "root");
  for (const who of ["reader", "dbro", "custom", "clusterro", "nobody", "midrun"]) {
    for (const [name, rpc, request, surface] of writes(who)) await capture(name, who, rpc, request, surface);
  }
  await state("after-refused", "root");

  // The positive controls: the same writes from principals that may write.
  for (const who of ["rw", "admin", "root"]) {
    for (const [name, rpc, request, surface] of writes(who)) await capture(name, who, rpc, request, surface);
    // Loaded again, so the next principal finds agent_scratch as the one before it did.
    await must(ROOT, "LoadCollection", { db_name: DB, collection_name: SCRATCH });
    await waitLoaded(ROOT, SCRATCH);
  }
  await state("after-writable", "root");

  // A grant made during the run: the role's grants read again, then the write it now allows.
  await grant(ROOT, "agent_midrun_role", "Insert");
  await sleep(3000);
  await capture(
    "select-grant-own-role-after-grant",
    "midrun",
    "SelectGrant",
    { entity: { role: { name: "agent_midrun_role" }, db_name: "*" } },
    "SelectGrant of its own role after Insert was granted, in every database",
  );
  await capture(
    "write-insert-after-grant",
    "midrun",
    "Insert",
    scratchRows(["300"]),
    "Insert of one row after Insert was granted",
  );

  // Authorization off: every principal writes, the anonymous one included.
  await state("open-before", "open-root");
  for (const who of ["open-reader", "open-anonymous"]) {
    for (const [name, rpc, request, surface] of writes(who)) await capture(name, who, rpc, request, surface);
    await must(OPEN_ROOT, "LoadCollection", { db_name: DB, collection_name: SCRATCH });
    await waitLoaded(OPEN_ROOT, SCRATCH);
  }
  await state("open-after", "open-root");
}

await run();
console.log(`wrote ${readdirSync(OUT).filter((file) => file.endsWith(".json")).length} captures into ${OUT}`);
