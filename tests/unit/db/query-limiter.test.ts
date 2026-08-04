import { describe, test, expect } from "bun:test";
import {
  analyzeQuery,
  applyQueryLimit,
  hasQueryLimit,
  isSelectQuery,
  type ParsedQueryInfo,
} from "@/lib/db/utils/query-limiter";

// ─── analyzeQuery ───────────────────────────────────────────────────────────

describe("analyzeQuery", () => {
  // ── Query type detection ────────────────────────────────────────────────

  describe("type detection", () => {
    test("detects SELECT", () => {
      expect(analyzeQuery("SELECT * FROM users").type).toBe("SELECT");
    });

    test("detects SELECT (lowercase)", () => {
      expect(analyzeQuery("select id from t").type).toBe("SELECT");
    });

    test("detects INSERT", () => {
      expect(analyzeQuery("INSERT INTO users VALUES (1, 'a')").type).toBe("INSERT");
    });

    test("detects UPDATE", () => {
      expect(analyzeQuery("UPDATE users SET name = 'x' WHERE id = 1").type).toBe("UPDATE");
    });

    test("detects DELETE", () => {
      expect(analyzeQuery("DELETE FROM users WHERE id = 1").type).toBe("DELETE");
    });

    test("detects CREATE as DDL", () => {
      expect(analyzeQuery("CREATE TABLE foo (id int)").type).toBe("DDL");
    });

    test("detects ALTER as DDL", () => {
      expect(analyzeQuery("ALTER TABLE foo ADD col int").type).toBe("DDL");
    });

    test("detects DROP as DDL", () => {
      expect(analyzeQuery("DROP TABLE foo").type).toBe("DDL");
    });

    test("detects TRUNCATE as DDL", () => {
      expect(analyzeQuery("TRUNCATE TABLE foo").type).toBe("DDL");
    });

    test("detects WITH...SELECT (CTE) as SELECT", () => {
      const sql = "WITH cte AS (SELECT 1) SELECT * FROM cte";
      const info = analyzeQuery(sql);
      expect(info.type).toBe("SELECT");
      expect(info.hasCTE).toBe(true);
    });

    test("detects unknown statement as OTHER", () => {
      expect(analyzeQuery("EXPLAIN SELECT * FROM t").type).toBe("OTHER");
    });

    test("detects GRANT as OTHER", () => {
      expect(analyzeQuery("GRANT SELECT ON t TO user").type).toBe("OTHER");
    });
  });

  // ── LIMIT detection ─────────────────────────────────────────────────────

  describe("LIMIT detection", () => {
    test("detects no LIMIT", () => {
      const info = analyzeQuery("SELECT * FROM users");
      expect(info.hasLimit).toBe(false);
      expect(info.existingLimit).toBeUndefined();
    });

    test("detects LIMIT N", () => {
      const info = analyzeQuery("SELECT * FROM users LIMIT 100");
      expect(info.hasLimit).toBe(true);
      expect(info.existingLimit).toBe(100);
    });

    test("detects LIMIT N OFFSET M", () => {
      const info = analyzeQuery("SELECT * FROM users LIMIT 50 OFFSET 10");
      expect(info.hasLimit).toBe(true);
      expect(info.existingLimit).toBe(50);
      expect(info.hasOffset).toBe(true);
      expect(info.existingOffset).toBe(10);
    });

    test("detects MySQL LIMIT offset, count style", () => {
      const info = analyzeQuery("SELECT * FROM users LIMIT 20, 50");
      expect(info.hasLimit).toBe(true);
      expect(info.existingLimit).toBe(50);
      expect(info.existingOffset).toBe(20);
    });

    test("detects Oracle FETCH FIRST N ROWS ONLY", () => {
      const info = analyzeQuery("SELECT * FROM users FETCH FIRST 25 ROWS ONLY");
      expect(info.hasLimit).toBe(true);
      expect(info.existingLimit).toBe(25);
    });

    test("detects Oracle FETCH NEXT N ROWS ONLY", () => {
      const info = analyzeQuery("SELECT * FROM users OFFSET 10 ROWS FETCH NEXT 20 ROWS ONLY");
      expect(info.hasLimit).toBe(true);
      expect(info.existingLimit).toBe(20);
    });

    test("detects MSSQL SELECT TOP N", () => {
      const info = analyzeQuery("SELECT TOP 10 * FROM users");
      expect(info.hasLimit).toBe(true);
      expect(info.existingLimit).toBe(10);
    });

    test("detects Oracle ROWNUM", () => {
      const info = analyzeQuery("SELECT * FROM users WHERE ROWNUM <= 100");
      expect(info.hasLimit).toBe(true);
    });

    test("detects LIMIT with trailing semicolon", () => {
      const info = analyzeQuery("SELECT * FROM users LIMIT 100;");
      expect(info.hasLimit).toBe(true);
      expect(info.existingLimit).toBe(100);
    });
  });

  // ── OFFSET detection ────────────────────────────────────────────────────

  describe("OFFSET detection", () => {
    test("no offset by default", () => {
      const info = analyzeQuery("SELECT * FROM users");
      expect(info.hasOffset).toBe(false);
    });

    test("detects standalone OFFSET (no LIMIT)", () => {
      const info = analyzeQuery("SELECT * FROM users OFFSET 20");
      expect(info.hasOffset).toBe(true);
      expect(info.existingOffset).toBe(20);
      expect(info.hasLimit).toBe(false);
    });
  });

  // ── Flags ───────────────────────────────────────────────────────────────

  describe("flags", () => {
    test("detects UNION", () => {
      const sql = "SELECT * FROM a UNION SELECT * FROM b";
      expect(analyzeQuery(sql).isUnion).toBe(true);
    });

    test("detects UNION ALL", () => {
      const sql = "SELECT * FROM a UNION ALL SELECT * FROM b";
      expect(analyzeQuery(sql).isUnion).toBe(true);
    });

    test("no UNION when not present", () => {
      expect(analyzeQuery("SELECT * FROM t").isUnion).toBe(false);
    });

    test("detects CTE (WITH clause)", () => {
      expect(analyzeQuery("WITH cte AS (SELECT 1) SELECT * FROM cte").hasCTE).toBe(true);
    });

    test("no CTE for regular queries", () => {
      expect(analyzeQuery("SELECT * FROM t").hasCTE).toBe(false);
    });

    test("detects subquery (nested SELECT)", () => {
      const sql = "SELECT * FROM (SELECT id FROM users) sub";
      expect(analyzeQuery(sql).hasSubquery).toBe(true);
    });

    test("no subquery for single SELECT", () => {
      expect(analyzeQuery("SELECT * FROM users").hasSubquery).toBe(false);
    });

    test("CTE with subquery has both flags", () => {
      const sql = "WITH cte AS (SELECT * FROM users) SELECT * FROM cte";
      const info = analyzeQuery(sql);
      expect(info.hasCTE).toBe(true);
      expect(info.hasSubquery).toBe(true); // CTE body + outer SELECT = 2 SELECTs
    });
  });
});

