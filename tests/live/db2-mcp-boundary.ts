/**
 * Live check of MCP's `run_read_query` on Db2 LUW, against a server of the operator's choosing.
 *
 * WHY THIS EXISTS. `run_read_query` serves Db2 through the same boundary agent mode does: the connection is acquired
 * under the agent read-only profile, and every statement goes through the provider's `queryReadOnly`, which checks the
 * user, as itself, before every statement on the statement's own connection to hold nothing but CONNECT and SELECT
 * (`agent-read.ts`), and sends the statement inside a derived table that only a fullselect fits. The MCP fence in front
 * of it is defence in depth. So this script replays the agent boundary check through the MCP tool's own handler
 * (`runStatement`) with that fence removed, against a real server:
 *
 *  - the check, through MCP: the seeded user (docker/db2-init/02-agent-principal.sql) is served; the instance owner,
 *    the seeded user granted DBADM, DATAACCESS, ACCESSCTRL, SECADM or SQLADM, and PUBLIC granted SELECT on the
 *    catalog's distribution statistics or on any of the seven objects that keep HIGH2KEY and LOW2KEY, or the seeded
 *    user a view or an alias of the owner's over either, are each refused before the statement is sent, with the
 *    check's own refusal;
 *    on one cached handle a grant added after a served call refuses the next call and its revoke admits the one after;
 *    with a distinct type in the database, whose generated casts and comparisons Db2 grants to PUBLIC, the seeded user
 *    is served a statement calling them;
 *  - the boundary, with the MCP fence bypassed: each write, data change, `NEXT VALUE FOR`, compound block, `CALL`,
 *    `SET`, declared temporary table, `LOCK TABLE`, `COMMIT` and second statement is sent as the seeded user through
 *    the MCP handler and refused by the server with its own SQLCODE, and a statement that closes the derived table
 *    early is refused by the provider before it is sent; with the fence in place each is refused before anything is
 *    acquired, but for `NEXT VALUE FOR` in a `VALUES`, which the fence admits and the server refuses; the instance owner runs the writes in a unit of work it rolls back, the positive control; a hash of the
 *    rows, the sequence, the agent user's grants and the fixture's tables is the same before and after;
 *  - what it reads beyond its tables: a table it holds no SELECT on, the distribution statistics in every spelling,
 *    the second highest and lowest value of every column through each of the seven objects that keep it, the
 *    statement history and other sessions are each refused by the server;
 *  - the catalog reads the agent profiles make from value-free sources: `inspect_schema` lists and describes the
 *    seeded user's tables under the seed's revokes;
 *  - the forms and paging: a SELECT, a WITH and a VALUES answer; TABLE and EXPLAIN are refused by the server; a page
 *    past the first is asked for with `offset` and answered from the next row; FETCH FIRST, OFFSET ... FETCH and LIMIT
 *    each run as the statement's own limit, and an offset on a statement with any of them or on a VALUES is refused
 *    before anything is sent, naming Db2's own clauses;
 *  - the limits: a read past the 1000-row provider budget and one past the 1 MiB budget are refused, never cut; a read
 *    past `timeout_ms` and a read whose client closes the call are answered at once, and the statement is shown
 *    running on the server after the answer, until it ends there.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it against a disposable database whose
 * instance owner is DB2INST1, holding the object fixture and the seeded agent user, such as the compose service:
 *
 *   docker compose -f database-compose.yml up -d db2
 *   LIBREDB_LIVE_DB2_PORT=50000 LIBREDB_LIVE_DB2_PASSWORD=<db2inst1's password> bun tests/live/db2-mcp-boundary.ts
 *
 * The check's refusal comes from the statement call, and the tool answers it in its own sentence, after the
 * untrusted-data notice; the match below takes the refusal's own sentence, never any error.
 *
 * Every object it creates carries the `LIBREDB_LM` prefix and is dropped on exit, and every grant it adds is revoked.
 * Each check prints one line, no credential among them, and any failure ends the run non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import { createHash } from "node:crypto";
import { Client } from "db2-node";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_CANCELLED_TEXT, MCP_UNTRUSTED_NOTICE, type ToolResult } from "@/lib/mcp/output";
import { inspectSchema, InspectSchemaInputSchema } from "@/lib/mcp/tools/inspect-schema";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm, type McpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`set ${name}: this script writes to the server it is pointed at, so it has no default`);
    process.exit(2);
  }
  return value;
}

const HOST = process.env.LIBREDB_LIVE_DB2_HOST ?? "127.0.0.1";
const PORT = Number(env("LIBREDB_LIVE_DB2_PORT"));
const ADMIN_PASSWORD = env("LIBREDB_LIVE_DB2_PASSWORD");
const AGENT_PASSWORD = process.env.LIBREDB_LIVE_DB2_AGENT_PASSWORD ?? "not-a-real-password";
const DATABASE = process.env.LIBREDB_LIVE_DB2_DATABASE ?? "TESTDB";
const CREDENTIALS = [ADMIN_PASSWORD, AGENT_PASSWORD];

/** The tool as MCP registers it, and the same tool with its statement fence removed: the boundary under test. */
const RUN_READ_QUERY = mcpStatementArm("run_read_query");
const UNFENCED: McpStatementArm = { ...RUN_READ_QUERY, fence: () => null };

