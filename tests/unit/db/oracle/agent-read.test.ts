/**
 * The Oracle agent read path's pure parts: the principal check run before every statement, as the agent user, and the
 * reading of an answer against the budget. The provider wiring is in tests/integration/db/oracle-provider.test.ts.
 *
 * The check refuses the profile, fail closed, unless the user is set READ ONLY and nothing it can reach runs outside
 * that. "Oracle's" means an object ALL_OBJECTS shows the user as Oracle-maintained and linked from the root container,
 * never a schema's flag, since an administrator can create objects in SYSTEM, nor the object's flag alone, since an
 * object made under `_oracle_script` or a replaced local one keeps it; for what a grant may execute, a local one is
 * admitted by its kind: no role that is not enabled at sign-in, no EXECUTE on code that is not
 * Oracle's, no view that is not Oracle's that calls code or reads a view it cannot examine, no such view that is not
 * valid, no virtual column on what it reads that is not Oracle's, no row-level security policy anywhere in the
 * database whose function is not Oracle's, and no fine-grained auditing policy anywhere with an audit condition or a
 * handler that is not Oracle's, read from two catalogs the user must be able to read, no sequence that is not Oracle's
 * and none of its own, no network or server-file package and no directory, no system privilege but CREATE SESSION,
 * and no database link. Every dictionary view is named SYS.<view>, so nothing in the user's schema and no PUBLIC
 * synonym stands in for it. Each refusal names the statements that would lift it, or the policies it found.
 */
import { describe, expect, test } from "bun:test";
import { ExecutionProfileError, QueryError } from "@/lib/db/errors";
import {
  AGENT_PRINCIPAL_STATEMENTS,
  agentDeadlineRefusal,
  assertAgentColumnTypes,
  readAgentAnswer,
  verifyAgentPrincipal,
} from "@/lib/db/providers/sql/oracle/agent-read";
import type { QueryResult } from "@/lib/db/types";

type Rows = readonly Record<string, unknown>[];
type Statement = keyof typeof AGENT_PRINCIPAL_STATEMENTS;

/** Oracle maintains the row `alias` and it is linked from the root container, not local to the database. */
function linked(alias: string): string {
  return `NVL(${alias}.ORACLE_MAINTAINED, 'N') = 'Y' AND NVL(${alias}.SHARING, 'NONE') <> 'NONE'`;
}

/** Some ALL_OBJECTS row matches `where`, over the alias x, and every one that does is linked. */
function allLinked(...readings: string[]): string {
  const exists = readings.map((where) => `EXISTS (SELECT 1 FROM SYS.ALL_OBJECTS x WHERE ${where})`);
  const local = readings.map(
    (where) => `NOT EXISTS (SELECT 1 FROM SYS.ALL_OBJECTS x WHERE ${where} AND NOT (${linked("x")}))`,
  );
  return `(${exists.join(" OR ")}) AND ${local.join(" AND ")}`;
}

/**
 * 'Y' when the object row `alias` is Oracle's own: linked. An administrator can replace a local object Oracle marked,
 * or create one under `_oracle_script`, and the flag stays (measured).
 */
function oracles(alias: string): string {
  return `CASE WHEN ${linked(alias)} THEN 'Y' ELSE 'N' END`;
}

/**
 * For what a grant may execute: linked, or local but marked and of a kind that cannot run a function (a domain, a job
 * class, a consumer group), an operator whose every binding's function and implementation type are linked, or an
 * indextype whose implementation type is.
 */
function oraclesByKind(alias: string): string {
  const fn = "REPLACE(b.FUNCTION_NAME, '\"')";
  const part = (n: number) => `REGEXP_SUBSTR(${fn}, '[^.]+', 1, ${n})`;
  const readings = [
    `x.OWNER = ${part(1)} AND x.OBJECT_NAME = ${part(2)}`,
    `x.OWNER = b.OWNER AND x.OBJECT_NAME = ${part(1)} AND ${part(3)} IS NULL`,
  ];
  const binding = `b.OWNER = ${alias}.OWNER AND b.OPERATOR_NAME = ${alias}.OBJECT_NAME`;
  const indextype = `i.OWNER = ${alias}.OWNER AND i.INDEXTYPE_NAME = ${alias}.OBJECT_NAME`;
  // Searched CASE stops at the first true WHEN, so the subqueries run only for a local operator or indextype.
  return (
    `CASE WHEN ${oracles(alias)} = 'Y' THEN 'Y' ` +
    `WHEN NVL(${alias}.ORACLE_MAINTAINED, 'N') <> 'Y' THEN 'N' ` +
    `WHEN ${alias}.OBJECT_TYPE IN ('DOMAIN', 'JOB CLASS', 'CONSUMER GROUP') THEN 'Y' ` +
    `WHEN ${alias}.OBJECT_TYPE = 'OPERATOR' AND EXISTS (SELECT 1 FROM SYS.ALL_OPBINDINGS b WHERE ${binding}) ` +
    `AND NOT EXISTS (SELECT 1 FROM SYS.ALL_OPBINDINGS b WHERE ${binding} AND NOT (${allLinked(...readings)} ` +
    "AND (b.IMPLEMENTATION_TYPE IS NULL OR " +
    `${allLinked("x.OWNER = b.IMPLEMENTATION_TYPE_SCHEMA AND x.OBJECT_NAME = b.IMPLEMENTATION_TYPE")}))) THEN 'Y' ` +
    `WHEN ${alias}.OBJECT_TYPE = 'INDEXTYPE' AND EXISTS (SELECT 1 FROM SYS.ALL_INDEXTYPES i WHERE ${indextype}) ` +
    `AND NOT EXISTS (SELECT 1 FROM SYS.ALL_INDEXTYPES i WHERE ${indextype} AND NOT (` +
    `${allLinked("x.OWNER = i.IMPLEMENTATION_SCHEMA AND x.OBJECT_NAME = i.IMPLEMENTATION_NAME")})) THEN 'Y' ELSE 'N' END`
  );
}

/** The session's grantees and the objects the check starts from, spelled out here rather than imported. */
const SESSION = "(p.GRANTEE IN (USER, 'PUBLIC') OR p.GRANTEE IN (SELECT ROLE FROM SYS.SESSION_ROLES))";
const ROOTS =
  "WITH r AS (SELECT p.GRANTEE, p.TABLE_SCHEMA AS OWNER, p.TABLE_NAME AS NAME FROM SYS.ALL_TAB_PRIVS p " +
  "JOIN SYS.ALL_OBJECTS o ON o.OWNER = p.TABLE_SCHEMA AND o.OBJECT_NAME = p.TABLE_NAME " +
  `WHERE NVL(p.TYPE, '-') <> 'USER' AND ${oracles("o")} <> 'Y' ` +
  `AND ${SESSION} ` +
  "UNION SELECT NULL, USER, OBJECT_NAME FROM SYS.USER_OBJECTS WHERE OBJECT_TYPE IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW'))";

