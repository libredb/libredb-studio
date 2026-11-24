/**
 * Live PostgreSQL check: a tree read answers on the connection's metadata session while editor statements hold every
 * connection of the editor's pool (docs/providers/CONTRACT.md, clause C-66).
 *
 * Through the real factory, `getOrCreateProvider` and `getOrCreateMetadataProvider`, with the execution context
 * `editorExecutionContext` derives, it holds every editor connection with `pg_sleep(4)`, once on the pool every caller
 * shares (Studio's default, 10) and once on an owned pool of 3, the default per-user size, then times one listing of the
 * seeded tables on the metadata session and one on the editor's provider. It fails unless the metadata listing answers
 * within 1,000 ms while the editor's waits for the holders, and exits non-zero on any failure.
 *
 * Then, on hold rounds of their own, it runs a session kill as POST /api/db/maintenance runs it: on the metadata session
 * (`metadataProvider` in src/lib/api/editor-provider.ts), its declarations read under the same posture, through
 * `providerMaintenance` and the host core, against one of the editor statements holding the editor's pool. Once on the
 * connection above, its shared pool of 10 held ("kill, pinned"), and once in the catalog `postgres` of a server-level
 * copy of it, the editor's catalog session of 3 held ("kill, catalog"). Each fails unless the editor's pool is full at
 * the kill, the kill answers success within 1,000 ms, its target is gone from `pg_stat_activity`, the metadata
 * session's own backend is still there, and exactly one holder ended by the administrator's command while the rest ran
 * out.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in `tests/runner/discover.ts`).
 * It needs Docker and nothing else:
 *
 *   bun tests/live/postgres-metadata-session-live.ts
 *
 * The container publishes on a loopback port Docker picks, runs under `--memory 1g`, and its name carries a per-run
 * suffix, as in tests/live/postgres-held-session-live.ts. `LIBREDB_LIVE_PG_CONTAINER_PREFIX` replaces the name's prefix
 * for a local run. The password is drawn for each run.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { editorProvider, metadataProvider } from "@/lib/api/editor-provider";
import { editorExecutionContext } from "@/lib/api/execution-context";
import { providerMaintenance } from "@/lib/api/provider-maintenance";
import {
  clearProviderCache,
  getOrCreateMetadataProvider,
  getOrCreateProvider,
  readProviderDeclarations,
} from "@/lib/db/factory";
import { PostgresProvider } from "@/lib/db/providers/sql/postgres";
import { createHostCore } from "@/lib/provider-host/core/host-core";
import { installHostCore } from "@/lib/provider-host/instance";
import type { DatabaseProvider, EditorExecutionContext } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const PG_CONTAINER = `${process.env.LIBREDB_LIVE_PG_CONTAINER_PREFIX ?? "libredb-live-metadata-session-pg"}-${randomBytes(4).toString("hex")}`;
/** A fresh password for each run: the check starts its own container. */
function runPassword(prefix: string): string {
  return `${prefix}-${randomBytes(12).toString("hex")}`;
}
const secret = runPassword("pg");
/** How long each holder keeps its editor connection, and the most a metadata listing may take meanwhile. */
const HOLD_SECONDS = 4;
const METADATA_BOUND_MS = 1_000;
const TABLES = 20;
/** The editor pool every caller shares, Studio's default size, and an owned one of the default per-user size. */
const SHARED_POOL = 10;
const OWNED_POOL = 3;
/** The most a kill on the metadata session may take while the editor's pool is held. */
const KILL_BOUND_MS = 1_000;
/** The editor's catalog session pool on a server-level connection (`CATALOG_SESSION_POOL` in postgres.ts). */
const CATALOG_POOL = 3;
/** What PostgreSQL answers a statement whose backend `pg_terminate_backend` ended. */
const TERMINATED = "terminating connection due to administrator command";

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The host port Docker published for the container's 5432, from `docker port`'s `127.0.0.1:49153`. */
function publishedPort(container: string): number {
  const binding = docker(["port", container, "5432/tcp"]).trim().split("\n")[0] ?? "";
  const port = Number(binding.slice(binding.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Docker published no port for ${container}: "${binding}"`);
  return port;
}

/** One statement through psql inside the container, over TCP, answering its unaligned output. */
function psql(sql: string): string {
  return docker([
    "exec",
    PG_CONTAINER,
    "psql",
    "-h",
    "127.0.0.1",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-tAc",
    sql,
  ]).trim();
}

async function startPostgres(): Promise<number> {
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    PG_CONTAINER,
    "--memory",
    "1g",
    "-e",
    `POSTGRES_PASSWORD=${secret}`,
    "-p",
    "127.0.0.1::5432",
    "postgres:18-alpine",
  ]);
  const port = publishedPort(PG_CONTAINER);
  const seed = Array.from({ length: TABLES }, (_, index) => `CREATE TABLE public.t${index} (id int);`).join(" ");
  let lastError: unknown;
  for (let i = 0; i < 60; i++) {
    try {
      // Over TCP, where only the real server listens (see tests/live/postgres-read-only-live.ts).
      docker(["exec", PG_CONTAINER, "pg_isready", "-q", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres"]);
      psql(seed);
      return port;
    } catch (err) {
      lastError = err;
      // oxlint-disable-next-line no-await-in-loop -- the server is polled until it accepts the seed.
      await sleep(1000);
    }
  }
  throw new Error(`live postgres container did not accept the seed: ${lastError}`);
}

/**
 * Resolves once `count` backends are running a statement tagged `tag`, read through psql so no pool of the check is
 * used. It reads only active backends: an idle backend keeps its last statement in `pg_stat_activity.query`, so the
 * editor connections an earlier round held still show `pg_sleep` there.
 */
async function taggedHoldersArrived(tag: string, count: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const running = Number(
      psql(
        `SELECT count(*) FROM pg_stat_activity WHERE state = 'active' AND query LIKE 'SELECT pg_sleep(%) AS ${tag}_%'`,
      ),
    );
    if (running >= count) return;
    // oxlint-disable-next-line no-await-in-loop -- polled until every holder reached the server.
    await sleep(50);
  }
  throw new Error(`the ${count} holders tagged ${tag} never all reached the server`);
}

/** Milliseconds `read` took to answer, with the number of objects it listed. */
async function timed(read: () => Promise<readonly unknown[]>): Promise<{ ms: number; listed: number }> {
  const started = performance.now();
  const listed = (await read()).length;
  return { ms: Math.round(performance.now() - started), listed };
}

async function heldEditorCase(
  label: string,
  connection: DatabaseConnection,
  execution: EditorExecutionContext,
  size: number,
) {
  const editor: DatabaseProvider = await getOrCreateProvider(connection, {}, execution);
  const metadata: DatabaseProvider = await getOrCreateMetadataProvider(connection, {}, execution);
  if (metadata === editor) throw new Error(`${label}: the metadata session is the editor's provider`);
  const tag = `held_${randomBytes(4).toString("hex")}`;
  const holders = Array.from({ length: size }, (_, index) =>
    editor.query(`SELECT pg_sleep(${HOLD_SECONDS}) AS ${tag}_${index}`),
  );
  await taggedHoldersArrived(tag, size);
  const tree = await timed(() => metadata.listObjects(["public"], "table"));
  const waiting = await timed(() => editor.listObjects(["public"], "table"));
  await Promise.all(holders);

  console.log(
    `${label}: ${size} of ${size} editor connections held by pg_sleep(${HOLD_SECONDS}): metadata session listed ${tree.listed} in ${tree.ms} ms; editor pool listed ${waiting.listed} in ${waiting.ms} ms`,
  );
  if (tree.listed !== TABLES || waiting.listed !== TABLES) throw new Error(`${label}: a listing missed a table`);
  if (tree.ms > METADATA_BOUND_MS) {
    throw new Error(`${label}: the metadata listing took ${tree.ms} ms, over ${METADATA_BOUND_MS} ms`);
  }
  // Vacuity: the editor's listing waited for a holder, so the editor's pool really was held.
  if (waiting.ms < METADATA_BOUND_MS) throw new Error(`${label}: the editor's listing did not wait (${waiting.ms} ms)`);
}

/** The pid of the backend running the statement tagged `tag`, read through psql. */
function backendOf(tag: string): number {
  const pid = Number(
    psql(
      `SELECT pid FROM pg_stat_activity WHERE state = 'active' AND query LIKE 'SELECT pg_sleep(%) AS ${tag}' LIMIT 1`,
    ),
  );
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`no backend runs the statement tagged ${tag}`);
  return pid;
}

/** Whether a backend of `pid` is still connected, read through psql. */
function backendPresent(pid: number): boolean {
  return psql(`SELECT count(*) FROM pg_stat_activity WHERE pid = ${pid}`) === "1";
}

/**
 * A kill of one held editor statement on the metadata session, composed as POST /api/db/maintenance composes it, while
 * `size` editor statements hold every connection of the editor's pool in `catalog`.
 */
async function heldEditorKill(
  label: string,
  connection: DatabaseConnection,
  catalog: string | undefined,
  size: number,
) {
  const session = { role: "admin" };
  const editor = await editorProvider(session, connection, catalog);
  const metadata = await metadataProvider(session, connection, catalog);
  if (metadata === editor) throw new Error(`${label}: the metadata session is the editor's provider`);

  const tag = `held_${randomBytes(4).toString("hex")}`;
  const holders = Array.from({ length: size }, (_, index) =>
    editor.query(`SELECT pg_sleep(${HOLD_SECONDS}) AS ${tag}_${index}`).then(
      () => "ended",
      (error: Error) => `failed: ${error.message}`,
    ),
  );
  await taggedHoldersArrived(tag, size);
  const target = backendOf(`${tag}_0`);
  // The metadata session's own backend, the one idle client its pool then holds, which the kill takes.
  const own = Number((await metadata.query("SELECT pg_backend_pid() AS pid")).rows[0]?.pid);
  // Vacuity: every connection of the editor's pool is held at the kill.
  if (!(editor instanceof PostgresProvider)) throw new Error(`${label}: the editor's provider is not a PostgreSQL one`);
  const held = editor.getPoolStats();
  if (held.total !== held.max || held.idle !== 0) {
    throw new Error(`${label}: the editor's pool is not held at the kill: ${JSON.stringify(held)}`);
  }

  const execution = editorExecutionContext(session, connection);
  const { capabilities: declared } = await readProviderDeclarations(connection, execution);
  const started = performance.now();
  const outcome = await providerMaintenance(metadata, declared, new AbortController().signal, "live").run(
    "kill",
    String(target),
  );
  const ms = Math.round(performance.now() - started);
  const ends = await Promise.all(holders);

  console.log(
    `${label}: editor pool held ${JSON.stringify(held)}; kill of ${target}: ${outcome.kind} in ${ms} ms; target present after: ${backendPresent(target)}; metadata backend ${own} present after: ${backendPresent(own)}`,
  );
  if (outcome.kind !== "answered" || outcome.result.success !== true) {
    throw new Error(
      `${label}: the kill did not answer success: ${outcome.kind === "answered" ? JSON.stringify(outcome.result) : String(outcome.error)}`,
    );
  }
  if (ms > KILL_BOUND_MS) throw new Error(`${label}: the kill took ${ms} ms, over ${KILL_BOUND_MS} ms`);
  if (backendPresent(target)) throw new Error(`${label}: the kill's target ${target} is still connected`);
  if (!backendPresent(own)) throw new Error(`${label}: the metadata session's own backend ${own} is gone`);
  const failed = ends.filter((end) => end !== "ended");
  if (failed.length !== 1 || !failed[0]?.includes(TERMINATED)) {
    throw new Error(`${label}: not exactly one holder ended by the kill: ${JSON.stringify(ends)}`);
  }
}

async function main(): Promise<void> {
  try {
    const port = await startPostgres();
    console.log(`PostgreSQL container ${PG_CONTAINER} started on 127.0.0.1:${port}`);
    const connection: DatabaseConnection = {
      id: "live-pg-metadata-session",
      type: "postgres",
      name: "Live PG metadata session",
      host: "127.0.0.1",
      port,
      user: "postgres",
      password: secret,
      database: "postgres",
      createdAt: new Date(),
    };
    const shared = editorExecutionContext({ role: "admin" }, connection);
    await heldEditorCase("shared", connection, shared, SHARED_POOL);
    // Governance is not configured in this script, so the owner is stated as `editorExecutionContext` states it for a
    // governed session: the subject and the default per-user pool size.
    await heldEditorCase(
      "owned",
      { ...connection, id: "live-pg-metadata-session-owned" },
      { ...shared, owner: "live-owner", ownerPoolMax: OWNED_POOL },
      OWNED_POOL,
    );
    // The kill runs through the host core, as the maintenance route runs it.
    installHostCore(createHostCore(), "test");
    await heldEditorKill("kill, pinned", connection, undefined, SHARED_POOL);
    await heldEditorKill(
      "kill, catalog",
      { ...connection, id: "live-pg-metadata-session-server", database: "" },
      "postgres",
      CATALOG_POOL,
    );
    console.log("PASS live PostgreSQL metadata-session check");
  } catch (error) {
    console.error("FAIL live PostgreSQL metadata-session check");
    console.error(error);
    // exitCode, not process.exit(1): exit would skip the finally below and leave the container running.
    process.exitCode = 1;
  } finally {
    await clearProviderCache();
    try {
      docker(["rm", "-f", PG_CONTAINER]);
    } catch {
      // Container may not exist or may already have been removed.
    }
  }
}

await main();
