/**
 * Live check of the Db2 LUW agent read-only execution profile, against a server of the operator's choosing.
 *
 * WHY THIS EXISTS, AND WHY IT CANNOT BE A UNIT TEST. The boundary is the server's: a user holding CONNECT and SELECT,
 * which Db2 refuses every write for, and a check before every statement that the user reaches nothing those leave open
 * (`agent-read.ts`). The provider suite replays answers its author wrote; whether the server refuses a statement, and
 * what the catalog lists for a user, is the server's to say. So this script asks a real server through the production
 * path (`createDatabaseProvider` with the profile's execution context, then `connect` and `queryReadOnly`):
 *
 *  - the seeded user (docker/db2-init/02-agent-principal.sql) is admitted, and reads its two tables;
 *  - the boundary, with Studio's client admission bypassed: an INSERT, a data change in `FINAL TABLE`, the same placed
 *    in the outer FROM by closing the derived table early, `NEXT VALUE FOR`, a `BEGIN ATOMIC` block, `CALL
 *    SYSPROC.ADMIN_CMD`, `SET CURRENT SCHEMA`, a declared temporary table, `LOCK TABLE` and `COMMIT` are each refused by
 *    the server, classified by SQLCODE; the same statements sent raw as the agent user are refused by its privileges;
 *    the instance owner runs them raw in a unit of work it rolls back, the positive control; the rows and the
 *    sequence read back the same before and after;
 *  - the check refuses, and admits again once the grant, the object or the control is gone: EXECUTE on an SQL table
 *    function that writes, granted to the user, to PUBLIC, to a role, and through a grant on every function of a
 *    schema; a module of the owner's; a package of the owner's; READ on a variable of the owner's; USAGE on a sequence;
 *    INSERT on a table; CREATEIN on a schema; CREATETAB and IMPLICIT_SCHEMA on the database, to PUBLIC; DBADM; a view
 *    that calls a function of the owner's; EXECUTE on IBM's UTL_FILE and DBMS_PIPE modules and on its AUDIT_ARCHIVE
 *    table function, each acting outside the call by its own catalog row; a view calling IBM's DBMS_RANDOM.VALUE; a
 *    view over a view it may not read; a view over an alias of a table it may not read; a view left inoperative; a column mask anywhere in the database; SETSESSIONUSER; a role with its ADMIN
 *    OPTION; a trusted context naming the user as its system authorization ID, on the address the server sees this
 *    script at, whose default role a raw connection of the user is first shown to hold, and the same context
 *    disabled; and on one handle a grant added after a call refuses the next call, and its revoke admits the one after;
 *  - it admits a view over a table, a view over a view it may read, a view calling IBM's own function, IBM's DB_MEMBERS
 *    and a view calling GET_INDEX_COLNAMES, both on the list of IBM functions measured as reading only;
 *  - each call has a connection of its own: what one call's session holds is not the next one's;
 *  - the operations profile opens the instance owner unproven; an editor handle refuses `queryReadOnly`;
 *  - the catalog reads the overlay composes, each answered as the agent user;
 *  - the budgets: a result past the row budget, one past the byte budget, a CLOB, a BLOB and an XML column, and a
 *    statement past its deadline are refused, and the next call answers.
 *
 * It is NOT in `bun run test`: the runner excludes `tests/live/` by name. Run it against a disposable database whose
 * instance owner is DB2INST1, holding the object fixture and the seeded agent user, such as the compose service:
 *
 *   docker compose -f database-compose.yml up -d db2
 *   LIBREDB_LIVE_DB2_PORT=50000 LIBREDB_LIVE_DB2_PASSWORD=<db2inst1's password> bun tests/live/db2-agent-boundary.ts
 *
 * Every object it creates carries the `LIBREDB_AB` prefix and is dropped on exit. Each check prints one line, and a run
 * with a failing check ends non-zero.
 */
// oxlint-disable no-await-in-loop -- the checks run one at a time on purpose: each reads what the server holds after the one before.
import { Client } from "db2-node";
import { composeCatalogRead } from "@/lib/agent/composed-sql";
import { ExecutionProfileError } from "@/lib/db/errors";
import { createDatabaseProvider, executionContextFor } from "@/lib/db/factory";
import type { DatabaseProvider } from "@/lib/db/types";
import type { DatabaseConnection } from "@/lib/types";

const PREFIX = "LIBREDB_AB";
const BUDGET = { statementTimeoutMs: 10_000, maxResultRows: 50, maxResultBytes: 64 * 1024 };

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

let failures = 0;
function check(ok: boolean, line: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
  if (!ok) failures++;
}

function connection(id: string, user: string, password: string): DatabaseConnection {
  return {
    id,
    name: id,
    type: "db2",
    host: HOST,
    port: PORT,
    database: DATABASE,
    user,
    password,
    // A container with no TLS listener: the explicit opt-in the provider otherwise refuses a cleartext password without.
    allowInsecureAuth: true,
    createdAt: new Date(),
  };
}

/** A raw client of the instance owner or the agent user, autocommitting each statement. */
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

function sqlcode(error: unknown): number | undefined {
  const match = /SQLCODE=(-?\d+)/.exec(error instanceof Error ? error.message : String(error));
  return match === null ? undefined : Number(match[1]);
}

const agentProfile = (id: string): Promise<DatabaseProvider> =>
  createDatabaseProvider(connection(id, "agent_ro", AGENT_PASSWORD), {}, executionContextFor("agent-read-only"));

async function refusalOf(provider: DatabaseProvider, sql: string, budget = BUDGET): Promise<unknown> {
  try {
    await provider.queryReadOnly?.(sql, budget);
    return undefined;
  } catch (error) {
    return error;
  }
}

