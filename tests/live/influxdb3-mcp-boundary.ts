/**
 * Live check of MCP's `run_read_query` on InfluxDB 3 (SQL), against the `influxdb3` and `influxdb3-filelimit` services
 * of `database-compose.yml` and an InfluxDB 3 Core server outside the checked line.
 *
 * WHY THIS EXISTS. `run_read_query` serves InfluxDB 3 through the same boundary agent mode does: the connection is
 * acquired under the agent read-only profile, whose open checks the server is the 3.12 Core line whose planner's write
 * refusals were captured (`sql-agent-read.ts`), and every statement goes through the provider's `queryReadOnly`, which
 * runs the read policy and the `system` schema fence before it sends anything. The MCP fence in front of it is defence
 * in depth. So this script replays the agent boundary check (`tests/live/influxdb3-agent-boundary.ts`, and the write
 * refusals it rests on, `tests/fixtures/influxdb/3.12.0-core/write-refusal/`) through the MCP tool's own handler
 * (`runStatement`) with that fence removed, against real servers:
 *
 *  - the open, through MCP: the 3.12.0 Core server is served under `agent-read-only`; a 3.11.0 Core server is refused
 *    before any statement runs, in the MCP refusal sentence, as the open refuses it for agent mode;
 *  - the boundary, with the MCP fence bypassed: each captured write, DDL, COPY, SET, transaction and second statement
 *    is sent through the MCP handler; the fenced tool refuses every one before anything is acquired, and unfenced the
 *    provider's read policy refuses it before it is sent, in its own sentence; sent raw through the route-table client
 *    with the same token, the planner refuses each with the status and the words the capture recorded; a `system`
 *    table, also with its schema written as a string, passes the MCP fence and is refused by the provider's `system`
 *    fence, while the same text sent raw is answered, so that fence is what keeps it out; the positive control is the same token writing a point through the
 *    write route into a scratch database, which MCP then reads and the script deletes; the databases, tables, columns,
 *    row counts and tokens hash the same before and after;
 *  - the forms and limits: a `VALUES` and an `EXPLAIN` answer, `TABLE` is refused by the read policy and is a parser
 *    error on the server; a read pages with `offset`; one past the 1000-row provider budget and one past the 1 MiB
 *    budget are refused, never cut; one past `timeout_ms` is answered as the timeout, and the server answers the next
 *    call; on the file-limit server a read over the file limit is answered as the database's refusal, never as rows.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it with both services up and seeded
 * (`docker/influxdb/seed.sh`, `docker/influxdb/seed.sh filelimit`), as for the agent check, and an unchecked Core
 * server started the same way from `influxdb:3.11.0-core` on another port:
 *
 *   LIBREDB_LIVE_INFLUXDB3_UNCHECKED_PORT=8183 bun tests/live/influxdb3-mcp-boundary.ts
 *
 * The scratch database is named `libredb_lm_<random>` and deleted before exit. Each check prints one line, and a line
 * that would carry the token fails instead of printing it; any failure ends the run non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import { createInfluxClient } from "@/lib/db/providers/timeseries/influxdb/client";
import { buildInfluxConnectionOptions } from "@/lib/db/providers/timeseries/influxdb/connection-options";
import { SQL_ROUTES } from "@/lib/db/providers/timeseries/influxdb/routes";
import { evaluateInfluxSql } from "@/lib/db/providers/timeseries/influxdb/sql-policy";
import type { McpConnectionContext } from "@/lib/mcp/context";
import type { ToolResult } from "@/lib/mcp/output";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm, type McpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import { loadWriteRefusalCaptures } from "../helpers/influxdb-fixtures";
import { readFixtureCredentials } from "./influxdb-evidence-checks";

const ROOT = path.resolve(import.meta.dirname, "../..");
const TOKEN = readFixtureCredentials(
  readFileSync(path.join(ROOT, "database-compose.yml"), "utf8"),
  readFileSync(path.join(ROOT, "docker/influxdb/seed.sh"), "utf8"),
).v3AdminToken;

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(
      `set ${name}: the open's refusal of an unchecked server is checked against one, so it has no default`,
    );
    process.exit(2);
  }
  return value;
}

const UNCHECKED_PORT = Number(env("LIBREDB_LIVE_INFLUXDB3_UNCHECKED_PORT"));
const SCRATCH = `libredb_lm_${randomBytes(4).toString("hex")}`;

/** The tool as MCP registers it, and the same tool with its statement fence removed: the boundary under test. */
const RUN_READ_QUERY = mcpStatementArm("run_read_query");
const UNFENCED: McpStatementArm = { ...RUN_READ_QUERY, fence: () => null };
const ENGINES = RUN_READ_QUERY.engines;

