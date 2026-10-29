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
 * of that before its first statement, from the dictionary views it reads as itself:
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
 *    does not show the user another schema's private synonym, so a synonym is admitted only when it resolves to a
 *    table or view the user can see, or to an object of a schema Oracle maintains (`PUBLIC.DUAL`), and is refused
 *    otherwise, a private synonym for a table included. `ALL_DEPENDENCIES` lists the user the view's own dependencies
 *    only, so a view reached through another view, a virtual column and a row-level policy function are not seen here.
 * 5. They hold no privilege on a sequence such a schema owns, and the user owns no sequence.
 * 6. They hold EXECUTE on none of the packages that reach the network or the server's files, and no privilege on a
 *    directory, which `BFILENAME` reads server files through.
 * 7. The session holds no system privilege but CREATE SESSION.
 * 8. `ALL_DB_LINKS` lists no link, PUBLIC or its own, since a link reaches another database under its stored
 *    credential.
 *
 * Every finding is collected and named in one refusal, as the statements that lift it. Oracle-maintained schemas'
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
const SESSION_GRANTEES = "(p.GRANTEE IN (USER, 'PUBLIC') OR p.GRANTEE IN (SELECT ROLE FROM SESSION_ROLES))";

/** An owner ALL_USERS does not mark as Oracle-maintained, an owner it does not list included, fail closed. */
const NOT_ORACLE_MAINTAINED = "NVL(u.ORACLE_MAINTAINED, 'N') <> 'Y'";

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
  readOnly: "SELECT USERNAME, READ_ONLY FROM USER_USERS",
  roles:
    "SELECT USERNAME AS GRANTEE, GRANTED_ROLE FROM USER_ROLE_PRIVS WHERE NVL(DEFAULT_ROLE, 'NO') <> 'YES' " +
    "ORDER BY 2, 1",
  units:
    "SELECT p.GRANTEE, p.TABLE_SCHEMA AS OWNER, p.TABLE_NAME AS NAME, p.TYPE AS OBJECT_TYPE " +
    "FROM ALL_TAB_PRIVS p LEFT JOIN ALL_USERS u ON u.USERNAME = p.TABLE_SCHEMA " +
    `WHERE p.PRIVILEGE = 'EXECUTE' AND ${NOT_ORACLE_MAINTAINED} AND ${SESSION_GRANTEES} ` +
    "ORDER BY 2, 3, 1",
  views:
    "SELECT p.GRANTEE, d.OWNER, d.NAME, d.REFERENCED_OWNER || '.' || d.REFERENCED_NAME AS CALLS " +
    "FROM ALL_DEPENDENCIES d JOIN ALL_TAB_PRIVS p ON p.TABLE_SCHEMA = d.OWNER AND p.TABLE_NAME = d.NAME " +
    "LEFT JOIN ALL_USERS u ON u.USERNAME = d.OWNER " +
    "LEFT JOIN ALL_SYNONYMS s ON s.OWNER = d.REFERENCED_OWNER AND s.SYNONYM_NAME = d.REFERENCED_NAME AND s.DB_LINK IS NULL " +
    "LEFT JOIN ALL_USERS su ON su.USERNAME = s.TABLE_OWNER " +
    "WHERE d.TYPE = 'VIEW' AND (d.REFERENCED_TYPE NOT IN ('TABLE', 'VIEW', 'SYNONYM', 'MATERIALIZED VIEW', 'NON-EXISTENT') " +
    "OR d.REFERENCED_TYPE = 'SYNONYM' AND NVL(su.ORACLE_MAINTAINED, 'N') <> 'Y' AND NOT EXISTS (SELECT 1 FROM ALL_OBJECTS o " +
    "WHERE o.OWNER = s.TABLE_OWNER AND o.OBJECT_NAME = s.TABLE_NAME AND o.OBJECT_TYPE IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW'))) " +
    `AND ${NOT_ORACLE_MAINTAINED} AND ${SESSION_GRANTEES} ORDER BY 2, 3, 1, 4`,
  sequences:
    "SELECT p.GRANTEE, p.TABLE_SCHEMA AS OWNER, p.TABLE_NAME AS NAME, 'N' AS OWNED " +
    "FROM ALL_TAB_PRIVS p LEFT JOIN ALL_USERS u ON u.USERNAME = p.TABLE_SCHEMA " +
    `WHERE p.TYPE = 'SEQUENCE' AND ${NOT_ORACLE_MAINTAINED} AND ${SESSION_GRANTEES} ` +
    "UNION ALL SELECT USER, USER, SEQUENCE_NAME, 'Y' FROM USER_SEQUENCES ORDER BY 2, 3, 1",
  reach:
    "SELECT p.GRANTEE, p.TABLE_SCHEMA AS OWNER, p.TABLE_NAME AS NAME, p.PRIVILEGE, p.TYPE AS OBJECT_TYPE " +
    "FROM ALL_TAB_PRIVS p " +
    `WHERE ((p.PRIVILEGE = 'EXECUTE' AND p.TABLE_NAME IN (${REACHING_PACKAGES.map((name) => `'${name}'`).join(", ")})) ` +
    `OR p.TYPE = 'DIRECTORY') AND ${SESSION_GRANTEES} ORDER BY 3, 4, 1`,
  systemPrivileges:
    "SELECT p.PRIVILEGE, g.GRANTEE FROM SESSION_PRIVS p LEFT JOIN " +
    "(SELECT USERNAME AS GRANTEE, PRIVILEGE FROM USER_SYS_PRIVS UNION ALL SELECT ROLE, PRIVILEGE FROM ROLE_SYS_PRIVS) g " +
    "ON g.PRIVILEGE = p.PRIVILEGE WHERE p.PRIVILEGE <> 'CREATE SESSION' ORDER BY 1, 2",
  links: "SELECT OWNER, DB_LINK FROM ALL_DB_LINKS ORDER BY 1, 2",
});

