/**
 * The agent read-only execution profile's statement path on Oracle: the check of the agent user, run once at first
 * use, and the reading of an answer against the budget.
 *
 * The boundary is the credential's. A local user set `ALTER USER ... READ ONLY` (Oracle Database 23ai and later) is
 * refused every write with ORA-28194: DML, DDL, temporary tables, `SELECT ... FOR UPDATE`, `LOCK TABLE`, `DBMS_SQL`,
 * a write over a database link, a granted definer's-rights function that writes in an autonomous transaction, the SQL
 * `COMMIT` and `ROLLBACK`, and every one of them again after `ALTER SESSION SET READ_ONLY = FALSE` (measured on 26ai
 * Free 23.26.3, `tests/fixtures/oracle/23.26.3-free/agent-boundary/`). What READ ONLY does not stop is what the user
 * can reach through others: a sequence's `NEXTVAL` advances, and a granted definer's-rights function runs with its
 * owner's privileges, `ALTER SYSTEM` and `NEXTVAL` included (captures 05 to 09). So the user is proved to reach none
 * of that before its first statement, from the dictionary views it reads as itself. Each is named `SYS.<view>`: an
 * unqualified name resolves first to an object or a private synonym in the user's own schema, then to a PUBLIC
 * synonym, either of which could stand in for the view and hide what it lists.
 *
 * 1. `USER_USERS.READ_ONLY` reads YES. A server without the column (ORA-00904) is older than 23ai and is refused.
 * 2. Every role granted to it, directly or through PUBLIC, is a default role. `SET ROLE` is permitted under READ ONLY
 *    and a pooled session keeps the role it enabled, while `ALL_TAB_PRIVS` lists only the grants of enabled roles, so
 *    a role the check cannot see the grants of is refused.
 * 3. It, its roles and PUBLIC hold EXECUTE on no PL/SQL unit, type, Java class or library a schema Oracle does not
 *    maintain owns (`ALL_USERS.ORACLE_MAINTAINED`), since such code runs with its owner's rights.
 * 4. They may read no view of such a schema whose definition calls code, a function, package or type, rather than a
 *    table or view: a plain SELECT on such a view runs the code with its owner's rights, and advanced a sequence for a
 *    READ ONLY user (measured). A view that calls the code through a synonym lists only the synonym, and `ALL_SYNONYMS`
 *    does not show the user another schema's private synonym, so a synonym is admitted only when it resolves to an
 *    object the check starts from (`ROOTS`), or to an object of a schema Oracle maintains (`PUBLIC.DUAL`), and is
 *    refused otherwise, a private synonym for a table included. `ALL_DEPENDENCIES` lists the user the view's own
 *    dependencies only, and an inner view's only when `ALL_OBJECTS` shows the user the inner view, any object grant
 *    that does so included, so a view over a view of such a schema is admitted only when the inner view is one the
 *    check starts from: measured, an outer view over an inner view the user could not see listed only the inner one
 *    and its SELECT ran the inner view's function.
 * 5. They may read no such view that is not valid: an invalid view lists the dependencies it had, and the user's SELECT
 *    compiles it and runs what it calls now (measured).
 * 6. No table or view of such a schema the user can see in `ALL_TAB_COLS` has a virtual column, hidden ones included:
 *    a SELECT of the column evaluates its expression, which can call a function with its owner's rights, and a hidden
 *    column of a function-based index can be selected by name (both measured). Every one is refused, a built-in
 *    expression such as `UPPER(NAME)` and the hidden column extended statistics add included, since the expression is
 *    not proved; a granted view that leaves it out is the remedy.
 * 7. `DBA_POLICIES` lists no row-level security policy anywhere in the database whose function such a schema owns,
 *    on any object, one Oracle maintains included: a SELECT of what it guards runs the function with its owner's
 *    rights, and the user can reach a guarded object the check cannot follow it to, behind a view or among Oracle's
 *    own tables (measured). A database that holds one is refused whatever the user is granted.
 * 8. `DBA_AUDIT_POLICIES` lists no fine-grained auditing policy anywhere with an audit condition, which a read
 *    evaluates and which can call a function with its owner's rights (measured), or with a handler such a schema owns,
 *    which a read runs. The condition is not parsed to prove it built-in. A fresh 26ai database holds no such policy
 *    and no such row-level policy (capture 00). A user that may not read either view is refused, naming its grant.
 * 9. They hold no privilege on a sequence such a schema owns, and the user owns no sequence.
 * 10. They hold EXECUTE on none of the packages that reach the network or the server's files, and no privilege on a
 *    directory, which `BFILENAME` reads server files through.
 * 11. The session holds no system privilege but CREATE SESSION.
 * 12. `ALL_DB_LINKS` lists no link, PUBLIC or its own, since a link reaches another database under its stored
 *    credential.
 *
 * Every finding is collected and named in one refusal, as the statements that lift it, or, for a policy, as the
 * policy. A revoke can uncover the next finding: a granted view over a view the refusal names is refused once that
 * inner grant is gone, so the check is run again until it admits. Oracle-maintained schemas'
 * PUBLIC grants are the vendor's boundary and are not refused: their four sequences can still be advanced, which moves
 * a counter and changes no data (capture 07).
 */
