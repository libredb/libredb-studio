/**
 * The agent read-only execution profile's statement path on Db2 LUW: the check of the agent user, run before every
 * statement on the statement's own connection, the derived table the statement is sent in, and the reading of an
 * answer against the budget.
 *
 * The boundary is the credential's. Db2 has no read-only user, so the agent signs in as a user that holds CONNECT and
 * SELECT and nothing that writes: the server refuses it an INSERT, a data change in `FINAL TABLE`, `NEXT VALUE FOR`, a
 * `BEGIN ATOMIC` block and a `CREATE` with SQL0551N or SQL0552N (measured on 12.1.0.0,
 * `tests/fixtures/db2/12.1.0.0/agent-boundary/`). What those two privileges do not stop is what the user reaches
 * through others: a granted SQL routine runs with its owner's authority (a table function wrote a row the user may not
 * insert), a view's function reads with its owner's authority, a column mask runs its function for any reader, and a
 * fresh database lets PUBLIC export a table to a server file through `SYSPROC.ADMIN_CMD`, create functions in
 * SYSTOOLS and update the statistics views (all measured). So before each statement the user is proved to reach none
 * of that, from the catalog it reads as itself. Each view is named `SYSCAT.<view>`, each function `SYSPROC.<name>`:
 * an unqualified name resolves through the session's schema and path, and a public alias, which PUBLIC may create on
 * a fresh database, or an object in the user's own schema could stand in for it.
 *
 * Code, a view, a table, a module, a variable or a control is IBM's only when its own catalog row says the system owns
 * it (`OWNERTYPE` S, and for a package `BOUNDBYTYPE` S as well), never by its schema: an administrator cannot create in
 * SYSPROC, SYSCAT, SYSIBM or SYSIBMADM (SQL0553N), but can in SYSTOOLS, and what it creates there is owned by the
 * administrator (measured).
 *
 * The session's grantees are the user, PUBLIC, the user's groups (`AUTH_LIST_GROUPS_FOR_AUTHID`) and every role it
 * holds directly, through a group, through PUBLIC or through another role (`AUTH_LIST_ROLES_FOR_AUTHID`). That list
 * leaves out the one role a session can hold without a grant to the user: a trusted context's default role. Db2 makes
 * a connection trusted without being asked when its system authorization ID and address match an enabled context, and
 * the session then holds the context's default role; a function granted to that role ran for the agent user with its
 * owner's authority (measured). So the first check comes before the others:
 *
 * 0. No trusted context, enabled or not, names the user as its system authorization ID (`SYSCAT.CONTEXTS`). A
 *    disabled one is refused too, since enabling it takes no change the user's own grants would show.
 * 1. The user holds no database or instance authority but CONNECT, in any of those ways
 *    (`AUTH_LIST_AUTHORITIES_FOR_AUTHID`).
 * 2. Its grantees hold no table, column or index privilege but SELECT, no schema or tablespace privilege, no
 *    sequence privilege (`NEXT VALUE FOR` advances a sequence the rollback does not take back), no role's ADMIN
 *    OPTION, no pass-through to a federated server and no SETSESSIONUSER.
 * 3. They may execute no routine, module or package that is not IBM's, since such code runs with its owner's
 *    authority, none of IBM's routines and modules that reach the server's files, the network or work outside the
 *    call (`REACHING_ROUTINES`, `REACHING_MODULES`), and read or write no global variable that is not IBM's, whose
 *    default can call code. A grant on every routine of a schema is refused when any routine there is not admitted.
 * 4. They may read no table object that is not IBM's and is a nickname, which reads another server, or a view that is
 *    not valid (a SELECT revalidates it and runs what it calls now), or a view whose dependencies (`SYSCAT.TABDEP`)
 *    hold anything but a table, a function that is IBM's, a variable that is IBM's, a view that is IBM's or one this
 *    check also examines, or an alias of a table object this check examines.
 * 5. `SYSCAT.CONTROLS` lists no row permission or column mask anywhere in the database that is not IBM's: Db2 evaluates
 *    it for any reader of the table it guards, a reader through a view included, and it can call a secured function
 *    with its owner's authority (measured). A fresh database holds five, IBM's own masks on its catalog tables.
 *
 * Every finding is collected and named in one refusal, as the statements that lift it, or, for a control, as the
 * control. The next call's check reads the catalog as it is then.
 */
