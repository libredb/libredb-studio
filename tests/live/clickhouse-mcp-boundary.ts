/**
 * Live check of MCP's `run_read_query` on ClickHouse, against a server of the operator's choosing.
 *
 * WHY THIS EXISTS. `run_read_query` serves ClickHouse through the same boundary agent mode does: the connection is
 * acquired under the agent read-only profile, whose open proves the user (`agent-boundary.ts`), and every statement
 * goes through the provider's `queryReadOnly`, which carries `readonly = 1`. The MCP fence in front of it is defence in
 * depth. So this script replays the agent boundary check through the MCP tool's own handler (`runStatement`) with that
 * fence removed, against a real server:
 *
 *  - the open, through MCP: a least-privilege user is served; the writable admin, a user holding BACKUP, and a user
 *    holding BACKUP only through a role are each refused before any statement runs, in the MCP refusal sentence;
 *  - the boundary, with the MCP fence bypassed: each write, DDL, SYSTEM statement, grant, temporary table, BACKUP,
 *    KILL, trailing `SETTINGS readonly = 0`, second statement and source table function is sent as the
 *    least-privilege user through the MCP handler, and is refused by ClickHouse with a read-only (164) or
 *    authorization (497) code, never a syntax error but for the second statement, which the server refuses as such; a
 *    table function that reaches another server is refused by the provider's own fence before it is sent, and the
 *    agent user is shown refused it by the server too; the same statements run as the writable admin without
 *    `readonly` on a scratch copy, the positive control that shows each would work; a hash of the engine's tables,
 *    rows, users, roles, named collections and functions is the same before and after;
 *  - the limits: a read answers its rows; one past the 1000-row provider budget and one past the 1 MiB budget are
 *    refused, never cut; one past `timeout_ms` is answered as the timeout.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it against a server you may write to, as
 * a user with access management and `named_collection_control` (as for `tests/live/clickhouse-agent-boundary.ts`):
 *
 *   LIBREDB_LIVE_CLICKHOUSE_PORT=8123 LIBREDB_LIVE_CLICKHOUSE_USER=... LIBREDB_LIVE_CLICKHOUSE_PASSWORD=... \
 *     bun tests/live/clickhouse-mcp-boundary.ts
 *
 * Every user, role, collection and database it creates carries the `libredb_lm_` prefix and is dropped on exit. Each
 * check prints one line, no credential among them, and any failure ends the run non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import { createHash, randomBytes } from "node:crypto";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import { agentRequestSettings } from "@/lib/db/providers/sql/clickhouse/agent-read";
import { ClickHouseHttpTransport } from "@/lib/db/providers/sql/clickhouse/http-transport";
import { ClickHouseTransportError } from "@/lib/db/providers/sql/clickhouse/transport";
import type { McpConnectionContext } from "@/lib/mcp/context";
import type { ToolResult } from "@/lib/mcp/output";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm, type McpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";

const PREFIX = "libredb_lm_";
const DB = `${PREFIX}data`;
const CTL = `${PREFIX}control`;

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`set ${name}: this script writes to the server it is pointed at, so it has no default`);
    process.exit(2);
  }
  return value;
}

const HOST = process.env.LIBREDB_LIVE_CLICKHOUSE_HOST ?? "127.0.0.1";
const PORT = Number(env("LIBREDB_LIVE_CLICKHOUSE_PORT"));
const ADMIN = { user: env("LIBREDB_LIVE_CLICKHOUSE_USER"), password: env("LIBREDB_LIVE_CLICKHOUSE_PASSWORD") };
/** One password for every seeded user, made for the run. */
const SEEDED_PASSWORD = randomBytes(12).toString("hex");
/** A name for the run's in-memory backups, which the server keeps until it restarts. */
const RUN = randomBytes(4).toString("hex");

/** The tool as MCP registers it, and the same tool with its statement fence removed: the boundary under test. */
const RUN_READ_QUERY = mcpStatementArm("run_read_query");
const UNFENCED: McpStatementArm = { ...RUN_READ_QUERY, fence: () => null };

function seed(user: string, password: string, database = DB): ManagedConnection {
  return {
    id: `seed:live-${user}`,
    name: user,
    seedId: `live-${user}`,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "clickhouse",
    host: HOST,
    port: PORT,
    user,
    password,
    database,
    createdAt: new Date(),
  } as ManagedConnection;
}

const adminTransport = new ClickHouseHttpTransport(seed(ADMIN.user, ADMIN.password, "default"));

async function admin(sql: string): Promise<void> {
  await adminTransport.query(sql, { timeoutMs: 30_000 });
}

