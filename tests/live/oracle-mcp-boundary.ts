/**
 * Live check of MCP's `run_read_query` on Oracle, against a server of the operator's choosing.
 *
 * WHY THIS EXISTS. `run_read_query` serves Oracle through the same boundary agent mode does: the connection is
 * acquired under the agent read-only profile, and every statement goes through the provider's `queryReadOnly`, which
 * opens a session of its own, `SET TRANSACTION READ ONLY`, checks the user on that session (`agent-read.ts`) and then
 * sends the statement. The MCP fence in front of it is defence in depth. So this script replays the agent boundary
 * check (`tests/live/oracle-agent-boundary.ts`) through the MCP tool's own handler (`runStatement`) with that fence
 * removed, against a real server:
 *
 *  - the principal, through MCP: the READ ONLY user holding `CREATE SESSION`, `SELECT` on one table and the two policy
 *    catalogs is served; SYSTEM, a READ WRITE user, a user holding `EXECUTE` on a definer's-rights function, the
 *    `CONNECT`, `DBA`, `SELECT_CATALOG_ROLE` or `AUDIT_VIEWER` role, `SELECT ANY TABLE`, `READ ANY TABLE`,
 *    `SELECT ANY DICTIONARY`, `SELECT` on `SYS.USER$` or on a sequence, a role of the operator's holding
 *    `SELECT ANY DICTIONARY` or `SELECT` on `SYS.USER$`, and any user while a PUBLIC database link exists, are each
 *    refused before the statement is sent, in the tool's sentence, naming what lifts it;
 *  - the data scope: each refused user is shown to read, signed in directly, what the check keeps from it (the
 *    dictionary, the audit trail, another schema's table), and the served user is refused each of those through MCP by
 *    the server's own ORA-00942, in every spelling (qualified, quoted, lower case, a PUBLIC synonym), while what PUBLIC
 *    may read answers;
 *  - the boundary, with the MCP fence bypassed: each write, DDL, temporary table, lock, PL/SQL write, transaction
 *    statement, grant, `ALTER SYSTEM`, `EXPLAIN PLAN` and second statement is sent as the served user through the MCP
 *    handler and refused by Oracle with the code its record names, never a connection error; the same writes run as
 *    the schema owner on its own scratch objects, the positive control; a snapshot of the table rows, the sequence,
 *    `open_cursors`, the owner's objects and the links reads the same before and after;
 *  - the limits: a read answers its rows and pages with `offset`; one past the 1000-row provider budget and one past
 *    the 1 MiB budget are refused, never cut; one past `timeout_ms` is answered as the timeout.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it, as the agent check, against a
 * disposable server whose SYS and SYSTEM passwords are the one given and whose pluggable database holds the schema
 * owner APP_OWNER, which `gvenzl/oracle-free` creates from `APP_USER` (see that script's docblock for the container):
 *
 *   LIBREDB_LIVE_ORACLE_PORT=15217 LIBREDB_LIVE_ORACLE_PASSWORD=not-a-real-password bun tests/live/oracle-mcp-boundary.ts
 *
 * It revokes PUBLIC's EXECUTE on the network and file packages, as the agent check does, and does not grant it back.
 * Every other user, role, object and link it creates carries the `LIBREDB_LM_` prefix and is dropped on exit. Each
 * check prints one line, no credential among them, and any failure ends the run non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import oracledb from "oracledb";
import { acquireExecutionProfileProvider, clearProviderCache, type ExecutionProfile } from "@/lib/db/factory";
import type { McpConnectionContext } from "@/lib/mcp/context";
import { MCP_UNTRUSTED_NOTICE, type ToolResult } from "@/lib/mcp/output";
import { runStatement, type McpStatementInput } from "@/lib/mcp/tools/run-statement";
import { mcpStatementArm, type McpStatementArm } from "@/lib/mcp/tools/statement-arms";
import type { ManagedConnection } from "@/lib/seed";

const PREFIX = "LIBREDB_LM_";
const RO = `${PREFIX}RO`;
const OWNER = "APP_OWNER";
const DATA = `${OWNER}.${PREFIX}DATA`;
const SECRET = `${OWNER}.${PREFIX}SECRET`;

function env(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    console.error(`set ${name}: this script writes to the server it is pointed at, so it has no default`);
    process.exit(2);
  }
  return value;
}

const HOST = process.env.LIBREDB_LIVE_ORACLE_HOST ?? "127.0.0.1";
const PORT = Number(env("LIBREDB_LIVE_ORACLE_PORT"));
const PASSWORD = env("LIBREDB_LIVE_ORACLE_PASSWORD");
const SERVICE = process.env.LIBREDB_LIVE_ORACLE_SERVICE ?? "FREEPDB1";
const CONNECT_STRING = `${HOST}:${PORT}/${SERVICE}`;

/** The tool as MCP registers it, and the same tool with its statement fence removed: the boundary under test. */
const RUN_READ_QUERY = mcpStatementArm("run_read_query");
const UNFENCED: McpStatementArm = { ...RUN_READ_QUERY, fence: () => null };

