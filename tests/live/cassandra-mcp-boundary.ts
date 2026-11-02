/**
 * Live check of MCP's `run_read_query` on Apache Cassandra, against a server of the operator's choosing.
 *
 * WHY THIS EXISTS. `run_read_query` serves Cassandra through the same boundary agent mode does: the connection is
 * acquired under the agent read-only profile, whose open checks the role (`agent-boundary.ts`), and every statement
 * goes through the provider's `queryReadOnly`, which checks the role again on a session of its own and sends one
 * SELECT of the connection's keyspace or of `system_schema`, and nothing else. The MCP fence in front of it is defence
 * in depth. So this script replays the agent boundary check (`tests/live/cassandra-agent-boundary.ts`) through the MCP
 * tool's own handler (`runStatement`), with that fence removed where it says so, against a real server:
 *
 *  - the open, through MCP: a role holding SELECT on the keyspace, and one holding SELECT on a table of it, are
 *    served; the image's superuser, a superuser role, a role granted a superuser role, MODIFY on a second keyspace,
 *    SELECT on every keyspace, EXECUTE on a function, UNMASK, MODIFY through a role granted to a role granted to it, a
 *    keyspace with a column masked by a user-defined function, a role holding nothing, and a role holding SELECT on
 *    `system_auth`, `system_traces` or `system` and bound to it are each refused before any statement runs, in the MCP
 *    refusal sentence, the role table's password hashes never answered though the role reads them on a session of
 *    its own;
 *  - the boundary, the MCP fence bypassed: each write, conditional write, BATCH, TRUNCATE, DDL statement, GRANT,
 *    REVOKE, role statement and USE is refused by the provider before it is sent, and a call of a user-defined
 *    function or aggregate, a SELECT, reaches the server and is refused by it as Unauthorized, in its own words; the
 *    same statements, sent as the role on a driver session of its own, are each refused by the server as Unauthorized
 *    (code 8448), and run as the superuser on a scratch keyspace, the positive control; the keyspace's rows, tables and
 *    functions and the roles read the same before and after; the same statements with the MCP fence in place are
 *    refused at admission, before anything is acquired;
 *  - the read scope: the trace of another session's statement, the node's system tables, the virtual tables'
 *    catalog, the role table and another keyspace are refused by the provider before they are sent, in every spelling
 *    (quoted, capitals, comments around the dot, no space at all), while the role reads the trace table and the
 *    node's row on a driver session of its own, the control that shows the server would answer; the schema catalog
 *    and an unqualified table answer;
 *  - the limits: a read answers its rows; a read past `max_rows` is cut and says how to page in CQL, an offset is
 *    refused, the token and clustering pages the answer names run; one past the 1000-row provider budget and one past
 *    the 1 MiB budget are refused, never cut; one past `timeout_ms` is answered as the timeout, and a cancel ends the
 *    wait; whether the coordinator still runs the statement after each is read from `system_views.queries`;
 *  - the engine gates: a node on AllowAllAuthorizer and a ScyllaDB node are refused at open through MCP.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it against a Cassandra 5.0 node with
 * PasswordAuthenticator and CassandraAuthorizer, user-defined functions and dynamic data masking on, as a superuser
 * (the recipe is `tests/fixtures/cassandra/5.0.9/agent-boundary/run.sh`):
 *
 *   LIBREDB_LIVE_CASSANDRA_PORT=9042 LIBREDB_LIVE_CASSANDRA_USER=... LIBREDB_LIVE_CASSANDRA_PASSWORD=... \
 *     bun tests/live/cassandra-mcp-boundary.ts
 *
 * Optional: `LIBREDB_LIVE_CASSANDRA_ALLOW_ALL_PORT` names a node with AllowAllAuthorizer whose superuser is the same,
 * and `LIBREDB_LIVE_SCYLLA_PORT` a ScyllaDB node with no authenticator; each is then refused at open.
 *
 * Every keyspace and role it creates carries the `libredb_lmc_` prefix and is dropped on exit. Each check prints one
 * line, no credential among them, and any failure ends the run non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import { createHash, randomBytes } from "node:crypto";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import { CassandraDriverTransport } from "@/lib/db/providers/sql/cassandra/driver-transport";
import { CassandraTransportError } from "@/lib/db/providers/sql/cassandra/transport";
import type { McpConnectionContext } from "@/lib/mcp/context";
import type { ToolResult } from "@/lib/mcp/output";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm, type McpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";

const PREFIX = "libredb_lmc_";
const KS = `${PREFIX}data`;
const OTHER = `${PREFIX}other`;
const SCRATCH = `${PREFIX}scratch`;
/** One password for every seeded role, made for the run. */
const PASSWORD = randomBytes(12).toString("hex");
/** A value only the superuser's traced statement carries, looked for in every answer the role gets through MCP. */
const MARKER = `trace-marker-${randomBytes(6).toString("hex")}`;
/** Rows enough for a scan that outlasts a short `timeout_ms`. */
const SLOW_ROWS = 1_000_000;

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`set ${name}: this script writes to the server it is pointed at, so it has no default`);
    process.exit(2);
  }
  return value;
}

