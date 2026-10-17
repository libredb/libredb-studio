/**
 * Live check of the MongoDB agent read-only execution profile (#1614), against servers of its own.
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. MongoDB has no read-only session, so the profile's boundary is
 * the connection's user and a server that enforces that user's privileges, proven at open (`agent-boundary.ts`), and
 * each read is held to its budget and deadline as it arrives (`agent-read.ts`). The provider suite drives a stand-in
 * driver, which answers what its author wrote; whether a server refuses a principal, accepts the probe, ends a read at
 * its deadline or holds a reply in memory is the server's to say. So this script asks real ones, through the
 * production path (`acquireExecutionProfileProvider`, then `queryReadOnly`):
 *
 *  - `libredb_agent` (02-agent-principal.js) is admitted and reads, holding exactly the read role's measured actions;
 *    root, read plus backup, plus a role reading admin.system.users, plus userAdmin, plus readWrite on another
 *    database, plus insert on one collection, read on two databases, and readAnyDatabase are refused
 *    PROFILE_PRIVILEGES_TOO_BROAD; a user with no roles and a connection with no user are refused
 *    PROFILE_PRIVILEGES_TOO_NARROW; a server without authorization is refused PROFILE_SERVER_UNENFORCED, with and
 *    without the read user's credentials;
 *  - no refusal changes a server: every database and collection reads back the same, and a collection named
 *    libredb_agent_probe still holds its three documents;
 *  - the open's three checks (`buildInfo`, `connectionStatus` and the probe's `delete`) carry `maxTimeMS` and the
 *    agent's comment, as the server logs them;
 *  - the operations profile opens root, and a server without authorization, unverified, and lists collections;
 *  - every write, `$out` and `$merge` at the top level and nested, two commands in one statement, the internal and the
 *    JavaScript operators and the diagnostic stages are refused before anything is sent; the writes, sent around that
 *    fence through the editor's own path on the same connection, are refused by the server; root reads it all back
 *    unchanged;
 *  - a database other than the bound one is refused naming the bound one, and a find limit of 0 is refused;
 *  - a count plans the `$group` it runs and never RECORD_STORE_FAST_COUNT, a sort plans the row bound, and a plan row
 *    holds only plan keys and not the server's host;
 *  - each slow read and slow plan ends at the server's own deadline with nothing left running, and on a server whose
 *    `maxTimeMS` a fail point disables, at the provider's own kill of the read's session;
 *  - a cursor read past the byte budget and a near-16 MiB document are refused without the process growing past
 *    `RSS_CEILING_BYTES`, each measured in a process of its own; a near-16 MiB distinct is decoded whole before its
 *    budgets (a documented limitation with a backlog entry), so its growth is printed and not held to the ceiling;
 *  - 20 reads under the hand-over budget are served, with no TimeoutOverflowWarning.
 *
 * `--matrix` repeats the checks that depend on the version on MongoDB 8.3.11 and 7.0.43 (the action set, the open's
 * three checks, the deadline and the kill as the read user, the plans) and adds FerretDB 2.7.0, refused
 * PROFILE_UNSUPPORTED_TARGET and opened by the operations profile.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in `tests/runner/discover.ts`).
 * CI runs it in the "Functional Smoke (PostgreSQL, MongoDB, RabbitMQ)" job of .github/workflows/ci.yml, and
 * loop/scripts/functional-smoke.sh runs it locally. It needs Docker and nothing else:
 *
 *   bun tests/live/mongodb-agent-profile.ts            # MongoDB 9.0.4, with and without authorization
 *   bun tests/live/mongodb-agent-profile.ts --matrix   # also 8.3.11, 7.0.43 and FerretDB 2.7.0
 *
 * Every container is the script's own, on a loopback port Docker picks, seeded by `docker/mongodb-init` mounted
 * read-only, with a root password made for the run, and removed on every exit. The 9.0.4 image is
 * database-compose.yml's `mongodb` service's, pinned by digest; `LIBREDB_LIVE_MONGO_IMAGE` may name another reference
 * to that digest, such as `mirror.gcr.io/library/mongo:9.0.4@sha256:...` where Docker Hub cannot be reached, and
 * nothing else. Each check prints one line, and the first that fails ends the run non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the servers hold after the one before, and a deadline is timed alone.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { Binary, type Document, MongoClient } from "mongodb";
import { AGENT_HANDOVER_BUDGET, AGENT_WORKFLOW_BUDGETS } from "@/lib/agent/execution-policy";
import { ExecutionProfileError } from "@/lib/db/errors";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import { AGENT_VERIFY_MAX_TIME_MS, MONGO_AGENT_READ_ACTIONS } from "@/lib/db/providers/document/mongodb/agent-boundary";
import {
  AGENT_COMMAND_COMMENT,
  AGENT_DEADLINE_BACKSTOP_MS,
  AGENT_KILL_GRACE_MS,
} from "@/lib/db/providers/document/mongodb/agent-read";
import type { DatabaseProvider, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

/**
 * MongoDB 9.0.4, the official image's multi-platform index as Docker Hub served it on 2026-10-17. database-compose.yml's
 * `mongodb` service and the CI step name this reference; tests/unit/db/mongodb/live-environment.test.ts holds the three
 * equal.
 */
export const MONGODB_LIVE_IMAGE = "mongo:9.0.4@sha256:f90507905ce6e52e4a63d0ff8964fc254fa4d37ccbe56c56f4bc0186eb02edea";

/** The versions `--matrix` adds, each pinned by its index digest as Docker Hub served it on 2026-10-17. */
const MONGODB_MATRIX_IMAGES: Readonly<Record<string, string>> = {
  "8.3.11": "mongo:8.3.11@sha256:d731d77bfd7afd66bd487bdf627b5bf7ce4c3602ec461d635977021db529ebbc",
  "7.0.43": "mongo:7.0.43@sha256:1f995ad6fdb93244a1addab1b58f934a0bc2f5643c38e02f5e9d7f0c7d227a7b",
};

/** FerretDB 2.7.0, the wire-compatible server the profile refuses, and the PostgreSQL build it was released with. */
const FERRETDB_IMAGE =
  "ghcr.io/ferretdb/ferretdb:2.7.0@sha256:5706414241eb84f0515512c37b46db0f1b1eac9e5ceb7e4c2523211c184b1985";
const FERRETDB_BACKEND_IMAGE =
  "ghcr.io/ferretdb/postgres-documentdb:17-0.107.0-ferretdb-2.7.0@sha256:2386795ec2aa7ae559304361979f1dc5708d383ee9020ae63dadc2940dfe58f7";

/** The process growth one read may cost: the ceiling tests/live/mysql-agent-profile.ts holds its reads to. */
const RSS_CEILING_BYTES = 64 * 1024 * 1024;

/**
 * The keys a plan row may carry at its top level: `PLAN_KEYS` in agent-read.ts, written out because that module keeps
 * it private, so a key the provider starts to pass fails here until this list changes with it.
 */
export const PLAN_KEYS: readonly string[] = Object.freeze([
  "explainVersion",
  "queryPlanner",
  "stages",
  "mergeType",
  "mergeShardId",
  "splitPipeline",
  "shards",
]);

/** The variables the check reads; `process.env` is one. */
type LiveEnvironment = Readonly<Record<string, string | undefined>>;

/**
 * The 9.0.4 image the check runs: `LIBREDB_LIVE_MONGO_IMAGE` when it is set, else `MONGODB_LIVE_IMAGE`. The variable
 * may name another registry, a mirror of Docker Hub, but only with the pinned digest, so the server is the one measured.
 */
