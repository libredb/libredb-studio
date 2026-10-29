/**
 * The Db2 agent read path's pure parts: the check of the agent user run before every statement, the derived table the
 * statement is sent in, the column refusal and the reading of an answer against the budget. The provider wiring is in
 * tests/integration/db/db2-provider.test.ts, the live boundary in tests/live/db2-agent-boundary.ts.
 *
 * The check refuses the profile, fail closed, while a trusted context names the user as its system authorization ID,
 * whose default role a matching connection takes without asking, and unless the user, its groups, its roles and PUBLIC
 * hold nothing but CONNECT and SELECT that reaches past the read: no other authority; no write, DDL, schema, tablespace, sequence, role-admin,
 * pass-through or session-user privilege; no EXECUTE on code that is not IBM's, which runs with its owner's authority,
 * nor on an IBM function, or a module holding one, whose own catalog row reads EXTERNAL_ACTION E or SQL_DATA_ACCESS M,
 * unless capture 10 lists it as measured reading only (procedures are admitted: no agent statement can call one); no
 * view that calls such code, reads a view or alias the check cannot follow or a nickname, or is not valid; and no row
 * permission or column mask anywhere in the database that is not IBM's. IBM's is the object's own OWNERTYPE, never its
 * schema. Every catalog view is named SYSCAT.<view>. Each refusal names the statements that would lift it, or the
 * controls it found.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ExecutionProfileError, QueryError } from "@/lib/db/errors";
import {
  AGENT_PRINCIPAL_STATEMENTS,
  assertAgentColumnTypes,
  boundAgentStatement,
  describeAgentStatement,
  readAgentAnswer,
  verifyAgentPrincipal,
} from "@/lib/db/providers/sql/db2/agent-read";
import { DB2_READING_FUNCTIONS } from "@/lib/db/providers/sql/db2/reading-functions";
import type { Db2ColumnMeta } from "@/lib/db/providers/sql/db2/driver";
import type { QueryResult } from "@/lib/db/types";

type Rows = readonly Record<string, unknown>[];
type Statement = keyof typeof AGENT_PRINCIPAL_STATEMENTS;

/** The session's grantees: the user, PUBLIC, the user's groups and every role it holds, each with its catalog type. */
const GRANTEES =
  "G (GRANTEE, GRANTEETYPE) AS (VALUES (CAST(SESSION_USER AS VARCHAR(128)), CAST('U' AS CHAR(1))), " +
  "(CAST('PUBLIC' AS VARCHAR(128)), CAST('G' AS CHAR(1))) " +
  "UNION SELECT CAST(a.\"GROUP\" AS VARCHAR(128)), CAST('G' AS CHAR(1)) " +
  "FROM TABLE (SYSPROC.AUTH_LIST_GROUPS_FOR_AUTHID(SESSION_USER)) AS a " +
  "UNION SELECT CAST(r.ROLENAME AS VARCHAR(128)), CAST('R' AS CHAR(1)) " +
  "FROM TABLE (SYSPROC.AUTH_LIST_ROLES_FOR_AUTHID(SESSION_USER, 'U')) AS r)";

const held = (alias: string) => `JOIN G ON G.GRANTEE = ${alias}.GRANTEE AND G.GRANTEETYPE = ${alias}.GRANTEETYPE`;

/**
 * Capture 10: the IBM functions a fresh 12.1.0.0 database, after the seed's revokes, lets the agent user's grantees
 * execute although their own catalog row reads EXTERNAL_ACTION E or SQL_DATA_ACCESS M. The check's allowlist is held
 * equal to it, so a release that adds or drops one is re-measured rather than admitted.
 */
const CAPTURE_10 = readFileSync(
  join(import.meta.dir, "../../../fixtures/db2/12.1.0.0/agent-boundary/10-external-action-functions-as-agent-ro.txt"),
  "utf8",
);
const MEASURED_READERS = CAPTURE_10.split("\n")
  .filter((line) => line.startsWith("SYSPROC "))
  .map((line) => line.split(/\s+/)[1]);

const facts = (row: string) =>
  `COALESCE(${row}.EXTERNAL_ACTION, 'E') <> 'E' AND COALESCE(${row}.SQL_DATA_ACCESS, 'M') <> 'M'`;

/**
 * The routine keeps to the call: no external action and no data change by its own row, a sourced one on a built-in or
 * on an IBM routine that keeps to the call, or one of the functions capture 10 lists, by specific name.
 */
const keepsToTheCall = (alias: string) =>
  `(${facts(alias)} AND (COALESCE(${alias}.ORIGIN, 'U') <> 'U' OR COALESCE(${alias}.SOURCESCHEMA, '') = 'SYSIBM' ` +
  `OR EXISTS (SELECT 1 FROM SYSCAT.ROUTINES s WHERE s.ROUTINESCHEMA = ${alias}.SOURCESCHEMA ` +
  `AND s.SPECIFICNAME = ${alias}.SOURCESPECIFIC AND COALESCE(s.OWNERTYPE, '') = 'S' ` +
  `AND COALESCE(s.ORIGIN, 'U') <> 'U' AND ${facts("s")})) ` +
  `OR ${alias}.ROUTINESCHEMA = 'SYSPROC' AND COALESCE(${alias}.ROUTINETYPE, '') = 'F' ` +
  `AND ${alias}.SPECIFICNAME IN (${MEASURED_READERS.map((name) => `'${name}'`).join(", ")}))`;