import { ExecutionProfileError, QueryError } from "@/lib/db/errors";
import type { QueryResult, ReadOnlyStatementBudget } from "@/lib/db/types";
import { byteBudgetSentence, measureResultBytes, rowBudgetSentence, TIME_BUDGET_PREFIX } from "../read-only-budget";

type Rows = readonly Record<string, unknown>[];

/** Runs one dictionary read as the agent user and answers its rows, keyed by the upper-case column names. */
export type OracleAgentReader = (sql: string) => Promise<Rows>;

/** The grantees whose privileges the session holds: the user, the roles enabled in it, and PUBLIC. */
const SESSION_GRANTEES = "(p.GRANTEE IN (USER, 'PUBLIC') OR p.GRANTEE IN (SELECT ROLE FROM SYS.SESSION_ROLES))";

/** An owner ALL_USERS does not mark as Oracle-maintained, an owner it does not list included, fail closed. */
const NOT_ORACLE_MAINTAINED = "NVL(u.ORACLE_MAINTAINED, 'N') <> 'Y'";

/**
 * The objects the check starts from, as a common table expression named `r`: every object of a schema Oracle does not
 * maintain granted to a grantee the session holds that `ALL_OBJECTS` shows the user, and every table or view the user
 * owns, with the grantee a revoke names (none for the user's own). A view's dependencies are read only for these, so an
 * object outside them is one the check has not examined: a grant `ALL_OBJECTS` does not show the object for, such as
 * DEBUG on a view, shows the user none of its dependencies either (measured).
 */
const ROOTS =
  "WITH r AS (SELECT p.GRANTEE, p.TABLE_SCHEMA AS OWNER, p.TABLE_NAME AS NAME FROM SYS.ALL_TAB_PRIVS p " +
  "JOIN SYS.ALL_OBJECTS o ON o.OWNER = p.TABLE_SCHEMA AND o.OBJECT_NAME = p.TABLE_NAME " +
  `LEFT JOIN SYS.ALL_USERS u ON u.USERNAME = p.TABLE_SCHEMA WHERE NVL(p.TYPE, '-') <> 'USER' AND ${NOT_ORACLE_MAINTAINED} ` +
  `AND ${SESSION_GRANTEES} ` +
  "UNION SELECT NULL, USER, OBJECT_NAME FROM SYS.USER_OBJECTS WHERE OBJECT_TYPE IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW'))";