/** At most this many statements are listed in a refusal; the rest are counted. */
const LISTED_STATEMENTS = 20;

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

function viewsFinding(rows: Rows): Finding | null {
  if (rows.length === 0) return null;
  return {
    what: "it may read a view that calls code a schema Oracle does not maintain owns, which a SELECT runs with its owner's rights",
    statements: rows.map((row) => {
      const [to, owner, name] = text(row, "ALL_DEPENDENCIES", "GRANTEE", "OWNER", "NAME", "CALLS");
      return `REVOKE ALL ON ${quoted(owner)}.${quoted(name)} FROM ${grantee(to)}`;
    }),
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
      const to = typeof row.GRANTEE === "string" && row.GRANTEE !== "" ? grantee(row.GRANTEE) : "<its grantee>";
      return `REVOKE ${privilege} FROM ${to}`;
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
    viewsFinding(await read(AGENT_PRINCIPAL_STATEMENTS.views)),
    sequencesFinding(await read(AGENT_PRINCIPAL_STATEMENTS.sequences)),
    reachFinding(await read(AGENT_PRINCIPAL_STATEMENTS.reach)),
    systemPrivilegesFinding(await read(AGENT_PRINCIPAL_STATEMENTS.systemPrivileges)),
    linksFinding(await read(AGENT_PRINCIPAL_STATEMENTS.links)),
  ].filter((found): found is Finding => found !== null);
  if (findings.length === 0) return;

  const statements = findings.flatMap((found) => found.statements);
  const listed = statements.slice(0, LISTED_STATEMENTS).join("; ");
  const rest = statements.length - LISTED_STATEMENTS;
  throw new ExecutionProfileError(
    `The agent read-only execution profile refuses the Oracle user ${user}: ${findings
      .map((found) => found.what)
      .join("; ")}. Run, as an administrator: ${listed}${rest > 0 ? `; and ${rest} more` : ""}.`,
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