export function liveImage(env: LiveEnvironment): string {
  const named = env.LIBREDB_LIVE_MONGO_IMAGE;
  if (named === undefined || named === "") return MONGODB_LIVE_IMAGE;
  const digest = MONGODB_LIVE_IMAGE.slice(MONGODB_LIVE_IMAGE.indexOf("@"));
  const parts = named.split("@");
  if (parts.length !== 2 || `@${parts[1]}` !== digest) {
    throw new Error(
      `LIBREDB_LIVE_MONGO_IMAGE must name MongoDB 9.0.4 by its pinned digest, ${digest}, as mirror.gcr.io/library/${MONGODB_LIVE_IMAGE} does; "${named}" does not, so the check would run another server.`,
    );
  }
  return named;
}

/** The user the image creates on a server that enforces authorization. */
const ROOT_USER = "root";

/** One MongoDB server the check starts. */
export interface MongoContainer {
  readonly name: string;
  readonly image: string;
  /** Whether the server enforces authorization: the image then creates the root user and starts it with `--auth`. */
  readonly authorization: boolean;
  /** Enables the test commands, for the fail point that keeps `maxTimeMS` from ending a read. */
  readonly testCommands?: boolean;
}

/**
 * `docker run`'s arguments for one server: the repository's init scripts mounted read-only (the object fixture and
 * `libredb_agent`, which the image runs once, on the fresh data directory), a loopback port Docker picks, and with
 * authorization the root user, whose password the docker CLI's own environment carries (`MONGO_INITDB_ROOT_PASSWORD`
 * named without a value), so no command line holds it.
 */
export function mongoRunArgs(container: MongoContainer, initDirectory: string): string[] {
  return [
    "run",
    "-d",
    "--name",
    container.name,
    ...(container.authorization
      ? ["-e", `MONGO_INITDB_ROOT_USERNAME=${ROOT_USER}`, "-e", "MONGO_INITDB_ROOT_PASSWORD"]
      : []),
    "-v",
    `${initDirectory}:/docker-entrypoint-initdb.d:ro`,
    "-p",
    "127.0.0.1::27017",
    container.image,
    ...(container.testCommands === true ? ["--setParameter", "enableTestCommands=1"] : []),
  ];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Every object a plan holds at any depth, its top level first. */
function planObjects(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(planObjects);
  if (!isPlainObject(value)) return [];
  return [value, ...Object.values(value).flatMap(planObjects)];
}

/** The `stage` of every node of a plan, at any depth. */
export function planStageNames(plan: unknown): string[] {
  return planObjects(plan).flatMap((node) => (typeof node.stage === "string" ? [node.stage] : []));
}

/** Whether a plan groups: a GROUP node of the query layer, or a `$group` stage of a pipeline the server runs itself. */
export function planRunsGroup(plan: unknown): boolean {
  return planObjects(plan).some((node) => node.stage === "GROUP" || Object.hasOwn(node, "$group"));
}

/** The limit of every sort a plan runs: a SORT node's `limitAmount`, or a pipeline `$sort` stage's `limit`. */
export function planSortLimits(plan: unknown): number[] {
  return planObjects(plan).flatMap((node) => {
    if (node.stage === "SORT" && typeof node.limitAmount === "number") return [node.limitAmount];
    const sort = node.$sort;
    return isPlainObject(sort) && typeof sort.limit === "number" ? [sort.limit] : [];
  });
}

/**
 * What a plan row carries that it may not: a top-level key outside `PLAN_KEYS`, or the host the server names itself by,
 * anywhere in the row. Never a search for the word serverInfo below the top level: a plan echoes the command's own
 * field names, and a command may name a field serverInfo.
 */
export function planRowProblems(row: Readonly<Record<string, unknown>>, serverHost: string): string[] {
  if (serverHost === "") {
    throw new Error("The server's own explain named no host, so the row cannot be searched for it");
  }
  const problems = Object.keys(row)
    .filter((key) => !PLAN_KEYS.includes(key))
    .map((key) => `top-level key "${key}" is not a plan key`);
  if (JSON.stringify(row).includes(serverHost)) problems.push(`the row carries the server's host ${serverHost}`);
  return problems;
}

const INIT_DIRECTORY = path.resolve(import.meta.dir, "../../docker/mongodb-init");
/** Names this run's containers and network apart from any other run's on the same Docker. */
const RUN = randomBytes(4).toString("hex");
const containers: string[] = [];
const networks: string[] = [];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function docker(args: readonly string[], env?: Readonly<Record<string, string>>): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: env === undefined ? process.env : { ...process.env, ...env },
  });
}

function dockerAvailable(): boolean {
  try {
    docker(["info"]);
    return true;
  } catch {
    return false;
  }
}

/** Removes every container and network this run made; each is named before it is made, so a failed start goes too. */
function removeEverything(): void {
  for (const name of containers.splice(0)) {
    try {
      docker(["rm", "-f", "-v", name]);
    } catch (error) {
      reportUnlessGone(name, error);
    }
  }
  for (const name of networks.splice(0)) {
    try {
      docker(["network", "rm", name]);
    } catch (error) {
      reportUnlessGone(name, error);
    }
  }
}

/**
 * A removal that failed because the object was never made, as after a failed start, is silent; any other failure is
 * printed, because a daemon error here can leave a container running. Docker 29.9 removes a missing container with
 * `rm -f` and no error, and answers `network <name> not found` for a missing network, where older releases say
 * `No such container` and `No such network`.
 */
function reportUnlessGone(name: string, error: unknown): void {
  const stderr = String((error as { stderr?: unknown }).stderr ?? error);
  if (!/No such (container|network)|network \S+ not found/.test(stderr)) {
    console.error(`Could not remove ${name}: ${stderr.trim()}`);
  }
}

interface Server {
  readonly label: string;
  readonly container: string;
  readonly port: number;
  /** The root password of a server that enforces authorization. */
  readonly rootPassword?: string;
}