import { ExecutionProfileError, QueryError } from "@/lib/db/errors";
import type { QueryResult, ReadOnlyStatementBudget } from "@/lib/db/types";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { readSqlSpan } from "@/lib/sql/spans";
import { readStatementEnd } from "@/lib/sql/statement-end";
import { byteBudgetSentence, measureResultBytes, rowBudgetSentence } from "../read-only-budget";
import type { Db2ColumnMeta } from "./driver";
import { db2TypeName } from "./values";

type Rows = readonly Record<string, unknown>[];

/** Runs one catalog read as the agent user and answers its rows, keyed by the column names its statement gives. */
export type Db2AgentReader = (sql: string) => Promise<Rows>;

/** IBM's routines in SYSPROC that write a server file, reach another server or schedule work outside the call. */
const REACHING_ROUTINES: readonly string[] = [
  "ADMIN_CMD",
  "ADMIN_TASK_ADD",
  "ADMIN_TASK_UPDATE",
  "DB2LOAD",
  "REMOTE_QUERY",
  "SNAP_WRITE_FILE",
  "SYSTS_ADMIN_CMD",
];

/** IBM's modules in SYSIBMADM that reach the server's files, the network, other sessions or the job scheduler. */
const REACHING_MODULES: readonly string[] = [
  "DBMS_ALERT",
  "DBMS_JOB",
  "DBMS_PIPE",
  "UTL_DIR",
  "UTL_FILE",
  "UTL_MAIL",
  "UTL_SMTP",
  "UTL_TCP",
];

const list = (names: readonly string[]) => names.map((name) => `'${name}'`).join(", ");

/** The session's grantees as a common table expression `G`, each with the type the catalog's grantee columns use. */
const GRANTEES =
  "G (GRANTEE, GRANTEETYPE) AS (VALUES (CAST(SESSION_USER AS VARCHAR(128)), CAST('U' AS CHAR(1))), " +
  "(CAST('PUBLIC' AS VARCHAR(128)), CAST('G' AS CHAR(1))) " +
  "UNION SELECT CAST(a.\"GROUP\" AS VARCHAR(128)), CAST('G' AS CHAR(1)) " +
  "FROM TABLE (SYSPROC.AUTH_LIST_GROUPS_FOR_AUTHID(SESSION_USER)) AS a " +
  "UNION SELECT CAST(r.ROLENAME AS VARCHAR(128)), CAST('R' AS CHAR(1)) " +
  "FROM TABLE (SYSPROC.AUTH_LIST_ROLES_FOR_AUTHID(SESSION_USER, 'U')) AS r)";

/** The catalog row `alias` grants to one of the session's grantees. */
function held(alias: string): string {
  return `JOIN G ON G.GRANTEE = ${alias}.GRANTEE AND G.GRANTEETYPE = ${alias}.GRANTEETYPE`;
}

/** The `SYSCAT.ROUTINES` row `alias` is IBM's, and not one of IBM's that reaches outside the call. */
function admittedRoutine(alias: string): string {
  return (
    `${alias}.OWNERTYPE = 'S' AND NOT (${alias}.ROUTINESCHEMA = 'SYSPROC' AND ${alias}.ROUTINENAME IN ` +
    `(${list(REACHING_ROUTINES)}))`
  );
}

/** The privileges a lateral VALUES spreads one catalog row into, one per column that may hold it. */
function spread(alias: string, pairs: readonly (readonly [string, string])[]): string {
  return `TABLE (VALUES ${pairs.map(([name, column]) => `('${name}', ${alias}.${column})`).join(", ")}) AS p (PRIVILEGE, HELD)`;
}