/** The packages and types whose EXECUTE reaches the network or the server's files. */
const REACHING_PACKAGES: readonly string[] = [
  "UTL_HTTP",
  "UTL_TCP",
  "UTL_SMTP",
  "UTL_FILE",
  "UTL_INADDR",
  "HTTPURITYPE",
  "DBMS_LDAP",
  "DBMS_SCHEDULER",
  "DBMS_PIPE",
  "DBMS_XSLPROCESSOR",
];

/** The check's statements, in the order they are sent. Each is one SELECT the agent user may run on any 23ai. */
export const AGENT_PRINCIPAL_STATEMENTS = Object.freeze({
  readOnly: "SELECT USERNAME, READ_ONLY FROM SYS.USER_USERS",
  roles:
    "SELECT USERNAME AS GRANTEE, GRANTED_ROLE FROM SYS.USER_ROLE_PRIVS WHERE NVL(DEFAULT_ROLE, 'NO') <> 'YES' " +
    "ORDER BY 2, 1",
  units:
    "SELECT p.GRANTEE, p.TABLE_SCHEMA AS OWNER, p.TABLE_NAME AS NAME, p.TYPE AS OBJECT_TYPE " +
    "FROM SYS.ALL_TAB_PRIVS p LEFT JOIN SYS.ALL_USERS u ON u.USERNAME = p.TABLE_SCHEMA " +
    `WHERE p.PRIVILEGE = 'EXECUTE' AND ${NOT_ORACLE_MAINTAINED} AND ${SESSION_GRANTEES} ` +
    "ORDER BY 2, 3, 1",
  views:
    `${ROOTS} SELECT p.GRANTEE, d.OWNER, d.NAME, d.REFERENCED_OWNER || '.' || d.REFERENCED_NAME AS CALLS ` +
    "FROM SYS.ALL_DEPENDENCIES d JOIN r p ON p.OWNER = d.OWNER AND p.NAME = d.NAME " +
    "LEFT JOIN SYS.ALL_USERS u ON u.USERNAME = d.OWNER " +
    "LEFT JOIN SYS.ALL_USERS ru ON ru.USERNAME = d.REFERENCED_OWNER " +
    "LEFT JOIN SYS.ALL_SYNONYMS s ON s.OWNER = d.REFERENCED_OWNER AND s.SYNONYM_NAME = d.REFERENCED_NAME " +
    "AND s.DB_LINK IS NULL " +
    "LEFT JOIN SYS.ALL_USERS su ON su.USERNAME = s.TABLE_OWNER " +
    "WHERE d.TYPE = 'VIEW' AND (d.REFERENCED_TYPE NOT IN ('TABLE', 'VIEW', 'SYNONYM', 'MATERIALIZED VIEW', 'NON-EXISTENT') " +
    "OR d.REFERENCED_TYPE = 'VIEW' AND NVL(ru.ORACLE_MAINTAINED, 'N') <> 'Y' AND NOT EXISTS (SELECT 1 FROM r v " +
    "WHERE v.OWNER = d.REFERENCED_OWNER AND v.NAME = d.REFERENCED_NAME) " +
    "OR d.REFERENCED_TYPE = 'SYNONYM' AND NVL(su.ORACLE_MAINTAINED, 'N') <> 'Y' AND NOT EXISTS (SELECT 1 FROM r o " +
    "WHERE o.OWNER = s.TABLE_OWNER AND o.NAME = s.TABLE_NAME)) " +
    `AND ${NOT_ORACLE_MAINTAINED} ORDER BY 2, 3, 1, 4`,
  invalidViews:
    `${ROOTS} SELECT p.GRANTEE, o.OWNER, o.OBJECT_NAME AS NAME, o.STATUS ` +
    "FROM SYS.ALL_OBJECTS o JOIN r p ON p.OWNER = o.OWNER AND p.NAME = o.OBJECT_NAME " +
    "LEFT JOIN SYS.ALL_USERS u ON u.USERNAME = o.OWNER " +
    `WHERE o.OBJECT_TYPE = 'VIEW' AND o.STATUS <> 'VALID' AND ${NOT_ORACLE_MAINTAINED} ORDER BY 2, 3, 1`,
  virtualColumns:
    "SELECT p.GRANTEE, c.OWNER, c.TABLE_NAME AS NAME, c.COLUMN_NAME " +
    "FROM SYS.ALL_TAB_COLS c LEFT JOIN SYS.ALL_USERS u ON u.USERNAME = c.OWNER " +
    `LEFT JOIN SYS.ALL_TAB_PRIVS p ON p.TABLE_SCHEMA = c.OWNER AND p.TABLE_NAME = c.TABLE_NAME AND ${SESSION_GRANTEES} ` +
    `WHERE c.VIRTUAL_COLUMN = 'YES' AND ${NOT_ORACLE_MAINTAINED} ORDER BY 2, 3, 1, 4`,
  policies:
    "SELECT a.OBJECT_OWNER AS OWNER, a.OBJECT_NAME AS NAME, a.POLICY_NAME AS POLICY " +
    "FROM SYS.DBA_POLICIES a LEFT JOIN SYS.ALL_USERS u ON u.USERNAME = a.PF_OWNER " +
    `WHERE ${NOT_ORACLE_MAINTAINED} ORDER BY 1, 2, 3`,
  auditPolicies:
    "SELECT f.OBJECT_SCHEMA AS OWNER, f.OBJECT_NAME AS NAME, f.POLICY_NAME AS POLICY " +
    "FROM SYS.DBA_AUDIT_POLICIES f LEFT JOIN SYS.ALL_USERS u ON u.USERNAME = f.PF_SCHEMA " +
    "WHERE f.POLICY_TEXT IS NOT NULL OR (f.PF_PACKAGE IS NOT NULL OR f.PF_FUNCTION IS NOT NULL) " +
    `AND ${NOT_ORACLE_MAINTAINED} ORDER BY 1, 2, 3`,
  sequences:
    "SELECT p.GRANTEE, p.TABLE_SCHEMA AS OWNER, p.TABLE_NAME AS NAME, 'N' AS OWNED " +
    "FROM SYS.ALL_TAB_PRIVS p LEFT JOIN SYS.ALL_USERS u ON u.USERNAME = p.TABLE_SCHEMA " +
    `WHERE p.TYPE = 'SEQUENCE' AND ${NOT_ORACLE_MAINTAINED} AND ${SESSION_GRANTEES} ` +
    "UNION ALL SELECT USER, USER, SEQUENCE_NAME, 'Y' FROM SYS.USER_SEQUENCES ORDER BY 2, 3, 1",
  reach:
    "SELECT p.GRANTEE, p.TABLE_SCHEMA AS OWNER, p.TABLE_NAME AS NAME, p.PRIVILEGE, p.TYPE AS OBJECT_TYPE " +
    "FROM SYS.ALL_TAB_PRIVS p " +
    `WHERE ((p.PRIVILEGE = 'EXECUTE' AND p.TABLE_NAME IN (${REACHING_PACKAGES.map((name) => `'${name}'`).join(", ")})) ` +
    `OR p.TYPE = 'DIRECTORY') AND ${SESSION_GRANTEES} ORDER BY 3, 4, 1`,
  systemPrivileges:
    "SELECT p.PRIVILEGE, g.GRANTEE FROM SYS.SESSION_PRIVS p LEFT JOIN " +
    "(SELECT USERNAME AS GRANTEE, PRIVILEGE FROM SYS.USER_SYS_PRIVS UNION ALL SELECT ROLE, PRIVILEGE FROM SYS.ROLE_SYS_PRIVS) g " +
    "ON g.PRIVILEGE = p.PRIVILEGE WHERE p.PRIVILEGE <> 'CREATE SESSION' ORDER BY 1, 2",
  links: "SELECT OWNER, DB_LINK FROM SYS.ALL_DB_LINKS ORDER BY 1, 2",
});

