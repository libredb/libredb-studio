/**
 * Live PostgreSQL check: a session that ends while the provider holds its client is reported as a named error.
 *
 * `pg` emits `error` on a client whose connection ends, and `pg-pool` takes its own listener off a client while the
 * client is checked out. So the provider's clients carry a listener of their own for their whole life
 * (`NoticeKeepingClient` in src/lib/db/providers/sql/postgres.ts). This script drives the real provider against a real
 * PostgreSQL and ends the session under it in the ways a server does: `pg_terminate_backend` from the session itself
 * and from a second session, and `idle_in_transaction_session_timeout`. For each case it checks the answer the caller
 * gets, and that the process saw no `uncaughtException` and no `unhandledRejection`.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in `tests/runner/discover.ts`).
 * CI runs it in the "Functional Smoke (PostgreSQL, MongoDB, RabbitMQ)" job of .github/workflows/ci.yml, under Bun and
 * then under Node through `bun build --target=node`, because an error thrown from a socket handler surfaces
 * differently in the two runtimes. It needs Docker and nothing else:
 *
 *   bun tests/live/postgres-held-session-live.ts
 *
 * The container publishes on a loopback port Docker picks and its name carries a per-run suffix, as in
 * tests/live/postgres-read-only-live.ts. `LIBREDB_LIVE_PG_CONTAINER_PREFIX` replaces the name's prefix for a local run.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { ConnectionError, NO_ACTIVE_TRANSACTION } from "@/lib/db/errors";
import { PostgresProvider } from "@/lib/db/providers/sql/postgres";
import type { DatabaseConnection } from "@/lib/types";

const PG_CONTAINER = `${process.env.LIBREDB_LIVE_PG_CONTAINER_PREFIX ?? "libredb-live-held-session-pg"}-${randomBytes(4).toString("hex")}`;
const PG_ADMIN_PASSWORD = "held-session-password";
const AGENT_USER = "agent_readonly";
const AGENT_PASSWORD = "held-session-agent-password";
const LOST = /^The transaction was lost: its database session ended \(.+\)\./;
const NOT_ACTIVE = new RegExp(`^${NO_ACTIVE_TRANSACTION}$`);

/** Every `uncaughtException` and `unhandledRejection` the process saw, in order. */
const processEvents: string[] = [];
process.on("uncaughtException", (error) => processEvents.push(`uncaughtException: ${error.message}`));
process.on("unhandledRejection", (reason) =>
  processEvents.push(`unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`),
);

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