/** The host port Docker published for the container's 27017, from `docker port`'s `127.0.0.1:49153`. */
function publishedPort(container: string): number {
  const binding = docker(["port", container, "27017/tcp"]).trim().split("\n")[0] ?? "";
  const port = Number(binding.slice(binding.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Docker published no port for ${container}: "${binding}"`);
  return port;
}

function startMongo(label: string, container: MongoContainer): Server {
  const rootPassword = container.authorization ? randomBytes(16).toString("hex") : undefined;
  containers.push(container.name);
  docker(
    mongoRunArgs(container, INIT_DIRECTORY),
    rootPassword === undefined ? undefined : { MONGO_INITDB_ROOT_PASSWORD: rootPassword },
  );
  return { label, container: container.name, port: publishedPort(container.name), rootPassword };
}

/**
 * FerretDB and its PostgreSQL backend on a network of their own. The backend's password is made for the run and is
 * the user FerretDB signs in with; the URL that carries it reaches FerretDB through the docker CLI's environment.
 */
async function startFerretDB(): Promise<{ readonly server: Server; readonly credential: Credential }> {
  const network = `libredb-live-mongo-${RUN}`;
  const backend = `libredb-live-mongo-${RUN}-ferret-backend`;
  const ferret = `libredb-live-mongo-${RUN}-ferretdb`;
  const password = randomBytes(16).toString("hex");
  networks.push(network);
  docker(["network", "create", network]);
  containers.push(backend);
  docker(
    [
      "run",
      "-d",
      "--name",
      backend,
      "--network",
      network,
      "-e",
      "POSTGRES_USER=postgres",
      "-e",
      "POSTGRES_PASSWORD",
      "-e",
      "POSTGRES_DB=postgres",
      FERRETDB_BACKEND_IMAGE,
    ],
    { POSTGRES_PASSWORD: password },
  );
  // The image's first start runs a temporary server on its socket only, then the real one; only the real one answers
  // on TCP, so FerretDB is started once TCP answers.
  const deadline = Date.now() + 120_000;
  for (;;) {
    try {
      docker(["exec", backend, "pg_isready", "-q", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres"]);
      break;
    } catch (error) {
      if (Date.now() > deadline) {
        throw new Error(`FerretDB's backend was not ready within 120 s: ${String(error)}`, { cause: error });
      }
      await sleep(1000);
    }
  }
  containers.push(ferret);
  docker(
    [
      "run",
      "-d",
      "--name",
      ferret,
      "--network",
      network,
      "-e",
      "FERRETDB_POSTGRESQL_URL",
      "-p",
      "127.0.0.1::27017",
      FERRETDB_IMAGE,
    ],
    { FERRETDB_POSTGRESQL_URL: `postgres://postgres:${password}@${backend}:5432/postgres` },
  );
  return {
    server: { label: "FerretDB 2.7.0", container: ferret, port: publishedPort(ferret) },
    credential: { user: "postgres", password },
  };
}

function dockerLogs(container: string): string {
  try {
    return execFileSync("docker", ["logs", "--tail", "40", container], { encoding: "utf8", stdio: "pipe" });
  } catch (error) {
    return String(error);
  }
}

/**
 * A client of the server once it answers. The image's first start runs the init scripts on a temporary server bound to
 * the container's own loopback, so the published port answers only once the real server is up, scripts applied.
 */
async function connectWhenReady(server: Server, credential?: Credential): Promise<MongoClient> {
  const auth =
    credential === undefined
      ? ""
      : `${encodeURIComponent(credential.user)}:${encodeURIComponent(credential.password)}@`;
  const query = credential?.authSource === undefined ? "" : `?authSource=${credential.authSource}`;
  const uri = `mongodb://${auth}127.0.0.1:${server.port}/${query}`;
  const deadline = Date.now() + 120_000;
  let last: unknown;
  while (Date.now() < deadline) {
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2_000 });
    try {
      await client.connect();
      await client.db("admin").command({ ping: 1 });
      return client;
    } catch (error) {
      last = error;
      await client.close().catch(() => {});
      await sleep(500);
    }
  }
  throw new Error(
    `${server.label} accepted no connection within 120 s: ${String(last)}\n${dockerLogs(server.container)}`,
  );
}

/** The read user 02-agent-principal.js creates, with the password it sets. */
const AGENT: Credential = Object.freeze({ user: "libredb_agent", password: "libredb_agent", authSource: "app" });
/** The database the read user reads, and every connection below is bound to unless it says otherwise. */
const BOUND = "app";
/** The collection the probe names: a refusal must leave a collection of that name as it was. */
const PROBE_COLLECTION = "libredb_agent_probe";
const VICTIM_DATABASE = "live_victim";
/** A database nothing may create: a refused open bound to it must leave it absent. */
const ABSENT_DATABASE = "live_absent";
const OTHER_DATABASE = "live_other";
const FENCE_COLLECTION = "live_fence";
const SLOW_COLLECTION = "live_slow";
const RSS_COLLECTION = "live_rss";
const HUGE_COLLECTION = "live_huge";
const BINARY_COLLECTION = "live_binary";
const DISTINCT_COLLECTION = "live_distinct";

interface Credential {
  readonly user: string;
  readonly password: string;
  /** The database the user lives in; absent, the bound database, as the driver reads it. */
  readonly authSource?: string;
}

function rootOf(server: Server): Credential {
  if (server.rootPassword === undefined) throw new Error(`${server.label} has no root user`);
  return { user: ROOT_USER, password: server.rootPassword, authSource: "admin" };
}

/** The privilege roles the role matrix grants beside `read`, each a custom role made for it. */
const MATRIX_ROLES: readonly { readonly db: string; readonly role: string; readonly privileges: Document[] }[] = [
  {
    db: "admin",
    role: "live_find_system_users",
    privileges: [{ resource: { db: "admin", collection: "system.users" }, actions: ["find"] }],
  },
  {
    db: BOUND,
    role: "live_insert_one_collection",
    privileges: [{ resource: { db: BOUND, collection: FENCE_COLLECTION }, actions: ["insert"] }],
  },
];

const READ = { role: "read", db: BOUND };

/** Users whose privileges reach past reads of the bound database: each is refused PROFILE_PRIVILEGES_TOO_BROAD. */
const TOO_BROAD_USERS: readonly { readonly user: string; readonly holds: string; readonly roles: Document[] }[] = [
  { user: "live_backup", holds: "read plus backup", roles: [READ, { role: "backup", db: "admin" }] },
  {
    user: "live_system_users",
    holds: "read plus a role reading admin.system.users",
    roles: [READ, { role: "live_find_system_users", db: "admin" }],
  },
  { user: "live_user_admin", holds: "read plus userAdmin", roles: [READ, { role: "userAdmin", db: BOUND }] },
  {
    user: "live_readwrite_other",
    holds: "read plus readWrite on another database",
    roles: [READ, { role: "readWrite", db: OTHER_DATABASE }],
  },
  {
    user: "live_insert_one",
    holds: "read plus insert on one collection",
    roles: [READ, { role: "live_insert_one_collection", db: BOUND }],
  },
  { user: "live_two_databases", holds: "read on two databases", roles: [READ, { role: "read", db: OTHER_DATABASE }] },
  { user: "live_read_any", holds: "readAnyDatabase", roles: [{ role: "readAnyDatabase", db: "admin" }] },
];

const NO_ROLES_USER = "live_no_roles";

/** The filter whose `$expr` builds a 200,000-element array per document: no read of it ends on its own in time. */
const SLOW_FILTER = {
  a: { $gte: 0 },
  b: { $gte: 0 },
  $expr: { $lt: [{ $size: { $range: [0, { $add: ["$i", 200000] }] } }, 0] },
};

/** The deadline the slow reads run under: short, so the run stays short. */
const SLOW_BUDGET: ReadOnlyStatementBudget = Object.freeze({
  statementTimeoutMs: 500,
  maxResultRows: 3,
  maxResultBytes: 1_000_000,
});

/** The budget the plans and the ordinary reads run under; its row bound is what a sort plans. */
const READ_BUDGET: ReadOnlyStatementBudget = Object.freeze({
  statementTimeoutMs: 10_000,
  maxResultRows: 10,
  maxResultBytes: 1_000_000,
});

/** The slow collection, on every server a deadline is measured on: two indexes, so its plan has two candidates. */
async function seedSlowCollection(root: MongoClient): Promise<void> {
  const collection = root.db(BOUND).collection(SLOW_COLLECTION);
  await collection.insertMany(Array.from({ length: 20_000 }, (_, i) => ({ i, a: i, b: i })));
  await collection.createIndex({ a: 1 });
  await collection.createIndex({ b: 1 });
}

