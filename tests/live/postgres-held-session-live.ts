/**
 * Live PostgreSQL check: a session that ends while the provider holds its client is reported as a named error.
 *
 * `pg` emits `error` on a client whose connection ends, and `pg-pool` takes its own listener off a client while the
 * client is checked out. So the provider's clients carry a listener of their own for their whole life
 * (`NoticeKeepingClient` in src/lib/db/providers/sql/postgres.ts). This script drives the real provider against a real
 * PostgreSQL whose server ends the session under it: a terminated backend, during a statement or between statements,
 * and `idle_in_transaction_session_timeout`. For each case it checks the answer the caller gets, that the rows of a
 * COMMIT the server ran stay committed, and that every failure reached the caller as an error rather than escaping
 * the call.
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
import { DatabaseError, NO_ACTIVE_TRANSACTION, QueryError, TransactionLostError } from "@/lib/db/errors";
import { errorOutcome } from "@/lib/db/error-record";
import { PostgresProvider } from "@/lib/db/providers/sql/postgres";
import type { DatabaseConnection } from "@/lib/types";

const PG_CONTAINER = `${process.env.LIBREDB_LIVE_PG_CONTAINER_PREFIX ?? "libredb-live-held-session-pg"}-${randomBytes(4).toString("hex")}`;
const PG_ADMIN_PASSWORD = "held-session-password";
const AGENT_USER = "agent_readonly";
const AGENT_PASSWORD = "held-session-agent-password";
const LOST =
  /^The transaction was lost: its database session ended \(.+\)\. The server rolls back what was still open in the session when it ended, but a COMMIT that had already reached the server stays committed, so check the data before running the work again\. Begin a new transaction to continue\.$/;
const NOT_ACTIVE = new RegExp(`^${NO_ACTIVE_TRANSACTION}$`);

/** Every error that escaped a call instead of reaching its caller, in order. */
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
    "--memory",
    "1g",
    "-e",
    `POSTGRES_PASSWORD=${PG_ADMIN_PASSWORD}`,
    "-p",
    "127.0.0.1::5432",
    "postgres:17",
  ]);
  const port = publishedPort(PG_CONTAINER);
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
  if (!(outcome.error instanceof TransactionLostError)) {
    throw new Error(`${label}: expected a TransactionLostError, got ${outcome.error?.constructor.name}`);
  }
  // Found before anything was sent, so the answer says the call never reached the server.
  if (errorOutcome(outcome.error) !== "not-sent") {
    throw new Error(`${label}: expected outcome not-sent, got ${errorOutcome(outcome.error)}`);
  }
}

/** A failure the server or the driver answered after the call was sent: a Studio class, never a lost transaction. */
function expectSentFailure(
  label: string,
  outcome: { error?: Error },
  expected: abstract new (...args: never[]) => DatabaseError,
): void {
  if (outcome.error === undefined) throw new Error(`${label}: expected an error, but it succeeded`);
  if (!(outcome.error instanceof expected) || outcome.error instanceof TransactionLostError) {
    throw new Error(`${label}: expected a ${expected.name}, got ${outcome.error.constructor.name}`, {
      cause: outcome.error,
    });
  }
  if (errorOutcome(outcome.error) !== "unknown") {
    throw new Error(`${label}: expected outcome unknown, got ${errorOutcome(outcome.error)}`);
  }
}

async function expectOne(label: string, provider: PostgresProvider): Promise<void> {
  const answer = await provider.query("SELECT 1 AS one");
  if (Number((answer.rows[0] as { one: number }).one) !== 1) throw new Error(`${label}: SELECT 1 did not answer 1`);
}

async function expectRows(label: string, provider: PostgresProvider, expected: number): Promise<void> {
  const answer = await provider.query("SELECT count(*)::int AS n FROM held_session_rows");
  const n = Number((answer.rows[0] as { n: number }).n);
  if (n !== expected) throw new Error(`${label}: another session counts ${n} rows, expected ${expected}`);
}

