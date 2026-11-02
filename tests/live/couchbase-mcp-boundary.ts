/**
 * Live check of MCP's `run_read_query` on Couchbase, against a cluster of the operator's choosing.
 *
 * WHY THIS EXISTS. `run_read_query` serves Couchbase through the same boundary agent mode does: the connection is
 * acquired under the agent read-only profile, whose open checks the user (`agent-boundary.ts`), and every statement goes
 * through the provider's `queryReadOnly`, which checks the user again and sends one SELECT. The MCP fence in front of it
 * is defence in depth. So this script replays the agent boundary check through the MCP tool's own handler
 * (`runStatement`) with that fence removed, against a real server:
 *
 *  - the open, through MCP: a user holding only query_select on a named scope is served; the administrator, a
 *    read-only administrator, query_select on every scope or every bucket, query_system_catalog, data_writer, a role
 *    held through a group and a user holding no role are each refused before any statement runs, in the MCP refusal
 *    sentence;
 *  - the boundary, with the MCP fence bypassed: each write, DDL, transaction, PREPARE, EXECUTE, UPDATE STATISTICS,
 *    ADVISE, INFER, EXPLAIN, GRANT, second statement and carriage-return text is refused by the provider's fence before
 *    it is sent, and the same text sent raw as the user is refused by the server for a missing role (13014), except
 *    the five the server runs for such a user, which is why the fence exists; with the MCP fence in place, each one
 *    that is not a SELECT is refused before anything is acquired;
 *  - the data scope: a SELECT of another bucket, of a scope the user holds no role on, of the bucket's `_system` scope
 *    and of each system keyspace that holds other users, their requests, prepared statements, roles, the optimizer's
 *    dictionary, the cluster's nodes, vitals or bucket settings, in each spelling (backticks, namespace, relative to
 *    the query context, a subquery, a join, `USE KEYS`, mixed case, a comment), passes the MCP fence and is refused by
 *    the server in its own words (13014 naming the missing role, or the keyspace not found for a spelling that names
 *    none); `CURL()`, `NEXTVAL`, `ADVISOR()`'s session forms and each user-defined function call likewise; `ADVISOR()`
 *    given one statement recommends indexes on the user's own keyspace and answers another's with the missing-role
 *    message in its row; a bucket, scope or collection that does not exist is answered as not found, one that exists as
 *    a missing role; the system keyspaces the user may read answer only its own user, its own bucket and the keyspaces
 *    it holds a role on;
 *  - the state: the documents of every bucket and scope, the users, functions, scopes and indexes read the same before
 *    and after; the administrator runs the writes, the positive control;
 *  - the forms, paging and limits: a SELECT and a WITH answer; a read past max_rows names the next offset and that
 *    offset answers the next rows; an offset on a query with its own LIMIT is refused before anything is sent; a read
 *    past the 1000-row provider budget and one past the 1 MiB budget are refused, never cut;
 *  - the cancel and the timeout: a read past `timeout_ms` is answered as the timeout, and the query service holds the
 *    statement no longer; a read whose client closes the call is answered as the cancel, the statement runs on until
 *    the provider closes its request at the time left of `timeout_ms`, and the query service holds it no longer then.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it against a Couchbase Server 8.0
 * Enterprise node set up as for `tests/live/couchbase-agent-boundary.ts` (`tests/fixtures/couchbase/8.0.2/agent-boundary/
 * run.sh`): a bucket with a primary index on its default collection and a scope `s1` holding a collection `c1`, and a
 * second bucket, as the administrator:
 *
 *   LIBREDB_LIVE_COUCHBASE_HOST=<node> LIBREDB_LIVE_COUCHBASE_USER=Administrator \
 *     LIBREDB_LIVE_COUCHBASE_PASSWORD=<its password> LIBREDB_LIVE_COUCHBASE_BUCKET=probe \
 *     LIBREDB_LIVE_COUCHBASE_OTHER_BUCKET=other bun tests/live/couchbase-mcp-boundary.ts
 *
 * Every user, group and document it creates carries the `libredb_lm_` prefix and is removed on exit. Each check prints
 * one line, and a line that would carry a password fails instead of printing it; any failure ends the run non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import { createHash, randomBytes } from "node:crypto";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import type { McpConnectionContext } from "@/lib/mcp/context";
import type { ToolResult } from "@/lib/mcp/output";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm, type McpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";

const PREFIX = "libredb_lm_";
/** One password for every seeded user, made for the run, never printed. */
const PASSWORD = randomBytes(12).toString("hex");

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`set ${name}: this script writes to the cluster it is pointed at, so it has no default`);
    process.exit(2);
  }
  return value;
}

