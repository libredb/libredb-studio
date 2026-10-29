/**
 * Live check of the InfluxDB 3 agent read-only execution profile, against the `influxdb3` and `influxdb3-filelimit`
 * services of `database-compose.yml`.
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The profile's boundary is the engine's: InfluxDB 3.12 Core's
 * planner refuses every write on `/api/v3/query_sql`, whatever the token, and Core mints only admin tokens. The
 * provider suite replays the answers tests/live/influxdb3-write-refusals.ts captured; whether a server still refuses
 * them, and whether the production path holds its budgets against real answers, is the server's to say. So this script
 * asks one, through the production path (`createDatabaseProvider` with the agent profile's execution context, then
 * `connect` and `queryReadOnly`), and through the route-table client alone where the provider's own policy would stop a
 * statement first:
 *
 *  - the open: the agent profile admits the 3.12.0 Core server, and the operations profile opens it too;
 *  - the boundary, with Studio's read policy bypassed: each write, DDL, COPY, SET and transaction statement is refused
 *    by `queryReadOnly` before sending, and sent raw through the client with the same token it is refused by the
 *    planner (400 or 405, never 200); the positive control is the token itself writing a point through the write
 *    route the provider's table does not hold, into a scratch database the script then deletes; the databases, tables,
 *    columns, row counts and tokens read back the same before and after;
 *  - the `system` schema: `system.queries` is refused with nothing sent, `system.influxdb_schema` is read;
 *  - the budgets: a result past the row budget, past the cell budget and past the byte budget, and a statement past its
 *    deadline, are each refused, never truncated; a read within them answers its rows;
 *  - the file-limit server: a read over more files than the limit is refused in the server's words, never as rows.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it with both services up and seeded
 * (`docker/influxdb/seed.sh`, `docker/influxdb/seed.sh filelimit`):
 *
 *   bun tests/live/influxdb3-agent-boundary.ts
 *
 * The scratch database is named `libredb_lb_<random>` and deleted before exit. Each check prints one line, and the
 * first that fails ends the run non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createDatabaseProvider, executionContextFor } from "@/lib/db/factory";
import { createInfluxClient } from "@/lib/db/providers/timeseries/influxdb/client";
import { buildInfluxConnectionOptions } from "@/lib/db/providers/timeseries/influxdb/connection-options";
import { SQL_ROUTES } from "@/lib/db/providers/timeseries/influxdb/routes";
import type { DatabaseProvider, ReadOnlyStatementBudget } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";
import { readFixtureCredentials } from "./influxdb-evidence-checks";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TOKEN = readFixtureCredentials(
  readFileSync(path.join(ROOT, "database-compose.yml"), "utf8"),
  readFileSync(path.join(ROOT, "docker/influxdb/seed.sh"), "utf8"),
).v3AdminToken;
const BUDGET: ReadOnlyStatementBudget = { statementTimeoutMs: 10_000, maxResultRows: 1_000, maxResultBytes: 1_000_000 };
const SCRATCH = `libredb_lb_${randomBytes(4).toString("hex")}`;

const WRITES: readonly string[] = [
  "INSERT INTO home (room, temp, time) VALUES ('Probe', 1.0, now())",
  "INSERT INTO home SELECT * FROM home",
  "CREATE TABLE libredb_lb_t AS SELECT 1 AS a",
  "CREATE EXTERNAL TABLE libredb_lb_x STORED AS CSV LOCATION '/tmp/libredb-lb.csv'",
  "CREATE VIEW libredb_lb_v AS SELECT 1",
  "CREATE SCHEMA libredb_lb_s",
  "CREATE DATABASE libredb_lb_db",
  "SELECT 1 INTO libredb_lb_into",
  "DROP TABLE home",
  "DROP SCHEMA iox",
  "DROP DATABASE home",
  "DELETE FROM home WHERE room = 'Kitchen'",
  "UPDATE home SET temp = 0",
  "TRUNCATE TABLE home",
  "MERGE INTO home USING home AS s ON true WHEN MATCHED THEN DELETE",
  "COPY home TO '/tmp/libredb-lb-copy.csv'",
  "COPY (SELECT 1) TO '/tmp/libredb-lb-copy.parquet' STORED AS PARQUET",
  "ALTER TABLE home ADD COLUMN libredb_lb INT",
  "SET datafusion.execution.batch_size = 1",
  "PREPARE libredb_lb_p AS SELECT 1",
  "BEGIN",
  "EXPLAIN ANALYZE INSERT INTO home (room, temp, time) VALUES ('Probe', 1.0, now())",
  "WITH x AS (SELECT 1) INSERT INTO home SELECT * FROM home",
  "SELECT 1; DROP TABLE home",
];

let checks = 0;
function check(ok: boolean, line: string): void {
  checks++;
  console.log(`${ok ? "ok  " : "FAIL"} ${checks} ${line}`);
  if (!ok) {
    console.error(`check ${checks} failed`);
    process.exitCode = 1;
    throw new Error(line);
  }
}

function connection(port: number, database = "home"): DatabaseConnection {
  return {
    id: `influxdb3-live-${port}-${database}`,
    name: "InfluxDB 3 live",
    type: "influxdb3",
    host: "127.0.0.1",
    port,
    password: TOKEN,
    database,
    createdAt: new Date(0),
  } as DatabaseConnection;
}

async function open(profile: "agent-read-only" | "agent-operations", port = 8181, database = "home") {
  const provider = await createDatabaseProvider(connection(port, database), {}, executionContextFor(profile));
  await provider.connect();
  return provider;
}

const options = buildInfluxConnectionOptions(connection(8181), { type: "influxdb3", queryTimeout: 30_000 });
const client = createInfluxClient(options, SQL_ROUTES);

/** A statement sent raw through the route-table client, past every check of Studio's. */
async function raw(q: string, db = "home") {
  return client.send({ route: "query", values: { db, q } }, AbortSignal.timeout(30_000));
}