/** Runs one case, then fails it if any error escaped a call meanwhile. */
async function check(label: string, body: () => Promise<void>): Promise<void> {
  processEvents.length = 0;
  const outcome = await settled(body);
  // The socket's end arrives after the statement's own answer, so the case waits for it before it reads the record.
  await sleep(300);
  const seen = processEvents.length > 0 ? ` (escaped errors: ${processEvents.join(" | ")})` : "";
  if (outcome.error !== undefined)
    throw new Error(`${label}: ${outcome.error.message}${seen}`, { cause: outcome.error });
  if (seen !== "") throw new Error(`${label}:${seen}`);
  console.log(`ok   ${label}`);
}

async function heldTransactionCases(connection: DatabaseConnection): Promise<void> {
  const provider = new PostgresProvider(connection);
  await provider.connect();
  try {
    await check("a transaction whose session ends during its statement is reported lost", async () => {
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

    await check("a transaction whose session is terminated between statements is reported lost at COMMIT", async () => {
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
      "a transaction whose COMMIT ran before its session ended is reported lost, and its row stays committed",
      async () => {
        await provider.query("CREATE TABLE IF NOT EXISTS held_session_rows (n int)");
        await provider.query("TRUNCATE held_session_rows");
        await provider.beginTransaction();
        await provider.queryInTransaction("INSERT INTO held_session_rows VALUES (1)");
        expectRejected(
          "the text whose COMMIT ran first",
          await settled(() => provider.queryInTransaction("COMMIT; SELECT pg_terminate_backend(pg_backend_pid())")),
          /terminating connection due to administrator command/,
        );
        await sleep(200);
        expectLost("the next statement", await settled(() => provider.queryInTransaction("SELECT 1")));
        await expectRows("the committed row", provider, 1);
      },
    );

    await check(
      "a transaction whose text committed and began again is reported lost when its session ends, and its row stays",
      async () => {
        await provider.query("TRUNCATE held_session_rows");
        await provider.beginTransaction();
        await provider.queryInTransaction("INSERT INTO held_session_rows VALUES (1)");
        const pid = Number((await provider.queryInTransaction("SELECT pg_backend_pid() AS pid")).rows[0].pid);
        await provider.queryInTransaction("COMMIT; BEGIN");
        if (!provider.isInTransaction()) throw new Error("the transaction the text began is not reported open");
        await provider.query(`SELECT pg_terminate_backend(${pid})`);
        await sleep(200);
        expectLost("COMMIT", await settled(() => provider.commitTransaction()));
        await expectRows("the committed row", provider, 1);
      },
    );

    await check(
      "a COMMIT the server refuses for a deferred constraint answers a QueryError, and the provider holds no transaction",
      async () => {
        await provider.query(
          "CREATE TABLE IF NOT EXISTS held_session_deferred (n int CONSTRAINT held_session_deferred_n UNIQUE DEFERRABLE INITIALLY DEFERRED)",
        );
        await provider.query("TRUNCATE held_session_deferred");
        await provider.beginTransaction();
        await provider.queryInTransaction("INSERT INTO held_session_deferred VALUES (1)");
        await provider.queryInTransaction("INSERT INTO held_session_deferred VALUES (1)");
        const commit = await settled(() => provider.commitTransaction());
        expectSentFailure("COMMIT", commit, QueryError);
        if (!commit.error?.message.includes("held_session_deferred_n")) {
          throw new Error(`COMMIT: the error does not name the constraint: ${commit.error?.message}`);
        }
        if (provider.isInTransaction()) throw new Error("the provider still reports the transaction open");
        await expectOne("the next pooled statement", provider);
      },
    );

    await check(
      "a COMMIT queued behind a statement that ends the session answers a DatabaseError, not the driver's error, and the provider holds no transaction",
      async () => {
        await provider.beginTransaction();
        // Both at once, so the COMMIT is sent on the held client before the statement ahead of it ends the session.
        const statement = settled(() => provider.queryInTransaction("SELECT pg_terminate_backend(pg_backend_pid())"));
        const commit = settled(() => provider.commitTransaction());
        expectRejected("the statement", await statement, /terminating connection due to administrator command/);
        expectSentFailure("COMMIT", await commit, DatabaseError);
        if (provider.isInTransaction()) throw new Error("the provider still reports the transaction open");
        await sleep(200);
        await expectOne("the next pooled statement", provider);
      },
    );

    await check("a statement whose session ends, followed at once by another, fails both explicitly", async () => {
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
    });
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
    await check("an agent read-only statement whose session ends fails with the session's error", async () => {
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