/** The check refuses the agent user while `grant` holds, naming `names`, and admits it once `lift` ran. */
async function refusedUntilLifted(
  provider: DatabaseProvider,
  what: string,
  grant: readonly string[],
  lift: readonly string[],
  names: string,
): Promise<void> {
  await setup(grant);
  const refused = await refusalOf(provider, "SELECT ID FROM APP.ORDERS");
  check(
    refused instanceof ExecutionProfileError && refused.message.includes(names),
    `${what}: refused, naming ${names}${refused instanceof Error && !refused.message.includes(names) ? ` (got: ${refused.message.slice(0, 300)})` : ""}`,
  );
  await setup(lift);
  const admitted = await refusalOf(provider, "SELECT ID FROM APP.ORDERS");
  check(
    admitted === undefined,
    `${what}: admitted once lifted${admitted instanceof Error ? ` (got: ${admitted.message.slice(0, 300)})` : ""}`,
  );
}

const CLEANUP = [
  "DROP VIEW APP.LIBREDB_AB_RANDOM",
  "DROP VIEW APP.LIBREDB_AB_LISTED",
  "DROP VIEW APP.LIBREDB_AB_OUTER",
  "DROP VIEW APP.LIBREDB_AB_INNER",
  "DROP VIEW APP.LIBREDB_AB_CALLS",
  "DROP VIEW APP.LIBREDB_AB_PLAIN",
  "DROP VIEW APP.LIBREDB_AB_IBM",
  "DROP VIEW APP.LIBREDB_AB_OVER_ALIAS",
  "DROP VIEW APP.LIBREDB_AB_BROKEN",
  "DROP TABLE APP.LIBREDB_AB_GONE",
  "DROP ALIAS APP.LIBREDB_AB_ALIAS",
  "DROP MASK APP.LIBREDB_AB_MASK",
  "DROP FUNCTION APP.LIBREDB_AB_WRITE",
  "DROP FUNCTION APP.LIBREDB_AB_READ",
  "DROP MODULE APP.LIBREDB_AB_MOD",
  "DROP VARIABLE APP.LIBREDB_AB_VAR",
  "DROP TABLE APP.LIBREDB_AB_LEDGER",
  "DROP TABLE APP.LIBREDB_AB_SECRET",
  "DROP TRUSTED CONTEXT LIBREDB_AB_CTX",
  "DROP ROLE LIBREDB_AB_ROLE",
  "DROP SEQUENCE APP.LIBREDB_AB_SEQ",
  "DROP TABLE LIBREDB_AB_IMPLICIT.T",
  "DROP SCHEMA LIBREDB_AB_IMPLICIT RESTRICT",
];