async function rawRows(q: string, db = "home"): Promise<string> {
  const answer = await raw(q, db);
  if (answer.status !== 200) throw new Error(`state read ${q}: ${answer.status} ${answer.text}`);
  return answer.text;
}

/** Everything a write could change, as one text; the scratch database is left out. */
async function serverState(): Promise<string> {
  const listing = await client.send({ route: "databases", values: {} }, AbortSignal.timeout(30_000));
  const names = (JSON.parse(listing.text) as { "iox::database": string }[])
    .map((row) => row["iox::database"])
    .filter((name) => name !== SCRATCH);
  const parts = [`databases ${names.join(",")}`];
  for (const name of names.filter((db) => db !== "_internal")) {
    parts.push(
      await rawRows(
        "SELECT table_schema, table_name, column_name FROM information_schema.columns ORDER BY 1, 2, 3",
        name,
      ),
    );
  }
  parts.push(await rawRows("SELECT count(*) AS n FROM home"));
  parts.push(await rawRows("SELECT name, permissions FROM system.tokens ORDER BY name", "_internal"));
  return parts.join("\n");
}

async function refusalOf(run: () => Promise<unknown>): Promise<Error | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error as Error;
  }
}

/** The write route the provider's table does not hold, used only for the positive control. */
async function writeLp(db: string, line: string): Promise<number> {
  const response = await fetch(`http://127.0.0.1:8181/api/v3/write_lp?db=${db}&precision=second`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "text/plain; charset=utf-8" },
    body: line,
  });
  return response.status;
}

async function dropScratch(): Promise<void> {
  await fetch(`http://127.0.0.1:8181/api/v3/configure/database?db=${SCRATCH}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${TOKEN}` },
  });
}

