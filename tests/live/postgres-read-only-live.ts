/**
 * Live PostgreSQL regression check for the agent read-only execution profile (#547).
 *
 * Verifies against a real PostgreSQL 16 engine container that:
 * 1. A direct write statement (INSERT) is rejected by PostgreSQL's read-only transaction bounds.
 * 2. A multi-command statement string (separated by ';') is rejected before/by the server.
 * 3. The underlying database data remains untouched.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name (`EXCLUDED` in
 * `tests/runner/discover.ts`). CI runs it in the "Functional Smoke (PostgreSQL, MongoDB, RabbitMQ)" job of
 * .github/workflows/ci.yml. It needs Docker and nothing else:
 *
 *   bun tests/live/postgres-read-only-live.ts
 *
 * The container publishes on a loopback port Docker picks, read back with `docker port`, and its name carries a
 * per-run suffix. A fixed host port failed CI on PR #2216 with "failed to bind host port 127.0.0.1:54332/tcp:
 * address already in use": 54332 is inside Linux's ephemeral range (32768-60999), the step before this one opens
 * many loopback client connections to its own PostgreSQL, and a client socket on that local port, open or in
 * TIME_WAIT, blocks Docker's bind. `LIBREDB_LIVE_PG_CONTAINER_PREFIX` replaces the name's prefix for a local run.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { acquireExecutionProfileProvider } from "@/lib/db/factory";

/** Names this run's container apart from any other run's on the same Docker. */
const PG_CONTAINER = `${process.env.LIBREDB_LIVE_PG_CONTAINER_PREFIX ?? "libredb-live-readonly-pg"}-${randomBytes(4).toString("hex")}`;
const PG_ADMIN_PASSWORD = "smoke-pg-password";
const AGENT_USER = "agent_readonly";
const AGENT_PASSWORD = "smoke-agent-password";

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The host port Docker published for the container's 5432, from `docker port`'s `127.0.0.1:49153`. */
function publishedPort(container: string): number {
  const binding = docker(["port", container, "5432/tcp"]).trim().split("\n")[0] ?? "";
  const port = Number(binding.slice(binding.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port <= 0) throw new Error(`Docker published no port for ${container}: "${binding}"`);
  return port;
}

async function startSeededPostgres(): Promise<number> {
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
    "postgres:16-alpine",
  ]);
  const port = publishedPort(PG_CONTAINER);

  const seedSql =
    "CREATE TABLE smoke_items (id int PRIMARY KEY, name text NOT NULL);" +
    " INSERT INTO smoke_items VALUES (1, 'smoke_row_one'), (2, 'smoke_row_two');" +
    ` CREATE ROLE ${AGENT_USER} WITH LOGIN PASSWORD '${AGENT_PASSWORD}';` +
    ` GRANT CONNECT ON DATABASE postgres TO ${AGENT_USER};` +
    ` GRANT USAGE ON SCHEMA public TO ${AGENT_USER};` +
    ` GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${AGENT_USER};`;

  let seeded = false;
  let lastError: unknown;
  for (let i = 0; i < 60 && !seeded; i++) {
    try {
      // Over TCP, not the Unix socket: the image's first start runs a temporary socket-only server,
      // stops it and starts the real one, so a seed over the socket can succeed before the restart
      // and the provider's TCP connect then lands in it ("Connection terminated unexpectedly").
      docker(["exec", PG_CONTAINER, "pg_isready", "-q", "-h", "127.0.0.1", "-p", "5432", "-U", "postgres"]);
      docker(["exec", PG_CONTAINER, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres", "-c", seedSql]);
      seeded = true;
    } catch (err) {
      lastError = err;
      // oxlint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
  }
  if (!seeded) throw new Error(`live postgres container did not accept seed: ${lastError}`);
  return port;
}

async function main(): Promise<void> {
  try {
    if (!dockerAvailable()) {
      throw new Error("Docker daemon is not available");
    }

    const port = await startSeededPostgres();
    console.log(`PostgreSQL container ${PG_CONTAINER} started on 127.0.0.1:${port} and seeded`);

    const provider = await acquireExecutionProfileProvider(
      {
        id: "live-pg-readonly",
        type: "postgres",
        name: "Live PG Read-Only",
        host: "127.0.0.1",
        port,
        user: "postgres",
        password: PG_ADMIN_PASSWORD,
        agentUser: AGENT_USER,
        agentPassword: AGENT_PASSWORD,
        database: "postgres",
        createdAt: new Date(),
      },
      "agent-read-only",
    );

    try {
      const queryReadOnly = provider.queryReadOnly?.bind(provider);

      if (!queryReadOnly) {
        throw new Error("Agent read-only provider has no queryReadOnly");
      }

      const budget = {
        statementTimeoutMs: 5000,
        maxResultRows: 100,
        maxResultBytes: 100_000,
      };

      await expectError(
        "direct INSERT is rejected",
        () => queryReadOnly("INSERT INTO smoke_items (id, name) VALUES (99, 'bad_write')", budget),
        /read-only transaction/i,
      );

      await expectError(
        "multi-command query is rejected",
        () => queryReadOnly("SELECT 1; SELECT 2", budget),
        /cannot insert multiple commands/i,
      );

      const result = await queryReadOnly("SELECT COUNT(*)::int AS count FROM smoke_items", budget);
      const count = Number((result.rows[0] as { count: number | string }).count);

      if (count !== 2) {
        throw new Error(`Expected 2 seeded rows, found ${count}`);
      }

      console.log("ok   seeded rows remain unchanged");
    } finally {
      await provider.disconnect();
    }
  } catch (error) {
    console.error("FAIL live PostgreSQL agent read-only check");
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

async function expectError(label: string, action: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (pattern.test(String(error))) {
      console.log(`ok   ${label}`);
      return;
    }

    throw new Error(`${label}: unexpected error: ${String(error)}`, { cause: error });
  }

  throw new Error(`${label}: expected an error, but the query succeeded`);
}

await main();
