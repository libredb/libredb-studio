/**
 * Live check of the Oracle agent read-only execution profile, against a server of the operator's choosing.
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The boundary is the server's: a user set READ ONLY, which Oracle
 * refuses every write for, and a check at first use that the user reaches nothing READ ONLY leaves open
 * (`agent-read.ts`). The provider suite replays answers its author wrote; whether the server refuses a statement, and
 * what the dictionary views list for a user, is the server's to say. So this script asks a real server through the
 * production path (`createDatabaseProvider` with the profile's execution context, then `connect` and `queryReadOnly`):
 *
 *  - the fresh database refuses its own read-only user, because PUBLIC holds EXECUTE on the network and file
 *    packages and the user may not read the policy and auditing catalog; the revoke script and the two catalog grants
 *    the refusal names, run as SYS, lift it;
 *  - the check refuses a user that is not READ ONLY, one granted EXECUTE on a definer's-rights function, one granted a
 *    view that calls it directly, through a private or PUBLIC synonym or through a chain of two synonyms, one granted a
 *    view over a synonym it cannot resolve, over a view it may not read, or over an invoker's-rights function, one
 *    granted a view left invalid, a table with a virtual column or a hidden one of a function-based index, a table or
 *    a synonym a row-level policy guards, a view over a table one guards, a table or a view over a table with a
 *    fine-grained auditing handler, a view over a view granted only DEBUG, a table of its own with a virtual column,
 *    one that may no longer read the catalog, one granted a sequence, one holding a role that is not a default role, one
 *    granted a directory, one holding ALTER SYSTEM, one owning a private database link, and any user while a PUBLIC
 *    database link exists, and admits each again once the grant is gone, the synonym or the table dropped or the
 *    private link dropped by its owner set READ WRITE; it admits a view over DBMS_LOB through Oracle's PUBLIC synonym,
 *    one over a synonym for a granted table, a view leaving out a hidden virtual column, and a view over a view once
 *    both are granted, the inner one INSERT only included;
 *  - the boundary, with Studio's client admission bypassed: every write, DDL, temporary table, lock, transaction
 *    statement, PL/SQL write and second statement is sent through `queryReadOnly` as the admitted user and refused,
 *    each classified by its ORA- code; the same writes run as the schema owner through the editor path, the positive
 *    control that shows each one would work; the tables, the sequence and the parameter read back the same before and
 *    after;
 *  - what reaches past READ ONLY and is not refused: a PUBLIC sequence Oracle maintains, recorded as the server
 *    answered, and `ALTER SESSION SET EDITION` refused inside the call's transaction;
 *  - the operations profile opens the schema owner, a writable user, unproven, and reads its objects, which is what
 *    plan mode grounds on; an editor handle refuses `queryReadOnly` before sending anything;
 *  - the catalog reads the overlay composes, each answered as the admitted user;
 *  - the budgets: a result past the row budget, one past the byte budget, a BFILE column, a nested CURSOR column (before
 *    any of it is fetched) and a statement past its deadline are refused, and a CLOB under them is answered as a string.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it against a server you may write to,
 * whose SYS and SYSTEM passwords are the one given, and whose pluggable database holds the schema owner APP_OWNER,
 * which `gvenzl/oracle-free` creates from `APP_USER`:
 *
 *   docker run -d --name <name> -p 15217:1521 -e ORACLE_PASSWORD=not-a-real-password \
 *     -e APP_USER=APP_OWNER -e APP_USER_PASSWORD=not-a-real-password gvenzl/oracle-free:slim@sha256:<the digest
 *     tests/fixtures/oracle/23.26.3-free/agent-boundary/run.sh pins>
 *   LIBREDB_LIVE_ORACLE_PORT=15217 LIBREDB_LIVE_ORACLE_PASSWORD=not-a-real-password bun tests/live/oracle-agent-boundary.ts
 *
 * It revokes PUBLIC's EXECUTE on the network and file packages and does not grant it back, so run it on a disposable
 * database. Every other object and user it creates carries the `LIBREDB_LB_` prefix and is dropped on exit. Each check
 * prints one line, and a run with a failing check ends non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import oracledb from "oracledb";
import { composeCatalogRead } from "@/lib/agent/composed-sql";
import { ExecutionProfileError } from "@/lib/db/errors";
import { createDatabaseProvider, executionContextFor } from "@/lib/db/factory";
import type { DatabaseProvider } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const PREFIX = "LIBREDB_LB_";
const RO = `${PREFIX}RO`;
const RO_SYS = `${PREFIX}RO_SYS`;
const OWNER = "APP_OWNER";
const BUDGET = { statementTimeoutMs: 10_000, maxResultRows: 50, maxResultBytes: 64 * 1024 };

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

let failures = 0;
function check(ok: boolean, line: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

/** Runs `sql` as `user` on a connection of its own, SYS as SYSDBA, answering the rows. */
async function as(user: string, sql: string): Promise<Record<string, unknown>[]> {
  const conn = await oracledb.getConnection({
    user,
    password: PASSWORD,
    connectString: CONNECT_STRING,
    ...(user === "SYS" ? { privilege: oracledb.SYSDBA } : {}),
  });
  try {
    const result = await conn.execute(sql, [], { outFormat: oracledb.OUT_FORMAT_OBJECT, autoCommit: true });
    return (result.rows ?? []) as Record<string, unknown>[];
  } finally {
    await conn.close();
  }
}

/** Runs each statement as `user`, ignoring the ORA- codes named, so a setup step can run twice. */
async function setup(user: string, statements: readonly string[], ignore: readonly string[] = []): Promise<void> {
  for (const sql of statements) {
    try {
      await as(user, sql);
    } catch (error) {
      if (!ignore.some((code) => (error as Error).message.includes(code))) throw error;
    }
  }
}

function connection(user: string, password = PASSWORD): DatabaseConnection {
  return {
    id: `live-oracle-${user}`,
    name: "Oracle live",
    type: "oracle",
    host: HOST,
    port: PORT,
    serviceName: SERVICE,
    user,
    password,
    createdAt: new Date(),
  };
}

async function agentFor(user: string): Promise<DatabaseProvider> {
  const provider = await createDatabaseProvider(connection(user), {}, executionContextFor("agent-read-only"));
  await provider.connect();
  return provider;
}

/** What one agent statement answered: "ran", or "refused: <message>". */
async function agentAnswer(provider: DatabaseProvider, sql: string, budget = BUDGET): Promise<string> {
  try {
    await provider.queryReadOnly?.(sql, budget);
    return "ran";
  } catch (error) {
    return `refused: ${(error as Error).message}`;
  }
}

/** The check's verdict for `user` on a fresh provider: "admitted", or the refusal's reason code and message. */
async function verdict(user: string): Promise<string> {
  const provider = await agentFor(user);
  try {
    await provider.queryReadOnly?.("SELECT 1 FROM DUAL", BUDGET);
    return "admitted";
  } catch (error) {
    return error instanceof ExecutionProfileError
      ? `${error.reasonCode}: ${error.message}`
      : `error: ${(error as Error).message}`;
  } finally {
    await provider.disconnect();
  }
}

/** What the boundary must hold unchanged: rows, the sequence, a parameter, the owner's objects and the links. */
async function snapshot(): Promise<string> {
  const [rows] = await as(
    "SYSTEM",
    `SELECT (SELECT COUNT(*) FROM ${OWNER}.${PREFIX}DATA) AS DATA_ROWS, (SELECT COUNT(*) FROM ${OWNER}.${PREFIX}SCRATCH) AS SCRATCH_ROWS, ` +
      `(SELECT COUNT(*) FROM ${OWNER}.${PREFIX}LOG) AS LOG_ROWS, ` +
      `(SELECT LAST_NUMBER FROM DBA_SEQUENCES WHERE SEQUENCE_OWNER = '${OWNER}' AND SEQUENCE_NAME = '${PREFIX}SEQ') AS SEQ, ` +
      "(SELECT VALUE FROM V$PARAMETER WHERE NAME = 'open_cursors') AS OPEN_CURSORS, " +
      `(SELECT COUNT(*) FROM DBA_OBJECTS WHERE OWNER IN ('${OWNER}', '${RO}')) AS OBJECTS, ` +
      "(SELECT COUNT(*) FROM DBA_DB_LINKS) AS LINKS FROM DUAL",
  );
  return JSON.stringify(rows);
}

