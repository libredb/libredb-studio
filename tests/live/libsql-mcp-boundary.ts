/**
 * Live check of MCP's `run_read_query` on libSQL, against servers of the operator's choosing.
 *
 * WHY THIS EXISTS. `run_read_query` serves libSQL through the same boundary agent mode does: the connection is acquired
 * under the agent read-only profile, whose open proves the token read-only (its claims, then three writes the server
 * must refuse, `agent-boundary.ts`), and every statement goes through the provider's `queryReadOnly`, alone in one
 * request under that token. The MCP fence in front of it is defence in depth. So this script replays the agent
 * boundary check (`tests/live/libsql-agent-boundary.ts`) through the MCP tool's own handler (`runStatement`) with that
 * fence removed, against real servers:
 *
 *  - the open, through MCP: a read-only token is served; the writable token, a read-only token whose permission claim
 *    widens it, a user name and password on a server started with HTTP Basic, and a server that checks no credential
 *    (with no token, and with the read-only token, whose probes it runs) are each refused before any statement runs,
 *    in the MCP refusal sentence;
 *  - the boundary, with the MCP fence bypassed: each write, DDL, writing pragma, attach, detach, vacuum, extension load
 *    and second statement is sent with the read-only token through the MCP handler; the fenced tool refuses every one
 *    before anything is acquired, and unfenced the server refuses every write with 403 and the rest with its own
 *    statement error; the same statements run with the writable token on a scratch table, the positive control; the
 *    tables, rows, indexes, views, triggers and `user_version` read back the same before and after; a `BEGIN
 *    IMMEDIATE` answers, and a write with the writable token right after it runs, so it held nothing past its request;
 *  - the limits: a read answers its rows and pages with offset; one past the 1000-row provider budget and one past the
 *    1 MiB budget are refused, never cut; one past `timeout_ms` is answered as the timeout, and the server answers the
 *    next call.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it against the three servers
 * `tests/live/libsql-agent-boundary.ts` takes, which `docs/providers/libsql.md` section 3.6 shows how to start, with the
 * same variables:
 *
 *   LIBREDB_LIVE_LIBSQL_JWT_PORT=18181 LIBREDB_LIVE_LIBSQL_RO_TOKEN=... LIBREDB_LIVE_LIBSQL_RW_TOKEN=... \
 *     LIBREDB_LIVE_LIBSQL_WIDENED_TOKEN=... \
 *     LIBREDB_LIVE_LIBSQL_BASIC_PORT=18182 LIBREDB_LIVE_LIBSQL_BASIC_USER=... LIBREDB_LIVE_LIBSQL_BASIC_PASSWORD=... \
 *     LIBREDB_LIVE_LIBSQL_OPEN_PORT=18183 bun tests/live/libsql-mcp-boundary.ts
 *
 * Every table it creates carries the `libredb_lm_` prefix and is dropped on exit. Each check prints one line, and a line
 * that would carry a credential the run was given fails instead of printing it; any failure ends the run non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import { createHash } from "node:crypto";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import { LibSQLHranaTransport } from "@/lib/db/providers/sql/libsql/hrana-transport";
import { LibSQLTransportError } from "@/lib/db/providers/sql/libsql/transport";
import type { McpConnectionContext } from "@/lib/mcp/context";
import type { ToolResult } from "@/lib/mcp/output";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm, type McpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";

const PREFIX = "libredb_lm_";
const DATA = `${PREFIX}data`;
const SCRATCH = `${PREFIX}scratch`;

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`set ${name}: this script writes to the servers it is pointed at, so it has no default`);
    process.exit(2);
  }
  return value;
}

const HOST = process.env.LIBREDB_LIVE_LIBSQL_HOST ?? "127.0.0.1";
const JWT_PORT = Number(env("LIBREDB_LIVE_LIBSQL_JWT_PORT"));
const RO = env("LIBREDB_LIVE_LIBSQL_RO_TOKEN");
const RW = env("LIBREDB_LIVE_LIBSQL_RW_TOKEN");
const WIDENED = env("LIBREDB_LIVE_LIBSQL_WIDENED_TOKEN");
const BASIC_PORT = Number(env("LIBREDB_LIVE_LIBSQL_BASIC_PORT"));
const BASIC = { user: env("LIBREDB_LIVE_LIBSQL_BASIC_USER"), password: env("LIBREDB_LIVE_LIBSQL_BASIC_PASSWORD") };
const OPEN_PORT = Number(env("LIBREDB_LIVE_LIBSQL_OPEN_PORT"));
const SECRETS = [RO, RW, WIDENED, BASIC.password];

/** The tool as MCP registers it, and the same tool with its statement fence removed: the boundary under test. */
const RUN_READ_QUERY = mcpStatementArm("run_read_query");
const UNFENCED: McpStatementArm = { ...RUN_READ_QUERY, fence: () => null };
const ENGINES = RUN_READ_QUERY.engines;