/** At most this many statements are listed in a refusal; the rest are counted. */
const LISTED_STATEMENTS = 20;

/** At most this many policies are named in one finding; the rest are counted. */
const LISTED_POLICIES = 10;

/** An identifier as a quoted Oracle name, exactly as the dictionary spells it. */
function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** A grantee as a REVOKE names it: PUBLIC bare, any other quoted. */
function grantee(name: string): string {
  return name === "PUBLIC" ? "PUBLIC" : quoted(name);
}

function unreadable(what: string): ExecutionProfileError {
  return new ExecutionProfileError(
    `The agent read-only execution profile's check of the Oracle user could not be read (${what}), so the boundary is unproven and the connection is refused.`,
    "PROFILE_PRIVILEGES_TOO_BROAD",
  );
}

/** The named columns of `row` as strings, or a refusal when one is not a non-empty string. */
function text(row: Record<string, unknown>, check: string, ...columns: string[]): string[] {
  return columns.map((column) => {
    const value = row[column];
    if (typeof value !== "string" || value === "") throw unreadable(`${check}: ${column}`);
    return value;
  });
}

/** One check's findings: what it found, and the statements that lift it. */
interface Finding {
  readonly what: string;
  readonly statements: readonly string[];
}

function readOnlyFinding(rows: Rows): { user: string; finding: Finding | null } {
  if (rows.length !== 1) throw unreadable(`USER_USERS answered ${rows.length} rows`);
  const [user, readOnly] = text(rows[0], "USER_USERS", "USERNAME", "READ_ONLY");
  if (readOnly === "YES") return { user, finding: null };
  return {
    user,
    finding: { what: `${user} is not set READ ONLY`, statements: [`ALTER USER ${quoted(user)} READ ONLY`] },
  };
}