function seed(id: string, user: string, password: string): ManagedConnection {
  return {
    id: `seed:live-${id}`,
    name: id,
    seedId: `live-${id}`,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "db2",
    host: HOST,
    port: PORT,
    database: DATABASE,
    user,
    password,
    // A container with no TLS listener: the explicit opt-in the provider otherwise refuses a cleartext password without.
    allowInsecureAuth: true,
    createdAt: new Date(),
  } as ManagedConnection;
}

const AGENT = seed("agent", "agent_ro", AGENT_PASSWORD);
const OWNER = seed("owner", "db2inst1", ADMIN_PASSWORD);

let failures = 0;
function check(ok: boolean, line: string): void {
  // A check line never carries a credential: one that would fails instead of printing it.
  if (CREDENTIALS.some((secret) => line.includes(secret))) {
    console.log("FAIL a check line would have carried a credential, and was not printed");
    failures++;
    return;
  }
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

async function raw(user: string, password: string): Promise<Client> {
  const client = new Client({
    host: HOST,
    port: PORT,
    database: DATABASE,
    user,
    password,
    ssl: false,
    securityMechanism: "userPassword",
  });
  await client.connect();
  return client;
}

const admin = await raw("db2inst1", ADMIN_PASSWORD);

async function rows(sql: string): Promise<Record<string, unknown>[]> {
  return (await admin.query(sql)).rows as Record<string, unknown>[];
}

function sqlcode(error: unknown): number | undefined {
  const match = /SQLCODE=(-?\d+)/.exec(error instanceof Error ? error.message : String(error));
  return match === null ? undefined : Number(match[1]);
}

/** Runs each statement as the instance owner, ignoring the SQLCODEs named, so a setup step can run twice. */
async function setup(
  statements: readonly string[],
  ignore: readonly number[] = [-204, -601, -556, -2105],
): Promise<void> {
  for (const sql of statements) {
    try {
      await admin.query(sql);
    } catch (error) {
      if (!ignore.some((code) => sqlcode(error) === code)) throw error;
    }
  }
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

/** The SQLCODE of an MCP answer that is the database's own refusal, or null when it is not one. */
function engineCodeOf(result: ToolResult): number | null {
  const text = result.content.map((part) => ("text" in part ? part.text : "")).at(-1) ?? "";
  if (result.isError !== true || !text.startsWith("The database refused or failed the call: ")) return null;
  const match = /SQLCODE=(-?\d+)/.exec(text);
  return match === null ? null : Number(match[1]);
}

/** The rows an MCP answer carries, or null when it is a refusal. */
function rowsOf(result: ToolResult): Record<string, unknown>[] | null {
  const content = (result as { structuredContent?: { rows?: Record<string, unknown>[] } }).structuredContent;
  return result.isError === true || content?.rows === undefined ? null : content.rows;
}

/** The check's own refusal sentence, as `agent-read.ts` writes it. */
const CHECK_REFUSAL = "The agent read-only execution profile refuses the Db2 user ";

/**
 * A refusal of the agent user by the check, naming `names`. The check runs inside the statement call, and the tool
 * answers a profile refusal there in its own sentence, behind the untrusted-data notice, since the refusal quotes
 * names a user of the database chose: two blocks, the notice and the sentence, never another error.
 */
function refusedByCheck(result: ToolResult, names: string): boolean {
  const blocks = result.content.map((part) => ("text" in part ? part.text : ""));
  return (
    result.isError === true &&
    blocks.length === 2 &&
    blocks[0] === MCP_UNTRUSTED_NOTICE &&
    blocks[1].startsWith(`run_read_query cannot run on this connection: ${CHECK_REFUSAL}`) &&
    blocks[1].includes(names)
  );
}

async function stateHash(): Promise<string> {
  const reads = [
    "SELECT ID, NAME FROM APP.CUSTOMERS ORDER BY ID",
    "SELECT ID, CUSTOMER_ID, TOTAL FROM APP.ORDERS ORDER BY ID",
    "SELECT NEXTCACHEFIRSTVALUE FROM SYSCAT.SEQUENCES WHERE SEQSCHEMA = 'APP' AND SEQNAME = 'ORDER_SEQ'",
    "SELECT TABSCHEMA, TABNAME, SELECTAUTH, INSERTAUTH FROM SYSCAT.TABAUTH WHERE GRANTEE = 'AGENT_RO' ORDER BY 1, 2",
    "SELECT TABSCHEMA, TABNAME, TYPE FROM SYSCAT.TABLES WHERE TABSCHEMA IN ('APP', 'REPORTING', 'AGENT_RO') ORDER BY 1, 2",
    "SELECT AUTHORITY, D_USER FROM TABLE (SYSPROC.AUTH_LIST_AUTHORITIES_FOR_AUTHID('AGENT_RO', 'U')) AS A ORDER BY 1",
  ];
  const hash = createHash("sha256");
  for (const sql of reads) hash.update(JSON.stringify(await rows(sql)));
  return hash.digest("hex");
}

/** The agent statements the server must refuse through the handler, each with the SQLCODEs it answers. */
const BOUNDARY: readonly (readonly [string, string, readonly number[]])[] = [
  ["INSERT", "INSERT INTO APP.CUSTOMERS VALUES (99, 'x')", [-104]],
  ["UPDATE", "UPDATE APP.CUSTOMERS SET NAME = 'x' WHERE ID = 1", [-104]],
  ["DELETE", "DELETE FROM APP.CUSTOMERS WHERE ID = 1", [-104]],
  ["MERGE", "MERGE INTO APP.CUSTOMERS T USING (VALUES (1)) S (ID) ON T.ID = S.ID WHEN MATCHED THEN DELETE", [-104]],
  ["FINAL TABLE", "SELECT * FROM FINAL TABLE (INSERT INTO APP.CUSTOMERS VALUES (99, 'x'))", [-20165]],
  ["OLD TABLE", "SELECT * FROM OLD TABLE (DELETE FROM APP.CUSTOMERS WHERE ID = 1)", [-20165]],
  ["NEXT VALUE FOR", "VALUES NEXT VALUE FOR APP.ORDER_SEQ", [-348]],
  ["BEGIN ATOMIC", "BEGIN ATOMIC INSERT INTO APP.CUSTOMERS VALUES (99, 'x'); END", [-104]],
  ["CALL ADMIN_CMD", "CALL SYSPROC.ADMIN_CMD('EXPORT TO /tmp/libredb_lm.del OF DEL SELECT * FROM APP.ORDERS')", [-104]],
  ["CREATE TABLE", "CREATE TABLE AGENT_RO.LIBREDB_LM_T (ID INTEGER)", [-104]],
  ["DROP TABLE", "DROP TABLE APP.SCRATCH", [-104]],
  ["GRANT", "GRANT SELECT ON APP.ORDERS TO PUBLIC", [-104]],
  ["SET CURRENT SCHEMA", "SET CURRENT SCHEMA = 'APP'", [-104]],
  ["DECLARE GLOBAL TEMPORARY TABLE", "DECLARE GLOBAL TEMPORARY TABLE SESSION.T (ID INTEGER)", [-104]],
  ["LOCK TABLE", "LOCK TABLE APP.ORDERS IN EXCLUSIVE MODE", [-104]],
  ["COMMIT", "COMMIT", [-104]],
  ["a second statement", "SELECT 1 FROM SYSIBM.SYSDUMMY1; DELETE FROM APP.CUSTOMERS", [-104]],
];

/**
 * A `VALUES` the MCP fence admits as a read: `NEXT VALUE FOR` would advance the sequence, and the server refuses it
 * inside the derived table (SQL0348N), while the check refuses any grantee holding USAGE on a sequence.
 */
const PASSES_FENCE: ReadonlySet<string> = new Set(["NEXT VALUE FOR"]);

/** Statements the agent user is refused reading, beyond its tables, each with the SQLCODEs the server answers. */
const SCOPE: readonly (readonly [string, string, readonly number[]])[] = [
  ["a table it holds no SELECT on", "SELECT V FROM APP.LIBREDB_LM_SECRET", [-551]],
  [
    "SYSCAT.COLDIST",
    "SELECT COLVALUE FROM SYSCAT.COLDIST WHERE TABNAME = 'LIBREDB_LM_SECRET' AND COLVALUE IS NOT NULL",
    [-551],
  ],
  [
    "SYSCAT.COLDIST, quoted",
    'SELECT "COLVALUE" FROM "SYSCAT"."COLDIST" WHERE "TABNAME" = \'LIBREDB_LM_SECRET\'',
    [-551],
  ],
  ["syscat.coldist, in lower case", "select colvalue from syscat.coldist where tabname = 'LIBREDB_LM_SECRET'", [-551]],
  [
    "SYSCAT.COLDIST, a comment inside the name",
    "SELECT COLVALUE FROM SYSCAT /* x */ . COLDIST WHERE TABNAME = 'LIBREDB_LM_SECRET'",
    [-551],
  ],
  ["SYSSTAT.COLDIST", "SELECT COLVALUE FROM SYSSTAT.COLDIST WHERE TABNAME = 'LIBREDB_LM_SECRET'", [-551]],
  ["SYSIBM.SYSCOLDIST", "SELECT COLVALUE FROM SYSIBM.SYSCOLDIST WHERE TBNAME = 'LIBREDB_LM_SECRET'", [-551]],
  ["SYSCAT.COLGROUPDIST", "SELECT COLVALUE FROM SYSCAT.COLGROUPDIST", [-551]],
  ["SYSCAT.COLDISTPARTITIONSTATS", "SELECT COLVALUE FROM SYSCAT.COLDISTPARTITIONSTATS", [-551]],
  ["SYSIBMADM.TOP_DYNAMIC_SQL", "SELECT VARCHAR(STMT_TEXT, 200) AS T FROM SYSIBMADM.TOP_DYNAMIC_SQL", [-1092]],
  ["SYSIBMADM.MON_CURRENT_SQL", "SELECT VARCHAR(STMT_TEXT, 200) AS T FROM SYSIBMADM.MON_CURRENT_SQL", [-551]],
  [
    "MON_GET_PKG_CACHE_STMT",
    "SELECT VARCHAR(STMT_TEXT, 200) AS T FROM TABLE (MON_GET_PKG_CACHE_STMT(NULL, NULL, NULL, -2)) AS M",
    [-551],
  ],
  [
    "SNAP_GET_DYN_SQL",
    "SELECT VARCHAR(STMT_TEXT, 200) AS T FROM TABLE (SYSPROC.SNAP_GET_DYN_SQL('', -1)) AS M",
    [-1092],
  ],
  ["MON_GET_CONNECTION", "SELECT SYSTEM_AUTH_ID FROM TABLE (MON_GET_CONNECTION(NULL, -2)) AS M", [-551]],
];

/** The authorities the instance owner grants the seeded user, each refused by the check through MCP. */
const AUTHORITIES = ["DBADM", "DATAACCESS", "ACCESSCTRL", "SECADM", "SQLADM"] as const;

/**
 * A statement that runs for seconds on the measured server, as the agent user may: a three-way catalog cross join,
 * times 25. SYSCAT.TABLES rather than SYSCAT.COLUMNS, which the seed revokes.
 */
const SLOW =
  "SELECT COUNT_BIG(*) AS N FROM SYSCAT.TABLES A, SYSCAT.TABLES B, SYSCAT.TABLES C, " +
  `(VALUES ${Array.from({ length: 25 }, (_, index) => index + 1).join(", ")}) AS D (N)`;

/** The seven objects that keep HIGH2KEY and LOW2KEY, each with the column that names the table a row describes. */
const COLUMN_STATISTICS: readonly (readonly [string, string, string])[] = [
  ["SYSCAT", "COLUMNS", "TABNAME"],
  ["SYSCAT", "SYSCOLUMNS_UNION", "TBNAME"],
  ["SYSCAT", "COLPARTITIONSTATS", "TABNAME"],
  ["SYSIBM", "SYSCOLUMNS", "TBNAME"],
  ["SYSIBM", "SYSCOLPARTITIONSTATS", "TBNAME"],
  ["SYSSTAT", "COLUMNS", "TABNAME"],
  ["SYSSTAT", "COLPARTITIONSTATS", "TABNAME"],
];

/** Whether the agent user's slow statement is still executing on the server, read by the instance owner. */
async function slowRunning(): Promise<boolean> {
  const found = await rows(
    "SELECT COUNT(*) AS N FROM TABLE (MON_GET_ACTIVITY(NULL, -2)) AS A " +
      "JOIN TABLE (MON_GET_CONNECTION(NULL, -2)) AS C ON C.APPLICATION_HANDLE = A.APPLICATION_HANDLE " +
      "WHERE C.SYSTEM_AUTH_ID = 'AGENT_RO' AND A.ACTIVITY_STATE = 'EXECUTING'",
  );
  return Number(found[0]?.N) > 0;
}

/** How long, from now, until the agent user's slow statement is no longer executing, polling every 250 ms. */
async function untilSlowEnds(limitMs = 120_000): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < limitMs && (await slowRunning())) await Bun.sleep(250);
  return Date.now() - started;
}