/**
 * An object not proven Oracle's own: ALL_OBJECTS shows the user no object of that owner and name, or one of them is
 * not Oracle's (see `oracles`). The schema's flag is no proof, since an administrator can create objects in SYSTEM or
 * SYS.
 */
function notOracles(owner: string, name: string, proof: (alias: string) => string = oracles): string {
  return (
    `NVL((SELECT MIN(${proof("m")}) FROM SYS.ALL_OBJECTS m ` +
    `WHERE m.OWNER = ${owner} AND m.OBJECT_NAME = ${name}), 'N') <> 'Y'`
  );
}

/** Every check statement, whole: a change of any join, filter or view the check reads fails the test that pins it. */
const EXPECTED_STATEMENTS: Readonly<Record<Statement, string>> = {
  readOnly: "SELECT USERNAME, READ_ONLY FROM SYS.USER_USERS",
  roles:
    "SELECT USERNAME AS GRANTEE, GRANTED_ROLE FROM SYS.USER_ROLE_PRIVS WHERE NVL(DEFAULT_ROLE, 'NO') <> 'YES' " +
    "ORDER BY 2, 1",
  units:
    "SELECT p.GRANTEE, p.TABLE_SCHEMA AS OWNER, p.TABLE_NAME AS NAME, " +
    "NVL((SELECT MIN(k.OBJECT_TYPE) FROM SYS.ALL_OBJECTS k WHERE k.OWNER = p.TABLE_SCHEMA " +
    "AND k.OBJECT_NAME = p.TABLE_NAME AND k.OBJECT_TYPE = 'EVALUATION CONTEXT'), p.TYPE) AS OBJECT_TYPE " +
    "FROM SYS.ALL_TAB_PRIVS p WHERE p.PRIVILEGE = 'EXECUTE' AND NVL(p.TYPE, '-') <> 'DIRECTORY' " +
    `AND ${notOracles("p.TABLE_SCHEMA", "p.TABLE_NAME", oraclesByKind)} AND ${SESSION} ORDER BY 2, 3, 1`,
  views:
    `${ROOTS} SELECT p.GRANTEE, d.OWNER, d.NAME, d.REFERENCED_OWNER || '.' || d.REFERENCED_NAME AS CALLS ` +
    "FROM SYS.ALL_DEPENDENCIES d JOIN r p ON p.OWNER = d.OWNER AND p.NAME = d.NAME " +
    "LEFT JOIN SYS.ALL_SYNONYMS s ON s.OWNER = d.REFERENCED_OWNER AND s.SYNONYM_NAME = d.REFERENCED_NAME " +
    "AND s.DB_LINK IS NULL " +
    "WHERE d.TYPE = 'VIEW' AND (d.REFERENCED_TYPE NOT IN ('TABLE', 'VIEW', 'SYNONYM', 'MATERIALIZED VIEW', 'NON-EXISTENT') " +
    `OR d.REFERENCED_TYPE = 'VIEW' AND ${notOracles("d.REFERENCED_OWNER", "d.REFERENCED_NAME")} ` +
    "AND NOT EXISTS (SELECT 1 FROM r v WHERE v.OWNER = d.REFERENCED_OWNER AND v.NAME = d.REFERENCED_NAME) " +
    `OR d.REFERENCED_TYPE = 'SYNONYM' AND ${notOracles("s.TABLE_OWNER", "s.TABLE_NAME")} ` +
    "AND NOT EXISTS (SELECT 1 FROM r o WHERE o.OWNER = s.TABLE_OWNER AND o.NAME = s.TABLE_NAME)) ORDER BY 2, 3, 1, 4",
  invalidViews:
    `${ROOTS} SELECT p.GRANTEE, o.OWNER, o.OBJECT_NAME AS NAME, o.STATUS ` +
    "FROM SYS.ALL_OBJECTS o JOIN r p ON p.OWNER = o.OWNER AND p.NAME = o.OBJECT_NAME " +
    "WHERE o.OBJECT_TYPE = 'VIEW' AND o.STATUS <> 'VALID' ORDER BY 2, 3, 1",
  virtualColumns:
    "SELECT p.GRANTEE, c.OWNER, c.TABLE_NAME AS NAME, c.COLUMN_NAME FROM SYS.ALL_TAB_COLS c " +
    `LEFT JOIN SYS.ALL_TAB_PRIVS p ON p.TABLE_SCHEMA = c.OWNER AND p.TABLE_NAME = c.TABLE_NAME AND ${SESSION} ` +
    `WHERE c.VIRTUAL_COLUMN = 'YES' AND ${notOracles("c.OWNER", "c.TABLE_NAME")} ORDER BY 2, 3, 1, 4`,
  policies:
    "SELECT a.OBJECT_OWNER AS OWNER, a.OBJECT_NAME AS NAME, a.POLICY_NAME AS POLICY FROM SYS.DBA_POLICIES a " +
    `WHERE ${notOracles("a.PF_OWNER", "NVL(a.PACKAGE, a.FUNCTION)")} ORDER BY 1, 2, 3`,
  auditPolicies:
    "SELECT f.OBJECT_SCHEMA AS OWNER, f.OBJECT_NAME AS NAME, f.POLICY_NAME AS POLICY FROM SYS.DBA_AUDIT_POLICIES f " +
    "WHERE f.POLICY_TEXT IS NOT NULL OR (f.PF_PACKAGE IS NOT NULL OR f.PF_FUNCTION IS NOT NULL) " +
    `AND ${notOracles("f.PF_SCHEMA", "NVL(f.PF_PACKAGE, f.PF_FUNCTION)")} ORDER BY 1, 2, 3`,
  sequences:
    "SELECT p.GRANTEE, p.TABLE_SCHEMA AS OWNER, p.TABLE_NAME AS NAME, 'N' AS OWNED FROM SYS.ALL_TAB_PRIVS p " +
    `WHERE p.TYPE = 'SEQUENCE' AND ${notOracles("p.TABLE_SCHEMA", "p.TABLE_NAME")} AND ${SESSION} ` +
    "UNION ALL SELECT USER, USER, SEQUENCE_NAME, 'Y' FROM SYS.USER_SEQUENCES ORDER BY 2, 3, 1",
  reach:
    "SELECT p.GRANTEE, p.TABLE_SCHEMA AS OWNER, p.TABLE_NAME AS NAME, p.PRIVILEGE, p.TYPE AS OBJECT_TYPE " +
    "FROM SYS.ALL_TAB_PRIVS p WHERE ((p.PRIVILEGE = 'EXECUTE' AND p.TABLE_NAME IN ('UTL_HTTP', 'UTL_TCP', " +
    "'UTL_SMTP', 'UTL_FILE', 'UTL_INADDR', 'HTTPURITYPE', 'DBMS_LDAP', 'DBMS_SCHEDULER', 'DBMS_PIPE', " +
    `'DBMS_XSLPROCESSOR')) OR p.TYPE = 'DIRECTORY') AND ${SESSION} ORDER BY 3, 4, 1`,
  systemPrivileges:
    "SELECT p.PRIVILEGE, g.GRANTEE FROM SYS.SESSION_PRIVS p LEFT JOIN " +
    "(SELECT USERNAME AS GRANTEE, PRIVILEGE FROM SYS.USER_SYS_PRIVS UNION ALL SELECT ROLE, PRIVILEGE FROM SYS.ROLE_SYS_PRIVS) g " +
    "ON g.PRIVILEGE = p.PRIVILEGE WHERE p.PRIVILEGE <> 'CREATE SESSION' ORDER BY 1, 2",
  links: "SELECT OWNER, DB_LINK FROM SYS.ALL_DB_LINKS ORDER BY 1, 2",
};