/** The server's code for `sql` sent as `user` with `settings`, or null when it answered. */
async function codeOf(user: string, password: string, sql: string, settings: Record<string, string | number>) {
  try {
    await new ClickHouseHttpTransport(seed(user, password)).query(sql, { settings, timeoutMs: 30_000 });
    return null;
  } catch (error) {
    if (error instanceof ClickHouseTransportError) return error.code;
    throw error;
  }
}

let failures = 0;
function check(ok: boolean, line: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

/** One MCP call on `connection`, through the factory's own profiled acquisition, as the route makes it. */
async function mcp(
  connection: ManagedConnection,
  args: Partial<McpStatementInput> & { readonly sql: string },
  arm: McpStatementArm = UNFENCED,
): Promise<{ readonly result: ToolResult; readonly acquired: ExecutionProfile[] }> {
  const acquired: ExecutionProfile[] = [];
  const context = {
    caller: { username: "live", role: "admin" },
    visibleConnections: async () => [connection],
    resolve: async () => connection,
    acquire: (target: ManagedConnection, profile: ExecutionProfile) => {
      acquired.push(profile);
      return acquireExecutionProfileProvider(target, profile);
    },
  } as unknown as McpConnectionContext;
  const input = arm.inputSchema.parse({ connection_id: connection.id, ...args }) as McpStatementInput;
  const result = await runStatement(arm, input, { context, signal: new AbortController().signal });
  return { result, acquired };
}

const textOf = (result: ToolResult): string =>
  result.content.map((part) => ("text" in part ? part.text : "")).join(" ");

/** The users the open must refuse through MCP, each with the grants that make it so and the words it must carry. */
const REFUSED_USERS: readonly { name: string; grants: string[]; says: string }[] = [
  { name: "backup", grants: [`GRANT BACKUP ON ${DB}.* TO {u}`], says: "holds BACKUP" },
  { name: "rolebackup", grants: [`GRANT ${PREFIX}r_backup TO {u}`, "SET DEFAULT ROLE NONE TO {u}"], says: "BACKUP" },
];

/**
 * `{db}` is the database a statement targets: the agent's, or the control copy. A statement the positive control
 * cannot run to the end, because it reads a source the test server does not have, is marked `source`: its control is
 * that the writable admin gets past every read-only and authorization check and fails on the source itself.
 */
const BOUNDARY_STATEMENTS: readonly (string | { source: string })[] = [
  "INSERT INTO {db}.t VALUES (99, 99)",
  "ALTER TABLE {db}.t UPDATE x = 0 WHERE 1",
  "ALTER TABLE {db}.t DELETE WHERE k = 1",
  "DELETE FROM {db}.t WHERE k = 2",
  "OPTIMIZE TABLE {db}.t FINAL",
  "TRUNCATE TABLE {db}.t",
  "CREATE TABLE {db}.t2 (x Int8) ENGINE = Memory",
  "CREATE TABLE {db}.t3 ENGINE = Memory AS SELECT * FROM {db}.t",
  "RENAME TABLE {db}.r TO {db}.r2",
  "DROP TABLE {db}.d",
  "CREATE TEMPORARY TABLE tmp (x Int8) ENGINE = Memory",
  "INSERT INTO FUNCTION null('x Int8') VALUES (1)",
  "SYSTEM FLUSH LOGS",
  `GRANT SELECT ON {db}.* TO ${PREFIX}ro`,
  `CREATE FUNCTION ${PREFIX}f AS x -> x`,
  "SELECT count() FROM url('http://127.0.0.1:8123/ping', LineAsString)",
  { source: "SELECT count() FROM file('libredb_lm_missing.csv', CSV, 'x Int8')" },
];

/** Statements `readonly = 1` leaves usable, so the agent user is held off them by its grants alone (497). */
const READONLY_EXEMPT_STATEMENTS: readonly string[] = [
  `BACKUP TABLE {db}.t TO Memory('${PREFIX}b_${RUN}')`,
  "KILL QUERY WHERE query_id = 'libredb-lm-none' SYNC",
];

/** Table functions that reach another server: the provider's own fence refuses them before the request. */
const FENCED_STATEMENTS: readonly string[] = [
  "SELECT count() FROM remote('127.0.0.1', system.one)",
  "SELECT count() FROM remoteSecure('127.0.0.1', system.one)",
  "SELECT * FROM cluster('default', system.one)",
];

function boundaryText(statement: string | { source: string }, database: string): string {
  return (typeof statement === "string" ? statement : statement.source).replaceAll("{db}", database);
}

/** The engine's code in an MCP answer that is the database's own refusal, or null when it is not one. */
function engineCodeOf(result: ToolResult): number | null {
  const match = /^The database refused or failed the call: Code: (\d+)\./.exec(
    result.content.map((part) => ("text" in part ? part.text : "")).at(-1) ?? "",
  );
  return result.isError === true && match !== null ? Number(match[1]) : null;
}

async function stateHash(): Promise<string> {
  const reads = [
    `SELECT database, name, engine, total_rows FROM system.tables WHERE database LIKE '${PREFIX}%' ORDER BY 1, 2`,
    `SELECT sum(k), sum(x), count() FROM ${DB}.t`,
    `SELECT name FROM system.users WHERE name LIKE '${PREFIX}%' ORDER BY 1`,
    `SELECT name FROM system.roles WHERE name LIKE '${PREFIX}%' ORDER BY 1`,
    `SELECT name FROM system.named_collections WHERE name LIKE '${PREFIX}%' ORDER BY 1`,
    `SELECT name FROM system.functions WHERE name LIKE '${PREFIX}%' ORDER BY 1`,
  ];
  const hash = createHash("sha256");
  for (const sql of reads) hash.update(JSON.stringify((await adminTransport.query(sql)).rows));
  return hash.digest("hex");
}

async function seedServer(): Promise<void> {
  await cleanup();
  for (const database of [DB, CTL]) {
    await admin(`CREATE DATABASE ${database}`);
    await admin(`CREATE TABLE ${database}.t (k Int64, x Int64) ENGINE = MergeTree ORDER BY k`);
    await admin(`INSERT INTO ${database}.t VALUES (1, 10), (2, 20), (3, 30)`);
    await admin(`CREATE TABLE ${database}.r (x Int8) ENGINE = Memory`);
    await admin(`CREATE TABLE ${database}.d (x Int8) ENGINE = Memory`);
  }
  await admin(`CREATE ROLE ${PREFIX}r_backup`);
  await admin(`GRANT BACKUP ON ${DB}.* TO ${PREFIX}r_backup`);
  for (const name of ["ro", ...REFUSED_USERS.map((user) => user.name)]) {
    await admin(`CREATE USER ${PREFIX}${name} IDENTIFIED WITH sha256_password BY '${SEEDED_PASSWORD}'`);
    await admin(`GRANT SELECT ON ${DB}.t TO ${PREFIX}${name}`);
  }
  for (const user of REFUSED_USERS) {
    for (const grant of user.grants) await admin(grant.replaceAll("{u}", `${PREFIX}${user.name}`));
  }
}

async function cleanup(): Promise<void> {
  const drops = [
    `DROP DATABASE IF EXISTS ${DB} SYNC`,
    `DROP DATABASE IF EXISTS ${CTL} SYNC`,
    `DROP FUNCTION IF EXISTS ${PREFIX}f`,
    `DROP ROLE IF EXISTS ${PREFIX}r_backup`,
    `DROP USER IF EXISTS ${["ro", ...REFUSED_USERS.map((user) => user.name)].map((name) => PREFIX + name).join(", ")}`,
  ];
  for (const sql of drops) await admin(sql);
}

async function main(): Promise<void> {
  await seedServer();
  const agent = seed(`${PREFIX}ro`, SEEDED_PASSWORD);

  // The open, through MCP.
  const served = await mcp(agent, { sql: `SELECT k, x FROM ${DB}.t ORDER BY k` }, RUN_READ_QUERY);
  check(
    served.result.isError === undefined &&
      JSON.stringify(served.result.structuredContent?.rows) ===
        '[{"k":"1","x":"10"},{"k":"2","x":"20"},{"k":"3","x":"30"}]' &&
      served.acquired.join() === "agent-read-only",
    `open: ${agent.user}, holding SELECT on ${DB}.t alone, is served under agent-read-only -> ${JSON.stringify(served.result.structuredContent?.rows)}`,
  );
  const refusedOpens = [
    { connection: seed(ADMIN.user, ADMIN.password), says: "" },
    ...REFUSED_USERS.map((user) => ({ connection: seed(`${PREFIX}${user.name}`, SEEDED_PASSWORD), says: user.says })),
  ];
  for (const { connection, says } of refusedOpens) {
    const { result } = await mcp(connection, { sql: `SELECT k FROM ${DB}.t` }, RUN_READ_QUERY);
    const text = textOf(result);
    check(
      result.isError === true &&
        text.startsWith("run_read_query cannot run on this connection: ClickHouse user ") &&
        text.endsWith("It runs on PostgreSQL, SQLite, DuckDB, SQL Server, MySQL and ClickHouse.") &&
        text.includes(says),
      `open: ${connection.name === ADMIN.user ? "the writable admin" : connection.name} is refused through MCP -> ${text}`,
    );
  }

  // The boundary, the MCP fence bypassed, with the state compared before and after.
  const before = await stateHash();
  const readonly = agentRequestSettings({ statementTimeoutMs: 10_000, maxResultRows: 1_000, maxResultBytes: 1 << 20 });
  for (const statement of BOUNDARY_STATEMENTS) {
    const sql = boundaryText(statement, DB);
    const fenced = await mcp(agent, { sql }, RUN_READ_QUERY);
    const { result } = await mcp(agent, { sql });
    const code = engineCodeOf(result);
    // A source table function is a SELECT, which the MCP fence admits: only the engine stands in its way.
    const fenceAdmits = sql.startsWith("SELECT");
    const fenceAnswered = fenced.result.isError === true && fenced.acquired.length === 0;
    check(
      fenceAnswered !== fenceAdmits && (code === 164 || code === 497),
      `boundary: the MCP fence ${fenceAdmits ? "admits" : "refuses"} ${sql}; bypassed, ClickHouse refuses it -> ${code}`,
    );
  }
  for (const template of READONLY_EXEMPT_STATEMENTS) {
    const sql = template.replaceAll("{db}", DB);
    const { result } = await mcp(agent, { sql });
    const code = engineCodeOf(result);
    check(code === 497, `boundary: readonly leaves ${sql} usable; bypassed, the user's grants refuse it -> ${code}`);
  }
  for (const sql of FENCED_STATEMENTS) {
    const { result } = await mcp(agent, { sql });
    const serverCode = await codeOf(agent.user!, SEEDED_PASSWORD, sql, readonly);
    check(
      textOf(result).startsWith(
        "The statement was refused before it reached the database: Read-only execution refused the table function",
      ) &&
        (serverCode === 164 || serverCode === 497),
      `boundary: bypassed, the provider's fence refuses ${sql} before it is sent; the server refuses the agent user too -> ${serverCode}`,
    );
  }
  const lowered = await mcp(agent, { sql: `SELECT count() FROM ${DB}.t SETTINGS readonly = 0` });
  check(
    engineCodeOf(lowered.result) === 164,
    `boundary: a trailing SETTINGS readonly = 0 -> ${engineCodeOf(lowered.result)}`,
  );
  const second = await mcp(agent, { sql: `SELECT 1; INSERT INTO ${DB}.t VALUES (98, 98)` });
  check(
    engineCodeOf(second.result) === 62,
    `boundary: a second statement, refused by the server as one -> ${engineCodeOf(second.result)}`,
  );
  const after = await stateHash();
  check(before === after, `boundary: the state hash is the same before and after -> ${before} / ${after}`);

  // The positive control: the same statements, as the writable admin without readonly, on the control copy.
  for (const statement of BOUNDARY_STATEMENTS) {
    const sql = boundaryText(statement, CTL);
    if (typeof statement === "string") {
      const code = await codeOf(ADMIN.user, ADMIN.password, sql, {});
      check(code === null, `control: the writable admin runs ${sql} -> ${code ?? "answered"}`);
    } else {
      const code = await codeOf(ADMIN.user, ADMIN.password, sql, { max_execution_time: 5 });
      check(
        code !== null && ![62, 164, 497].includes(code),
        `control: the writable admin reaches the source of ${sql} -> ${code ?? "answered"}`,
      );
    }
  }

  // The limits.
  const rows = await mcp(agent, { sql: "SELECT number FROM numbers(2000) LIMIT 1001" }, RUN_READ_QUERY);
  check(
    textOf(rows.result).startsWith("The result has more than 1000 rows"),
    `limits: rows past the provider budget -> ${textOf(rows.result)}`,
  );
  const bytes = await mcp(agent, { sql: "SELECT repeat('x', 600000) AS a, repeat('y', 600000) AS b" }, RUN_READ_QUERY);
  check(
    textOf(bytes.result).startsWith("The result is larger than 1 MiB"),
    `limits: bytes past the provider budget -> ${textOf(bytes.result)}`,
  );
  const page = await mcp(agent, { sql: "SELECT number FROM numbers(500)", max_rows: 5 }, RUN_READ_QUERY);
  check(
    page.result.structuredContent?.row_count === 5 && page.result.structuredContent?.truncated_by === "max_rows",
    `limits: a read past max_rows is cut to it and says so -> ${JSON.stringify(page.result.structuredContent?.pagination)}`,
  );
  const slow = await mcp(
    agent,
    { sql: "SELECT count() FROM numbers(100000000000)", timeout_ms: 1_000 },
    RUN_READ_QUERY,
  );
  check(
    textOf(slow.result) ===
      "The statement did not finish within timeout_ms (1000 ms). Narrow it, or raise timeout_ms up to 30000.",
    `limits: past timeout_ms -> ${textOf(slow.result)}`,
  );
}

try {
  await main();
} finally {
  await clearProviderCache();
  await cleanup();
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
