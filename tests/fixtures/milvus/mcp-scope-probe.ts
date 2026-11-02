/**
 * Seeds the Milvus server 3.0.2/mcp-scope/run.sh started, sends the data-scope plan, and writes one capture per call
 * into 3.0.2/mcp-scope/.
 *
 *   bun tests/fixtures/milvus/mcp-scope-probe.ts
 *
 * What it measures is what the server itself lets a narrow read-only user see, with no Studio check in front of it:
 * which databases, collections and aliases a listing answers a user granted one database or a few collections, what
 * a read naming a database, collection, alias, partition or index outside the user's grants answers next to one
 * naming a missing one, and which collection a read naming an alias is answered for. The provider's metadata reads,
 * and the data-scope rules of `docs/providers/milvus.md` built on them, rest on these answers.
 *
 * The environment carries MILVUS_AUTH_TARGET (authorization on) and MILVUS_ROOT_PASSWORD, root's password, generated
 * per run by run.sh. Every other user's password is generated here for the run. A capture records the principal's
 * name and rights, never a password or a token, and the script refuses to write a file that holds any form of any
 * credential it sent. It drives @grpc/grpc-js with the definition the descriptor generator builds, as
 * agent-boundary-probe.ts does, and sends every call raw.
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
const OUT = path.join(import.meta.dir, VERSION, "mcp-scope");
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
  "CreateAlias",
  "AlterAlias",
  "CreateIndex",
  "CreatePartition",
  "CreateDatabase",
  "CreateCredential",
  "CreateRole",
  "OperateUserRole",
  "OperatePrivilegeV2",
]);

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is not set`);
  return value;
}

const TARGET = env("MILVUS_AUTH_TARGET");

/** Every form of every credential the run sent; none may appear in a written capture. */
const SECRETS = new Set<string>();
function remember(secret: string): void {
  SECRETS.add(secret);
  SECRETS.add(Buffer.from(secret, "utf8").toString("base64").replace(/=+$/, ""));
}

const ROOT_PASSWORD = env("MILVUS_ROOT_PASSWORD");
remember(ROOT_PASSWORD);

function generated(): string {
  const value = randomBytes(16).toString("hex");
  remember(value);
  return value;
}

interface Principal {
  readonly user: string;
  readonly password: string;
  /** The database its connection would name, which every read of it names unless the read says otherwise. */
  readonly db: string;
  readonly rights: string;
}

/** The databases: the connection's own, a second one the one-database user is granted, and one nobody is. */
const DB = "default";
const DB_A = "scope_db_a";
const DB_B = "scope_db_b";
/** In `default`: two collections the few-collections user is granted, and one it is not, with an alias each. */
const C1 = "scope_c1";
const C2 = "scope_c2";
const C3 = "scope_c3";
const ALIAS_C1 = "scope_alias_c1";
const ALIAS_C3 = "scope_alias_c3";
/** In scope_db_a and scope_db_b: one collection each, and an alias in scope_db_b. */
const A1 = "scope_a1";
const B1 = "scope_b1";
const ALIAS_B1 = "scope_alias_b1";
/** A name no database, collection, alias, partition or index has. */
const MISSING = "scope_missing";

const PRINCIPALS: Readonly<Record<string, Principal>> = {
  root: { user: "root", password: ROOT_PASSWORD, db: DB, rights: "the built-in root user" },
  dbro: {
    user: "scope_dbro",
    password: generated(),
    db: DB,
    rights: "role scope_dbro_role: the DatabaseReadOnly and CollectionReadOnly groups on default/*",
  },
  few: {
    user: "scope_few",
    password: generated(),
    db: DB,
    rights:
      "role scope_few_role: the CollectionReadOnly group on default/scope_c1 and default/scope_c2, and the ShowCollections and DescribeDatabase privileges on default/*",
  },
  onedb: {
    user: "scope_onedb",
    password: generated(),
    db: DB_A,
    rights: "role scope_onedb_role: the DatabaseReadOnly and CollectionReadOnly groups on scope_db_a/*",
  },
};

function method(rpc: string): MethodDefinition<object, object> {
  const found = (DEFINITION[SERVICE] as Record<string, MethodDefinition<object, object>>)[rpc];
  if (found === undefined) throw new Error(`MilvusService has no ${rpc}`);
  return found;
}

