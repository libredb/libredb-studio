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