/** The check's statements, in the order they are sent. Each is one SELECT the agent user may run on 12.1. */
export const AGENT_PRINCIPAL_STATEMENTS = Object.freeze({
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
    [
      "SELECT t.GRANTEE, t.GRANTEETYPE, p.PRIVILEGE, 'TABLE' AS KIND, t.TABSCHEMA AS SCHEMA, t.TABNAME AS NAME " +
        `FROM SYSCAT.TABAUTH t ${held("t")}, ` +
        spread("t", [
          ["CONTROL", "CONTROLAUTH"],
          ["ALTER", "ALTERAUTH"],
          ["DELETE", "DELETEAUTH"],
          ["INDEX", "INDEXAUTH"],
          ["INSERT", "INSERTAUTH"],
          ["REFERENCES", "REFAUTH"],
          ["UPDATE", "UPDATEAUTH"],
        ]) +
        " WHERE p.HELD <> 'N'",
      "SELECT c.GRANTEE, c.GRANTEETYPE, CASE c.PRIVTYPE WHEN 'U' THEN 'UPDATE' ELSE 'REFERENCES' END, " +
        `'TABLE', c.TABSCHEMA, c.TABNAME FROM SYSCAT.COLAUTH c ${held("c")}`,
      "SELECT i.GRANTEE, i.GRANTEETYPE, 'CONTROL', 'INDEX', i.INDSCHEMA, i.INDNAME " +
        `FROM SYSCAT.INDEXAUTH i ${held("i")} WHERE i.CONTROLAUTH <> 'N'`,
      "SELECT s.GRANTEE, s.GRANTEETYPE, p.PRIVILEGE, 'SCHEMA', s.SCHEMANAME, s.SCHEMANAME " +
        `FROM SYSCAT.SCHEMAAUTH s ${held("s")}, ` +
        spread(
          "s",
          [
            "ALTERIN",
            "CREATEIN",
            "DROPIN",
            "SELECTIN",
            "INSERTIN",
            "UPDATEIN",
            "DELETEIN",
            "EXECUTEIN",
            "SCHEMAADM",
            "ACCESSCTRL",
            "DATAACCESS",
            "LOAD",
            "SCHEMARCAC",
          ].map((name) => [name, `${name}AUTH`] as const),
        ) +
        " WHERE p.HELD <> 'N'",
      "SELECT b.GRANTEE, b.GRANTEETYPE, 'USE', 'TABLESPACE', '', b.TBSPACE " +
        `FROM SYSCAT.TBSPACEAUTH b ${held("b")} WHERE b.USEAUTH <> 'N'`,
      "SELECT q.GRANTEE, q.GRANTEETYPE, p.PRIVILEGE, 'SEQUENCE', q.SEQSCHEMA, q.SEQNAME " +
        `FROM SYSCAT.SEQUENCEAUTH q ${held("q")}, ` +
        spread("q", [
          ["USAGE", "USAGEAUTH"],
          ["ALTER", "ALTERAUTH"],
        ]) +
        " WHERE p.HELD <> 'N'",
      "SELECT o.GRANTEE, o.GRANTEETYPE, 'ADMIN OPTION', 'ROLE', '', o.ROLENAME " +
        `FROM SYSCAT.ROLEAUTH o ${held("o")} WHERE o.ADMIN <> 'N'`,
      "SELECT h.GRANTEE, h.GRANTEETYPE, 'PASSTHRU', 'SERVER', '', h.SERVERNAME " +
        `FROM SYSCAT.PASSTHRUAUTH h ${held("h")}`,
      "SELECT u.TRUSTEDID, u.TRUSTEDIDTYPE, 'SETSESSIONUSER', 'SESSION USER', '', u.SURROGATEAUTHID " +
        "FROM SYSCAT.SURROGATEAUTHIDS u JOIN G ON G.GRANTEE = u.TRUSTEDID AND G.GRANTEETYPE = u.TRUSTEDIDTYPE",
    ].join(" UNION ALL ") +
    " ORDER BY 4, 5, 6, 3, 1",
  code:
    `WITH ${GRANTEES} ` +
    [
      "SELECT a.GRANTEE, a.GRANTEETYPE, 'EXECUTE' AS PRIVILEGE, " +
        "CASE a.ROUTINETYPE WHEN 'P' THEN 'PROCEDURE' WHEN 'M' THEN 'METHOD' ELSE 'FUNCTION' END AS KIND, " +
        `a.SCHEMA, COALESCE(a.SPECIFICNAME, '*') AS NAME FROM SYSCAT.ROUTINEAUTH a ${held("a")} ` +
        "WHERE a.EXECUTEAUTH <> 'N' AND EXISTS (SELECT 1 FROM SYSCAT.ROUTINES r WHERE r.ROUTINESCHEMA = a.SCHEMA " +
        "AND (r.SPECIFICNAME = a.SPECIFICNAME OR a.SPECIFICNAME IS NULL AND r.ROUTINETYPE = a.ROUTINETYPE) " +
        `AND NOT (${admittedRoutine("r")}))`,
      "SELECT m.GRANTEE, m.GRANTEETYPE, 'EXECUTE', 'MODULE', m.MODULESCHEMA, m.MODULENAME " +
        `FROM SYSCAT.MODULEAUTH m ${held("m")} WHERE m.EXECUTEAUTH <> 'N' ` +
        "AND NOT EXISTS (SELECT 1 FROM SYSCAT.MODULES d WHERE d.MODULEID = m.MODULEID AND d.OWNERTYPE = 'S' " +
        `AND NOT (d.MODULESCHEMA = 'SYSIBMADM' AND d.MODULENAME IN (${list(REACHING_MODULES)})))`,
      "SELECT k.GRANTEE, k.GRANTEETYPE, p.PRIVILEGE, 'PACKAGE', k.PKGSCHEMA, k.PKGNAME " +
        `FROM SYSCAT.PACKAGEAUTH k ${held("k")}, ` +
        spread("k", [
          ["CONTROL", "CONTROLAUTH"],
          ["BIND", "BINDAUTH"],
          ["EXECUTE", "EXECUTEAUTH"],
        ]) +
        " WHERE p.HELD <> 'N' AND (p.PRIVILEGE = 'CONTROL' " +
        "OR NOT EXISTS (SELECT 1 FROM SYSCAT.PACKAGES d WHERE d.PKGSCHEMA = k.PKGSCHEMA AND d.PKGNAME = k.PKGNAME) " +
        "OR EXISTS (SELECT 1 FROM SYSCAT.PACKAGES d WHERE d.PKGSCHEMA = k.PKGSCHEMA AND d.PKGNAME = k.PKGNAME " +
        "AND NOT (d.OWNERTYPE = 'S' AND d.BOUNDBYTYPE = 'S')))",
      "SELECT v.GRANTEE, v.GRANTEETYPE, p.PRIVILEGE, 'VARIABLE', v.VARSCHEMA, v.VARNAME " +
        `FROM SYSCAT.VARIABLEAUTH v ${held("v")}, ` +
        spread("v", [
          ["READ", "READAUTH"],
          ["WRITE", "WRITEAUTH"],
        ]) +
        " WHERE p.HELD <> 'N' " +
        "AND NOT EXISTS (SELECT 1 FROM SYSCAT.VARIABLES d WHERE d.VARID = v.VARID AND d.OWNERTYPE = 'S')",
    ].join(" UNION ALL ") +
    " ORDER BY 4, 5, 6, 3, 1",
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
});