function seed(name: string, port: number, credential: { user?: string; password?: string }): ManagedConnection {
  return {
    id: `seed:live-${name}`,
    name,
    seedId: `live-${name}`,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "libsql",
    host: HOST,
    port,
    ...credential,
    createdAt: new Date(),
  } as ManagedConnection;
}

const writable = new LibSQLHranaTransport(seed("rw", JWT_PORT, { password: RW }));

async function write(sql: string): Promise<void> {
  await writable.execute(sql, { timeoutMs: 30_000 });
}

let failures = 0;
function check(ok: boolean, line: string): void {
  if (SECRETS.some((secret) => line.includes(secret))) {
    console.log("FAIL a check line carried a credential, and is not printed");
    failures++;
    return;
  }
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

/** The server's own refusal in an MCP answer, or null when the answer is not one. */
function engineRefusalOf(result: ToolResult): string | null {
  const last = result.content.map((part) => ("text" in part ? part.text : "")).at(-1) ?? "";
  const match = /^The database refused or failed the call: ([\s\S]*)$/.exec(last);
  return result.isError === true && match !== null ? (match[1] ?? null) : null;
}

/**
 * The writes, each written for a table so the positive control runs it on the scratch copy. `refusedForEvery` holds the
 * server's own wording for a statement it refuses whatever the token, so the bypassed check and its control both
 * match that refusal rather than any error.
 */
const WRITES: { sql: (table: string) => string; refusedForEvery?: string }[] = [
  { sql: (t) => `INSERT INTO "${t}" (id, v) VALUES (100, 'x')` },
  { sql: (t) => `INSERT INTO "${t}" (id, v) VALUES (101, 'x') RETURNING id` },
  { sql: (t) => `INSERT INTO "${t}" (id, v) VALUES (1, 'x') ON CONFLICT (id) DO UPDATE SET v = 'y'` },
  { sql: (t) => `REPLACE INTO "${t}" (id, v) VALUES (1, 'z')` },
  { sql: (t) => `UPDATE "${t}" SET v = 'u' WHERE id = 1` },
  { sql: (t) => `DELETE FROM "${t}" WHERE id = 2` },
  { sql: (t) => `WITH doomed AS (SELECT 3 AS id) DELETE FROM "${t}" WHERE id IN (SELECT id FROM doomed)` },
  { sql: (t) => `CREATE TABLE "${t}_made" AS SELECT * FROM "${t}"` },
  { sql: (t) => `CREATE INDEX "${t}_made_idx" ON "${t}" (v)` },
  { sql: (t) => `CREATE VIEW "${t}_made_view" AS SELECT 1 AS a` },
  { sql: (t) => `CREATE TRIGGER "${t}_made_trg" AFTER INSERT ON "${t}" BEGIN SELECT 1; END` },
  { sql: (t) => `ALTER TABLE "${t}" ADD COLUMN extra TEXT` },
  { sql: (t) => `DROP INDEX "${t}_idx"` },
  { sql: (t) => `DROP TABLE "${t}"` },
  { sql: () => "REINDEX" },
  { sql: () => "PRAGMA user_version = 5" },
  { sql: () => "PRAGMA foreign_keys = OFF" },
  { sql: () => "ATTACH DATABASE ':memory:' AS other", refusedForEvery: "unsupported statement" },
  { sql: () => "DETACH DATABASE other", refusedForEvery: "no such database" },
  { sql: () => `VACUUM INTO '/tmp/${PREFIX}copy.db'`, refusedForEvery: "unsupported statement" },
  { sql: () => "VACUUM", refusedForEvery: "unsupported statement" },
  { sql: () => "ANALYZE", refusedForEvery: "unsupported statement" },
  { sql: (t) => `CREATE TEMP TABLE "${t}_tmp" (a INTEGER)`, refusedForEvery: "unsupported statement" },
  { sql: () => "PRAGMA journal_mode = DELETE", refusedForEvery: "unsupported statement" },
  { sql: () => "PRAGMA writable_schema = ON", refusedForEvery: "unsupported statement" },
  { sql: () => "PRAGMA query_only = 0", refusedForEvery: "unsupported statement" },
  { sql: () => "SELECT load_extension('/tmp/libredb_lm_none')", refusedForEvery: "not authorized" },
  { sql: (t) => `SELECT 1; DELETE FROM "${t}"`, refusedForEvery: "more than one statement" },
];

/** The writable token's answer to `sql`: `ran`, or the server's statement error. */
async function writableAnswer(sql: string): Promise<string> {
  try {
    await write(sql);
    return "ran";
  } catch (error) {
    if (error instanceof LibSQLTransportError) return `refused: ${error.message.slice(0, 120)}`;
    throw error;
  }
}

/** A hash of the server's state as the writable token reads it: every schema object, every row, and `user_version`. */
async function stateHash(): Promise<string> {
  const hash = createHash("sha256");
  for (const sql of [
    "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name",
    `SELECT * FROM "${DATA}" ORDER BY id`,
    "PRAGMA user_version",
  ]) {
    hash.update(JSON.stringify((await writable.execute(sql, { timeoutMs: 30_000 })).rows));
  }
  return hash.digest("hex");
}

async function seedServer(): Promise<void> {
  await cleanup();
  for (const table of [DATA, SCRATCH]) {
    await write(`CREATE TABLE "${table}" (id INTEGER PRIMARY KEY, v TEXT)`);
    await write(`INSERT INTO "${table}" (id, v) VALUES (1, 'a'), (2, 'b'), (3, 'c')`);
    await write(`CREATE INDEX "${table}_idx" ON "${table}" (v)`);
  }
}

async function cleanup(): Promise<void> {
  const left = await writable.execute(
    `SELECT type, name FROM sqlite_master WHERE name LIKE '${PREFIX}%' AND type IN ('table', 'view', 'trigger') ORDER BY type DESC`,
    { timeoutMs: 30_000 },
  );
  for (const row of left.rows) await write(`DROP ${String(row.type).toUpperCase()} IF EXISTS "${String(row.name)}"`);
  await write("PRAGMA user_version = 0");
}

/** The MCP refusal sentence a connection refused at open is answered with, around the profile's own message. */
const refusedAtOpen = (text: string, says: string): boolean =>
  text.startsWith("run_read_query cannot run on this connection: ") &&
  text.endsWith(`It runs on ${ENGINES}.`) &&
  text.includes(says);

async function main(): Promise<void> {
  await seedServer();
  const agent = seed("ro", JWT_PORT, { password: RO });

  // The open, through MCP.
  const served = await mcp(agent, { sql: `SELECT id, v FROM "${DATA}" ORDER BY id` }, RUN_READ_QUERY);
  check(
    served.result.isError === undefined &&
      JSON.stringify(served.result.structuredContent?.rows) ===
        '[{"id":1,"v":"a"},{"id":2,"v":"b"},{"id":3,"v":"c"}]' &&
      served.acquired.join() === "agent-read-only",
    `open: the read-only token is served under agent-read-only -> ${JSON.stringify(served.result.structuredContent?.rows)}`,
  );
  const refusedOpens: readonly { label: string; connection: ManagedConnection; says: string }[] = [
    {
      label: "the writable token",
      connection: seed("rw-open", JWT_PORT, { password: RW }),
      says: "is not a read-only token",
    },
    {
      label: "the widened token",
      connection: seed("widened", JWT_PORT, { password: WIDENED }),
      says: 'carries claims beyond the read-only marker and the standard ones ("p")',
    },
    {
      label: "a user name and password on the Basic server",
      connection: seed("basic", BASIC_PORT, BASIC),
      says: "signs in with a user name and password (HTTP Basic)",
    },
    {
      label: "no token on the server that checks none",
      connection: seed("open-none", OPEN_PORT, {}),
      says: "with no token reaches only a server that checks no credential",
    },
    {
      label: "the read-only token on the server that checks none",
      connection: seed("open-ro", OPEN_PORT, { password: RO }),
      says: "so the server does not hold the token to them",
    },
  ];
  for (const { label, connection, says } of refusedOpens) {
    const { result, acquired } = await mcp(connection, { sql: `SELECT id FROM "${DATA}"` }, RUN_READ_QUERY);
    const text = textOf(result);
    check(
      result.isError === true && acquired.join() === "agent-read-only" && refusedAtOpen(text, says),
      `open: ${label} is refused through MCP -> ${text}`,
    );
  }

  // The boundary, with the state compared before and after: the fenced tool refuses each statement before anything
  // is acquired, and with its fence removed the server refuses it.
  const before = await stateHash();
  for (const statement of WRITES) {
    const sql = statement.sql(DATA);
    const fenced = await mcp(agent, { sql }, RUN_READ_QUERY);
    check(
      fenced.result.isError === true &&
        fenced.acquired.length === 0 &&
        textOf(fenced.result).startsWith("The statement was refused before it reached the database ("),
      `boundary: the MCP fence refuses ${sql} before anything is acquired`,
    );
    const refusal = engineRefusalOf((await mcp(agent, { sql })).result) ?? "answered";
    const expected =
      statement.refusedForEvery === undefined
        ? refusal.startsWith("libSQL request failed: Authorization forbidden: ")
        : refusal.includes(statement.refusedForEvery) && !refusal.includes("Authorization forbidden");
    check(expected, `boundary: bypassed, the server refuses ${sql} -> ${refusal.slice(0, 120)}`);
  }
  const after = await stateHash();
  check(before === after, `boundary: the state hash is the same before and after -> ${before} / ${after}`);

  // The positive control, on the scratch table.
  for (const statement of WRITES) {
    const sql = statement.sql(SCRATCH);
    const answer = await writableAnswer(sql);
    const expected =
      statement.refusedForEvery === undefined
        ? answer === "ran"
        : answer.startsWith("refused: ") && answer.includes(statement.refusedForEvery);
    check(expected, `control: the writable token on ${sql} -> ${answer}`);
  }
  await write("PRAGMA user_version = 0");

  // A transaction statement is not a write: it answers, and closes with its own request.
  const begun = await mcp(agent, { sql: "BEGIN IMMEDIATE" });
  check(begun.result.isError === undefined, `boundary: bypassed, BEGIN IMMEDIATE answers -> ${textOf(begun.result)}`);
  check(
    (await writableAnswer(`CREATE TABLE "${PREFIX}after_begin" (a INTEGER)`)) === "ran",
    "control: a write with the writable token right after it runs, so the lock closed with the request",
  );

  // The limits.
  const page = await mcp(
    agent,
    { sql: `SELECT id FROM "${DATA}" ORDER BY id`, max_rows: 1, offset: 1 },
    RUN_READ_QUERY,
  );
  check(
    JSON.stringify(page.result.structuredContent?.rows) === '[{"id":2}]' &&
      page.result.structuredContent?.hint === "Call again with offset 2 for the next page.",
    `limits: a page with LIMIT n OFFSET m -> ${JSON.stringify(page.result.structuredContent?.pagination)}`,
  );
  const rows = await mcp(
    agent,
    { sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 1001) SELECT x FROM c LIMIT 1001" },
    RUN_READ_QUERY,
  );
  check(
    textOf(rows.result).startsWith("The result has more than 1000 rows"),
    `limits: rows past the provider budget -> ${textOf(rows.result)}`,
  );
  const bytes = await mcp(agent, { sql: "SELECT hex(randomblob(600000)) AS big" }, RUN_READ_QUERY);
  check(
    textOf(bytes.result).startsWith("The result is larger than 1 MiB"),
    `limits: bytes past the provider budget -> ${textOf(bytes.result)}`,
  );
  const slow = await mcp(
    agent,
    {
      sql: "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c LIMIT 3000000000) SELECT count(*) FROM c",
      timeout_ms: 1_000,
    },
    RUN_READ_QUERY,
  );
  check(
    textOf(slow.result) ===
      "The statement did not finish within timeout_ms (1000 ms). Narrow it, or raise timeout_ms up to 30000.",
    `limits: past timeout_ms -> ${textOf(slow.result)}`,
  );
  const next = await mcp(agent, { sql: "SELECT 1 AS one" }, RUN_READ_QUERY);
  check(
    JSON.stringify(next.result.structuredContent?.rows) === '[{"one":1}]',
    "limits: the server answers the next call after the timeout",
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
