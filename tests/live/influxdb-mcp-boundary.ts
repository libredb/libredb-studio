/**
 * Live check of MCP's `run_influxql_read` on InfluxDB 1.13.1 and 2.9.1, against the servers
 * `tests/fixtures/influxdb/1.13.1/mcp-boundary/run.sh` starts and seeds.
 *
 * WHY THIS EXISTS. `run_influxql_read` serves InfluxDB over InfluxQL through the boundary agent mode uses: the
 * connection is acquired under the agent read-only profile, and every statement goes through the provider's
 * `queryReadOnly`, which reads it with the agent's reader, has the server prove the principal is refused an
 * administrator's read and a no-op write on every database it lists, and refuses an answer shaped as SHOW QUERIES or
 * SHOW CONTINUOUS QUERIES from its columns. The MCP fence in front of it is defence in depth. So this script replays
 * the agent boundary through the MCP tool's own handler (`runStatement`), with that fence in place and removed:
 *
 *  - the open, through MCP: a 1.x READ user and a 2.x token reading one bucket are served under `agent-read-only`; a
 *    1.x admin, a 1.x user that writes a second database, a 1.x server with authentication off, the 2.x operator token
 *    and a 2.x token that writes its bucket are each refused in the tool's sentence before any statement runs;
 *  - the boundary: every write-shaped statement is refused by the fenced tool before anything is acquired, by the
 *    provider's reader with the MCP fence removed, and, sent raw as the READ user past every check of Studio's, by
 *    the server; the positive control is the same `SELECT ... INTO` from the user that writes the second database,
 *    which the server runs; the databases, measurements, users, grants and counts hash the same before and after;
 *  - statement text: every spelling of SHOW QUERIES and SHOW CONTINUOUS QUERIES is refused by the fenced tool before
 *    anything is acquired and by the provider's reader with the fence removed; sent raw as the READ user while the
 *    admin runs a heavy read, the server's answer to each is recorded in `<version>/mcp-boundary/query-text-spellings.json`
 *    (whether it carried statement text, never the text), and the provider's answer check refuses the live answers
 *    that did, from their columns;
 *  - data scope: the READ user lists only its database and is refused a fully qualified read of another and of
 *    `_internal` by the server, while a user granted READ on both reads the second: the grant is the scope;
 *  - the forms and limits: each admitted form answers; a read past the 1000-row provider budget is refused, never cut;
 *    one cut at max_rows says to page with OFFSET; one past the minimum `timeout_ms` is answered as the timeout, and a
 *    client close as cancelled, each with how long the server ran the statement on afterwards, read from the admin's
 *    SHOW QUERIES.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it through the run.sh named above. Each
 * check prints one line, and a line or a capture that would carry a credential fails instead; any failure ends the run
 * non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { InfluxAnswerShapeError } from "@/lib/db/providers/timeseries/influxdb/errors";
import { readInfluxqlAgentStatement } from "@/lib/db/providers/timeseries/influxdb/influxql-agent-statement";
import {
  INFLUXQL_AGENT_QUERY_TEXT_SENTENCE,
  shapeInfluxqlAgentAnswer,
} from "@/lib/db/providers/timeseries/influxdb/influxql-agent-read";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_CANCELLED_TEXT, type ToolResult } from "@/lib/mcp/output";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm, type McpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";
import { INFLUXQL_QUERY_TEXT_SPELLINGS } from "../helpers/influxql-query-text-spellings";

const ROOT = path.resolve(import.meta.dirname, "../..");
const IMAGES = {
  "1.13.1": "influxdb:1.13.1@sha256:3e3913d3b7512d1749922c8183bbf2a76973dd9f98e1a1e3249c652ec1576fc0",
  "2.9.1": "influxdb:2.9.1@sha256:db0bdab1e5ad5ee899c127b8c13d9c986a3ced78cd9200dd80a1064bf1533b6e",
} as const;

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`set ${name}: run this check through tests/fixtures/influxdb/1.13.1/mcp-boundary/run.sh`);
    process.exit(2);
  }
  return value;
}

const URL1 = env("INFLUX1_URL");
const URL1_NOAUTH = env("INFLUX1_NOAUTH_URL");
const URL2 = env("INFLUX2_URL");
const ADMIN = env("INFLUX1_ADMIN");
const READER = env("INFLUX1_READER");
const WIDE = env("INFLUX1_WIDE");
const RW = env("INFLUX1_RW");
const OPERATOR = env("INFLUX2_OPERATOR");
const RO = env("INFLUX2_RO");
const RWHOME = env("INFLUX2_RWHOME");

/** Every credential value and its forms, none of which a printed line or a capture may hold. */
const SECRETS: readonly string[] = [ADMIN, READER, WIDE, RW].flatMap((pair) => [
  pair.slice(pair.indexOf(":") + 1),
  Buffer.from(pair).toString("base64"),
]);
const ALL_SECRETS = [...SECRETS, OPERATOR, RO, RWHOME];