async function startPostgres(): Promise<number> {
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    PG_CONTAINER,
    "-e",
    `POSTGRES_PASSWORD=${PG_ADMIN_PASSWORD}`,
    "-p",
    "127.0.0.1::5432",
    "postgres:17",
  ]);
  const port = publishedPort(PG_CONTAINER);
  // The agent role may end its own backend: pg_terminate_backend admits a session of the caller's own role.
  const seedSql =
    `CREATE ROLE ${AGENT_USER} WITH LOGIN PASSWORD '${AGENT_PASSWORD}';` +
    ` GRANT CONNECT ON DATABASE postgres TO ${AGENT_USER};`;
  let lastError: unknown;
  for (let i = 0; i < 60; i++) {
    try {
      // Over TCP, where only the real server listens (see tests/live/postgres-read-only-live.ts).
      docker(["exec", PG_CONTAINER, "pg_isready", "-q", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres"]);
      docker(["exec", PG_CONTAINER, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres", "-c", seedSql]);
      return port;
    } catch (err) {
      lastError = err;
      // oxlint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
  }
  throw new Error(`live postgres container did not accept the seed: ${lastError}`);
}

/** What `run` settled with: the value, or the error it rejected with. */
async function settled<T>(run: () => Promise<T>): Promise<{ value?: T; error?: Error }> {
  try {
    return { value: await run() };
  } catch (error) {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function expectRejected(label: string, outcome: { error?: Error }, pattern: RegExp): void {
  if (outcome.error === undefined) throw new Error(`${label}: expected an error, but it succeeded`);
  if (!pattern.test(outcome.error.message)) {
    throw new Error(`${label}: unexpected error: ${outcome.error.message}`, { cause: outcome.error });
  }
}

function expectLost(label: string, outcome: { error?: Error }): void {
  expectRejected(label, outcome, LOST);
  if (!(outcome.error instanceof ConnectionError)) {
    throw new Error(`${label}: expected a ConnectionError, got ${outcome.error?.constructor.name}`);
  }
}

async function expectOne(label: string, provider: PostgresProvider): Promise<void> {
  const answer = await provider.query("SELECT 1 AS one");
  if (Number((answer.rows[0] as { one: number }).one) !== 1) throw new Error(`${label}: SELECT 1 did not answer 1`);
}

/** Runs one case, then fails it if the process saw any uncaught exception or unhandled rejection meanwhile. */
async function check(label: string, body: () => Promise<void>): Promise<void> {
  processEvents.length = 0;
  const outcome = await settled(body);
  // The socket's end arrives after the statement's own answer, so the case waits for it before it reads the record.
  await sleep(300);
  const seen = processEvents.length > 0 ? ` (process events: ${processEvents.join(" | ")})` : "";
  if (outcome.error !== undefined)
    throw new Error(`${label}: ${outcome.error.message}${seen}`, { cause: outcome.error });
  if (seen !== "") throw new Error(`${label}:${seen}`);
  console.log(`ok   ${label}`);
}

async function heldTransactionCases(connection: DatabaseConnection): Promise<void> {
  const provider = new PostgresProvider(connection);
  await provider.connect();
  try {
    await check("a transaction whose statement ends its own session is reported lost", async () => {
      await provider.beginTransaction();
      expectRejected(
        "the statement in flight",
        await settled(() => provider.queryInTransaction("SELECT pg_terminate_backend(pg_backend_pid())")),
        /terminating connection due to administrator command/,
      );
      await sleep(200);
      expectLost("the next statement", await settled(() => provider.queryInTransaction("SELECT 1")));
      if (provider.isInTransaction()) throw new Error("the lost transaction is still reported open");
      expectRejected("COMMIT afterwards", await settled(() => provider.commitTransaction()), NOT_ACTIVE);
      await expectOne("the next pooled statement", provider);
    });

    await check("a transaction whose session another session terminates is reported lost at COMMIT", async () => {
      await provider.beginTransaction();
      const pid = Number((await provider.queryInTransaction("SELECT pg_backend_pid() AS pid")).rows[0].pid);
      await provider.query(`SELECT pg_terminate_backend(${pid})`);
      await sleep(200);
      expectLost("COMMIT", await settled(() => provider.commitTransaction()));
      if (provider.isInTransaction()) throw new Error("the lost transaction is still reported open");
      await expectOne("the next pooled statement", provider);
    });

    await check("a transaction left idle past its timeout is reported lost at ROLLBACK", async () => {
      await provider.beginTransaction();
      await provider.queryInTransaction("SET idle_in_transaction_session_timeout = '300ms'");
      await sleep(1200);
      expectLost("ROLLBACK", await settled(() => provider.rollbackTransaction()));
      if (provider.isInTransaction()) throw new Error("the lost transaction is still reported open");
      expectRejected("ROLLBACK again", await settled(() => provider.rollbackTransaction()), NOT_ACTIVE);
      await expectOne("the next pooled statement", provider);
    });

    await check(
      "a statement that ends its own session, followed at once by another, fails both explicitly",
      async () => {
        const first = settled(() => provider.query("SELECT pg_terminate_backend(pg_backend_pid())"));
        expectRejected("the first statement", await first, /terminating connection due to administrator command/);
        // At once, so the pool hands out the same client before its socket has closed.
        expectRejected(
          "the statement right after it",
          await settled(() => provider.query("SELECT 1")),
          /Connection terminated unexpectedly|not queryable/,
        );
        await sleep(200);
        await expectOne("a later statement", provider);
      },
    );
  } finally {
    // `disconnect()` waits for every borrowed client, so a case that failed with its transaction still held would
    // keep the script from ending. The rollback hands that client back; its own outcome is not what is checked here.
    if (provider.isInTransaction()) await settled(() => provider.rollbackTransaction());
    await provider.disconnect();
  }
}

async function agentReadOnlyCase(connection: DatabaseConnection): Promise<void> {
  // Opened the way the factory opens the profile (`acquireExecutionProfileProvider`): as the agent role, with the
  // server-injected read-only execution context. The factory itself is not imported, so the Node bundle carries
  // only this provider.
  const provider = new PostgresProvider(
    { ...connection, user: AGENT_USER, password: AGENT_PASSWORD },
    {},
    { readOnly: true },
  );
  await provider.connect();
  const budget = { statementTimeoutMs: 5000, maxResultRows: 100, maxResultBytes: 100_000 };
  try {
    await check("an agent read-only statement that ends its own session fails with the session's error", async () => {
      const queryReadOnly = provider.queryReadOnly.bind(provider);
      expectRejected(
        "the statement",
        await settled(() => queryReadOnly("SELECT pg_terminate_backend(pg_backend_pid())", budget)),
        /terminating connection due to administrator command/,
      );
      const after = await queryReadOnly("SELECT 1 AS one", budget);
      if (Number((after.rows[0] as { one: number }).one) !== 1) throw new Error("the next read did not answer 1");
    });
  } finally {
    await provider.disconnect();
  }
}

async function main(): Promise<void> {
  try {
    const port = await startPostgres();
    console.log(`PostgreSQL container ${PG_CONTAINER} started on 127.0.0.1:${port}`);
    const connection: DatabaseConnection = {
      id: "live-pg-held-session",
      type: "postgres",
      name: "Live PG held session",
      host: "127.0.0.1",
      port,
      user: "postgres",
      password: PG_ADMIN_PASSWORD,
      database: "postgres",
      createdAt: new Date(),
    };
    await heldTransactionCases(connection);
    await agentReadOnlyCase(connection);
  } catch (error) {
    console.error("FAIL live PostgreSQL held-session check");
    console.error(error);
    // exitCode, not process.exit(1): exit would skip the finally below and leave the container running.
    process.exitCode = 1;
  } finally {
    try {
      docker(["rm", "-f", PG_CONTAINER]);
    } catch {
      // Container may not exist or may already have been removed.
    }
  }
}

await main();