const HOST = process.env.LIBREDB_LIVE_CASSANDRA_HOST ?? "127.0.0.1";
const PORT = Number(env("LIBREDB_LIVE_CASSANDRA_PORT"));
const ADMIN = { user: env("LIBREDB_LIVE_CASSANDRA_USER"), password: env("LIBREDB_LIVE_CASSANDRA_PASSWORD") };
const DATA_CENTRE = process.env.LIBREDB_LIVE_CASSANDRA_DATA_CENTRE ?? "datacenter1";
// The image's default superuser signs in with its own name as its password, which a refusal naming that role prints,
// so that password is a secret only when it is not the role's name.
const SECRETS = [PASSWORD, ...(ADMIN.password === ADMIN.user ? [] : [ADMIN.password])];

/** The tool as MCP registers it, and the same tool with its statement fence removed: the boundary under test. */
const RUN_READ_QUERY = mcpStatementArm("run_read_query");
const UNFENCED: McpStatementArm = { ...RUN_READ_QUERY, fence: () => null };
const ENGINES = RUN_READ_QUERY.engines;

function seed(user: string, password: string, port = PORT, database = KS): ManagedConnection {
  return {
    id: `seed:live-${user}-${port}-${database}`,
    name: user,
    seedId: `live-${user}`,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "cassandra",
    host: HOST,
    port,
    user,
    password,
    database,
    localDataCenter: DATA_CENTRE,
    createdAt: new Date(),
  } as ManagedConnection;
}

let adminTransport: CassandraDriverTransport | null = null;

async function admin(cql: string): Promise<{ rows: Record<string, unknown>[] }> {
  if (adminTransport === null) {
    adminTransport = new CassandraDriverTransport(seed(ADMIN.user, ADMIN.password, PORT, ""), 60_000);
    await adminTransport.connect();
  }
  return adminTransport.execute(cql);
}

/**
 * What `cql` sent as `user` on a driver session of its own, bound to `keyspace`, answers: its rows, or the server's
 * code and words.
 */