/** The tool as MCP registers it, and the same tool with its statement fence removed: the boundary under test. */
const RUN_INFLUXQL_READ = mcpStatementArm("run_influxql_read");
const UNFENCED: McpStatementArm = { ...RUN_INFLUXQL_READ, fence: () => null };
const ENGINES = RUN_INFLUXQL_READ.engines;
const NOT_SENT = "The statement was refused before it reached the database";

function seed(name: string, url: string, user: string, password: string, database = "home"): ManagedConnection {
  const { hostname, port } = new URL(url);
  return {
    id: `seed:live-${name}`,
    name,
    seedId: `live-${name}`,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "influxdb",
    host: hostname,
    port: Number(port),
    user,
    password,
    database,
    createdAt: new Date(),
  } as ManagedConnection;
}

const basic = (pair: string) => {
  const at = pair.indexOf(":");
  return { user: pair.slice(0, at), password: pair.slice(at + 1) };
};
const v1 = (name: string, pair: string, database?: string) =>
  seed(name, URL1, basic(pair).user, basic(pair).password, database);
const v2 = (name: string, token: string) => seed(name, URL2, "", token);

const READER_SEED = v1("reader", READER);
const RO_SEED = v2("ro", RO);

let failures = 0;
function check(ok: boolean, line: string): void {
  if (ALL_SECRETS.some((secret) => line.includes(secret))) {
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
  args: Partial<McpStatementInput> & { readonly statement: string },
  arm: McpStatementArm = RUN_INFLUXQL_READ,
  signal: AbortSignal = new AbortController().signal,
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
  const result = await runStatement(arm, input, { context, signal });
  return { result, acquired };
}

const textOf = (result: ToolResult): string =>
  result.content.map((part) => ("text" in part ? part.text : "")).join(" ");

/** The last block of an answer: the sentence after the untrusted-data notice, when there is one. */
const lastOf = (result: ToolResult): string =>
  result.content.map((part) => ("text" in part ? part.text : "")).at(-1) ?? "";

const rowsOf = (result: ToolResult): Record<string, unknown>[] | null => {
  const content = (result as { structuredContent?: { rows?: Record<string, unknown>[] } }).structuredContent;
  return result.isError === true || content?.rows === undefined ? null : content.rows;
};

/** A statement sent raw over the v1 `/query` route, past every check of Studio's. */
async function raw(
  url: string,
  authorization: string | undefined,
  q: string,
  db: string | undefined = "home",
): Promise<{ readonly status: number; readonly text: string }> {
  const form = new URLSearchParams({ q, ...(db === undefined ? {} : { db }) });
  const response = await fetch(`${url}/query`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(authorization === undefined ? {} : { authorization }),
    },
    body: form.toString(),
    signal: AbortSignal.timeout(60_000),
  });
  return { status: response.status, text: await response.text() };
}

const asBasic = (pair: string) => `Basic ${Buffer.from(pair).toString("base64")}`;
const asAdmin = (q: string, db?: string) => raw(URL1, asBasic(ADMIN), q, db);
const asReader = (q: string) => raw(URL1, asBasic(READER), q);

/** Whether a raw answer ran with no error anywhere. */
function ran(answer: { readonly status: number; readonly text: string }): boolean {
  if (answer.status !== 200) return false;
  return !answer.text.includes('"error"');
}

