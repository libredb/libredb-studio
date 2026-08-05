import { describe, test, expect } from "bun:test";
import { readOperativeKeyword } from "@/lib/sql/operative-keyword";

// ─── Helpers ────────────────────────────────────────────────────────────────

function operativeOf(sql: string): string | null {
  return readOperativeKeyword(sql)?.keyword ?? null;
}

// ─── readOperativeKeyword ───────────────────────────────────────────────────
//
// Which keyword actually OPERATES a statement. For everything but `WITH` that is
// the leading keyword; for a `WITH` it is the first keyword after the CTE list,
// because the CTE list is a preamble and the statement that follows it is the one
// the server executes. Typing a `WITH` by "does the text contain SELECT" made
// `WITH t AS (UPDATE …) INSERT INTO … SELECT …` look like a read, and the query
// limiter then appended a bound to the rows that statement WRITES (#287).

describe("readOperativeKeyword", () => {
  // ── Statements that are not CTEs ─────────────────────────────────────────

  describe("a statement that does not lead with WITH", () => {
    test.each<[string, string, string]>([
      ["SELECT", "SELECT * FROM t", "SELECT"],
      ["INSERT", "INSERT INTO t VALUES (1)", "INSERT"],
      ["UPDATE", "UPDATE t SET a = 1", "UPDATE"],
      ["a comment-led SELECT", "-- note\nSELECT 1", "SELECT"],
      ["a word that merely starts with WITH", "WITHDRAW 1", "WITHDRAW"],
    ])("reports the leading keyword of %s", (_label, sql, expected) => {
      expect(operativeOf(sql)).toBe(expected);
    });

    test("reports where the keyword is, so callers can slice the statement's own spelling", () => {
      const operative = readOperativeKeyword("/* note */ select 1");

      expect(operative).not.toBeNull();
      expect("/* note */ select 1".slice(operative?.start, operative?.end)).toBe("select");
    });

    test("reports null when there is no statement at all", () => {
      expect(readOperativeKeyword("")).toBeNull();
      expect(readOperativeKeyword("   \n ")).toBeNull();
      expect(readOperativeKeyword("-- just a note\n")).toBeNull();
    });
  });

  // ── Read-only CTEs ──────────────────────────────────────────────────────

  describe("a CTE whose operative statement reads", () => {
    test.each<[string, string]>([
      ["one CTE", "WITH t AS (SELECT 1) SELECT * FROM t"],
      ["lower case", "with t as (select 1) select * from t"],
      ["WITH RECURSIVE", "WITH RECURSIVE t AS (SELECT 1 UNION ALL SELECT 2) SELECT * FROM t"],
      ["several comma-separated CTEs", "WITH a AS (SELECT 1), b AS (SELECT 2) SELECT * FROM a, b"],
      ["a column list before AS", "WITH t (a, b) AS (SELECT 1, 2) SELECT * FROM t"],
      ["MATERIALIZED (PostgreSQL)", "WITH t AS MATERIALIZED (SELECT 1) SELECT * FROM t"],
      ["NOT MATERIALIZED (PostgreSQL)", "WITH t AS NOT MATERIALIZED (SELECT 1) SELECT * FROM t"],
      [
        "a nested CTE inside the definition",
        "WITH outer_q AS (WITH inner_q AS (SELECT 1) SELECT * FROM inner_q) SELECT * FROM outer_q",
      ],
      ["a double-quoted CTE name", 'WITH "my cte" AS (SELECT 1) SELECT * FROM "my cte"'],
      ["a backtick-quoted CTE name (MySQL)", "WITH `my cte` AS (SELECT 1) SELECT * FROM `my cte`"],
      ["a bracket-quoted CTE name (MSSQL)", "WITH [my cte] AS (SELECT 1) SELECT * FROM [my cte]"],
      ["a bracket-quoted name with MSSQL's ]] escape", "WITH [my]]cte] AS (SELECT 1) SELECT 1"],
      // A jsonb path operator inside a CTE body is an everyday PostgreSQL read.
      ["a jsonb path operator in the definition", "WITH t AS (SELECT meta #> '{a}' AS v FROM docs) SELECT * FROM t"],
      // A reader whose identifier alphabet is ASCII cannot walk past a localized
      // CTE name, and every statement it cannot walk loses its bound. This
      // project's own comments are Turkish, so these are not exotic inputs.
      ["a non-ASCII CTE name", "WITH müşteri AS (SELECT 1) SELECT * FROM müşteri"],
      ["a non-ASCII recursive CTE name", "WITH RECURSIVE ağaç AS (SELECT 1) SELECT * FROM ağaç"],
      ["a non-ASCII name among several CTEs", "WITH t AS (SELECT 1), ürün AS (SELECT 2) SELECT * FROM t, ürün"],
      ["a dollar in a CTE name (MySQL)", "WITH t$x AS (SELECT 1) SELECT * FROM t$x"],
      ["a subquery inside the definition", "WITH t AS (SELECT * FROM (SELECT 1) inner_q) SELECT * FROM t"],
      ["comments around the CTE list", "WITH /* a */ t AS /* b */ (SELECT 1) -- c\nSELECT * FROM t"],
      ["a newline before the operative keyword", "WITH t AS (\n  SELECT 1\n)\nSELECT * FROM t"],
      ["parens written inside a string literal", "WITH t AS (SELECT ') ) )' AS s) SELECT * FROM t"],
      ["parens written inside a comment", "WITH t AS (SELECT 1 -- ) ) )\n) SELECT * FROM t"],
      ["parens written inside a block comment", "WITH t AS (SELECT 1 /* ) ) */) SELECT * FROM t"],
      ["parens written inside a dollar-quoted body", "WITH t AS (SELECT $$ ) ) $$ AS s) SELECT * FROM t"],
      ["parens written inside a quoted identifier", 'WITH t AS (SELECT 1 AS ")wat") SELECT * FROM t'],
    ])("reports SELECT for %s", (_label, sql) => {
      expect(operativeOf(sql)).toBe("SELECT");
    });
  });

  // ── Writing CTEs ────────────────────────────────────────────────────────
  //
  // The defect itself: each of these supplies the word SELECT somewhere in its
  // body, and each one WRITES.

  describe("a CTE whose operative statement writes", () => {
    test.each<[string, string, string]>([
      [
        "INSERT ... SELECT after an UPDATE ... RETURNING CTE",
        "WITH t AS (UPDATE logs SET seen = true RETURNING id) INSERT INTO audit SELECT id FROM t",
        "INSERT",
      ],
      [
        "INSERT ... SELECT after a DELETE ... RETURNING CTE",
        "WITH gone AS (DELETE FROM sessions WHERE stale RETURNING id) INSERT INTO audit SELECT id FROM gone",
        "INSERT",
      ],
      [
        "UPDATE ... FROM a read-only CTE",
        "WITH stale AS (SELECT id FROM sessions WHERE expired) UPDATE users SET flag = 1 FROM stale",
        "UPDATE",
      ],
      [
        "DELETE ... USING a read-only CTE",
        "WITH doomed AS (SELECT id FROM sessions) DELETE FROM users USING doomed WHERE users.id = doomed.id",
        "DELETE",
      ],
      [
        "MERGE after a read-only CTE",
        "WITH src AS (SELECT 1 AS id) MERGE INTO target USING src ON target.id = src.id WHEN MATCHED THEN DELETE",
        "MERGE",
      ],
      [
        "a parenthesised subquery SELECT inside the definition of a writing CTE",
        "WITH t AS (UPDATE logs SET n = (SELECT count(*) FROM x) RETURNING id) INSERT INTO audit SELECT id FROM t",
        "INSERT",
      ],
      [
        "several CTEs before the write",
        "WITH a AS (SELECT 1), b AS (SELECT 2) INSERT INTO t SELECT * FROM a, b",
        "INSERT",
      ],
      [
        "a column list before AS on a writing CTE",
        "WITH t (id) AS (SELECT 1) DELETE FROM users WHERE id IN (SELECT id FROM t)",
        "DELETE",
      ],
      [
        "a comment between the CTE list and the write",
        "WITH t AS (SELECT 1) /* here comes the write */ INSERT INTO u SELECT * FROM t",
        "INSERT",
      ],
      ["lower case", "with t as (select 1) insert into u select * from t", "INSERT"],
    ])("reports the write keyword for %s", (_label, sql, expected) => {
      expect(operativeOf(sql)).toBe(expected);
    });
  });

  // ── Undeterminable input biases to "not a read" ──────────────────────────
  //
  // Every caller of this primitive uses "is it SELECT" to decide whether to
  // REWRITE the statement. Answering null (so: not SELECT) costs an unbounded
  // read; answering SELECT on a guess would cost a partially-committed write.
  // The ranking is not symmetric, so malformed input answers null.

  describe("input whose operative keyword cannot be determined", () => {
    test.each<[string, string]>([
      ["WITH on its own", "WITH"],
      ["WITH RECURSIVE on its own", "WITH RECURSIVE"],
      ["a CTE list that never closes its body", "WITH t AS (SELECT 1"],
      ["a CTE body with unbalanced parens", "WITH t AS ((SELECT 1) SELECT * FROM t"],
      ["nothing after the CTE list", "WITH t AS (SELECT 1)"],
      ["only a comment after the CTE list", "WITH t AS (SELECT 1) -- and then?"],
      ["a semicolon after the CTE list", "WITH t AS (SELECT 1);"],
      ["a missing AS", "WITH t (SELECT 1) SELECT 2"],
      ["a body that is not parenthesised", "WITH t AS SELECT 1"],
      ["NOT followed by something other than MATERIALIZED", "WITH t AS NOT LAZY (SELECT 1) SELECT 2"],
      ["an unterminated block comment inside the CTE list", "WITH t AS /* never closed (SELECT 1) SELECT 2"],
      ["an unterminated string inside the CTE body", "WITH t AS (SELECT 'never closed) SELECT 2"],
      ["an unterminated quoted CTE name", 'WITH "never closed AS (SELECT 1) SELECT 2'],
      ["an unterminated bracket CTE name", "WITH [never closed AS (SELECT 1) SELECT 2"],
      ["a string literal where the CTE name belongs", "WITH 'nope' AS (SELECT 1) SELECT 2"],
      ["a comma with no further CTE", "WITH a AS (SELECT 1), SELECT 2"],
      // Where a string literal ends is dialect-dependent when a backslash sits
      // before its closing quote, and the two readings disagree about the rest of
      // the statement. Under the MySQL reading this text is a DELETE, so guessing
      // the standard reading (which finds a `SELECT` inside what is really string
      // content) would bound a write - the failure #287 is about.
      ["a backslash-escaped quote inside a CTE body", "WITH t AS (SELECT '\\') SELECT ') DELETE FROM users"],
      // The same ambiguity where the escaped quote is FOLLOWED by another one -
      // how a MySQL string ending in an apostrophe is actually written. Under the
      // MySQL reading this statement is a DELETE; the standard reading finds a
      // `SELECT` that is really string content.
      [
        "a backslash-escaped quote followed by another quote",
        "WITH t AS (SELECT 'a\\'') DELETE FROM users WHERE note = ') SELECT 1'",
      ],
    ])("reports null for %s", (_label, sql) => {
      expect(readOperativeKeyword(sql)).toBeNull();
    });

    // KNOWN LIMITATION, asserted so it is a decision and not a surprise: the
    // PostgreSQL recursive-CTE clauses SEARCH and CYCLE sit BETWEEN the CTE list
    // and the operative statement, and this reader stops at the first word after
    // the list. It answers SEARCH, which is not SELECT, so such a statement is
    // simply not bounded - the honest direction. Widening the grammar to skip
    // these clauses is a separate change with its own tests.
    test("stops at a SEARCH clause rather than guessing past it", () => {
      const sql = "WITH RECURSIVE t AS (SELECT 1) SEARCH DEPTH FIRST BY id SET ord SELECT * FROM t";

      expect(operativeOf(sql)).toBe("SEARCH");
    });

    // KNOWN LIMITATION, pinned for the same reason: ClickHouse's `WITH <expr> AS
    // <alias>` puts an EXPRESSION where the standard form puts a name, and reading
    // one needs an expression parser rather than a grammar walk. These are reads,
    // and they lose their bound - a cost, not a hazard, and ClickHouse has no
    // data-modifying CTE for the safe direction to protect anything from.
    test.each<[string, string]>([
      ["a scalar", "WITH 1 AS x SELECT x FROM t"],
      ["an array", "WITH [1, 2, 3] AS arr SELECT arr FROM t"],
      ["a function call", "WITH now() AS ts SELECT ts FROM t"],
    ])("does not read ClickHouse's %s CTE form", (_label, sql) => {
      expect(readOperativeKeyword(sql)).toBeNull();
    });
  });

  // ── Recorded gaps in the UNSAFE direction ────────────────────────────────
  //
  // Everything above errs toward "cannot tell", which costs a bound. These two
  // inputs go the other way - they answer SELECT for text that writes - so they
  // are pinned here rather than left to be discovered. Neither is reachable in
  // ordinary use, and each is paid for on purpose; the reasoning lives in
  // `operative-keyword.ts` and `spans.ts`. A test that starts failing here means
  // someone closed a gap, which is welcome - update the expectation and say so.

  describe("known gaps that answer SELECT for a statement that writes", () => {
    // Oracle's alternative quoting is not a literal to `readSqlSpan`, so the `)`
    // inside this one closes the CTE body early. Unreachable in Oracle itself,
    // which has no `WITH … DELETE`, and no other dialect here has the form.
    test("walks an Oracle q-quoted literal as code", () => {
      expect(operativeOf("WITH t AS (SELECT q'{it's ) SELECT x}' FROM dual) DELETE FROM users")).toBe("SELECT");
    });

    // `#-` is a PostgreSQL jsonb operator and a MySQL comment opener at once.
    // Reading it as code is what keeps `SELECT meta #> '{a}'` bounded; the price
    // is that a MySQL comment opening with those characters is read as SQL, so a
    // paren inside it ends the CTE body early. MySQL 8 accepts both `WITH … DELETE`
    // and `LIMIT` on a `DELETE`, so this really is the bad direction - it is
    // contrived rather than impossible, and closing it would cost every
    // jsonb-operator CTE its bound.
    test("walks a MySQL hash comment opening with an operator character as code", () => {
      const sql = "WITH t AS (\n  #- drop the ) SELECT here\n  SELECT id FROM logs\n) DELETE FROM users";

      expect(operativeOf(sql)).toBe("SELECT");
    });

    // The same statement with an ordinary `# ` comment - how they are actually
    // written - reads correctly, which is what makes the gap narrow.
    test("reads the same statement correctly when the comment opens plainly", () => {
      const sql = "WITH t AS (\n  # drop the ) SELECT here\n  SELECT id FROM logs\n) DELETE FROM users";

      expect(operativeOf(sql)).toBe("DELETE");
    });
  });

  // ── Bounded time ────────────────────────────────────────────────────────
  //
  // The CTE-list scan is a character scanner rather than a regex over
  // parenthesised bodies for the reason `leading-keyword.ts` documents in
  // measured detail: a nested quantifier over that shape backtracks
  // catastrophically (its predecessors cost 958ms, 852ms and - exponentially -
  // 634ms on a 49-character input). This guard fails outright if the scan is
  // ever replaced by one that can backtrack, and it asserts the ANSWER too,
  // because a fast wrong answer is not a pass.

  test("answers in bounded time on adversarial input", () => {
    const BOUND_MS = 200;
    const adversarial: [string, string, string | null][] = [
      ["20k unbalanced open parens", `WITH t AS ${"(".repeat(20000)}`, null],
      ["20k unbalanced close parens", `WITH t AS ${")".repeat(20000)}`, null],
      ["20k deeply nested parens", `WITH t AS ${"(".repeat(20000)}SELECT 1${")".repeat(20000)} SELECT 2`, "SELECT"],
      ["20k unterminated quotes", `WITH t AS (SELECT ${"'".repeat(20001)}`, null],
      ["20k dashes", `WITH t AS (SELECT 1) ${"-".repeat(20000)}`, null],
      ["2k empty block comments", `WITH t AS (SELECT 1) ${"/**/".repeat(2000)}INSERT INTO u VALUES (1)`, "INSERT"],
      [
        "5k CTEs",
        `WITH ${Array.from({ length: 5000 }, (_v, i) => `t${i} AS (SELECT ${i})`).join(", ")} SELECT 1`,
        "SELECT",
      ],
      ["20k whitespace inside the CTE list", `WITH t AS ${" ".repeat(20000)}(SELECT 1) SELECT 2`, "SELECT"],
    ];

    for (const [label, sql, expected] of adversarial) {
      const started = performance.now();
      const keyword = operativeOf(sql);
      const elapsed = performance.now() - started;

      expect(keyword, label).toBe(expected);
      expect(elapsed, `${label} took ${elapsed.toFixed(1)}ms`).toBeLessThan(BOUND_MS);
    }
  });
});