const SETUP_AS_SYSTEM: readonly string[] = [
  `CREATE USER ${RO} IDENTIFIED BY "${PASSWORD}"`,
  `GRANT CREATE SESSION TO ${RO}`,
  `ALTER USER ${RO} READ ONLY`,
  `CREATE USER ${RO_SYS} IDENTIFIED BY "${PASSWORD}"`,
  `GRANT CREATE SESSION, ALTER SYSTEM TO ${RO_SYS}`,
  `ALTER USER ${RO_SYS} READ ONLY`,
  `CREATE TABLE ${OWNER}.${PREFIX}DATA (ID NUMBER PRIMARY KEY, NAME VARCHAR2(40), DOC CLOB)`,
  `INSERT INTO ${OWNER}.${PREFIX}DATA VALUES (1, 'one', 'clob one')`,
  `INSERT INTO ${OWNER}.${PREFIX}DATA VALUES (2, 'two', RPAD(TO_CLOB('x'), 30000, 'x'))`,
  `CREATE TABLE ${OWNER}.${PREFIX}CHILD (ID NUMBER PRIMARY KEY, DATA_ID NUMBER REFERENCES ${OWNER}.${PREFIX}DATA (ID))`,
  `CREATE INDEX ${OWNER}.${PREFIX}CHILD_DATA ON ${OWNER}.${PREFIX}CHILD (DATA_ID)`,
  `CREATE TABLE ${OWNER}.${PREFIX}SCRATCH (ID NUMBER)`,
  `CREATE TABLE ${OWNER}.${PREFIX}LOG (MSG VARCHAR2(100))`,
  `CREATE OR REPLACE SYNONYM ${OWNER}.${PREFIX}LOG_SYN FOR ${OWNER}.${PREFIX}LOG`,
  `CREATE OR REPLACE VIEW ${OWNER}.${PREFIX}LOG_SYN_VIEW AS SELECT MSG FROM ${OWNER}.${PREFIX}LOG_SYN`,
  `CREATE SEQUENCE ${OWNER}.${PREFIX}SEQ NOCACHE`,
  `CREATE OR REPLACE FUNCTION ${OWNER}.${PREFIX}NEXT RETURN NUMBER AS BEGIN RETURN ${OWNER}.${PREFIX}SEQ.NEXTVAL; END;`,
  `CREATE OR REPLACE VIEW ${OWNER}.${PREFIX}NEXT_VIEW AS SELECT ${OWNER}.${PREFIX}NEXT() AS N FROM DUAL`,
  // The same function called through a private and a PUBLIC synonym: ALL_DEPENDENCIES lists only the synonym.
  `CREATE OR REPLACE SYNONYM ${OWNER}.${PREFIX}NEXT_SYN FOR ${OWNER}.${PREFIX}NEXT`,
  `CREATE OR REPLACE VIEW ${OWNER}.${PREFIX}SYN_VIEW AS SELECT ${OWNER}.${PREFIX}NEXT_SYN() AS N FROM DUAL`,
  `CREATE OR REPLACE PUBLIC SYNONYM ${PREFIX}PSYN FOR ${OWNER}.${PREFIX}NEXT`,
  `CREATE OR REPLACE VIEW ${OWNER}.${PREFIX}PSYN_VIEW AS SELECT ${PREFIX}PSYN() AS N FROM DUAL`,
  // Synonyms that call no code: Oracle's DBMS_LOB through its PUBLIC synonym, a granted table, a table not granted.
  `CREATE OR REPLACE VIEW ${OWNER}.${PREFIX}LOB_VIEW AS SELECT DBMS_LOB.GETLENGTH(TO_CLOB('x')) AS L FROM DUAL`,
  `CREATE OR REPLACE SYNONYM ${OWNER}.${PREFIX}DATA_SYN FOR ${OWNER}.${PREFIX}DATA`,
  `CREATE OR REPLACE VIEW ${OWNER}.${PREFIX}DATA_SYN_VIEW AS SELECT ID FROM ${OWNER}.${PREFIX}DATA_SYN`,
  `CREATE OR REPLACE FUNCTION ${OWNER}.${PREFIX}NEXT_DET(x NUMBER) RETURN NUMBER DETERMINISTIC AS BEGIN RETURN ${OWNER}.${PREFIX}SEQ.NEXTVAL; END;`,
  `CREATE TABLE ${OWNER}.${PREFIX}VIRT (ID NUMBER, N NUMBER GENERATED ALWAYS AS (${OWNER}.${PREFIX}NEXT_DET(ID)) VIRTUAL)`,
  `INSERT INTO ${OWNER}.${PREFIX}VIRT (ID) VALUES (1)`,
  // A function-based index over a built-in: its hidden virtual column is refused too, and a view leaving it out is not.
  `CREATE TABLE ${OWNER}.${PREFIX}FBI (ID NUMBER, NAME VARCHAR2(20))`,
  `CREATE INDEX ${OWNER}.${PREFIX}FBI_UP ON ${OWNER}.${PREFIX}FBI (UPPER(NAME))`,
  `CREATE OR REPLACE VIEW ${OWNER}.${PREFIX}FBI_VIEW AS SELECT ID, NAME FROM ${OWNER}.${PREFIX}FBI`,
  // A row-level policy function and an auditing handler that advance the sequence, and a function an audit condition
  // calls that advances it. The policies are added by the checks below, one at a time: any one refuses the database.
  `CREATE OR REPLACE FUNCTION ${OWNER}.${PREFIX}POL_FN(s VARCHAR2, o VARCHAR2) RETURN VARCHAR2 AS n NUMBER; BEGIN n := ${OWNER}.${PREFIX}SEQ.NEXTVAL; RETURN NULL; END;`,
  `CREATE OR REPLACE PROCEDURE ${OWNER}.${PREFIX}FGA_FN(s VARCHAR2, o VARCHAR2, p VARCHAR2) AS n NUMBER; BEGIN n := ${OWNER}.${PREFIX}SEQ.NEXTVAL; END;`,
  `CREATE OR REPLACE FUNCTION ${OWNER}.${PREFIX}AC_FN(x NUMBER) RETURN NUMBER AS BEGIN RETURN ${OWNER}.${PREFIX}SEQ.NEXTVAL; END;`,
  // An empty table shaped like DBA_POLICIES, for a private synonym of that name in the agent user's schema.
  `CREATE TABLE ${OWNER}.${PREFIX}NOPOL (OBJECT_OWNER VARCHAR2(128), OBJECT_NAME VARCHAR2(128), POLICY_NAME VARCHAR2(128), PF_OWNER VARCHAR2(128))`,
  `CREATE TABLE ${OWNER}.${PREFIX}POL (ID NUMBER)`,
  `INSERT INTO ${OWNER}.${PREFIX}POL VALUES (1)`,
  `CREATE TABLE ${OWNER}.${PREFIX}SYNPOL (ID NUMBER)`,
  `GRANT SELECT ON ${OWNER}.${PREFIX}SYNPOL TO ${RO}`,
  `CREATE TABLE ${OWNER}.${PREFIX}BEHIND (ID NUMBER)`,
  `INSERT INTO ${OWNER}.${PREFIX}BEHIND VALUES (1)`,
  `CREATE OR REPLACE VIEW ${OWNER}.${PREFIX}BEHIND_VIEW AS SELECT ID FROM ${OWNER}.${PREFIX}BEHIND`,
  `CREATE TABLE ${OWNER}.${PREFIX}AUDITED (ID NUMBER)`,
  `INSERT INTO ${OWNER}.${PREFIX}AUDITED VALUES (1)`,
  `CREATE OR REPLACE VIEW ${OWNER}.${PREFIX}AUDITED_VIEW AS SELECT ID FROM ${OWNER}.${PREFIX}AUDITED`,
  // Views over views: one over a view replaced to call the function after the outer one was created, one over a plain
  // view, and one over a chain of two private synonyms ending at the function.
  `CREATE OR REPLACE VIEW ${OWNER}.${PREFIX}INNER AS SELECT 1 AS N FROM DUAL`,
  `CREATE OR REPLACE VIEW ${OWNER}.${PREFIX}OUTER AS SELECT N FROM ${OWNER}.${PREFIX}INNER`,
  `CREATE OR REPLACE VIEW ${OWNER}.${PREFIX}INNER AS SELECT ${OWNER}.${PREFIX}NEXT() AS N FROM DUAL`,
  `CREATE OR REPLACE VIEW ${OWNER}.${PREFIX}PLAIN_INNER AS SELECT ID FROM ${OWNER}.${PREFIX}DATA`,
  `CREATE OR REPLACE VIEW ${OWNER}.${PREFIX}PLAIN_OUTER AS SELECT ID FROM ${OWNER}.${PREFIX}PLAIN_INNER`,
  `CREATE OR REPLACE SYNONYM ${OWNER}.${PREFIX}CHAIN2 FOR ${OWNER}.${PREFIX}NEXT`,
  `CREATE OR REPLACE SYNONYM ${OWNER}.${PREFIX}CHAIN1 FOR ${OWNER}.${PREFIX}CHAIN2`,
  `CREATE OR REPLACE VIEW ${OWNER}.${PREFIX}CHAIN_VIEW AS SELECT ${OWNER}.${PREFIX}CHAIN1() AS N FROM DUAL`,
  // A view over an invoker's-rights function, which a view runs with the view owner's rights.
  `CREATE OR REPLACE FUNCTION ${OWNER}.${PREFIX}INVOKER RETURN NUMBER AUTHID CURRENT_USER AS BEGIN RETURN 1; END;`,
  `CREATE OR REPLACE VIEW ${OWNER}.${PREFIX}INVOKER_VIEW AS SELECT ${OWNER}.${PREFIX}INVOKER() AS N FROM DUAL`,
  // A view that is left invalid: the column it reads is dropped and added again.
  `CREATE TABLE ${OWNER}.${PREFIX}STALE (ID NUMBER, N NUMBER)`,
  `CREATE OR REPLACE VIEW ${OWNER}.${PREFIX}STALE_VIEW AS SELECT ID, N FROM ${OWNER}.${PREFIX}STALE`,
  `CREATE ROLE ${PREFIX}ROLE`,
  `GRANT SELECT ON ${OWNER}.${PREFIX}DATA TO ${RO}`,
  `GRANT SELECT ON ${OWNER}.${PREFIX}CHILD TO ${RO}`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ${OWNER}.${PREFIX}SCRATCH TO ${RO}`,
];

/** A row-level policy of `name` on `schema.object` whose function is the owner's POL_FN. */
function rlsPolicy(schema: string, object: string, name: string): string {
  return `BEGIN DBMS_RLS.ADD_POLICY(object_schema => '${schema}', object_name => '${object}', policy_name => '${name}', function_schema => '${OWNER}', policy_function => '${PREFIX}POL_FN', statement_types => 'SELECT'); END;`;
}

function dropRlsPolicy(schema: string, object: string, name: string): string {
  return `BEGIN DBMS_RLS.DROP_POLICY('${schema}', '${object}', '${name}'); END;`;
}

/** A fine-grained auditing policy of `name` on `schema.object`, with the condition and the handler given, or none. */
function fgaPolicy(schema: string, object: string, name: string, condition: string | null, handler: boolean): string {
  const audit = condition === null ? "" : `audit_condition => '${condition.replaceAll("'", "''")}', `;
  const handlerArgs = handler ? `handler_schema => '${OWNER}', handler_module => '${PREFIX}FGA_FN', ` : "";
  return `BEGIN DBMS_FGA.ADD_POLICY(object_schema => '${schema}', object_name => '${object}', policy_name => '${name}', ${audit}${handlerArgs}statement_types => 'SELECT'); END;`;
}