/** The columns of every series a raw answer carries. */
function seriesColumns(text: string): string[][] {
  const columns: string[][] = [];
  for (const line of text.split("\n").filter((entry) => entry.trim() !== "")) {
    try {
      const document = JSON.parse(line) as { results?: { series?: { columns: string[] }[] }[] };
      for (const result of document.results ?? [])
        for (const series of result.series ?? []) columns.push(series.columns);
    } catch {
      // Not JSON: an error page; it carries no series.
    }
  }
  return columns;
}

const carriesStatementText = (text: string) =>
  seriesColumns(text).some((columns) => columns[0] !== "time" && columns.includes("query"));

/** The first error a raw answer words, or null. */
function errorOf(text: string): string | null {
  const match = /"error":"((?:[^"\\]|\\.)*)"/.exec(text);
  return match === null ? null : JSON.parse(`"${match[1]}"`);
}

/** A hash of everything a write could change on the 1.13.1 server. */
async function stateHash(): Promise<string> {
  // The server's own _internal database appears once its monitor first writes, so the listing is hashed without it.
  const listing = JSON.parse((await asAdmin("SHOW DATABASES")).text) as {
    results: { series: { values: string[][] }[] }[];
  };
  const names = listing.results[0].series[0].values.map(([name]) => name).filter((name) => name !== "_internal");
  const hash = createHash("sha256").update(`databases ${names.join(",")}`);
  for (const [q, db] of [
    ["SHOW USERS", undefined],
    ["SHOW GRANTS FOR reader", undefined],
    ["SHOW GRANTS FOR rw", undefined],
    ["SHOW CONTINUOUS QUERIES", undefined],
    ["SHOW MEASUREMENTS", "home"],
    ["SHOW MEASUREMENTS", "other"],
    ["SELECT count(*) FROM home", "home"],
    ["SELECT count(*) FROM m", "other"],
    ["SHOW RETENTION POLICIES", "home"],
  ] as const) {
    hash.update((await asAdmin(q, db)).text);
  }
  return hash.digest("hex");
}

/**
 * The heavy read the timeout and the cancel checks run, written as the admin's SHOW QUERIES lists it (the server
 * writes a duration in its largest whole unit): 200 million one millisecond buckets, about fifteen seconds read
 * chunked on the run.sh server, in under 100 MiB since LIMIT 1 keeps one row.
 */
const SLOW = "SELECT count(v) FROM big WHERE time >= 1600000000s AND time < 444500h GROUP BY time(1ms) LIMIT 1";

/** Whether the admin's SHOW QUERIES lists `statement` running, read from the parsed answer's query column. */
async function running(statement: string): Promise<boolean> {
  const answer = await asAdmin("SHOW QUERIES");
  const document = JSON.parse(answer.text) as {
    results: { series?: { columns: string[]; values: unknown[][] }[] }[];
  };
  const series = document.results[0]?.series?.[0];
  if (series === undefined) return false;
  const column = series.columns.indexOf("query");
  return series.values.some((row) => row[column] === statement);
}

/** Milliseconds until `statement` leaves the admin's SHOW QUERIES, polled every 100 ms, at most 40 s. */
async function msUntilGone(statement: string): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < 40_000) {
    if (!(await running(statement))) return Date.now() - start;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return -1;
}