/** IBM's routine, and a procedure, which no agent statement can call, or a routine that keeps to the call. */
const admittedRoutine = (alias: string) =>
  `COALESCE(${alias}.OWNERTYPE, '') = 'S' AND (COALESCE(${alias}.ROUTINETYPE, '') = 'P' OR ${keepsToTheCall(alias)})`;

const PINNED: Record<Statement, string> = {
  user: "SELECT CAST(SESSION_USER AS VARCHAR(128)) AS USERNAME FROM SYSIBM.SYSDUMMY1",
  contexts:
    "SELECT CONTEXTNAME AS NAME, COALESCE(DEFAULTCONTEXTROLE, '') AS ROLE FROM SYSCAT.CONTEXTS " +
    "WHERE SYSTEMAUTHID = SESSION_USER ORDER BY 1",
  authorities:
    "SELECT a.AUTHORITY, a.D_USER, a.D_GROUP, a.D_PUBLIC, a.ROLE_USER, a.ROLE_GROUP, a.ROLE_PUBLIC " +
    "FROM TABLE (SYSPROC.AUTH_LIST_AUTHORITIES_FOR_AUTHID(SESSION_USER, 'U')) AS a " +
    "WHERE a.AUTHORITY <> 'CONNECT' " +
    "AND 'Y' IN (a.D_USER, a.D_GROUP, a.D_PUBLIC, a.ROLE_USER, a.ROLE_GROUP, a.ROLE_PUBLIC) ORDER BY 1",
  privileges:
    `WITH ${GRANTEES} ` +
    "SELECT t.GRANTEE, t.GRANTEETYPE, p.PRIVILEGE, 'TABLE' AS KIND, t.TABSCHEMA AS SCHEMA, t.TABNAME AS NAME " +
    `FROM SYSCAT.TABAUTH t ${held("t")}, ` +
    "TABLE (VALUES ('CONTROL', t.CONTROLAUTH), ('ALTER', t.ALTERAUTH), ('DELETE', t.DELETEAUTH), " +
    "('INDEX', t.INDEXAUTH), ('INSERT', t.INSERTAUTH), ('REFERENCES', t.REFAUTH), ('UPDATE', t.UPDATEAUTH)) " +
    "AS p (PRIVILEGE, HELD) WHERE p.HELD <> 'N' " +
    "UNION ALL SELECT c.GRANTEE, c.GRANTEETYPE, CASE c.PRIVTYPE WHEN 'U' THEN 'UPDATE' ELSE 'REFERENCES' END, " +
    `'TABLE', c.TABSCHEMA, c.TABNAME FROM SYSCAT.COLAUTH c ${held("c")} ` +
    "UNION ALL SELECT i.GRANTEE, i.GRANTEETYPE, 'CONTROL', 'INDEX', i.INDSCHEMA, i.INDNAME " +
    `FROM SYSCAT.INDEXAUTH i ${held("i")} WHERE i.CONTROLAUTH <> 'N' ` +
    "UNION ALL SELECT s.GRANTEE, s.GRANTEETYPE, p.PRIVILEGE, 'SCHEMA', s.SCHEMANAME, s.SCHEMANAME " +
    `FROM SYSCAT.SCHEMAAUTH s ${held("s")}, ` +
    "TABLE (VALUES ('ALTERIN', s.ALTERINAUTH), ('CREATEIN', s.CREATEINAUTH), ('DROPIN', s.DROPINAUTH), " +
    "('SELECTIN', s.SELECTINAUTH), ('INSERTIN', s.INSERTINAUTH), ('UPDATEIN', s.UPDATEINAUTH), " +
    "('DELETEIN', s.DELETEINAUTH), ('EXECUTEIN', s.EXECUTEINAUTH), ('SCHEMAADM', s.SCHEMAADMAUTH), " +
    "('ACCESSCTRL', s.ACCESSCTRLAUTH), ('DATAACCESS', s.DATAACCESSAUTH), ('LOAD', s.LOADAUTH), " +
    "('SCHEMARCAC', s.SCHEMARCACAUTH)) AS p (PRIVILEGE, HELD) WHERE p.HELD <> 'N' " +
    "UNION ALL SELECT b.GRANTEE, b.GRANTEETYPE, 'USE', 'TABLESPACE', '', b.TBSPACE " +
    `FROM SYSCAT.TBSPACEAUTH b ${held("b")} WHERE b.USEAUTH <> 'N' ` +
    "UNION ALL SELECT q.GRANTEE, q.GRANTEETYPE, p.PRIVILEGE, 'SEQUENCE', q.SEQSCHEMA, q.SEQNAME " +
    `FROM SYSCAT.SEQUENCEAUTH q ${held("q")}, ` +
    "TABLE (VALUES ('USAGE', q.USAGEAUTH), ('ALTER', q.ALTERAUTH)) AS p (PRIVILEGE, HELD) WHERE p.HELD <> 'N' " +
    "UNION ALL SELECT o.GRANTEE, o.GRANTEETYPE, 'ADMIN OPTION', 'ROLE', '', o.ROLENAME " +
    `FROM SYSCAT.ROLEAUTH o ${held("o")} WHERE o.ADMIN <> 'N' ` +
    "UNION ALL SELECT h.GRANTEE, h.GRANTEETYPE, 'PASSTHRU', 'SERVER', '', h.SERVERNAME " +
    `FROM SYSCAT.PASSTHRUAUTH h ${held("h")} ` +
    "UNION ALL SELECT u.TRUSTEDID, u.TRUSTEDIDTYPE, 'SETSESSIONUSER', 'SESSION USER', '', u.SURROGATEAUTHID " +
    "FROM SYSCAT.SURROGATEAUTHIDS u JOIN G ON G.GRANTEE = u.TRUSTEDID AND G.GRANTEETYPE = u.TRUSTEDIDTYPE " +
    "ORDER BY 4, 5, 6, 3, 1",
  code:
    `WITH ${GRANTEES} ` +
    "SELECT a.GRANTEE, a.GRANTEETYPE, 'EXECUTE' AS PRIVILEGE, " +
    "CASE a.ROUTINETYPE WHEN 'P' THEN 'PROCEDURE' WHEN 'M' THEN 'METHOD' ELSE 'FUNCTION' END AS KIND, " +
    `a.SCHEMA, COALESCE(a.SPECIFICNAME, '*') AS NAME FROM SYSCAT.ROUTINEAUTH a ${held("a")} ` +
    "WHERE a.EXECUTEAUTH <> 'N' AND EXISTS (SELECT 1 FROM SYSCAT.ROUTINES r WHERE r.ROUTINESCHEMA = a.SCHEMA " +
    "AND (r.SPECIFICNAME = a.SPECIFICNAME OR a.SPECIFICNAME IS NULL AND r.ROUTINETYPE = a.ROUTINETYPE) " +
    `AND NOT (${admittedRoutine("r")})) ` +
    "UNION ALL SELECT m.GRANTEE, m.GRANTEETYPE, 'EXECUTE', 'MODULE', m.MODULESCHEMA, m.MODULENAME " +
    `FROM SYSCAT.MODULEAUTH m ${held("m")} WHERE m.EXECUTEAUTH <> 'N' ` +
    "AND NOT EXISTS (SELECT 1 FROM SYSCAT.MODULES d WHERE d.MODULEID = m.MODULEID AND d.OWNERTYPE = 'S' " +
    "AND NOT EXISTS (SELECT 1 FROM SYSCAT.ROUTINES r WHERE r.ROUTINEMODULEID = d.MODULEID AND NOT (" +
    "(COALESCE(r.OWNERTYPE, '') = 'S' OR COALESCE(r.ORIGIN, '') = 'S') " +
    `AND (COALESCE(r.ROUTINETYPE, '') = 'P' OR ${keepsToTheCall("r")})))) ` +
    "UNION ALL SELECT k.GRANTEE, k.GRANTEETYPE, p.PRIVILEGE, 'PACKAGE', k.PKGSCHEMA, k.PKGNAME " +
    `FROM SYSCAT.PACKAGEAUTH k ${held("k")}, ` +
    "TABLE (VALUES ('CONTROL', k.CONTROLAUTH), ('BIND', k.BINDAUTH), ('EXECUTE', k.EXECUTEAUTH)) " +
    "AS p (PRIVILEGE, HELD) WHERE p.HELD <> 'N' AND (p.PRIVILEGE = 'CONTROL' " +
    "OR NOT EXISTS (SELECT 1 FROM SYSCAT.PACKAGES d WHERE d.PKGSCHEMA = k.PKGSCHEMA AND d.PKGNAME = k.PKGNAME) " +
    "OR EXISTS (SELECT 1 FROM SYSCAT.PACKAGES d WHERE d.PKGSCHEMA = k.PKGSCHEMA AND d.PKGNAME = k.PKGNAME " +
    "AND NOT (d.OWNERTYPE = 'S' AND d.BOUNDBYTYPE = 'S'))) " +
    "UNION ALL SELECT v.GRANTEE, v.GRANTEETYPE, p.PRIVILEGE, 'VARIABLE', v.VARSCHEMA, v.VARNAME " +
    `FROM SYSCAT.VARIABLEAUTH v ${held("v")}, ` +
    "TABLE (VALUES ('READ', v.READAUTH), ('WRITE', v.WRITEAUTH)) AS p (PRIVILEGE, HELD) WHERE p.HELD <> 'N' " +
    "AND NOT EXISTS (SELECT 1 FROM SYSCAT.VARIABLES d WHERE d.VARID = v.VARID AND d.OWNERTYPE = 'S') " +
    "ORDER BY 4, 5, 6, 3, 1",
  reach:
    `WITH ${GRANTEES}, ROOTS (GRANTEE, GRANTEETYPE, TABSCHEMA, TABNAME, TYPE) AS (` +
    `SELECT a.GRANTEE, a.GRANTEETYPE, a.TABSCHEMA, a.TABNAME, t.TYPE FROM SYSCAT.TABAUTH a ${held("a")} ` +
    "JOIN SYSCAT.TABLES t ON t.TABSCHEMA = a.TABSCHEMA AND t.TABNAME = a.TABNAME " +
    "WHERE a.SELECTAUTH <> 'N' AND t.OWNERTYPE <> 'S') " +
    "SELECT x.GRANTEE, x.GRANTEETYPE, x.TABSCHEMA AS SCHEMA, x.TABNAME AS NAME FROM ROOTS x " +
    "WHERE x.TYPE = 'N' OR x.TYPE IN ('V', 'W') AND (NOT EXISTS (SELECT 1 FROM SYSCAT.VIEWS v " +
    "WHERE v.VIEWSCHEMA = x.TABSCHEMA AND v.VIEWNAME = x.TABNAME AND v.VALID = 'Y') " +
    "OR EXISTS (SELECT 1 FROM SYSCAT.TABDEP d WHERE d.TABSCHEMA = x.TABSCHEMA AND d.TABNAME = x.TABNAME AND NOT (" +
    "d.BTYPE IN ('T', 'S', 'U', 'H', 'L', 'O', 'R') " +
    "OR d.BTYPE IN ('V', 'W') AND (EXISTS (SELECT 1 FROM SYSCAT.TABLES b WHERE b.TABSCHEMA = d.BSCHEMA " +
    "AND b.TABNAME = d.BNAME AND b.OWNERTYPE = 'S') " +
    "OR EXISTS (SELECT 1 FROM ROOTS o WHERE o.TABSCHEMA = d.BSCHEMA AND o.TABNAME = d.BNAME)) " +
    "OR d.BTYPE = 'F' AND EXISTS (SELECT 1 FROM SYSCAT.ROUTINES f WHERE f.ROUTINESCHEMA = d.BSCHEMA " +
    `AND f.SPECIFICNAME = d.BNAME AND ${admittedRoutine("f")}) ` +
    "OR d.BTYPE = 'A' AND EXISTS (SELECT 1 FROM SYSCAT.TABLES s WHERE s.TABSCHEMA = d.BSCHEMA " +
    "AND s.TABNAME = d.BNAME AND s.TYPE = 'A' AND EXISTS (SELECT 1 FROM ROOTS o " +
    "WHERE o.TABSCHEMA = s.BASE_TABSCHEMA AND o.TABNAME = s.BASE_TABNAME)) " +
    "OR d.BTYPE = 'v' AND EXISTS (SELECT 1 FROM SYSCAT.VARIABLES g WHERE g.VARSCHEMA = d.BSCHEMA " +
    "AND g.VARNAME = d.BNAME AND g.OWNERTYPE = 'S')))) ORDER BY 3, 4, 1",
  controls:
    "SELECT CONTROLSCHEMA AS SCHEMA, CONTROLNAME AS NAME, TABSCHEMA, TABNAME FROM SYSCAT.CONTROLS " +
    "WHERE OWNERTYPE <> 'S' ORDER BY 3, 4, 1, 2",
};