function dropFgaPolicy(schema: string, object: string, name: string): string {
  return `BEGIN DBMS_FGA.DROP_POLICY('${schema}', '${object}', '${name}'); END;`;
}

/** How a refusal names a policy. */
function namedPolicy(schema: string, object: string, name: string): string {
  return `"${schema}"."${object}" policy "${name}"`;
}

/** The sequence's last number, which a policy function, handler or condition that ran has advanced. */
async function sequenceNumber(): Promise<number> {
  const [row] = await as(
    "SYSTEM",
    `SELECT LAST_NUMBER AS N FROM DBA_SEQUENCES WHERE SEQUENCE_OWNER = '${OWNER}' AND SEQUENCE_NAME = '${PREFIX}SEQ'`,
  );
  return Number(row?.N);
}

/** PUBLIC's default EXECUTE grants on the packages the check refuses, as the doc's revoke script lifts them. */
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
].map((name) => `REVOKE EXECUTE ON ${name} FROM PUBLIC`);

/** The two catalog views the check reads for row-level policies and auditing handlers; only SYS may grant them. */
const CATALOG_GRANTS_AS_SYS: readonly string[] = [
  `GRANT SELECT ON SYS.DBA_POLICIES TO ${RO}`,
  `GRANT SELECT ON SYS.DBA_AUDIT_POLICIES TO ${RO}`,
];

async function cleanup(): Promise<void> {
  await setup(
    "SYSTEM",
    [
      dropRlsPolicy("SYSTEM", "HELP", `${PREFIX}HELP_P`),
      dropFgaPolicy("SYSTEM", "SQLPLUS_PRODUCT_PROFILE", `${PREFIX}SPP_P`),
      `DROP TABLE ${OWNER}.${PREFIX}NOPOL PURGE`,
      `DROP FUNCTION ${OWNER}.${PREFIX}AC_FN`,
      `DROP USER ${RO} CASCADE`,
      `DROP USER ${RO_SYS} CASCADE`,
      `DROP ROLE ${PREFIX}ROLE`,
      `DROP PUBLIC DATABASE LINK ${PREFIX}LINK`,
      `DROP VIEW ${OWNER}.${PREFIX}NEXT_VIEW`,
      `DROP VIEW ${OWNER}.${PREFIX}SYN_VIEW`,
      `DROP VIEW ${OWNER}.${PREFIX}PSYN_VIEW`,
      `DROP VIEW ${OWNER}.${PREFIX}LOB_VIEW`,
      `DROP VIEW ${OWNER}.${PREFIX}DATA_SYN_VIEW`,
      `DROP VIEW ${OWNER}.${PREFIX}LOG_SYN_VIEW`,
      `DROP SYNONYM ${OWNER}.${PREFIX}NEXT_SYN`,
      `DROP SYNONYM ${OWNER}.${PREFIX}DATA_SYN`,
      `DROP SYNONYM ${OWNER}.${PREFIX}LOG_SYN`,
      `DROP PUBLIC SYNONYM ${PREFIX}PSYN`,
      `DROP TABLE ${OWNER}.${PREFIX}VIRT PURGE`,
      `DROP VIEW ${OWNER}.${PREFIX}FBI_VIEW`,
      `DROP TABLE ${OWNER}.${PREFIX}FBI PURGE`,
      `DROP TABLE ${OWNER}.${PREFIX}POL PURGE`,
      `DROP SYNONYM ${OWNER}.${PREFIX}SYNPOL_SYN`,
      `DROP PUBLIC SYNONYM ${PREFIX}SYNPOL_PSYN`,
      `DROP TABLE ${OWNER}.${PREFIX}SYNPOL PURGE`,
      `DROP VIEW ${OWNER}.${PREFIX}BEHIND_VIEW`,
      `DROP TABLE ${OWNER}.${PREFIX}BEHIND PURGE`,
      `DROP VIEW ${OWNER}.${PREFIX}AUDITED_VIEW`,
      `DROP TABLE ${OWNER}.${PREFIX}AUDITED PURGE`,
      `DROP FUNCTION ${OWNER}.${PREFIX}POL_FN`,
      `DROP PROCEDURE ${OWNER}.${PREFIX}FGA_FN`,
      `DROP VIEW ${OWNER}.${PREFIX}OUTER`,
      `DROP VIEW ${OWNER}.${PREFIX}INNER`,
      `DROP VIEW ${OWNER}.${PREFIX}PLAIN_OUTER`,
      `DROP VIEW ${OWNER}.${PREFIX}PLAIN_INNER`,
      `DROP VIEW ${OWNER}.${PREFIX}CHAIN_VIEW`,
      `DROP SYNONYM ${OWNER}.${PREFIX}CHAIN1`,
      `DROP SYNONYM ${OWNER}.${PREFIX}CHAIN2`,
      `DROP VIEW ${OWNER}.${PREFIX}INVOKER_VIEW`,
      `DROP FUNCTION ${OWNER}.${PREFIX}INVOKER`,
      `DROP VIEW ${OWNER}.${PREFIX}STALE_VIEW`,
      `DROP TABLE ${OWNER}.${PREFIX}STALE PURGE`,
      `DROP FUNCTION ${OWNER}.${PREFIX}NEXT_DET`,
      `DROP FUNCTION ${OWNER}.${PREFIX}NEXT`,
      `DROP SEQUENCE ${OWNER}.${PREFIX}SEQ`,
      `DROP TABLE ${OWNER}.${PREFIX}CHILD PURGE`,
      `DROP TABLE ${OWNER}.${PREFIX}DATA PURGE`,
      `DROP TABLE ${OWNER}.${PREFIX}SCRATCH PURGE`,
      `DROP TABLE ${OWNER}.${PREFIX}LOG PURGE`,
      `DROP TABLE ${OWNER}.${PREFIX}NEW PURGE`,
      `DROP TABLE ${OWNER}.${PREFIX}GTT PURGE`,
    ],
    ["ORA-"],
  );
  await setup("SYS", [`DROP DIRECTORY ${PREFIX}DIR`], ["ORA-"]);
}