/** Writes `value` as a capture, refusing one that holds a credential. */
function capture(version: keyof typeof IMAGES, name: string, value: object): void {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (ALL_SECRETS.some((secret) => text.includes(secret))) {
    check(false, `capture ${version}/${name} would carry a credential, and is not written`);
    return;
  }
  const dir = path.join(ROOT, "tests/fixtures/influxdb", version, "mcp-boundary");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${name}.json`), text);
}

async function opens(): Promise<void> {
  const served = await mcp(READER_SEED, { statement: "SHOW MEASUREMENTS" });
  check(
    JSON.stringify(rowsOf(served.result)) === '[{"name":"big"},{"name":"home"}]' &&
      served.acquired.join() === "agent-read-only",
    `open: the 1.13.1 READ user is served under agent-read-only -> ${JSON.stringify(rowsOf(served.result))}`,
  );
  const ro = await mcp(RO_SEED, { statement: "SHOW MEASUREMENTS" });
  check(
    JSON.stringify(rowsOf(ro.result)) === '[{"name":"home"}]',
    `open: the 2.9.1 token reading bucket home is served -> ${JSON.stringify(rowsOf(ro.result))}`,
  );
  const refusals: readonly (readonly [string, ManagedConnection, string])[] = [
    ["the 1.13.1 admin", v1("admin", ADMIN), "needs a principal that is not an administrator"],
    ["the 1.13.1 user that writes other", v1("rw", RW), 'can write the database "other"'],
    ["a 1.13.1 server with authentication off", seed("noauth", URL1_NOAUTH, "", ""), "its authentication is off"],
    ["the 2.9.1 operator token", v2("operator", OPERATOR), "system buckets"],
    ["the 2.9.1 token that writes home", v2("rwhome", RWHOME), 'can write the database "home"'],
  ];
  for (const [who, connection, says] of refusals) {
    const { result } = await mcp(connection, { statement: "SHOW MEASUREMENTS" });
    const text = textOf(result);
    check(
      result.isError === true &&
        text.startsWith("run_influxql_read cannot run on this connection: The agent read-only profile") &&
        text.includes(says) &&
        text.endsWith(`It runs on ${ENGINES}.`),
      `open: ${who} is refused through MCP -> ${text.slice(0, 160)}`,
    );
  }
}

/** Write-shaped statements, each refused before it is sent and, sent raw as the READ user, by the server. */
const WRITES: readonly string[] = [
  'SELECT * INTO "other".."libredb_lm" FROM home',
  'SELECT * INTO "home".."libredb_lm" FROM home',
  'SELECT * INTO "other".."libredb_lm" FROM (SELECT * FROM home)',
  "DELETE FROM home WHERE time < 0",
  "DROP MEASUREMENT home",
  "DROP SERIES FROM home",
  "DROP DATABASE other",
  "CREATE DATABASE libredb_lm",
  "CREATE RETENTION POLICY libredb_lm ON home DURATION 1h REPLICATION 1",
  'CREATE CONTINUOUS QUERY libredb_lm ON home BEGIN SELECT mean(temp) INTO "other".."lm" FROM home GROUP BY time(1h) END',
  "CREATE USER libredb_lm WITH PASSWORD 'not-a-real-password'",
  "GRANT ALL TO reader",
  "KILL QUERY 1",
  "SHOW MEASUREMENTS; DROP MEASUREMENT home",
];

async function boundary(): Promise<void> {
  const before = await stateHash();
  for (const statement of WRITES) {
    const fenced = await mcp(READER_SEED, { statement });
    check(
      fenced.result.isError === true && fenced.acquired.length === 0 && textOf(fenced.result).startsWith(NOT_SENT),
      `boundary: the MCP fence refuses ${statement} before anything is acquired`,
    );
    const unfenced = await mcp(READER_SEED, { statement }, UNFENCED);
    check(
      unfenced.result.isError === true &&
        unfenced.acquired.join() === "agent-read-only" &&
        textOf(unfenced.result).startsWith(NOT_SENT),
      `boundary: fence removed, the provider's reader refuses ${statement} unsent -> ${textOf(unfenced.result).slice(0, 100)}`,
    );
    const answer = await asReader(statement);
    check(
      !ran(answer),
      `boundary: sent raw as the READ user, the server refuses ${statement} -> ${answer.status} ${errorOf(answer.text)}`,
    );
  }
  const after = await stateHash();
  check(before === after, `boundary: the state hash is the same before and after -> ${before} / ${after}`);

  // The positive control: the user that also writes other runs the same INTO there, which the proof refuses it for.
  try {
    const written = await raw(URL1, asBasic(RW), 'SELECT * INTO "other".."libredb_lm" FROM home');
    check(
      ran(written) && written.text.includes('"written"'),
      `control: the user granted WRITE on other runs SELECT ... INTO there -> ${written.status} ${written.text.slice(0, 90)}`,
    );
  } finally {
    await asAdmin('DROP MEASUREMENT "libredb_lm"', "other");
  }
}