async function main(): Promise<void> {
  const agent = await open("agent-read-only");
  check(agent.isConnected(), "open: the agent profile admits the 3.12.0 Core server");
  const operations = await open("agent-operations");
  check(operations.isConnected(), "open: the operations profile opens the same server");
  await operations.disconnect();

  const before = await serverState();
  for (const sql of WRITES) {
    const viaProvider = await refusalOf(() => (agent as DatabaseProvider).queryReadOnly!(sql, BUDGET));
    check(viaProvider !== null, `boundary: queryReadOnly refuses ${sql} (${viaProvider?.message.slice(0, 70)})`);
    const answer = await raw(sql);
    check(
      answer.status === 400 || answer.status === 405,
      `boundary: the planner refuses ${sql} sent raw -> ${answer.status} ${answer.text.slice(0, 60)}`,
    );
  }
  check((await serverState()) === before, "boundary: databases, tables, columns, rows and tokens read back the same");

  // The positive control: the same token writes through the write route, which the provider's table does not hold.
  try {
    const written = await writeLp(SCRATCH, `probe,tag=a v=1i ${Math.floor(Date.now() / 1000)}`);
    check(written === 204, `control: the same token writes a point through /api/v3/write_lp -> ${written}`);
    const scratch = await open("agent-read-only", 8181, SCRATCH);
    const read = await scratch.queryReadOnly!("SELECT tag, v FROM probe", BUDGET);
    check(read.rowCount === 1, `control: the agent reads the written point back -> ${JSON.stringify(read.rows)}`);
    await scratch.disconnect();
  } finally {
    await dropScratch();
  }

  const system = await refusalOf(() => agent.queryReadOnly!("SELECT * FROM system.queries", BUDGET));
  check(system?.message.includes("system.influxdb_schema") === true, `system: system.queries -> ${system?.message}`);
  const schema = await agent.queryReadOnly!("SELECT * FROM system.influxdb_schema", BUDGET);
  check(schema.rowCount > 0, `system: system.influxdb_schema answers ${schema.rowCount} rows`);

  const rows = await refusalOf(() => agent.queryReadOnly!("SELECT * FROM home", { ...BUDGET, maxResultRows: 3 }));
  check(
    rows?.message.startsWith("Read-only execution exceeded the row budget") === true,
    `budget: rows -> ${rows?.message}`,
  );
  const wide =
    "SELECT value AS a, value AS b, value AS c, value AS d, value AS e, value AS f FROM generate_series(1, 50000)";
  const cells = await refusalOf(() =>
    agent.queryReadOnly!(wide, { ...BUDGET, maxResultRows: 60_000, maxResultBytes: 50_000_000 }),
  );
  check(
    cells?.message === "Read-only execution exceeded the row budget: 50000 rows > 41666 allowed",
    `budget: cells -> ${cells?.message}`,
  );
  const bytes = await refusalOf(() => agent.queryReadOnly!("SELECT * FROM home", { ...BUDGET, maxResultBytes: 100 }));
  check(
    bytes?.message.startsWith("Read-only execution exceeded the byte budget") === true,
    `budget: bytes -> ${bytes?.message}`,
  );
  const slow = await refusalOf(() =>
    agent.queryReadOnly!("SELECT count(*) FROM generate_series(1, 2000000000)", { ...BUDGET, statementTimeoutMs: 300 }),
  );
  check(
    slow?.message === "Read-only execution exceeded the time budget: no answer within 300ms",
    `budget: deadline -> ${slow?.message}`,
  );
  const read = await agent.queryReadOnly!("SELECT count(*) AS n FROM home", BUDGET);
  check(read.rowCount === 1, `read: the agent reads home -> ${JSON.stringify(read.rows)}`);
  const plan = await agent.queryReadOnly!("EXPLAIN SELECT count(*) FROM home", BUDGET);
  check(plan.fields.includes("plan_type"), `read: EXPLAIN answers the plan -> ${plan.rowCount} rows`);
  const catalog = await agent.queryReadOnly!(
    "SELECT table_schema, table_name, column_name, data_type, is_nullable, ordinal_position + 1 AS ordinal_position FROM information_schema.columns WHERE table_schema = 'iox' AND table_name = 'home' ORDER BY table_schema, table_name, ordinal_position",
    BUDGET,
  );
  check(catalog.rowCount === 5, `read: the catalog read answers home's columns -> ${catalog.rowCount}`);
  await agent.disconnect();

  const limited = await open("agent-read-only", 8182);
  const filelimit = await refusalOf(() => limited.queryReadOnly!('SELECT count(*) FROM "home"', BUDGET));
  check(
    filelimit?.message.toLowerCase().includes("file limit") === true,
    `filelimit: a read over the file limit is refused -> ${filelimit?.message.slice(0, 90)}`,
  );
  await limited.disconnect();
  client.close();
  console.log(`${checks} checks passed`);
}

try {
  await main();
} finally {
  client.close();
}
