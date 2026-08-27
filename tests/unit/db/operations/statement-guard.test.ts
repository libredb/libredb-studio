import { describe, test, expect } from "bun:test";
import {
  agentPlanExecutionSqlInput,
  agentReadSqlInput,
  inspectAgentStatement,
} from "@/lib/db/operations/statement-guard";

/**
 * The guard is defense in depth, so both directions matter and neither is a
 * "nice to have": a miss lets hostile text reach the database-native boundary
 * (which is what actually refuses it), while a false positive refuses a
 * legitimate agent read. The cases below are therefore chosen to be
 * unanswerable by substring matching in EITHER direction — every legitimate
 * fixture mentions a write keyword somewhere the statement does not execute it.
 */

describe("inspectAgentStatement — legitimate bounded reads", () => {
  test.each([
    ["a plain select", "SELECT 1"],
    ["lowercase and unaligned whitespace", "  select\n\tid\nfrom t\nwhere id = 1  "],
    ["a read-only CTE", "WITH recent AS (SELECT id FROM t) SELECT * FROM recent"],
    ["a recursive CTE", "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 5) SELECT * FROM c"],
    ["a VALUES list", "VALUES (1), (2)"],
    ["PostgreSQL TABLE shorthand", "TABLE inventory"],
    ["plan inspection", "EXPLAIN SELECT 1"],
    ["a leading block comment", "/* daily report */ SELECT 1"],
    ["a leading line comment", "-- daily report\nSELECT 1"],
    ["a trailing terminator", "SELECT 1;"],
    ["repeated trailing terminators and trivia", "SELECT 1 ; ; -- done\n"],
  ])("allows %s", (_label, sql) => {
    expect(inspectAgentStatement(sql)).toBeNull();
  });

  test.each([
    ["a write keyword inside a string literal", "SELECT 'insert into t values (1)' AS note"],
    ["a write keyword inside a quoted identifier", 'SELECT "delete" FROM audit'],
    ["a write keyword as part of a longer identifier", "SELECT insert_count, updated_at FROM insert_log"],
    ["a write keyword inside a line comment", "SELECT id FROM t -- delete from t\n"],
    ["a write keyword inside a block comment", "SELECT id FROM t /* update t set x = 1 */"],
    ["a semicolon inside a string literal", "SELECT ';' AS semi, 'a;b' AS pair"],
  ])("allows a read that merely mentions %s", (_label, sql) => {
    expect(inspectAgentStatement(sql)).toBeNull();
  });
});

describe("inspectAgentStatement — text the engines read differently", () => {
  test.each([
    // `$tag$…$tag$` is a literal in PostgreSQL and a BIND PARAMETER followed by
    // ordinary code in SQLite, so a `;` written inside one really terminates the
    // statement there. Reading it as a literal would admit a second statement.
    ["a dollar-quoted body", "SELECT $tag$ drop table t $tag$ AS body"],
    ["a semicolon inside a dollar-quoted body", "SELECT $x$ ; ATTACH DATABASE '/tmp/x.db' AS y $x$"],
    // `#` starts a comment in MySQL/ClickHouse, is an operator in PostgreSQL and
    // prefixes a bind variable in SQLite — the same disagreement about where the
    // statement ends.
    ["a hash run", "SELECT 1 #; DROP TABLE t"],
    ["a hash operator", "SELECT flags # 5 AS x FROM t"],
    ["a dollar-quoted code block", "DO $$ BEGIN PERFORM 1; END $$"],
  ])("denies %s rather than picking a dialect", (_label, sql) => {
    expect(inspectAgentStatement(sql)).toBe("DIALECT_AMBIGUOUS_TEXT");
  });
});