let failures = 0;
function check(ok: boolean, line: string): void {
  // A line never carries the password: a check that would print it fails instead.
  const safe = !line.includes(PASSWORD);
  console.log(`${ok && safe ? "PASS" : "FAIL"} ${safe ? line : "(line withheld: it named a credential)"}`);
  if (!ok || !safe) failures++;
}

function signIn(user: string): Promise<oracledb.Connection> {
  return oracledb.getConnection({
    user,
    password: PASSWORD,
    connectString: CONNECT_STRING,
    ...(user === "SYS" ? { privilege: oracledb.SYSDBA } : {}),
  });
}

/** Runs `sql` as `user` on a connection of its own, SYS as SYSDBA, answering the rows. */
async function as(user: string, sql: string): Promise<Record<string, unknown>[]> {
  const conn = await signIn(user);
  try {
    const result = await conn.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: true });
    return (result.rows ?? []) as Record<string, unknown>[];
  } finally {
    await conn.close();
  }
}

/**
 * Runs each statement as `user` on one connection, ignoring the ORA- codes named, so a setup step can run twice. One
 * connection for the whole list: a server process per statement outruns a small database's process limit (ORA-12516).
 */
async function setup(user: string, statements: readonly string[], ignore: readonly string[] = []): Promise<void> {
  const conn = await signIn(user);
  try {
    for (const sql of statements) {
      try {
        await conn.execute(sql, [], { autoCommit: true });
      } catch (error) {
        if (!ignore.some((code) => (error as Error).message.includes(code))) throw error;
      }
    }
  } finally {
    await conn.close();
  }
}

/** What `sql` answers signed in as `user` directly, outside Studio: its first row, or the ORA- code it was refused. */
async function direct(user: string, sql: string): Promise<string> {
  try {
    return JSON.stringify((await as(user, sql))[0]);
  } catch (error) {
    return /ORA-\d{5}/.exec((error as Error).message)?.[0] ?? "error";
  }
}

function seed(user: string): ManagedConnection {
  return {
    id: `seed:live-${user.toLowerCase()}`,
    name: user,
    seedId: `live-${user.toLowerCase()}`,
    managed: true,
    mcp: true,
    roles: ["*"],
    type: "oracle",
    host: HOST,
    port: PORT,
    serviceName: SERVICE,
    user,
    password: PASSWORD,
    createdAt: new Date(),
  } as ManagedConnection;
}