/** Everything the checks on the primary 9.0.4 server read, and the role matrix's users. */
async function seedPrimaryServer(root: MongoClient, usersPassword: string): Promise<void> {
  const app = root.db(BOUND);
  await app.collection(FENCE_COLLECTION).insertMany([1, 2, 3].map((n) => ({ n, kept: true })));
  await seedSlowCollection(root);
  await app.collection(RSS_COLLECTION).insertMany(Array.from({ length: 1000 }, (_, i) => ({ i, pad: "x".repeat(50) })));
  // Near the 16 MiB a document may hold: one batch of one document, as large as a batch gets.
  await app.collection(HUGE_COLLECTION).insertOne({ blob: "y".repeat(16 * 1024 * 1024 - 1024) });
  await app.collection(BINARY_COLLECTION).insertOne({ blob: new Binary(Buffer.alloc(220_000)) });
  // One array of 780,000 small documents: a distinct of it answers each as a value, a reply of about 14.8 MiB.
  await app.collection(DISTINCT_COLLECTION).insertOne({ v: Array.from({ length: 780_000 }, (_, a) => ({ a })) });
  await seedVictim(root);
  for (const { db, role, privileges } of MATRIX_ROLES) {
    await root.db(db).command({ createRole: role, privileges, roles: [] });
  }
  for (const { user, roles } of TOO_BROAD_USERS) await app.command({ createUser: user, pwd: usersPassword, roles });
  await app.command({ createUser: NO_ROLES_USER, pwd: usersPassword, roles: [] });
}

async function seedVictim(client: MongoClient): Promise<void> {
  await client
    .db(VICTIM_DATABASE)
    .collection(PROBE_COLLECTION)
    .insertMany([1, 2, 3].map((n) => ({ n, owner: "someone else" })));
}