function rolesFinding(rows: Rows): Finding | null {
  if (rows.length === 0) return null;
  return {
    what: "it holds a role that is not enabled at sign-in, whose grants SET ROLE would add",
    statements: rows.map((row) => {
      const [to, role] = text(row, "USER_ROLE_PRIVS", "GRANTEE", "GRANTED_ROLE");
      return `REVOKE ${quoted(role)} FROM ${grantee(to)}`;
    }),
  };
}

function unitsFinding(rows: Rows): Finding | null {
  if (rows.length === 0) return null;
  return {
    what: "it holds EXECUTE on code a schema Oracle does not maintain owns, which runs with its owner's rights",
    statements: rows.map((row) => {
      const [to, owner, name] = text(row, "ALL_TAB_PRIVS", "GRANTEE", "OWNER", "NAME");
      return `REVOKE EXECUTE ON ${quoted(owner)}.${quoted(name)} FROM ${grantee(to)}`;
    }),
  };
}

/** A grantee a revoke can name, or the open placeholder when the check read the object through no grant it can name. */
function optionalGrantee(row: Record<string, unknown>): string {
  return typeof row.GRANTEE === "string" && row.GRANTEE !== "" ? grantee(row.GRANTEE) : "<its grantee>";
}

/**
 * What takes `owner.name` from the user: the revoke of the grant the row names, or, for an object the user owns, which
 * no revoke takes from it, its move out of the user's schema.
 */
function lift(row: Record<string, unknown>, user: string, owner: string, name: string): string {
  const object = `${quoted(owner)}.${quoted(name)}`;
  if (owner === user && optionalGrantee(row) === "<its grantee>") {
    return `move ${object} out of the agent user's own schema`;
  }
  return `REVOKE ALL ON ${object} FROM ${optionalGrantee(row)}`;
}