async function asRole(
  user: string,
  cql: string,
  keyspace = KS,
): Promise<{ rows: Record<string, unknown>[] } | { code: number | null; message: string }> {
  const transport = new CassandraDriverTransport(seed(user, PASSWORD, PORT, keyspace), 30_000);
  await transport.connect();
  try {
    return { rows: (await transport.execute(cql)).rows };
  } catch (error) {
    if (error instanceof CassandraTransportError) return { code: error.code, message: error.message };
    throw error;
  } finally {
    await transport.close();
  }
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** One MCP call on `connection`, through the factory's own profiled acquisition, as the route makes it. */
async function mcp(
  connection: ManagedConnection,
  args: Partial<McpStatementInput> & { readonly sql: string },
  arm: McpStatementArm = RUN_READ_QUERY,
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

/** The last text block of an MCP answer, where the refusal or the database's words are. */
const lastTextOf = (result: ToolResult): string =>
  result.content.map((part) => ("text" in part ? part.text : "")).at(-1) ?? "";

const NOT_SENT = "The statement was refused before it reached the database: ";
const NOT_SELECT = `${NOT_SENT}The agent read-only execution profile sends one CQL statement, a SELECT, and nothing else; this statement does not begin with SELECT, so it was not sent.`;
const SCOPE = `${NOT_SENT}The agent read-only execution profile reads the tables of the connection's keyspace and of system_schema, and nothing else; this SELECT reads `;
const ENGINE = "The database refused or failed the call: ";
/** The server's Unauthorized wordings (code 8448): a missing permission, and the two a role statement answers. */
const UNAUTHORIZED = new RegExp(
  `^(?:User ${PREFIX}ro has no \\w+ permission on <[^>]+> or any of its parents|User ${PREFIX}ro does not have sufficient privileges to perform the requested operation|You aren't allowed to alter your own superuser status or that of a role granted to you)`,
);

async function seedServer(): Promise<void> {
  for (const keyspace of [KS, OTHER, SCRATCH]) {
    await admin(
      `CREATE KEYSPACE IF NOT EXISTS ${keyspace} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`,
    );
  }
  for (const keyspace of [KS, SCRATCH]) {
    await admin(`CREATE TABLE IF NOT EXISTS ${keyspace}.customers (id int PRIMARY KEY, name text)`);
    await admin(`CREATE TABLE IF NOT EXISTS ${keyspace}.big (id int PRIMARY KEY, body text)`);
    for (const [id, name] of [
      [1, "Ada"],
      [2, "Brian"],
      [3, "Chen"],
    ] as const) {
      await admin(`INSERT INTO ${keyspace}.customers (id, name) VALUES (${id}, '${name}')`);
    }
    await admin(
      `CREATE FUNCTION IF NOT EXISTS ${keyspace}.plus_one(x int) RETURNS NULL ON NULL INPUT RETURNS int LANGUAGE java AS 'return x + 1;'`,
    );
    await admin(
      `CREATE FUNCTION IF NOT EXISTS ${keyspace}.acc(state int, v int) CALLED ON NULL INPUT RETURNS int LANGUAGE java AS 'return state + (v == null ? 0 : v);'`,
    );
    await admin(`CREATE AGGREGATE IF NOT EXISTS ${keyspace}.total(int) SFUNC acc STYPE int INITCOND 0`);
    await admin(
      `CREATE FUNCTION IF NOT EXISTS ${keyspace}.redact(v text) RETURNS NULL ON NULL INPUT RETURNS text LANGUAGE java AS 'return "redacted-by-udf";'`,
    );
  }
  // Two values past half a MiB each, so one row is past the 1 MiB provider budget.
  await admin(`INSERT INTO ${KS}.big (id, body) VALUES (1, '${"x".repeat(600_000)}')`);
  await admin(`INSERT INTO ${KS}.big (id, body) VALUES (2, '${"y".repeat(600_000)}')`);
  await admin(`CREATE TABLE IF NOT EXISTS ${KS}.many (id int PRIMARY KEY)`);
  await admin(`CREATE TABLE IF NOT EXISTS ${KS}.events (pk int, ck int, v text, PRIMARY KEY (pk, ck))`);
  await admin(`CREATE TABLE IF NOT EXISTS ${KS}.slow (id int PRIMARY KEY, v text)`);
  await admin(`CREATE TABLE IF NOT EXISTS ${OTHER}.t (id int PRIMARY KEY, v text)`);
  await admin(`INSERT INTO ${OTHER}.t (id, v) VALUES (1, 'kept')`);
  await admin(`CREATE TABLE IF NOT EXISTS ${SCRATCH}.masked (id int PRIMARY KEY, secret text)`);
  await admin(`ALTER TABLE ${SCRATCH}.masked ALTER secret MASKED WITH ${SCRATCH}.redact()`);
  for (let ck = 1; ck <= 6; ck++) await admin(`INSERT INTO ${KS}.events (pk, ck, v) VALUES (1, ${ck}, 'e${ck}')`);
  await fill(`INSERT INTO ${KS}.many (id) VALUES (?)`, 1_100, (id) => [id]);
  await fill(`INSERT INTO ${KS}.slow (id, v) VALUES (?, ?)`, SLOW_ROWS, (id) => [id, "x".repeat(200)]);

  const role = async (name: string, ...grants: string[]) => {
    await admin(`CREATE ROLE IF NOT EXISTS ${name} WITH LOGIN = true AND PASSWORD = '${PASSWORD}'`);
    for (const grant of grants) await admin(grant);
  };
  await role(`${PREFIX}ro`, `GRANT SELECT ON KEYSPACE ${KS} TO ${PREFIX}ro`);
  await role(`${PREFIX}table`, `GRANT SELECT ON TABLE ${KS}.customers TO ${PREFIX}table`);
  await role(
    `${PREFIX}modify`,
    `GRANT SELECT ON KEYSPACE ${KS} TO ${PREFIX}modify`,
    `GRANT MODIFY ON KEYSPACE ${OTHER} TO ${PREFIX}modify`,
  );
  await admin(
    `CREATE ROLE IF NOT EXISTS ${PREFIX}super WITH LOGIN = true AND SUPERUSER = true AND PASSWORD = '${PASSWORD}'`,
  );
  await role(`${PREFIX}allks`, `GRANT SELECT ON ALL KEYSPACES TO ${PREFIX}allks`);
  await role(
    `${PREFIX}exec`,
    `GRANT SELECT ON KEYSPACE ${KS} TO ${PREFIX}exec`,
    `GRANT EXECUTE ON FUNCTION ${KS}.plus_one(int) TO ${PREFIX}exec`,
  );
  await role(
    `${PREFIX}unmask`,
    `GRANT SELECT ON KEYSPACE ${KS} TO ${PREFIX}unmask`,
    `GRANT UNMASK ON KEYSPACE ${KS} TO ${PREFIX}unmask`,
  );
  await admin(`CREATE ROLE IF NOT EXISTS ${PREFIX}writer_inner`);
  await admin(`GRANT MODIFY ON KEYSPACE ${KS} TO ${PREFIX}writer_inner`);
  await admin(`CREATE ROLE IF NOT EXISTS ${PREFIX}writer_middle`);
  await admin(`GRANT ${PREFIX}writer_inner TO ${PREFIX}writer_middle`);
  await role(
    `${PREFIX}inherit`,
    `GRANT SELECT ON KEYSPACE ${KS} TO ${PREFIX}inherit`,
    `GRANT ${PREFIX}writer_middle TO ${PREFIX}inherit`,
  );
  await admin(`CREATE ROLE IF NOT EXISTS ${PREFIX}super_inner WITH SUPERUSER = true`);
  await role(
    `${PREFIX}inherit_super`,
    `GRANT SELECT ON KEYSPACE ${KS} TO ${PREFIX}inherit_super`,
    `GRANT ${PREFIX}super_inner TO ${PREFIX}inherit_super`,
  );
  await role(`${PREFIX}none`);
  await role(`${PREFIX}masked`, `GRANT SELECT ON KEYSPACE ${SCRATCH} TO ${PREFIX}masked`);
  for (const keyspace of SYSTEM_BOUND) {
    await role(`${PREFIX}${keyspace}`, `GRANT SELECT ON KEYSPACE ${keyspace} TO ${PREFIX}${keyspace}`);
  }
}

/** Inserts `count` rows through one prepared statement, many at a time. */
async function fill(cql: string, count: number, values: (id: number) => unknown[]): Promise<void> {
  const client = new (await import("cassandra-driver")).Client({
    contactPoints: [`${HOST}:${PORT}`],
    localDataCenter: DATA_CENTRE,
    credentials: { username: ADMIN.user, password: ADMIN.password },
  });
  await client.connect();
  let next = 0;
  const worker = async () => {
    while (next < count) {
      const id = next++;
      await client.execute(cql, values(id), { prepare: true });
    }
  };
  try {
    await Promise.all(Array.from({ length: 256 }, worker));
  } finally {
    await client.shutdown();
  }
}

/**
 * Cassandra's own keyspaces a role is bound to: each role holds SELECT on its keyspace alone, which the role check
 * reads as bounded, so only the refusal of a system keyspace as the connection's keeps it from the role table's
 * password hashes, other sessions' traces and the node's own tables.
 */
const SYSTEM_BOUND = ["system_auth", "system_traces", "system"] as const;

/** A bcrypt digest as `system_auth.roles.salted_hash` holds one. */
const BCRYPT = /\$2[aby]\$\d\d\$/;

const ROLES = [
  "ro",
  "table",
  "modify",
  "super",
  "allks",
  "exec",
  "unmask",
  "inherit",
  "writer_middle",
  "writer_inner",
  "inherit_super",
  "super_inner",
  "none",
  "masked",
  ...SYSTEM_BOUND,
];

async function cleanup(): Promise<void> {
  for (const keyspace of [KS, OTHER, SCRATCH]) await admin(`DROP KEYSPACE IF EXISTS ${keyspace}`).catch(() => {});
  for (const name of ROLES) await admin(`DROP ROLE IF EXISTS ${PREFIX}${name}`).catch(() => {});
}

/** The state the boundary must leave as it found: the keyspace's rows, tables and functions, and the roles. */
async function stateHash(): Promise<string> {
  const reads = [
    `SELECT id, name FROM ${KS}.customers`,
    `SELECT id FROM ${KS}.big`,
    `SELECT table_name FROM system_schema.tables WHERE keyspace_name = '${KS}'`,
    `SELECT function_name FROM system_schema.functions WHERE keyspace_name = '${KS}'`,
    `SELECT id, v FROM ${OTHER}.t`,
  ];
  const hash = createHash("sha256");
  for (const cql of reads) hash.update(JSON.stringify((await admin(cql)).rows));
  hash.update(JSON.stringify((await admin("LIST ROLES")).rows.map((row) => row.role).sort()));
  return hash.digest("hex");
}

/** The boundary's statements, each with the keyspace it writes to left as `@`. */
const WRITES: readonly string[] = [
  "INSERT INTO @.customers (id, name) VALUES (99, 'x')",
  "UPDATE @.customers SET name = 'x' WHERE id = 1",
  "DELETE FROM @.customers WHERE id = 1",
  "INSERT INTO @.customers (id, name) VALUES (98, 'x') IF NOT EXISTS",
  "BEGIN BATCH INSERT INTO @.customers (id, name) VALUES (97, 'x'); APPLY BATCH",
  "BEGIN UNLOGGED BATCH UPDATE @.customers SET name = 'y' WHERE id = 2; APPLY BATCH",
  "TRUNCATE @.big",
  "CREATE TABLE @.made (id int PRIMARY KEY)",
  "ALTER TABLE @.customers ADD extra text",
  "CREATE INDEX ON @.customers (name)",
  "CREATE MATERIALIZED VIEW @.by_name AS SELECT * FROM @.customers WHERE id IS NOT NULL AND name IS NOT NULL PRIMARY KEY (name, id)",
  "CREATE FUNCTION @.made_f(x int) RETURNS NULL ON NULL INPUT RETURNS int LANGUAGE java AS 'return x;'",
  "CREATE TYPE @.addr (street text)",
  "DROP TABLE @.big",
  "SELECT @.plus_one(id) FROM @.customers WHERE id = 1",
  "SELECT @.total(id) FROM @.customers",
];

/** Statements on no keyspace's data: each refused the role, never run by the control. */
const ROLE_WRITES: readonly string[] = [
  `CREATE KEYSPACE ${PREFIX}made WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`,
  `GRANT MODIFY ON KEYSPACE ${KS} TO ${PREFIX}ro`,
  `REVOKE SELECT ON KEYSPACE ${KS} FROM ${PREFIX}ro`,
  `CREATE ROLE ${PREFIX}made`,
  `ALTER ROLE ${PREFIX}ro WITH SUPERUSER = true`,
];

/** Reads outside the scope, each with the table the refusal names, in every spelling the server reads alike. */
const OUT_OF_SCOPE: readonly [string, string][] = [
  ["SELECT * FROM system_traces.sessions", "system_traces.sessions"],
  ["SELECT activity FROM system_traces.events", "system_traces.events"],
  ['SELECT * FROM "system_traces"."sessions"', "system_traces.sessions"],
  ["SELECT * FROM SYSTEM_TRACES.SESSIONS", "system_traces.sessions"],
  ["SELECT * FROM System_Traces.Sessions", "system_traces.sessions"],
  ["SELECT * FROM system_traces /* c */ . sessions", "system_traces.sessions"],
  ["SELECT * FROM system_traces\n-- c\n.sessions", "system_traces.sessions"],
  ['SELECT"session_id"FROM"system_traces"."sessions"', "system_traces.sessions"],
  ["SELECT * FROM system.local", "system.local"],
  ["SELECT * FROM system.peers_v2", "system.peers_v2"],
  ["SELECT * FROM system.size_estimates", "system.size_estimates"],
  ["SELECT * FROM system.table_estimates", "system.table_estimates"],
  ["SELECT * FROM system_virtual_schema.tables", "system_virtual_schema.tables"],
  ["SELECT * FROM system_auth.roles", "system_auth.roles"],
  ["SELECT * FROM system_views.clients", "system_views.clients"],
  ["SELECT * FROM system_distributed.repair_history", "system_distributed.repair_history"],
  [`SELECT * FROM ${OTHER}.t`, `${OTHER}.t`],
];

/** Whether the coordinator still runs a statement whose text holds `needle`, as `system_views.queries` lists them. */
async function stillRunning(needle: string): Promise<boolean> {
  const rows = (await admin("SELECT task FROM system_views.queries")).rows;
  return rows.some((row) => String(row.task).includes(needle));
}

/** How long after now the coordinator stops listing a statement whose text holds `needle`, in ms, up to 30 s. */
async function endsAfter(needle: string): Promise<number> {
  const start = Date.now();
  while (Date.now() - start < 30_000 && (await stillRunning(needle))) await sleep(50);
  return Date.now() - start;
}

async function main(): Promise<void> {
  await cleanup();
  await seedServer();
  const agent = seed(`${PREFIX}ro`, PASSWORD);

  // The open, through MCP.
  for (const user of [`${PREFIX}ro`, `${PREFIX}table`]) {
    const served = await mcp(seed(user, PASSWORD), { sql: `SELECT id, name FROM ${KS}.customers` });
    check(
      served.result.isError === undefined &&
        served.result.structuredContent?.row_count === 3 &&
        served.acquired.join() === "agent-read-only",
      `open: ${user} is served under agent-read-only -> ${served.result.structuredContent?.row_count ?? textOf(served.result)}`,
    );
  }
  const refusedOpens: readonly [ManagedConnection, string, string][] = [
    [seed(ADMIN.user, ADMIN.password), "the image's superuser", "it is a superuser"],
    [seed(`${PREFIX}super`, PASSWORD), `${PREFIX}super`, "it is a superuser"],
    [seed(`${PREFIX}inherit_super`, PASSWORD), `${PREFIX}inherit_super`, `it is a superuser (${PREFIX}super_inner)`],
    [seed(`${PREFIX}modify`, PASSWORD), `${PREFIX}modify`, `it holds MODIFY on <keyspace ${OTHER}>`],
    [seed(`${PREFIX}allks`, PASSWORD), `${PREFIX}allks`, "it holds SELECT on <all keyspaces>"],
    [seed(`${PREFIX}exec`, PASSWORD), `${PREFIX}exec`, `it holds EXECUTE on <function ${KS}.plus_one(int)>`],
    [seed(`${PREFIX}unmask`, PASSWORD), `${PREFIX}unmask`, `it holds UNMASK on <keyspace ${KS}>`],
    [
      seed(`${PREFIX}inherit`, PASSWORD),
      `${PREFIX}inherit`,
      `it holds MODIFY on <keyspace ${KS}> (granted to ${PREFIX}writer_inner)`,
    ],
    [
      seed(`${PREFIX}masked`, PASSWORD, PORT, SCRATCH),
      `${PREFIX}masked`,
      `the column ${SCRATCH}.masked.secret is masked with the user-defined function ${SCRATCH}.redact`,
    ],
    [seed(`${PREFIX}none`, PASSWORD), `${PREFIX}none`, "holds none"],
    ...SYSTEM_BOUND.map((keyspace): [ManagedConnection, string, string] => [
      seed(`${PREFIX}${keyspace}`, PASSWORD, PORT, keyspace),
      `${PREFIX}${keyspace} bound to ${keyspace}`,
      `this connection names ${keyspace}, one of the keyspaces Apache Cassandra keeps for itself`,
    ]),
  ];
  for (const [connection, who, says] of refusedOpens) {
    const { result, acquired } = await mcp(connection, { sql: `SELECT id FROM ${connection.database}.customers` });
    const text = textOf(result);
    check(
      result.isError === true &&
        acquired.join() === "agent-read-only" &&
        text.startsWith("run_read_query cannot run on this connection: The agent read-only execution profile ") &&
        text.endsWith(`It runs on ${ENGINES}.`) &&
        text.includes(says),
      `open: ${who} is refused through MCP -> ${text}`,
    );
  }

  // A role holding SELECT on system_auth, bound to it: the server would serve it the role table, hashes included.
  const hashes = await asRole(`${PREFIX}system_auth`, "SELECT role, salted_hash FROM roles", "system_auth");
  check(
    "rows" in hashes && hashes.rows.some((row) => BCRYPT.test(String(row.salted_hash))),
    `control: on a session of its own the role bound to system_auth reads the role table's password hashes -> ${"rows" in hashes ? `${hashes.rows.length} rows` : hashes.message}`,
  );
  for (const arm of [RUN_READ_QUERY, UNFENCED]) {
    const { result, acquired } = await mcp(
      seed(`${PREFIX}system_auth`, PASSWORD, PORT, "system_auth"),
      {
        sql: "SELECT role, is_superuser, salted_hash FROM roles",
      },
      arm,
    );
    const text = textOf(result);
    check(
      result.isError === true &&
        acquired.join() === "agent-read-only" &&
        text.startsWith("run_read_query cannot run on this connection: ") &&
        text.includes("this connection names system_auth, one of the keyspaces Apache Cassandra keeps for itself") &&
        !BCRYPT.test(text) &&
        result.structuredContent === undefined,
      `open: ${arm === UNFENCED ? "bypassed, " : ""}the role table read on a connection bound to system_auth is refused at open, and no hash is answered -> ${text}`,
    );
  }

  // The boundary, the MCP fence bypassed, with the state compared before and after.
  const before = await stateHash();
  for (const template of [...WRITES, ...ROLE_WRITES]) {
    const cql = template.replaceAll("@", KS);
    const fenced = await mcp(agent, { sql: cql });
    const { result } = await mcp(agent, { sql: cql }, UNFENCED);
    const text = lastTextOf(result);
    const fenceAnswered = fenced.result.isError === true && fenced.acquired.length === 0;
    if (cql.startsWith("SELECT ")) {
      check(
        !fenceAnswered && text.startsWith(ENGINE) && UNAUTHORIZED.test(text.slice(ENGINE.length)),
        `boundary: the MCP fence admits ${cql}; the server refuses it as Unauthorized -> ${text}`,
      );
    } else {
      check(
        fenceAnswered && text.startsWith(NOT_SELECT),
        `boundary: the MCP fence refuses ${cql}; bypassed, the provider refuses it before it is sent -> ${text}`,
      );
    }
    const raw = await asRole(`${PREFIX}ro`, cql);
    check(
      "code" in raw && raw.code === 8448 && UNAUTHORIZED.test(raw.message),
      `boundary: sent as the role on a session of its own, refused as Unauthorized: ${cql} -> ${"code" in raw ? raw.message : "ran"}`,
    );
  }
  const use = await mcp(agent, { sql: `USE ${OTHER}` }, UNFENCED);
  check(lastTextOf(use.result).startsWith(NOT_SELECT), `boundary: a USE -> ${lastTextOf(use.result)}`);
  const second = await mcp(agent, { sql: `SELECT id FROM ${KS}.customers; DROP TABLE ${KS}.big` }, UNFENCED);
  check(
    lastTextOf(second.result).includes("this text goes on after its first statement's semicolon"),
    `boundary: a second statement -> ${lastTextOf(second.result)}`,
  );
  const crText = `SELECT id FROM ${KS}.customers -- x\rALTER ROLE ${PREFIX}ro WITH PASSWORD = 'not-a-real-password'`;
  const cr = await mcp(agent, { sql: crText }, UNFENCED);
  check(
    lastTextOf(cr.result).includes("carriage return inside a -- or // comment"),
    `boundary: a statement after a carriage return in a comment -> ${lastTextOf(cr.result)}`,
  );
  check((await stateHash()) === before, "boundary: the state hash is the same before and after");
  for (const template of WRITES) {
    const cql = template.replaceAll("@", SCRATCH);
    const ran = await admin(cql).then(
      () => "ran",
      (error: unknown) => (error as Error).message,
    );
    check(ran === "ran", `control: the superuser runs ${cql} -> ${ran}`);
  }

  // The read scope: the trace of the superuser's statement, which holds the marker, is there for the role to read.
  const tracer = new (await import("cassandra-driver")).Client({
    contactPoints: [`${HOST}:${PORT}`],
    localDataCenter: DATA_CENTRE,
    credentials: { username: ADMIN.user, password: ADMIN.password },
  });
  await tracer.connect();
  await tracer.execute(`SELECT v FROM ${OTHER}.t WHERE id = 1 AND v = '${MARKER}' ALLOW FILTERING`, [], {
    traceQuery: true,
  });
  await tracer.shutdown();
  await sleep(2_000);
  const traces = await asRole(`${PREFIX}ro`, "SELECT parameters FROM system_traces.sessions");
  check(
    "rows" in traces && JSON.stringify(traces.rows).includes(MARKER),
    `control: on a session of its own the role reads other sessions' traced statements -> ${"rows" in traces ? `${traces.rows.length} rows` : traces.message}`,
  );
  const local = await asRole(`${PREFIX}ro`, "SELECT release_version FROM system.local");
  check("rows" in local && local.rows.length === 1, "control: on a session of its own the role reads system.local");
  const roles = await asRole(`${PREFIX}ro`, "SELECT role FROM system_auth.roles");
  check(
    "code" in roles && roles.code === 8448,
    `control: the server refuses the role system_auth.roles -> ${"code" in roles ? roles.message : "read"}`,
  );
  for (const [cql, table] of OUT_OF_SCOPE) {
    for (const arm of [RUN_READ_QUERY, UNFENCED]) {
      const { result, acquired } = await mcp(agent, { sql: cql }, arm);
      const text = lastTextOf(result);
      check(
        acquired.join() === "agent-read-only" &&
          text ===
            `${SCOPE}${table}, so it was not sent. Name a table of the keyspace ${KS}, or of system_schema for the schema.` &&
          !textOf(result).includes(MARKER),
        `scope: ${arm === UNFENCED ? "bypassed, " : ""}${JSON.stringify(cql)} is refused before it is sent -> ${text}`,
      );
    }
  }
  const catalog = await mcp(agent, {
    sql: `SELECT column_name FROM system_schema.columns WHERE keyspace_name = '${KS}' AND table_name = 'customers'`,
  });
  check(
    catalog.result.structuredContent?.row_count === 2,
    `scope: the schema catalog answers -> ${catalog.result.structuredContent?.row_count ?? textOf(catalog.result)}`,
  );
  const unqualified = await mcp(agent, { sql: "SELECT id FROM customers" });
  check(
    unqualified.result.structuredContent?.row_count === 3,
    `scope: an unqualified table reads the connection's keyspace -> ${unqualified.result.structuredContent?.row_count ?? textOf(unqualified.result)}`,
  );

  // The forms.
  for (const cql of [
    `WITH x AS (SELECT id FROM ${KS}.customers) SELECT * FROM x`,
    "VALUES (1)",
    `TABLE ${KS}.customers`,
    `EXPLAIN SELECT id FROM ${KS}.customers`,
  ]) {
    const { result } = await mcp(agent, { sql: cql });
    const raw = await asRole(`${PREFIX}ro`, cql);
    check(
      lastTextOf(result).startsWith(NOT_SELECT) && "code" in raw && raw.code === 8192,
      `forms: ${cql} passes the MCP fence and the provider refuses it; the server answers it as a syntax error -> ${"code" in raw ? raw.message : "ran"}`,
    );
  }
  const json = await mcp(agent, { sql: `SELECT JSON id, name FROM ${KS}.customers WHERE id = 1` });
  check(json.result.structuredContent?.row_count === 1, "forms: a SELECT JSON answers");

  // The limits.
  const cut = await mcp(agent, { sql: `SELECT id FROM ${KS}.many`, max_rows: 5 });
  const page = cut.result.structuredContent as
    | { row_count: number; truncated_by: string; rows: { id: number }[]; hint: string; pagination: object }
    | undefined;
  check(
    page?.row_count === 5 &&
      page.truncated_by === "max_rows" &&
      (page.pagination as { nextOffset: unknown }).nextOffset === null &&
      page.hint.includes("WHERE token(the partition key) > token(the last one read)"),
    `limits: a read past max_rows is cut and names CQL's paging -> ${JSON.stringify(page?.pagination)} ${page?.hint}`,
  );
  const last = page?.rows.at(-1)?.id;
  const next = await mcp(agent, { sql: `SELECT id FROM ${KS}.many WHERE token(id) > token(${last})`, max_rows: 5 });
  const nextIds = (next.result.structuredContent?.rows as { id: number }[] | undefined)?.map((row) => row.id) ?? [];
  check(
    nextIds.length === 5 && !nextIds.some((id) => page?.rows.some((row) => row.id === id)),
    `limits: the token page the answer names reads the next rows -> ${nextIds.join(",")}`,
  );
  const clustered = await mcp(agent, { sql: `SELECT ck FROM ${KS}.events WHERE pk = 1 AND ck > 2 LIMIT 2` });
  check(
    JSON.stringify(clustered.result.structuredContent?.rows) === '[{"ck":3},{"ck":4}]',
    `limits: the clustering page the answer names reads the next rows -> ${JSON.stringify(clustered.result.structuredContent?.rows)}`,
  );
  const offset = await mcp(agent, { sql: `SELECT id FROM ${KS}.many`, offset: 5 });
  check(
    textOf(offset.result).startsWith("This engine's SQL has no OFFSET, so this query cannot be paged with offset."),
    `limits: an offset is refused -> ${textOf(offset.result)}`,
  );
  const rows = await mcp(agent, { sql: `SELECT id FROM ${KS}.many LIMIT 2000` });
  check(
    textOf(rows.result).startsWith("The result has more than 1000 rows") &&
      textOf(rows.result).includes("page it in SQL: LIMIT n, and for the next page"),
    `limits: rows past the provider budget -> ${textOf(rows.result)}`,
  );
  const bytes = await mcp(agent, { sql: `SELECT body FROM ${KS}.big` });
  check(
    textOf(bytes.result).startsWith("The result is larger than 1 MiB"),
    `limits: bytes past the provider budget -> ${textOf(bytes.result)}`,
  );
  const slowCql = `SELECT count(*) FROM ${KS}.slow WHERE v = 'none' ALLOW FILTERING`;
  const timedStart = Date.now();
  const slow = await mcp(agent, { sql: slowCql, timeout_ms: 500 });
  const timedFor = Date.now() - timedStart;
  const runsOnAfterTimeout = await stillRunning(`${KS}.slow`);
  const timeoutRunsFor = await endsAfter(`${KS}.slow`);
  check(
    textOf(slow.result) ===
      "The statement did not finish within timeout_ms (500 ms). Narrow it, or raise timeout_ms up to 30000.",
    `limits: past timeout_ms -> ${textOf(slow.result)} after ${timedFor} ms; the coordinator ${runsOnAfterTimeout ? `still runs it, for ${timeoutRunsFor} ms more` : "no longer lists it"}`,
  );
  await sleep(15_000);
  const controller = new AbortController();
  const cancelled = mcp(agent, { sql: slowCql, timeout_ms: 30_000 }, RUN_READ_QUERY, controller.signal);
  await sleep(600);
  controller.abort();
  const cancelledAt = Date.now();
  const cancelAnswer = await cancelled;
  const answeredIn = Date.now() - cancelledAt;
  const runsOnAfterCancel = await stillRunning(`${KS}.slow`);
  const cancelRunsFor = await endsAfter(`${KS}.slow`);
  check(
    cancelAnswer.result.isError === true && answeredIn < 500,
    `limits: a cancel ends the wait -> ${textOf(cancelAnswer.result)} ${answeredIn} ms after it; the coordinator ${runsOnAfterCancel ? `still runs it, for ${cancelRunsFor} ms more` : "no longer lists it"}`,
  );

  // The engine gates.
  const allowPort = process.env.LIBREDB_LIVE_CASSANDRA_ALLOW_ALL_PORT;
  if (allowPort !== undefined && allowPort !== "") {
    const allowAdmin = new CassandraDriverTransport(seed(ADMIN.user, ADMIN.password, Number(allowPort), ""), 60_000);
    await allowAdmin.connect();
    await allowAdmin.execute(
      `CREATE KEYSPACE IF NOT EXISTS ${KS} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`,
    );
    await allowAdmin.execute(`CREATE TABLE IF NOT EXISTS ${KS}.customers (id int PRIMARY KEY, name text)`);
    await allowAdmin.execute(`CREATE ROLE IF NOT EXISTS ${PREFIX}ro WITH LOGIN = true AND PASSWORD = '${PASSWORD}'`);
    const { result } = await mcp(seed(`${PREFIX}ro`, PASSWORD, Number(allowPort)), {
      sql: `SELECT id FROM ${KS}.customers`,
    });
    check(
      textOf(result).startsWith(
        "run_read_query cannot run on this connection: The agent read-only execution profile ",
      ) &&
        textOf(result).includes(
          "needs a server that enforces its roles' grants (PasswordAuthenticator and CassandraAuthorizer)",
        ),
      `gates: AllowAllAuthorizer is refused at open through MCP -> ${textOf(result)}`,
    );
    await allowAdmin.execute(`DROP KEYSPACE IF EXISTS ${KS}`);
    await allowAdmin.execute(`DROP ROLE IF EXISTS ${PREFIX}ro`);
    await allowAdmin.close();
  }
  const scyllaPort = process.env.LIBREDB_LIVE_SCYLLA_PORT;
  if (scyllaPort !== undefined && scyllaPort !== "") {
    const { result } = await mcp(seed("not-a-real-role", "not-a-real-password", Number(scyllaPort), "system"), {
      sql: "SELECT release_version FROM system.local",
    });
    check(
      textOf(result).startsWith(
        "run_read_query cannot run on this connection: The agent read-only execution profile ",
      ) && textOf(result).includes("Apache Cassandra 5.0 only"),
      `gates: ScyllaDB is refused at open through MCP -> ${textOf(result)}`,
    );
  }
}

try {
  await main();
} finally {
  await clearProviderCache();
  await cleanup();
  // Assigned inside `admin()`, which the compiler does not follow from here.
  await (adminTransport as CassandraDriverTransport | null)?.close();
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