function check(ok: boolean, label: string, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${label}${detail === "" ? "" : ` - ${detail}`}`);
  if (!ok) throw new Error(`${label}${detail === "" ? "" : ` - ${detail}`}`);
}

function note(label: string, detail: string): void {
  console.log(`INFO ${label} - ${detail}`);
}

async function refusal(run: () => Promise<unknown>): Promise<string | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

let opens = 0;

/** A connection to the server; a fresh id each time, so the profiled cache never hands one open another's provider. */
function connectionTo(server: Server, database: string, credential?: Credential): DatabaseConnection {
  opens += 1;
  return {
    id: `live-mongodb-${RUN}-${opens}`,
    name: `live ${server.label}`,
    type: "mongodb",
    host: "127.0.0.1",
    port: server.port,
    database,
    ...credential,
    createdAt: new Date(),
  };
}

function readOnlyPath(provider: DatabaseProvider): NonNullable<DatabaseProvider["queryReadOnly"]> {
  const queryReadOnly = provider.queryReadOnly?.bind(provider);
  if (queryReadOnly === undefined) throw new Error("The profiled provider has no queryReadOnly");
  return queryReadOnly;
}

/** What a server holds, read by root or, without authorization, by anyone: every refusal must leave it as it was. */
async function serverState(client: MongoClient): Promise<string> {
  const listing = await client.db("admin").command({ listDatabases: 1, nameOnly: true });
  // `config` and `local` are the server's own, written by it in the background (its sessions, its startup log).
  const names = (listing.databases as { name: string }[])
    .map(({ name }) => name)
    .filter((name) => name !== "config" && name !== "local")
    .sort();
  const collections: Record<string, string[]> = {};
  for (const name of names) {
    const infos = await client.db(name).listCollections({}, { nameOnly: true }).toArray();
    collections[name] = infos.map(({ name: collection }) => collection).sort();
  }
  const victim = await client.db(VICTIM_DATABASE).collection(PROBE_COLLECTION).find().sort({ n: 1 }).toArray();
  const fence = await client.db(BOUND).collection(FENCE_COLLECTION).find().sort({ n: 1 }).toArray();
  return JSON.stringify({ names, collections, victim, fence });
}

interface Watched {
  readonly server: Server;
  readonly client: MongoClient;
  readonly baseline: string;
}

/** The servers whose state changed since their baseline, with what they hold now. */
async function changedServers(watched: readonly Watched[]): Promise<string[]> {
  const changed: string[] = [];
  for (const { server, client, baseline } of watched) {
    const now = await serverState(client);
    if (now !== baseline) changed.push(`${server.label} changed: ${now}`);
  }
  return changed;
}

/** An open the profile must refuse with `code`, leaving every watched server as it was. */
async function expectRefusedAtOpen(
  label: string,
  connection: DatabaseConnection,
  profile: ExecutionProfile,
  code: string,
  watched: readonly Watched[],
): Promise<void> {
  let reason: string;
  try {
    const provider = await acquireExecutionProfileProvider(connection, profile);
    await provider.disconnect();
    reason = "it opened";
  } catch (error) {
    reason = error instanceof ExecutionProfileError ? `${error.reasonCode}: ${error.message}` : String(error);
  }
  const changed = await changedServers(watched);
  check(
    reason.startsWith(`${code}:`) && changed.length === 0,
    `${label} is refused ${code}, and nothing changed`,
    [reason.slice(0, 170), ...changed].join("; "),
  );
}

/** The actions the read user's session holds, as the server answers them. */
async function sessionActions(server: Server): Promise<string[]> {
  const client = await connectWhenReady(server, AGENT);
  try {
    const status = await client.db(BOUND).command({ connectionStatus: 1, showPrivileges: true });
    const privileges = (status.authInfo?.authenticatedUserPrivileges ?? []) as { actions: string[] }[];
    return [...new Set(privileges.flatMap(({ actions }) => actions))].sort();
  } finally {
    await client.close();
  }
}

/**
 * The commands the server logged for one verified open of the read user: the command log's verbosity is raised to 1
 * around it, which logs every command the server runs with its whole document (id 51803), and set back after.
 */
async function loggedOpenCommands(server: Server, root: MongoClient): Promise<Map<string, Document>> {
  const admin = root.db("admin");
  const before = (await admin.command({ getLog: "global" })).totalLinesWritten as number;
  await admin.command({ setParameter: 1, logComponentVerbosity: { command: { verbosity: 1 } } });
  try {
    const provider = await acquireExecutionProfileProvider(connectionTo(server, BOUND, AGENT), "agent-read-only");
    await provider.disconnect();
  } finally {
    await admin.command({ setParameter: 1, logComponentVerbosity: { command: { verbosity: 0 } } });
  }
  const log = await admin.command({ getLog: "global" });
  const lines = log.log as string[];
  const written = (log.totalLinesWritten as number) - before;
  const commands = new Map<string, Document>();
  for (const line of lines.slice(Math.max(0, lines.length - written))) {
    const entry = JSON.parse(line) as { id?: number; attr?: { command?: Document } };
    const command = entry.attr?.command;
    if (entry.id === 51803 && command?.comment === AGENT_COMMAND_COMMENT)
      commands.set(Object.keys(command)[0], command);
  }
  return commands;
}

/** The read user is admitted and reads, holding exactly the read role's actions on this version. */
async function checkReadUser(server: Server, expectedActions: readonly string[]): Promise<void> {
  const provider = await acquireExecutionProfileProvider(connectionTo(server, BOUND, AGENT), "agent-read-only");
  try {
    const orders = await readOnlyPath(provider)('{"collection": "orders", "operation": "find"}', READ_BUDGET);
    check(
      orders.rowCount === 2,
      `${server.label}: libredb_agent is admitted and reads app.orders`,
      `${orders.rowCount} rows`,
    );
  } finally {
    await provider.disconnect();
  }
  const actions = await sessionActions(server);
  check(
    JSON.stringify(actions) === JSON.stringify([...expectedActions].sort()),
    `${server.label}: libredb_agent's session holds exactly the read role's measured actions`,
    actions.join(", "),
  );
}

/** The open's three checks carry the server's deadline and the agent's comment, as the server logs them. */
async function checkOpenCommands(server: Server, root: MongoClient): Promise<void> {
  const logged = await loggedOpenCommands(server, root);
  for (const name of ["buildInfo", "connectionStatus", "delete"]) {
    const command = logged.get(name);
    check(
      command?.maxTimeMS === AGENT_VERIFY_MAX_TIME_MS,
      `${server.label}: the open's ${name} carries maxTimeMS ${AGENT_VERIFY_MAX_TIME_MS} and the agent's comment, as the server logged it`,
      command === undefined ? `not logged; logged: ${[...logged.keys()].join(", ")}` : `maxTimeMS ${command.maxTimeMS}`,
    );
  }
}

/** The opens every version refuses: root, and a connection that authenticated no user. */
async function checkVersionRefusals(server: Server, watched: readonly Watched[]): Promise<void> {
  await expectRefusedAtOpen(
    `${server.label}: root`,
    connectionTo(server, BOUND, rootOf(server)),
    "agent-read-only",
    "PROFILE_PRIVILEGES_TOO_BROAD",
    watched,
  );
  await expectRefusedAtOpen(
    `${server.label}: a connection with no user`,
    connectionTo(server, BOUND),
    "agent-read-only",
    "PROFILE_PRIVILEGES_TOO_NARROW",
    watched,
  );
}

/** The role matrix, the no-roles user, root bound to a probe-named collection's database, and the hand-over open. */
async function checkRoleMatrix(server: Server, usersPassword: string, watched: readonly Watched[]): Promise<void> {
  for (const { user, holds } of TOO_BROAD_USERS) {
    await expectRefusedAtOpen(
      `${server.label}: ${holds}`,
      connectionTo(server, BOUND, { user, password: usersPassword, authSource: BOUND }),
      "agent-read-only",
      "PROFILE_PRIVILEGES_TOO_BROAD",
      watched,
    );
  }
  await expectRefusedAtOpen(
    `${server.label}: a user with no roles`,
    connectionTo(server, BOUND, { user: NO_ROLES_USER, password: usersPassword, authSource: BOUND }),
    "agent-read-only",
    "PROFILE_PRIVILEGES_TOO_NARROW",
    watched,
  );
  await expectRefusedAtOpen(
    `${server.label}: root bound to a database holding a ${PROBE_COLLECTION} collection`,
    connectionTo(server, VICTIM_DATABASE, rootOf(server)),
    "agent-read-only",
    "PROFILE_PRIVILEGES_TOO_BROAD",
    watched,
  );
  await expectRefusedAtOpen(
    `${server.label}: root under the hand-over profile`,
    connectionTo(server, BOUND, rootOf(server)),
    "agent-handover",
    "PROFILE_PRIVILEGES_TOO_BROAD",
    watched,
  );
  const handover = await acquireExecutionProfileProvider(connectionTo(server, BOUND, AGENT), "agent-handover");
  await handover.disconnect();
  check(true, `${server.label}: libredb_agent is admitted under the hand-over profile`);
}

/** A server that enforces nothing is refused for every connection, and the probe it accepted changed nothing. */
async function checkUnenforced(server: Server, watched: readonly Watched[]): Promise<void> {
  await expectRefusedAtOpen(
    `${server.label}: libredb_agent`,
    connectionTo(server, BOUND, AGENT),
    "agent-read-only",
    "PROFILE_SERVER_UNENFORCED",
    watched,
  );
  await expectRefusedAtOpen(
    `${server.label}: a connection with no user`,
    connectionTo(server, BOUND),
    "agent-read-only",
    "PROFILE_SERVER_UNENFORCED",
    watched,
  );
  await expectRefusedAtOpen(
    `${server.label}: a connection bound to a database that does not exist`,
    connectionTo(server, ABSENT_DATABASE),
    "agent-read-only",
    "PROFILE_SERVER_UNENFORCED",
    watched,
  );
  await expectRefusedAtOpen(
    `${server.label}: a connection bound to a database holding a ${PROBE_COLLECTION} collection`,
    connectionTo(server, VICTIM_DATABASE),
    "agent-read-only",
    "PROFILE_SERVER_UNENFORCED",
    watched,
  );
}

/** The operations profile proves no statement boundary: it opens what the read-only profile refuses, and lists. */
async function checkOperationsProfile(
  server: Server,
  credential: Credential | undefined,
  watched: readonly Watched[],
): Promise<void> {
  const who = credential === undefined ? "a connection with no user" : credential.user;
  const provider = await acquireExecutionProfileProvider(connectionTo(server, BOUND, credential), "agent-operations");
  try {
    const listed = (await provider.listObjects([BOUND], "collection")).map(({ name }) => name);
    const statement = await refusal(() =>
      readOnlyPath(provider)('{"collection": "orders", "operation": "count"}', READ_BUDGET),
    );
    const changed = await changedServers(watched);
    check(
      listed.includes("orders") && statement !== null && changed.length === 0,
      `${server.label}: ${who} opens unverified under agent-operations, lists collections, and sends no statement`,
      [`${listed.length} collections`, statement?.slice(0, 80) ?? "a statement ran", ...changed].join("; "),
    );
  } finally {
    await provider.disconnect();
  }
}

const NOTHING_SENT = /Nothing was sent\./;

/** The fence: each statement is refused before anything is sent, and the writes are refused by the server around it. */
async function checkFence(server: Server, watched: readonly Watched[]): Promise<void> {
  const provider = await acquireExecutionProfileProvider(connectionTo(server, BOUND, AGENT), "agent-read-only");
  const read = readOnlyPath(provider);
  try {
    const writes: [string, Document][] = [
      ["insertOne", { operation: "insertOne", documents: [{ planted: true }] }],
      ["insertMany", { operation: "insertMany", documents: [{ planted: true }, { planted: true }] }],
      ["updateOne", { operation: "updateOne", filter: {}, update: { $set: { kept: false } } }],
      ["updateMany", { operation: "updateMany", filter: {}, update: { $set: { kept: false } } }],
      ["deleteOne", { operation: "deleteOne", filter: {} }],
      ["deleteMany", { operation: "deleteMany", filter: {} }],
      ["$out at the top level", { operation: "aggregate", pipeline: [{ $out: "live_written" }] }],
      ["$merge at the top level", { operation: "aggregate", pipeline: [{ $merge: { into: "live_written" } }] }],
      ["$out inside $facet", { operation: "aggregate", pipeline: [{ $facet: { a: [{ $out: "live_written" }] } }] }],
      [
        "$merge inside $lookup's pipeline",
        {
          operation: "aggregate",
          pipeline: [{ $lookup: { from: "orders", as: "x", pipeline: [{ $merge: "live_written" }] } }],
        },
      ],
      [
        "$out inside $unionWith's pipeline",
        {
          operation: "aggregate",
          pipeline: [{ $unionWith: { coll: "orders", pipeline: [{ $out: "live_written" }] } }],
        },
      ],
    ];
    for (const [label, command] of writes) {
      const text = JSON.stringify({ collection: FENCE_COLLECTION, ...command });
      const fenced = await refusal(() => read(text, READ_BUDGET));
      check(
        fenced !== null && NOTHING_SENT.test(fenced),
        `the fence refuses ${label}`,
        fenced?.slice(0, 90) ?? "it ran",
      );
      // The same text through the editor's own envelope on the profiled connection: the user is the boundary.
      const around = await refusal(() => provider.query(text));
      check(
        around !== null && /not authorized/i.test(around),
        `the server refuses ${label} sent around the fence`,
        around?.slice(0, 90) ?? "it ran",
      );
    }
    const refusedBeforeSending: [string, string][] = [
      [
        "two commands as one statement",
        JSON.stringify([
          { collection: "orders", operation: "find" },
          { collection: FENCE_COLLECTION, operation: "find" },
        ]),
      ],
      [
        "two commands written one after the other",
        `${JSON.stringify({ collection: "orders", operation: "find" })} ${JSON.stringify({ collection: FENCE_COLLECTION, operation: "find" })}`,
      ],
      [
        "$_internalJsEmit in a $project",
        JSON.stringify({
          collection: "orders",
          operation: "aggregate",
          pipeline: [{ $project: { x: { $_internalJsEmit: { eval: "function() { emit(1, 1); }", this: {} } } } }],
        }),
      ],
      [
        "$_internalJsEmit in a find's projection",
        JSON.stringify({
          collection: "orders",
          operation: "find",
          options: { projection: { x: { $_internalJsEmit: { eval: "function() { emit(1, 1); }", this: {} } } } },
        }),
      ],
      [
        "$_internalJsReduce in a $group",
        JSON.stringify({
          collection: "orders",
          operation: "aggregate",
          pipeline: [
            { $group: { _id: null, x: { $_internalJsReduce: { data: "$total", eval: "function(k, v) {}" } } } },
          ],
        }),
      ],
      ["$where", JSON.stringify({ collection: "orders", operation: "find", filter: { $where: "true" } })],
      [
        "$function",
        JSON.stringify({
          collection: "orders",
          operation: "find",
          filter: { $expr: { $function: { body: "function() { return true; }", args: [], lang: "js" } } },
        }),
      ],
      [
        "$planCacheStats at the top level",
        JSON.stringify({ collection: "orders", operation: "aggregate", pipeline: [{ $planCacheStats: {} }] }),
      ],
      [
        "$planCacheStats inside $unionWith's pipeline",
        JSON.stringify({
          collection: "orders",
          operation: "aggregate",
          pipeline: [{ $unionWith: { coll: "orders", pipeline: [{ $planCacheStats: {} }] } }],
        }),
      ],
      ["$collStats", JSON.stringify({ collection: "orders", operation: "aggregate", pipeline: [{ $collStats: {} }] })],
      [
        "$changeStream",
        JSON.stringify({ collection: "orders", operation: "aggregate", pipeline: [{ $changeStream: {} }] }),
      ],
      ["a find limit of 0", JSON.stringify({ collection: "orders", operation: "find", options: { limit: 0 } })],
    ];
    for (const [label, text] of refusedBeforeSending) {
      const fenced = await refusal(() => read(text, READ_BUDGET));
      check(
        fenced !== null && NOTHING_SENT.test(fenced),
        `the fence refuses ${label}`,
        fenced?.slice(0, 90) ?? "it ran",
      );
    }
    const other = await refusal(() =>
      read(JSON.stringify({ collection: "orders", database: "admin", operation: "find" }), READ_BUDGET),
    );
    check(
      other !== null && other.includes(`reads the database "${BOUND}" its connection is bound to`),
      "a command naming another database is refused, naming the bound one",
      other?.slice(0, 110) ?? "it ran",
    );
    const bound = await read(
      JSON.stringify({ collection: "orders", database: BOUND, operation: "count" }),
      READ_BUDGET,
    );
    check(
      JSON.stringify(bound.rows) === '[{"count":2}]',
      "a command naming the bound database is served",
      JSON.stringify(bound.rows),
    );
    const changed = await changedServers(watched);
    check(
      changed.length === 0,
      `${server.label}: root reads the data back unchanged after the fence`,
      changed.join("; "),
    );
  } finally {
    await provider.disconnect();
  }
}

/** Root's own explain of a command, for the host the server names itself by. */
async function serverHost(root: MongoClient, command: Document): Promise<string> {
  const reply = await root.db(BOUND).command({ explain: command, verbosity: "queryPlanner" });
  return String((reply.serverInfo as Document | undefined)?.host ?? "");
}

/** A count plans the group it runs, a sort plans the row bound, and a plan row is the plan alone. */
async function checkPlans(server: Server, root: MongoClient): Promise<void> {
  const provider = await acquireExecutionProfileProvider(connectionTo(server, BOUND, AGENT), "agent-read-only");
  const read = readOnlyPath(provider);
  const bound = READ_BUDGET.maxResultRows + 1;
  try {
    const plans: [string, Document, Document][] = [
      [
        "count",
        { collection: SLOW_COLLECTION, operation: "count" },
        {
          aggregate: SLOW_COLLECTION,
          pipeline: [{ $match: {} }, { $group: { _id: 1, n: { $sum: 1 } } }],
          cursor: {},
        },
      ],
      [
        "aggregate $sort",
        { collection: SLOW_COLLECTION, operation: "aggregate", pipeline: [{ $sort: { i: 1 } }] },
        { aggregate: SLOW_COLLECTION, pipeline: [{ $sort: { i: 1 } }, { $limit: bound }], cursor: {} },
      ],
      [
        "find",
        { collection: SLOW_COLLECTION, operation: "find", filter: { a: 5 } },
        { find: SLOW_COLLECTION, filter: { a: 5 }, limit: bound },
      ],
      [
        "findOne",
        { collection: SLOW_COLLECTION, operation: "findOne", filter: { b: 5 }, options: { projection: { i: 1 } } },
        { find: SLOW_COLLECTION, filter: { b: 5 }, projection: { i: 1 }, limit: 1 },
      ],
      [
        "distinct",
        { collection: SLOW_COLLECTION, operation: "distinct", field: "a", filter: { b: { $lt: 3 } } },
        { distinct: SLOW_COLLECTION, key: "a", query: { b: { $lt: 3 } } },
      ],
    ];
    for (const [label, statement, rootCommand] of plans) {
      const result = await read(JSON.stringify(statement), READ_BUDGET, "estimate-plan");
      const row = result.rows[0] as Record<string, unknown>;
      const problems = planRowProblems(row, await serverHost(root, rootCommand));
      check(
        result.rowCount === 1 && problems.length === 0,
        `${server.label}: the ${label} plan row holds only plan keys and not the server's host`,
        problems.length === 0 ? Object.keys(row).join(", ") : problems.join("; "),
      );
      if (label === "count") {
        const stages = planStageNames(row);
        check(
          planRunsGroup(row) && !stages.includes("RECORD_STORE_FAST_COUNT"),
          `${server.label}: a count plans the $group it runs, never RECORD_STORE_FAST_COUNT`,
          stages.join(" < "),
        );
      }
      if (label === "aggregate $sort") {
        const limits = planSortLimits(row);
        check(
          limits.includes(bound),
          `${server.label}: an aggregate $sort plans the row bound, ${bound}`,
          `sort limits ${JSON.stringify(limits)}`,
        );
      }
    }
  } finally {
    await provider.disconnect();
  }
}