// ─── Leading comments (#275) ────────────────────────────────────────────────
//
// A comment is not whitespace, so the leading-keyword tests used to miss behind
// one and every annotated statement fell through to `OTHER`. For a SELECT that
// meant no LIMIT was injected and the whole result set came back, with the UI
// badge reporting "not limited"; for the rest it meant a write was classified as
// something the pipeline knows nothing about.

describe("classification behind a leading comment", () => {
  describe("type detection", () => {
    test.each<[string, string]>([
      ["a line comment", "-- annotated\nSELECT * FROM users"],
      ["a block comment", "/* annotated */ SELECT * FROM users"],
      ["a hash comment (MySQL)", "# annotated\nSELECT * FROM users"],
      ["stacked comments of all three styles", "# a\n-- b\n/* c */\nSELECT * FROM users"],
      ["a comment, then a blank line", "/* annotated */\n\nSELECT * FROM users"],
      ["a comment, then whitespace", "-- annotated\n\t  SELECT * FROM users"],
    ])("classifies a SELECT behind %s as SELECT", (_label, sql) => {
      expect(analyzeQuery(sql).type).toBe("SELECT");
    });

    test.each<[string, ParsedQueryInfo["type"], string]>([
      ["INSERT", "INSERT", "-- annotated\nINSERT INTO users VALUES (1, 'a')"],
      ["UPDATE", "UPDATE", "/* annotated */ UPDATE users SET name = 'x' WHERE id = 1"],
      ["DELETE", "DELETE", "# annotated\nDELETE FROM users WHERE id = 1"],
      ["CREATE", "DDL", "-- annotated\nCREATE TABLE foo (id int)"],
      ["ALTER", "DDL", "-- annotated\nALTER TABLE foo ADD col int"],
      ["DROP", "DDL", "/* annotated */ DROP TABLE foo"],
      ["TRUNCATE", "DDL", "# annotated\nTRUNCATE TABLE foo"],
    ])("classifies a commented %s as %s", (_keyword, expected, sql) => {
      expect(analyzeQuery(sql).type).toBe(expected);
    });

    test("classifies a commented CTE as SELECT and flags it as a CTE", () => {
      const info = analyzeQuery("-- annotated\nWITH cte AS (SELECT 1) SELECT * FROM cte");

      expect(info.type).toBe("SELECT");
      expect(info.hasCTE).toBe(true);
    });

    test("does not flag a commented plain SELECT as a CTE", () => {
      expect(analyzeQuery("-- annotated\nSELECT * FROM users").hasCTE).toBe(false);
    });

    test("leaves a commented statement it does not know as OTHER", () => {
      expect(analyzeQuery("-- annotated\nGRANT SELECT ON t TO someone").type).toBe("OTHER");
    });

    // The keyword has to be the statement's own, not one mentioned in the comment:
    // classifying this as a SELECT would inject a LIMIT into an UPDATE.
    test("ignores a keyword that only appears inside the comment body", () => {
      expect(analyzeQuery("-- remember to SELECT first\nUPDATE users SET name = 'x'").type).toBe("UPDATE");
    });

    // Same principle, on the one branch that reads more than the leading keyword:
    // `WITH` is a SELECT only when the statement also CONTAINS a SELECT, and that
    // search has to start past the trivia too. A LEADING comment could not reach this
    // branch before the classifier saw behind one, which is what makes this the
    // task's own regression to guard. An INTERIOR comment has always been able to
    // answer for the statement here (`WITH t AS (UPDATE …) /* SELECT */ INSERT …`
    // still classifies as SELECT) - same pre-existing family as the trailing-comment
    // swallow, out of this task's scope. Below: a CTE that writes, annotated with a
    // comment that happens to say SELECT.
    const writingCTE =
      "-- remember to SELECT afterwards\nWITH t AS (UPDATE x SET a = 1 RETURNING id) INSERT INTO y VALUES (1)";

    test("does not let a SELECT inside the comment body turn a writing CTE into a SELECT", () => {
      const info = analyzeQuery(writingCTE);

      expect(info.type).toBe("OTHER");
      expect(info.hasCTE).toBe(true);
    });

    test("leaves that writing CTE unmodified rather than appending a LIMIT to it", () => {
      const result = applyQueryLimit(writingCTE, 500);

      expect(result.sql).toBe(writingCTE);
      expect(result.wasLimited).toBe(false);
    });

    // The comment must not be able to hide a real SELECT either - a genuine
    // CTE-SELECT behind a comment mentioning nothing still classifies as SELECT
    // (the `slice` starts at the keyword, so the statement's own text is intact).
    test("still finds the statement's own SELECT when the comment mentions none", () => {
      expect(analyzeQuery("-- annotated\nWITH t AS (SELECT 1) SELECT * FROM t").type).toBe("SELECT");
    });
  });

  // ── Already-bounded statements ────────────────────────────────────────────
  //
  // The three "already limited" probes have to see behind a comment too. The
  // `TOP` one is the dangerous one: missing it means a second `TOP` is injected
  // into a statement that already has one, which is invalid SQL rather than
  // merely too many rows.

  describe("existing bounds are still detected", () => {
    test.each<[string, string, number]>([
      ["LIMIT", "-- annotated\nSELECT * FROM users LIMIT 10", 10],
      ["FETCH FIRST", "/* annotated */ SELECT * FROM users FETCH FIRST 25 ROWS ONLY", 25],
      ["SELECT TOP", "-- annotated\nSELECT TOP 10 * FROM users", 10],
      ["SELECT TOP behind a block comment", "/* annotated */ SELECT TOP 10 * FROM users", 10],
    ])("detects a commented %s as already limited", (_label, sql, expected) => {
      const info = analyzeQuery(sql);

      expect(info.hasLimit).toBe(true);
      expect(info.existingLimit).toBe(expected);
    });

    test("does not bound a commented, already-bounded SELECT a second time", () => {
      const sql = "-- annotated\nSELECT * FROM users LIMIT 10";

      const result = applyQueryLimit(sql, 500);

      expect(result.sql).toBe(sql);
      expect(result.wasLimited).toBe(false);
      expect(result.appliedLimit).toBe(10);
    });
  });

  // ── The limit actually gets applied ───────────────────────────────────────

  describe("limiting", () => {
    test("adds a LIMIT to a commented SELECT and keeps the comment", () => {
      const result = applyQueryLimit("-- annotated\nSELECT * FROM users", 500);

      expect(result.sql).toBe("-- annotated\nSELECT * FROM users LIMIT 500");
      expect(result.wasLimited).toBe(true);
      expect(result.appliedLimit).toBe(500);
    });

    test("leaves a commented INSERT unmodified", () => {
      const sql = "-- annotated\nINSERT INTO users VALUES (1, 'a')";

      const result = applyQueryLimit(sql, 500);

      expect(result.sql).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });

    test("reports a commented SELECT as a SELECT through isSelectQuery", () => {
      expect(isSelectQuery("/* annotated */ SELECT 1")).toBe(true);
      expect(isSelectQuery("-- annotated\nINSERT INTO t VALUES (1)")).toBe(false);
    });

    test("reports a commented bound through hasQueryLimit", () => {
      expect(hasQueryLimit("-- annotated\nSELECT TOP 10 * FROM users")).toBe(true);
      expect(hasQueryLimit("-- annotated\nSELECT * FROM users")).toBe(false);
    });
  });
});