try {
  await setup(CLEANUP);
  await setup([
    "CREATE TABLE APP.LIBREDB_AB_SECRET (V VARCHAR(20))",
    "INSERT INTO APP.LIBREDB_AB_SECRET VALUES ('owner-only')",
    "CREATE TABLE APP.LIBREDB_AB_LEDGER (N INTEGER)",
    "CREATE SEQUENCE APP.LIBREDB_AB_SEQ START WITH 1",
    "CREATE FUNCTION APP.LIBREDB_AB_WRITE () RETURNS TABLE (N INTEGER) LANGUAGE SQL MODIFIES SQL DATA " +
      "BEGIN ATOMIC INSERT INTO APP.LIBREDB_AB_LEDGER VALUES (1); RETURN SELECT COUNT(*) FROM APP.LIBREDB_AB_LEDGER; END",
    "CREATE FUNCTION APP.LIBREDB_AB_READ () RETURNS VARCHAR(20) LANGUAGE SQL READS SQL DATA " +
      "RETURN (SELECT MAX(V) FROM APP.LIBREDB_AB_SECRET)",
    "CREATE ROLE LIBREDB_AB_ROLE",
  ]);

  const provider = await agentProfile("live-db2-agent");
  await provider.connect();

  // ---- The seeded user is admitted -------------------------------------------------------------------------------
  const first = await refusalOf(provider, "SELECT ID FROM APP.ORDERS ORDER BY ID");
  check(first === undefined, `the seeded agent user is admitted${first instanceof Error ? `: ${first.message}` : ""}`);

  // ---- The boundary, with the client's admission bypassed ----------------------------------------------------------
  const before = {
    customers: Number((await rows("SELECT COUNT(*) AS N FROM APP.CUSTOMERS"))[0].N),
    seq: String(
      (
        await rows(
          "SELECT NEXTCACHEFIRSTVALUE AS V FROM SYSCAT.SEQUENCES WHERE SEQSCHEMA = 'APP' AND SEQNAME = 'ORDER_SEQ'",
        )
      )[0].V,
    ),
  };
  const writes: [string, string, number[]][] = [
    ["INSERT", "INSERT INTO APP.CUSTOMERS VALUES (99, 'x')", [-104]],
    ["FINAL TABLE", "SELECT * FROM FINAL TABLE (INSERT INTO APP.CUSTOMERS VALUES (99, 'x'))", [-20165]],
    ["NEXT VALUE FOR", "VALUES NEXT VALUE FOR APP.ORDER_SEQ", [-348]],
    ["BEGIN ATOMIC", "BEGIN ATOMIC INSERT INTO APP.CUSTOMERS VALUES (99, 'x'); END", [-104]],
    [
      "CALL ADMIN_CMD",
      "CALL SYSPROC.ADMIN_CMD('EXPORT TO /tmp/libredb_ab.del OF DEL SELECT * FROM APP.ORDERS')",
      [-104],
    ],
    ["SET CURRENT SCHEMA", "SET CURRENT SCHEMA = 'APP'", [-104]],
    ["DECLARE GLOBAL TEMPORARY TABLE", "DECLARE GLOBAL TEMPORARY TABLE SESSION.T (ID INTEGER)", [-104]],
    ["LOCK TABLE", "LOCK TABLE APP.ORDERS IN EXCLUSIVE MODE", [-104]],
    ["COMMIT", "COMMIT", [-104]],
    ["a second statement", "SELECT 1 FROM SYSIBM.SYSDUMMY1; DELETE FROM APP.CUSTOMERS", [-104]],
  ];
  for (const [label, sql, codes] of writes) {
    const refused = await refusalOf(provider, sql);
    const code = sqlcode(refused);
    check(
      code !== undefined && codes.includes(code),
      `${label}: refused by the server through queryReadOnly (SQLCODE ${code})`,
    );
  }
  // Closing the derived table early to put the data change in the outer FROM is refused before it is sent; sent raw by
  // the instance owner, the same wrapped text is refused by the server too, since the change is joined to the table.
  const outerFinal =
    "SELECT 1 AS A FROM SYSIBM.SYSDUMMY1) AS X, FINAL TABLE (INSERT INTO APP.CUSTOMERS VALUES (99, 'x')) AS Y, " +
    "(SELECT 1 AS B FROM SYSIBM.SYSDUMMY1";
  const outerRefused = await refusalOf(provider, outerFinal);
  let outerRaw: unknown;
  try {
    await admin.query(
      `SELECT * FROM (\n${outerFinal}\n) AS LIBREDB_AGENT_READ ORDER BY ORDER OF LIBREDB_AGENT_READ FETCH FIRST 2 ROWS ONLY`,
    );
  } catch (error) {
    outerRaw = error;
  }
  check(
    outerRefused instanceof Error &&
      outerRefused.message.includes("it closes a parenthesis it did not open") &&
      sqlcode(outerRaw) === -20165,
    `FINAL TABLE in the outer FROM: refused before it is sent, and raw by the server (SQLCODE ${sqlcode(outerRaw)})`,
  );
  // The same, raw as the agent user: its privileges refuse each one the parser would let through.
  const agent = await raw("agent_ro", AGENT_PASSWORD);
  const rawRefusals: [string, string, number][] = [
    ["INSERT", "INSERT INTO APP.CUSTOMERS VALUES (99, 'x')", -551],
    ["FINAL TABLE", "SELECT * FROM FINAL TABLE (INSERT INTO APP.CUSTOMERS VALUES (99, 'x'))", -551],
    ["NEXT VALUE FOR", "VALUES NEXT VALUE FOR APP.ORDER_SEQ", -551],
    ["BEGIN ATOMIC", "BEGIN ATOMIC INSERT INTO APP.CUSTOMERS VALUES (99, 'x'); END", -551],
    ["CALL ADMIN_CMD", "CALL SYSPROC.ADMIN_CMD('EXPORT TO /tmp/libredb_ab.del OF DEL SELECT * FROM APP.ORDERS')", -551],
    ["CREATE TABLE", "CREATE TABLE AGENT_RO.LIBREDB_AB_T (ID INTEGER)", -552],
    [
      "CREATE FUNCTION in SYSTOOLS",
      "CREATE FUNCTION SYSTOOLS.LIBREDB_AB_F () RETURNS INTEGER LANGUAGE SQL RETURN 1",
      -551,
    ],
    ["UPDATE SYSSTAT", "UPDATE SYSSTAT.TABLES SET CARD = 7 WHERE TABSCHEMA = 'APP' AND TABNAME = 'ORDERS'", -551],
  ];
  for (const [label, sql, code] of rawRefusals) {
    let caught: unknown;
    try {
      await agent.query(sql);
    } catch (error) {
      caught = error;
    }
    check(
      sqlcode(caught) === code,
      `${label}: refused raw to the agent user by privilege (SQLCODE ${sqlcode(caught)})`,
    );
  }
  await agent.close();
  // The positive control: the instance owner's writes run, in a unit of work rolled back.
  const tx = await admin.beginTransaction();
  let ran = 0;
  for (const sql of [
    "INSERT INTO APP.CUSTOMERS VALUES (99, 'x')",
    "SELECT * FROM FINAL TABLE (INSERT INTO APP.CUSTOMERS VALUES (98, 'y'))",
    "VALUES NEXT VALUE FOR APP.LIBREDB_AB_SEQ",
    "BEGIN ATOMIC INSERT INTO APP.CUSTOMERS VALUES (97, 'z'); END",
    "LOCK TABLE APP.ORDERS IN EXCLUSIVE MODE",
  ]) {
    await tx.query(sql);
    ran++;
  }
  await tx.rollback();
  check(
    ran === 5,
    "positive control: the instance owner's INSERT, FINAL TABLE, NEXT VALUE FOR, BEGIN ATOMIC and LOCK TABLE ran",
  );
  const after = {
    customers: Number((await rows("SELECT COUNT(*) AS N FROM APP.CUSTOMERS"))[0].N),
    seq: String(
      (
        await rows(
          "SELECT NEXTCACHEFIRSTVALUE AS V FROM SYSCAT.SEQUENCES WHERE SEQSCHEMA = 'APP' AND SEQNAME = 'ORDER_SEQ'",
        )
      )[0].V,
    ),
  };
  check(
    after.customers === before.customers && after.seq === before.seq,
    "the rows and APP.ORDER_SEQ read back the same",
  );

  // ---- The row bound holds: a statement that closes the derived table early is refused before it is sent ------------
  const breakouts: [string, string][] = [
    ["a lateral read", "SELECT 1 AS A FROM SYSIBM.SYSDUMMY1) AS X, LATERAL (SELECT COLNAME FROM SYSCAT.COLUMNS"],
    ["a union", "SELECT COLNAME FROM SYSCAT.COLUMNS) AS X UNION ALL SELECT * FROM (SELECT COLNAME FROM SYSCAT.COLUMNS"],
    ["a table expression", "SELECT 1 AS A FROM SYSIBM.SYSDUMMY1) AS X, TABLE (SELECT COLNAME FROM SYSCAT.COLUMNS"],
  ];
  for (const [label, sql] of breakouts) {
    const refused = await refusalOf(provider, sql);
    check(
      refused instanceof Error && refused.message.includes("it closes a parenthesis it did not open"),
      `closing the derived table early to add ${label}: refused before it is sent`,
    );
  }
  // Measured raw, the same wrapped text: the lateral and table forms still end under the outer FETCH FIRST, and the union
  // form is refused by the server, whose outer ORDER BY ORDER OF cannot name the derived table there.
  const wrap = (sql: string) =>
    `SELECT * FROM (\n${sql}\n) AS LIBREDB_AGENT_READ ORDER BY ORDER OF LIBREDB_AGENT_READ FETCH FIRST 2 ROWS ONLY`;
  const lateral = (await admin.query(wrap(breakouts[0][1]))).rows.length;
  const tableForm = (await admin.query(wrap(breakouts[2][1]))).rows.length;
  let union: unknown;
  try {
    await admin.query(wrap(breakouts[1][1]));
  } catch (error) {
    union = error;
  }
  check(
    lateral === 2 && tableForm === 2 && sqlcode(union) === -204,
    `raw, the lateral and table forms answer at most 2 rows (${lateral}, ${tableForm}) and the union form is refused (SQLCODE ${sqlcode(union)})`,
  );
  const quoted = await provider.queryReadOnly?.(
    "SELECT ')' AS P, ID FROM APP.ORDERS -- )\nWHERE ID IN (1, 2) /* ( */ ORDER BY ID",
    BUDGET,
  );
  check(
    quoted?.rows.length === 2,
    "a parenthesis inside a literal or a comment is read past, and the statement answers",
  );

  // ---- The check, before every statement -------------------------------------------------------------------------
  await refusedUntilLifted(
    provider,
    "EXECUTE on an SQL table function that writes, granted to the user",
    ["GRANT EXECUTE ON FUNCTION APP.LIBREDB_AB_WRITE TO USER AGENT_RO"],
    ["REVOKE EXECUTE ON FUNCTION APP.LIBREDB_AB_WRITE FROM USER AGENT_RO RESTRICT"],
    'REVOKE EXECUTE ON SPECIFIC FUNCTION "APP"."SQL',
  );
  // Measured first: the granted function writes with its owner's authority for the agent user's SELECT.
  await setup(["GRANT EXECUTE ON FUNCTION APP.LIBREDB_AB_WRITE TO USER AGENT_RO"]);
  {
    const agentRaw = await raw("agent_ro", AGENT_PASSWORD);
    await agentRaw.query("SELECT * FROM TABLE (APP.LIBREDB_AB_WRITE()) AS T");
    // The SQL COMMIT statement is the agent user's to send raw; inside queryReadOnly's derived table it is refused.
    await agentRaw.query("COMMIT");
    await agentRaw.close();
    const ledger = Number((await rows("SELECT COUNT(*) AS N FROM APP.LIBREDB_AB_LEDGER"))[0].N);
    check(ledger === 1, "the granted SQL table function wrote a row for the agent user, which holds no INSERT");
  }
  await setup(["REVOKE EXECUTE ON FUNCTION APP.LIBREDB_AB_WRITE FROM USER AGENT_RO RESTRICT"]);
  await refusedUntilLifted(
    provider,
    "EXECUTE on that function to PUBLIC",
    ["GRANT EXECUTE ON FUNCTION APP.LIBREDB_AB_WRITE TO PUBLIC"],
    ["REVOKE EXECUTE ON FUNCTION APP.LIBREDB_AB_WRITE FROM PUBLIC RESTRICT"],
    "FROM PUBLIC RESTRICT",
  );
  await refusedUntilLifted(
    provider,
    "EXECUTE on that function to a role the user holds",
    [
      "GRANT ROLE LIBREDB_AB_ROLE TO USER AGENT_RO",
      "GRANT EXECUTE ON FUNCTION APP.LIBREDB_AB_WRITE TO ROLE LIBREDB_AB_ROLE",
    ],
    ["REVOKE ROLE LIBREDB_AB_ROLE FROM USER AGENT_RO"],
    'FROM ROLE "LIBREDB_AB_ROLE"',
  );
  await setup(["REVOKE EXECUTE ON FUNCTION APP.LIBREDB_AB_WRITE FROM ROLE LIBREDB_AB_ROLE RESTRICT"]);
  await refusedUntilLifted(
    provider,
    "EXECUTE on every function of a schema",
    ["GRANT EXECUTE ON FUNCTION APP.* TO USER AGENT_RO"],
    ["REVOKE EXECUTE ON FUNCTION APP.* FROM USER AGENT_RO RESTRICT"],
    'REVOKE EXECUTE ON FUNCTION "APP".* FROM USER "AGENT_RO" RESTRICT',
  );
  await refusedUntilLifted(
    provider,
    "EXECUTE on a module of the owner's",
    [
      "CREATE MODULE APP.LIBREDB_AB_MOD",
      "ALTER MODULE APP.LIBREDB_AB_MOD PUBLISH FUNCTION F () RETURNS INTEGER LANGUAGE SQL RETURN 1",
      "GRANT EXECUTE ON MODULE APP.LIBREDB_AB_MOD TO USER AGENT_RO",
    ],
    ["REVOKE EXECUTE ON MODULE APP.LIBREDB_AB_MOD FROM USER AGENT_RO"],
    'REVOKE EXECUTE ON MODULE "APP"."LIBREDB_AB_MOD"',
  );
  const ownPackage = String(
    (await rows("SELECT PKGNAME FROM SYSCAT.PACKAGES WHERE PKGSCHEMA = 'APP' FETCH FIRST 1 ROW ONLY"))[0].PKGNAME,
  ).trim();
  await refusedUntilLifted(
    provider,
    "EXECUTE on a package of the owner's",
    [`GRANT EXECUTE ON PACKAGE APP.${ownPackage} TO USER AGENT_RO`],
    [`REVOKE EXECUTE ON PACKAGE APP.${ownPackage} FROM USER AGENT_RO`],
    `REVOKE EXECUTE ON PACKAGE "APP"."${ownPackage}"`,
  );
  await refusedUntilLifted(
    provider,
    "READ on a variable of the owner's",
    [
      "CREATE VARIABLE APP.LIBREDB_AB_VAR INTEGER DEFAULT 1",
      "GRANT READ ON VARIABLE APP.LIBREDB_AB_VAR TO USER AGENT_RO",
    ],
    ["REVOKE READ ON VARIABLE APP.LIBREDB_AB_VAR FROM USER AGENT_RO"],
    'REVOKE READ ON VARIABLE "APP"."LIBREDB_AB_VAR"',
  );
  await refusedUntilLifted(
    provider,
    "USAGE on a sequence",
    ["GRANT USAGE ON SEQUENCE APP.LIBREDB_AB_SEQ TO USER AGENT_RO"],
    ["REVOKE USAGE ON SEQUENCE APP.LIBREDB_AB_SEQ FROM USER AGENT_RO RESTRICT"],
    'REVOKE USAGE ON SEQUENCE "APP"."LIBREDB_AB_SEQ"',
  );
  await refusedUntilLifted(
    provider,
    "INSERT on a table",
    ["GRANT INSERT ON APP.LIBREDB_AB_LEDGER TO USER AGENT_RO"],
    ["REVOKE INSERT ON APP.LIBREDB_AB_LEDGER FROM USER AGENT_RO"],
    'REVOKE INSERT ON TABLE "APP"."LIBREDB_AB_LEDGER"',
  );
  await refusedUntilLifted(
    provider,
    "CREATEIN on a schema",
    ["GRANT CREATEIN ON SCHEMA APP TO USER AGENT_RO"],
    ["REVOKE CREATEIN ON SCHEMA APP FROM USER AGENT_RO"],
    'REVOKE CREATEIN ON SCHEMA "APP"',
  );
  await refusedUntilLifted(
    provider,
    "CREATETAB and IMPLICIT_SCHEMA to PUBLIC",
    ["GRANT CREATETAB, IMPLICIT_SCHEMA ON DATABASE TO PUBLIC"],
    ["REVOKE CREATETAB, IMPLICIT_SCHEMA ON DATABASE FROM PUBLIC"],
    "REVOKE CREATETAB ON DATABASE FROM PUBLIC",
  );
  await refusedUntilLifted(
    provider,
    "DBADM",
    ["GRANT DBADM ON DATABASE TO USER AGENT_RO"],
    ["REVOKE DBADM ON DATABASE FROM USER AGENT_RO"],
    'REVOKE DBADM ON DATABASE FROM USER "AGENT_RO"',
  );
  await refusedUntilLifted(
    provider,
    "SETSESSIONUSER",
    ["GRANT SETSESSIONUSER ON PUBLIC TO USER AGENT_RO"],
    ["REVOKE SETSESSIONUSER ON PUBLIC FROM USER AGENT_RO"],
    'REVOKE SETSESSIONUSER ON PUBLIC FROM USER "AGENT_RO"',
  );
  await refusedUntilLifted(
    provider,
    "a role with its ADMIN OPTION",
    ["GRANT ROLE LIBREDB_AB_ROLE TO USER AGENT_RO WITH ADMIN OPTION"],
    ["REVOKE ROLE LIBREDB_AB_ROLE FROM USER AGENT_RO"],
    'REVOKE ADMIN OPTION FOR ROLE "LIBREDB_AB_ROLE"',
  );
  await refusedUntilLifted(
    provider,
    "a view that calls a function of the owner's",
    [
      "CREATE VIEW APP.LIBREDB_AB_CALLS AS SELECT APP.LIBREDB_AB_READ() AS V FROM SYSIBM.SYSDUMMY1",
      "GRANT SELECT ON APP.LIBREDB_AB_CALLS TO USER AGENT_RO",
    ],
    ["REVOKE SELECT ON APP.LIBREDB_AB_CALLS FROM USER AGENT_RO"],
    'REVOKE SELECT ON TABLE "APP"."LIBREDB_AB_CALLS"',
  );
  await refusedUntilLifted(
    provider,
    "a view over a view the user may not read",
    [
      "CREATE VIEW APP.LIBREDB_AB_INNER AS SELECT V FROM APP.LIBREDB_AB_SECRET",
      "CREATE VIEW APP.LIBREDB_AB_OUTER AS SELECT V FROM APP.LIBREDB_AB_INNER",
      "GRANT SELECT ON APP.LIBREDB_AB_OUTER TO USER AGENT_RO",
    ],
    ["GRANT SELECT ON APP.LIBREDB_AB_INNER TO USER AGENT_RO"],
    'REVOKE SELECT ON TABLE "APP"."LIBREDB_AB_OUTER"',
  );
  await setup([
    "REVOKE SELECT ON APP.LIBREDB_AB_OUTER FROM USER AGENT_RO",
    "REVOKE SELECT ON APP.LIBREDB_AB_INNER FROM USER AGENT_RO",
  ]);
  await refusedUntilLifted(
    provider,
    "a view over an alias of a table the user may not read",
    [
      "CREATE ALIAS APP.LIBREDB_AB_ALIAS FOR APP.LIBREDB_AB_SECRET",
      "CREATE VIEW APP.LIBREDB_AB_OVER_ALIAS AS SELECT V FROM APP.LIBREDB_AB_ALIAS",
      "GRANT SELECT ON APP.LIBREDB_AB_OVER_ALIAS TO USER AGENT_RO",
    ],
    ["REVOKE SELECT ON APP.LIBREDB_AB_OVER_ALIAS FROM USER AGENT_RO"],
    'REVOKE SELECT ON TABLE "APP"."LIBREDB_AB_OVER_ALIAS"',
  );
  await refusedUntilLifted(
    provider,
    "a view left inoperative",
    [
      "CREATE TABLE APP.LIBREDB_AB_GONE (ID INTEGER)",
      "CREATE VIEW APP.LIBREDB_AB_BROKEN AS SELECT ID FROM APP.LIBREDB_AB_GONE",
      "GRANT SELECT ON APP.LIBREDB_AB_BROKEN TO USER AGENT_RO",
      "DROP TABLE APP.LIBREDB_AB_GONE",
    ],
    ["DROP VIEW APP.LIBREDB_AB_BROKEN"],
    'REVOKE SELECT ON TABLE "APP"."LIBREDB_AB_BROKEN"',
  );
  await refusedUntilLifted(
    provider,
    "a column mask on a table the user cannot read, database wide",
    [
      "CREATE MASK APP.LIBREDB_AB_MASK ON APP.LIBREDB_AB_SECRET FOR COLUMN V RETURN CASE WHEN 1 = 1 THEN V ELSE V END ENABLE",
    ],
    ["DROP MASK APP.LIBREDB_AB_MASK"],
    '"APP"."LIBREDB_AB_MASK" on "APP"."LIBREDB_AB_SECRET"',
  );
  // IBM's code by its own catalog row: a module holding a function that acts outside the call, and a function of
  // IBM's that does and is not on the measured list, are refused; a function on that list is admitted, called raw.
  for (const ibmModule of ["UTL_FILE", "DBMS_PIPE"]) {
    await refusedUntilLifted(
      provider,
      `EXECUTE on IBM's ${ibmModule} module, which holds a function with an external action`,
      [`GRANT EXECUTE ON MODULE SYSIBMADM.${ibmModule} TO USER AGENT_RO`],
      [`REVOKE EXECUTE ON MODULE SYSIBMADM.${ibmModule} FROM USER AGENT_RO`],
      `REVOKE EXECUTE ON MODULE "SYSIBMADM"."${ibmModule}" FROM USER "AGENT_RO"`,
    );
  }
  await refusedUntilLifted(
    provider,
    "EXECUTE on IBM's AUDIT_ARCHIVE table function, an external action not on the measured list",
    ["GRANT EXECUTE ON SPECIFIC FUNCTION SYSPROC.AUDIT_ARCHIVE_TF TO USER AGENT_RO"],
    ["REVOKE EXECUTE ON SPECIFIC FUNCTION SYSPROC.AUDIT_ARCHIVE_TF FROM USER AGENT_RO RESTRICT"],
    'REVOKE EXECUTE ON SPECIFIC FUNCTION "SYSPROC"."AUDIT_ARCHIVE_TF" FROM USER "AGENT_RO" RESTRICT',
  );
  {
    let members: unknown;
    try {
      members = (await provider.queryReadOnly?.("SELECT COUNT(*) AS N FROM TABLE (SYSPROC.DB_MEMBERS()) AS T", BUDGET))
        ?.rows[0]?.N;
    } catch (error) {
      members = error;
    }
    check(
      Number(members) === 1,
      `admitted: IBM's DB_MEMBERS, an external action on the measured list, answers through queryReadOnly${members instanceof Error ? ` (got: ${members.message.slice(0, 300)})` : ""}`,
    );
  }
  await refusedUntilLifted(
    provider,
    "a view that calls IBM's DBMS_RANDOM.VALUE, an external action",
    [
      "CREATE VIEW APP.LIBREDB_AB_RANDOM AS SELECT SYSIBMADM.DBMS_RANDOM.VALUE() AS V FROM SYSIBM.SYSDUMMY1",
      "GRANT SELECT ON APP.LIBREDB_AB_RANDOM TO USER AGENT_RO",
    ],
    ["REVOKE SELECT ON APP.LIBREDB_AB_RANDOM FROM USER AGENT_RO"],
    'REVOKE SELECT ON TABLE "APP"."LIBREDB_AB_RANDOM"',
  );
  await setup([
    "CREATE VIEW APP.LIBREDB_AB_LISTED AS SELECT VARCHAR(SYSPROC.GET_INDEX_COLNAMES('APP', 'ORDERS'), 40) AS C " +
      "FROM SYSIBM.SYSDUMMY1",
    "GRANT SELECT ON APP.LIBREDB_AB_LISTED TO USER AGENT_RO",
  ]);
  const listedView = await refusalOf(provider, "SELECT C FROM APP.LIBREDB_AB_LISTED");
  check(
    listedView === undefined,
    `admitted: a view that calls IBM's GET_INDEX_COLNAMES, on the measured list${listedView instanceof Error ? ` (got: ${listedView.message.slice(0, 300)})` : ""}`,
  );
  await setup(["REVOKE SELECT ON APP.LIBREDB_AB_LISTED FROM USER AGENT_RO"]);

  // Measured first: a connection from the address a trusted context names becomes trusted without asking, and holds
  // the context's default role, which AUTH_LIST_ROLES_FOR_AUTHID does not list.
  const address = String(
    (
      await rows(
        "SELECT CLIENT_IPADDR FROM TABLE (MON_GET_CONNECTION(MON_GET_APPLICATION_HANDLE(), -1)) AS M FETCH FIRST 1 ROW ONLY",
      )
    )[0].CLIENT_IPADDR,
  ).trim();
  const context =
    "CREATE TRUSTED CONTEXT LIBREDB_AB_CTX BASED UPON CONNECTION USING SYSTEM AUTHID AGENT_RO " +
    `ATTRIBUTES (ADDRESS '${address}') DEFAULT ROLE LIBREDB_AB_ROLE ENABLE`;
  await setup(["GRANT INSERT ON APP.LIBREDB_AB_LEDGER TO ROLE LIBREDB_AB_ROLE", context]);
  {
    const agentRaw = await raw("agent_ro", AGENT_PASSWORD);
    const listed = (
      await agentRaw.query(
        "SELECT ROLENAME FROM TABLE (SYSPROC.AUTH_LIST_ROLES_FOR_AUTHID(SESSION_USER, 'U')) AS R " +
          "WHERE ROLENAME = 'LIBREDB_AB_ROLE'",
      )
    ).rows.length;
    let inserted = true;
    try {
      await agentRaw.query("INSERT INTO APP.LIBREDB_AB_LEDGER VALUES (2)");
    } catch {
      inserted = false;
    }
    await agentRaw.close();
    await setup(["DELETE FROM APP.LIBREDB_AB_LEDGER WHERE N = 2"]);
    check(
      inserted && listed === 0,
      `a trusted context on ${address} gave the agent user's raw connection its default role's INSERT, unlisted (${inserted}, ${listed})`,
    );
  }
  await setup(["DROP TRUSTED CONTEXT LIBREDB_AB_CTX"]);
  await refusedUntilLifted(
    provider,
    "a trusted context naming the user as its system authorization ID",
    [context],
    ["DROP TRUSTED CONTEXT LIBREDB_AB_CTX"],
    '"LIBREDB_AB_CTX" (default role "LIBREDB_AB_ROLE")',
  );
  await refusedUntilLifted(
    provider,
    "the same trusted context, disabled",
    [context, "ALTER TRUSTED CONTEXT LIBREDB_AB_CTX ALTER DISABLE"],
    ["DROP TRUSTED CONTEXT LIBREDB_AB_CTX"],
    '"LIBREDB_AB_CTX" (default role "LIBREDB_AB_ROLE")',
  );
  await setup(["REVOKE INSERT ON APP.LIBREDB_AB_LEDGER FROM ROLE LIBREDB_AB_ROLE"]);

  // Admitted: a view over a table, a view over a view the user may read, and a view calling IBM's own function.
  await setup([
    "CREATE VIEW APP.LIBREDB_AB_PLAIN AS SELECT ID FROM APP.ORDERS",
    "CREATE VIEW APP.LIBREDB_AB_IBM AS SELECT UPPER(NAME) AS N, LENGTH(NAME) AS L FROM APP.CUSTOMERS",
    "CREATE VIEW APP.LIBREDB_AB_OUTER2 AS SELECT ID FROM APP.LIBREDB_AB_PLAIN",
    "GRANT SELECT ON APP.LIBREDB_AB_PLAIN TO USER AGENT_RO",
    "GRANT SELECT ON APP.LIBREDB_AB_IBM TO USER AGENT_RO",
    "GRANT SELECT ON APP.LIBREDB_AB_OUTER2 TO USER AGENT_RO",
  ]);
  const plain = await refusalOf(provider, "SELECT N, L FROM APP.LIBREDB_AB_IBM");
  check(
    plain === undefined,
    `admitted: a view over a table, one over a view it may read, and one calling IBM's UPPER${plain instanceof Error ? ` (got: ${plain.message.slice(0, 300)})` : ""}`,
  );
  await setup(["DROP VIEW APP.LIBREDB_AB_OUTER2"]);

  // On one handle: a grant added after a call refuses the next call, and its revoke admits the one after.
  const handleOk = await refusalOf(provider, "SELECT ID FROM APP.ORDERS");
  await setup(["GRANT INSERT ON APP.ORDERS TO USER AGENT_RO"]);
  const handleRefused = await refusalOf(provider, "SELECT ID FROM APP.ORDERS");
  await setup(["REVOKE INSERT ON APP.ORDERS FROM USER AGENT_RO"]);
  const handleAgain = await refusalOf(provider, "SELECT ID FROM APP.ORDERS");
  check(
    handleOk === undefined && handleRefused instanceof ExecutionProfileError && handleAgain === undefined,
    "on one handle: a grant after a call refuses the next call, and its revoke admits the one after",
  );

  // ---- Each call's own connection ----------------------------------------------------------------------------------
  const schemas = await provider.queryReadOnly?.("VALUES CURRENT SCHEMA", BUDGET);
  check(
    schemas?.rows[0] !== undefined && Object.values(schemas.rows[0])[0] === "AGENT_RO",
    "a call reads the agent user's own CURRENT SCHEMA",
  );

  // ---- The operations profile and an editor handle ------------------------------------------------------------------
  const operations = await createDatabaseProvider(
    connection("live-db2-ops", "db2inst1", ADMIN_PASSWORD),
    {},
    executionContextFor("agent-operations"),
  );
  await operations.connect();
  const listed = await operations.listObjects(["APP"], "table");
  check(
    listed.some((object) => object.name === "ORDERS"),
    "the operations profile opens the instance owner unproven and lists its tables",
  );
  const opsRefused = await refusalOf(operations, "SELECT 1 FROM SYSIBM.SYSDUMMY1");
  check(
    opsRefused instanceof Error && opsRefused.message.includes("agent read-only profile"),
    "the operations profile refuses queryReadOnly",
  );
  await operations.disconnect();
  const editor = await createDatabaseProvider(connection("live-db2-editor", "agent_ro", AGENT_PASSWORD));
  await editor.connect();
  const editorRefused = await refusalOf(editor, "SELECT 1 FROM SYSIBM.SYSDUMMY1");
  check(
    editorRefused instanceof Error && editorRefused.message.includes("agent read-only profile"),
    "an editor handle refuses queryReadOnly",
  );
  await editor.disconnect();

  // ---- The catalog reads ---------------------------------------------------------------------------------------------
  const kindColumn = {
    columns: "column_name",
    relations: "referenced_table",
    indexes: "index_name",
    statistics: "estimated_rows",
  } as const;
  for (const kind of ["columns", "relations", "indexes", "statistics"] as const) {
    const sql = composeCatalogRead("db2", {
      kind,
      schema: "APP",
      table: kind === "relations" || kind === "statistics" ? undefined : "ORDERS",
    });
    let answered: Record<string, unknown>[] | Error;
    try {
      answered = (await provider.queryReadOnly?.(sql, { ...BUDGET, maxResultRows: 500 }))?.rows ?? [];
    } catch (error) {
      answered = error instanceof Error ? error : new Error(String(error));
    }
    check(
      !(answered instanceof Error) && answered.length > 0 && Object.keys(answered[0]).includes(kindColumn[kind]),
      `catalog ${kind}: answered as the agent user${answered instanceof Error ? ` (got: ${answered.message.slice(0, 200)})` : ""}`,
    );
  }

  // A schema made implicitly, by a CREATE in a schema that does not exist, is owned by SYSIBM; its table is still read.
  await setup([
    "CREATE TABLE LIBREDB_AB_IMPLICIT.T (ID INTEGER)",
    "GRANT SELECT ON LIBREDB_AB_IMPLICIT.T TO USER AGENT_RO",
  ]);
  const implicitOwner = String(
    (await rows("SELECT OWNERTYPE FROM SYSCAT.SCHEMATA WHERE SCHEMANAME = 'LIBREDB_AB_IMPLICIT'"))[0]?.OWNERTYPE,
  );
  // An implicit schema grants PUBLIC CREATEIN, which the check refuses until it is revoked.
  const implicitRefused = await refusalOf(provider, "SELECT ID FROM APP.ORDERS");
  check(
    implicitRefused instanceof ExecutionProfileError &&
      implicitRefused.message.includes('REVOKE CREATEIN ON SCHEMA "LIBREDB_AB_IMPLICIT" FROM PUBLIC'),
    "a schema made implicitly gives PUBLIC CREATEIN, and the check refuses it",
  );
  await setup(["REVOKE CREATEIN ON SCHEMA LIBREDB_AB_IMPLICIT FROM PUBLIC"]);
  const implicitColumns = await provider.queryReadOnly?.(
    composeCatalogRead("db2", { kind: "columns", schema: "LIBREDB_AB_IMPLICIT" }),
    BUDGET,
  );
  check(
    implicitOwner === "S" && implicitColumns?.rows.length === 1,
    `a table in a schema made implicitly, owned by the system (${implicitOwner}), is in the catalog read`,
  );
  await setup(["DROP TABLE LIBREDB_AB_IMPLICIT.T", "DROP SCHEMA LIBREDB_AB_IMPLICIT RESTRICT"]);

  // ---- The budgets -----------------------------------------------------------------------------------------------------
  const rowsOver = await refusalOf(provider, "SELECT COLNAME FROM SYSCAT.COLUMNS", { ...BUDGET, maxResultRows: 3 });
  check(
    rowsOver instanceof Error &&
      rowsOver.message.startsWith("Read-only execution exceeded the row budget: 4 rows > 3 allowed"),
    "a result past the row budget is refused at one row past it",
  );
  const bytesOver = await refusalOf(provider, "SELECT * FROM APP.ORDERS", { ...BUDGET, maxResultBytes: 20 });
  check(
    bytesOver instanceof Error && bytesOver.message.startsWith("Read-only execution exceeded the byte budget"),
    "a result past the byte budget is refused",
  );
  for (const column of ["C_CLOB", "C_BLOB", "C_XML"]) {
    await setup([`GRANT SELECT ON APP.ALLTYPES TO USER AGENT_RO`]);
    const lob = await refusalOf(provider, `SELECT ID, ${column} FROM APP.ALLTYPES`);
    check(
      lob instanceof Error && lob.message.includes(`refused column ${column}`),
      `a ${column} column is refused before any row is read`,
    );
  }
  await setup(["REVOKE SELECT ON APP.ALLTYPES FROM USER AGENT_RO"]);
  const started = Date.now();
  const slow = await refusalOf(provider, "SELECT COUNT(*) FROM SYSCAT.COLUMNS A, SYSCAT.COLUMNS B, SYSCAT.COLUMNS C", {
    ...BUDGET,
    statementTimeoutMs: 1_500,
  });
  const waited = Date.now() - started;
  check(
    slow instanceof Error &&
      slow.message === "Read-only execution exceeded the time budget: no answer within 1500ms" &&
      waited < 4_000,
    `a statement past its deadline is refused (${waited} ms)`,
  );
  const next = await refusalOf(provider, "VALUES 1");
  check(next === undefined, "the call after it answers");

  await provider.disconnect();
} finally {
  await setup(["REVOKE SELECT ON APP.ALLTYPES FROM USER AGENT_RO", "DROP VIEW APP.LIBREDB_AB_OUTER2", ...CLEANUP]);
  await admin.close();
}

console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