/** At most this many statements are listed in a refusal; the rest are counted. */
const LISTED_STATEMENTS = 20;

/** At most this many controls are named in one finding; the rest are counted. */
const LISTED_CONTROLS = 10;

/** The authorities the instance gives through an operating-system group its configuration names, not a GRANT. */
const INSTANCE_AUTHORITIES: ReadonlySet<string> = new Set(["SYSADM", "SYSCTRL", "SYSMAINT", "SYSMON"]);

/** An identifier as a delimited Db2 name, exactly as the catalog spells it. */
function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function unreadable(what: string): ExecutionProfileError {
  return new ExecutionProfileError(
    `The agent read-only execution profile's check of the Db2 user could not be read (${what}), so the boundary is unproven and the connection is refused.`,
    "PROFILE_PRIVILEGES_TOO_BROAD",
  );
}

/**
 * The named columns of `row` as strings, trailing blanks dropped (db2-node pads a CHAR name), or a refusal when one is
 * not a non-empty string. A column named in `optional` may be empty.
 */
function text(
  row: Record<string, unknown>,
  check: string,
  columns: readonly string[],
  optional: readonly string[] = [],
) {
  return columns.map((column) => {
    const value = row[column];
    const read = typeof value === "string" ? value.trimEnd() : undefined;
    if (read === undefined || (read === "" && !optional.includes(column))) throw unreadable(`${check}: ${column}`);
    return read;
  });
}