// ─── applyQueryLimit ────────────────────────────────────────────────────────

describe("applyQueryLimit", () => {
  // ── Adding LIMIT ────────────────────────────────────────────────────────

  describe("adding LIMIT to SELECT", () => {
    test("adds LIMIT to bare SELECT", () => {
      const result = applyQueryLimit("SELECT * FROM users", 100);
      expect(result.sql).toBe("SELECT * FROM users LIMIT 100");
      expect(result.wasLimited).toBe(true);
      expect(result.appliedLimit).toBe(100);
    });

    test("adds LIMIT and OFFSET", () => {
      const result = applyQueryLimit("SELECT * FROM users", 50, 20);
      expect(result.sql).toBe("SELECT * FROM users LIMIT 50 OFFSET 20");
      expect(result.wasLimited).toBe(true);
      expect(result.appliedLimit).toBe(50);
      expect(result.appliedOffset).toBe(20);
    });

    test("handles trailing semicolon", () => {
      const result = applyQueryLimit("SELECT * FROM users;", 100);
      expect(result.sql).toBe("SELECT * FROM users LIMIT 100;");
      expect(result.wasLimited).toBe(true);
    });

    test("trims whitespace before adding LIMIT", () => {
      const result = applyQueryLimit("  SELECT * FROM users  ", 100);
      expect(result.sql).toBe("SELECT * FROM users LIMIT 100");
    });
  });

  // ── Preserving existing LIMIT ───────────────────────────────────────────

  describe("preserving existing LIMIT", () => {
    test("preserves existing LIMIT when forceLimit is false (default)", () => {
      const result = applyQueryLimit("SELECT * FROM users LIMIT 50", 100);
      expect(result.sql).toBe("SELECT * FROM users LIMIT 50");
      expect(result.wasLimited).toBe(false);
      expect(result.originalLimit).toBe(50);
      expect(result.appliedLimit).toBe(50);
    });

    test("preserves existing LIMIT OFFSET", () => {
      const result = applyQueryLimit("SELECT * FROM users LIMIT 50 OFFSET 10", 100);
      expect(result.wasLimited).toBe(false);
      expect(result.appliedLimit).toBe(50);
      expect(result.appliedOffset).toBe(10);
    });
  });

  // ── Force LIMIT ─────────────────────────────────────────────────────────

  describe("forceLimit", () => {
    test("replaces existing LIMIT when forceLimit is true", () => {
      const result = applyQueryLimit("SELECT * FROM users LIMIT 50", 200, 0, {
        forceLimit: true,
      });
      expect(result.sql).toBe("SELECT * FROM users LIMIT 200");
      expect(result.wasLimited).toBe(true);
      expect(result.originalLimit).toBe(50);
      expect(result.appliedLimit).toBe(200);
    });

    test("replaces existing LIMIT OFFSET when forceLimit is true", () => {
      const result = applyQueryLimit("SELECT * FROM users LIMIT 50 OFFSET 10", 100, 5, {
        forceLimit: true,
      });
      expect(result.sql).toBe("SELECT * FROM users LIMIT 100 OFFSET 5");
      expect(result.wasLimited).toBe(true);
    });
  });

  // ── Non-SELECT queries ──────────────────────────────────────────────────

  describe("non-SELECT queries", () => {
    test("INSERT returns unmodified", () => {
      const sql = "INSERT INTO users VALUES (1, 'a')";
      const result = applyQueryLimit(sql, 100);
      expect(result.sql).toBe(sql);
      expect(result.wasLimited).toBe(false);
      expect(result.appliedLimit).toBe(0);
    });

    test("UPDATE returns unmodified", () => {
      const sql = "UPDATE users SET name = 'x'";
      const result = applyQueryLimit(sql, 100);
      expect(result.sql).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });

    test("DELETE returns unmodified", () => {
      const sql = "DELETE FROM users WHERE id = 1";
      const result = applyQueryLimit(sql, 100);
      expect(result.sql).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });

    test("DDL (CREATE TABLE) returns unmodified", () => {
      const sql = "CREATE TABLE foo (id int)";
      const result = applyQueryLimit(sql, 100);
      expect(result.sql).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });
  });

  // ── CTE and complex queries ─────────────────────────────────────────────

  describe("CTE and complex queries", () => {
    test("adds LIMIT to CTE query", () => {
      const sql = "WITH cte AS (SELECT 1) SELECT * FROM cte";
      const result = applyQueryLimit(sql, 100);
      expect(result.sql).toBe("WITH cte AS (SELECT 1) SELECT * FROM cte LIMIT 100");
      expect(result.wasLimited).toBe(true);
    });

    test("adds LIMIT to UNION query", () => {
      const sql = "SELECT * FROM a UNION SELECT * FROM b";
      // analyzeQuery detects type=SELECT from first word, so it will add LIMIT
      const result = applyQueryLimit(sql, 100);
      expect(result.sql).toContain("LIMIT 100");
      expect(result.wasLimited).toBe(true);
    });
  });

  // ── Offset behavior ────────────────────────────────────────────────────

  describe("offset behavior", () => {
    test("offset=0 does not add OFFSET clause", () => {
      const result = applyQueryLimit("SELECT * FROM t", 100, 0);
      expect(result.sql).toBe("SELECT * FROM t LIMIT 100");
      expect(result.appliedOffset).toBe(0);
    });

    test("positive offset adds OFFSET clause", () => {
      const result = applyQueryLimit("SELECT * FROM t", 100, 50);
      expect(result.sql).toBe("SELECT * FROM t LIMIT 100 OFFSET 50");
      expect(result.appliedOffset).toBe(50);
    });
  });
});