/** Every captured statement but the two token captures, which record the token table and a route, not a refusal. */
const REFUSALS = loadWriteRefusalCaptures().filter((entry) => !entry.name.startsWith("write-refusal/token-"));
const textOfCapture = (entry: (typeof REFUSALS)[number]): string => (entry.request.body as { q: string }).q;

const SYSTEM_TABLES: readonly string[] = [
  "SELECT * FROM system.queries",
  "SELECT * FROM system.parquet_files",
  'SELECT * FROM "system"."queries"',
];
const SYSTEM_REFUSAL =
  "The statement was refused before it reached the database: The agent reads no table of InfluxDB 3's system schema but system.influxdb_schema: the others hold other queries' text, files and engine logs.";
/** The schema named by a string before a `.`, which the server reads as a name and answers with system.queries' rows. */
const STRING_QUALIFIED_SYSTEM_TABLES: readonly string[] = [
  "SELECT query_text FROM 'system'.queries",
  "SELECT query_text FROM 'system'.'queries'",
  "SELECT query_text FROM public.'system'.queries",
  "SELECT query_text FROM 'public'.'system'.'queries'",
  `SELECT query_text FROM 'system'."queries"`,
];
const STRING_QUALIFIER_REFUSAL =
  "The statement was refused before it reached the database: The agent reads no name written as a string before a `.`, since InfluxDB 3 reads it as a schema or table name and the system schema fence reads only names: write the name bare or in double quotes.";

function seed(name: string, port: number, database = "home"): ManagedConnection {
  return {
    id: `seed:live-${name}`,
    name,
    seedId: `live-${name}`,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "influxdb3",
    host: "127.0.0.1",
    port,
    password: TOKEN,
    database,
    createdAt: new Date(),
  } as ManagedConnection;
}

const options = buildInfluxConnectionOptions(seed("raw", 8181), { type: "influxdb3", queryTimeout: 30_000 });
const client = createInfluxClient(options, SQL_ROUTES);

/** A statement sent raw through the route-table client, past every check of Studio's. */
async function raw(q: string, db = "home") {
  return client.send({ route: "query", values: { db, q } }, AbortSignal.timeout(30_000));
}

async function rawRows(q: string, db = "home"): Promise<string> {
  const answer = await raw(q, db);
  if (answer.status !== 200) throw new Error(`state read ${q}: ${answer.status}`);
  return answer.text;
}