async function rawCall(principal: Principal, rpc: string, request: object): Promise<object> {
  const client = new grpc.Client(`dns:${TARGET}`, grpc.credentials.createInsecure(), {
    "grpc.enable_retries": 0,
    "grpc.use_local_subchannel_pool": 1,
  });
  try {
    const definition = method(rpc);
    const metadata = new grpc.Metadata();
    const pair = `${principal.user}:${principal.password}`;
    remember(pair);
    metadata.set("authorization", Buffer.from(pair, "utf8").toString("base64"));
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

function succeeded(rpc: string, answer: object): boolean {
  const status = ANSWERS_A_STATUS.has(rpc)
    ? (answer as Status)
    : ((answer as { status?: Status | null }).status ?? undefined);
  return status !== undefined && status.code === 0 && status.error_code === "Success";
}

function encode(value: unknown): unknown {
  if (value instanceof Uint8Array) return { $bytes: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(encode);
  if (value !== null && typeof value === "object") {
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

async function must(rpc: string, request: object): Promise<Record<string, unknown>> {
  const measured = await call(PRINCIPALS.root as Principal, rpc, request);
  if (measured.outcome !== "pass") throw new Error(`${rpc} failed: ${JSON.stringify(measured.payload)}`);
  return measured.payload as Record<string, unknown>;
}

function assertNoSecret(text: string, file: string): void {
  for (const secret of SECRETS) {
    if (text.includes(secret)) throw new Error(`${file} would hold a form of a credential; nothing was written`);
  }
}

async function capture(name: string, who: string, rpc: string, request: object, surface: string): Promise<Measured> {
  const principal = PRINCIPALS[who];
  if (principal === undefined) throw new Error(`no principal ${who}`);
  const measured = await call(principal, rpc, request);
  const file = path.join(OUT, `${name}-${who}.json`);
  const text = `${JSON.stringify(
    {
      $captured: {
        server: "authorization on",
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
          ],
        }),
      )
      .finish(),
  );
}

async function collection(db: string, name: string): Promise<void> {
  await must("CreateCollection", { db_name: db, collection_name: name, schema: schema(name), shards_num: 1 });
  await must("CreateIndex", {
    db_name: db,
    collection_name: name,
    field_name: "vec",
    index_name: "vec_idx",
    extra_params: kv({ index_type: "FLAT", metric_type: "L2", params: "{}" }),
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

async function user(who: string, role: string): Promise<void> {
  const principal = PRINCIPALS[who] as Principal;
  await must("CreateCredential", {
    username: principal.user,
    password: Buffer.from(principal.password, "utf8").toString("base64"),
  });
  await must("CreateRole", { entity: { name: role } });
  await must("OperateUserRole", { username: principal.user, role_name: role, type: "AddUserToRole" });
}

async function seed(): Promise<void> {
  await must("CreateDatabase", { db_name: DB_A });
  await must("CreateDatabase", { db_name: DB_B });
  for (const name of [C1, C2, C3]) await collection(DB, name);
  await must("CreatePartition", { db_name: DB, collection_name: C3, partition_name: "scope_c3_part" });
  await must("CreateAlias", { db_name: DB, collection_name: C1, alias: ALIAS_C1 });
  await must("CreateAlias", { db_name: DB, collection_name: C3, alias: ALIAS_C3 });
  await collection(DB_A, A1);
  await collection(DB_B, B1);
  await must("CreateAlias", { db_name: DB_B, collection_name: B1, alias: ALIAS_B1 });
  await user("dbro", "scope_dbro_role");
  await grant("scope_dbro_role", "DatabaseReadOnly", DB);
  await grant("scope_dbro_role", "CollectionReadOnly", DB);
  await user("few", "scope_few_role");
  await grant("scope_few_role", "CollectionReadOnly", DB, C1);
  await grant("scope_few_role", "CollectionReadOnly", DB, C2);
  await grant("scope_few_role", "ShowCollections", DB);
  await grant("scope_few_role", "DescribeDatabase", DB);
  await user("onedb", "scope_onedb_role");
  await grant("scope_onedb_role", "DatabaseReadOnly", DB_A);
  await grant("scope_onedb_role", "CollectionReadOnly", DB_A);
}

/** The listings, then a read of each kind naming a granted object, an ungranted one and a missing one. */
/** The roles each principal holds, whose grants the read-only proof reads. */
const ROLE_OF: Readonly<Record<string, string | undefined>> = {
  root: undefined,
  dbro: "scope_dbro_role",
  few: "scope_few_role",
  onedb: "scope_onedb_role",
};

/** The read-only proof's reads, so a narrow principal's open can be replayed: each one passes it. */
async function proofReads(who: string): Promise<void> {
  const principal = PRINCIPALS[who] as Principal;
  await capture("list-cred-users", who, "ListCredUsers", {}, "ListCredUsers, the user list");
  await capture(
    "select-user-self",
    who,
    "SelectUser",
    { user: { name: principal.user }, include_role_info: true },
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
  }
  await capture(
    "select-grant-public",
    who,
    "SelectGrant",
    { entity: { role: { name: "public" }, db_name: "*" } },
    "SelectGrant of the role public, in every database",
  );
}

async function plan(who: string): Promise<void> {
  await proofReads(who);
  const own = (PRINCIPALS[who] as Principal).db;
  const other = own === DB ? DB_B : DB;
  const granted = own === DB ? C1 : A1;
  const ungranted = own === DB ? C3 : B1;
  const ungrantedDb = own === DB ? DB : DB_B;
  await capture("list-databases", who, "ListDatabases", {}, "ListDatabases");
  await capture("show-collections", who, "ShowCollections", { db_name: own }, `ShowCollections ${own}`);
  await capture("show-collections-other-db", who, "ShowCollections", { db_name: other }, `ShowCollections ${other}`);
  await capture("list-aliases", who, "ListAliases", { db_name: own }, `ListAliases ${own}`);
  await capture("list-aliases-other-db", who, "ListAliases", { db_name: DB_B }, `ListAliases ${DB_B}`);
  await capture("describe-database", who, "DescribeDatabase", { db_name: own }, `DescribeDatabase ${own}`);
  await capture("describe-database-other", who, "DescribeDatabase", { db_name: other }, `DescribeDatabase ${other}`);
  await capture(
    "describe-database-missing",
    who,
    "DescribeDatabase",
    { db_name: MISSING },
    "DescribeDatabase of a missing database",
  );
  const names: ReadonlyArray<readonly [string, string, string]> = [
    ["granted", own, granted],
    ["ungranted", ungrantedDb, ungranted],
    ["missing", own, MISSING],
    ["alias-granted", DB, ALIAS_C1],
    ["alias-ungranted", DB, ALIAS_C3],
    ["other-db-alias", DB_B, ALIAS_B1],
  ];
  for (const [tag, db, name] of names) {
    const named = { db_name: db, collection_name: name };
    await capture(`describe-collection-${tag}`, who, "DescribeCollection", named, `DescribeCollection ${db}/${name}`);
    await capture(`statistics-${tag}`, who, "GetCollectionStatistics", named, `GetCollectionStatistics ${db}/${name}`);
    await capture(`load-state-${tag}`, who, "GetLoadState", named, `GetLoadState ${db}/${name}`);
    await capture(`show-partitions-${tag}`, who, "ShowPartitions", named, `ShowPartitions ${db}/${name}`);
    await capture(`describe-index-${tag}`, who, "DescribeIndex", named, `DescribeIndex ${db}/${name}`);
    await capture(`list-aliases-of-${tag}`, who, "ListAliases", named, `ListAliases of ${db}/${name}`);
  }
  await capture(
    "describe-index-missing-index",
    who,
    "DescribeIndex",
    { db_name: own, collection_name: granted, index_name: MISSING },
    `DescribeIndex ${own}/${granted} of a missing index`,
  );
  await capture(
    "describe-alias-granted",
    who,
    "DescribeAlias",
    { db_name: DB, alias: ALIAS_C1 },
    `DescribeAlias ${DB}/${ALIAS_C1}`,
  );
  await capture(
    "describe-alias-ungranted",
    who,
    "DescribeAlias",
    { db_name: DB, alias: ALIAS_C3 },
    `DescribeAlias ${DB}/${ALIAS_C3}`,
  );
  await capture(
    "describe-alias-missing",
    who,
    "DescribeAlias",
    { db_name: own, alias: MISSING },
    "DescribeAlias of a missing alias",
  );
  await capture(
    "describe-alias-other-db",
    who,
    "DescribeAlias",
    { db_name: DB_B, alias: ALIAS_B1 },
    `DescribeAlias ${DB_B}/${ALIAS_B1}`,
  );
  await capture(
    "batch-describe-collection",
    who,
    "BatchDescribeCollection",
    { db_name: own, collection_name: [granted, ungranted, MISSING] },
    `BatchDescribeCollection ${own}: a granted, an ungranted and a missing collection`,
  );
}

async function run(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  for (const file of readdirSync(OUT)) if (file.endsWith(".json")) rmSync(path.join(OUT, file));
  await seed();
  for (const who of ["root", "dbro", "few", "onedb"]) await plan(who);
  console.log(`wrote ${readdirSync(OUT).filter((file) => file.endsWith(".json")).length} captures to ${OUT}`);
}

await run();