/** A grantee as a REVOKE names it, from its catalog name and type. */
function grantee(name: string, type: string, check: string): string {
  if (type === "U") return `USER ${quoted(name)}`;
  if (type === "R") return `ROLE ${quoted(name)}`;
  if (type === "G") return name === "PUBLIC" ? "PUBLIC" : `GROUP ${quoted(name)}`;
  throw unreadable(`${check}: GRANTEETYPE ${type}`);
}

/** One check's findings: what it found, and the statements that lift it. */
interface Finding {
  readonly what: string;
  readonly statements: readonly string[];
}

function contextsFinding(rows: Rows): Finding | null {
  if (rows.length === 0) return null;
  const named = rows.map((row) => {
    const [name, role] = text(row, "contexts", ["NAME", "ROLE"], ["ROLE"]);
    return role === "" ? quoted(name) : `${quoted(name)} (default role ${quoted(role)})`;
  });
  return {
    what:
      "it is the system authorization ID of a trusted context, and Db2 makes a connection that matches the " +
      "context's attributes trusted without being asked, giving it the context's default role, which the role list " +
      "the other checks read does not show, so agent mode is not offered for this user while the context exists: " +
      named.join(", "),
    statements: [],
  };
}

function authoritiesFinding(rows: Rows, user: string): Finding | null {
  if (rows.length === 0) return null;
  return {
    what: "it holds a database or instance authority beyond CONNECT",
    statements: rows.flatMap((row) => {
      const [authority] = text(row, "authorities", ["AUTHORITY"]);
      if (INSTANCE_AUTHORITIES.has(authority)) {
        return [`take ${user} out of the operating-system group the instance names for ${authority}`];
      }
      const statements: string[] = [];
      if (row.D_USER === "Y") statements.push(`REVOKE ${authority} ON DATABASE FROM USER ${quoted(user)}`);
      if (row.D_PUBLIC === "Y") statements.push(`REVOKE ${authority} ON DATABASE FROM PUBLIC`);
      if ([row.D_GROUP, row.ROLE_USER, row.ROLE_GROUP, row.ROLE_PUBLIC].includes("Y")) {
        statements.push(`revoke ${authority} from the group or role that gives it to ${user}`);
      }
      return statements;
    }),
  };
}

/** The REVOKE that takes one privilege row's privilege, by the kind of object it is on. */
function revoke(row: Record<string, unknown>, check: string): string {
  const [name, type, privilege, kind, schema, object] = text(
    row,
    check,
    ["GRANTEE", "GRANTEETYPE", "PRIVILEGE", "KIND", "SCHEMA", "NAME"],
    ["SCHEMA"],
  );
  const from = `FROM ${grantee(name, type, check)}`;
  const qualified = `${quoted(schema)}.${quoted(object)}`;
  switch (kind) {
    case "TABLE":
      return `REVOKE ${privilege} ON TABLE ${qualified} ${from}`;
    case "INDEX":
      return `REVOKE CONTROL ON INDEX ${qualified} ${from}`;
    case "SCHEMA":
      return `REVOKE ${privilege} ON SCHEMA ${quoted(object)} ${from}`;
    case "TABLESPACE":
      return `REVOKE USE OF TABLESPACE ${quoted(object)} ${from}`;
    case "SEQUENCE":
      return `REVOKE ${privilege} ON SEQUENCE ${qualified} ${from} RESTRICT`;
    case "ROLE":
      return `REVOKE ADMIN OPTION FOR ROLE ${quoted(object)} ${from}`;
    case "SERVER":
      return `REVOKE PASSTHRU ON SERVER ${quoted(object)} ${from}`;
    case "SESSION USER":
      return `REVOKE SETSESSIONUSER ON ${object === "PUBLIC" ? "PUBLIC" : `USER ${quoted(object)}`} ${from}`;
    case "FUNCTION":
    case "PROCEDURE":
    case "METHOD":
      return object === "*"
        ? `REVOKE EXECUTE ON ${kind} ${quoted(schema)}.* ${from} RESTRICT`
        : `REVOKE EXECUTE ON SPECIFIC ${kind} ${qualified} ${from} RESTRICT`;
    case "MODULE":
      return `REVOKE EXECUTE ON MODULE ${qualified} ${from}`;
    case "PACKAGE":
      return `REVOKE ${privilege} ON PACKAGE ${qualified} ${from}`;
    case "VARIABLE":
      return `REVOKE ${privilege} ON VARIABLE ${qualified} ${from}`;
    default:
      throw unreadable(`${check}: KIND ${kind}`);
  }
}