/** The writes sent as the read-only user, and the same write as the schema owner sends it on its own scratch objects. */
const WRITES: readonly { readonly label: string; readonly agent: string; readonly owner: string }[] = [
  {
    label: "INSERT",
    agent: `INSERT INTO ${OWNER}.${PREFIX}SCRATCH VALUES (1)`,
    owner: `INSERT INTO ${PREFIX}SCRATCH VALUES (1)`,
  },
  {
    label: "UPDATE",
    agent: `UPDATE ${OWNER}.${PREFIX}SCRATCH SET ID = 2`,
    owner: `UPDATE ${PREFIX}SCRATCH SET ID = 2`,
  },
  { label: "DELETE", agent: `DELETE FROM ${OWNER}.${PREFIX}SCRATCH`, owner: `DELETE FROM ${PREFIX}SCRATCH` },
  {
    label: "MERGE",
    agent: `MERGE INTO ${OWNER}.${PREFIX}SCRATCH s USING DUAL ON (1 = 0) WHEN NOT MATCHED THEN INSERT (ID) VALUES (3)`,
    owner: `MERGE INTO ${PREFIX}SCRATCH s USING DUAL ON (1 = 0) WHEN NOT MATCHED THEN INSERT (ID) VALUES (3)`,
  },
  {
    label: "CREATE TABLE",
    agent: `CREATE TABLE ${OWNER}.${PREFIX}NEW (ID NUMBER)`,
    owner: `CREATE TABLE ${PREFIX}NEW (ID NUMBER)`,
  },
  {
    label: "CREATE GLOBAL TEMPORARY TABLE",
    agent: `CREATE GLOBAL TEMPORARY TABLE ${OWNER}.${PREFIX}GTT (ID NUMBER)`,
    owner: `CREATE GLOBAL TEMPORARY TABLE ${PREFIX}GTT (ID NUMBER)`,
  },
  {
    label: "CREATE PRIVATE TEMPORARY TABLE",
    agent: "CREATE PRIVATE TEMPORARY TABLE ORA$PTT_LIBREDB_LB (ID NUMBER) ON COMMIT DROP DEFINITION",
    owner: "CREATE PRIVATE TEMPORARY TABLE ORA$PTT_LIBREDB_LB (ID NUMBER) ON COMMIT DROP DEFINITION",
  },
  {
    label: "SELECT ... FOR UPDATE",
    agent: `SELECT ID FROM ${OWNER}.${PREFIX}SCRATCH FOR UPDATE`,
    owner: `SELECT ID FROM ${PREFIX}SCRATCH FOR UPDATE`,
  },
  {
    label: "LOCK TABLE",
    agent: `LOCK TABLE ${OWNER}.${PREFIX}SCRATCH IN EXCLUSIVE MODE`,
    owner: `LOCK TABLE ${PREFIX}SCRATCH IN EXCLUSIVE MODE`,
  },
  {
    label: "a write in a PL/SQL block after a read",
    agent: `DECLARE n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM ${OWNER}.${PREFIX}DATA; INSERT INTO ${OWNER}.${PREFIX}SCRATCH VALUES (n); END;`,
    owner: `DECLARE n NUMBER; BEGIN SELECT COUNT(*) INTO n FROM ${PREFIX}DATA; INSERT INTO ${PREFIX}SCRATCH VALUES (n); END;`,
  },
  {
    label: "a write after ALTER SESSION SET READ_ONLY = FALSE",
    agent: `BEGIN EXECUTE IMMEDIATE 'ALTER SESSION SET READ_ONLY = FALSE'; INSERT INTO ${OWNER}.${PREFIX}SCRATCH VALUES (4); END;`,
    owner: `BEGIN EXECUTE IMMEDIATE 'ALTER SESSION SET READ_ONLY = FALSE'; INSERT INTO ${PREFIX}SCRATCH VALUES (4); END;`,
  },
  {
    label: "a write through DBMS_SQL",
    agent: `DECLARE c INTEGER := DBMS_SQL.OPEN_CURSOR; n INTEGER; BEGIN DBMS_SQL.PARSE(c, 'INSERT INTO ${OWNER}.${PREFIX}SCRATCH VALUES (5)', DBMS_SQL.NATIVE); n := DBMS_SQL.EXECUTE(c); DBMS_SQL.CLOSE_CURSOR(c); END;`,
    owner: `DECLARE c INTEGER := DBMS_SQL.OPEN_CURSOR; n INTEGER; BEGIN DBMS_SQL.PARSE(c, 'INSERT INTO ${PREFIX}SCRATCH VALUES (5)', DBMS_SQL.NATIVE); n := DBMS_SQL.EXECUTE(c); DBMS_SQL.CLOSE_CURSOR(c); END;`,
  },
  { label: "COMMIT", agent: "COMMIT", owner: "COMMIT" },
  { label: "ROLLBACK", agent: "ROLLBACK", owner: "ROLLBACK" },
];