let failures = 0;
function check(ok: boolean, line: string): void {
  if (line.includes(TOKEN)) {
    console.log("FAIL a check line carried the token, and is not printed");
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

/** The engine's answer in an MCP result that is the database's own refusal, or null when it is not one. */
function engineTextOf(result: ToolResult): string | null {
  const last = result.content.map((part) => ("text" in part ? part.text : "")).at(-1) ?? "";
  const prefix = "The database refused or failed the call: ";
  return result.isError === true && last.startsWith(prefix) ? last.slice(prefix.length) : null;
}

/** The sentence the provider's read policy refuses `sql` with, as MCP answers a refusal that sent nothing. */
function policyRefusal(sql: string): string | null {
  const verdict = evaluateInfluxSql(sql);
  if (verdict.allowed) return null;
  const reason = /[.!?]$/.test(verdict.message) ? verdict.message : `${verdict.message}.`;
  return `The statement was refused before it reached the database: ${reason}`;
}

/** A hash of everything a write could change; the scratch database is left out. */
async function stateHash(): Promise<string> {
  const listing = await client.send({ route: "databases", values: {} }, AbortSignal.timeout(30_000));
  const names = (JSON.parse(listing.text) as { "iox::database": string }[])
    .map((row) => row["iox::database"])
    .filter((name) => name !== SCRATCH);
  const hash = createHash("sha256").update(`databases ${names.join(",")}`);
  for (const name of names.filter((db) => db !== "_internal")) {
    hash.update(
      await rawRows(
        "SELECT table_schema, table_name, column_name FROM information_schema.columns ORDER BY 1, 2, 3",
        name,
      ),
    );
  }
  hash.update(await rawRows("SELECT count(*) AS n FROM home"));
  hash.update(await rawRows("SELECT name, permissions FROM system.tokens ORDER BY name", "_internal"));
  return hash.digest("hex");
}

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
  const agent = seed("core-3-12", 8181);

  // The open, through MCP.
  const count = JSON.parse((await rawRows("SELECT count(*) AS n FROM home")).trim()) as { n: number };
  const served = await mcp(agent, { sql: "SELECT count(*) AS n FROM home" }, RUN_READ_QUERY);
  check(
    served.result.isError === undefined &&
      JSON.stringify(served.result.structuredContent?.rows) === JSON.stringify([count]) &&
      served.acquired.join() === "agent-read-only",
    `open: the 3.12.0 Core server is served under agent-read-only -> ${JSON.stringify(served.result.structuredContent?.rows)}`,
  );
  const unchecked = await mcp(seed("core-3-11", UNCHECKED_PORT), { sql: "SELECT 1" }, RUN_READ_QUERY);
  check(
    unchecked.result.isError === true &&
      textOf(unchecked.result) ===
        `run_read_query cannot run on this connection: The agent read-only profile is checked on InfluxDB 3 Core 3.12, and this server is InfluxDB 3 Core 3.11.0: its write refusals have not been captured, so it is refused. It runs on ${ENGINES}.`,
    `open: a 3.11.0 Core server is refused through MCP -> ${textOf(unchecked.result)}`,
  );

  // The boundary, the MCP fence bypassed, with the state compared before and after.
  const before = await stateHash();
  for (const entry of REFUSALS) {
    const sql = textOfCapture(entry);
    const fenced = await mcp(agent, { sql }, RUN_READ_QUERY);
    check(
      fenced.result.isError === true && fenced.acquired.length === 0,
      `boundary: the MCP fence refuses ${sql} before anything is acquired`,
    );
    const { result } = await mcp(agent, { sql });
    const policy = policyRefusal(sql);
    check(
      policy !== null && textOf(result) === policy,
      `boundary: bypassed, the read policy refuses ${sql} unsent -> ${textOf(result).slice(0, 110)}`,
    );
    const answer = await raw(sql);
    check(
      answer.status === entry.status && answer.text === entry.body,
      `boundary: sent raw, the planner refuses ${sql} in its own words -> ${answer.status} ${answer.text.slice(0, 70)}`,
    );
  }
  for (const sql of SYSTEM_TABLES) {
    const { result, acquired } = await mcp(agent, { sql }, RUN_READ_QUERY);
    const answer = await raw(sql);
    check(
      textOf(result) === SYSTEM_REFUSAL && acquired.join() === "agent-read-only" && answer.status === 200,
      `system: ${sql} passes the MCP fence and is refused by the provider's system fence; sent raw the server answers it -> ${answer.status}`,
    );
  }
  for (const sql of STRING_QUALIFIED_SYSTEM_TABLES) {
    const { result, acquired } = await mcp(agent, { sql }, RUN_READ_QUERY);
    const answer = await raw(sql);
    check(
      textOf(result) === STRING_QUALIFIER_REFUSAL &&
        acquired.join() === "agent-read-only" &&
        answer.status === 200 &&
        answer.text.includes('"query_text"'),
      `system: ${sql} passes the MCP fence and is refused by the provider's fence; sent raw the server answers it with rows -> ${answer.status}`,
    );
  }
  const schema = await mcp(agent, { sql: "SELECT * FROM system.influxdb_schema" }, RUN_READ_QUERY);
  check(
    schema.result.isError === undefined && (schema.result.structuredContent?.row_count as number) > 0,
    `system: system.influxdb_schema is read -> ${schema.result.structuredContent?.row_count} rows`,
  );
  const after = await stateHash();
  check(before === after, `boundary: the state hash is the same before and after -> ${before} / ${after}`);

  // The positive control: the same token writes through the write route, which the provider's table does not hold.
  try {
    const written = await writeLp(SCRATCH, `probe,tag=a v=1i ${Math.floor(Date.now() / 1000)}`);
    check(written === 204, `control: the same token writes a point through /api/v3/write_lp -> ${written}`);
    const read = await mcp(seed("scratch", 8181, SCRATCH), { sql: "SELECT tag, v FROM probe" }, RUN_READ_QUERY);
    check(
      JSON.stringify(read.result.structuredContent?.rows) === '[{"tag":"a","v":1}]',
      `control: MCP reads the written point back -> ${JSON.stringify(read.result.structuredContent?.rows)}`,
    );
  } finally {
    await dropScratch();
  }

  // The forms.
  const values = await mcp(agent, { sql: "VALUES (1, 'a'), (2, 'b')" }, RUN_READ_QUERY);
  check(values.result.structuredContent?.row_count === 2, `forms: VALUES answers its rows`);
  const plan = await mcp(agent, { sql: "EXPLAIN SELECT count(*) FROM home" }, RUN_READ_QUERY);
  check(
    (plan.result.structuredContent?.columns as { name: string }[] | undefined)?.some(
      (column) => column.name === "plan_type",
    ) === true,
    `forms: EXPLAIN answers the plan -> ${plan.result.structuredContent?.row_count} rows`,
  );
  const table = await mcp(agent, { sql: "TABLE home" }, RUN_READ_QUERY);
  const tableRaw = await raw("TABLE home");
  check(
    textOf(table.result) === policyRefusal("TABLE home") &&
      tableRaw.status === 400 &&
      tableRaw.text.startsWith('SQL error: ParserError("Expected: an SQL statement, found: TABLE'),
    `forms: TABLE passes the MCP fence, is refused by the read policy, and is a parser error on the server -> ${tableRaw.text.slice(0, 80)}`,
  );

  // The limits.
  const page = await mcp(agent, { sql: "SELECT room, time FROM home ORDER BY time, room", max_rows: 5, offset: 5 });
  check(
    page.result.structuredContent?.row_count === 5 &&
      JSON.stringify(page.result.structuredContent?.pagination) ===
        '{"offset":5,"limit":5,"hasMore":true,"nextOffset":10,"wasLimited":true}',
    `limits: a read pages with offset -> ${JSON.stringify(page.result.structuredContent?.pagination)}`,
  );
  const rows = await mcp(agent, { sql: "SELECT value FROM generate_series(1, 5000) LIMIT 2000" }, RUN_READ_QUERY);
  check(
    textOf(rows.result).startsWith("The result has more than 1000 rows"),
    `limits: rows past the provider budget -> ${textOf(rows.result)}`,
  );
  const bytes = await mcp(agent, { sql: "SELECT repeat('x', 600000) AS a, repeat('y', 600000) AS b" }, RUN_READ_QUERY);
  check(
    textOf(bytes.result).startsWith("The result is larger than 1 MiB"),
    `limits: bytes past the provider budget -> ${textOf(bytes.result)}`,
  );
  const slow = await mcp(
    agent,
    { sql: "SELECT count(*) AS n FROM generate_series(1, 20000000000)", timeout_ms: 1_000 },
    RUN_READ_QUERY,
  );
  check(
    textOf(slow.result) ===
      "The statement did not finish within timeout_ms (1000 ms). Narrow it, or raise timeout_ms up to 30000.",
    `limits: past timeout_ms -> ${textOf(slow.result)}`,
  );
  const next = await mcp(agent, { sql: "SELECT count(*) AS n FROM home" }, RUN_READ_QUERY);
  check(
    JSON.stringify(next.result.structuredContent?.rows) === JSON.stringify([count]),
    `limits: the server answers the next call -> ${JSON.stringify(next.result.structuredContent?.rows)}`,
  );

  // The file-limit server.
  const limited = await mcp(seed("filelimit", 8182), { sql: 'SELECT count(*) FROM "home"' }, RUN_READ_QUERY);
  check(
    engineTextOf(limited.result)?.startsWith(
      "InfluxDB 3 Core refuses a query that would read more than its file limit",
    ) === true,
    `filelimit: a read over the file limit is answered as the database's refusal, never as rows -> ${engineTextOf(limited.result)?.slice(0, 90)}`,
  );
}

try {
  await main();
} finally {
  await dropScratch();
  await clearProviderCache();
  client.close();
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