// ─── hasQueryLimit ──────────────────────────────────────────────────────────

describe("hasQueryLimit", () => {
  test("returns false for query without LIMIT", () => {
    expect(hasQueryLimit("SELECT * FROM users")).toBe(false);
  });

  test("returns true for query with LIMIT", () => {
    expect(hasQueryLimit("SELECT * FROM users LIMIT 100")).toBe(true);
  });

  test("returns true for query with TOP", () => {
    expect(hasQueryLimit("SELECT TOP 10 * FROM users")).toBe(true);
  });

  test("returns true for query with FETCH FIRST", () => {
    expect(hasQueryLimit("SELECT * FROM users FETCH FIRST 10 ROWS ONLY")).toBe(true);
  });

  test("returns false for INSERT", () => {
    expect(hasQueryLimit("INSERT INTO t VALUES (1)")).toBe(false);
  });
});

// ─── isSelectQuery ──────────────────────────────────────────────────────────

describe("isSelectQuery", () => {
  test("returns true for SELECT", () => {
    expect(isSelectQuery("SELECT * FROM users")).toBe(true);
  });

  test("returns true for lowercase select", () => {
    expect(isSelectQuery("select 1")).toBe(true);
  });

  test("returns true for WITH...SELECT (CTE)", () => {
    expect(isSelectQuery("WITH cte AS (SELECT 1) SELECT * FROM cte")).toBe(true);
  });

  test("returns false for INSERT", () => {
    expect(isSelectQuery("INSERT INTO t VALUES (1)")).toBe(false);
  });

  test("returns false for UPDATE", () => {
    expect(isSelectQuery("UPDATE t SET x = 1")).toBe(false);
  });

  test("returns false for DELETE", () => {
    expect(isSelectQuery("DELETE FROM t")).toBe(false);
  });

  test("returns false for DDL", () => {
    expect(isSelectQuery("CREATE TABLE t (id int)")).toBe(false);
  });

  test("returns false for EXPLAIN", () => {
    expect(isSelectQuery("EXPLAIN SELECT * FROM t")).toBe(false);
  });
});