function viewsFinding(rows: Rows, user: string): Finding | null {
  if (rows.length === 0) return null;
  return {
    what: "it may read a view that calls code a schema Oracle does not maintain owns, or a synonym or view the check cannot follow to its end, which a SELECT runs with its owner's rights",
    statements: rows.map((row) => {
      const [owner, name] = text(row, "ALL_DEPENDENCIES", "OWNER", "NAME", "CALLS");
      return lift(row, user, owner, name);
    }),
  };
}

function invalidViewsFinding(rows: Rows, user: string): Finding | null {
  if (rows.length === 0) return null;
  return {
    what: "it may read a view that is not valid, whose dependencies the dictionary lists only once it is compiled, while a SELECT compiles it and runs what it calls",
    statements: rows.map((row) => {
      const [owner, name] = text(row, "ALL_OBJECTS", "OWNER", "NAME", "STATUS");
      return lift(row, user, owner, name);
    }),
  };
}

function virtualColumnsFinding(rows: Rows, user: string): Finding | null {
  if (rows.length === 0) return null;
  return {
    what: "it may read a table or view with a virtual column, whose expression a SELECT evaluates and which can call code with its owner's rights (grant a view that leaves it out instead)",
    statements: rows.map((row) => {
      const [owner, name] = text(row, "ALL_TAB_COLS", "OWNER", "NAME", "COLUMN_NAME");
      return lift(row, user, owner, name);
    }),
  };
}

/** Whether `error` is the server's answer that the user may not read a catalog view. */
function isUnreadableCatalog(error: unknown): boolean {
  return error instanceof Error && /\bORA-00942\b/.test(error.message);
}

/** The two policy catalogs the check reads database wide, each with what its finding says. */
const POLICY_CATALOGS = {
  policies: {
    view: "DBA_POLICIES",
    lists: "the row-level security policies of the database",
    holds:
      "a row-level security policy whose function a schema Oracle does not maintain owns, which Oracle runs with that owner's rights when any user reads what it guards",
  },
  auditPolicies: {
    view: "DBA_AUDIT_POLICIES",
    lists: "the fine-grained auditing policies of the database",
    holds:
      "a fine-grained auditing policy with an audit condition, which Oracle evaluates when any user reads what it audits and which can call a function, or with a handler a schema Oracle does not maintain owns, which Oracle runs with that owner's rights",
  },
} as const;

/**
 * The policies a catalog lists that no user of the database can be proven outside (see the module docblock, items 7
 * and 8). No revoke of the user's grants lifts one, so the finding names the policies rather than a statement; a user
 * that may not read the catalog is refused, naming the grant, which only SYS may run.
 */
async function policyCatalogFinding(
  read: OracleAgentReader,
  catalog: keyof typeof POLICY_CATALOGS,
  user: string,
): Promise<Finding | null> {
  const { view, lists, holds } = POLICY_CATALOGS[catalog];
  let rows: Rows;
  try {
    rows = await read(AGENT_PRINCIPAL_STATEMENTS[catalog]);
  } catch (error) {
    if (!isUnreadableCatalog(error)) throw error;
    return {
      what: `the check cannot read SYS.${view}, which lists ${lists}`,
      statements: [`GRANT SELECT ON SYS.${view} TO ${quoted(user)} (as SYS)`],
    };
  }
  if (rows.length === 0) return null;
  const named = rows.map((row) => {
    const [owner, name, policy] = text(row, view, "OWNER", "NAME", "POLICY");
    return `${quoted(owner)}.${quoted(name)} policy ${quoted(policy)}`;
  });
  const rest = named.length - LISTED_POLICIES;
  return {
    what: `the database holds ${holds}, so agent mode is not offered on this database while it exists: ${named
      .slice(0, LISTED_POLICIES)
      .join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`,
    statements: [],
  };
}

function sequencesFinding(rows: Rows): Finding | null {
  if (rows.length === 0) return null;
  return {
    what: "it can reach a sequence NEXTVAL would advance",
    statements: rows.map((row) => {
      const [to, owner, name, owned] = text(row, "sequences", "GRANTEE", "OWNER", "NAME", "OWNED");
      return owned === "Y"
        ? `DROP SEQUENCE ${quoted(owner)}.${quoted(name)}`
        : `REVOKE ALL ON ${quoted(owner)}.${quoted(name)} FROM ${grantee(to)}`;
    }),
  };
}