async function main(): Promise<void> {
  await cleanup();
  await setup("SYSTEM", SETUP_AS_SYSTEM);

  // The fresh database refuses its own read-only user: PUBLIC holds EXECUTE on the network and file packages, and the
  // user, which reads granted tables, may not read the catalog of row-level policies and auditing handlers.
  const fresh = await verdict(RO);
  check(
    fresh.startsWith("PROFILE_PRIVILEGES_TOO_BROAD") &&
      fresh.includes('REVOKE EXECUTE ON "SYS"."UTL_HTTP" FROM PUBLIC') &&
      fresh.includes(`GRANT SELECT ON SYS.DBA_POLICIES TO "${RO}" (as SYS)`) &&
      fresh.includes(`GRANT SELECT ON SYS.DBA_AUDIT_POLICIES TO "${RO}" (as SYS)`),
    `a fresh database refuses its READ ONLY user until PUBLIC's grants are revoked and the catalog granted: ${fresh}`,
  );
  await setup("SYS", REVOKES_AS_SYS, ["ORA-01927"]);
  await setup("SYS", CATALOG_GRANTS_AS_SYS);
  check((await verdict(RO)) === "admitted", "after the revoke script the READ ONLY user is admitted");

  // Each grant the check refuses, refused and then lifted.
  const refusedThenLifted: readonly {
    label: string;
    grant: string[];
    revoke: string[];
    names: string;
    admin?: string;
  }[] = [
    {
      label: "a user that is not READ ONLY",
      grant: [`ALTER USER ${RO} READ WRITE`],
      revoke: [`ALTER USER ${RO} READ ONLY`],
      names: `ALTER USER "${RO}" READ ONLY`,
    },
    {
      label: "EXECUTE on a granted definer's-rights function",
      grant: [`GRANT EXECUTE ON ${OWNER}.${PREFIX}NEXT TO ${RO}`],
      revoke: [`REVOKE EXECUTE ON ${OWNER}.${PREFIX}NEXT FROM ${RO}`],
      names: `REVOKE EXECUTE ON "${OWNER}"."${PREFIX}NEXT" FROM "${RO}"`,
    },
    {
      label: "EXECUTE on that function through PUBLIC",
      grant: [`GRANT EXECUTE ON ${OWNER}.${PREFIX}NEXT TO PUBLIC`],
      revoke: [`REVOKE EXECUTE ON ${OWNER}.${PREFIX}NEXT FROM PUBLIC`],
      names: `REVOKE EXECUTE ON "${OWNER}"."${PREFIX}NEXT" FROM PUBLIC`,
    },
    {
      label: "EXECUTE on that function through a default role",
      grant: [`GRANT EXECUTE ON ${OWNER}.${PREFIX}NEXT TO ${PREFIX}ROLE`, `GRANT ${PREFIX}ROLE TO ${RO}`],
      revoke: [`REVOKE ${PREFIX}ROLE FROM ${RO}`, `REVOKE EXECUTE ON ${OWNER}.${PREFIX}NEXT FROM ${PREFIX}ROLE`],
      names: `REVOKE EXECUTE ON "${OWNER}"."${PREFIX}NEXT" FROM "${PREFIX}ROLE"`,
    },
    {
      label: "a role that is not a default role",
      grant: [`GRANT ${PREFIX}ROLE TO ${RO}`, `ALTER USER ${RO} DEFAULT ROLE NONE`],
      revoke: [`REVOKE ${PREFIX}ROLE FROM ${RO}`, `ALTER USER ${RO} DEFAULT ROLE ALL`],
      names: `REVOKE "${PREFIX}ROLE" FROM "${RO}"`,
    },
    {
      label: "a granted view over that function",
      grant: [`GRANT SELECT ON ${OWNER}.${PREFIX}NEXT_VIEW TO ${RO}`],
      revoke: [`REVOKE SELECT ON ${OWNER}.${PREFIX}NEXT_VIEW FROM ${RO}`],
      names: `REVOKE ALL ON "${OWNER}"."${PREFIX}NEXT_VIEW" FROM "${RO}"`,
    },
    {
      label: "a granted view that calls that function through a private synonym",
      grant: [`GRANT SELECT ON ${OWNER}.${PREFIX}SYN_VIEW TO ${RO}`],
      revoke: [`REVOKE SELECT ON ${OWNER}.${PREFIX}SYN_VIEW FROM ${RO}`],
      names: `REVOKE ALL ON "${OWNER}"."${PREFIX}SYN_VIEW" FROM "${RO}"`,
    },
    {
      label: "a granted view that calls that function through a PUBLIC synonym",
      grant: [`GRANT SELECT ON ${OWNER}.${PREFIX}PSYN_VIEW TO ${RO}`],
      revoke: [`REVOKE SELECT ON ${OWNER}.${PREFIX}PSYN_VIEW FROM ${RO}`],
      names: `REVOKE ALL ON "${OWNER}"."${PREFIX}PSYN_VIEW" FROM "${RO}"`,
    },
    {
      label: "a granted view over a private synonym for a table the user is not granted, which it cannot resolve",
      grant: [`GRANT SELECT ON ${OWNER}.${PREFIX}LOG_SYN_VIEW TO ${RO}`],
      revoke: [`REVOKE SELECT ON ${OWNER}.${PREFIX}LOG_SYN_VIEW FROM ${RO}`],
      names: `REVOKE ALL ON "${OWNER}"."${PREFIX}LOG_SYN_VIEW" FROM "${RO}"`,
    },
    {
      label: "a granted table with a virtual column over that function",
      grant: [`GRANT SELECT ON ${OWNER}.${PREFIX}VIRT TO ${RO}`],
      revoke: [`REVOKE SELECT ON ${OWNER}.${PREFIX}VIRT FROM ${RO}`],
      names: `REVOKE ALL ON "${OWNER}"."${PREFIX}VIRT" FROM "${RO}"`,
    },
    {
      label: "a granted table whose function-based index over UPPER has a hidden virtual column",
      grant: [`GRANT SELECT ON ${OWNER}.${PREFIX}FBI TO ${RO}`],
      revoke: [`REVOKE SELECT ON ${OWNER}.${PREFIX}FBI FROM ${RO}`],
      names: `REVOKE ALL ON "${OWNER}"."${PREFIX}FBI" FROM "${RO}"`,
    },
    {
      label: "a row-level policy on a granted table",
      grant: [`GRANT SELECT ON ${OWNER}.${PREFIX}POL TO ${RO}`, rlsPolicy(OWNER, `${PREFIX}POL`, `${PREFIX}POL_P`)],
      revoke: [
        dropRlsPolicy(OWNER, `${PREFIX}POL`, `${PREFIX}POL_P`),
        `REVOKE SELECT ON ${OWNER}.${PREFIX}POL FROM ${RO}`,
      ],
      names: namedPolicy(OWNER, `${PREFIX}POL`, `${PREFIX}POL_P`),
    },
    {
      label: "a row-level policy on a table the user is not granted at all, the rule being database wide",
      grant: [rlsPolicy(OWNER, `${PREFIX}POL`, `${PREFIX}POL_P`)],
      revoke: [dropRlsPolicy(OWNER, `${PREFIX}POL`, `${PREFIX}POL_P`)],
      names: namedPolicy(OWNER, `${PREFIX}POL`, `${PREFIX}POL_P`),
    },
    {
      label: "a row-level policy on a private synonym for a granted table, lifted by dropping the synonym",
      grant: [
        `CREATE OR REPLACE SYNONYM ${OWNER}.${PREFIX}SYNPOL_SYN FOR ${OWNER}.${PREFIX}SYNPOL`,
        rlsPolicy(OWNER, `${PREFIX}SYNPOL_SYN`, `${PREFIX}SYN_P`),
      ],
      revoke: [`DROP SYNONYM ${OWNER}.${PREFIX}SYNPOL_SYN`],
      names: namedPolicy(OWNER, `${PREFIX}SYNPOL_SYN`, `${PREFIX}SYN_P`),
    },
    {
      label: "a row-level policy on a PUBLIC synonym, lifted by dropping the synonym",
      grant: [
        `CREATE OR REPLACE PUBLIC SYNONYM ${PREFIX}SYNPOL_PSYN FOR ${OWNER}.${PREFIX}SYNPOL`,
        rlsPolicy("PUBLIC", `${PREFIX}SYNPOL_PSYN`, `${PREFIX}PSYN_P`),
      ],
      revoke: [`DROP PUBLIC SYNONYM ${PREFIX}SYNPOL_PSYN`],
      names: namedPolicy("PUBLIC", `${PREFIX}SYNPOL_PSYN`, `${PREFIX}PSYN_P`),
    },
    {
      label: "a row-level policy of the owner's on SYSTEM.HELP, an object Oracle maintains that PUBLIC reads",
      grant: [rlsPolicy("SYSTEM", "HELP", `${PREFIX}HELP_P`)],
      revoke: [dropRlsPolicy("SYSTEM", "HELP", `${PREFIX}HELP_P`)],
      names: namedPolicy("SYSTEM", "HELP", `${PREFIX}HELP_P`),
    },
    {
      label: "an auditing handler of the owner's on SYSTEM.SQLPLUS_PRODUCT_PROFILE, an object Oracle maintains",
      grant: [fgaPolicy("SYSTEM", "SQLPLUS_PRODUCT_PROFILE", `${PREFIX}SPP_P`, null, true)],
      revoke: [dropFgaPolicy("SYSTEM", "SQLPLUS_PRODUCT_PROFILE", `${PREFIX}SPP_P`)],
      names: namedPolicy("SYSTEM", "SQLPLUS_PRODUCT_PROFILE", `${PREFIX}SPP_P`),
    },
    {
      label: "an auditing policy whose audit condition calls a function of the owner's, with no handler",
      grant: [fgaPolicy(OWNER, `${PREFIX}AUDITED`, `${PREFIX}AC_P`, `${OWNER}.${PREFIX}AC_FN(ID) = 1`, false)],
      revoke: [dropFgaPolicy(OWNER, `${PREFIX}AUDITED`, `${PREFIX}AC_P`)],
      names: namedPolicy(OWNER, `${PREFIX}AUDITED`, `${PREFIX}AC_P`),
    },
    {
      label: "an auditing policy whose audit condition is built-in only, since the condition is not parsed",
      grant: [fgaPolicy(OWNER, `${PREFIX}AUDITED`, `${PREFIX}AC_P`, "ID > 0", false)],
      revoke: [dropFgaPolicy(OWNER, `${PREFIX}AUDITED`, `${PREFIX}AC_P`)],
      names: namedPolicy(OWNER, `${PREFIX}AUDITED`, `${PREFIX}AC_P`),
    },
    {
      label: "a granted view over a view it may not read, replaced to call that function after the outer view was made",
      grant: [`GRANT SELECT ON ${OWNER}.${PREFIX}OUTER TO ${RO}`],
      revoke: [`REVOKE SELECT ON ${OWNER}.${PREFIX}OUTER FROM ${RO}`],
      names: `REVOKE ALL ON "${OWNER}"."${PREFIX}OUTER" FROM "${RO}"`,
    },
    {
      label: "a granted view over a view that calls no code but that it may not read",
      grant: [`GRANT SELECT ON ${OWNER}.${PREFIX}PLAIN_OUTER TO ${RO}`],
      revoke: [`REVOKE SELECT ON ${OWNER}.${PREFIX}PLAIN_OUTER FROM ${RO}`],
      names: `REVOKE ALL ON "${OWNER}"."${PREFIX}PLAIN_OUTER" FROM "${RO}"`,
    },
    {
      label: "a granted view that calls that function through a chain of two private synonyms",
      grant: [`GRANT SELECT ON ${OWNER}.${PREFIX}CHAIN_VIEW TO ${RO}`],
      revoke: [`REVOKE SELECT ON ${OWNER}.${PREFIX}CHAIN_VIEW FROM ${RO}`],
      names: `REVOKE ALL ON "${OWNER}"."${PREFIX}CHAIN_VIEW" FROM "${RO}"`,
    },
    {
      label: "a granted view over an invoker's-rights function",
      grant: [`GRANT SELECT ON ${OWNER}.${PREFIX}INVOKER_VIEW TO ${RO}`],
      revoke: [`REVOKE SELECT ON ${OWNER}.${PREFIX}INVOKER_VIEW FROM ${RO}`],
      names: `REVOKE ALL ON "${OWNER}"."${PREFIX}INVOKER_VIEW" FROM "${RO}"`,
    },
    {
      label: "a granted view left invalid by a dropped column",
      grant: [
        `GRANT SELECT ON ${OWNER}.${PREFIX}STALE_VIEW TO ${RO}`,
        `ALTER TABLE ${OWNER}.${PREFIX}STALE DROP COLUMN N`,
        `ALTER TABLE ${OWNER}.${PREFIX}STALE ADD (N NUMBER)`,
      ],
      revoke: [`REVOKE SELECT ON ${OWNER}.${PREFIX}STALE_VIEW FROM ${RO}`],
      names: `REVOKE ALL ON "${OWNER}"."${PREFIX}STALE_VIEW" FROM "${RO}"`,
    },
    {
      label: "a granted view over a table a row-level policy guards, which ALL_POLICIES does not list",
      grant: [
        `GRANT SELECT ON ${OWNER}.${PREFIX}BEHIND_VIEW TO ${RO}`,
        rlsPolicy(OWNER, `${PREFIX}BEHIND`, `${PREFIX}BEHIND_P`),
      ],
      revoke: [
        dropRlsPolicy(OWNER, `${PREFIX}BEHIND`, `${PREFIX}BEHIND_P`),
        `REVOKE SELECT ON ${OWNER}.${PREFIX}BEHIND_VIEW FROM ${RO}`,
      ],
      names: namedPolicy(OWNER, `${PREFIX}BEHIND`, `${PREFIX}BEHIND_P`),
    },
    {
      label: "a granted table with a fine-grained auditing handler",
      grant: [
        `GRANT SELECT ON ${OWNER}.${PREFIX}AUDITED TO ${RO}`,
        fgaPolicy(OWNER, `${PREFIX}AUDITED`, `${PREFIX}FGA_P`, null, true),
      ],
      revoke: [
        dropFgaPolicy(OWNER, `${PREFIX}AUDITED`, `${PREFIX}FGA_P`),
        `REVOKE SELECT ON ${OWNER}.${PREFIX}AUDITED FROM ${RO}`,
      ],
      names: namedPolicy(OWNER, `${PREFIX}AUDITED`, `${PREFIX}FGA_P`),
    },
    {
      label: "a granted view over a table with a fine-grained auditing handler",
      grant: [
        `GRANT SELECT ON ${OWNER}.${PREFIX}AUDITED_VIEW TO ${RO}`,
        fgaPolicy(OWNER, `${PREFIX}AUDITED`, `${PREFIX}FGA_P`, null, true),
      ],
      revoke: [
        dropFgaPolicy(OWNER, `${PREFIX}AUDITED`, `${PREFIX}FGA_P`),
        `REVOKE SELECT ON ${OWNER}.${PREFIX}AUDITED_VIEW FROM ${RO}`,
      ],
      names: namedPolicy(OWNER, `${PREFIX}AUDITED`, `${PREFIX}FGA_P`),
    },
    {
      label: "a granted view over a view granted only DEBUG, which ALL_OBJECTS hides and the check does not examine",
      grant: [
        `GRANT SELECT ON ${OWNER}.${PREFIX}PLAIN_OUTER TO ${RO}`,
        `GRANT DEBUG ON ${OWNER}.${PREFIX}PLAIN_INNER TO ${RO}`,
      ],
      revoke: [
        `REVOKE SELECT ON ${OWNER}.${PREFIX}PLAIN_OUTER FROM ${RO}`,
        `REVOKE DEBUG ON ${OWNER}.${PREFIX}PLAIN_INNER FROM ${RO}`,
      ],
      names: `REVOKE ALL ON "${OWNER}"."${PREFIX}PLAIN_OUTER" FROM "${RO}"`,
    },
    {
      label: "a table of its own with a virtual column, which no revoke takes from it",
      grant: [`CREATE TABLE ${RO}.${PREFIX}MINE (ID NUMBER, V NUMBER GENERATED ALWAYS AS (ID + 1) VIRTUAL)`],
      revoke: [`DROP TABLE ${RO}.${PREFIX}MINE PURGE`],
      names: `move "${RO}"."${PREFIX}MINE" out of the agent user's own schema`,
    },
    {
      label: "a user that may no longer read DBA_POLICIES",
      grant: [`REVOKE SELECT ON SYS.DBA_POLICIES FROM ${RO}`],
      revoke: [`GRANT SELECT ON SYS.DBA_POLICIES TO ${RO}`],
      names: `GRANT SELECT ON SYS.DBA_POLICIES TO "${RO}" (as SYS)`,
      admin: "SYS",
    },
    {
      label: "a user that may no longer read DBA_AUDIT_POLICIES",
      grant: [`REVOKE SELECT ON SYS.DBA_AUDIT_POLICIES FROM ${RO}`],
      revoke: [`GRANT SELECT ON SYS.DBA_AUDIT_POLICIES TO ${RO}`],
      names: `GRANT SELECT ON SYS.DBA_AUDIT_POLICIES TO "${RO}" (as SYS)`,
      admin: "SYS",
    },
    {
      label: "a granted sequence",
      grant: [`GRANT SELECT ON ${OWNER}.${PREFIX}SEQ TO ${RO}`],
      revoke: [`REVOKE SELECT ON ${OWNER}.${PREFIX}SEQ FROM ${RO}`],
      names: `REVOKE ALL ON "${OWNER}"."${PREFIX}SEQ" FROM "${RO}"`,
    },
    {
      label: "a PUBLIC database link",
      grant: [
        `CREATE PUBLIC DATABASE LINK ${PREFIX}LINK CONNECT TO ${OWNER} IDENTIFIED BY "${PASSWORD}" USING 'localhost:1521/${SERVICE}'`,
      ],
      revoke: [`DROP PUBLIC DATABASE LINK ${PREFIX}LINK`],
      names: `DROP PUBLIC DATABASE LINK "${PREFIX}LINK"`,
    },
  ];
  for (const { label, grant, revoke, names, admin = "SYSTEM" } of refusedThenLifted) {
    await setup(admin, grant);
    const refused = await verdict(RO);
    check(
      refused.startsWith("PROFILE_PRIVILEGES_TOO_BROAD") && refused.includes(names),
      `the check refuses ${label}, naming ${names}: ${refused}`,
    );
    await setup(admin, revoke);
    check((await verdict(RO)) === "admitted", `with ${label} gone the user is admitted again`);
  }
  // The policies Oracle ships are admitted: the admitted user reads row-level policies in the fresh database, every one
  // of whose functions XDB, a schema Oracle maintains, owns (capture 00).
  const [vendor] = await as(RO, "SELECT COUNT(*) AS N FROM SYS.DBA_POLICIES");
  check(Number(vendor?.N) > 0, `the admitted user reads ${vendor?.N} row-level policies Oracle ships, and is admitted`);
  // An auditing policy with neither an audit condition nor a handler runs nothing of the owner's, and is admitted.
  await setup("SYSTEM", [fgaPolicy(OWNER, `${PREFIX}AUDITED`, `${PREFIX}PLAIN_P`, null, false)]);
  const plainAudit = await verdict(RO);
  check(
    plainAudit === "admitted",
    `the check admits an auditing policy with no condition and no handler: ${plainAudit}`,
  );
  await setup("SYSTEM", [dropFgaPolicy(OWNER, `${PREFIX}AUDITED`, `${PREFIX}PLAIN_P`)]);
  // What the refused policies would run for the READ ONLY user, read in a session of its own outside the agent path:
  // the row-level policy on SYSTEM.HELP and the audit condition each advance the owner's sequence.
  for (const { label, add, drop, read } of [
    {
      label: "a row-level policy of the owner's on SYSTEM.HELP",
      add: [rlsPolicy("SYSTEM", "HELP", `${PREFIX}HELP_P`)],
      drop: [dropRlsPolicy("SYSTEM", "HELP", `${PREFIX}HELP_P`)],
      read: "SELECT COUNT(*) AS N FROM SYSTEM.HELP",
    },
    {
      // The condition is evaluated with the policy owner's privileges: SYSTEM, which made the policy, is granted EXECUTE
      // on the function by its owner, or the read answers ORA-28112 and runs nothing (measured).
      label: "an audit condition calling a function of the owner's",
      add: [
        `GRANT SELECT ON ${OWNER}.${PREFIX}AUDITED TO ${RO}`,
        fgaPolicy(OWNER, `${PREFIX}AUDITED`, `${PREFIX}AC_P`, `${OWNER}.${PREFIX}AC_FN(ID) = 1`, false),
      ],
      drop: [
        dropFgaPolicy(OWNER, `${PREFIX}AUDITED`, `${PREFIX}AC_P`),
        `REVOKE SELECT ON ${OWNER}.${PREFIX}AUDITED FROM ${RO}`,
      ],
      read: `SELECT COUNT(*) AS N FROM ${OWNER}.${PREFIX}AUDITED`,
    },
  ]) {
    await setup("SYSTEM", add);
    await setup(OWNER, [`GRANT EXECUTE ON ${OWNER}.${PREFIX}AC_FN TO SYSTEM`]);
    const before = await sequenceNumber();
    await as(RO, read);
    const after = await sequenceNumber();
    check(after > before, `${label} ran for the READ ONLY user on a plain SELECT (sequence ${before} -> ${after})`);
    await setup("SYSTEM", drop);
  }
  // A private synonym DBA_POLICIES in the agent user's own schema, over an empty table, hides every policy from an
  // unqualified read, and not from the check, which names the view SYS.DBA_POLICIES.
  await setup("SYSTEM", [
    `GRANT SELECT ON ${OWNER}.${PREFIX}NOPOL TO ${RO}`,
    `CREATE SYNONYM ${RO}.DBA_POLICIES FOR ${OWNER}.${PREFIX}NOPOL`,
    rlsPolicy(OWNER, `${PREFIX}POL`, `${PREFIX}POL_P`),
  ]);
  const [shadowed] = await as(RO, `SELECT COUNT(*) AS N FROM DBA_POLICIES WHERE POLICY_NAME = '${PREFIX}POL_P'`);
  const [qualified] = await as(RO, `SELECT COUNT(*) AS N FROM SYS.DBA_POLICIES WHERE POLICY_NAME = '${PREFIX}POL_P'`);
  check(
    Number(shadowed?.N) === 0 && Number(qualified?.N) === 1,
    `the private synonym hides the policy from an unqualified DBA_POLICIES (${shadowed?.N} rows) and not from SYS.DBA_POLICIES (${qualified?.N})`,
  );
  const shadow = await verdict(RO);
  check(
    shadow.startsWith("PROFILE_PRIVILEGES_TOO_BROAD") &&
      shadow.includes(namedPolicy(OWNER, `${PREFIX}POL`, `${PREFIX}POL_P`)),
    `the check refuses the policy whatever the user's schema holds named DBA_POLICIES: ${shadow}`,
  );
  await setup("SYSTEM", [dropRlsPolicy(OWNER, `${PREFIX}POL`, `${PREFIX}POL_P`)]);
  const shadowAdmitted = await verdict(RO);
  check(
    shadowAdmitted === "admitted",
    `with the policy dropped the user is admitted, the synonym kept: ${shadowAdmitted}`,
  );
  await setup("SYSTEM", [`DROP SYNONYM ${RO}.DBA_POLICIES`, `REVOKE SELECT ON ${OWNER}.${PREFIX}NOPOL FROM ${RO}`]);
  // Views whose synonyms resolve to no code are admitted: DBMS_LOB through Oracle's PUBLIC synonym, a granted table.
  for (const view of [`${PREFIX}LOB_VIEW`, `${PREFIX}DATA_SYN_VIEW`]) {
    await setup("SYSTEM", [`GRANT SELECT ON ${OWNER}.${view} TO ${RO}`]);
    const admitted = await verdict(RO);
    check(
      admitted === "admitted",
      `the check admits a granted view over a synonym that calls no code, ${view}: ${admitted}`,
    );
    await setup("SYSTEM", [`REVOKE SELECT ON ${OWNER}.${view} FROM ${RO}`]);
  }
  // The remedies an over-refusal names: a view leaving out a hidden virtual column, and the inner view granted too.
  for (const views of [[`${PREFIX}FBI_VIEW`], [`${PREFIX}PLAIN_OUTER`, `${PREFIX}PLAIN_INNER`]]) {
    await setup(
      "SYSTEM",
      views.map((view) => `GRANT SELECT ON ${OWNER}.${view} TO ${RO}`),
    );
    const admitted = await verdict(RO);
    check(admitted === "admitted", `the check admits the remedy, a grant on ${views.join(" and ")}: ${admitted}`);
    await setup(
      "SYSTEM",
      views.map((view) => `REVOKE SELECT ON ${OWNER}.${view} FROM ${RO}`),
    );
  }
  // An inner view granted only INSERT is one the check starts from, so it reads that view's dependencies and admits it.
  await setup("SYSTEM", [
    `GRANT SELECT ON ${OWNER}.${PREFIX}PLAIN_OUTER TO ${RO}`,
    `GRANT INSERT ON ${OWNER}.${PREFIX}PLAIN_INNER TO ${RO}`,
  ]);
  const insertOnly = await verdict(RO);
  check(
    insertOnly === "admitted",
    `the check admits a view over a view granted only INSERT, whose dependencies it reads: ${insertOnly}`,
  );
  await setup("SYSTEM", [
    `REVOKE SELECT ON ${OWNER}.${PREFIX}PLAIN_OUTER FROM ${RO}`,
    `REVOKE INSERT ON ${OWNER}.${PREFIX}PLAIN_INNER FROM ${RO}`,
  ]);
  // A private link the user owns: only its owner drops it, and READ ONLY refuses the owner the DROP.
  await setup("SYSTEM", [`ALTER USER ${RO} READ WRITE`, `GRANT CREATE DATABASE LINK TO ${RO}`]);
  await setup(RO, [
    `CREATE DATABASE LINK ${PREFIX}MINE CONNECT TO ${OWNER} IDENTIFIED BY "${PASSWORD}" USING 'localhost:1521/${SERVICE}'`,
  ]);
  await setup("SYSTEM", [`REVOKE CREATE DATABASE LINK FROM ${RO}`, `ALTER USER ${RO} READ ONLY`]);
  const privateLink = await verdict(RO);
  const linkName = privateLink.match(/DROP DATABASE LINK "([^"]+)"/)?.[1] ?? `${PREFIX}MINE`;
  check(
    privateLink.startsWith("PROFILE_PRIVILEGES_TOO_BROAD") &&
      privateLink.includes(
        `ALTER USER "${RO}" READ WRITE; DROP DATABASE LINK "${linkName}" (as ${RO}); ALTER USER "${RO}" READ ONLY`,
      ),
    `the check refuses a private link the user owns, naming the drop between READ WRITE and READ ONLY: ${privateLink}`,
  );
  let readOnlyDrop = "ran";
  try {
    await as(RO, `DROP DATABASE LINK "${linkName}"`);
  } catch (error) {
    readOnlyDrop = (error as Error).message;
  }
  check(/ORA-28194/.test(readOnlyDrop), `the READ ONLY owner is refused the DROP of its own link: ${readOnlyDrop}`);
  await setup("SYSTEM", [`ALTER USER ${RO} READ WRITE`]);
  await setup(RO, [`DROP DATABASE LINK "${linkName}"`]);
  await setup("SYSTEM", [`ALTER USER ${RO} READ ONLY`]);
  check((await verdict(RO)) === "admitted", "with the private link dropped as named the user is admitted again");
  await setup("SYS", [
    `CREATE OR REPLACE DIRECTORY ${PREFIX}DIR AS '/tmp'`,
    `GRANT READ ON DIRECTORY ${PREFIX}DIR TO ${RO}`,
  ]);
  const directory = await verdict(RO);
  check(
    directory.startsWith("PROFILE_PRIVILEGES_TOO_BROAD") &&
      directory.includes(`REVOKE READ ON DIRECTORY "${PREFIX}DIR" FROM "${RO}"`),
    `the check refuses a directory grant, which BFILENAME reads server files through: ${directory}`,
  );
  await setup("SYS", [`DROP DIRECTORY ${PREFIX}DIR`]);
  check((await verdict(RO)) === "admitted", "with the directory gone the user is admitted again");
  const alterSystem = await verdict(RO_SYS);
  check(
    alterSystem.startsWith("PROFILE_PRIVILEGES_TOO_BROAD") &&
      alterSystem.includes(`REVOKE ALTER SYSTEM FROM "${RO_SYS}"`),
    `the check refuses a READ ONLY user holding ALTER SYSTEM: ${alterSystem}`,
  );

  // The operations profile opens a writable user unproven, as plan mode grounds; an editor handle refuses.
  const operations = await createDatabaseProvider(connection(OWNER), {}, executionContextFor("agent-operations"));
  await operations.connect();
  const objects = await operations.listObjects([OWNER], "table");
  check(
    objects.some((object) => object.name === `${PREFIX}DATA`),
    "the operations profile opens the schema owner, a writable user, and lists its tables",
  );
  check(
    (await agentAnswer(operations, "SELECT 1 FROM DUAL")).startsWith(
      "refused: Read-only execution requires a provider opened under the agent read-only profile",
    ),
    "the operations profile's handle refuses queryReadOnly",
  );
  await operations.disconnect();
  // Plan mode under an agent credential grounds as the READ ONLY user itself, on the ALL_* views it reads with no grant.
  const grounding = await createDatabaseProvider(connection(RO), {}, executionContextFor("agent-operations"));
  await grounding.connect();
  const seen = await grounding.listObjects([OWNER], "table");
  const described = await grounding.describeObjects([OWNER], "table");
  check(
    seen.some((object) => object.name === `${PREFIX}DATA`) &&
      described.details.some((detail) => detail.path.at(-1) === `${PREFIX}DATA` && (detail.columns?.length ?? 0) === 3),
    `the operations profile opens the READ ONLY user and grounds on the tables it may read (${seen.length} listed)`,
  );
  const health = await grounding.getHealth();
  console.log(`INFO the READ ONLY user's health reading: ${JSON.stringify(health).slice(0, 300)}`);
  await grounding.disconnect();
  const editor = await createDatabaseProvider(connection(OWNER));
  await editor.connect();
  check(
    (await agentAnswer(editor, "SELECT 1 FROM DUAL")).startsWith(
      "refused: Read-only execution requires a provider opened under the agent read-only profile",
    ),
    "an editor handle refuses queryReadOnly before sending anything",
  );

  // The boundary: every write refused for the admitted user, and run by the owner as the positive control.
  const agent = await agentFor(RO);
  const before = await snapshot();
  for (const { label, agent: sql } of WRITES) {
    const answer = await agentAnswer(agent, sql);
    // ALTER SESSION SET READ_ONLY inside the call's read-only transaction answers ORA-65023 before the write is reached.
    check(
      /ORA-(28194|65023)/.test(answer),
      `${label} as the READ ONLY user is refused with ORA-28194 or ORA-65023: ${answer}`,
    );
  }
  const second = await agentAnswer(agent, `SELECT 1 FROM DUAL; DELETE FROM ${OWNER}.${PREFIX}SCRATCH`);
  check(
    second.startsWith("refused:") && /ORA-0(0933|0911|3405|3048)/.test(second),
    `a second statement is refused by the parser: ${second}`,
  );
  const grant = await agentAnswer(agent, `GRANT SELECT ON ${OWNER}.${PREFIX}DATA TO PUBLIC`);
  check(/ORA-(28194|01031|01749)/.test(grant), `GRANT as the READ ONLY user is refused: ${grant}`);
  const alter = await agentAnswer(agent, "ALTER SYSTEM SET OPEN_CURSORS = 333");
  check(/ORA-(28194|01031)/.test(alter), `ALTER SYSTEM as the admitted user is refused: ${alter}`);
  check((await snapshot()) === before, `the engine state reads the same after the refused writes: ${before}`);

  for (const { label, owner: sql } of WRITES) {
    let answer = "ran";
    try {
      await editor.query(sql);
    } catch (error) {
      answer = `refused: ${(error as Error).message}`;
    }
    check(answer === "ran", `positive control: ${label} runs as the writable schema owner: ${answer}`);
  }
  await setup(
    OWNER,
    [`DROP TABLE ${PREFIX}NEW PURGE`, `DROP TABLE ${PREFIX}GTT PURGE`, `DELETE FROM ${PREFIX}SCRATCH`],
    ["ORA-"],
  );
  await editor.disconnect();

  // The edition a session reads in cannot be switched inside the call's read-only transaction.
  const edition = await agentAnswer(agent, "ALTER SESSION SET EDITION = ORA$BASE");
  check(/ORA-38814/.test(edition), `ALTER SESSION SET EDITION as the admitted user is refused: ${edition}`);

  // What reaches past READ ONLY: an Oracle-maintained PUBLIC sequence.
  const sequence = await agentAnswer(agent, "SELECT SYS.SCHEDULER$_JOBSUFFIX_S.NEXTVAL AS N FROM DUAL");
  check(sequence === "ran", `residual: a PUBLIC sequence Oracle maintains advances for the admitted user: ${sequence}`);
  const seqAfter = await snapshot();

  // What the agent composes: each catalog kind answered as the admitted user.
  for (const kind of ["columns", "relations", "indexes", "statistics"] as const) {
    const sql = composeCatalogRead("oracle", { kind, schema: OWNER });
    let rows: Record<string, unknown>[] = [];
    let answer = "ran";
    try {
      rows = (await agent.queryReadOnly?.(sql, { ...BUDGET, maxResultRows: 1_000, maxResultBytes: 1024 * 1024 }))
        ?.rows as Record<string, unknown>[];
    } catch (error) {
      answer = `refused: ${(error as Error).message}`;
    }
    check(
      answer === "ran" && rows.some((row) => String(row.table_name).startsWith(PREFIX)),
      `the ${kind} catalog read answers as the admitted user (${rows.length} rows): ${answer}`,
    );
  }

  // The budgets.
  const many = "SELECT LEVEL AS N FROM DUAL CONNECT BY LEVEL <= 60";
  check(
    (await agentAnswer(agent, many)).startsWith("refused: Read-only execution exceeded the row budget: 51 rows > 50"),
    "budget: 60 rows under a budget of 50 are refused at the 51st",
  );
  check(
    (
      await agentAnswer(agent, `SELECT DOC FROM ${OWNER}.${PREFIX}DATA WHERE ID = 2`, {
        ...BUDGET,
        maxResultBytes: 10_000,
      })
    ).startsWith("refused: Read-only execution exceeded the byte budget"),
    "budget: a 30,000-character CLOB under a byte budget of 10,000 is refused",
  );
  const clob = await agent.queryReadOnly?.(`SELECT DOC FROM ${OWNER}.${PREFIX}DATA WHERE ID = 1`, BUDGET);
  check(clob?.rows[0]?.DOC === "clob one", "a CLOB under the budgets is answered as a string");
  check(
    (await agentAnswer(agent, "SELECT BFILENAME('DATA_PUMP_DIR', 'x') AS F FROM DUAL")).startsWith(
      "refused: Read-only execution refused column F of type BFILE",
    ),
    "a BFILE column is refused before any value is read",
  );
  // A nested cursor is refused from the metadata, before the driver fetches it: 51^3 rows if it expanded them.
  const nested =
    "SELECT CURSOR(SELECT CURSOR(SELECT LEVEL FROM DUAL CONNECT BY LEVEL <= 1000) FROM DUAL CONNECT BY LEVEL <= 1000) AS C1 FROM DUAL CONNECT BY LEVEL <= 1000";
  const rssBefore = process.memoryUsage().rss;
  const startedAt = Date.now();
  const cursor = await agentAnswer(agent, nested);
  const grewMb = Math.round((process.memoryUsage().rss - rssBefore) / 1024 / 1024);
  check(
    cursor.startsWith("refused: Read-only execution refused column C1 of type CURSOR") && grewMb < 20,
    `a nested CURSOR column is refused before any of it is fetched, in ${Date.now() - startedAt}ms, RSS +${grewMb} MB: ${cursor}`,
  );
  check(
    (await agentAnswer(agent, "BEGIN DBMS_SESSION.SLEEP(5); END;", { ...BUDGET, statementTimeoutMs: 1_000 })) ===
      "refused: Read-only execution exceeded the time budget: no answer within 1000ms",
    "budget: a statement past a one-second deadline is refused",
  );
  check((await agentAnswer(agent, "SELECT 1 FROM DUAL")) === "ran", "the next statement answers after the deadline");
  check((await snapshot()) === seqAfter, "the engine state reads the same after the budget checks");
  await agent.disconnect();
}

try {
  await main();
} finally {
  await cleanup();
}
console.log(failures === 0 ? "every check passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