/** One MCP call as `user`, through the factory's own profiled acquisition, as the route makes it. */
async function mcp(
  user: string,
  args: Partial<McpStatementInput> & { readonly sql: string },
  arm: McpStatementArm = UNFENCED,
): Promise<{ readonly result: ToolResult; readonly acquired: ExecutionProfile[] }> {
  const connection = seed(user);
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

/** The answer's last text block: the refusal, or the database's error after the untrusted-data notice. */
const textOf = (result: ToolResult): string => {
  const last = result.content.at(-1);
  return last !== undefined && "text" in last ? last.text : "";
};

/** The ORA- code of an MCP answer that is the database's own refusal, or null when it is not one. */
function engineCodeOf(result: ToolResult): string | null {
  const match = /^The database refused or failed the call: (?:[\s\S]*?)(ORA-\d{5})/.exec(textOf(result));
  return result.isError === true && match !== null ? match[1] : null;
}

/** The ORA- codes of an MCP answer that is the database's own refusal, every one, in order. */
function engineCodesOf(result: ToolResult): string[] {
  const text = textOf(result);
  return result.isError === true && text.startsWith("The database refused or failed the call: ")
    ? [...text.matchAll(/ORA-\d{5}/g)].map((match) => match[0])
    : [];
}

const REFUSAL_OPENING = "run_read_query cannot run on this connection: The agent read-only execution profile refuses";

/** PUBLIC's grants the fresh database holds that the check refuses, as the agent check revokes them. */
const REVOKES_AS_SYS: readonly string[] = [
  "SYS.UTL_HTTP",
  "SYS.UTL_TCP",
  "SYS.UTL_SMTP",
  "SYS.UTL_FILE",
  "SYS.UTL_INADDR",
  "SYS.HTTPURITYPE",
  "SYS.DBMS_LDAP",
  "SYS.DBMS_SCHEDULER",
  "XDB.DBMS_XSLPROCESSOR",
  "SYS.SCHEDULER$NTFY_SVC_METRICS",
  "XDB.XMLINDEX",
  "XDB.XMLINDEX_NOOP",
]
  .map((name) => `REVOKE EXECUTE ON ${name} FROM PUBLIC`)
  .concat(
    `BEGIN DBMS_RULE_ADM.REVOKE_OBJECT_PRIVILEGE(DBMS_RULE_ADM.EXECUTE_ON_EVALUATION_CONTEXT, '"SYS"."STREAMS$_EVALUATION_CONTEXT"', 'PUBLIC'); END;`,
  );

/**
 * The users the check must refuse, each with the grants (run as SYS) that make it so, the words its refusal must
 * carry, and a read it makes signed in directly that the check keeps from it, with what that read answers there.
 */
const REFUSED: readonly {
  readonly name: string;
  readonly grants: readonly string[];
  readonly says: string;
  readonly reads?: { readonly sql: string; readonly answers: RegExp };
  readonly readWrite?: boolean;
}[] = [
  { name: "RW", grants: [], says: `ALTER USER "${PREFIX}RW" READ ONLY`, readWrite: true },
  {
    name: "DEF",
    grants: [`GRANT EXECUTE ON ${OWNER}.${PREFIX}NEXT TO {u}`],
    says: `REVOKE EXECUTE ON "${OWNER}"."${PREFIX}NEXT" FROM "${PREFIX}DEF"`,
  },
  { name: "CONN", grants: ["GRANT CONNECT TO {u}"], says: 'REVOKE SET CONTAINER FROM "CONNECT"' },
  {
    name: "DBA",
    grants: ["GRANT DBA TO {u}"],
    says: "it holds a system privilege beyond CREATE SESSION",
    reads: { sql: "SELECT COUNT(*) AS N FROM SYS.DBA_USERS", answers: /^\{"N":\d+\}$/ },
  },
  {
    name: "CAT",
    grants: ["GRANT SELECT_CATALOG_ROLE TO {u}"],
    says: `REVOKE "SELECT_CATALOG_ROLE" FROM "${PREFIX}CAT"`,
    reads: { sql: "SELECT COUNT(*) AS N FROM SYS.DBA_USERS", answers: /^\{"N":\d+\}$/ },
  },
  {
    name: "AUDV",
    grants: ["GRANT AUDIT_VIEWER TO {u}"],
    says: `REVOKE "AUDIT_VIEWER" FROM "${PREFIX}AUDV"`,
    reads: { sql: "SELECT COUNT(*) AS N FROM AUDSYS.UNIFIED_AUDIT_TRAIL", answers: /^\{"N":\d+\}$/ },
  },
  {
    name: "USERD",
    grants: ["GRANT SELECT ON SYS.USER$ TO {u}"],
    says: `REVOKE SELECT ON "SYS"."USER$" FROM "${PREFIX}USERD"`,
    reads: { sql: "SELECT COUNT(*) AS N FROM SYS.USER$", answers: /^\{"N":\d+\}$/ },
  },
  {
    name: "SAT",
    grants: ["GRANT SELECT ANY TABLE TO {u}"],
    says: `REVOKE SELECT ANY TABLE FROM "${PREFIX}SAT"`,
    reads: { sql: `SELECT COUNT(*) AS N FROM ${SECRET}`, answers: /^\{"N":1\}$/ },
  },
  {
    name: "RAT",
    grants: ["GRANT READ ANY TABLE TO {u}"],
    says: `REVOKE READ ANY TABLE FROM "${PREFIX}RAT"`,
    reads: { sql: `SELECT COUNT(*) AS N FROM ${SECRET}`, answers: /^\{"N":1\}$/ },
  },
  {
    name: "SEQ",
    grants: [`GRANT SELECT ON ${OWNER}.${PREFIX}SEQ TO {u}`],
    says: `REVOKE ALL ON "${OWNER}"."${PREFIX}SEQ" FROM "${PREFIX}SEQ"`,
  },
  // The same reach through a role of the operator's: a system privilege, and an object grant on Oracle's own schema.
  {
    name: "RSAD",
    grants: [
      `CREATE ROLE ${PREFIX}R_SAD`,
      `GRANT SELECT ANY DICTIONARY TO ${PREFIX}R_SAD`,
      `GRANT ${PREFIX}R_SAD TO {u}`,
    ],
    says: `REVOKE SELECT ANY DICTIONARY FROM "${PREFIX}R_SAD"`,
    reads: { sql: "SELECT COUNT(*) AS N FROM SYS.DBA_USERS", answers: /^\{"N":\d+\}$/ },
  },
  {
    name: "ROBJ",
    grants: [
      `CREATE ROLE ${PREFIX}R_OBJ`,
      `GRANT SELECT ON SYS.USER$ TO ${PREFIX}R_OBJ`,
      `GRANT ${PREFIX}R_OBJ TO {u}`,
    ],
    says: `REVOKE "${PREFIX}R_OBJ" FROM "${PREFIX}ROBJ"`,
    reads: { sql: "SELECT COUNT(*) AS N FROM SYS.USER$", answers: /^\{"N":\d+\}$/ },
  },
  {
    name: "SAD",
    grants: ["GRANT SELECT ANY DICTIONARY TO {u}"],
    says: `REVOKE SELECT ANY DICTIONARY FROM "${PREFIX}SAD"`,
    reads: { sql: "SELECT COUNT(*) AS N FROM SYS.DBA_USERS", answers: /^\{"N":\d+\}$/ },
  },
];

/** What the served user may not read, in each spelling, refused by the server itself; and what PUBLIC may read. */
const OUT_OF_SCOPE: readonly string[] = [
  "SELECT COUNT(*) AS N FROM SYS.USER$",
  'SELECT COUNT(*) AS N FROM "SYS"."USER$"',
  "SELECT COUNT(*) AS N FROM sys.user$",
  `SELECT COUNT(*) AS N FROM ${PREFIX}USER_SYN`,
  "SELECT COUNT(*) AS N FROM DBA_USERS",
  "SELECT COUNT(*) AS N FROM SYS.DBA_USERS",
  "SELECT COUNT(*) AS N FROM SYS.LINK$",
  "SELECT COUNT(*) AS N FROM V$SESSION",
  "SELECT COUNT(*) AS N FROM SYS.V_$SQL",
  "SELECT COUNT(*) AS N FROM X$KSPPI",
  "SELECT COUNT(*) AS N FROM SYS.AUD$",
  "SELECT COUNT(*) AS N FROM UNIFIED_AUDIT_TRAIL",
  "SELECT COUNT(*) AS N FROM SYS.DBA_SOURCE",
  `SELECT COUNT(*) AS N FROM ${SECRET}`,
  `SELECT COUNT(*) AS N FROM "${OWNER}"."${PREFIX}SECRET"`,
];
const PUBLIC_READS: readonly string[] = ["SELECT COUNT(*) AS N FROM ALL_USERS", "SELECT COUNT(*) AS N FROM V$VERSION"];

/**
 * The writes and the other statements the boundary must refuse, sent as the served user with the fence removed, each
 * with the code Oracle answers and, where it differs, the same statement as the owner sends it on its own objects.
 */
const BOUNDARY: readonly { readonly sql: string; readonly code: string; readonly owner?: string }[] = [
  {
    sql: `INSERT INTO ${OWNER}.${PREFIX}SCRATCH VALUES (1)`,
    code: "ORA-28194",
    owner: `INSERT INTO ${PREFIX}SCRATCH VALUES (1)`,
  },
  {
    sql: `UPDATE ${OWNER}.${PREFIX}SCRATCH SET ID = 2`,
    code: "ORA-28194",
    owner: `UPDATE ${PREFIX}SCRATCH SET ID = 2`,
  },
  { sql: `DELETE FROM ${OWNER}.${PREFIX}SCRATCH`, code: "ORA-28194", owner: `DELETE FROM ${PREFIX}SCRATCH` },
  {
    sql: `MERGE INTO ${OWNER}.${PREFIX}SCRATCH s USING DUAL ON (1 = 0) WHEN NOT MATCHED THEN INSERT (ID) VALUES (3)`,
    code: "ORA-28194",
    owner: `MERGE INTO ${PREFIX}SCRATCH s USING DUAL ON (1 = 0) WHEN NOT MATCHED THEN INSERT (ID) VALUES (3)`,
  },
  {
    sql: `CREATE TABLE ${OWNER}.${PREFIX}NEW (ID NUMBER)`,
    code: "ORA-28194",
    owner: `CREATE TABLE ${PREFIX}NEW (ID NUMBER)`,
  },
  {
    sql: `CREATE GLOBAL TEMPORARY TABLE ${OWNER}.${PREFIX}GTT (ID NUMBER)`,
    code: "ORA-28194",
    owner: `CREATE GLOBAL TEMPORARY TABLE ${PREFIX}GTT (ID NUMBER)`,
  },
  // The tool pages a SELECT with no row limiting clause of its own, so FETCH FIRST lands after FOR UPDATE, which the
  // parser refuses; with a clause of its own the statement reaches the server whole, and READ ONLY refuses it.
  { sql: `SELECT ID FROM ${OWNER}.${PREFIX}SCRATCH FOR UPDATE`, code: "ORA-03049" },
  {
    sql: `SELECT ID FROM ${OWNER}.${PREFIX}SCRATCH WHERE ROWNUM <= 5 FOR UPDATE`,
    code: "ORA-28194",
    owner: `SELECT ID FROM ${PREFIX}SCRATCH WHERE ROWNUM <= 5 FOR UPDATE`,
  },
  {
    sql: `LOCK TABLE ${OWNER}.${PREFIX}SCRATCH IN EXCLUSIVE MODE`,
    code: "ORA-28194",
    owner: `LOCK TABLE ${PREFIX}SCRATCH IN EXCLUSIVE MODE`,
  },
  {
    sql: `DECLARE n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM ${DATA}; INSERT INTO ${OWNER}.${PREFIX}SCRATCH VALUES (n); END;`,
    code: "ORA-28194",
    owner: `DECLARE n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM ${PREFIX}DATA; INSERT INTO ${PREFIX}SCRATCH VALUES (n); END;`,
  },
  {
    sql: `BEGIN EXECUTE IMMEDIATE 'ALTER SESSION SET READ_ONLY = FALSE'; INSERT INTO ${OWNER}.${PREFIX}SCRATCH VALUES (4); END;`,
    code: "ORA-65023",
    owner: `BEGIN EXECUTE IMMEDIATE 'ALTER SESSION SET READ_ONLY = FALSE'; INSERT INTO ${PREFIX}SCRATCH VALUES (4); END;`,
  },
  { sql: "COMMIT", code: "ORA-28194", owner: "COMMIT" },
  { sql: "ROLLBACK", code: "ORA-28194", owner: "ROLLBACK" },
  { sql: `GRANT SELECT ON ${DATA} TO PUBLIC`, code: "ORA-28194" },
  { sql: "ALTER SYSTEM SET OPEN_CURSORS = 333", code: "ORA-01031" },
  { sql: `SELECT 1 FROM DUAL; DELETE FROM ${OWNER}.${PREFIX}SCRATCH`, code: "ORA-03405" },
  { sql: "ALTER SESSION SET EDITION = ORA$BASE", code: "ORA-38814" },
  // EXPLAIN PLAN writes its rows into PLAN_TABLE, which the call's read-only transaction refuses.
  { sql: "EXPLAIN PLAN FOR SELECT 1 FROM DUAL", code: "ORA-01456" },
];

async function snapshot(): Promise<string> {
  const [rows] = await as(
    "SYSTEM",
    `SELECT (SELECT COUNT(*) FROM ${DATA}) AS DATA_ROWS, (SELECT COUNT(*) FROM ${OWNER}.${PREFIX}SCRATCH) AS SCRATCH_ROWS, ` +
      `(SELECT LAST_NUMBER FROM DBA_SEQUENCES WHERE SEQUENCE_OWNER = '${OWNER}' AND SEQUENCE_NAME = '${PREFIX}SEQ') AS SEQ, ` +
      "(SELECT VALUE FROM V$PARAMETER WHERE NAME = 'open_cursors') AS OPEN_CURSORS, " +
      `(SELECT COUNT(*) FROM DBA_OBJECTS WHERE OWNER IN ('${OWNER}', '${RO}')) AS OBJECTS, ` +
      `(SELECT COUNT(*) FROM DBA_TAB_PRIVS WHERE GRANTEE = 'PUBLIC' AND OWNER = '${OWNER}') AS PUBLIC_GRANTS, ` +
      "(SELECT COUNT(*) FROM DBA_DB_LINKS) AS LINKS FROM DUAL",
  );
  return JSON.stringify(rows);
}

const USERS = ["RO", ...REFUSED.map((user) => user.name)].map((name) => `${PREFIX}${name}`);

async function cleanup(): Promise<void> {
  await clearProviderCache();
  await setup(
    "SYS",
    [
      ...USERS.map((user) => `DROP USER ${user} CASCADE`),
      `DROP ROLE ${PREFIX}R_SAD`,
      `DROP ROLE ${PREFIX}R_OBJ`,
      `DROP PUBLIC SYNONYM ${PREFIX}USER_SYN`,
      `DROP PUBLIC DATABASE LINK ${PREFIX}LINK`,
      `DROP FUNCTION ${OWNER}.${PREFIX}NEXT`,
      `DROP SEQUENCE ${OWNER}.${PREFIX}SEQ`,
      `DROP TABLE ${DATA} PURGE`,
      `DROP TABLE ${SECRET} PURGE`,
      `DROP TABLE ${OWNER}.${PREFIX}SCRATCH PURGE`,
      `DROP TABLE ${OWNER}.${PREFIX}NEW PURGE`,
      `DROP TABLE ${OWNER}.${PREFIX}GTT PURGE`,
    ],
    ["ORA-"],
  );
}

async function seedServer(): Promise<void> {
  await cleanup();
  await setup("SYS", REVOKES_AS_SYS, ["ORA-01927"]);
  await setup("SYSTEM", [
    `CREATE TABLE ${DATA} (ID NUMBER PRIMARY KEY, DOC CLOB)`,
    `INSERT INTO ${DATA} (ID, DOC) SELECT LEVEL, TO_CLOB('row ' || LEVEL) FROM DUAL CONNECT BY LEVEL <= 1200`,
    `CREATE TABLE ${SECRET} (ID NUMBER)`,
    `INSERT INTO ${SECRET} VALUES (42)`,
    `CREATE TABLE ${OWNER}.${PREFIX}SCRATCH (ID NUMBER)`,
    `CREATE SEQUENCE ${OWNER}.${PREFIX}SEQ NOCACHE`,
    `CREATE OR REPLACE FUNCTION ${OWNER}.${PREFIX}NEXT RETURN NUMBER AS BEGIN RETURN ${OWNER}.${PREFIX}SEQ.NEXTVAL; END;`,
    `CREATE OR REPLACE PUBLIC SYNONYM ${PREFIX}USER_SYN FOR SYS.USER$`,
  ]);
  for (const user of USERS) {
    await setup("SYSTEM", [
      `CREATE USER ${user} IDENTIFIED BY "${PASSWORD}"`,
      `GRANT CREATE SESSION TO ${user}`,
      `GRANT SELECT ON ${DATA} TO ${user}`,
      // The writes the boundary sends are granted, so READ ONLY, not a missing grant, is what refuses them.
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ${OWNER}.${PREFIX}SCRATCH TO ${user}`,
    ]);
    await setup("SYS", [
      `GRANT SELECT ON SYS.DBA_POLICIES TO ${user}`,
      `GRANT SELECT ON SYS.DBA_AUDIT_POLICIES TO ${user}`,
    ]);
  }
  for (const user of REFUSED) {
    await setup(
      "SYS",
      user.grants.map((grant) => grant.replaceAll("{u}", `${PREFIX}${user.name}`)),
    );
  }
  for (const user of USERS.filter((name) => name !== `${PREFIX}RW`)) {
    await setup("SYSTEM", [`ALTER USER ${user} READ ONLY`]);
  }
}

async function main(): Promise<void> {
  await seedServer();

  // The principal, through MCP: the served user, then every user the check refuses, each before its statement.
  const served = await mcp(RO, { sql: `SELECT ID FROM ${DATA} ORDER BY ID FETCH FIRST 3 ROWS ONLY` }, RUN_READ_QUERY);
  check(
    served.result.isError === undefined &&
      JSON.stringify(served.result.structuredContent?.rows) === '[{"ID":1},{"ID":2},{"ID":3}]' &&
      served.acquired.join() === "agent-read-only",
    `principal: ${RO}, READ ONLY with SELECT on one table and the two policy catalogs, is served under agent-read-only -> ${JSON.stringify(served.result.structuredContent?.rows)}`,
  );
  for (const user of [{ name: "SYSTEM", says: 'ALTER USER "SYSTEM" READ ONLY' }, ...REFUSED]) {
    const name = user.name === "SYSTEM" ? "SYSTEM" : `${PREFIX}${user.name}`;
    if ("reads" in user && user.reads !== undefined) {
      const raw = await direct(name, user.reads.sql);
      check(user.reads.answers.test(raw), `data scope: ${name}, signed in directly, reads ${user.reads.sql} -> ${raw}`);
    }
    const { result, acquired } = await mcp(name, { sql: `SELECT COUNT(*) AS N FROM ${DATA}` }, RUN_READ_QUERY);
    const text = textOf(result);
    check(
      result.isError === true &&
        acquired.join() === "agent-read-only" &&
        result.content.length === 2 &&
        result.content[0]?.text === MCP_UNTRUSTED_NOTICE &&
        text.startsWith(`${REFUSAL_OPENING} the Oracle user ${name}: `) &&
        text.includes(user.says),
      `principal: ${name} is refused through MCP before its statement, behind the untrusted notice, naming ${user.says} -> ${text}`,
    );
    await clearProviderCache();
  }
  await setup("SYSTEM", [
    `CREATE PUBLIC DATABASE LINK ${PREFIX}LINK CONNECT TO ${OWNER} IDENTIFIED BY "${PASSWORD}" USING '${CONNECT_STRING}'`,
  ]);
  const linked = await mcp(RO, { sql: "SELECT 1 AS N FROM DUAL" }, RUN_READ_QUERY);
  check(
    linked.result.content[0]?.text === MCP_UNTRUSTED_NOTICE &&
      textOf(linked.result).startsWith(`${REFUSAL_OPENING} the Oracle user ${RO}: `) &&
      textOf(linked.result).includes(`DROP PUBLIC DATABASE LINK "${PREFIX}LINK"`),
    `principal: while a PUBLIC database link exists the served user is refused through MCP -> ${textOf(linked.result)}`,
  );
  await setup("SYSTEM", [`DROP PUBLIC DATABASE LINK ${PREFIX}LINK`]);
  const relinked = await mcp(RO, { sql: "SELECT 1 AS N FROM DUAL" }, RUN_READ_QUERY);
  check(relinked.result.isError === undefined, "principal: with the link dropped the next call is served");

  // The data scope of the served user: what the check keeps from the others, the server keeps from it.
  for (const sql of OUT_OF_SCOPE) {
    const { result } = await mcp(RO, { sql });
    const code = engineCodeOf(result);
    check(code === "ORA-00942", `data scope: the served user is refused ${sql} by the server -> ${code}`);
  }
  for (const sql of PUBLIC_READS) {
    const { result } = await mcp(RO, { sql }, RUN_READ_QUERY);
    check(
      result.isError === undefined && result.structuredContent?.row_count === 1,
      `data scope: what PUBLIC may read answers the served user: ${sql} -> ${JSON.stringify(result.structuredContent?.rows)}`,
    );
  }

  // The boundary, the MCP fence bypassed, with the state compared before and after.
  const before = await snapshot();
  for (const { sql, code } of BOUNDARY) {
    const fenced = await mcp(RO, { sql }, RUN_READ_QUERY);
    const fenceAdmits = fenced.acquired.length > 0;
    const { result } = await mcp(RO, { sql });
    const codes = engineCodesOf(result);
    check(
      codes.includes(code),
      `boundary: the MCP fence ${fenceAdmits ? "admits" : "refuses"} ${sql}; bypassed, Oracle refuses it -> ${codes.join(" ") || textOf(result)}`,
    );
  }
  const after = await snapshot();
  check(before === after, `boundary: the snapshot is the same before and after -> ${before} / ${after}`);

  // The positive control: the same writes, as the writable schema owner, on its own objects.
  for (const { owner } of BOUNDARY) {
    if (owner === undefined) continue;
    let answer = "ran";
    try {
      await as(OWNER, owner);
    } catch (error) {
      answer = /ORA-\d{5}/.exec((error as Error).message)?.[0] ?? "error";
    }
    check(answer === "ran", `control: the writable owner runs ${owner} -> ${answer}`);
  }

  // The forms Oracle does not take, answered as the database's.
  for (const [sql, code] of [
    ["VALUES (1)", "ORA-00900"],
    [`TABLE ${DATA}`, "ORA-00900"],
    ["EXPLAIN SELECT 1 FROM DUAL", "ORA-02000"],
  ] as const) {
    const { result } = await mcp(RO, { sql }, RUN_READ_QUERY);
    check(
      engineCodeOf(result) === code,
      `forms: ${sql} passes the fence and Oracle answers ${code} -> ${engineCodeOf(result)}`,
    );
  }

  // The limits.
  const page = await mcp(RO, { sql: `SELECT ID FROM ${DATA} ORDER BY ID`, max_rows: 5, offset: 5 }, RUN_READ_QUERY);
  check(
    JSON.stringify(page.result.structuredContent?.rows) === '[{"ID":6},{"ID":7},{"ID":8},{"ID":9},{"ID":10}]' &&
      JSON.stringify(page.result.structuredContent?.pagination) ===
        '{"offset":5,"limit":5,"hasMore":true,"nextOffset":10,"wasLimited":true}',
    `limits: a read pages with offset -> ${JSON.stringify(page.result.structuredContent?.pagination)}`,
  );
  const own = await mcp(RO, { sql: `SELECT ID FROM ${DATA} FETCH FIRST 3 ROWS ONLY`, offset: 1 }, RUN_READ_QUERY);
  check(
    textOf(own.result) ===
      "This query has its own FETCH FIRST, OFFSET ... FETCH or ROWNUM, so it cannot be paged with offset. Remove it and page with offset, or page it in SQL: ORDER BY ... OFFSET m ROWS FETCH NEXT n ROWS ONLY." &&
      own.result.isError === true,
    `limits: an offset on a query with its own row limiting clause is refused before it is sent -> ${textOf(own.result)}`,
  );
  const rows = await mcp(RO, { sql: `SELECT ID FROM ${DATA} FETCH FIRST 1001 ROWS ONLY` }, RUN_READ_QUERY);
  check(
    textOf(rows.result) ===
      "The result has more than 1000 rows, the most this server reads for one call. Add FETCH FIRST n ROWS ONLY with n of 1000 or less, or remove your own FETCH FIRST, OFFSET ... FETCH or ROWNUM and page with offset.",
    `limits: rows past the provider budget -> ${textOf(rows.result)}`,
  );
  const bytes = await mcp(
    RO,
    {
      sql: `SELECT TO_CLOB(RPAD('x', 4000, 'x')) || RPAD('y', 4000, 'y') || RPAD('z', 4000, 'z') AS DOC FROM ${DATA} FETCH FIRST 200 ROWS ONLY`,
    },
    RUN_READ_QUERY,
  );
  check(
    textOf(bytes.result) ===
      "The result is larger than 1 MiB, the most this server reads for one call. Select fewer or narrower columns, or add FETCH FIRST n ROWS ONLY with a smaller n.",
    `limits: bytes past the provider budget -> ${textOf(bytes.result)}`,
  );
  const slow = await mcp(
    RO,
    { sql: "SELECT COUNT(*) AS N FROM SYS.ALL_OBJECTS a, SYS.ALL_OBJECTS b, SYS.ALL_OBJECTS c", timeout_ms: 2_000 },
    RUN_READ_QUERY,
  );
  check(
    textOf(slow.result) ===
      "The statement did not finish within timeout_ms (2000 ms). Narrow it, or raise timeout_ms up to 30000.",
    `limits: past timeout_ms -> ${textOf(slow.result)}`,
  );
  const next = await mcp(RO, { sql: "SELECT 1 AS N FROM DUAL" }, RUN_READ_QUERY);
  check(next.result.isError === undefined, "limits: the next call after the timeout is served");
}

try {
  await main();
} finally {
  await cleanup();
}
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