async function statementText(): Promise<void> {
  // An admin's heavy read runs while the READ user asks, so SHOW QUERIES has another principal's statement to show.
  const heavy = asAdmin(SLOW, "home").catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const entries: { statement: string; status: number; statementText: boolean; error: string | null }[] = [];
  const carried: string[] = [];
  for (const statement of INFLUXQL_QUERY_TEXT_SPELLINGS) {
    const fenced = await mcp(READER_SEED, { statement });
    check(
      fenced.result.isError === true && fenced.acquired.length === 0 && textOf(fenced.result).startsWith(NOT_SENT),
      `statement text: the MCP fence refuses ${JSON.stringify(statement)} before anything is acquired`,
    );
    const unfenced = await mcp(READER_SEED, { statement }, UNFENCED);
    check(
      unfenced.result.isError === true && textOf(unfenced.result).startsWith(NOT_SENT),
      `statement text: fence removed, the provider's reader refuses ${JSON.stringify(statement)} unsent`,
    );
    check(!readInfluxqlAgentStatement(statement).ok, `statement text: the reader refuses ${JSON.stringify(statement)}`);
    const answer = await asReader(statement);
    const holds = carriesStatementText(answer.text);
    if (holds) carried.push(answer.text);
    entries.push({ statement, status: answer.status, statementText: holds, error: errorOf(answer.text) });
  }
  await heavy;
  capture("1.13.1", "query-text-spellings", {
    version: "1.13.1",
    image: IMAGES["1.13.1"],
    capturedAt: new Date().toISOString().slice(0, 10),
    principal: "reader: READ on home, while the admin runs a heavy read",
    entries,
  });
  check(carried.length > 0, `statement text: sent raw, ${carried.length} spellings were answered with statement text`);
  for (const text of carried) {
    let refused: Error | undefined;
    try {
      shapeInfluxqlAgentAnswer(
        text,
        { statementTimeoutMs: 5_000, maxResultRows: 1_000, maxResultBytes: 1 << 20 },
        [],
        "SELECT 1",
      );
    } catch (error) {
      refused = error as Error;
    }
    // A second statement's answer is refused by the shaper as more than one statement, before the columns are read.
    const secondStatement = refused instanceof InfluxAnswerShapeError && refused.fault === "lexer-disagreement";
    check(
      refused?.message === INFLUXQL_AGENT_QUERY_TEXT_SENTENCE || secondStatement,
      `statement text: the provider refuses a live answer that carried statement text -> ${secondStatement ? "as a second statement" : refused?.message}`,
    );
  }
  const two: { statement: string; status: number; statementText: boolean; error: string | null }[] = [];
  for (const statement of INFLUXQL_QUERY_TEXT_SPELLINGS) {
    const answer = await raw(URL2, `Token ${RO}`, statement);
    two.push({
      statement,
      status: answer.status,
      statementText: carriesStatementText(answer.text),
      error: errorOf(answer.text) ?? (answer.status === 200 ? null : answer.text.slice(0, 200)),
    });
  }
  capture("2.9.1", "query-text-spellings", {
    version: "2.9.1",
    image: IMAGES["2.9.1"],
    capturedAt: new Date().toISOString().slice(0, 10),
    principal: "ro: read on bucket home",
    entries: two,
  });
  check(
    two.every((entry) => !entry.statementText),
    "statement text: 2.9.1 answers no spelling with statement text",
  );
}

async function dataScope(): Promise<void> {
  const listed = await mcp(READER_SEED, { statement: "SHOW DATABASES" });
  check(
    JSON.stringify(rowsOf(listed.result)) === '[{"name":"home"}]',
    `scope: the READ user lists only its database -> ${JSON.stringify(rowsOf(listed.result))}`,
  );
  for (const statement of ['SELECT * FROM "other".."m"', 'SELECT * FROM "_internal".."runtime" LIMIT 1']) {
    const { result } = await mcp(READER_SEED, { statement });
    check(
      result.isError === true && lastOf(result).includes("This user cannot read database"),
      `scope: the server refuses the READ user ${statement} -> ${lastOf(result)}`,
    );
  }
  const wide = v1("wide", WIDE);
  const other = await mcp(wide, { statement: 'SELECT * FROM "other".."m"' });
  check(
    rowsOf(other.result)?.length === 1,
    `scope: the user granted READ on other reads it by its full name -> ${JSON.stringify(rowsOf(other.result))}`,
  );
  const ro = await mcp(RO_SEED, { statement: 'SELECT * FROM "other".."m"' });
  check(ro.result.isError === true, `scope: the 2.9.1 token reading home is refused other -> ${lastOf(ro.result)}`);
}

