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
 *    packages; the revoke script the refusal names, run as SYS, lifts it;
 *  - the check refuses a user that is not READ ONLY, one granted EXECUTE on a definer's-rights function, one granted a
 *    sequence, one holding a role that is not a default role, one granted a directory, one holding ALTER SYSTEM, and
 *    any user while a PUBLIC database link exists, and admits each again once the grant is gone;
 *  - the boundary, with Studio's client admission bypassed: every write, DDL, temporary table, lock, transaction
 *    statement, PL/SQL write and second statement is sent through `queryReadOnly` as the admitted user and refused,
 *    each classified by its ORA- code; the same writes run as the schema owner through the editor path, the positive
 *    control that shows each one would work; the tables, the sequence and the parameter read back the same before and
 *    after;
 *  - what reaches past READ ONLY and is not refused: a PUBLIC sequence Oracle maintains, and a view over a definer's
 *    function, each recorded as the server answered;
 *  - the operations profile opens the schema owner, a writable user, unproven, and reads its objects, which is what
 *    plan mode grounds on; an editor handle refuses `queryReadOnly` before sending anything;
 *  - the catalog reads the overlay composes, each answered as the admitted user;
 *  - the budgets: a result past the row budget, one past the byte budget, a BFILE column and a statement past its
 *    deadline are refused, and a CLOB under them is answered as a string.
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
  `CREATE SEQUENCE ${OWNER}.${PREFIX}SEQ`,
  `CREATE OR REPLACE FUNCTION ${OWNER}.${PREFIX}NEXT RETURN NUMBER AS BEGIN RETURN ${OWNER}.${PREFIX}SEQ.NEXTVAL; END;`,
  `CREATE OR REPLACE VIEW ${OWNER}.${PREFIX}NEXT_VIEW AS SELECT ${OWNER}.${PREFIX}NEXT() AS N FROM DUAL`,
  `CREATE OR REPLACE FUNCTION ${OWNER}.${PREFIX}NEXT_DET(x NUMBER) RETURN NUMBER DETERMINISTIC AS BEGIN RETURN ${OWNER}.${PREFIX}SEQ.NEXTVAL; END;`,
  `CREATE TABLE ${OWNER}.${PREFIX}VIRT (ID NUMBER, N NUMBER GENERATED ALWAYS AS (${OWNER}.${PREFIX}NEXT_DET(ID)) VIRTUAL)`,
  `INSERT INTO ${OWNER}.${PREFIX}VIRT (ID) VALUES (1)`,
  `GRANT SELECT ON ${OWNER}.${PREFIX}VIRT TO ${RO}`,
  `CREATE ROLE ${PREFIX}ROLE`,
  `GRANT SELECT ON ${OWNER}.${PREFIX}DATA TO ${RO}`,
  `GRANT SELECT ON ${OWNER}.${PREFIX}CHILD TO ${RO}`,
  `GRANT SELECT, INSERT, UPDATE, DELETE ON ${OWNER}.${PREFIX}SCRATCH TO ${RO}`,
];

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

async function cleanup(): Promise<void> {
  await setup(
    "SYSTEM",
    [
      `DROP USER ${RO} CASCADE`,
      `DROP USER ${RO_SYS} CASCADE`,
      `DROP ROLE ${PREFIX}ROLE`,
      `DROP PUBLIC DATABASE LINK ${PREFIX}LINK`,
      `DROP VIEW ${OWNER}.${PREFIX}NEXT_VIEW`,
      `DROP TABLE ${OWNER}.${PREFIX}VIRT PURGE`,
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

  // The fresh database refuses its own read-only user: PUBLIC holds EXECUTE on the network and file packages.
  const fresh = await verdict(RO);
  check(
    fresh.startsWith("PROFILE_PRIVILEGES_TOO_BROAD") &&
      fresh.includes('REVOKE EXECUTE ON "SYS"."UTL_HTTP" FROM PUBLIC'),
    `a fresh database refuses its READ ONLY user until PUBLIC's grants are revoked: ${fresh}`,
  );
  await setup("SYS", REVOKES_AS_SYS, ["ORA-01927"]);
  check((await verdict(RO)) === "admitted", "after the revoke script the READ ONLY user is admitted");

  // Each grant the check refuses, refused and then lifted.
  const refusedThenLifted: readonly {
    label: string;
    grant: string[];
    revoke: string[];
    names: string;
    user?: string;
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
  for (const { label, grant, revoke, names } of refusedThenLifted) {
    await setup("SYSTEM", grant);
    const refused = await verdict(RO);
    check(
      refused.startsWith("PROFILE_PRIVILEGES_TOO_BROAD") && refused.includes(names),
      `the check refuses ${label}, naming ${names}: ${refused}`,
    );
    await setup("SYSTEM", revoke);
    check((await verdict(RO)) === "admitted", `with ${label} gone the user is admitted again`);
  }
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

  // What reaches past READ ONLY: an Oracle-maintained PUBLIC sequence, and a virtual column over a definer's function.
  const sequence = await agentAnswer(agent, "SELECT SYS.SCHEDULER$_JOBSUFFIX_S.NEXTVAL AS N FROM DUAL");
  check(sequence === "ran", `residual: a PUBLIC sequence Oracle maintains advances for the admitted user: ${sequence}`);
  const seqBefore = await snapshot();
  const virtual = await agentAnswer(agent, `SELECT N FROM ${OWNER}.${PREFIX}VIRT`);
  const seqAfter = await snapshot();
  check(
    virtual === "ran" && seqAfter !== seqBefore,
    `residual: a virtual column over a definer's function advances its sequence for the admitted user: ${virtual}; before ${seqBefore}, after ${seqAfter}`,
  );

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
