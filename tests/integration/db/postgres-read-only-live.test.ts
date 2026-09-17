/**
 * Live PostgreSQL regression check for the agent read-only execution profile (#547).
 *
 * Verifies against a real PostgreSQL 16 engine container that:
 * 1. A direct write statement (INSERT) is rejected by PostgreSQL's read-only transaction bounds.
 * 2. A multi-command statement string (separated by ';') is rejected before/by the server.
 * 3. The underlying database data remains untouched.
 */
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireExecutionProfileProvider } from "@/lib/db/factory";

const PG_CONTAINER = "libredb-live-readonly-pg";
const PG_PORT = 54329;
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

async function startSeededPostgres(): Promise<void> {
  try {
    docker(["rm", "-f", PG_CONTAINER]);
  } catch {
    // fine if no container exists
  }
  docker([
    "run",
    "-d",
    "--rm",
    "--name",
    PG_CONTAINER,
    "-e",
    `POSTGRES_PASSWORD=${PG_ADMIN_PASSWORD}`,
    "-p",
    `127.0.0.1:${PG_PORT}:5432`,
    "postgres:16-alpine",
  ]);

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
      docker(["exec", PG_CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-c", seedSql]);
      seeded = true;
    } catch (err) {
      lastError = err;
      await sleep(1000);
    }
  }
  if (!seeded) throw new Error(`live postgres container did not accept seed: ${lastError}`);
}

describe("Live PostgreSQL agent read-only execution profile (#547)", () => {
  const hasDocker = dockerAvailable();

  beforeAll(async () => {
    if (!hasDocker) return;
    await startSeededPostgres();
  });

  afterAll(() => {
    try {
      docker(["rm", "-f", PG_CONTAINER]);
    } catch {
      // already cleaned up
    }
  });

  test("rejects direct write statement and multi-command string on real PostgreSQL", async () => {
    if (!hasDocker) {
      console.log("Skipping live postgres test: Docker daemon not available");
      return;
    }

    const provider = await acquireExecutionProfileProvider(
      {
        id: "live-pg-readonly",
        type: "postgres",
        name: "Live PG Read-Only",
        host: "127.0.0.1",
        port: PG_PORT,
        user: "postgres",
        password: PG_ADMIN_PASSWORD,
        agentUser: AGENT_USER,
        agentPassword: AGENT_PASSWORD,
        database: "postgres",
        createdAt: new Date(),
      },
      "agent-read-only",
    );

    const queryReadOnly = provider.queryReadOnly?.bind(provider);
    if (!queryReadOnly) throw new Error("agent read-only provider has no queryReadOnly");

    const budget = {
      statementTimeoutMs: 5000,
      maxResultRows: 100,
      maxResultBytes: 100_000,
    };

    try {
      // 1. Direct write statement must be rejected by PostgreSQL read-only transaction
      await expect(
        queryReadOnly("INSERT INTO smoke_items (id, name) VALUES (99, 'bad_write')", budget),
      ).rejects.toThrow(/read-only transaction/i);

      // 2. Multi-command statement string must be rejected before/by extended query protocol
      await expect(queryReadOnly("SELECT 1; SELECT 2", budget)).rejects.toThrow(/cannot insert multiple commands/i);

      // 3. Database state integrity verification: no rows were inserted
      const result = await queryReadOnly("SELECT COUNT(*)::int AS count FROM smoke_items", budget);
      const count = Number((result.rows[0] as { count: number | string }).count);
      expect(count).toBe(2);
    } finally {
      await provider.disconnect();
    }
  });
});