describe("inspectAgentStatement — multi-statement input", () => {
  test.each([
    ["a smuggled write", "SELECT 1; INSERT INTO t VALUES (1)"],
    ["no whitespace after the terminator", "SELECT 1;SELECT 2"],
    ["transaction control between reads", "SELECT 1; COMMIT; SELECT 2"],
    ["a literal after the terminator", "SELECT 1; 'tail'"],
    // A quoted name after the terminator is a token too, and it is the only
    // other span kind this walk can reach: `scanStatementShape` reads with
    // `DEFAULT_SQL_GRAMMAR`, whose brackets are quoted names rather than
    // subscripts, and a dollar-quoted run is refused a step earlier as text the
    // engines read differently. Measured 2026-08-27: without the
    // `quoted-identifier` reading these two answer `null` - the guard's own
    // one-statement rule bypassed by a quote.
    ["a quoted name after the terminator", 'SELECT 1; "tail"'],
    ["a backtick name after the terminator", "SELECT 1; `tail`"],
    ["a bracketed name after the terminator", "SELECT 1; [tail]"],
    ["a leading terminator", "; SELECT 1"],
    ["a comment hiding the terminator's tail", "SELECT 1; -- x\nDROP TABLE t"],
  ])("denies %s", (_label, sql) => {
    expect(inspectAgentStatement(sql)).toBe("MULTIPLE_STATEMENTS");
  });
});

describe("inspectAgentStatement — statements that are not bounded reads", () => {
  test.each([
    ["a bare write", "INSERT INTO t VALUES (1)"],
    ["a schema change", "CREATE TABLE injected (id INTEGER)"],
    ["a mutating pragma", "PRAGMA journal_mode = WAL"],
    ["a pragma read (still not a read statement)", "PRAGMA query_only"],
    ["an attach", "ATTACH DATABASE '/etc/passwd' AS stolen"],
    ["a detach", "DETACH DATABASE stolen"],
    ["a vacuum that writes elsewhere", "VACUUM INTO '/tmp/copy.db'"],
    ["a server-side file write", "COPY (SELECT 1) TO '/tmp/copy.txt'"],
    ["a server-side program execution", "COPY (SELECT 1) TO PROGRAM 'sh -c id'"],
    ["a write hidden behind a block comment", "/* SELECT */ INSERT INTO t VALUES (1)"],
    ["a write hidden behind a line comment", "-- SELECT 1\nDROP TABLE t"],
    // The string-bodied form: the dollar-quoted one is refused a step earlier,
    // as text the engines read differently (see the dialect group).
    ["an anonymous code block", "DO 'BEGIN PERFORM 1; END'"],
    // A CTE list is a preamble: `readOperativeKeyword` walks it and answers the
    // keyword that actually operates the statement, so a write AFTER the list is
    // reported here rather than as a keyword hidden inside a read.
    ["a write after the CTE list", "WITH src AS (SELECT 1 AS id) UPDATE t SET id = src.id FROM src"],
  ])("denies %s", (_label, sql) => {
    expect(inspectAgentStatement(sql)).toBe("NON_READ_STATEMENT");
  });
});

describe("inspectAgentStatement — side effects hidden inside a read-shaped statement", () => {
  test.each([
    [
      "a data-modifying CTE",
      "WITH moved AS (INSERT INTO archive SELECT * FROM t RETURNING id) SELECT count(*) FROM moved",
    ],
    [
      "a data-modifying CTE behind a read-only one",
      "WITH a AS (SELECT 1 AS x), b AS (DELETE FROM t RETURNING id) SELECT * FROM a JOIN b ON true",
    ],
    ["SQLite extension loading through a function call", "SELECT load_extension('/tmp/evil.so')"],
    ["a pragma function used as a setter", "SELECT * FROM pragma_query_only(0)"],
    ["a locking read that takes row locks", "SELECT id FROM t FOR UPDATE"],
    ["a merge inside a CTE", "WITH m AS (MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE) SELECT 1"],
    // A SELECT-headed statement that WRITES: PostgreSQL's SELECT INTO creates a
    // table, and MySQL's INTO OUTFILE writes a server-side file.
    ["a table-creating SELECT INTO", "SELECT * INTO stolen FROM t"],
    ["a file-writing SELECT", "SELECT v FROM t INTO OUTFILE '/tmp/stolen.csv'"],
  ])("denies %s", (_label, sql) => {
    expect(inspectAgentStatement(sql)).toBe("SIDE_EFFECT_KEYWORD");
  });
});