function privilegesFinding(rows: Rows): Finding | null {
  if (rows.length === 0) return null;
  return {
    what: "it holds a privilege that writes, creates, administers or acts as another user, beyond SELECT",
    statements: rows.map((row) => revoke(row, "privileges")),
  };
}

function codeFinding(rows: Rows): Finding | null {
  if (rows.length === 0) return null;
  return {
    what:
      "it may execute code that is not IBM's, which runs with its owner's authority, or IBM code that reaches the " +
      "server's files, the network or work outside the call",
    statements: rows.map((row) => revoke(row, "code")),
  };
}

function reachFinding(rows: Rows): Finding | null {
  if (rows.length === 0) return null;
  return {
    what:
      "it may read a view that calls code that is not IBM's or reads a view or alias the check cannot follow, a view " +
      "that is not valid, or a nickname, which reads another server; each runs with its owner's authority",
    statements: rows.map((row) => {
      const [name, type, schema, object] = text(row, "reach", ["GRANTEE", "GRANTEETYPE", "SCHEMA", "NAME"]);
      return `REVOKE SELECT ON TABLE ${quoted(schema)}.${quoted(object)} FROM ${grantee(name, type, "reach")}`;
    }),
  };
}

function controlsFinding(rows: Rows): Finding | null {
  if (rows.length === 0) return null;
  const named = rows.map((row) => {
    const [schema, name, tableSchema, table] = text(row, "controls", ["SCHEMA", "NAME", "TABSCHEMA", "TABNAME"]);
    return `${quoted(schema)}.${quoted(name)} on ${quoted(tableSchema)}.${quoted(table)}`;
  });
  const rest = named.length - LISTED_CONTROLS;
  return {
    what:
      "the database holds a row permission or column mask that is not IBM's, which Db2 evaluates with its owner's " +
      "authority when any user reads the table it guards and which can call a function, so agent mode is not offered " +
      `on this database while it exists: ${named.slice(0, LISTED_CONTROLS).join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`,
    statements: [],
  };
}

/**
 * Proves the agent user before a statement, sending each check through `read` in order and refusing the profile when
 * any finds anything (see the module docblock). A read that fails leaves as it came, so the call fails and no
 * statement is sent.
 */
export async function verifyAgentPrincipal(read: Db2AgentReader): Promise<void> {
  const users = await read(AGENT_PRINCIPAL_STATEMENTS.user);
  if (users.length !== 1) throw unreadable(`the user read answered ${users.length} rows`);
  const [user] = text(users[0], "user", ["USERNAME"]);
  const findings = [
    contextsFinding(await read(AGENT_PRINCIPAL_STATEMENTS.contexts)),
    authoritiesFinding(await read(AGENT_PRINCIPAL_STATEMENTS.authorities), user),
    privilegesFinding(await read(AGENT_PRINCIPAL_STATEMENTS.privileges)),
    codeFinding(await read(AGENT_PRINCIPAL_STATEMENTS.code)),
    reachFinding(await read(AGENT_PRINCIPAL_STATEMENTS.reach)),
    controlsFinding(await read(AGENT_PRINCIPAL_STATEMENTS.controls)),
  ].filter((found): found is Finding => found !== null);
  if (findings.length === 0) return;

  // A table found through several of its columns is named once.
  const statements = [...new Set(findings.flatMap((found) => found.statements))];
  const listed = statements.slice(0, LISTED_STATEMENTS).join("; ");
  const rest = statements.length - LISTED_STATEMENTS;
  const run =
    statements.length === 0 ? "" : ` Run, as an administrator: ${listed}${rest > 0 ? `; and ${rest} more` : ""}.`;
  throw new ExecutionProfileError(
    `The agent read-only execution profile refuses the Db2 user ${user}: ${findings
      .map((found) => found.what)
      .join("; ")}.${run}`,
    "PROFILE_PRIVILEGES_TOO_BROAD",
  );
}

/** The correlation name of the derived table the agent's statement is sent in. */
const AGENT_READ = "LIBREDB_AGENT_READ";

/** The refusal of a statement the derived table cannot be proved to hold whole. */
function unbounded(reason: string, sql: string): QueryError {
  return new QueryError(
    `Read-only execution refused this statement: ${reason}, so the row bound around it could not be proved to hold`,
    "db2",
    sql,
  );
}