const HOST = env("LIBREDB_LIVE_COUCHBASE_HOST");
const ADMIN = { user: env("LIBREDB_LIVE_COUCHBASE_USER"), password: env("LIBREDB_LIVE_COUCHBASE_PASSWORD") };
const BUCKET = env("LIBREDB_LIVE_COUCHBASE_BUCKET");
const OTHER = env("LIBREDB_LIVE_COUCHBASE_OTHER_BUCKET");
const CONTEXT = `default:\`${BUCKET}\``;
const SCOPE = `\`${BUCKET}\`.\`_default\``;
const ENGINES =
  "It runs on PostgreSQL, SQLite, DuckDB, SQL Server, MySQL, ClickHouse, libSQL, InfluxDB 3 (SQL), Elasticsearch, OpenSearch, Oracle, Db2 LUW, Apache Cassandra and Couchbase.";

/** The tool as MCP registers it, and the same tool with its statement fence removed: the boundary under test. */
const RUN_READ_QUERY = mcpStatementArm("run_read_query");
const UNFENCED: McpStatementArm = { ...RUN_READ_QUERY, fence: () => null };

let failures = 0;
function check(ok: boolean, line: string): void {
  // A line never carries a password: one that would fails instead of printing it.
  if (line.includes(PASSWORD) || line.includes(ADMIN.password)) {
    console.log("FAIL a check line would carry a password, so it is not printed");
    failures++;
    return;
  }
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

/** A management request as the administrator; fails the run on any answer but 2xx. */
async function manage(method: string, path: string, form?: Record<string, string>): Promise<void> {
  const response = await fetch(`http://${HOST}:8091${path}`, {
    method,
    headers: {
      authorization: basic(ADMIN.user, ADMIN.password),
      ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  await response.text();
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}`);
}

interface Answer {
  code: number | null;
  message: string;
  /** The role the server names as missing, read from the error or from its cause: a function call's refusal is 5010. */
  missingRole: string | null;
  rows: unknown[];
  mutations: number;
}

/** `statement` on the query service as `user`, on a request of its own, with readonly off: no Studio code between. */
async function raw(user: string, password: string, statement: string): Promise<Answer> {
  const response = await fetch(`http://${HOST}:8093/query/service`, {
    method: "POST",
    headers: { authorization: basic(user, password), "content-type": "application/json" },
    body: JSON.stringify({ statement, query_context: CONTEXT, scan_consistency: "request_plus", readonly: false }),
  });
  const payload = (await response.json()) as {
    results?: unknown[];
    errors?: { code: number; msg: string; reason?: { missing_role?: string; cause?: { missing_role?: string } } }[];
    metrics?: { mutationCount?: number };
  };
  const error = payload.errors?.[0];
  return {
    code: error?.code ?? null,
    message: error?.msg ?? "",
    missingRole: error?.reason?.missing_role ?? error?.reason?.cause?.missing_role ?? null,
    rows: payload.results ?? [],
    mutations: payload.metrics?.mutationCount ?? 0,
  };
}

const asAdmin = (statement: string) => raw(ADMIN.user, ADMIN.password, statement);

async function setUser(name: string, roles: string, groups = ""): Promise<void> {
  await manage("PUT", `/settings/rbac/users/local/${name}`, {
    password: PASSWORD,
    roles,
    ...(groups === "" ? {} : { groups }),
  });
}

function seed(user: string, password = PASSWORD): ManagedConnection {
  return {
    id: `seed:live-${user}`,
    name: user,
    seedId: `live-${user}`,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "couchbase",
    host: HOST,
    port: 8091,
    user,
    password,
    database: BUCKET,
    createdAt: new Date(),
  } as ManagedConnection;
}

/** One MCP call on `connection`, through the factory's own profiled acquisition, as the route makes it. */
async function mcp(
  connection: ManagedConnection,
  args: Partial<McpStatementInput> & { readonly sql: string },
  arm: McpStatementArm = UNFENCED,
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

/** The last text block of an MCP answer: the database's own words, behind the tool's prefix, or Studio's. */
const lastText = (result: ToolResult): string =>
  result.content.map((part) => ("text" in part ? part.text : "")).at(-1) ?? "";

const ENGINE_PREFIX = "The database refused or failed the call: ";
const NOT_SENT = "The statement was refused before it reached the database: ";
const FENCE =
  "The agent read-only execution profile sends one SQL++ statement, a SELECT (a WITH before it is fine), and nothing else";

const AGENT = `${PREFIX}ro`;

/** Each user the open refuses through MCP, with its roles, an optional group, and the role its refusal must name. */
const REFUSED: readonly (readonly [string, string, string, string])[] = [
  ["bucketwide", `query_select[${BUCKET}]`, "", `query_select[${BUCKET}:*:*]`],
  [
    "system",
    `query_select[${BUCKET}:_default],query_select[${BUCKET}:_system]`,
    "",
    `query_select[${BUCKET}:_system:*]`,
  ],
  ["all", "query_select[*]", "", "query_select[*:*:*]"],
  ["two", `query_select[${BUCKET}:_default],query_select[${OTHER}]`, "", `query_select[${OTHER}:*:*]`],
  ["catalog", `query_select[${BUCKET}:_default],query_system_catalog`, "", "query_system_catalog"],
  ["writer", `query_select[${BUCKET}:_default],data_writer[${BUCKET}]`, "", `data_writer[${BUCKET}:*:*]`],
  ["roadmin", "ro_admin", "", "ro_admin"],
  ["grouped", `query_select[${BUCKET}:_default]`, `${PREFIX}writers`, `data_writer[${BUCKET}:*:*]`],
];

/** Statements the provider's fence refuses before sending, and what the server answers the admitted user for each. */
const FENCED: readonly (readonly [string, "refused" | "runs"])[] = [
  [`INSERT INTO \`_default\` (KEY, VALUE) VALUES ("${PREFIX}w", {"by": "mcp"})`, "refused"],
  [`UPSERT INTO \`_default\` (KEY, VALUE) VALUES ("${PREFIX}seed", {"n": -1})`, "refused"],
  [`UPDATE \`_default\` SET n = -1 WHERE META().id = "${PREFIX}seed"`, "refused"],
  [`DELETE FROM \`_default\` WHERE META().id = "${PREFIX}seed"`, "refused"],
  [
    `MERGE INTO \`_default\` AS t USING [{"id": "${PREFIX}seed"}] AS s ON META(t).id = s.id WHEN MATCHED THEN UPDATE SET t.n = -1`,
    "refused",
  ],
  [`CREATE INDEX ${PREFIX}ix ON \`_default\`(n)`, "refused"],
  [`CREATE SCOPE \`${BUCKET}\`.\`${PREFIX}scope\``, "refused"],
  [`GRANT query_update ON \`_default\` TO ${AGENT}`, "refused"],
  ["UPDATE STATISTICS FOR `_default` INDEX ALL", "runs"],
  ["BEGIN WORK", "runs"],
  [`PREPARE ${PREFIX}p FROM SELECT 1 AS a`, "runs"],
  [`EXECUTE ${PREFIX}admin_p`, "runs"],
  ["ADVISE SELECT * FROM `_default` WHERE n = 1", "runs"],
];

/** Statements the provider's fence refuses whatever the server would answer: a form no read needs. */
const FENCED_FORMS: readonly string[] = [
  "INFER `_default`",
  "EXPLAIN SELECT d.n FROM `_default` AS d",
  "SELECT 1 AS a; DELETE FROM `_default`",
  `-- x\rDELETE FROM \`_default\` USE KEYS "${PREFIX}cr"`,
];

/**
 * SELECTs past the user's role: another bucket, a scope it holds no role on, the bucket's `_system` scope, and the
 * system keyspaces that hold other users, their work, the optimizer's dictionary or the cluster's settings, each in the
 * spellings SQL++ takes. The MCP fence admits each, and the server refuses each in its own words.
 */
const OUT_OF_SCOPE: readonly string[] = [
  `SELECT d.* FROM default:\`${OTHER}\` AS d`,
  `SELECT d.* FROM \`default\`:\`${OTHER}\` AS d`,
  `SELECT d.* FROM \`${OTHER}\`.\`_default\`.\`_default\` AS d`,
  `SELECT d.* FROM default:\`${OTHER}\` /* a comment */ AS d USE KEYS ["o1"]`,
  `SELECT (SELECT RAW o.n FROM default:\`${OTHER}\` AS o USE KEYS "o1") AS x`,
  `SELECT d.n AS mine, o.n AS theirs FROM \`_default\` AS d JOIN default:\`${OTHER}\` AS o ON KEYS "o1"`,
  `SELECT d.* FROM ${OTHER} AS d`,
  "SELECT c.* FROM s1.c1 AS c",
  'SELECT c.* FROM `s1`.`c1` AS c USE KEYS "c1"',
  `SELECT c.* FROM \`default\`:\`${BUCKET}\`.\`s1\`.\`c1\` AS c`,
  "SELECT META(q).id FROM `_system`.`_query` AS q LIMIT 1",
  `SELECT m.* FROM \`${BUCKET}\`.\`_system\`.\`_mobile\` AS m USE KEYS "_sync:user:alice"`,
  "SELECT * FROM system:user_info",
  "SELECT * FROM `system`:`user_info`",
  "SELECT * FROM SYSTEM:USER_INFO",
  "SELECT * FROM system:group_info",
  "SELECT * FROM system:applicable_roles",
  "SELECT * FROM system:active_requests",
  "SELECT * FROM system:completed_requests",
  "SELECT * FROM system:completed_requests_history",
  "SELECT * FROM System:Completed_Requests",
  "SELECT * FROM system:prepareds",
  "SELECT * FROM system:functions_cache",
  "SELECT * FROM system:dictionary",
  "SELECT * FROM system:dictionary_cache",
  "SELECT * FROM system:tasks_cache",
  "SELECT * FROM system:transactions",
  "SELECT * FROM system:nodes",
  "SELECT * FROM system:vitals",
  "SELECT * FROM system:bucket_info",
  "SELECT * FROM system:database_info",
  "SELECT * FROM system:aus",
  "SELECT * FROM system:aus_settings",
  "SELECT * FROM system:awr",
  'SELECT CURL("http://127.0.0.1:8091/settings/rbac/users") AS v',
  'SELECT ADVISOR({"action": "start", "duration": "1m"}) AS v',
  'SELECT ADVISOR({"action": "get"}) AS v',
  'SELECT ADVISOR({"action": "list"}) AS v',
  `SELECT NEXTVAL FOR ${SCOPE}.${PREFIX}seq AS v`,
];

/**
 * Calls of user-defined functions, inline and JavaScript, scoped and global: the server refuses each with 5010, whose
 * message reads "Error evaluating projection" and whose cause names the missing role, which the raw answer shows.
 */
const FUNCTION_CALLS: readonly string[] = [
  `SELECT default:${SCOPE}.${PREFIX}inline(1) AS v`,
  `SELECT default:${SCOPE}.${PREFIX}js(1) AS v`,
  `SELECT default:${SCOPE}.${PREFIX}jsw() AS v`,
  `SELECT default:${PREFIX}global(1) AS v`,
];

/** The server's own refusal of a read past the role, or of a spelling that names no keyspace the user may read. */
const SERVER_WORDS =
  /^(User does not have credentials to (run|use) .+\. Add role \S+( on \S+)? to allow the statement to run\.|Keyspace not found .+|Unable to run subquery - cause: Keyspace not found .+)$/;

async function seedServer(): Promise<void> {
  await manage("PUT", `/settings/rbac/groups/${PREFIX}writers`, { roles: `data_writer[${BUCKET}]` });
  await setUser(AGENT, `query_select[${BUCKET}:_default]`);
  await setUser(`${PREFIX}none`, "");
  for (const [name, roles, groups] of REFUSED) await setUser(`${PREFIX}${name}`, roles, groups);
  await asAdmin(`UPSERT INTO \`_default\` (KEY, VALUE) VALUES ("${PREFIX}seed", {"n": 1}), ("${PREFIX}cr", {"n": 2})`);
  await asAdmin(`PREPARE ${PREFIX}admin_p FROM SELECT "${PREFIX}admin-prepared" AS m`);
  await asAdmin(`CREATE OR REPLACE FUNCTION default:${SCOPE}.${PREFIX}inline(x) { x + 1 }`);
  await asAdmin(`CREATE OR REPLACE FUNCTION default:${PREFIX}global(x) { x * 2 }`);
  await asAdmin(
    `CREATE OR REPLACE FUNCTION default:${SCOPE}.${PREFIX}js(x) LANGUAGE JAVASCRIPT AS "function ${PREFIX}js(x) { return x + 1; }"`,
  );
  await asAdmin(
    `CREATE OR REPLACE FUNCTION default:${SCOPE}.${PREFIX}jsw() LANGUAGE JAVASCRIPT AS "function ${PREFIX}jsw() { var r = INSERT INTO \`_default\` (KEY, VALUE) VALUES ('${PREFIX}js', {}); r.close(); return 1; }"`,
  );
  await asAdmin(`CREATE SEQUENCE IF NOT EXISTS ${SCOPE}.${PREFIX}seq`);
  // The query service takes a moment to see a new user.
  await new Promise((resolve) => setTimeout(resolve, 2000));
}

async function cleanUp(): Promise<void> {
  const quiet = async (work: () => Promise<unknown>) => {
    await work().catch(() => {});
  };
  for (const name of ["ro", "none", ...REFUSED.map(([user]) => user)]) {
    await quiet(() => manage("DELETE", `/settings/rbac/users/local/${PREFIX}${name}`));
  }
  await quiet(() => manage("DELETE", `/settings/rbac/groups/${PREFIX}writers`));
  await quiet(() => asAdmin(`DELETE FROM \`_default\` WHERE META().id LIKE "${PREFIX}%"`));
  await quiet(() => asAdmin(`DROP INDEX ${PREFIX}ix IF EXISTS ON \`_default\``));
  await quiet(() => asAdmin(`DROP SCOPE \`${BUCKET}\`.\`${PREFIX}scope\` IF EXISTS`));
  await quiet(() => asAdmin(`DELETE FROM system:prepareds WHERE name LIKE "%${PREFIX}%"`));
  for (const fn of ["inline", "js", "jsw"]) {
    await quiet(() => asAdmin(`DROP FUNCTION default:${SCOPE}.${PREFIX}${fn} IF EXISTS`));
  }
  await quiet(() => asAdmin(`DROP FUNCTION default:${PREFIX}global IF EXISTS`));
  await quiet(() => asAdmin(`DROP SEQUENCE ${SCOPE}.${PREFIX}seq IF EXISTS`));
}

/** What the administrator reads of every bucket and scope the run could touch, hashed. */
async function stateHash(): Promise<string> {
  const reads = [
    "SELECT META(d).id AS k, d AS v FROM `_default` AS d ORDER BY META(d).id",
    "SELECT META(c).id AS k, c AS v FROM `s1`.`c1` AS c ORDER BY META(c).id",
    `SELECT META(o).id AS k, o AS v FROM default:\`${OTHER}\` AS o ORDER BY META(o).id`,
    "SELECT RAW k.`path` FROM system:all_keyspaces_info AS k ORDER BY k.`path`",
    "SELECT i.`name`, i.`keyspace_id`, i.`scope_id`, i.`bucket_id` FROM system:indexes AS i ORDER BY i.`id`",
    "SELECT RAW f.`identity` FROM system:functions AS f",
    "SELECT u.`id`, u.`roles` FROM system:user_info AS u ORDER BY u.`id`",
  ];
  const hash = createHash("sha256");
  for (const statement of reads) {
    const answer = await asAdmin(statement);
    if (answer.code !== null) throw new Error(`the state read failed (${answer.code}): ${statement}`);
    hash.update(JSON.stringify(answer.rows));
  }
  return hash.digest("hex");
}

/** The statements the query service holds that carry `marker`, as the administrator reads them. */
async function running(marker: string): Promise<number> {
  const answer = await asAdmin(
    `SELECT RAW a.requestId FROM system:active_requests AS a WHERE CONTAINS(a.statement, "${marker}") AND NOT CONTAINS(a.statement, "system:active_requests")`,
  );
  return answer.rows.length;
}

async function opens(): Promise<void> {
  const agent = seed(AGENT);
  const served = await mcp(
    agent,
    { sql: `SELECT META(d).id AS k, d.n FROM \`_default\` AS d WHERE d.n = 1` },
    RUN_READ_QUERY,
  );
  check(
    served.result.isError === undefined &&
      JSON.stringify(served.result.structuredContent?.rows).includes(`"k":"${PREFIX}seed"`) &&
      served.acquired.join() === "agent-read-only",
    `open: ${AGENT}, holding query_select on the _default scope alone, is served under agent-read-only -> ${JSON.stringify(served.result.structuredContent?.rows)}`,
  );
  const refusedOpens = [
    { connection: seed(ADMIN.user, ADMIN.password), label: "the administrator", says: "admin" },
    ...REFUSED.map(([name, , , says]) => ({ connection: seed(`${PREFIX}${name}`), label: name, says })),
  ];
  for (const { connection, label, says } of refusedOpens) {
    const { result, acquired } = await mcp(connection, { sql: "SELECT RAW 1" }, RUN_READ_QUERY);
    const text = textOf(result);
    check(
      result.isError === true &&
        acquired.join() === "agent-read-only" &&
        text.startsWith(
          "run_read_query cannot run on this connection: The agent read-only execution profile needs a Couchbase user whose only roles are query_select on named scopes of the bucket ",
        ) &&
        text.endsWith(ENGINES) &&
        text.includes(` also holds ${says}`),
      `open: ${label} is refused through MCP, naming ${says} -> ${text}`,
    );
  }
  // A user holding no role cannot read /pools/default, so the open fails before the check, as unauthenticated.
  const none = await mcp(seed(`${PREFIX}none`), { sql: "SELECT RAW 1" }, RUN_READ_QUERY);
  check(
    none.result.isError === true &&
      lastText(none.result).startsWith(`${ENGINE_PREFIX}Couchbase rejected the credentials (HTTP 401)`),
    `open: a user holding no role is refused before the check -> ${textOf(none.result)}`,
  );
}

async function boundary(): Promise<void> {
  const agent = seed(AGENT);
  const before = await stateHash();
  for (const [statement, server] of FENCED) {
    const fenced = await mcp(agent, { sql: statement }, RUN_READ_QUERY);
    check(
      fenced.result.isError === true &&
        fenced.acquired.length === 0 &&
        textOf(fenced.result).startsWith(
          "The statement was refused before it reached the database (NON_READ_STATEMENT)",
        ),
      `fence: the MCP fence refuses it before anything is acquired: ${statement}`,
    );
    const { result } = await mcp(agent, { sql: statement });
    check(
      textOf(result).startsWith(`${NOT_SENT}${FENCE}; this statement does not begin with SELECT or WITH`),
      `boundary: bypassed, the provider's fence refuses it before it is sent: ${statement}`,
    );
    const behind = await raw(AGENT, PASSWORD, statement);
    check(
      server === "refused" ? behind.code === 13014 : behind.code === null,
      server === "refused"
        ? `behind the fence: the server refuses it for a missing role (${behind.code}): ${statement}`
        : `behind the fence: the server runs it for the user, so the fence is load-bearing (${behind.code}): ${statement}`,
    );
  }
  for (const statement of FENCED_FORMS) {
    const { result } = await mcp(agent, { sql: statement });
    check(
      textOf(result).startsWith(`${NOT_SENT}${FENCE}; `),
      `boundary: bypassed, the provider's fence refuses ${JSON.stringify(statement)} before it is sent -> ${textOf(result)}`,
    );
  }
  for (const statement of OUT_OF_SCOPE) {
    const { result, acquired } = await mcp(agent, { sql: statement }, RUN_READ_QUERY);
    const last = lastText(result);
    const words = last.startsWith(ENGINE_PREFIX) ? last.slice(ENGINE_PREFIX.length) : "";
    check(
      result.isError === true && acquired.join() === "agent-read-only" && SERVER_WORDS.test(words),
      `scope: the MCP fence admits it and the server refuses it: ${statement} -> ${words}`,
    );
  }
  for (const statement of FUNCTION_CALLS) {
    const { result } = await mcp(agent, { sql: statement }, RUN_READ_QUERY);
    const behind = await raw(AGENT, PASSWORD, statement);
    check(
      lastText(result) === `${ENGINE_PREFIX}Error evaluating projection` &&
        behind.code === 5010 &&
        behind.missingRole !== null,
      `scope: the MCP fence admits a function call and the server refuses it for ${behind.missingRole} (${behind.code}): ${statement}`,
    );
  }
  check(before === (await stateHash()), "state: every bucket, scope, user, function and index reads the same after");

  // The positive controls: the administrator runs the writes the user is refused, on scratch keys.
  const write = await asAdmin(`INSERT INTO \`_default\` (KEY, VALUE) VALUES ("${PREFIX}admin", {"n": 1})`);
  check(write.mutations === 1, "control: the administrator's INSERT writes");
  const carriage = await asAdmin(`-- x\rDELETE FROM \`_default\` USE KEYS "${PREFIX}cr"`);
  check(
    carriage.mutations === 1,
    "control: the server ends a -- comment at a lone carriage return and runs the DELETE after it",
  );
}

async function dataScope(): Promise<void> {
  const agent = seed(AGENT);
  const rowsOf = async (sql: string) => {
    const { result } = await mcp(agent, { sql }, RUN_READ_QUERY);
    return (result.structuredContent?.rows ?? null) as Record<string, unknown>[] | null;
  };
  const me = await rowsOf("SELECT u.`id`, u.`roles` FROM system:my_user_info AS u");
  check(
    me?.length === 1 && me[0]?.id === AGENT,
    `scope: system:my_user_info answers the user's own entry alone -> ${me?.map((row) => row.id).join()}`,
  );
  const keyspaces = ((await rowsOf("SELECT k.`path` AS p FROM system:all_keyspaces_info AS k")) ?? []).map(
    (row) => row.p,
  );
  check(
    keyspaces.filter((path) => typeof path !== "string" || !path.startsWith("system:")).join() ===
      `default:${BUCKET}._default._default`,
    `scope: system:all_keyspaces_info lists, beside the system catalog, only the collection the user holds a role on -> ${keyspaces.filter((path) => typeof path === "string" && !path.startsWith("system:")).join()}`,
  );
  const buckets = (await rowsOf("SELECT b.`name` AS b FROM system:buckets AS b"))?.map((row) => row.b);
  check(
    JSON.stringify(buckets) === JSON.stringify([BUCKET]),
    `scope: system:buckets lists the user's bucket alone -> ${JSON.stringify(buckets)}`,
  );
  const indexes = await rowsOf("SELECT i.`name` FROM system:indexes AS i");
  check(indexes?.length === 0, `scope: system:indexes shows the user no index -> ${indexes?.length}`);

  // ADVISOR() given one statement runs for the user: it recommends indexes on a keyspace the user holds the role on, and
  // answers any other with the server's missing-role message inside its row.
  const own = JSON.stringify(await rowsOf('SELECT ADVISOR("SELECT * FROM `_default` WHERE n = 1") AS a'));
  check(
    own.includes('"recommended_indexes"') && own.includes(`ON \`default\`:\`${BUCKET}\`.\`_default\`.\`_default\``),
    `scope: ADVISOR() given one statement recommends indexes on the user's own keyspace -> ${own}`,
  );
  const theirs = await rowsOf(`SELECT ADVISOR("SELECT * FROM default:\`${OTHER}\` WHERE n = 1") AS a`);
  const answer = (theirs?.[0]?.a ?? {}) as { errors?: { error?: string }[] };
  const theirErrors = answer.errors ?? [];
  check(
    theirs?.length === 1 &&
      Object.keys(answer).join() === "errors" &&
      theirErrors.length === 1 &&
      theirErrors[0]?.error ===
        `User does not have credentials to run SELECT queries on default:${OTHER}. Add role query_select on default:${OTHER} to allow the statement to run.`,
    `scope: ADVISOR() given another bucket's statement answers the missing-role message and nothing more -> ${JSON.stringify(theirs)}`,
  );

  // A name that does not exist is answered as not found, one that exists as a missing role.
  const absent: readonly [string, string][] = [
    [
      `SELECT d.* FROM default:\`${PREFIX}nobucket\` AS d`,
      `Keyspace not found in CB datastore: default:${PREFIX}nobucket (near line 1, column 17) - cause: No bucket named ${PREFIX}nobucket`,
    ],
    ["SELECT c.* FROM s9.c9 AS c", `Scope not found in CB datastore default:${BUCKET}.s9 (near line 1, column 17)`],
    [
      "SELECT c.* FROM s1.c9 AS c",
      `Keyspace not found in CB datastore: default:${BUCKET}.s1.c9 (near line 1, column 17)`,
    ],
  ];
  for (const [statement, words] of absent) {
    const { result } = await mcp(agent, { sql: statement }, RUN_READ_QUERY);
    check(
      result.isError === true && lastText(result) === `${ENGINE_PREFIX}${words}`,
      `scope: a name that does not exist is answered as not found: ${statement} -> ${lastText(result)}`,
    );
  }
}

async function formsAndLimits(): Promise<void> {
  const agent = seed(AGENT);
  const withRead = await mcp(agent, { sql: "WITH t AS ([1, 2, 3]) SELECT RAW x FROM t AS x" }, RUN_READ_QUERY);
  check(
    JSON.stringify(withRead.result.structuredContent?.rows) === '[{"__value":1},{"__value":2},{"__value":3}]',
    `forms: a WITH before a SELECT answers -> ${JSON.stringify(withRead.result.structuredContent?.rows)}`,
  );
  const first = await mcp(
    agent,
    { sql: "SELECT x FROM ARRAY_RANGE(0, 10) AS x ORDER BY x", max_rows: 3 },
    RUN_READ_QUERY,
  );
  const pagination = first.result.structuredContent?.pagination as { nextOffset?: number | null } | undefined;
  check(
    JSON.stringify(first.result.structuredContent?.rows) === '[{"x":0},{"x":1},{"x":2}]' &&
      pagination?.nextOffset === 3 &&
      textOf(first.result).includes("Call again with offset 3 for the next page."),
    `paging: a read past max_rows names the next offset -> ${JSON.stringify(pagination)}`,
  );
  const next = await mcp(
    agent,
    { sql: "SELECT x FROM ARRAY_RANGE(0, 10) AS x ORDER BY x", max_rows: 3, offset: 3 },
    RUN_READ_QUERY,
  );
  check(
    JSON.stringify(next.result.structuredContent?.rows) === '[{"x":3},{"x":4},{"x":5}]',
    `paging: that offset answers the next rows -> ${JSON.stringify(next.result.structuredContent?.rows)}`,
  );
  const own = await mcp(
    agent,
    { sql: "SELECT x FROM ARRAY_RANGE(0, 10) AS x ORDER BY x LIMIT 5", offset: 3 },
    RUN_READ_QUERY,
  );
  check(
    textOf(own.result) ===
      "This query has its own LIMIT or TOP, so it cannot be paged with offset. Remove it and page with offset, or page it in SQL: LIMIT n OFFSET m." &&
      own.acquired.join() === "agent-read-only",
    `paging: an offset on a query with its own LIMIT is refused before it is sent -> ${textOf(own.result)}`,
  );
  for (const statement of ["EXPLAIN SELECT x FROM ARRAY_RANGE(0, 3) AS x", "VALUES (1)", "TABLE `_default`"]) {
    const passed = await mcp(agent, { sql: statement }, RUN_READ_QUERY);
    check(
      textOf(passed.result).startsWith(`${NOT_SENT}${FENCE}; this statement does not begin with SELECT or WITH`) &&
        passed.acquired.join() === "agent-read-only",
      `forms: ${JSON.stringify(statement)} passes the MCP fence and the provider refuses it before it is sent -> ${textOf(passed.result)}`,
    );
  }

  const rows = await mcp(agent, { sql: "SELECT RAW x FROM ARRAY_RANGE(0, 2000) AS x LIMIT 1500" }, RUN_READ_QUERY);
  check(
    textOf(rows.result).startsWith("The result has more than 1000 rows"),
    `limits: rows past the provider budget -> ${textOf(rows.result)}`,
  );
  const bytes = await mcp(agent, { sql: "SELECT REPEAT('x', 600000) AS a, REPEAT('y', 600000) AS b" }, RUN_READ_QUERY);
  check(
    textOf(bytes.result).startsWith("The result is larger than 1 MiB"),
    `limits: bytes past the provider budget -> ${textOf(bytes.result)}`,
  );
}

async function cancelAndTimeout(): Promise<void> {
  const agent = seed(AGENT);
  const slow = (marker: string) =>
    `SELECT COUNT(*) AS n, "${marker}" AS m FROM ARRAY_RANGE(0, 6000) AS a, ARRAY_RANGE(0, 6000) AS b`;

  const timedOut = await mcp(agent, { sql: slow(`${PREFIX}timeout`), timeout_ms: 2_000 }, RUN_READ_QUERY);
  await new Promise((resolve) => setTimeout(resolve, 500));
  const afterTimeout = await running(`${PREFIX}timeout`);
  check(
    textOf(timedOut.result) ===
      "The statement did not finish within timeout_ms (2000 ms). Narrow it, or raise timeout_ms up to 30000." &&
      afterTimeout === 0,
    `timeout: past timeout_ms the client gets the timeout answer, and the query service holds the statement no longer -> ${afterTimeout} running`,
  );

  const controller = new AbortController();
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 1_500);
  const cancelled = await mcp(
    agent,
    { sql: slow(`${PREFIX}cancel`), timeout_ms: 6_000 },
    RUN_READ_QUERY,
    controller.signal,
  );
  const answeredAt = Date.now() - startedAt;
  const afterCancel = await running(`${PREFIX}cancel`);
  check(
    textOf(cancelled.result) === "The call was cancelled before it finished." && answeredAt < 3_000,
    `cancel: a client close is answered as the cancel at once -> ${answeredAt} ms`,
  );
  check(
    afterCancel === 1,
    `cancel: the statement runs on in the query service after the close -> ${afterCancel} running`,
  );
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, 6_000 - (Date.now() - startedAt)) + 1_000));
  const afterDeadline = await running(`${PREFIX}cancel`);
  check(
    afterDeadline === 0,
    `cancel: once the time left of timeout_ms passes, the query service holds it no longer -> ${afterDeadline} running`,
  );
}

try {
  await cleanUp();
  await seedServer();
  await opens();
  await boundary();
  await dataScope();
  await formsAndLimits();
  await cancelAndTimeout();
} finally {
  await clearProviderCache();
  await cleanUp();
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