const ORDER: readonly Statement[] = ["user", "contexts", "authorities", "privileges", "code", "reach", "controls"];

/** A reader answering each check from `answers`, the user AGENT_RO by default, recording what it was sent. */
function reader(answers: Partial<Record<Statement, Rows>> = {}) {
  const sent: string[] = [];
  const read = async (sql: string): Promise<Rows> => {
    sent.push(sql);
    const name = ORDER.find((candidate) => AGENT_PRINCIPAL_STATEMENTS[candidate] === sql);
    if (name === undefined) throw new Error(`unknown statement: ${sql}`);
    if (name === "user") return answers.user ?? [{ USERNAME: "AGENT_RO" }];
    return answers[name] ?? [];
  };
  return { read, sent };
}

async function refusal(answers: Partial<Record<Statement, Rows>>): Promise<ExecutionProfileError> {
  const { read } = reader(answers);
  const caught = await verifyAgentPrincipal(read).catch((error: unknown) => error);
  if (!(caught instanceof ExecutionProfileError)) throw new Error(`expected a refusal, got ${String(caught)}`);
  return caught;
}

/** A privilege row as the catalog answers it: CHAR columns padded, as db2-node hands them back. */
const privilege = (
  grantee: string,
  type: string,
  privilegeName: string,
  kind: string,
  schema: string,
  name: string,
) => ({
  GRANTEE: `${grantee}  `,
  GRANTEETYPE: type,
  PRIVILEGE: privilegeName,
  KIND: kind,
  SCHEMA: schema === "" ? "" : `${schema} `,
  NAME: name,
});