/**
 * The statement's own text: trimmed, its terminator and trailing comments left out, read under Db2's grammar, so the
 * closing parenthesis is never swallowed by a `;` or a trailing comment. Refused before anything is sent unless the
 * derived table provably holds it whole: its end must be readable (no literal, quoted name or comment left open, which
 * would swallow what follows), and every parenthesis outside a literal, a quoted name or a comment must close one the
 * statement opened, and all of them close. A statement that closed the derived table early could put a clause beside
 * it that the row bound does not reach.
 */
function statementText(sql: string): string {
  const source = sql.trim();
  const grammar = resolveSqlGrammar("db2");
  const { end, rewritable } = readStatementEnd(source, grammar);
  if (!rewritable) {
    throw unbounded("its end cannot be read, a literal, a quoted name or a comment is left open", sql);
  }
  const text = source.slice(0, end);
  let depth = 0;
  for (let i = 0; i < text.length; ) {
    // Every span inside the statement's own text is terminated: `readStatementEnd` refused any that is not.
    const span = readSqlSpan(text, i, grammar);
    if (span !== null) {
      i = span.end;
      continue;
    }
    if (text[i] === "(") depth++;
    if (text[i] === ")" && --depth < 0) throw unbounded("it closes a parenthesis it did not open", sql);
    i++;
  }
  if (depth !== 0) throw unbounded("it leaves a parenthesis open", sql);
  return text;
}

/**
 * The statement as the agent sends it: a fullselect inside a derived table, its own order kept (`ORDER OF`), bounded at
 * one row past the row budget so a result past it is refused rather than fetched whole. Each part stands on its own
 * line, so a line comment in the statement ends before the closing parenthesis. Only a fullselect fits there: a CALL,
 * a SET, a data change, a compound block or `NEXT VALUE FOR` inside it is refused by the server's parser
 * (SQL0104N, SQL20165N, SQL0348N, measured), and the privileges the check proves are the boundary behind that.
 */
export function boundAgentStatement(sql: string, maxRows: number): string {
  return `SELECT * FROM (\n${statementText(sql)}\n) AS ${AGENT_READ} ORDER BY ORDER OF ${AGENT_READ} FETCH FIRST ${maxRows + 1} ROWS ONLY`;
}

/** The statement's columns without its rows: the same derived table under a predicate no row meets. */
export function describeAgentStatement(sql: string): string {
  return `SELECT * FROM (\n${statementText(sql)}\n) AS ${AGENT_READ} WHERE 1 = 0`;
}

/** The types whose values the agent does not read: a LOB or an XML document, which a row can carry up to 2 GB of. */
const UNREAD_TYPES: ReadonlySet<string> = new Set(["CLOB", "DBCLOB", "BLOB", "XML"]);

/**
 * Refuses a result holding a LOB or XML column, read from the described columns before any row is fetched: db2-node
 * fetches every value of a row whole, so the byte budget could only be applied after the value is in memory.
 */
export function assertAgentColumnTypes(columns: readonly Db2ColumnMeta[], sql: string): void {
  for (const column of columns) {
    const type = db2TypeName(column);
    if (!UNREAD_TYPES.has(type)) continue;
    throw new QueryError(
      `Read-only execution refused column ${column.name} of type ${type}: the agent reads no LOB or XML value, whose ` +
        "size the byte budget cannot bound before it is fetched; select a bounded part of it instead, such as " +
        `VARCHAR(SUBSTR(${column.name}, 1, 1000))`,
      "db2",
      sql,
    );
  }
}

/**
 * The agent's result, or the shared refusal: the statement fetched at most one row past the row budget, so a result
 * past it is refused rather than cut, and every value is counted against the byte budget.
 */
export function readAgentAnswer(result: QueryResult, budget: ReadOnlyStatementBudget, sql: string): QueryResult {
  if (result.rows.length > budget.maxResultRows) {
    throw new QueryError(rowBudgetSentence(result.rows.length, budget.maxResultRows), "db2", sql);
  }
  const bytes = measureResultBytes(result.rows);
  if (bytes > budget.maxResultBytes) {
    throw new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), "db2", sql);
  }
  return result;
}