async function formsAndLimits(): Promise<void> {
  for (const statement of [
    "SELECT temp FROM home WHERE time > 0 LIMIT 5",
    "SHOW DATABASES",
    "SHOW RETENTION POLICIES",
    "SHOW MEASUREMENTS",
    "SHOW SERIES FROM home",
    "SHOW TAG KEYS FROM home",
    'SHOW TAG VALUES FROM home WITH KEY = "room"',
    "SHOW FIELD KEYS FROM home",
    "SHOW SERIES CARDINALITY",
    "EXPLAIN SELECT temp FROM home WHERE time > 0",
  ]) {
    const { result } = await mcp(READER_SEED, { statement });
    check(
      result.isError !== true,
      `forms: ${statement} answers -> ${(result as { structuredContent?: { row_count?: number } }).structuredContent?.row_count} rows`,
    );
  }
  const rows = await mcp(READER_SEED, { statement: "SELECT v FROM big WHERE time > 0 LIMIT 1500" });
  check(
    textOf(rows.result).startsWith("The result has more than 1000 rows"),
    `limits: rows past the provider budget -> ${textOf(rows.result)}`,
  );
  const cut = await mcp(READER_SEED, { statement: "SELECT v FROM big WHERE time > 0 LIMIT 300", max_rows: 100 });
  const hint = (cut.result as { structuredContent?: { hint?: string; truncated?: boolean } }).structuredContent;
  check(
    hint?.truncated === true && hint.hint?.includes("add OFFSET 100 to the statement") === true,
    `limits: a read cut at max_rows says to page inside the statement -> ${hint?.hint}`,
  );

  // Each run is sampled while it waits, so a statement that never started is not read as one the server stopped.
  const sample = (afterMs: number) =>
    new Promise<boolean>((resolve) => setTimeout(() => resolve(running(SLOW)), afterMs));
  const timedStart = Date.now();
  const timedSeen = sample(350);
  const timed = await mcp(READER_SEED, { statement: SLOW, timeout_ms: 500 });
  const timedAnswered = Date.now() - timedStart;
  const timedRanOn = await msUntilGone(SLOW);
  check(
    textOf(timed.result) ===
      "The statement did not finish within timeout_ms (500 ms). Narrow it, or raise timeout_ms up to 30000." &&
      (await timedSeen) &&
      timedRanOn >= 0 &&
      timedRanOn < 2_000,
    `limits: past the minimum timeout_ms, answered in ${timedAnswered} ms; running before it, the statement left the server ${timedRanOn} ms after`,
  );

  // A client close stops MCP waiting, not the statement: the provider's request runs on to its own deadline, the time
  // left of timeout_ms, and dropping it there is what ends the statement on the server.
  const cancelTimeout = 8_000;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1_000);
  const cancelStart = Date.now();
  const cancelSeen = sample(700);
  const cancelled = await mcp(
    READER_SEED,
    { statement: SLOW, timeout_ms: cancelTimeout },
    RUN_INFLUXQL_READ,
    controller.signal,
  );
  const cancelAnswered = Date.now() - cancelStart;
  const runningAfterCancel = await running(SLOW);
  const cancelRanOn = await msUntilGone(SLOW);
  check(
    textOf(cancelled.result) === MCP_CANCELLED_TEXT &&
      (await cancelSeen) &&
      cancelAnswered < 2_500 &&
      runningAfterCancel &&
      cancelRanOn >= 0 &&
      Math.abs(cancelAnswered + cancelRanOn - cancelTimeout) < 1_500,
    `limits: a client close, answered in ${cancelAnswered} ms; the statement ran on and left the server ${cancelRanOn} ms later, at the time left of timeout_ms (${cancelTimeout} ms)`,
  );
  const next = await mcp(READER_SEED, { statement: "SHOW MEASUREMENTS" });
  check(next.result.isError !== true, "limits: the server answers the next call");
}

async function main(): Promise<void> {
  await opens();
  await boundary();
  await statementText();
  await dataScope();
  await formsAndLimits();
}

try {
  await main();
} finally {
  await clearProviderCache();
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