/** The dictionary views `sql` names without a schema: an ALL_, USER_, DBA_, SESSION_ or ROLE_ name not after a dot. */
function unqualifiedDictionaryViews(sql: string): string[] {
  return [...sql.matchAll(/(?<![\w.$#])(?:ALL|USER|DBA|SESSION|ROLE)_[A-Z_$#]+/g)].map((match) => match[0]);
}

/** What each FROM and JOIN of `sql` reads, a subquery left out. */
function readSources(sql: string): string[] {
  return [...sql.matchAll(/\b(?:FROM|JOIN)\s+([A-Za-z_$#][\w$#.]*)/g)].map((match) => match[1]);
}

/** A principal that passes every item: APP_RO set READ ONLY, holding nothing but CREATE SESSION. */
const CLEAN: Readonly<Record<Statement, Rows>> = {
  readOnly: [{ USERNAME: "APP_RO", READ_ONLY: "YES" }],
  roles: [],
  units: [],
  views: [],
  invalidViews: [],
  virtualColumns: [],
  policies: [],
  auditPolicies: [],
  sequences: [],
  reach: [],
  systemPrivileges: [],
  links: [],
};

/** A reader that answers each check statement from `answers` over the clean principal, and records what it sent. */
function reader(answers: Partial<Record<Statement, Rows | Error>> = {}) {
  const sent: string[] = [];
  const read = async (sql: string): Promise<Rows> => {
    sent.push(sql);
    const name = (Object.keys(AGENT_PRINCIPAL_STATEMENTS) as Statement[]).find(
      (key) => AGENT_PRINCIPAL_STATEMENTS[key] === sql,
    );
    if (name === undefined) throw new Error(`unexpected statement: ${sql}`);
    const answer = answers[name] ?? CLEAN[name];
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { read, sent };
}

async function refusal(answers: Partial<Record<Statement, Rows | Error>>): Promise<ExecutionProfileError> {
  try {
    await verifyAgentPrincipal(reader(answers).read);
  } catch (error) {
    if (error instanceof ExecutionProfileError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

describe("verifyAgentPrincipal", () => {
  test("admits a READ ONLY user that holds nothing beyond CREATE SESSION, sending every check once, in order", async () => {
    const { read, sent } = reader();
    await verifyAgentPrincipal(read);
    // The policy and auditing catalogs are read whatever the user reaches: the rule over them is database wide.
    expect(sent).toEqual(Object.values(AGENT_PRINCIPAL_STATEMENTS));
  });

  test("each check statement is exactly the text below, so a changed join, filter or view is a failing test", () => {
    expect<Record<string, string>>({ ...AGENT_PRINCIPAL_STATEMENTS }).toEqual(EXPECTED_STATEMENTS);
  });

  test("every reading of an object's Oracle-maintained flag is the one shared proof, never the flag alone", () => {
    // A local object Oracle marked keeps the flag when an administrator replaces it, and an object created under
    // `_oracle_script` is marked; SHARING reads NONE on both, where Oracle's own objects in a PDB are linked.
    const flag = /\b\w+\.ORACLE_MAINTAINED\b/g;
    let proofs = 0;
    for (const [name, sql] of Object.entries(AGENT_PRINCIPAL_STATEMENTS)) {
      const bare = [oraclesByKind("m"), oracles("o"), oracles("m")].reduce(
        (left, proof) => left.split(proof).join(""),
        sql,
      );
      expect(bare.match(flag) ?? [], name).toEqual([]);
      proofs += sql.length - bare.length;
    }
    expect(proofs).toBeGreaterThan(0);
  });

  test("everywhere an object is Oracle's only when linked, never by the flag alone", () => {
    expect(oracles("m")).toBe(
      "CASE WHEN NVL(m.ORACLE_MAINTAINED, 'N') = 'Y' AND NVL(m.SHARING, 'NONE') <> 'NONE' THEN 'Y' ELSE 'N' END",
    );
    // Only the EXECUTE grants admit a local object Oracle marked by its kind; the other checks hold every object to the
    // link, which on a fresh database refuses nothing more there (measured).
    for (const [name, sql] of Object.entries(AGENT_PRINCIPAL_STATEMENTS)) {
      expect(sql.includes(oraclesByKind("m")), name).toBe(name === "units");
    }
  });

  test("an executable local object is Oracle's only when of a kind that runs no function, or by what it runs", () => {
    const proof = oraclesByKind("m");
    expect(proof.startsWith(`CASE WHEN ${oracles("m")} = 'Y' THEN 'Y' `)).toBe(true);
    // Measured: a domain's check, display, order and default expressions refuse a user function (ORA-00904,
    // ORA-04044), and a job class or a consumer group names no code. An evaluation context names a function that
    // DBMS_RULE, which PUBLIC may execute, runs, so it is not among them.
    expect(proof).toContain("m.OBJECT_TYPE IN ('DOMAIN', 'JOB CLASS', 'CONSUMER GROUP')");
    expect(proof).not.toContain("EVALUATION CONTEXT");
    // An operator by every binding, its function and its implementation type; an indextype by its implementation type.
    expect(proof).toContain("FROM SYS.ALL_OPBINDINGS b WHERE b.OWNER = m.OWNER AND b.OPERATOR_NAME = m.OBJECT_NAME");
    expect(proof).toContain("x.OWNER = b.IMPLEMENTATION_TYPE_SCHEMA AND x.OBJECT_NAME = b.IMPLEMENTATION_TYPE");
    expect(proof).toContain("FROM SYS.ALL_INDEXTYPES i WHERE i.OWNER = m.OWNER AND i.INDEXTYPE_NAME = m.OBJECT_NAME");
    expect(proof).toContain("x.OWNER = i.IMPLEMENTATION_SCHEMA AND x.OBJECT_NAME = i.IMPLEMENTATION_NAME");
  });

  test("names every dictionary view SYS.<view>, so an object or synonym of the same name cannot stand in for it", () => {
    // An unqualified name resolves first to an object or a private synonym in the agent user's own schema, then to a
    // PUBLIC synonym, so an administrator's synonym APP_RO.DBA_POLICIES over an empty table would hide every policy.
    for (const [name, sql] of Object.entries(AGENT_PRINCIPAL_STATEMENTS)) {
      expect(unqualifiedDictionaryViews(sql), name).toEqual([]);
      for (const source of readSources(sql))
        expect(
          ["SYS.", "r"].some((ok) => source.startsWith(ok)),
          `${name}: ${source}`,
        ).toBe(true);
    }
  });

  test("the qualification test catches an unqualified view, in a FROM, a JOIN or a subquery", () => {
    expect(unqualifiedDictionaryViews("SELECT 1 FROM DBA_POLICIES a JOIN SYS.ALL_USERS u ON 1 = 1")).toEqual([
      "DBA_POLICIES",
    ]);
    expect(
      unqualifiedDictionaryViews(
        "SELECT 1 FROM SYS.ALL_TAB_PRIVS p WHERE p.GRANTEE IN (SELECT ROLE FROM SESSION_ROLES)",
      ),
    ).toEqual(["SESSION_ROLES"]);
    expect(readSources("SELECT 1 FROM USER_USERS JOIN r ON 1 = 1")).toEqual(["USER_USERS", "r"]);
  });

  test("every check statement is one query with no terminator and no bind", () => {
    for (const sql of Object.values(AGENT_PRINCIPAL_STATEMENTS)) {
      expect(sql.startsWith("SELECT ") || sql.startsWith("WITH r AS (SELECT ")).toBe(true);
      expect(sql).not.toContain(";");
      expect(sql).not.toContain(":");
    }
  });

  describe("the user is set READ ONLY", () => {
    test("refuses a user whose USER_USERS.READ_ONLY reads NO, naming ALTER USER ... READ ONLY", async () => {
      const error = await refusal({ readOnly: [{ USERNAME: "APP_RW", READ_ONLY: "NO" }] });
      expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(error.message).toContain("APP_RW is not set READ ONLY");
      expect(error.message).toContain('Run, as an administrator: ALTER USER "APP_RW" READ ONLY.');
    });

    test("refuses a server whose USER_USERS has no READ_ONLY column (ORA-00904), one older than 23ai", async () => {
      const error = await refusal({
        readOnly: new Error('ORA-00904: "READ_ONLY": invalid identifier'),
      });
      expect(error.reasonCode).toBe("PROFILE_UNSUPPORTED_TARGET");
      expect(error.message).toContain("Oracle Database 23ai or later");
      expect(error.message).toContain("ORA-00904");
    });

    test("an other failure of the read leaves as it came, refusing the call", async () => {
      const failure = new Error("ORA-03113: end-of-file on communication channel");
      await expect(verifyAgentPrincipal(reader({ readOnly: failure }).read)).rejects.toBe(failure);
    });

    test.each([
      ["no row", []],
      ["two rows", [CLEAN.readOnly[0], CLEAN.readOnly[0]]],
      ["a missing column", [{ USERNAME: "APP_RO" }]],
      ["a number for the name", [{ USERNAME: 7, READ_ONLY: "YES" }]],
    ] as const)("refuses an unreadable answer (%s), since the boundary is then unproven", async (_label, rows) => {
      const error = await refusal({ readOnly: rows });
      expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(error.message).toContain("could not be read");
    });
  });

  describe("every granted role is enabled at sign-in", () => {
    test("refuses a role that is not a default role, since SET ROLE could enable grants this check cannot see", async () => {
      const error = await refusal({ roles: [{ GRANTEE: "APP_RO", GRANTED_ROLE: "RO_ROLE" }] });
      expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(error.message).toContain("a role that is not enabled at sign-in");
      expect(error.message).toContain('REVOKE "RO_ROLE" FROM "APP_RO"');
    });

    test("names PUBLIC bare when the role is granted to PUBLIC", async () => {
      const error = await refusal({ roles: [{ GRANTEE: "PUBLIC", GRANTED_ROLE: "R1" }] });
      expect(error.message).toContain('REVOKE "R1" FROM PUBLIC');
    });
  });

  describe("no EXECUTE on code Oracle does not maintain", () => {
    test("refuses a granted definer's-rights function, naming the revoke", async () => {
      const error = await refusal({
        units: [{ GRANTEE: "APP_RO", OWNER: "APP_OWNER", NAME: "BUMP", OBJECT_TYPE: "FUNCTION" }],
      });
      expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(error.message).toContain("EXECUTE on code Oracle does not maintain, which runs with its owner's rights");
      expect(error.message).toContain('REVOKE EXECUTE ON "APP_OWNER"."BUMP" FROM "APP_RO"');
    });

    test("names DBMS_RULE_ADM's revoke for an evaluation context, which a REVOKE statement cannot take", async () => {
      // Measured: REVOKE EXECUTE ON SYS.STREAMS$_EVALUATION_CONTEXT FROM PUBLIC answers ORA-04042, and ALL_TAB_PRIVS
      // types the grant UNKNOWN, so the kind is read from ALL_OBJECTS.
      const error = await refusal({
        units: [
          { GRANTEE: "PUBLIC", OWNER: "SYS", NAME: "STREAMS$_EVALUATION_CONTEXT", OBJECT_TYPE: "EVALUATION CONTEXT" },
          { GRANTEE: "O'NE", OWNER: "APP_OWNER", NAME: "E'C", OBJECT_TYPE: "EVALUATION CONTEXT" },
          { GRANTEE: "PUBLIC", OWNER: "SYS", NAME: "EMAIL_D" },
        ],
      });
      expect(error.message).toContain(
        "BEGIN DBMS_RULE_ADM.REVOKE_OBJECT_PRIVILEGE(DBMS_RULE_ADM.EXECUTE_ON_EVALUATION_CONTEXT, " +
          `'"SYS"."STREAMS$_EVALUATION_CONTEXT"', 'PUBLIC'); END;`,
      );
      expect(error.message).toContain(
        `DBMS_RULE_ADM.EXECUTE_ON_EVALUATION_CONTEXT, '"APP_OWNER"."E''C"', 'O''NE'); END;`,
      );
      expect(error.message).not.toContain('REVOKE EXECUTE ON "SYS"."STREAMS$_EVALUATION_CONTEXT"');
      expect(error.message).toContain('REVOKE EXECUTE ON "SYS"."EMAIL_D" FROM PUBLIC');
    });

    test("refuses the grant through an enabled role and through PUBLIC alike", async () => {
      const error = await refusal({
        units: [
          { GRANTEE: "RO_ROLE", OWNER: "APP_OWNER", NAME: "PKG", OBJECT_TYPE: "PACKAGE" },
          { GRANTEE: "PUBLIC", OWNER: "APP_OWNER", NAME: "T_OBJ", OBJECT_TYPE: "TYPE" },
        ],
      });
      expect(error.message).toContain('REVOKE EXECUTE ON "APP_OWNER"."PKG" FROM "RO_ROLE"');
      expect(error.message).toContain('REVOKE EXECUTE ON "APP_OWNER"."T_OBJ" FROM PUBLIC');
    });

    test("the check reads every grantee the session holds: the user, its enabled roles and PUBLIC", () => {
      const sql = AGENT_PRINCIPAL_STATEMENTS.units;
      expect(sql).toContain("ALL_TAB_PRIVS");
      expect(sql).toContain("SESSION_ROLES");
      expect(sql).toContain("'PUBLIC'");
      // Code is Oracle's only when ALL_OBJECTS shows the user every object of its name as Oracle-maintained: a schema
      // Oracle maintains proves nothing, since an administrator can create a function in SYSTEM, and an object the
      // user cannot see counts as not Oracle's, fail closed.
      expect(sql).toContain(notOracles("p.TABLE_SCHEMA", "p.TABLE_NAME", oraclesByKind));
      expect(sql).not.toContain("ALL_USERS");
      // A directory's EXECUTE is the reach check's, which names the directory revoke.
      expect(sql).toContain("NVL(p.TYPE, '-') <> 'DIRECTORY'");
    });
  });

  describe("no granted view Oracle does not maintain that calls code", () => {
    test("refuses a granted view over a definer's-rights function, which a plain SELECT runs", async () => {
      const error = await refusal({
        views: [{ GRANTEE: "APP_RO", OWNER: "APP_OWNER", NAME: "NEXT_VIEW", CALLS: "APP_OWNER.NEXT_ID" }],
      });
      expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(error.message).toContain("it may read a view Oracle does not maintain that calls code");
      expect(error.message).toContain('REVOKE ALL ON "APP_OWNER"."NEXT_VIEW" FROM "APP_RO"');
    });

    test("the check reads the view's own dependencies, leaving tables and views out", () => {
      expect(AGENT_PRINCIPAL_STATEMENTS.views).toContain("ALL_DEPENDENCIES");
      expect(AGENT_PRINCIPAL_STATEMENTS.views).toContain(
        "d.REFERENCED_TYPE NOT IN ('TABLE', 'VIEW', 'SYNONYM', 'MATERIALIZED VIEW', 'NON-EXISTENT')",
      );
    });

    test("a synonym the view names is admitted only when it resolves to a table or view, or to an Oracle-maintained object", () => {
      // A view that calls a definer's-rights function through a synonym lists only the synonym in ALL_DEPENDENCIES,
      // and ALL_SYNONYMS does not show the agent user another schema's private synonym, so one it cannot resolve to a
      // table or view, or to an object of a schema Oracle maintains (PUBLIC.DUAL, PUBLIC.DBMS_LOB), is refused.
      const sql = AGENT_PRINCIPAL_STATEMENTS.views;
      expect(sql).toContain(
        "LEFT JOIN SYS.ALL_SYNONYMS s ON s.OWNER = d.REFERENCED_OWNER AND s.SYNONYM_NAME = d.REFERENCED_NAME AND s.DB_LINK IS NULL",
      );
      expect(sql).toContain(
        `d.REFERENCED_TYPE = 'SYNONYM' AND ${notOracles("s.TABLE_OWNER", "s.TABLE_NAME")} AND NOT EXISTS (SELECT 1 FROM r o ` +
          "WHERE o.OWNER = s.TABLE_OWNER AND o.NAME = s.TABLE_NAME)",
      );
    });

    test("refuses a granted view over a synonym it cannot resolve, naming the view's revoke", async () => {
      const error = await refusal({
        views: [{ GRANTEE: "APP_RO", OWNER: "APP_OWNER", NAME: "SYN_VIEW", CALLS: "APP_OWNER.NEXT_SYN" }],
      });
      expect(error.message).toContain('REVOKE ALL ON "APP_OWNER"."SYN_VIEW" FROM "APP_RO"');
    });
  });

  describe("no granted view that reads a view the user cannot examine", () => {
    test("the check admits an inner view Oracle does not maintain only when it examines that view itself", () => {
      // A view reached only through another view lists the outer view's dependency on the inner one, never the inner
      // view's own calls. The check reads a view's dependencies only for the objects it starts from, those granted to
      // the session's grantees or owned by the user, so an inner view is admitted only when it is one of them; that
      // ALL_OBJECTS shows it is not enough.
      const sql = AGENT_PRINCIPAL_STATEMENTS.views;
      // An inner view in a schema Oracle maintains is admitted unexamined only when ALL_OBJECTS shows the user it as
      // Oracle-maintained: an administrator's view in SYSTEM is not Oracle's.
      expect(sql).toContain(
        `OR d.REFERENCED_TYPE = 'VIEW' AND ${notOracles("d.REFERENCED_OWNER", "d.REFERENCED_NAME")} AND NOT EXISTS (SELECT 1 FROM r v ` +
          "WHERE v.OWNER = d.REFERENCED_OWNER AND v.NAME = d.REFERENCED_NAME)",
      );
      expect(sql).toContain("FROM SYS.ALL_DEPENDENCIES d JOIN r p ON p.OWNER = d.OWNER AND p.NAME = d.NAME");
      expect(sql).not.toContain("FROM SYS.ALL_OBJECTS v");
    });

    test("the objects the check starts from are those granted to the session's grantees and those the user owns", () => {
      const sql = AGENT_PRINCIPAL_STATEMENTS.views;
      expect(sql).toContain(
        "WITH r AS (SELECT p.GRANTEE, p.TABLE_SCHEMA AS OWNER, p.TABLE_NAME AS NAME FROM SYS.ALL_TAB_PRIVS p",
      );
      // A grant ALL_OBJECTS does not show the user the object for, such as DEBUG on a view, shows it none of the
      // object's dependencies either (measured), so such an object is not one the check examines.
      expect(sql).toContain("JOIN SYS.ALL_OBJECTS o ON o.OWNER = p.TABLE_SCHEMA AND o.OBJECT_NAME = p.TABLE_NAME");
      expect(sql).toContain("NVL(p.TYPE, '-') <> 'USER'");
      expect(sql).toContain("SESSION_ROLES");
      expect(sql).toContain(
        "UNION SELECT NULL, USER, OBJECT_NAME FROM SYS.USER_OBJECTS WHERE OBJECT_TYPE IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW'))",
      );
      for (const name of ["views", "invalidViews"] as const) {
        expect(AGENT_PRINCIPAL_STATEMENTS[name].startsWith(`${ROOTS} SELECT `)).toBe(true);
      }
    });

    test("refuses a view the user owns that calls code, naming the move a revoke cannot make", async () => {
      const error = await refusal({
        views: [{ GRANTEE: null, OWNER: "APP_RO", NAME: "MINE_V", CALLS: "APP_OWNER.NEXT_ID" }],
      });
      expect(error.message).toContain('move "APP_RO"."MINE_V" out of the agent user\'s own schema');
    });

    test("refuses a granted view over a view it cannot examine, naming the outer view's revoke", async () => {
      const error = await refusal({
        views: [{ GRANTEE: "APP_RO", OWNER: "APP_OWNER", NAME: "OUTER_V", CALLS: "APP_OWNER.INNER_V" }],
      });
      expect(error.message).toContain('REVOKE ALL ON "APP_OWNER"."OUTER_V" FROM "APP_RO"');
    });
  });

  describe("no granted view that is not valid", () => {
    test("refuses a view whose dependencies are stale, naming the revoke rather than a compile", async () => {
      // An invalid view lists the dependencies it had before, and the user's SELECT compiles it and runs what it calls
      // now (measured: a dropped column re-added as a virtual column over a function advanced its sequence).
      const error = await refusal({
        invalidViews: [{ GRANTEE: "APP_RO", OWNER: "APP_OWNER", NAME: "V4", STATUS: "INVALID" }],
      });
      expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(error.message).toContain("it may read a view that is not valid");
      expect(error.message).toContain('REVOKE ALL ON "APP_OWNER"."V4" FROM "APP_RO"');
      expect(error.message).not.toContain("COMPILE");
    });

    test("the check reads the status of every granted view Oracle does not maintain", () => {
      const sql = AGENT_PRINCIPAL_STATEMENTS.invalidViews;
      expect(sql).toContain("FROM SYS.ALL_OBJECTS o JOIN r p ON p.OWNER = o.OWNER AND p.NAME = o.OBJECT_NAME");
      expect(sql).toContain("o.OBJECT_TYPE = 'VIEW' AND o.STATUS <> 'VALID'");
      // The objects it starts from are those ALL_OBJECTS does not mark Oracle-maintained, an administrator's object in
      // SYSTEM included.
      expect(sql).toContain(`${oracles("o")} <> 'Y'`);
      expect(sql).toContain("SESSION_ROLES");
    });
  });

  describe("no virtual column on what it reads that Oracle does not maintain", () => {
    test("refuses a virtual column, hidden ones included, naming the revoke on its table", async () => {
      const error = await refusal({
        virtualColumns: [
          { GRANTEE: "APP_RO", OWNER: "APP_OWNER", NAME: "VT", COLUMN_NAME: "N" },
          { GRANTEE: "RO_ROLE", OWNER: "APP_OWNER", NAME: "FBI", COLUMN_NAME: "SYS_NC00003$" },
        ],
      });
      expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(error.message).toContain("a virtual column");
      expect(error.message).toContain("grant a view that leaves it out");
      expect(error.message).toContain('REVOKE ALL ON "APP_OWNER"."VT" FROM "APP_RO"');
      expect(error.message).toContain('REVOKE ALL ON "APP_OWNER"."FBI" FROM "RO_ROLE"');
    });

    test("names one revoke per table and grantee, however many virtual columns it has", async () => {
      const error = await refusal({
        virtualColumns: [
          { GRANTEE: "APP_RO", OWNER: "APP_OWNER", NAME: "VT", COLUMN_NAME: "N" },
          { GRANTEE: "APP_RO", OWNER: "APP_OWNER", NAME: "VT", COLUMN_NAME: "U" },
        ],
      });
      expect(error.message.split('REVOKE ALL ON "APP_OWNER"."VT" FROM "APP_RO"').length).toBe(2);
    });

    test("a table the agent user owns is refused naming its move, since no revoke reaches the user's own object", async () => {
      const error = await refusal({
        virtualColumns: [{ GRANTEE: null, OWNER: "APP_RO", NAME: "MINE", COLUMN_NAME: "N" }],
      });
      expect(error.message).toContain('move "APP_RO"."MINE" out of the agent user\'s own schema');
      expect(error.message).not.toContain("<its grantee>");
    });

    test("a table of another schema read through no grant it can name is still refused, its grantee left open", async () => {
      const error = await refusal({
        virtualColumns: [{ GRANTEE: null, OWNER: "APP_OWNER", NAME: "VT", COLUMN_NAME: "N" }],
      });
      expect(error.message).toContain('REVOKE ALL ON "APP_OWNER"."VT" FROM <its grantee>');
    });

    test("the check reads every virtual column ALL_TAB_COLS lists, hidden ones included, on objects of such schemas", () => {
      const sql = AGENT_PRINCIPAL_STATEMENTS.virtualColumns;
      expect(sql).toContain("FROM SYS.ALL_TAB_COLS c");
      expect(sql).toContain("c.VIRTUAL_COLUMN = 'YES'");
      expect(sql).not.toContain("HIDDEN_COLUMN");
      expect(sql).toContain(notOracles("c.OWNER", "c.TABLE_NAME"));
      expect(sql).toContain("LEFT JOIN SYS.ALL_TAB_PRIVS p");
    });
  });

  describe("no row-level security policy anywhere in the database whose function Oracle does not maintain", () => {
    test("refuses a policy on any object, an Oracle-maintained one included, naming the policy and no revoke", async () => {
      // Oracle runs the policy function with its owner's rights on every read of what it guards, by any user, and a
      // table, view or synonym reached through a view the check cannot follow, or Oracle's own SYSTEM.HELP, is read
      // without ALL_POLICIES listing the policy to the user (measured), so no revoke of the user's grants lifts it.
      const error = await refusal({
        policies: [
          { OWNER: "APP_OWNER", NAME: "PT", POLICY: "PT_P" },
          { OWNER: "SYSTEM", NAME: "HELP", POLICY: "HELP_P" },
        ],
      });
      expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(error.message).toBe(
        "The agent read-only execution profile refuses the Oracle user APP_RO: the database holds a row-level security " +
          "policy whose function is not one Oracle maintains, which Oracle runs with its owner's rights " +
          "when any user reads what it guards, so agent mode is not offered on this database while it exists: " +
          '"APP_OWNER"."PT" policy "PT_P", "SYSTEM"."HELP" policy "HELP_P".',
      );
    });

    test("a policy function is Oracle's only when ALL_OBJECTS shows the user it as Oracle-maintained, whatever schema owns it", () => {
      // The fresh database's XDB policies call XDB.DBMS_XDBZ0, which PUBLIC may execute and ALL_OBJECTS marks
      // Oracle-maintained; an administrator's function in SYSTEM, a schema Oracle maintains, is not marked, and ran
      // with SYSTEM's rights for a READ ONLY user reading SYSTEM.HELP (measured), so it is refused like any other.
      const sql = AGENT_PRINCIPAL_STATEMENTS.policies;
      expect(sql).toContain(`WHERE ${notOracles("a.PF_OWNER", "NVL(a.PACKAGE, a.FUNCTION)")}`);
      expect(sql).not.toContain("ALL_USERS");
    });

    test("refuses, fail closed, a user that may not read SYS.DBA_POLICIES, naming the grant only SYS may run", async () => {
      const error = await refusal({
        policies: new Error('ORA-00942: table or view "SYS"."DBA_POLICIES" does not exist'),
      });
      expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(error.message).toBe(
        "The agent read-only execution profile refuses the Oracle user APP_RO: the check cannot read SYS.DBA_POLICIES, " +
          "which lists the row-level security policies of the database. Run, as an administrator: " +
          'GRANT SELECT ON SYS.DBA_POLICIES TO "APP_RO" (as SYS).',
      );
    });

    test("an other failure of the read leaves as it came", async () => {
      const failure = new Error("ORA-03113: end-of-file on communication channel");
      await expect(verifyAgentPrincipal(reader({ policies: failure }).read)).rejects.toBe(failure);
    });

    test("names at most ten policies and counts the rest", async () => {
      const policies = Array.from({ length: 12 }, (_, i) => ({ OWNER: "APP_OWNER", NAME: `T${i}`, POLICY: "P" }));
      const error = await refusal({ policies });
      expect(error.message).toContain('"APP_OWNER"."T9" policy "P"');
      expect(error.message).not.toContain('"T10"');
      expect(error.message).toContain('"T9" policy "P", and 2 more.');
    });
  });

  describe("no fine-grained auditing policy anywhere with an audit condition or a handler Oracle does not maintain", () => {
    test("refuses a policy with an audit condition, which can call a function, or with such a handler", async () => {
      // An audit condition is evaluated on a read and may call a function, which ran with its owner's rights for an
      // admitted READ ONLY user (measured); it is not parsed to prove it built-in, so every one is refused.
      const error = await refusal({
        auditPolicies: [
          { OWNER: "APP_OWNER", NAME: "AUDITED", POLICY: "AC_P" },
          { OWNER: "SYSTEM", NAME: "SQLPLUS_PRODUCT_PROFILE", POLICY: "H_P" },
        ],
      });
      expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(error.message).toBe(
        "The agent read-only execution profile refuses the Oracle user APP_RO: the database holds a fine-grained " +
          "auditing policy with an audit condition, which Oracle evaluates when any user reads what it audits and which " +
          "can call a function, or with a handler that is not one Oracle maintains, which Oracle runs with its " +
          "owner's rights, so agent mode is not offered on this database while it exists: " +
          '"APP_OWNER"."AUDITED" policy "AC_P", "SYSTEM"."SQLPLUS_PRODUCT_PROFILE" policy "H_P".',
      );
    });

    test("refuses every audit condition, and a handler unless ALL_OBJECTS shows the user it as Oracle-maintained", () => {
      const sql = AGENT_PRINCIPAL_STATEMENTS.auditPolicies;
      expect(sql).toContain(
        "WHERE f.POLICY_TEXT IS NOT NULL OR (f.PF_PACKAGE IS NOT NULL OR f.PF_FUNCTION IS NOT NULL) " +
          `AND ${notOracles("f.PF_SCHEMA", "NVL(f.PF_PACKAGE, f.PF_FUNCTION)")} ORDER BY`,
      );
      expect(sql).not.toContain("ALL_USERS");
    });

    test("refuses, fail closed, a user that may not read SYS.DBA_AUDIT_POLICIES, naming the grant", async () => {
      const error = await refusal({
        auditPolicies: new Error('ORA-00942: table or view "SYS"."DBA_AUDIT_POLICIES" does not exist'),
      });
      expect(error.message).toBe(
        "The agent read-only execution profile refuses the Oracle user APP_RO: the check cannot read " +
          "SYS.DBA_AUDIT_POLICIES, which lists the fine-grained auditing policies of the database. Run, as an " +
          'administrator: GRANT SELECT ON SYS.DBA_AUDIT_POLICIES TO "APP_RO" (as SYS).',
      );
    });

    test("names both grants when neither catalog is readable, beside every other finding", async () => {
      const error = await refusal({
        readOnly: [{ USERNAME: "APP_RO", READ_ONLY: "NO" }],
        policies: new Error("ORA-00942: table or view does not exist"),
        auditPolicies: new Error("ORA-00942: table or view does not exist"),
      });
      expect(error.message).toContain(
        'Run, as an administrator: ALTER USER "APP_RO" READ ONLY; GRANT SELECT ON SYS.DBA_POLICIES TO "APP_RO" (as SYS); ' +
          'GRANT SELECT ON SYS.DBA_AUDIT_POLICIES TO "APP_RO" (as SYS).',
      );
    });

    test("an other failure of the read leaves as it came", async () => {
      const failure = new Error("ORA-03113: end-of-file on communication channel");
      await expect(verifyAgentPrincipal(reader({ auditPolicies: failure }).read)).rejects.toBe(failure);
    });
  });

  describe("no sequence Oracle does not maintain, and none of its own", () => {
    test("refuses a granted sequence, which NEXTVAL advances under READ ONLY", async () => {
      const error = await refusal({
        sequences: [{ GRANTEE: "APP_RO", OWNER: "APP_OWNER", NAME: "SEQ1", OWNED: "N" }],
      });
      expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(error.message).toContain("a sequence NEXTVAL would advance");
      expect(error.message).toContain('REVOKE ALL ON "APP_OWNER"."SEQ1" FROM "APP_RO"');
    });

    test("refuses a sequence the agent user owns, naming its drop", async () => {
      const error = await refusal({
        sequences: [{ GRANTEE: "APP_RO", OWNER: "APP_RO", NAME: "MINE", OWNED: "Y" }],
      });
      expect(error.message).toContain('DROP SEQUENCE "APP_RO"."MINE"');
    });
  });

  describe("no package that reaches the network or the server's files, and no directory", () => {
    test.each([
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
    ])("the check names %s", (name) => {
      expect(AGENT_PRINCIPAL_STATEMENTS.reach).toContain(`'${name}'`);
    });

    test("refuses PUBLIC's default EXECUTE on UTL_HTTP, naming the revoke from PUBLIC", async () => {
      const error = await refusal({
        reach: [{ GRANTEE: "PUBLIC", OWNER: "SYS", NAME: "UTL_HTTP", PRIVILEGE: "EXECUTE", OBJECT_TYPE: "PACKAGE" }],
      });
      expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(error.message).toContain("a package that reaches the network or the server's files");
      expect(error.message).toContain('REVOKE EXECUTE ON "SYS"."UTL_HTTP" FROM PUBLIC');
    });

    test("refuses a directory grant, which BFILENAME reads server files through, naming the directory revoke", async () => {
      const error = await refusal({
        reach: [{ GRANTEE: "APP_RO", OWNER: "SYS", NAME: "DATA_DIR", PRIVILEGE: "READ", OBJECT_TYPE: "DIRECTORY" }],
      });
      expect(error.message).toContain('REVOKE READ ON DIRECTORY "DATA_DIR" FROM "APP_RO"');
    });
  });

  describe("no system privilege beyond CREATE SESSION", () => {
    test("refuses ALTER SYSTEM, which runs under READ ONLY, naming its grantee", async () => {
      const error = await refusal({ systemPrivileges: [{ PRIVILEGE: "ALTER SYSTEM", GRANTEE: "APP_RO_SYS" }] });
      expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(error.message).toContain("a system privilege beyond CREATE SESSION");
      expect(error.message).toContain('REVOKE ALTER SYSTEM FROM "APP_RO_SYS"');
    });

    test("a privilege the session holds through a grantee it cannot name is still refused, with the grantee left open", async () => {
      const error = await refusal({ systemPrivileges: [{ PRIVILEGE: "SELECT ANY TABLE", GRANTEE: null }] });
      expect(error.message).toContain("REVOKE SELECT ANY TABLE FROM <its grantee>");
    });

    test("the check reads SESSION_PRIVS, what the session holds from every source, and spares CREATE SESSION", () => {
      expect(AGENT_PRINCIPAL_STATEMENTS.systemPrivileges).toContain("FROM SYS.SESSION_PRIVS p");
      expect(AGENT_PRINCIPAL_STATEMENTS.systemPrivileges).toContain("p.PRIVILEGE <> 'CREATE SESSION'");
    });
  });

  describe("no database link", () => {
    test("refuses a PUBLIC link, which reaches another database under its stored credential", async () => {
      const error = await refusal({ links: [{ OWNER: "PUBLIC", DB_LINK: "LOOPLINK" }] });
      expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(error.message).toContain("a database link");
      expect(error.message).toContain('DROP PUBLIC DATABASE LINK "LOOPLINK"');
    });

    test("refuses a private link the agent user owns too, naming the drop its owner can run only while READ WRITE", async () => {
      // Only a private link's owner can drop it, and the owner is READ ONLY, which refuses the DROP with ORA-28194.
      const error = await refusal({
        links: [
          { OWNER: "APP_RO", DB_LINK: "MINE.EXAMPLE" },
          { OWNER: "APP_RO", DB_LINK: "OTHER.EXAMPLE" },
        ],
      });
      expect(error.message).toContain(
        'ALTER USER "APP_RO" READ WRITE; DROP DATABASE LINK "MINE.EXAMPLE" (as APP_RO); ' +
          'DROP DATABASE LINK "OTHER.EXAMPLE" (as APP_RO); ALTER USER "APP_RO" READ ONLY',
      );
    });
  });

  test("names every finding of every check in one refusal", async () => {
    const error = await refusal({
      readOnly: [{ USERNAME: "APP_RO", READ_ONLY: "NO" }],
      units: [{ GRANTEE: "APP_RO", OWNER: "APP_OWNER", NAME: "BUMP", OBJECT_TYPE: "FUNCTION" }],
      links: [{ OWNER: "PUBLIC", DB_LINK: "LOOPLINK" }],
    });
    expect(error.message).toContain('ALTER USER "APP_RO" READ ONLY');
    expect(error.message).toContain('REVOKE EXECUTE ON "APP_OWNER"."BUMP" FROM "APP_RO"');
    expect(error.message).toContain('DROP PUBLIC DATABASE LINK "LOOPLINK"');
  });

  test("lists at most twenty statements and counts the rest", async () => {
    const units = Array.from({ length: 25 }, (_, i) => ({
      GRANTEE: "PUBLIC",
      OWNER: "APP_OWNER",
      NAME: `F${i}`,
      OBJECT_TYPE: "FUNCTION",
    }));
    const error = await refusal({ units });
    expect(error.message).toContain('"F19"');
    expect(error.message).not.toContain('"F20"');
    expect(error.message).toContain("and 5 more");
  });

  test.each([
    ["roles", [{ GRANTEE: "APP_RO" }]],
    ["units", [{ GRANTEE: "APP_RO", OWNER: "A", NAME: 3, OBJECT_TYPE: "FUNCTION" }]],
    ["views", [{ GRANTEE: "APP_RO", OWNER: "A", NAME: "V" }]],
    ["invalidViews", [{ GRANTEE: "APP_RO", OWNER: "A", STATUS: "INVALID" }]],
    ["virtualColumns", [{ GRANTEE: "APP_RO", OWNER: "A", NAME: "T" }]],
    ["policies", [{ OWNER: "A", NAME: "T" }]],
    ["auditPolicies", [{ OWNER: "A", POLICY: "P" }]],
    ["sequences", [{ GRANTEE: "APP_RO", OWNER: "A", NAME: "S" }]],
    ["reach", [{ GRANTEE: "APP_RO", OWNER: "SYS", NAME: "UTL_TCP", OBJECT_TYPE: "PACKAGE" }]],
    ["systemPrivileges", [{ GRANTEE: "APP_RO" }]],
    ["links", [{ OWNER: "PUBLIC" }]],
  ] as const)("refuses an unreadable %s row rather than skipping it", async (check, rows) => {
    const error = await refusal({ [check]: rows });
    expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
    expect(error.message).toContain("could not be read");
  });
});

describe("assertAgentColumnTypes", () => {
  const BFILE = { num: 2020, name: "DB_TYPE_BFILE" };
  const OBJECT = { num: 2023, name: "DB_TYPE_OBJECT" };
  const VARCHAR = { num: 1, name: "DB_TYPE_VARCHAR" };

  test("admits columns of no refused type, and an answer with no columns", () => {
    expect(() => assertAgentColumnTypes([{ name: "ID", dbType: VARCHAR }], [BFILE], "SELECT 1")).not.toThrow();
    expect(() => assertAgentColumnTypes(undefined, [BFILE], "BEGIN NULL; END;")).not.toThrow();
  });

  test("refuses a BFILE column, whose locator reads a server file, naming the column", () => {
    try {
      assertAgentColumnTypes([{ name: "F", dbType: BFILE, dbTypeName: "BFILE" }], [BFILE, OBJECT], "SELECT f FROM t");
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(QueryError);
      expect((error as Error).message).toBe(
        "Read-only execution refused column F of type BFILE: the agent reads scalar and LOB values only",
      );
    }
  });
});

describe("readAgentAnswer", () => {
  const BUDGET = { statementTimeoutMs: 2_500, maxResultRows: 2, maxResultBytes: 40 };
  const result = (rows: Record<string, unknown>[]): QueryResult => ({
    rows,
    fields: ["ID"],
    rowCount: rows.length,
    executionTime: 3,
  });

  test("answers a result within both budgets as it came", () => {
    const within = result([{ ID: 1 }, { ID: 2 }]);
    expect(readAgentAnswer(within, BUDGET, "SELECT id FROM t")).toBe(within);
  });

  test("refuses the extra row maxRows + 1 let through, in the shared row sentence", () => {
    expect(() => readAgentAnswer(result([{ ID: 1 }, { ID: 2 }, { ID: 3 }]), BUDGET, "SELECT id FROM t")).toThrow(
      "Read-only execution exceeded the row budget: 3 rows > 2 allowed",
    );
  });

  test("counts a LOB fetched as a string against the byte budget, in the shared byte sentence", () => {
    expect(() => readAgentAnswer(result([{ DOC: "x".repeat(60) }]), BUDGET, "SELECT doc FROM t")).toThrow(
      "Read-only execution exceeded the byte budget: 72 bytes > 40 allowed",
    );
  });
});

describe("agentDeadlineRefusal", () => {
  test("reads the driver's call timeout as the shared time refusal", () => {
    const refused = agentDeadlineRefusal(
      new Error("NJS-123: call timeout of 2500 ms exceeded"),
      { statementTimeoutMs: 2_500, maxResultRows: 1, maxResultBytes: 1 },
      "SELECT 1 FROM DUAL",
    );
    expect(refused).toBeInstanceOf(QueryError);
    expect(refused?.message).toBe("Read-only execution exceeded the time budget: no answer within 2500ms");
  });

  test("leaves every other failure to the provider's own mapping", () => {
    expect(
      agentDeadlineRefusal(
        new Error("ORA-28194: Can perform read operations only"),
        { statementTimeoutMs: 1, maxResultRows: 1, maxResultBytes: 1 },
        "x",
      ),
    ).toBeNull();
  });
});