// ─── leading trivia must not answer whole-statement probes ──────────────────
//
// The leading keyword is read past comments (#275), but three probes still
// searched the WHOLE text: the Oracle ROWNUM bound, UNION detection and the
// subquery count. A word written in a leading comment then answered for the
// statement — and for ROWNUM that means "already bounded", so the query runs
// unbounded, which is the exact symptom #275 removed. Reported by review on
// PR #289.

describe("analyzeQuery: leading comments cannot answer for the statement body", () => {
  test("a ROWNUM bound mentioned in a leading comment does not mark the query bounded", () => {
    const info = analyzeQuery("-- switch to ROWNUM <= 10 on oracle\nSELECT * FROM huge_table");
    expect(info.type).toBe("SELECT");
    expect(info.hasLimit).toBe(false);

    const limited = applyQueryLimit("-- switch to ROWNUM <= 10 on oracle\nSELECT * FROM huge_table", 500);
    expect(limited.wasLimited).toBe(true);
    expect(limited.sql).toContain("LIMIT 500");
  });

  test("a ROWNUM bound mentioned in a leading block comment does not mark the query bounded", () => {
    expect(analyzeQuery("/* ROWNUM <= 5 */ SELECT * FROM huge_table").hasLimit).toBe(false);
  });

  test("a real ROWNUM bound is still detected", () => {
    expect(analyzeQuery("SELECT * FROM t WHERE ROWNUM <= 10").hasLimit).toBe(true);
    expect(analyzeQuery("-- annotated\nSELECT * FROM t WHERE ROWNUM <= 10").hasLimit).toBe(true);
  });

  test("UNION mentioned in a leading comment does not mark the query a union", () => {
    expect(analyzeQuery("-- consider UNION ALL here\nSELECT 1").isUnion).toBe(false);
    expect(analyzeQuery("SELECT 1 UNION SELECT 2").isUnion).toBe(true);
  });

  test("SELECT mentioned in a leading comment does not count as a nested SELECT", () => {
    expect(analyzeQuery("-- SELECT was here\nSELECT 1").hasSubquery).toBe(false);
    expect(analyzeQuery("SELECT (SELECT 1) AS x").hasSubquery).toBe(true);
  });
});
