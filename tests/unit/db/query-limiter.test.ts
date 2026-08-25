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
    // a `WITH` is typed by the keyword its CTE list operates (#287), and finding
    // that keyword has to start past the trivia too. A LEADING comment could not
    // reach this branch before the classifier saw behind one, which is what makes
    // this the task's own regression to guard. Below: a CTE that writes, annotated
    // with a comment that happens to say SELECT.
    const writingCTE =
      "-- remember to SELECT afterwards\nWITH t AS (UPDATE x SET a = 1 RETURNING id) INSERT INTO y VALUES (1)";

    test("does not let a SELECT inside the comment body turn a writing CTE into a SELECT", () => {
      const info = analyzeQuery(writingCTE);

      // INSERT rather than OTHER since #287: the statement is typed by the keyword
      // after its CTE list, which is the honest answer and the one the four
      // consumers of `type` (all of which test `=== "SELECT"`) already handle.
      expect(info.type).toBe("INSERT");
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

// ─── Data-modifying CTEs (#287) ─────────────────────────────────────────────
//
// A `WITH` statement used to be typed by testing whether the word SELECT appeared
// anywhere in its text. `INSERT INTO … SELECT` supplies that word itself, so an
// ordinary data-modifying CTE was typed SELECT and the limiter appended a bound to
// it. In PostgreSQL that bound applies to the rows the statement WRITES: the
// statement commits at most the default limit and the UI reports a truncated
// result set. A write that commits 500 of 10,000 rows is not recoverable the way a
// truncated read is, which is what makes this the worst failure in this family.
//
// The type now comes from the keyword the CTE list actually operates
// (`lib/sql/operative-keyword`), and that keyword is reported as its own type
// rather than as a blanket OTHER - every consumer of `type` tests `=== "SELECT"`,
// so the honest answer costs nothing.

describe("a CTE is typed by the keyword its list operates", () => {
  describe("type detection", () => {
    test.each<[string, ParsedQueryInfo["type"], string]>([
      [
        "INSERT ... SELECT after an UPDATE ... RETURNING CTE",
        "INSERT",
        "WITH t AS (UPDATE logs SET seen = true RETURNING id) INSERT INTO audit SELECT id FROM t",
      ],
      [
        "INSERT ... SELECT after a DELETE ... RETURNING CTE",
        "INSERT",
        "WITH gone AS (DELETE FROM sessions RETURNING id) INSERT INTO audit SELECT id FROM gone",
      ],
      [
        "UPDATE ... FROM a read-only CTE",
        "UPDATE",
        "WITH stale AS (SELECT id FROM sessions) UPDATE users SET flag = 1 FROM stale",
      ],
      [
        "DELETE ... USING a read-only CTE",
        "DELETE",
        "WITH doomed AS (SELECT id FROM sessions) DELETE FROM users USING doomed WHERE users.id = doomed.id",
      ],
      // MERGE has no member in the type union, so it lands on OTHER - which is
      // still not SELECT, and not being bounded is the whole point.
      [
        "MERGE after a read-only CTE",
        "OTHER",
        "WITH src AS (SELECT 1 AS id) MERGE INTO target USING src ON target.id = src.id WHEN MATCHED THEN DELETE",
      ],
      [
        "a parenthesised subquery SELECT inside the writing CTE's definition",
        "INSERT",
        "WITH t AS (UPDATE logs SET n = (SELECT count(*) FROM x) RETURNING id) INSERT INTO audit SELECT id FROM t",
      ],
    ])("types %s as %s", (_label, expected, sql) => {
      expect(analyzeQuery(sql).type).toBe(expected);
    });

    test.each<[string, string]>([
      ["one CTE", "WITH t AS (SELECT 1) SELECT * FROM t"],
      ["several CTEs", "WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a, b"],
      ["a nested CTE", "WITH o AS (WITH i AS (SELECT 1) SELECT * FROM i) SELECT * FROM o"],
      ["WITH RECURSIVE", "WITH RECURSIVE t AS (SELECT 1 UNION ALL SELECT 2) SELECT * FROM t"],
      ["a column list before AS", "WITH t (a) AS (SELECT 1) SELECT * FROM t"],
      ["MATERIALIZED", "WITH t AS MATERIALIZED (SELECT 1) SELECT * FROM t"],
    ])("still types a read-only CTE with %s as SELECT", (_label, sql) => {
      expect(analyzeQuery(sql).type).toBe("SELECT");
    });

    // #291. A CTE element may also be `<expr> AS <alias>`, which is how ClickHouse
    // ordinarily writes one. The walker introduced above read only the standard
    // `name AS (body)` shape, so these typed OTHER and streamed unbounded off an
    // analytics engine - a protection switched off by the change that closed #287.
    test.each<[string, string]>([
      ["a scalar alias", "WITH 1 AS one SELECT one, count(*) FROM events GROUP BY one"],
      ["a function alias", "WITH now() AS t SELECT * FROM events WHERE ts < t"],
      ["an array alias", "WITH [1, 2, 3] AS arr SELECT arrayJoin(arr)"],
      ["a mixed CTE list", "WITH 1 AS one, t AS (SELECT 2) SELECT one, * FROM t"],
    ])("types an expression CTE with %s as SELECT", (_label, sql) => {
      expect(analyzeQuery(sql).type).toBe("SELECT");
    });

    // And the direction that may not move with it: an expression element in front
    // of a write is still a write.
    test("types a write after an expression CTE as the write", () => {
      expect(analyzeQuery("WITH 1 AS x INSERT INTO t VALUES (x)").type).toBe("INSERT");
    });

    // Not being able to tell must never resolve to SELECT: an unbounded read is
    // recoverable, a partially committed write is not.
    test.each<[string, string]>([
      ["an unclosed CTE body", "WITH t AS (SELECT 1"],
      ["nothing after the CTE list", "WITH t AS (SELECT 1)"],
      ["a malformed CTE list", "WITH t AS SELECT 1"],
    ])("does not type %s as SELECT", (_label, sql) => {
      expect(analyzeQuery(sql).type).not.toBe("SELECT");
    });

    // hasCTE answers "does this statement lead with WITH", which is independent of
    // what the CTE list operates - the two readings must not start disagreeing.
    test.each<[string, string]>([
      ["a read-only CTE", "WITH t AS (SELECT 1) SELECT * FROM t"],
      ["a writing CTE", "WITH t AS (SELECT 1) INSERT INTO u SELECT * FROM t"],
      ["a MERGE CTE", "WITH s AS (SELECT 1) MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN DELETE"],
      ["an unclosed CTE body", "WITH t AS (SELECT 1"],
      ["a commented writing CTE", "-- note\nWITH t AS (SELECT 1) DELETE FROM u WHERE id IN (SELECT id FROM t)"],
    ])("flags %s as a CTE", (_label, sql) => {
      expect(analyzeQuery(sql).hasCTE).toBe(true);
    });
  });

  describe("limiting", () => {
    test.each<[string, string]>([
      ["INSERT", "WITH t AS (UPDATE logs SET seen = true RETURNING id) INSERT INTO audit SELECT id FROM t"],
      ["UPDATE", "WITH stale AS (SELECT id FROM sessions) UPDATE users SET flag = 1 FROM stale"],
      ["DELETE", "WITH doomed AS (SELECT id FROM s) DELETE FROM users USING doomed WHERE users.id = doomed.id"],
      [
        "MERGE",
        "WITH src AS (SELECT 1 AS id) MERGE INTO target USING src ON target.id = src.id WHEN MATCHED THEN DELETE",
      ],
    ])("leaves a CTE that operates an %s byte-identical", (_label, sql) => {
      const result = applyQueryLimit(sql, 500);

      expect(result.sql).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });

    test("still bounds a read-only CTE", () => {
      const sql = "WITH RECURSIVE t AS (SELECT 1 UNION ALL SELECT 2) SELECT * FROM t";

      const result = applyQueryLimit(sql, 500);

      expect(result.sql).toBe(`${sql} LIMIT 500`);
      expect(result.wasLimited).toBe(true);
    });

    test("bounds an expression CTE (#291)", () => {
      const sql = "WITH 1 AS one SELECT one, count(*) FROM events GROUP BY one";

      const result = applyQueryLimit(sql, 500);

      expect(result.sql).toBe(`${sql} LIMIT 500`);
      expect(result.wasLimited).toBe(true);
    });

    test("leaves a write after an expression CTE byte-identical", () => {
      const sql = "WITH 1 AS x INSERT INTO t VALUES (x)";

      const result = applyQueryLimit(sql, 500);

      expect(result.sql).toBe(sql);
      expect(result.wasLimited).toBe(false);
    });

    test("reports a writing CTE as not a SELECT through isSelectQuery", () => {
      expect(isSelectQuery("WITH t AS (SELECT 1) INSERT INTO u SELECT * FROM t")).toBe(false);
      expect(isSelectQuery("WITH t AS (SELECT 1) SELECT * FROM t")).toBe(true);
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

// ─── trailing trivia (#280) ─────────────────────────────────────────────────
//
// The limiter used to treat the END of a statement as plain text, which broke it
// in both directions at once. Appending `LIMIT n` after a trailing line comment
// puts the bound INSIDE the comment while the caller is told the statement was
// limited, and reading an existing bound off the same text makes a commented-out
// one look real, so nothing is injected. Either way the query runs unbounded, and
// the first also lights the "limited" badge over a full table scan.
//
// The fix is one reading of where the statement ends, shared by the placement and
// by the probes (`lib/sql/statement-end`).

describe("trailing trivia: placement", () => {
  test.each<[string, string, string]>([
    // label, input, expected output
    ["a line comment", "SELECT * FROM t -- note", "SELECT * FROM t LIMIT 500 -- note"],
    ["a semicolon then a comment", "SELECT * FROM t; -- note", "SELECT * FROM t LIMIT 500; -- note"],
    ["a comment then a semicolon", "SELECT * FROM t -- note\n;", "SELECT * FROM t LIMIT 500 -- note\n;"],
    ["a comment carrying a semicolon", "SELECT * FROM t -- a; b", "SELECT * FROM t LIMIT 500 -- a; b"],
    // A block comment closes, so the bound was already engine-visible after it.
    // It moves anyway: one reading of the end serves both the placement and the
    // probes, and a probe that had to look PAST a trailing block comment is how
    // `LIMIT 10 /* note */` used to collect a second bound (below).
    ["a block comment", "SELECT * FROM t /* note */", "SELECT * FROM t LIMIT 500 /* note */"],
    ["mixed trivia", "SELECT * FROM t /* a */ ; -- b", "SELECT * FROM t LIMIT 500 /* a */ ; -- b"],
  ])("puts the bound before %s", (_label, sql, expected) => {
    const result = applyQueryLimit(sql, 500);

    expect(result.sql).toBe(expected);
    expect(result.wasLimited).toBe(true);
  });

  test("an offset bound also lands before the comment", () => {
    const result = applyQueryLimit("SELECT * FROM t -- note", 500, 20);

    expect(result.sql).toBe("SELECT * FROM t LIMIT 500 OFFSET 20 -- note");
    expect(result.wasLimited).toBe(true);
  });

  // The flag is the part a user acts on: a badge reading "limited to 500" over a
  // statement the engine ran unbounded is worse than no badge at all.
  test("never reports a bound the engine cannot see", () => {
    for (const sql of ["SELECT * FROM t -- note", "SELECT * FROM t /* note */", "SELECT * FROM t; -- note"]) {
      const result = applyQueryLimit(sql, 500);

      // Everything the engine reads: the comment and what follows it removed.
      const executed = result.sql.split(/--|#/)[0];
      expect(result.wasLimited && executed.includes("LIMIT 500"), sql).toBe(true);
    }
  });

  test("a statement with no trailing trivia is emitted exactly as before", () => {
    expect(applyQueryLimit("SELECT * FROM t", 500).sql).toBe("SELECT * FROM t LIMIT 500");
    expect(applyQueryLimit("SELECT * FROM t;", 500).sql).toBe("SELECT * FROM t LIMIT 500;");
  });
});

describe("trailing trivia: detection", () => {
  // A bound written inside a comment is a bound the user turned OFF. Reading it
  // as real leaves the statement unbounded, which is what #280 reported.
  test.each<[string, string]>([
    ["a commented-out LIMIT", "SELECT * FROM t -- LIMIT 10"],
    ["a commented-out FETCH FIRST", "SELECT * FROM t -- FETCH FIRST 10 ROWS ONLY"],
    ["a commented-out OFFSET", "SELECT * FROM t -- OFFSET 5"],
    ["a commented-out ROWNUM bound", "SELECT * FROM t -- ROWNUM <= 10"],
    ["a commented-out LIMIT in a block comment", "SELECT * FROM t /* LIMIT 10 */"],
  ])("does not mistake %s for a real one", (_label, sql) => {
    const info = analyzeQuery(sql);
    expect(info.hasLimit).toBe(false);

    const result = applyQueryLimit(sql, 500);
    expect(result.sql).toContain("LIMIT 500");
    expect(result.wasLimited).toBe(true);
  });

  test.each<[string, string, number]>([
    ["a LIMIT before a line comment", "SELECT * FROM t LIMIT 10 -- deliberate", 10],
    ["a LIMIT before a block comment", "SELECT * FROM t LIMIT 10 /* deliberate */", 10],
    ["a LIMIT before a semicolon and a comment", "SELECT * FROM t LIMIT 10; -- deliberate", 10],
    ["a FETCH FIRST before a comment", "SELECT * FROM t FETCH FIRST 25 ROWS ONLY -- deliberate", 25],
  ])("still honours %s", (_label, sql, expected) => {
    const info = analyzeQuery(sql);
    expect(info.hasLimit).toBe(true);
    expect(info.existingLimit).toBe(expected);

    // Not doubled: a second bound after the first is a syntax error, not extra rows.
    const result = applyQueryLimit(sql, 500);
    expect(result.sql).toBe(sql);
    expect(result.wasLimited).toBe(false);
  });

  test("an OFFSET without a LIMIT is seen behind a comment", () => {
    const info = analyzeQuery("SELECT * FROM t OFFSET 5 -- note");

    expect(info.hasOffset).toBe(true);
    expect(info.existingOffset).toBe(5);
  });

  test("hasQueryLimit reads the statement, not its trailing comment", () => {
    expect(hasQueryLimit("SELECT * FROM t -- LIMIT 10")).toBe(false);
    expect(hasQueryLimit("SELECT * FROM t LIMIT 10 -- note")).toBe(true);
  });

  // forceLimit strips the old bound before writing the new one, and that strip is
  // end-anchored too: run against the raw text it either misses the bound (two
  // LIMITs) or tears the comment apart.
  test("forceLimit replaces a real bound and leaves the comment intact", () => {
    const result = applyQueryLimit("SELECT * FROM t LIMIT 10 -- deliberate", 500, 0, { forceLimit: true });

    expect(result.sql).toBe("SELECT * FROM t LIMIT 500 -- deliberate");
    expect(result.wasLimited).toBe(true);
    expect(result.originalLimit).toBe(10);
  });

  test("forceLimit replaces a MySQL-style bound behind a comment", () => {
    const result = applyQueryLimit("SELECT * FROM t LIMIT 5, 10 -- deliberate", 500, 0, { forceLimit: true });

    expect(result.sql).toBe("SELECT * FROM t LIMIT 500 -- deliberate");
    expect(result.wasLimited).toBe(true);
  });
});

// A statement whose end may not be cut has nowhere honest to take a bound, and
// `wasLimited: false` is the honest answer - the second branch of the spec's own
// item 1. Two shapes reach it, and both are ordinary SQL somewhere:
//
//   - a literal MySQL and PostgreSQL close in different places (`'O\'Brien'`),
//     where inserting on a guess emits the bound after the statement's own `;`;
//   - a trailing `#` run, which is a comment in MySQL and a temp table, an
//     identifier or an XOR operator in the dialects that are not MySQL. Cutting
//     there emitted `SELECT * FROM LIMIT 500 #tmp`.
//
// The cost is that these statements are not bounded: an over-large read the user
// can re-run, against a statement the server would have rejected outright.
describe("a statement whose end may not be cut is not rewritten", () => {
  test.each<[string, string]>([
    ["a quote behind an odd backslash run", "SELECT * FROM users WHERE name = 'O\\'Brien'"],
    ["the same with a terminator", "SELECT * FROM users WHERE name = 'O\\'Brien';"],
    ["the same with a trailing comment", "SELECT * FROM users WHERE name = 'O\\'Brien' -- note"],
    ["an unterminated block comment", "SELECT * FROM users /* note"],
    ["a T-SQL temp table", "SELECT * FROM #tmp"],
    ["an Oracle identifier carrying a hash", "SELECT * FROM EMP WHERE ID# = 1"],
    ["a PostgreSQL XOR operator", "SELECT flags # 5 AS x FROM t"],
    ["a MySQL trailing hash comment", "SELECT * FROM t # note"],
  ])("returns %s untouched", (_label, sql) => {
    const result = applyQueryLimit(sql, 500);

    expect(result.sql).toBe(sql);
    expect(result.wasLimited).toBe(false);
    expect(result.appliedLimit).toBe(0);
  });

  // Reading is not cutting. Where the cut is refused the probes read the WHOLE
  // statement, which is what they read before this reader existed - so a bound
  // written after a `#` is still found, and this is the one shape where a bound
  // written INSIDE a line comment is still taken for a real one. That is the
  // pre-existing reading for `#` and it is left as it is deliberately: the
  // alternative hides `SELECT * FROM #t FETCH NEXT 10 ROWS ONLY`'s real bound
  // from every caller, and the outcome here is the same either way - the
  // statement is returned untouched.
  test("a bound written after a hash is still found", () => {
    expect(analyzeQuery("SELECT * FROM #t FETCH NEXT 10 ROWS ONLY").hasLimit).toBe(true);
    expect(analyzeQuery("SELECT * FROM t # LIMIT 10").hasLimit).toBe(true);
  });

  // KNOWN LIMITATION, pinned: for `#` alone, a commented-out bound is still read
  // as a real one, so the statement is left alone as "already bounded" instead of
  // being bounded. The `--` form, which is unambiguous, is fixed above.
  test("a bound commented out with a hash is read as real, and the statement is left alone", () => {
    const sql = "SELECT * FROM t # LIMIT 10";

    const result = applyQueryLimit(sql, 500);

    expect(result.sql).toBe(sql);
    expect(result.wasLimited).toBe(false);
  });

  test("a hash comment with code after it does not stop the statement", () => {
    const result = applyQueryLimit("SELECT * FROM t # note\nWHERE a = 1", 500);

    expect(result.sql).toBe("SELECT * FROM t # note\nWHERE a = 1 LIMIT 500");
    expect(result.wasLimited).toBe(true);
  });
});

// ─── The bound must never land inside a bracketed name (PR #299 review) ──────
//
// `[…]` quotes an identifier in SQL Server and SQLite, so a comment marker inside
// one is part of the NAME. Reading it as trailing trivia made the insert-before-
// trivia rewrite splice the bound INTO the identifier and still report success:
// `SELECT [a--b] FROM t` came back as `SELECT [a LIMIT 500--b] FROM t`. That is a
// regression this milestone introduced - before it, the bound was appended at the
// end, which was harmless here.

describe("applyQueryLimit: bracket-quoted identifiers", () => {
  test("does not write the bound inside a bracketed name carrying a comment marker", () => {
    const limited = applyQueryLimit("SELECT [a--b] FROM t", 500);

    expect(limited.sql).toBe("SELECT [a--b] FROM t LIMIT 500");
    expect(limited.wasLimited).toBe(true);
  });

  test("a doubled bracket inside the name does not end it either", () => {
    expect(applyQueryLimit("SELECT [a]]b] FROM t", 500).sql).toBe("SELECT [a]]b] FROM t LIMIT 500");
  });

  test("a real trailing comment after a bracketed name is still trivia", () => {
    expect(applyQueryLimit("SELECT [a--b] FROM t -- daily", 500).sql).toBe("SELECT [a--b] FROM t LIMIT 500 -- daily");
  });
});

// ─── `[…]` is read per dialect (#295) ────────────────────────────────────────
//
// The reading above is a NAME, which is right for SQL Server and SQLite and wrong
// for ClickHouse, where the same characters are an array or a subscript: they nest
// and nothing inside them is escaped. Read as a name, a `]` written inside a
// string ends the run early and the CTE element around it cannot be crossed, so
// the statement loses its bound - on the engine whose whole point is scanning more
// rows than a browser can hold. The two readings are mutually exclusive, so this
// is the dialect's answer and both sides are asserted on the emitted text.

describe("applyQueryLimit: the bracket grammar", () => {
  test.each<[string, string, "clickhouse", string]>([
    [
      "a map subscript whose key carries a close bracket",
      "WITH m['a]b'] AS v SELECT v FROM t",
      "clickhouse",
      "WITH m['a]b'] AS v SELECT v FROM t LIMIT 500",
    ],
    [
      "a nested array element",
      "WITH [[1,2],[3,4]] AS a SELECT arrayJoin(a)",
      "clickhouse",
      "WITH [[1,2],[3,4]] AS a SELECT arrayJoin(a) LIMIT 500",
    ],
    [
      "a nested array in the select list",
      "SELECT [[1,2],[3,4]] AS a FROM t",
      "clickhouse",
      "SELECT [[1,2],[3,4]] AS a FROM t LIMIT 500",
    ],
    // The bound goes after the run and before the trailing comment: a subscript is
    // the statement's own text, not trivia, so an end read before it would splice
    // the clause into the middle of the statement. The rows where the run is the
    // statement's LAST token are what make that assertable at all - with code after
    // the run, both readings put the end in the same place (reported by review).
    [
      "an array literal before a trailing hash comment",
      "SELECT [[1,2],[3]] AS a FROM t # daily",
      "clickhouse",
      "SELECT [[1,2],[3]] AS a FROM t LIMIT 500 # daily",
    ],
    ["a subscript that ends the statement", "SELECT m['a]b']", "clickhouse", "SELECT m['a]b'] LIMIT 500"],
    [
      "a nested array that ends the statement, before a comment",
      "SELECT [[1,2],[3,4]] # daily",
      "clickhouse",
      "SELECT [[1,2],[3,4]] LIMIT 500 # daily",
    ],
  ])("%s is bounded under the subscript grammar, emitted intact", (_label, sql, type, expected) => {
    const result = applyQueryLimit(sql, 500, 0, {}, type);

    expect(result.sql).toBe(expected);
    expect(result.wasLimited).toBe(true);
    // Without the dialect the same text keeps today's answer, which for every
    // shape here is no bound at all: the name reading either cannot cross the
    // element or cannot close the run.
    expect(applyQueryLimit(sql, 500).sql).not.toBe(expected);
  });

  test.each<[string, string, "mssql" | "sqlite", string]>([
    ["an apostrophe inside the name", "SELECT [it's] FROM t", "mssql", "SELECT [it's] FROM t LIMIT 500"],
    ["a doubled close bracket", "SELECT [a]]b] FROM t", "mssql", "SELECT [a]]b] FROM t LIMIT 500"],
    ["a comment marker inside the name", "SELECT [a--b] FROM t", "sqlite", "SELECT [a--b] FROM t LIMIT 500"],
    ["a name carrying a semicolon", "SELECT [a;b] FROM t -- daily", "sqlite", "SELECT [a;b] FROM t LIMIT 500 -- daily"],
  ])("a bracket-quoted name with %s stays one name under the name grammar", (_label, sql, type, expected) => {
    const result = applyQueryLimit(sql, 500, 0, {}, type);

    expect(result.sql).toBe(expected);
    expect(result.wasLimited).toBe(true);
  });

  test("a subscript with no literal in it, and a literal with no close bracket, keep their answers", () => {
    // Neither reading moves for these, and that is worth pinning: it is what says
    // the change is confined to the runs where the two grammars disagree.
    expect(applyQueryLimit("SELECT a[1] FROM t", 500, 0, {}, "clickhouse").sql).toBe("SELECT a[1] FROM t LIMIT 500");
    expect(applyQueryLimit("SELECT a[1] FROM t", 500).sql).toBe("SELECT a[1] FROM t LIMIT 500");
    expect(applyQueryLimit("SELECT 'a[b' FROM t", 500, 0, {}, "clickhouse").sql).toBe("SELECT 'a[b' FROM t LIMIT 500");
    expect(applyQueryLimit("SELECT 'a[b' FROM t", 500).sql).toBe("SELECT 'a[b' FROM t LIMIT 500");
  });

  test("a run the subscript grammar cannot close is not rewritten", () => {
    const sql = "SELECT [1,2 AS a FROM t";

    expect(applyQueryLimit(sql, 500, 0, {}, "clickhouse")).toMatchObject({ sql, wasLimited: false });
  });
});

// ─── The dialect channel (#292) ──────────────────────────────────────────────
//
// Every reading above is a call that names NO dialect, and the point of the
// compatibility default is that those answers do not move: the readers do exactly
// what they did before this channel existed. A caller that DOES name its dialect
// gets that dialect's grammar, and the shapes below are the ones where the two
// answers differ - each asserted on BOTH sides, so the default is a decision
// rather than whatever the implementation happened to do.

describe("a named dialect changes the reading; naming none does not", () => {
  // The bad direction this family exists to prevent: a hash comment whose first
  // character makes a PostgreSQL operator hides a `)`, the CTE body ends early,
  // and a statement that DELETEs is typed SELECT and bounded. MySQL 8 accepts
  // both `WITH … DELETE` and a `LIMIT` on a `DELETE`, so that bound would commit a
  // partial delete while the UI reported a truncated result set.
  const HIDDEN_DELETE = "WITH t AS (\n  #- drop the ) SELECT here\n  SELECT id FROM logs\n) DELETE FROM users";

  test("without a dialect the hidden DELETE keeps today's (wrong) type", () => {
    expect(analyzeQuery(HIDDEN_DELETE).type).toBe("SELECT");
  });

  test("under MySQL's grammar it is typed as the DELETE it operates and gets no bound", () => {
    expect(analyzeQuery(HIDDEN_DELETE, "mysql").type).toBe("DELETE");

    const result = applyQueryLimit(HIDDEN_DELETE, 500, 0, {}, "mysql");
    expect(result.sql).toBe(HIDDEN_DELETE);
    expect(result.wasLimited).toBe(false);
  });

  // The read-side face of the same ambiguity: a bound written after a hash is
  // read as a real one today, so the statement is left unbounded. Under MySQL's
  // grammar the bound is commented out, so a real one is added - and it is added
  // BEFORE the comment, or it would land inside it.
  test("a bound commented out with a hash is real without a dialect and commented out under MySQL's", () => {
    const sql = "SELECT * FROM t # LIMIT 10";

    expect(analyzeQuery(sql).hasLimit).toBe(true);
    expect(applyQueryLimit(sql, 500).sql).toBe(sql);

    expect(analyzeQuery(sql, "mysql").hasLimit).toBe(false);
    expect(applyQueryLimit(sql, 500, 0, {}, "mysql")).toMatchObject({
      sql: "SELECT * FROM t LIMIT 500 # LIMIT 10",
      wasLimited: true,
    });
  });

  // The other side: under a code grammar the run is part of the statement, so the
  // cut is no longer refused and an ordinary temp-table read is bounded.
  test.each<[string, string, "mssql" | "oracle" | "postgres" | "sqlite", string]>([
    ["a T-SQL temp table", "SELECT * FROM #tmp", "mssql", "SELECT * FROM #tmp LIMIT 500"],
    [
      "an Oracle identifier carrying a hash",
      "SELECT * FROM EMP WHERE ID# = 1",
      "oracle",
      "SELECT * FROM EMP WHERE ID# = 1 LIMIT 500",
    ],
    ["a PostgreSQL XOR operator", "SELECT flags # 5 AS x FROM t", "postgres", "SELECT flags # 5 AS x FROM t LIMIT 500"],
    ["a SQLite bind variable", "SELECT * FROM t WHERE id = #id", "sqlite", "SELECT * FROM t WHERE id = #id LIMIT 500"],
  ])("%s is bounded under a code grammar and left alone without one", (_label, sql, type, expected) => {
    expect(applyQueryLimit(sql, 500).wasLimited).toBe(false);

    const result = applyQueryLimit(sql, 500, 0, {}, type);
    expect(result.sql).toBe(expected);
    expect(result.wasLimited).toBe(true);
  });

  // Fixture discipline: input built from syntax these readers do not model as a
  // unit - a hash INSIDE a quoted name, and a dollar-quoted body carrying both a
  // hash and a close paren. The emitted text is asserted whole, because "a bound
  // was added" would pass while the bound sat inside the name.
  test.each<[string, string, "mysql" | "postgres" | "mssql", string]>([
    ["a backtick name carrying a hash", "SELECT `a#b` FROM t", "mysql", "SELECT `a#b` FROM t LIMIT 500"],
    [
      "a bracket name carrying a hash, from a temp table",
      "SELECT [a#b] FROM #tmp",
      "mssql",
      "SELECT [a#b] FROM #tmp LIMIT 500",
    ],
    [
      "a dollar-quoted body carrying a hash and a paren",
      "SELECT $fn$ # ) DELETE $fn$ AS body FROM t",
      "postgres",
      "SELECT $fn$ # ) DELETE $fn$ AS body FROM t LIMIT 500",
    ],
  ])("%s is emitted intact", (_label, sql, type, expected) => {
    const result = applyQueryLimit(sql, 500, 0, {}, type);

    expect(result.sql).toBe(expected);
    expect(result.wasLimited).toBe(true);
  });

  // Oracle's alternate quoting (`q'{it's}'`) is the second grammar this channel
  // carries, and the only dialect that has the form is the only one that reads it.
  // Both inputs below are Oracle text, so the dialect-less answers are what
  // reading Oracle as something else costs: the first loses its bound, and the
  // second - whose literal also carries a `--` - has the clause placed before what
  // that reading calls a trailing comment, i.e. inside the literal. That answer is
  // correct FOR the grammar being read (there `q` is a name and `'[it'` a string)
  // and wrong for the statement, which is the whole point of naming the dialect.
  test.each<[string, string, string, string]>([
    [
      "a CTE body holding an apostrophe",
      "WITH t AS (SELECT q'{it's}' AS s FROM dual) SELECT * FROM t",
      "WITH t AS (SELECT q'{it's}' AS s FROM dual) SELECT * FROM t",
      "WITH t AS (SELECT q'{it's}' AS s FROM dual) SELECT * FROM t LIMIT 500",
    ],
    [
      "a literal holding an apostrophe and a comment marker",
      "SELECT q'[it's a -- note )]' AS s FROM dual",
      "SELECT q'[it's a LIMIT 500 -- note )]' AS s FROM dual",
      "SELECT q'[it's a -- note )]' AS s FROM dual LIMIT 500",
    ],
  ])("%s is read as a literal under Oracle's grammar only", (_label, sql, withoutDialect, underOracle) => {
    expect(applyQueryLimit(sql, 500).sql).toBe(withoutDialect);

    const result = applyQueryLimit(sql, 500, 0, {}, "oracle");
    expect(result.sql).toBe(underOracle);
    expect(result.wasLimited).toBe(true);
  });

  test("isSelectQuery takes the dialect too, so the multi-statement route agrees with the provider", () => {
    expect(isSelectQuery(HIDDEN_DELETE)).toBe(true);
    expect(isSelectQuery(HIDDEN_DELETE, "mysql")).toBe(false);
  });

  // A dialect with no established `#` rule keeps the default reading, and that is
  // an answer this milestone owes its readers rather than an accident.
  test("a dialect left at the compatibility default answers as a dialect-less call does", () => {
    expect(analyzeQuery(HIDDEN_DELETE, "druid").type).toBe("SELECT");
    expect(applyQueryLimit("SELECT * FROM t # note", 500, 0, {}, "couchbase").wasLimited).toBe(false);
  });
});

// ─── Where a block comment ends is the dialect's answer too (#300) ───────────
//
// The third grammar this channel carries, and the one whose cost is the same as
// the `#` row's worst case: a comment that NESTS ends later than the flat reading
// thinks, so a `)` written between the first `*/` and the comment's real end
// closes a CTE body that is still open. The statement is then typed by a keyword
// the operator commented out, and a bound appended to a write on PostgreSQL
// commits part of it.

describe("a nested block comment under the dialect that reads it", () => {
  // The `)` and the `SELECT` both sit AFTER the inner `*/`, which is the region a
  // flat reading hands over as code. With the whole comment read as one comment,
  // the CTE body runs to its real `)` and the statement is the write it operates.
  const hiddenWrite = (write: string) =>
    `WITH recent AS (\n  /* outer /* inner */ ) SELECT 1 */\n  SELECT id FROM logs\n)\n${write}`;

  test.each<[string, string, ParsedQueryInfo["type"]]>([
    ["an INSERT … SELECT", "INSERT INTO archive (id) SELECT id FROM recent", "INSERT"],
    ["an UPDATE … SET", "UPDATE archive SET seen = true WHERE id IN (SELECT id FROM recent)", "UPDATE"],
  ])("%s hidden behind a nested comment is typed as the write it is, and not bounded", (_label, write, type) => {
    const sql = hiddenWrite(write);

    // Today's answer without the dialect, kept: the flat reading really is what
    // MySQL does, and the statement is a syntax error there.
    expect(analyzeQuery(sql).type).toBe("SELECT");
    expect(analyzeQuery(sql, "mysql").type).toBe("SELECT");

    expect(analyzeQuery(sql, "postgres").type).toBe(type);

    const result = applyQueryLimit(sql, 500, 0, {}, "postgres");
    expect(result.sql).toBe(sql);
    expect(result.wasLimited).toBe(false);
  });

  // The read side of the same fact: with the comment read whole, the statement
  // behind it is an ordinary SELECT and collects its bound - and the bound goes
  // after the statement, never inside the comment.
  test("a read behind a nested comment is bounded, and the comment is emitted intact", () => {
    const sql = "/* outer /* inner */ still a note */ SELECT id FROM logs";

    expect(applyQueryLimit(sql, 500).wasLimited).toBe(false);

    expect(applyQueryLimit(sql, 500, 0, {}, "postgres")).toMatchObject({
      sql: "/* outer /* inner */ still a note */ SELECT id FROM logs LIMIT 500",
      wasLimited: true,
    });
  });

  // Fixture discipline (the milestone's rule): a nested comment written where no
  // reader models it as a unit - inside a dollar-quoted body, and inside a trailing
  // comment run - with the emitted text asserted whole rather than "a bound was
  // added".
  test.each<[string, string, string]>([
    [
      "a dollar-quoted body carrying a nested comment and a paren",
      "SELECT $fn$ /* a /* b */ ) $fn$ AS body FROM t",
      "SELECT $fn$ /* a /* b */ ) $fn$ AS body FROM t LIMIT 500",
    ],
    [
      "a trailing nested comment, where the bound goes before it",
      "SELECT id FROM logs /* a /* b */ c */",
      "SELECT id FROM logs LIMIT 500 /* a /* b */ c */",
    ],
  ])("%s is emitted intact under a nesting grammar", (_label, sql, expected) => {
    const result = applyQueryLimit(sql, 500, 0, {}, "postgres");

    expect(result.sql).toBe(expected);
    expect(result.wasLimited).toBe(true);
  });

  // One opener too many is undeterminable rather than guessed, so nothing is
  // rewritten - the fail-safe direction this folder keeps everywhere.
  test("a nested comment that never closes is not rewritten under a nesting grammar", () => {
    const sql = "/* outer /* inner */ SELECT id FROM logs";

    expect(applyQueryLimit(sql, 500, 0, {}, "postgres")).toMatchObject({ sql, wasLimited: false });
  });

  // Ordinary comments answer the same under both readings, which is what says the
  // change is confined to the runs where the grammars disagree.
  test.each<[string, string, string]>([
    ["one block comment", "/* note */ SELECT 1", "/* note */ SELECT 1 LIMIT 500"],
    ["adjacent block comments", "/*a*//*b*/SELECT 1", "/*a*//*b*/SELECT 1 LIMIT 500"],
    ["a comment holding a lone star", "/* a * b */ SELECT 1", "/* a * b */ SELECT 1 LIMIT 500"],
    ["a multi-line comment", "/* one\n   two */ SELECT 1", "/* one\n   two */ SELECT 1 LIMIT 500"],
  ])("%s keeps its answer under both readings", (_label, sql, expected) => {
    expect(applyQueryLimit(sql, 500).sql).toBe(expected);
    expect(applyQueryLimit(sql, 500, 0, {}, "postgres").sql).toBe(expected);
  });
});

// ─── S5: the whole-body probes read code only ────────────────────────────────
//
// The statement's TYPE stopped being fooled by a word written in a comment when
// the leading-keyword reader arrived (#275), and the end-anchored bound probes
// stopped being fooled by the trailing run when the statement-end reader did
// (#280). Three probes were left reading the whole body as characters: the Oracle
// ROWNUM bound, the UNION test and the nested-SELECT count. A mention of any of
// them mid-statement - in a line comment, a block comment, a string literal or a
// quoted identifier - answered for the statement, and for ROWNUM that answer is
// "already bounded", so the limiter skipped the bound and the full result set came
// back. They read through `lib/sql/words` now, which is the same span reader the
// rest of the module already shares.

describe("analyzeQuery: a mention in a comment or a literal is not the statement's code", () => {
  describe("the Oracle ROWNUM bound", () => {
    test.each<[string, string]>([
      ["a mid-statement line comment", "SELECT *\n-- try ROWNUM <= 10 here\nFROM huge_table WHERE active = 1"],
      ["a mid-statement block comment", "SELECT * FROM huge_table /* ROWNUM <= 10 */ WHERE active = 1"],
      ["a string literal", "SELECT * FROM huge_table WHERE note = 'ROWNUM <= 10'"],
      ["a quoted identifier", 'SELECT "ROWNUM <= 10" FROM huge_table'],
    ])("%s does not mark the statement bounded", (_label, sql) => {
      expect(analyzeQuery(sql).hasLimit).toBe(false);

      // The consequence the user sees: the bound is injected, so the statement
      // does not run unbounded.
      const result = applyQueryLimit(sql, 500);
      expect(result.wasLimited).toBe(true);
      expect(result.sql).toBe(`${sql} LIMIT 500`);
    });

    test.each<[string, string]>([
      ["written plainly", "SELECT * FROM t WHERE ROWNUM <= 10"],
      ["with no spaces", "SELECT * FROM t WHERE ROWNUM<10"],
      ["with a comment between the name and its comparison", "SELECT * FROM t WHERE ROWNUM /* n */ <= 10"],
      ["after a mention of the same words in a literal", "SELECT * FROM t WHERE n = 'ROWNUM <= 1' AND ROWNUM <= 10"],
    ])("a real bound %s is still detected", (_label, sql) => {
      expect(analyzeQuery(sql).hasLimit).toBe(true);
      expect(applyQueryLimit(sql, 500).wasLimited).toBe(false);
    });

    // Every code occurrence is asked, not just the first: the regex this replaced
    // scanned the whole body, so a bound written after another mention of the same
    // pseudo-column was found, and it still is.
    test("a bound after a non-bound mention of ROWNUM is found", () => {
      expect(analyzeQuery("SELECT ROWNUM AS rn FROM t WHERE ROWNUM <= 10").hasLimit).toBe(true);
    });

    // Between the name and its comparison only whitespace and comments are
    // trivia. A literal, a quoted identifier and a subscript are the statement's
    // own text, and this shape is valid PostgreSQL: `rownum` is an ordinary column
    // holding an array, so `rownum[1] <= 10` is not an Oracle row bound. A reader
    // that stepped over the subscript called the statement bounded and injected
    // nothing, and the whole table came back.
    test("a span between ROWNUM and its comparison is not stepped over", () => {
      const sql = "SELECT tags FROM t WHERE rownum[1] <= 10";

      expect(analyzeQuery(sql, "postgres").hasLimit).toBe(false);
      expect(applyQueryLimit(sql, 500, 0, {}, "postgres").sql).toBe(`${sql} LIMIT 500`);
    });

    test("a bare ROWNUM with no comparison is not a bound", () => {
      expect(analyzeQuery("SELECT ROWNUM, id FROM t").hasLimit).toBe(false);
      expect(analyzeQuery("SELECT * FROM t WHERE ROWNUM = 1").hasLimit).toBe(false);
      expect(analyzeQuery("SELECT * FROM t WHERE ROWNUM <= x").hasLimit).toBe(false);
      expect(analyzeQuery("SELECT * FROM t ORDER BY ROWNUM").hasLimit).toBe(false);
    });
  });

  describe("the UNION test", () => {
    test.each<[string, string]>([
      ["a mid-statement line comment", "SELECT id\n-- UNION ALL with archive later\nFROM users"],
      ["a mid-statement block comment", "SELECT id FROM users /* UNION archive */ WHERE active = 1"],
      ["a string literal", "SELECT id FROM users WHERE note = 'UNION'"],
      ["a quoted identifier", 'SELECT "UNION" FROM users'],
    ])("%s does not make the statement a union", (_label, sql) => {
      expect(analyzeQuery(sql).isUnion).toBe(false);
    });

    test.each<[string, string]>([
      ["a plain UNION", "SELECT 1 UNION SELECT 2"],
      ["UNION ALL", "SELECT 1 UNION ALL SELECT 2"],
      ["a UNION after a literal mentioning it", "SELECT n FROM a WHERE n = 'UNION' UNION SELECT n FROM b"],
    ])("%s is still a union", (_label, sql) => {
      expect(analyzeQuery(sql).isUnion).toBe(true);
    });
  });

  describe("the nested-SELECT count", () => {
    test.each<[string, string]>([
      ["a mid-statement line comment", "SELECT id\n-- SELECT was here\nFROM users"],
      ["a mid-statement block comment", "SELECT id FROM users /* SELECT id FROM archive */"],
      ["a string literal", "SELECT id FROM users WHERE note = 'SELECT 1'"],
      ["a quoted identifier", 'SELECT "SELECT" FROM users'],
    ])("%s is not a nested SELECT", (_label, sql) => {
      expect(analyzeQuery(sql).hasSubquery).toBe(false);
    });

    test.each<[string, string]>([
      ["a scalar subquery", "SELECT (SELECT 1) AS x"],
      ["an IN subquery", "SELECT id FROM users WHERE id IN (SELECT user_id FROM orders)"],
      ["a subquery after a literal mentioning one", "SELECT (SELECT 1) AS x FROM t WHERE n = 'SELECT 2'"],
    ])("%s still counts", (_label, sql) => {
      expect(analyzeQuery(sql).hasSubquery).toBe(true);
    });
  });

  // The fail-safe direction this module keeps everywhere: where a run does not
  // close, no reader over `lib/sql/spans` can say what is inside it, so the three
  // probes keep the whole-text reading they had rather than reporting the bound
  // as absent. `\'` is the shape that reaches this - the two dialect readings of
  // it put the end of the string in different places.
  describe("a run that never closes keeps the conservative reading", () => {
    test("a real ROWNUM bound behind an unresolvable literal is still reported", () => {
      const sql = "SELECT * FROM t WHERE name = 'O\\'Brien' AND ROWNUM <= 10";

      expect(analyzeQuery(sql).hasLimit).toBe(true);
      // Nothing is rewritten either way: the statement's end is undeterminable.
      expect(applyQueryLimit(sql, 500)).toMatchObject({ sql, wasLimited: false });
    });

    test("a real UNION behind an unresolvable literal is still reported", () => {
      expect(analyzeQuery("SELECT n FROM a WHERE n = 'O\\'Brien' UNION SELECT n FROM b").isUnion).toBe(true);
    });

    test("a real subquery behind an unresolvable literal is still reported", () => {
      expect(analyzeQuery("SELECT * FROM t WHERE n = 'O\\'Brien' AND id IN (SELECT id FROM u)").hasSubquery).toBe(true);
    });
  });

  // The dialect the module already receives decides which runs are not code, and
  // these probes now get the same answer as the rest of the module: `#` opens a
  // comment in MySQL and is an operator character in PostgreSQL, so the SAME text
  // is a note on one engine and the statement's own bound on the other.
  //
  // The `#` run sits MID-statement deliberately. Measured on the trailing form
  // (`SELECT * FROM t WHERE a = 1 # ROWNUM <= 10 is only a note\n`), both dialects
  // answer the same with and without the code-word reading above: `readStatementEnd`
  // already trims a trailing MySQL comment off the text these probes read, so that
  // shape is decided by the statement-end reader and pins nothing here. With the run
  // mid-statement the mysql arm flips - bounded before the change, unbounded after.
  test("which runs are comments is the dialect's answer here too", () => {
    const sql = "SELECT * FROM t WHERE a #> '{b}' AND ROWNUM <= 10";
    const commented = "SELECT * FROM t WHERE a = 1 # ROWNUM <= 10\nAND b = 2";

    expect(analyzeQuery(sql, "postgres").hasLimit).toBe(true);
    expect(analyzeQuery(commented, "mysql").hasLimit).toBe(false);
    expect(analyzeQuery(commented, "postgres").hasLimit).toBe(true);
  });
});