const CLEANUP = [
  "DROP TABLE APP.LIBREDB_LM_TYPED",
  "DROP DISTINCT TYPE APP.LIBREDB_LM_MONEY",
  "DROP VIEW APP.LIBREDB_LM_KEYS",
  "DROP ALIAS APP.LIBREDB_LM_KEYS_ALIAS",
  "DROP VIEW APP.LIBREDB_LM_STATS",
  "DROP ALIAS APP.LIBREDB_LM_STATS_ALIAS",
  "DROP TABLE APP.LIBREDB_LM_SECRET",
];

try {
  await setup(CLEANUP);
  await setup([
    "CREATE TABLE APP.LIBREDB_LM_SECRET (V VARCHAR(20))",
    "INSERT INTO APP.LIBREDB_LM_SECRET VALUES ('owner-only'), ('owner-only'), ('owner-only'), ('owner-other')",
    "CALL SYSPROC.ADMIN_CMD('RUNSTATS ON TABLE APP.LIBREDB_LM_SECRET WITH DISTRIBUTION')",
    "CREATE VIEW APP.LIBREDB_LM_STATS AS SELECT TABNAME, COLVALUE FROM SYSCAT.COLDIST",
    "CREATE ALIAS APP.LIBREDB_LM_STATS_ALIAS FOR SYSCAT.COLDIST",
    "CREATE VIEW APP.LIBREDB_LM_KEYS AS SELECT TABNAME, COLNAME, HIGH2KEY, LOW2KEY FROM SYSCAT.COLUMNS",
    "CREATE ALIAS APP.LIBREDB_LM_KEYS_ALIAS FOR SYSIBM.SYSCOLUMNS",
  ]);
  const before = await stateHash();

  // ---- Served: the seeded user reads its table through MCP ------------------------------------------------------
  const served = await mcp(AGENT, { sql: "SELECT ID FROM APP.ORDERS ORDER BY ID" }, RUN_READ_QUERY);
  check(
    rowsOf(served.result)?.length === 2 && served.acquired.join(",") === "agent-read-only",
    `the seeded agent user is served under the agent read-only profile (${served.acquired.join(",")})`,
  );

  // A distinct type's generated casts and comparisons, which Db2 grants to PUBLIC, leave the seeded user served.
  await setup([
    "CREATE DISTINCT TYPE APP.LIBREDB_LM_MONEY AS DECIMAL(9, 2) WITH COMPARISONS",
    "CREATE TABLE APP.LIBREDB_LM_TYPED (ID INTEGER NOT NULL, C_MONEY APP.LIBREDB_LM_MONEY)",
    "INSERT INTO APP.LIBREDB_LM_TYPED VALUES (1, APP.LIBREDB_LM_MONEY(12.34))",
    "GRANT SELECT ON APP.LIBREDB_LM_TYPED TO USER AGENT_RO",
  ]);
  const typed = await mcp(
    AGENT,
    {
      sql: 'SELECT ID, APP.DECIMAL(C_MONEY) AS AMOUNT FROM APP.LIBREDB_LM_TYPED WHERE APP."="(C_MONEY, APP.LIBREDB_LM_MONEY(12.34))',
    },
    RUN_READ_QUERY,
  );
  await setup(["DROP TABLE APP.LIBREDB_LM_TYPED", "DROP DISTINCT TYPE APP.LIBREDB_LM_MONEY"]);
  check(
    rowsOf(typed.result)?.length === 1,
    `with a distinct type in the database, the seeded user is served a statement calling its generated functions: ${textOf(typed.result).slice(0, 300)}`,
  );

  // ---- The check refuses, through MCP, before the statement is sent -----------------------------------------------
  const owner = await mcp(OWNER, { sql: "SELECT ID FROM APP.ORDERS" }, RUN_READ_QUERY);
  check(
    refusedByCheck(owner.result, "it holds a database or instance authority beyond CONNECT"),
    `the instance owner is refused by the check: ${textOf(owner.result).slice(0, 400)}`,
  );
  const ownerScope = await mcp(
    OWNER,
    { sql: "SELECT COLVALUE FROM SYSCAT.COLDIST WHERE TABNAME = 'LIBREDB_LM_SECRET'" },
    RUN_READ_QUERY,
  );
  check(
    refusedByCheck(ownerScope.result, "beyond CONNECT") && !textOf(ownerScope.result).includes("owner-only"),
    "the instance owner reads no distribution statistics through MCP: refused before the statement is sent",
  );
  for (const authority of AUTHORITIES) {
    await setup([`GRANT ${authority} ON DATABASE TO USER AGENT_RO`]);
    const refused = await mcp(AGENT, { sql: "SELECT ID FROM APP.ORDERS" }, RUN_READ_QUERY);
    await setup([`REVOKE ${authority} ON DATABASE FROM USER AGENT_RO`]);
    const again = await mcp(AGENT, { sql: "SELECT ID FROM APP.ORDERS" }, RUN_READ_QUERY);
    check(
      refusedByCheck(refused.result, `REVOKE ${authority} ON DATABASE FROM USER "AGENT_RO"`) &&
        rowsOf(again.result) !== null,
      `${authority} granted to the seeded user: refused by the check, served again once revoked`,
    );
  }
  for (const [schema, name] of [
    ["SYSCAT", "COLDIST"],
    ["SYSIBM", "SYSCOLDIST"],
    ["SYSSTAT", "COLGROUPDIST"],
  ]) {
    await setup([`GRANT SELECT ON ${schema}.${name} TO PUBLIC`]);
    const refused = await mcp(
      AGENT,
      { sql: "SELECT COLVALUE FROM SYSCAT.COLDIST WHERE TABNAME = 'LIBREDB_LM_SECRET'" },
      RUN_READ_QUERY,
    );
    await setup([`REVOKE SELECT ON ${schema}.${name} FROM PUBLIC`]);
    check(
      refusedByCheck(refused.result, `REVOKE SELECT ON TABLE "${schema}"."${name}" FROM PUBLIC`) &&
        !textOf(refused.result).includes("owner-only"),
      `SELECT on ${schema}.${name} to PUBLIC: refused by the check, before the statement is sent`,
    );
  }
  for (const [schema, name, table] of COLUMN_STATISTICS) {
    await setup([`GRANT SELECT ON ${schema}.${name} TO PUBLIC`]);
    const refused = await mcp(
      AGENT,
      { sql: `SELECT HIGH2KEY, LOW2KEY FROM ${schema}.${name} WHERE ${table} = 'LIBREDB_LM_SECRET'` },
      RUN_READ_QUERY,
    );
    await setup([`REVOKE SELECT ON ${schema}.${name} FROM PUBLIC`]);
    check(
      refusedByCheck(refused.result, `REVOKE SELECT ON TABLE "${schema}"."${name}" FROM PUBLIC`) &&
        !textOf(refused.result).includes("owner-"),
      `SELECT on the column statistics ${schema}.${name} to PUBLIC: refused by the check, before the statement is sent`,
    );
  }
  // A view or an alias of the owner's over the distribution statistics: a grant on the alias is a grant on the object it
  // names, and the view reads them with its owner's authority. Each is refused before the statement is sent.
  for (const [label, object, names, sql] of [
    [
      "a view of the owner's over SYSCAT.COLDIST",
      "APP.LIBREDB_LM_STATS",
      '"APP"."LIBREDB_LM_STATS"',
      "SELECT COLVALUE FROM APP.LIBREDB_LM_STATS WHERE TABNAME = 'LIBREDB_LM_SECRET'",
    ],
    [
      "an alias of the owner's for SYSCAT.COLDIST",
      "APP.LIBREDB_LM_STATS_ALIAS",
      '"SYSCAT"."COLDIST"',
      "SELECT COLVALUE FROM APP.LIBREDB_LM_STATS_ALIAS WHERE TABNAME = 'LIBREDB_LM_SECRET'",
    ],
    [
      "a view of the owner's over SYSCAT.COLUMNS",
      "APP.LIBREDB_LM_KEYS",
      '"APP"."LIBREDB_LM_KEYS"',
      "SELECT HIGH2KEY, LOW2KEY FROM APP.LIBREDB_LM_KEYS WHERE TABNAME = 'LIBREDB_LM_SECRET'",
    ],
    [
      "an alias of the owner's for SYSIBM.SYSCOLUMNS",
      "APP.LIBREDB_LM_KEYS_ALIAS",
      '"SYSIBM"."SYSCOLUMNS"',
      "SELECT HIGH2KEY, LOW2KEY FROM APP.LIBREDB_LM_KEYS_ALIAS WHERE TBNAME = 'LIBREDB_LM_SECRET'",
    ],
  ]) {
    await setup([`GRANT SELECT ON ${object} TO USER AGENT_RO`]);
    const refused = await mcp(AGENT, { sql }, RUN_READ_QUERY);
    await setup([`REVOKE SELECT ON ${object} FROM USER AGENT_RO`]);
    check(
      refusedByCheck(refused.result, `REVOKE SELECT ON TABLE ${names} FROM USER "AGENT_RO"`) &&
        !textOf(refused.result).includes("owner-only"),
      `${label}, granted to the seeded user: refused by the check, before the statement is sent`,
    );
  }

  // On one cached handle: the check runs before every statement, with no verdict kept.
  const handleOk = await mcp(AGENT, { sql: "SELECT ID FROM APP.ORDERS" }, RUN_READ_QUERY);
  await setup(["GRANT INSERT ON APP.ORDERS TO USER AGENT_RO"]);
  const handleRefused = await mcp(AGENT, { sql: "SELECT ID FROM APP.ORDERS" }, RUN_READ_QUERY);
  await setup(["REVOKE INSERT ON APP.ORDERS FROM USER AGENT_RO"]);
  const handleAgain = await mcp(AGENT, { sql: "SELECT ID FROM APP.ORDERS" }, RUN_READ_QUERY);
  check(
    rowsOf(handleOk.result) !== null &&
      refusedByCheck(handleRefused.result, 'REVOKE INSERT ON TABLE "APP"."ORDERS" FROM USER "AGENT_RO"') &&
      rowsOf(handleAgain.result) !== null,
    "on one handle: a grant after a served call refuses the next call, and its revoke serves the one after",
  );

  // ---- The boundary, with the MCP fence bypassed, and with it in place ---------------------------------------------
  for (const [label, sql, codes] of BOUNDARY) {
    const unfenced = await mcp(AGENT, { sql });
    const code = engineCodeOf(unfenced.result);
    check(
      code !== null && codes.includes(code),
      `${label}: refused by the server through the handler with the fence removed (SQLCODE ${code})`,
    );
    const fenced = await mcp(AGENT, { sql }, RUN_READ_QUERY);
    if (PASSES_FENCE.has(label)) {
      check(
        engineCodeOf(fenced.result) === code,
        `${label}: passes the MCP fence, a VALUES, and is refused by the server (SQLCODE ${engineCodeOf(fenced.result)})`,
      );
      continue;
    }
    check(
      fenced.result.isError === true &&
        textOf(fenced.result).startsWith("The statement was refused before it reached the database (") &&
        fenced.acquired.length === 0,
      `${label}: refused by the MCP fence before anything is acquired`,
    );
  }
  const outerFinal =
    "SELECT 1 AS A FROM SYSIBM.SYSDUMMY1) AS X, FINAL TABLE (INSERT INTO APP.CUSTOMERS VALUES (99, 'x')) AS Y, " +
    "(SELECT 1 AS B FROM SYSIBM.SYSDUMMY1";
  const outer = await mcp(AGENT, { sql: outerFinal });
  check(
    outer.result.isError === true &&
      textOf(outer.result).includes(
        "Read-only execution refused this statement: it closes a parenthesis it did not open",
      ),
    "FINAL TABLE in the outer FROM, the derived table closed early: refused by the provider before it is sent",
  );
  // The positive control: the instance owner's writes run, in a unit of work rolled back.
  const tx = await admin.beginTransaction();
  let ran = 0;
  for (const sql of [
    "INSERT INTO APP.CUSTOMERS VALUES (99, 'x')",
    "UPDATE APP.CUSTOMERS SET NAME = 'x' WHERE ID = 99",
    "SELECT * FROM FINAL TABLE (INSERT INTO APP.CUSTOMERS VALUES (98, 'y'))",
    "DELETE FROM APP.CUSTOMERS WHERE ID IN (98, 99)",
    "LOCK TABLE APP.ORDERS IN EXCLUSIVE MODE",
  ]) {
    await tx.query(sql);
    ran++;
  }
  await tx.rollback();
  check(ran === 5, "positive control: the instance owner's INSERT, UPDATE, FINAL TABLE, DELETE and LOCK TABLE ran");

  // ---- What the agent user reads beyond its tables ---------------------------------------------------------------
  for (const [label, sql, codes] of SCOPE) {
    const answered = await mcp(AGENT, { sql }, RUN_READ_QUERY);
    const code = engineCodeOf(answered.result);
    check(
      code !== null && codes.includes(code) && !textOf(answered.result).includes("owner-only"),
      `${label}: refused by the server through MCP (SQLCODE ${code})`,
    );
  }
  // The second highest and lowest value of every column, through each object that keeps it: the seed revoked all seven.
  for (const [schema, name, table] of COLUMN_STATISTICS) {
    const answered = await mcp(
      AGENT,
      { sql: `SELECT HIGH2KEY, LOW2KEY FROM ${schema}.${name} WHERE ${table} = 'LIBREDB_LM_SECRET'` },
      RUN_READ_QUERY,
    );
    const code = engineCodeOf(answered.result);
    check(
      code === -551 && !textOf(answered.result).includes("owner-"),
      `HIGH2KEY and LOW2KEY through ${schema}.${name}: refused by the server through MCP (SQLCODE ${code})`,
    );
  }

  // ---- The agent profiles' catalog reads, from the value-free sources ---------------------------------------------
  {
    const context = {
      caller: { username: "live", role: "admin" },
      visibleConnections: async () => [AGENT],
      resolve: async () => AGENT,
      acquire: (target: ManagedConnection, profile: ExecutionProfile) =>
        acquireExecutionProfileProvider(target, profile),
    } as unknown as McpConnectionContext;
    const inspected = await inspectSchema(
      InspectSchemaInputSchema.parse({ connection_id: AGENT.id, schema: "APP", table: "ORDERS" }),
      { context, signal: new AbortController().signal },
    );
    const tables = (inspected as { structuredContent?: { tables?: { name: string; columns?: unknown[] }[] } })
      .structuredContent?.tables;
    check(
      inspected.isError !== true &&
        tables?.length === 1 &&
        tables[0].columns?.length === 4 &&
        JSON.stringify(tables[0].columns).includes("DECIMAL(12,2)"),
      `inspect_schema describes APP.ORDERS as the seeded user under the seed's revokes: ${textOf(inspected).slice(0, 300)}`,
    );
  }

  // ---- The forms and paging -------------------------------------------------------------------------------------
  const forms: [string, string, boolean | number][] = [
    ["SELECT", "SELECT ID FROM APP.ORDERS ORDER BY ID", true],
    ["WITH", "WITH T AS (SELECT ID FROM APP.ORDERS) SELECT ID FROM T ORDER BY ID", true],
    ["VALUES", "VALUES (1), (2), (3)", true],
    ["TABLE", "TABLE APP.ORDERS", -104],
    ["EXPLAIN", "EXPLAIN PLAN FOR SELECT ID FROM APP.ORDERS", -104],
  ];
  for (const [label, sql, expected] of forms) {
    const answered = await mcp(AGENT, { sql }, RUN_READ_QUERY);
    check(
      expected === true ? rowsOf(answered.result) !== null : engineCodeOf(answered.result) === expected,
      `${label}: ${expected === true ? "answers" : `refused by the server (SQLCODE ${engineCodeOf(answered.result)})`}`,
    );
  }
  const ordered = "SELECT TABSCHEMA, TABNAME FROM SYSCAT.TABLES ORDER BY TABSCHEMA, TABNAME";
  const page1 = await mcp(AGENT, { sql: ordered, max_rows: 5 }, RUN_READ_QUERY);
  const page2 = await mcp(AGENT, { sql: ordered, max_rows: 5, offset: 5 }, RUN_READ_QUERY);
  const all = await mcp(AGENT, { sql: `${ordered} FETCH FIRST 10 ROWS ONLY` });
  const paged = (result: ToolResult) =>
    (result as { structuredContent?: { pagination?: { nextOffset: number | null } } }).structuredContent?.pagination;
  check(
    paged(page1.result)?.nextOffset === 5 &&
      JSON.stringify([...(rowsOf(page1.result) ?? []), ...(rowsOf(page2.result) ?? [])]) ===
        JSON.stringify(rowsOf(all.result)),
    "paging: the first page names offset 5, and the page at offset 5 is the next five rows",
  );
  // Each of Db2's own row limiting clauses runs as the statement's own limit, and an offset on it is refused unsent.
  for (const [clause, sql] of [
    ["FETCH FIRST", "SELECT ID FROM APP.ORDERS ORDER BY ID FETCH FIRST 1 ROW ONLY"],
    ["OFFSET ... FETCH", "SELECT ID FROM APP.ORDERS ORDER BY ID OFFSET 1 ROWS FETCH NEXT 1 ROW ONLY"],
    ["LIMIT", "SELECT ID FROM APP.ORDERS ORDER BY ID LIMIT 1"],
  ] as const) {
    const answered = await mcp(AGENT, { sql }, RUN_READ_QUERY);
    const ownLimit = await mcp(AGENT, { sql, offset: 1 }, RUN_READ_QUERY);
    check(
      rowsOf(answered.result)?.length === 1 &&
        textOf(ownLimit.result) ===
          "This query has its own FETCH FIRST, OFFSET ... FETCH or LIMIT, so it cannot be paged with offset. Remove it and page with offset, or page it in SQL: ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY." &&
        ownLimit.acquired.length === 1,
      `${clause}: the server runs it as the statement's own limit, and an offset on it is refused before it is sent`,
    );
  }
  const valuesOffset = await mcp(AGENT, { sql: "VALUES (1), (2), (3)", offset: 1 }, RUN_READ_QUERY);
  check(
    textOf(valuesOffset.result) === "This statement's result cannot be paged. Call again without offset.",
    "an offset on a VALUES is refused before it is sent",
  );

  // ---- The limits ---------------------------------------------------------------------------------------------------
  const tooMany = await mcp(
    AGENT,
    { sql: "SELECT COLUMN_NAME FROM SYSIBM.COLUMNS FETCH FIRST 2000 ROWS ONLY" },
    RUN_READ_QUERY,
  );
  check(
    textOf(tooMany.result).endsWith(
      "The result has more than 1000 rows, the most this server reads for one call. Add FETCH FIRST n ROWS ONLY with n of 1000 or less, or remove your own FETCH FIRST, OFFSET ... FETCH or LIMIT and page with offset.",
    ),
    `a read past the 1000-row budget is refused, never cut: ${textOf(tooMany.result).slice(0, 120)}`,
  );
  const tooBig = await mcp(
    AGENT,
    { sql: "SELECT REPEAT('x', 30000) AS X FROM SYSIBM.COLUMNS FETCH FIRST 60 ROWS ONLY" },
    RUN_READ_QUERY,
  );
  check(
    tooBig.result.isError === true &&
      textOf(tooBig.result).endsWith(
        "The result is larger than 1 MiB, the most this server reads for one call. Select fewer or narrower columns, or add FETCH FIRST n ROWS ONLY with a smaller n.",
      ),
    `a read past the 1 MiB budget is refused, never cut: ${textOf(tooBig.result).slice(0, 120)}`,
  );
  const timedStart = Date.now();
  const timed = await mcp(AGENT, { sql: SLOW, timeout_ms: 2_000 }, RUN_READ_QUERY);
  const timedAnswered = Date.now() - timedStart;
  const runningAfterTimeout = await slowRunning();
  const timedRanOn = await untilSlowEnds();
  check(
    textOf(timed.result) ===
      "The statement did not finish within timeout_ms (2000 ms). Narrow it, or raise timeout_ms up to 30000." &&
      timedAnswered < 4_000 &&
      runningAfterTimeout,
    `timeout_ms: answered in ${timedAnswered} ms, and the statement ran on the server ${timedRanOn} ms more`,
  );
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 1_000);
  const cancelStart = Date.now();
  const cancelled = await mcp(AGENT, { sql: SLOW, timeout_ms: 20_000 }, RUN_READ_QUERY, controller.signal);
  const cancelAnswered = Date.now() - cancelStart;
  const runningAfterCancel = await slowRunning();
  const cancelRanOn = await untilSlowEnds();
  check(
    textOf(cancelled.result) === MCP_CANCELLED_TEXT && cancelAnswered < 2_500 && runningAfterCancel,
    `a client close: answered in ${cancelAnswered} ms, and the statement ran on the server ${cancelRanOn} ms more`,
  );
  const next = await mcp(AGENT, { sql: "VALUES 1" }, RUN_READ_QUERY);
  check(rowsOf(next.result) !== null, "the call after them answers");

  check((await stateHash()) === before, "the rows, the sequence, the agent user's grants and the tables read the same");
} finally {
  await setup([
    ...AUTHORITIES.map((authority) => `REVOKE ${authority} ON DATABASE FROM USER AGENT_RO`),
    "REVOKE SELECT ON SYSCAT.COLDIST FROM PUBLIC",
    "REVOKE SELECT ON SYSIBM.SYSCOLDIST FROM PUBLIC",
    "REVOKE SELECT ON SYSSTAT.COLGROUPDIST FROM PUBLIC",
    ...COLUMN_STATISTICS.map(([schema, name]) => `REVOKE SELECT ON ${schema}.${name} FROM PUBLIC`),
    "REVOKE INSERT ON APP.ORDERS FROM USER AGENT_RO",
    ...CLEANUP,
  ]);
  await admin.close();
  clearProviderCache();
}

console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