/** How many operations root's `$currentOp` lists on the slow collection, every user's included. */
async function runningOn(root: MongoClient): Promise<number> {
  const ops = await root
    .db("admin")
    .aggregate([
      { $currentOp: { allUsers: true, idleSessions: false } },
      { $match: { ns: `${BOUND}.${SLOW_COLLECTION}` } },
    ])
    .toArray();
  return ops.length;
}

const SLOW_READS: readonly [string, Document, "execute" | "estimate-plan"][] = [
  ["find", { collection: SLOW_COLLECTION, operation: "find", filter: SLOW_FILTER }, "execute"],
  ["find's plan", { collection: SLOW_COLLECTION, operation: "find", filter: SLOW_FILTER }, "estimate-plan"],
  [
    "aggregate",
    { collection: SLOW_COLLECTION, operation: "aggregate", pipeline: [{ $match: SLOW_FILTER }] },
    "execute",
  ],
  [
    "aggregate's plan",
    { collection: SLOW_COLLECTION, operation: "aggregate", pipeline: [{ $match: SLOW_FILTER }] },
    "estimate-plan",
  ],
  ["count", { collection: SLOW_COLLECTION, operation: "count", filter: SLOW_FILTER }, "execute"],
  ["distinct", { collection: SLOW_COLLECTION, operation: "distinct", field: "a", filter: SLOW_FILTER }, "execute"],
  [
    "distinct's plan",
    { collection: SLOW_COLLECTION, operation: "distinct", field: "a", filter: SLOW_FILTER },
    "estimate-plan",
  ],
  ["findOne", { collection: SLOW_COLLECTION, operation: "findOne", filter: SLOW_FILTER }, "execute"],
];