describe("the check's statements", () => {
  test.each(ORDER)("%s is pinned whole", (name) => {
    expect(AGENT_PRINCIPAL_STATEMENTS[name]).toBe(PINNED[name]);
  });

  test("they are exactly these, frozen", () => {
    expect(Object.keys(AGENT_PRINCIPAL_STATEMENTS)).toEqual([...ORDER]);
    expect(Object.isFrozen(AGENT_PRINCIPAL_STATEMENTS)).toBe(true);
  });

  test("every catalog object is named by its schema, so nothing in the user's schema or a public alias stands in", () => {
    for (const sql of Object.values(AGENT_PRINCIPAL_STATEMENTS)) {
      const named = [...sql.matchAll(/\b(?:FROM|JOIN)\s+(?!TABLE\b|G\b|ROOTS\b|\()([A-Z_."]+)/g)].map((m) => m[1]);
      for (const name of named) expect(name).toMatch(/^(SYSCAT|SYSIBM|SYSPROC)\./);
    }
  });
});

describe("IBM's functions measured as reading only", () => {
  test("are exactly capture 10's, by specific name, frozen", () => {
    expect(MEASURED_READERS).toHaveLength(81);
    expect([...DB2_READING_FUNCTIONS]).toEqual(MEASURED_READERS);
    expect(Object.isFrozen(DB2_READING_FUNCTIONS)).toBe(true);
  });
});

describe("verifyAgentPrincipal", () => {
  test("admits a user every check finds nothing for, reading each check once, in order", async () => {
    const { read, sent } = reader();
    await expect(verifyAgentPrincipal(read)).resolves.toBeUndefined();
    expect(sent).toEqual(ORDER.map((name) => AGENT_PRINCIPAL_STATEMENTS[name]));
  });

  test("an authority beyond CONNECT is refused, naming the revoke for each way it is held", async () => {
    const error = await refusal({
      authorities: [
        {
          AUTHORITY: "CREATETAB",
          D_USER: "Y",
          D_GROUP: "N",
          D_PUBLIC: "Y",
          ROLE_USER: "N",
          ROLE_GROUP: "N",
          ROLE_PUBLIC: "N",
        },
        {
          AUTHORITY: "DBADM",
          D_USER: "N",
          D_GROUP: "Y",
          D_PUBLIC: "N",
          ROLE_USER: "N",
          ROLE_GROUP: "N",
          ROLE_PUBLIC: "N",
        },
        {
          AUTHORITY: "SQLADM",
          D_USER: "N",
          D_GROUP: "N",
          D_PUBLIC: "N",
          ROLE_USER: "Y",
          ROLE_GROUP: "N",
          ROLE_PUBLIC: "N",
        },
        {
          AUTHORITY: "SYSADM",
          D_USER: "N",
          D_GROUP: "Y",
          D_PUBLIC: "N",
          ROLE_USER: "N",
          ROLE_GROUP: "N",
          ROLE_PUBLIC: "N",
        },
      ],
    });
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toBe(
      "The agent read-only execution profile refuses the Db2 user AGENT_RO: it holds a database or instance authority " +
        'beyond CONNECT. Run, as an administrator: REVOKE CREATETAB ON DATABASE FROM USER "AGENT_RO"; ' +
        "REVOKE CREATETAB ON DATABASE FROM PUBLIC; revoke DBADM from the group or role that gives it to AGENT_RO; " +
        "revoke SQLADM from the group or role that gives it to AGENT_RO; " +
        "take AGENT_RO out of the operating-system group the instance names for SYSADM.",
    );
  });

  test("a privilege beyond SELECT is refused, naming the revoke each kind takes and each kind of grantee", async () => {
    const error = await refusal({
      privileges: [
        privilege("AGENT_RO", "U", "INSERT", "TABLE", "APP", "ORDERS"),
        privilege("PUBLIC", "G", "UPDATE", "TABLE", "SYSSTAT", "TABLES"),
        privilege("OPS", "G", "CONTROL", "INDEX", "APP", "ORDERS_IX"),
        privilege("PUBLIC", "G", "CREATEIN", "SCHEMA", "SYSTOOLS", "SYSTOOLS"),
        privilege("READERS", "R", "USE", "TABLESPACE", "", "USERSPACE1"),
        privilege("AGENT_RO", "U", "USAGE", "SEQUENCE", "APP", "ORDER_SEQ"),
        privilege("AGENT_RO", "U", "ADMIN OPTION", "ROLE", "", "READERS"),
        privilege("AGENT_RO", "U", "PASSTHRU", "SERVER", "", "REMOTE1"),
        privilege("AGENT_RO", "U", "SETSESSIONUSER", "SESSION USER", "", "PUBLIC"),
        privilege("AGENT_RO", "U", "SETSESSIONUSER", "SESSION USER", "", "DB2INST1"),
      ],
    });
    expect(error.message).toBe(
      "The agent read-only execution profile refuses the Db2 user AGENT_RO: it holds a privilege that writes, " +
        "creates, administers or acts as another user, beyond SELECT. Run, as an administrator: " +
        'REVOKE INSERT ON TABLE "APP"."ORDERS" FROM USER "AGENT_RO"; ' +
        'REVOKE UPDATE ON TABLE "SYSSTAT"."TABLES" FROM PUBLIC; ' +
        'REVOKE CONTROL ON INDEX "APP"."ORDERS_IX" FROM GROUP "OPS"; ' +
        'REVOKE CREATEIN ON SCHEMA "SYSTOOLS" FROM PUBLIC; ' +
        'REVOKE USE OF TABLESPACE "USERSPACE1" FROM ROLE "READERS"; ' +
        'REVOKE USAGE ON SEQUENCE "APP"."ORDER_SEQ" FROM USER "AGENT_RO" RESTRICT; ' +
        'REVOKE ADMIN OPTION FOR ROLE "READERS" FROM USER "AGENT_RO"; ' +
        'REVOKE PASSTHRU ON SERVER "REMOTE1" FROM USER "AGENT_RO"; ' +
        'REVOKE SETSESSIONUSER ON PUBLIC FROM USER "AGENT_RO"; ' +
        'REVOKE SETSESSIONUSER ON USER "DB2INST1" FROM USER "AGENT_RO".',
    );
  });

  test("EXECUTE on code is refused, a schema-wide grant by its wildcard, a package and a variable by their privilege", async () => {
    const error = await refusal({
      code: [
        privilege("AGENT_RO", "U", "EXECUTE", "FUNCTION", "APP", "WRITE_LEDGER"),
        privilege("PUBLIC", "G", "EXECUTE", "PROCEDURE", "SYSPROC", "ADMIN_CMD"),
        privilege("PUBLIC", "G", "EXECUTE", "FUNCTION", "SYSTOOLS", "*"),
        privilege("AGENT_RO", "U", "EXECUTE", "METHOD", "APP", "POINT_X"),
        privilege("PUBLIC", "G", "EXECUTE", "MODULE", "SYSIBMADM", "DBMS_JOB"),
        privilege("PUBLIC", "G", "EXECUTE", "PACKAGE", "NULLID", "SYSSH200"),
        privilege("AGENT_RO", "U", "WRITE", "VARIABLE", "APP", "MODE"),
      ],
    });
    expect(error.message).toBe(
      "The agent read-only execution profile refuses the Db2 user AGENT_RO: it may execute code that is not IBM's, " +
        "which runs with its owner's authority, or an IBM function, or a module holding one, whose own catalog row " +
        "says it acts outside the call or modifies data. Run, as an administrator: " +
        'REVOKE EXECUTE ON SPECIFIC FUNCTION "APP"."WRITE_LEDGER" FROM USER "AGENT_RO" RESTRICT; ' +
        'REVOKE EXECUTE ON SPECIFIC PROCEDURE "SYSPROC"."ADMIN_CMD" FROM PUBLIC RESTRICT; ' +
        'REVOKE EXECUTE ON FUNCTION "SYSTOOLS".* FROM PUBLIC RESTRICT; ' +
        'REVOKE EXECUTE ON SPECIFIC METHOD "APP"."POINT_X" FROM USER "AGENT_RO" RESTRICT; ' +
        'REVOKE EXECUTE ON MODULE "SYSIBMADM"."DBMS_JOB" FROM PUBLIC; ' +
        'REVOKE EXECUTE ON PACKAGE "NULLID"."SYSSH200" FROM PUBLIC; ' +
        'REVOKE WRITE ON VARIABLE "APP"."MODE" FROM USER "AGENT_RO".',
    );
  });

  test("a view over code, a view it cannot follow and a nickname are refused by the grant that reaches them", async () => {
    const error = await refusal({
      reach: [
        { GRANTEE: "AGENT_RO", GRANTEETYPE: "U", SCHEMA: "APP", NAME: "CALLS_CODE" },
        { GRANTEE: "PUBLIC", GRANTEETYPE: "G", SCHEMA: "APP", NAME: "REMOTE_ORDERS" },
      ],
    });
    expect(error.message).toBe(
      "The agent read-only execution profile refuses the Db2 user AGENT_RO: it may read a view that calls code that " +
        "is not IBM's or an IBM function that acts outside the call or modifies data, or reads a view or alias the " +
        "check cannot follow, a view that is not valid, or a nickname, " +
        "which reads another server; each runs with its owner's authority. Run, as an administrator: " +
        'REVOKE SELECT ON TABLE "APP"."CALLS_CODE" FROM USER "AGENT_RO"; ' +
        'REVOKE SELECT ON TABLE "APP"."REMOTE_ORDERS" FROM PUBLIC.',
    );
  });

  test("a row permission or column mask anywhere in the database refuses it, naming the controls", async () => {
    const controls = Array.from({ length: 12 }, (_, index) => ({
      SCHEMA: "APP ",
      NAME: `MASK_${index}`,
      TABSCHEMA: "APP ",
      TABNAME: "CUSTOMERS",
    }));
    const error = await refusal({ controls });
    expect(error.message).toBe(
      "The agent read-only execution profile refuses the Db2 user AGENT_RO: the database holds a row permission or " +
        "column mask that is not IBM's, which Db2 evaluates with its owner's authority when any user reads the table " +
        "it guards and which can call a function, so agent mode is not offered on this database while it exists: " +
        Array.from({ length: 10 }, (_, index) => `"APP"."MASK_${index}" on "APP"."CUSTOMERS"`).join(", ") +
        ", and 2 more.",
    );
  });

  test("a trusted context whose system authorization ID is the user refuses it, enabled or not, naming each", async () => {
    const contexts = [
      { NAME: "AUDIT_CTX ", ROLE: "" },
      { NAME: "APP_CTX", ROLE: "WRITER " },
    ];
    const error = await refusal({ contexts });
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toBe(
      "The agent read-only execution profile refuses the Db2 user AGENT_RO: it is the system authorization ID of a " +
        "trusted context, and Db2 makes a connection that matches the context's attributes trusted without being " +
        "asked, giving it the context's default role, which the role list the other checks read does not show, so " +
        'agent mode is not offered for this user while the context exists: "AUDIT_CTX", "APP_CTX" (default role ' +
        '"WRITER").',
    );
  });

  test("findings are named together, each statement once, at most twenty listed and the rest counted", async () => {
    const rows = Array.from({ length: 23 }, (_, index) =>
      privilege("AGENT_RO", "U", "INSERT", "TABLE", "APP", `T${String(index).padStart(2, "0")}`),
    );
    const error = await refusal({
      privileges: [...rows, rows[0]],
      controls: [{ SCHEMA: "APP", NAME: "P", TABSCHEMA: "APP", TABNAME: "T" }],
    });
    expect(error.message).toContain("beyond SELECT; the database holds a row permission");
    expect(error.message).toContain('REVOKE INSERT ON TABLE "APP"."T19" FROM USER "AGENT_RO"; and 3 more.');
    expect(error.message).not.toContain('"T20"');
    expect(error.message.match(/"T00"/g)).toHaveLength(1);
  });

  test("a name with a double quote is quoted as Db2 spells it", async () => {
    const error = await refusal({ privileges: [privilege('A"B', "U", "INSERT", "TABLE", "APP", 'O"K')] });
    expect(error.message).toContain('REVOKE INSERT ON TABLE "APP"."O""K" FROM USER "A""B".');
  });

  test("an answer it cannot read refuses the profile, fail closed", async () => {
    const cases: [Partial<Record<Statement, Rows>>, string][] = [
      [{ user: [] }, "the user read answered 0 rows"],
      [{ user: [{ USERNAME: "" }] }, "user: USERNAME"],
      [{ contexts: [{ NAME: "C", ROLE: null }] }, "contexts: ROLE"],
      [{ contexts: [{ NAME: "", ROLE: "" }] }, "contexts: NAME"],
      [{ authorities: [{ AUTHORITY: 7 }] }, "authorities: AUTHORITY"],
      [{ privileges: [{ ...privilege("A", "U", "INSERT", "TABLE", "APP", "T"), NAME: null }] }, "privileges: NAME"],
      [{ privileges: [privilege("A", "X", "INSERT", "TABLE", "APP", "T")] }, "privileges: GRANTEETYPE X"],
      [{ privileges: [privilege("A", "U", "INSERT", "VIEW", "APP", "T")] }, "privileges: KIND VIEW"],
      [{ code: [privilege("A", "U", "EXECUTE", "TRIGGER", "APP", "T")] }, "code: KIND TRIGGER"],
      [{ reach: [{ GRANTEE: "A", GRANTEETYPE: "U", SCHEMA: "APP" }] }, "reach: NAME"],
      [{ controls: [{ SCHEMA: "APP", NAME: "P", TABSCHEMA: "APP" }] }, "controls: TABNAME"],
    ];
    for (const [answers, what] of cases) {
      const error = await refusal(answers);
      expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(error.message).toBe(
        `The agent read-only execution profile's check of the Db2 user could not be read (${what}), so the boundary is unproven and the connection is refused.`,
      );
    }
  });

  test("a read that fails leaves as it came, and no later check is sent", async () => {
    const failure = new Error("SQL0551N");
    const sent: string[] = [];
    const caught = await verifyAgentPrincipal(async (sql) => {
      sent.push(sql);
      if (sql === AGENT_PRINCIPAL_STATEMENTS.privileges) throw failure;
      return sql === AGENT_PRINCIPAL_STATEMENTS.user ? [{ USERNAME: "AGENT_RO" }] : [];
    }).catch((error: unknown) => error);
    expect(caught).toBe(failure);
    expect(sent).toEqual([
      AGENT_PRINCIPAL_STATEMENTS.user,
      AGENT_PRINCIPAL_STATEMENTS.contexts,
      AGENT_PRINCIPAL_STATEMENTS.authorities,
      AGENT_PRINCIPAL_STATEMENTS.privileges,
    ]);
  });
});

describe("the statement's derived table", () => {
  test("bounds the statement at one row past the budget, keeping its own order, on lines of its own", () => {
    expect(boundAgentStatement("SELECT ID FROM APP.ORDERS ORDER BY ID DESC", 50)).toBe(
      "SELECT * FROM (\nSELECT ID FROM APP.ORDERS ORDER BY ID DESC\n) AS LIBREDB_AGENT_READ " +
        "ORDER BY ORDER OF LIBREDB_AGENT_READ FETCH FIRST 51 ROWS ONLY",
    );
  });

  test("describes the statement without fetching a row", () => {
    expect(describeAgentStatement("VALUES 1")).toBe("SELECT * FROM (\nVALUES 1\n) AS LIBREDB_AGENT_READ WHERE 1 = 0");
  });

  test("leaves out the trailing terminator and trivia, and keeps a comment inside the statement", () => {
    const sql = "  SELECT 1 -- one\n  FROM SYSIBM.SYSDUMMY1 ; -- done\n ";
    expect(boundAgentStatement(sql, 1)).toBe(
      "SELECT * FROM (\nSELECT 1 -- one\n  FROM SYSIBM.SYSDUMMY1\n) AS LIBREDB_AGENT_READ " +
        "ORDER BY ORDER OF LIBREDB_AGENT_READ FETCH FIRST 2 ROWS ONLY",
    );
    expect(describeAgentStatement(sql)).toBe(
      "SELECT * FROM (\nSELECT 1 -- one\n  FROM SYSIBM.SYSDUMMY1\n) AS LIBREDB_AGENT_READ WHERE 1 = 0",
    );
  });
});

describe("the derived table holds the statement whole, or nothing is sent", () => {
  const refusal = (reason: string, sql: string) =>
    new QueryError(
      `Read-only execution refused this statement: ${reason}, so the row bound around it could not be proved to hold`,
      "db2",
      sql,
    );

  test.each([
    ["a literal left open", "SELECT 'x FROM APP.ORDERS"],
    ["a quoted name left open", 'SELECT "X FROM APP.ORDERS'],
    ["a block comment left open", "SELECT 1 FROM SYSIBM.SYSDUMMY1 /* the rest"],
  ])("refuses a statement whose end cannot be read: %s", (_, sql) => {
    const expected = refusal("its end cannot be read, a literal, a quoted name or a comment is left open", sql);
    expect(() => boundAgentStatement(sql, 5)).toThrow(expected);
    expect(() => describeAgentStatement(sql)).toThrow(expected);
  });

  test.each([
    [
      "closes the derived table early to join a lateral read",
      "SELECT 1 FROM SYSIBM.SYSDUMMY1) AS X, LATERAL (SELECT COLNAME FROM SYSCAT.COLUMNS",
    ],
    [
      "closes it early to add a union",
      "SELECT COLNAME FROM SYSCAT.COLUMNS) AS X UNION ALL SELECT * FROM (SELECT COLNAME FROM SYSCAT.COLUMNS",
    ],
    ["closes one more than it opens", "SELECT (1)) FROM SYSIBM.SYSDUMMY1"],
  ])("refuses a statement that %s", (_, sql) => {
    const expected = refusal("it closes a parenthesis it did not open", sql);
    expect(() => boundAgentStatement(sql, 5)).toThrow(expected);
    expect(() => describeAgentStatement(sql)).toThrow(expected);
  });

  test("refuses a statement that leaves a parenthesis open", () => {
    const sql = "SELECT COUNT((1) FROM SYSIBM.SYSDUMMY1";
    expect(() => boundAgentStatement(sql, 5)).toThrow(refusal("it leaves a parenthesis open", sql));
  });

  test("reads past a parenthesis inside a literal, a quoted name or a comment", () => {
    const sql = "SELECT ')' AS \"a)b\", ID FROM APP.ORDERS -- )\nWHERE ID IN (1, 2) /* ( */ ORDER BY ID";
    expect(boundAgentStatement(sql, 5)).toBe(
      `SELECT * FROM (\n${sql}\n) AS LIBREDB_AGENT_READ ORDER BY ORDER OF LIBREDB_AGENT_READ FETCH FIRST 6 ROWS ONLY`,
    );
  });
});

describe("assertAgentColumnTypes", () => {
  const column = (name: string, typeName: string, db2TypeName?: string): Db2ColumnMeta => ({
    name,
    typeName,
    nullable: true,
    ...(db2TypeName === undefined ? {} : { db2TypeName }),
  });

  test("admits every type that is not a LOB or XML", () => {
    expect(() =>
      assertAgentColumnTypes(
        [column("ID", "Integer"), column("NAME", "VarChar(100)"), column("G", "CHAR(5)", "GRAPHIC(5)")],
        "SELECT 1",
      ),
    ).not.toThrow();
  });

  test.each([
    ["CLOB", "CLOB"],
    ["DBCLOB", "DBCLOB"],
    ["BLOB", "BLOB"],
    ["Xml", "XML"],
    ["VarChar(32777)", "CLOB"],
  ])("refuses a %s column before any row is read", (typeName, shown) => {
    expect(() => assertAgentColumnTypes([column("ID", "Integer"), column("DOC", typeName)], "SELECT DOC")).toThrow(
      new QueryError(
        `Read-only execution refused column DOC of type ${shown}: the agent reads no LOB or XML value, whose size the ` +
          "byte budget cannot bound before it is fetched; select a bounded part of it instead, such as " +
          "VARCHAR(SUBSTR(DOC, 1, 1000))",
        "db2",
        "SELECT DOC",
      ),
    );
  });
});

describe("readAgentAnswer", () => {
  const answer = (rows: Record<string, unknown>[]): QueryResult => ({
    rows,
    fields: ["V"],
    rowCount: rows.length,
    executionTime: 1,
  });
  const budget = { statementTimeoutMs: 1000, maxResultRows: 2, maxResultBytes: 40 };

  test("answers a result within the budgets as it is", () => {
    const result = answer([{ V: "a" }, { V: "b" }]);
    expect(readAgentAnswer(result, budget, "SELECT V")).toBe(result);
  });

  test("refuses one row past the row budget, rather than cutting it", () => {
    expect(() => readAgentAnswer(answer([{ V: 1 }, { V: 2 }, { V: 3 }]), budget, "SELECT V")).toThrow(
      new QueryError("Read-only execution exceeded the row budget: 3 rows > 2 allowed", "db2", "SELECT V"),
    );
  });

  test("refuses a result past the byte budget", () => {
    const error = (() => {
      try {
        readAgentAnswer(answer([{ V: "x".repeat(60) }]), budget, "SELECT V");
      } catch (caught) {
        return caught as QueryError;
      }
    })();
    expect(error).toBeInstanceOf(QueryError);
    expect(error?.message).toMatch(/^Read-only execution exceeded the byte budget: \d+ bytes > 40 allowed$/);
  });
});