describe("inspectAgentStatement — text with no readable statement", () => {
  test.each([
    ["only a line comment", "-- nothing here\n"],
    ["only a block comment", "/* nothing here */"],
    ["only whitespace", "   \n\t"],
    ["a CTE list that cannot be read", "WITH t AS NOT LAZY (SELECT 1) SELECT 2"],
  ])("denies %s", (_label, sql) => {
    expect(inspectAgentStatement(sql)).toBe("NO_STATEMENT");
  });

  test.each([
    ["an unterminated string literal", "SELECT 'oops"],
    ["an unterminated block comment", "SELECT 1 /* oops"],
  ])("denies %s as undeterminable text", (_label, sql) => {
    expect(inspectAgentStatement(sql)).toBe("UNDETERMINABLE_TEXT");
  });
});

describe("inspectAgentStatement — plan inspection versus plan execution", () => {
  test("refuses EXPLAIN ANALYZE unless plan execution is explicitly permitted", () => {
    expect(inspectAgentStatement("EXPLAIN ANALYZE SELECT 1")).toBe("SIDE_EFFECT_KEYWORD");
    expect(inspectAgentStatement("EXPLAIN (ANALYZE, BUFFERS) SELECT 1")).toBe("SIDE_EFFECT_KEYWORD");
    // Obfuscation of the same request must not slip past the inspect variant.
    expect(inspectAgentStatement("EXPLAIN /* plan */ ANALYZE SELECT 1")).toBe("SIDE_EFFECT_KEYWORD");
  });

  test("refuses the British spelling too — PostgreSQL accepts ANALYSE and it executes", () => {
    // One spelling is not the keyword: `EXPLAIN ANALYSE` runs the statement on
    // PostgreSQL exactly as ANALYZE does, so a guard that knew only one spelling
    // would launder plan EXECUTION through the risk-class-0, approval-free
    // plan-INSPECTION descriptor.
    expect(inspectAgentStatement("EXPLAIN ANALYSE SELECT 1")).toBe("SIDE_EFFECT_KEYWORD");
    expect(inspectAgentStatement("EXPLAIN (ANALYSE, BUFFERS) SELECT 1")).toBe("SIDE_EFFECT_KEYWORD");
    expect(inspectAgentStatement("EXPLAIN ANALYSE SELECT 1", { allowPlanExecution: true })).toBeNull();
  });

  test("permits ANALYZE only for the plan-execution variant, and still refuses a write it carries", () => {
    expect(inspectAgentStatement("EXPLAIN ANALYZE SELECT 1", { allowPlanExecution: true })).toBeNull();
    expect(
      inspectAgentStatement("EXPLAIN ANALYZE WITH w AS (INSERT INTO t VALUES (1) RETURNING id) SELECT * FROM w", {
        allowPlanExecution: true,
      }),
    ).toBe("SIDE_EFFECT_KEYWORD");
    // A bare ANALYZE is a statistics write in both engines, not a plan read.
    expect(inspectAgentStatement("ANALYZE t", { allowPlanExecution: true })).toBe("NON_READ_STATEMENT");
  });
});

describe("agent SQL input schemas", () => {
  test("the read schema accepts exactly one non-empty bounded read and nothing else", () => {
    expect(agentReadSqlInput.safeParse({ sql: "SELECT 1" }).success).toBe(true);
    for (const input of [{}, { sql: "" }, { sql: 1 }, { sql: "SELECT 1", extra: true }, null, "SELECT 1", []]) {
      expect(agentReadSqlInput.safeParse(input).success).toBe(false);
    }
  });

  test("the read schema reports the violation as the issue message, keyed to the sql field", () => {
    const parsed = agentReadSqlInput.safeParse({ sql: "SELECT 1; DROP TABLE t" });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("MULTIPLE_STATEMENTS");
      expect(parsed.error.issues[0]?.path).toEqual(["sql"]);
    }
  });

  test("only the plan-execution schema admits EXPLAIN ANALYZE", () => {
    expect(agentReadSqlInput.safeParse({ sql: "EXPLAIN ANALYZE SELECT 1" }).success).toBe(false);
    expect(agentPlanExecutionSqlInput.safeParse({ sql: "EXPLAIN ANALYZE SELECT 1" }).success).toBe(true);
    expect(agentPlanExecutionSqlInput.safeParse({ sql: "DROP TABLE t" }).success).toBe(false);
  });
});