/**
 * Each slow read and slow plan ends at its deadline with nothing left running. On a server that keeps `maxTimeMS`,
 * the server ends it (code 50) within 1,500 ms of the deadline. On a server whose `maxTimeNeverTimeOut` fail point
 * disables `maxTimeMS`, only the provider's own timer can: it fires one backstop past the deadline and kills the read's
 * session, which must end it within the kill's grace, the plans included, whose explain runs as its own command in the
 * session rather than as the cursor the builder opened.
 */
async function checkDeadlines(server: Server, root: MongoClient, killedByTheProvider: boolean): Promise<void> {
  const provider = await acquireExecutionProfileProvider(connectionTo(server, BOUND, AGENT), "agent-read-only");
  const read = readOnlyPath(provider);
  const deadline = SLOW_BUDGET.statementTimeoutMs;
  const earliest = killedByTheProvider ? deadline + AGENT_DEADLINE_BACKSTOP_MS : 0;
  const latest = killedByTheProvider ? deadline + AGENT_DEADLINE_BACKSTOP_MS + AGENT_KILL_GRACE_MS : deadline + 1_500;
  const who = killedByTheProvider ? "the provider's kill of its session" : "the server's maxTimeMS";
  if (killedByTheProvider) {
    await root.db("admin").command({ configureFailPoint: "maxTimeNeverTimeOut", mode: "alwaysOn" });
  }
  try {
    for (const [label, statement, mode] of SLOW_READS) {
      const started = Date.now();
      const message = await refusal(() => read(JSON.stringify(statement), SLOW_BUDGET, mode));
      const elapsed = Date.now() - started;
      await sleep(200);
      const left = await runningOn(root);
      check(
        message !== null &&
          message.includes(`statement deadline of ${deadline}ms and was killed server-side`) &&
          elapsed >= earliest &&
          elapsed < latest &&
          left === 0,
        `${server.label}: a slow ${label} ends at ${who}, with nothing left running`,
        `${elapsed} ms, ${left} operations left 200 ms later; ${message?.slice(0, 90) ?? "it was served"}`,
      );
    }
  } finally {
    if (killedByTheProvider) await root.db("admin").command({ configureFailPoint: "maxTimeNeverTimeOut", mode: "off" });
    await provider.disconnect();
  }
}

/** The reads the memory check measures, each in a process of its own (`--rss-case <key>`). */
const RSS_CASES: Readonly<Record<string, { readonly label: string; readonly statement: Document }>> = {
  aggregate: {
    label: "an aggregate building 200,000-element arrays",
    statement: {
      collection: RSS_COLLECTION,
      operation: "aggregate",
      pipeline: [{ $project: { pad: { $range: [0, 200000] } } }],
    },
  },
  find: {
    label: "a find projecting 200,000-element arrays",
    statement: {
      collection: RSS_COLLECTION,
      operation: "find",
      options: { projection: { pad: { $range: [0, 200000] } } },
    },
  },
  document: { label: "a near-16 MiB document", statement: { collection: HUGE_COLLECTION, operation: "find" } },
  binary: { label: "a 220,000-byte Binary document", statement: { collection: BINARY_COLLECTION, operation: "find" } },
  distinct: {
    label: "a near-16 MiB distinct",
    statement: { collection: DISTINCT_COLLECTION, operation: "distinct", field: "v" },
  },
};

const RSS_RESULT = "RSS-RESULT ";

/**
 * One memory case, run in this process when it was started with `--rss-case <case> <port>`: the read user reads it
 * under the investigation budget, with the process's resident size sampled every 2 ms around the read, and the growth
 * is printed on one line for the parent.
 */
async function measureRssCase(name: string, port: number): Promise<void> {
  const server: Server = { label: "9.0.4", container: "", port };
  const provider = await acquireExecutionProfileProvider(connectionTo(server, BOUND, AGENT), "agent-read-only");
  const budget = AGENT_WORKFLOW_BUDGETS.investigation.policy.budgets;
  Bun.gc(true);
  const base = process.memoryUsage().rss;
  let peak = base;
  const sampler = setInterval(() => {
    peak = Math.max(peak, process.memoryUsage().rss);
  }, 2);
  let outcome: string;
  try {
    const result = await readOnlyPath(provider)(JSON.stringify(RSS_CASES[name].statement), budget);
    outcome = `served ${result.rowCount} rows`;
  } catch (error) {
    outcome = `refused: ${error instanceof Error ? error.message : String(error)}`;
  }
  clearInterval(sampler);
  peak = Math.max(peak, process.memoryUsage().rss);
  console.log(`${RSS_RESULT}${JSON.stringify({ outcome, growth: peak - base })}`);
  await provider.disconnect();
  await clearProviderCache();
}

function runRssCase(name: string, server: Server): { outcome: string; growth: number } {
  const child = spawnSync(process.execPath, [import.meta.path, "--rss-case", name, String(server.port)], {
    encoding: "utf8",
    timeout: 120_000,
  });
  const line = (child.stdout ?? "").split("\n").find((text) => text.startsWith(RSS_RESULT));
  if (child.status !== 0 || line === undefined) {
    throw new Error(`The memory case "${name}" did not finish (exit ${child.status}): ${child.stderr}`);
  }
  return JSON.parse(line.slice(RSS_RESULT.length)) as { outcome: string; growth: number };
}

