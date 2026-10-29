/**
 * The Oracle agent read path's pure parts: the principal check run at first use, as the agent user, and the reading of
 * an answer against the budget. The provider wiring is in tests/integration/db/oracle-provider.test.ts.
 *
 * The check refuses the profile, fail closed, unless the user is set READ ONLY and nothing it can reach runs outside
 * that: no role that is not enabled at sign-in, no EXECUTE on code owned by a schema Oracle does not maintain, no view
 * of such a schema that calls such code, no sequence of such a schema and none of its own, no network or server-file package and no directory, no system
 * privilege but CREATE SESSION, and no database link. Each refusal names the statements that would lift it.
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

/** A principal that passes every item: APP_RO set READ ONLY, holding nothing but CREATE SESSION. */
const CLEAN: Readonly<Record<Statement, Rows>> = {
  readOnly: [{ USERNAME: "APP_RO", READ_ONLY: "YES" }],
  roles: [],
  units: [],
  views: [],
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
    expect(sent).toEqual(Object.values(AGENT_PRINCIPAL_STATEMENTS));
  });

  test("every check statement is one SELECT with no terminator and no bind", () => {
    for (const sql of Object.values(AGENT_PRINCIPAL_STATEMENTS)) {
      expect(sql.startsWith("SELECT ")).toBe(true);
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

  describe("no EXECUTE on code owned by a schema Oracle does not maintain", () => {
    test("refuses a granted definer's-rights function, naming the revoke", async () => {
      const error = await refusal({
        units: [{ GRANTEE: "APP_RO", OWNER: "APP_OWNER", NAME: "BUMP", OBJECT_TYPE: "FUNCTION" }],
      });
      expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(error.message).toContain("EXECUTE on code a schema Oracle does not maintain owns");
      expect(error.message).toContain('REVOKE EXECUTE ON "APP_OWNER"."BUMP" FROM "APP_RO"');
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
      // An owner ALL_USERS does not list counts as one Oracle does not maintain, fail closed.
      expect(sql).toContain("NVL(u.ORACLE_MAINTAINED, 'N') <> 'Y'");
    });
  });

  describe("no granted view that calls code a schema Oracle does not maintain owns", () => {
    test("refuses a granted view over a definer's-rights function, which a plain SELECT runs", async () => {
      const error = await refusal({
        views: [{ GRANTEE: "APP_RO", OWNER: "APP_OWNER", NAME: "NEXT_VIEW", CALLS: "APP_OWNER.NEXT_ID" }],
      });
      expect(error.reasonCode).toBe("PROFILE_PRIVILEGES_TOO_BROAD");
      expect(error.message).toContain("it may read a view that calls code a schema Oracle does not maintain owns");
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
        "LEFT JOIN ALL_SYNONYMS s ON s.OWNER = d.REFERENCED_OWNER AND s.SYNONYM_NAME = d.REFERENCED_NAME AND s.DB_LINK IS NULL",
      );
      expect(sql).toContain("LEFT JOIN ALL_USERS su ON su.USERNAME = s.TABLE_OWNER");
      expect(sql).toContain(
        "d.REFERENCED_TYPE = 'SYNONYM' AND NVL(su.ORACLE_MAINTAINED, 'N') <> 'Y' AND NOT EXISTS (SELECT 1 FROM ALL_OBJECTS o " +
          "WHERE o.OWNER = s.TABLE_OWNER AND o.OBJECT_NAME = s.TABLE_NAME AND o.OBJECT_TYPE IN ('TABLE', 'VIEW', 'MATERIALIZED VIEW'))",
      );
    });

    test("refuses a granted view over a synonym it cannot resolve, naming the view's revoke", async () => {
      const error = await refusal({
        views: [{ GRANTEE: "APP_RO", OWNER: "APP_OWNER", NAME: "SYN_VIEW", CALLS: "APP_OWNER.NEXT_SYN" }],
      });
      expect(error.message).toContain('REVOKE ALL ON "APP_OWNER"."SYN_VIEW" FROM "APP_RO"');
    });
  });

  describe("no sequence of a schema Oracle does not maintain, and none of its own", () => {
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
      expect(AGENT_PRINCIPAL_STATEMENTS.systemPrivileges).toContain("FROM SESSION_PRIVS p");
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

  test("names every finding of every check in one refusal, so one round of revokes lifts it", async () => {
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