function reachFinding(rows: Rows): Finding | null {
  if (rows.length === 0) return null;
  return {
    what: "it holds a package that reaches the network or the server's files, or a directory",
    statements: rows.map((row) => {
      const [to, owner, name, privilege, type] = text(
        row,
        "ALL_TAB_PRIVS",
        "GRANTEE",
        "OWNER",
        "NAME",
        "PRIVILEGE",
        "OBJECT_TYPE",
      );
      const object = type === "DIRECTORY" ? `DIRECTORY ${quoted(name)}` : `${quoted(owner)}.${quoted(name)}`;
      return `REVOKE ${privilege} ON ${object} FROM ${grantee(to)}`;
    }),
  };
}

function systemPrivilegesFinding(rows: Rows): Finding | null {
  if (rows.length === 0) return null;
  return {
    what: "it holds a system privilege beyond CREATE SESSION",
    statements: rows.map((row) => {
      const [privilege] = text(row, "SESSION_PRIVS", "PRIVILEGE");
      // A privilege the session holds through a grantee neither view lists is still refused, its grantee left open.
      return `REVOKE ${privilege} FROM ${optionalGrantee(row)}`;
    }),
  };
}

function linksFinding(rows: Rows): Finding | null {
  if (rows.length === 0) return null;
  return {
    what: "it can use a database link, which reaches another database under its stored credential",
    statements: rows.flatMap((row, index) => {
      const [owner, link] = text(row, "ALL_DB_LINKS", "OWNER", "DB_LINK");
      if (owner === "PUBLIC") return [`DROP PUBLIC DATABASE LINK ${quoted(link)}`];
      // Only its owner drops a private link, and the owner is the agent user, whose READ ONLY refuses the DROP: it is
      // set READ WRITE around its drops. The rows are ordered by owner, so its links are consecutive.
      const first = rows[index - 1]?.OWNER !== owner;
      const last = rows[index + 1]?.OWNER !== owner;
      return [
        ...(first ? [`ALTER USER ${quoted(owner)} READ WRITE`] : []),
        `DROP DATABASE LINK ${quoted(link)} (as ${owner})`,
        ...(last ? [`ALTER USER ${quoted(owner)} READ ONLY`] : []),
      ];
    }),
  };
}

/** Whether `error` is the server's answer that `USER_USERS` has no `READ_ONLY` column. */
function isMissingReadOnlyColumn(error: unknown): boolean {
  return error instanceof Error && /\bORA-00904\b/.test(error.message);
}

/**
 * Proves the agent user before its first statement, sending each check through `read` in order and refusing the
 * profile when any finds anything (see the module docblock). A failure of the first read other than ORA-00904, or of
 * any later read, leaves as it came, so the call fails and no statement is sent.
 */