const mib = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MiB`;

/**
 * Cursor reads and a near-16 MiB document are refused within the ceiling, under the investigation budget. A near-16 MiB
 * distinct is decoded whole before either budget is read (docs/providers/mongodb.md, and its backlog entry), so its
 * growth is printed for the record rather than held to the ceiling until that entry is closed.
 */
function checkMemory(server: Server): void {
  for (const key of ["aggregate", "find", "document"]) {
    const { outcome, growth } = runRssCase(key, server);
    check(
      /exceeded the byte budget/.test(outcome) && growth < RSS_CEILING_BYTES,
      `${RSS_CASES[key].label} past the byte budget is refused, the process growing under ${mib(RSS_CEILING_BYTES)}`,
      `${mib(growth)} grown, ${outcome.slice(0, 80)}`,
    );
  }
  const binary = runRssCase("binary", server);
  check(/^served 1 rows/.test(binary.outcome), `${RSS_CASES.binary.label} is served`, binary.outcome);
  const distinct = runRssCase("distinct", server);
  note(
    `${RSS_CASES.distinct.label} is decoded whole before its budgets, so it is measured and not held to the ceiling`,
    `${mib(distinct.growth)} grown, ${distinct.outcome.slice(0, 80)}`,
  );
}

/** The hand-over replays a statement under the "no time limit" budget, whose timer must not overflow and fire at once. */
async function checkHandover(server: Server, overflowWarnings: () => number): Promise<void> {
  const provider = await acquireExecutionProfileProvider(connectionTo(server, BOUND, AGENT), "agent-handover");
  const read = readOnlyPath(provider);
  const statements = [
    { collection: SLOW_COLLECTION, operation: "find", options: { limit: 400 } },
    { collection: SLOW_COLLECTION, operation: "aggregate", pipeline: [{ $limit: 400 }] },
    { collection: SLOW_COLLECTION, operation: "count" },
    { collection: SLOW_COLLECTION, operation: "distinct", field: "i", filter: { i: { $lt: 50 } } },
    { collection: SLOW_COLLECTION, operation: "findOne", filter: { i: 7 } },
  ];
  let served = 0;
  const refusals = new Set<string>();
  try {
    for (let n = 0; n < 20; n += 1) {
      const message = await refusal(() =>
        read(JSON.stringify(statements[n % statements.length]), AGENT_HANDOVER_BUDGET),
      );
      if (message === null) served += 1;
      else refusals.add(message.slice(0, 90));
    }
  } finally {
    await provider.disconnect();
  }
  check(
    served === 20 && overflowWarnings() === 0,
    "20 reads under the hand-over budget are served, with no TimeoutOverflowWarning",
    `${served} served, ${overflowWarnings()} warnings ${[...refusals].join("; ")}`,
  );
}

/** A server the checks read, its root (or, without authorization, anonymous) client, and what it held before them. */
async function watch(server: Server, client: MongoClient): Promise<Watched> {
  return { server, client, baseline: await serverState(client) };
}

async function run(matrix: boolean, overflowWarnings: () => number): Promise<void> {
  if (!dockerAvailable()) throw new Error("Docker daemon is not available");
  const image = liveImage(process.env);
  const name = (role: string) => `libredb-live-mongo-${RUN}-${role}`;
  const primary = startMongo("9.0.4", { name: name("auth"), image, authorization: true });
  const unenforced = startMongo("9.0.4 without authorization", { name: name("noauth"), image, authorization: false });
  const killable = startMongo("9.0.4 with maxTimeMS disabled", {
    name: name("kill"),
    image,
    authorization: true,
    testCommands: true,
  });
  const versions = matrix
    ? Object.entries(MONGODB_MATRIX_IMAGES).map(([version, versionImage]) => ({
        version,
        server: startMongo(version, { name: name(`${version}-auth`), image: versionImage, authorization: true }),
        killable: startMongo(`${version} with maxTimeMS disabled`, {
          name: name(`${version}-kill`),
          image: versionImage,
          authorization: true,
          testCommands: true,
        }),
      }))
    : [];
  const ferret = matrix ? await startFerretDB() : undefined;
  console.log(`Containers started (run ${RUN}); waiting for the servers`);

  const clients: MongoClient[] = [];
  try {
    const [primaryRoot, unenforcedClient, killRoot] = await Promise.all([
      connectWhenReady(primary, rootOf(primary)),
      connectWhenReady(unenforced),
      connectWhenReady(killable, rootOf(killable)),
    ]);
    clients.push(primaryRoot, unenforcedClient, killRoot);
    const usersPassword = randomBytes(16).toString("hex");
    await seedPrimaryServer(primaryRoot, usersPassword);
    await seedVictim(unenforcedClient);
    await seedSlowCollection(killRoot);
    console.log("Servers seeded");

    const watched = [await watch(primary, primaryRoot), await watch(unenforced, unenforcedClient)];
    const allActions = [...MONGO_AGENT_READ_ACTIONS];
    await checkReadUser(primary, allActions);
    await checkVersionRefusals(primary, watched);
    await checkRoleMatrix(primary, usersPassword, watched);
    await checkUnenforced(unenforced, watched);
    await checkOpenCommands(primary, primaryRoot);
    await checkOperationsProfile(primary, rootOf(primary), watched);
    await checkOperationsProfile(unenforced, undefined, watched);
    await checkFence(primary, watched);
    await checkPlans(primary, primaryRoot);
    await checkDeadlines(primary, primaryRoot, false);
    await checkDeadlines(killable, killRoot, true);
    checkMemory(primary);
    await checkHandover(primary, overflowWarnings);
    const changed = await changedServers(watched);
    check(changed.length === 0, "every check left both servers as they were", changed.join("; "));

    for (const version of versions) {
      const [root, versionKillRoot] = await Promise.all([
        connectWhenReady(version.server, rootOf(version.server)),
        connectWhenReady(version.killable, rootOf(version.killable)),
      ]);
      clients.push(root, versionKillRoot);
      await seedSlowCollection(root);
      await seedSlowCollection(versionKillRoot);
      const versionWatched = [await watch(version.server, root)];
      // 7.0's read role does not hold performRawDataOperations, which 8.3 and 9.0 added.
      const actions = version.version.startsWith("7.")
        ? allActions.filter((action) => action !== "performRawDataOperations")
        : allActions;
      await checkReadUser(version.server, actions);
      await checkVersionRefusals(version.server, versionWatched);
      await checkOpenCommands(version.server, root);
      await checkPlans(version.server, root);
      await checkDeadlines(version.server, root, false);
      await checkDeadlines(version.killable, versionKillRoot, true);
    }

    if (ferret !== undefined) {
      const { server, credential } = ferret;
      clients.push(await connectWhenReady(server, credential));
      await expectRefusedAtOpen(
        `${server.label}: its backend's user`,
        connectionTo(server, BOUND, credential),
        "agent-read-only",
        "PROFILE_UNSUPPORTED_TARGET",
        [],
      );
      const operations = await acquireExecutionProfileProvider(
        connectionTo(server, BOUND, credential),
        "agent-operations",
      );
      await operations.disconnect();
      check(true, `${server.label}: its backend's user opens unverified under agent-operations`);
    }
  } finally {
    await clearProviderCache();
    for (const client of clients) await client.close().catch(() => {});
  }
}

async function main(): Promise<void> {
  const rssCase = process.argv.indexOf("--rss-case");
  if (rssCase !== -1) {
    await measureRssCase(process.argv[rssCase + 1], Number(process.argv[rssCase + 2]));
    return;
  }
  let overflows = 0;
  process.on("warning", (warning) => {
    if (warning.name === "TimeoutOverflowWarning") overflows += 1;
  });
  // A signal skips `finally`; the containers go anyway.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      removeEverything();
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  }
  try {
    await run(process.argv.includes("--matrix"), () => overflows);
    console.log("\nEvery check passed.");
  } catch (error) {
    console.error("\nFAIL live MongoDB agent read-only check");
    console.error(error);
    // exitCode, not process.exit(1): exit would skip the finally below and leave the containers running.
    process.exitCode = 1;
  } finally {
    removeEverything();
  }
}

if (import.meta.main) await main();