export async function verifyAgentPrincipal(read: OracleAgentReader): Promise<void> {
  let readOnlyRows: Rows;
  try {
    readOnlyRows = await read(AGENT_PRINCIPAL_STATEMENTS.readOnly);
  } catch (error) {
    if (!isMissingReadOnlyColumn(error)) throw error;
    throw new ExecutionProfileError(
      "The agent read-only execution profile requires Oracle Database 23ai or later, where a user can be set READ ONLY; this server answered ORA-00904 for USER_USERS.READ_ONLY, so the connection is refused.",
      "PROFILE_UNSUPPORTED_TARGET",
    );
  }
  const { user, finding } = readOnlyFinding(readOnlyRows);
  const findings = [
    finding,
    rolesFinding(await read(AGENT_PRINCIPAL_STATEMENTS.roles)),
    unitsFinding(await read(AGENT_PRINCIPAL_STATEMENTS.units)),
    viewsFinding(await read(AGENT_PRINCIPAL_STATEMENTS.views), user),
    invalidViewsFinding(await read(AGENT_PRINCIPAL_STATEMENTS.invalidViews), user),
    virtualColumnsFinding(await read(AGENT_PRINCIPAL_STATEMENTS.virtualColumns), user),
    await policyCatalogFinding(read, "policies", user),
    await policyCatalogFinding(read, "auditPolicies", user),
    sequencesFinding(await read(AGENT_PRINCIPAL_STATEMENTS.sequences)),
    reachFinding(await read(AGENT_PRINCIPAL_STATEMENTS.reach)),
    systemPrivilegesFinding(await read(AGENT_PRINCIPAL_STATEMENTS.systemPrivileges)),
    linksFinding(await read(AGENT_PRINCIPAL_STATEMENTS.links)),
  ].filter((found): found is Finding => found !== null);
  if (findings.length === 0) return;

  // A view or table found through several of its columns or calls is named once.
  const statements = [...new Set(findings.flatMap((found) => found.statements))];
  const listed = statements.slice(0, LISTED_STATEMENTS).join("; ");
  const rest = statements.length - LISTED_STATEMENTS;
  const run =
    statements.length === 0 ? "" : ` Run, as an administrator: ${listed}${rest > 0 ? `; and ${rest} more` : ""}.`;
  throw new ExecutionProfileError(
    `The agent read-only execution profile refuses the Oracle user ${user}: ${findings
      .map((found) => found.what)
      .join("; ")}.${run}`,
    "PROFILE_PRIVILEGES_TOO_BROAD",
  );
}

/** One column of a result, as much of the driver's metadata as the type refusal reads. */
interface AgentColumn {
  readonly name: string;
  readonly dbType?: unknown;
  readonly dbTypeName?: string;
}

/**
 * Refuses an answer holding a column of a type the agent does not read: a BFILE, whose locator reads a server file,
 * and an object or a cursor, which carry values the byte budget cannot measure. Checked on the metadata before any
 * value is read.
 */
export function assertAgentColumnTypes(
  metaData: readonly AgentColumn[] | undefined,
  refused: readonly unknown[],
  sql: string,
): void {
  const column = metaData?.find((candidate) => refused.includes(candidate.dbType));
  if (column === undefined) return;
  throw new QueryError(
    `Read-only execution refused column ${column.name} of type ${column.dbTypeName ?? "unknown"}: the agent reads scalar and LOB values only`,
    "oracle",
    sql,
  );
}

/**
 * The agent's result, or the shared refusal: the execute fetched at most one row past the row budget (`maxRows`), so a
 * result past it is refused rather than cut, and every value, a LOB fetched whole as a string or a buffer included, is
 * counted against the byte budget.
 */
export function readAgentAnswer(result: QueryResult, budget: ReadOnlyStatementBudget, sql: string): QueryResult {
  if (result.rows.length > budget.maxResultRows) {
    throw new QueryError(rowBudgetSentence(result.rows.length, budget.maxResultRows), "oracle", sql);
  }
  const bytes = measureResultBytes(result.rows);
  if (bytes > budget.maxResultBytes) {
    throw new QueryError(byteBudgetSentence(bytes, budget.maxResultBytes), "oracle", sql);
  }
  return result;
}

/** The driver's call timeout (NJS-123, the Thick client's DPI-1067) as the shared time refusal, or null. */
export function agentDeadlineRefusal(error: unknown, budget: ReadOnlyStatementBudget, sql: string): QueryError | null {
  if (!(error instanceof Error) || !/\b(?:NJS-123|DPI-1067)\b/.test(error.message)) return null;
  return new QueryError(`${TIME_BUDGET_PREFIX}: no answer within ${budget.statementTimeoutMs}ms`, "oracle", sql);
}
