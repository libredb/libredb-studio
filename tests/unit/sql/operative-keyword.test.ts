import { describe, test, expect } from "bun:test";
import { resolveSqlGrammar, type SqlGrammar } from "@/lib/sql/grammar";
import { readOperativeKeyword } from "@/lib/sql/operative-keyword";

// ─── Helpers ────────────────────────────────────────────────────────────────

function operativeOf(sql: string, grammar?: SqlGrammar): string | null {
  return readOperativeKeyword(sql, grammar)?.keyword ?? null;
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
      // A CTE named with a word that is also a statement keyword. Reading the
      // list's grammar answers this; the alternative considered for #291 - "the
      // first statement keyword at paren depth 0" - would have read the NAME as
      // the operative keyword and cost this read its bound.
      ["a CTE named with a statement keyword", "WITH insert AS (SELECT 1) SELECT * FROM insert"],
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

  // ── ClickHouse's expression form ─────────────────────────────────────────
  //
  // `WITH <expr> AS <alias>` puts an expression where the standard form puts a
  // name, and on ClickHouse it is how a CTE is ordinarily written. The walker
  // #287 introduced recognised only the standard shape and answered null for
  // these, so the statement typed OTHER and lost its bound on the one engine
  // where an unbounded read hurts most (#291).
  //
  // The two shapes are told apart by what follows the element's `AS`: a body or
  // one of PostgreSQL's inlining hints can only be the standard form, anything
  // else is an alias. The expression itself is never parsed - the reader only has
  // to find where the element stops.

  describe("a CTE whose element is an expression", () => {
    test.each<[string, string]>([
      ["a scalar", "WITH 1 AS x SELECT x FROM t"],
      ["a negative scalar", "WITH -1 AS x SELECT x FROM t"],
      ["a string", "WITH 'nope' AS s SELECT s FROM t"],
      ["an array", "WITH [1, 2, 3] AS arr SELECT arrayJoin(arr)"],
      ["a function call", "WITH now() AS ts SELECT ts FROM t"],
      ["a function call with several arguments", "WITH concat(a, b) AS c SELECT c FROM t"],
      ["an arithmetic expression", "WITH x + 1 AS y SELECT y FROM t"],
      ["a parenthesised subquery", "WITH (SELECT max(id) FROM t) AS m SELECT m"],
      // `CAST`'s own `AS` sits inside its parens, so only a depth-aware reader
      // finds the element's own `AS` rather than that one.
      ["a CAST whose own AS is nested", "WITH CAST(1 AS Int32) AS n SELECT n"],
      ["several expression elements", "WITH 1 AS one, 2 AS two SELECT one + two"],
      ["an expression element after a standard one", "WITH t AS (SELECT 1), 2 AS two SELECT * FROM t"],
      ["a standard element after an expression one", "WITH 2 AS two, t AS (SELECT 1) SELECT * FROM t"],
      ["an aggregate over the alias", "WITH 1 AS one SELECT one, count(*) FROM events GROUP BY one"],
      ["a quoted alias", 'WITH now() AS "ts" SELECT * FROM events'],
      ["a comment before the operative keyword", "WITH 1 AS x /* note */ SELECT x"],
      ["a comment inside the expression", "WITH now() /* clock */ AS ts SELECT ts"],
    ])("reports SELECT for %s", (_label, sql) => {
      expect(operativeOf(sql)).toBe("SELECT");
    });

    // The direction that must not move: reading a new element shape may not let a
    // statement that WRITES be typed as a read. #287's whole cost was a bound
    // appended to a write, so each of these is asserted here as well as through
    // the standard-form fixtures above.
    test.each<[string, string, string]>([
      ["an INSERT after an expression element", "WITH 1 AS x INSERT INTO t VALUES (x)", "INSERT"],
      ["a DELETE after an expression element", "WITH now() AS ts DELETE FROM logs WHERE at < ts", "DELETE"],
      ["an UPDATE after a mixed CTE list", "WITH 1 AS x, s AS (SELECT id FROM t) UPDATE u SET a = x FROM s", "UPDATE"],
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
      // PostgreSQL's inlining hints exist only in the standard shape, so reading
      // one COMMITS the element to it: what follows must be a body, and a failure
      // there is malformed input rather than an expression element whose alias
      // happens to be the word `MATERIALIZED`.
      ["MATERIALIZED with no body", "WITH t AS MATERIALIZED SELECT 1"],
      ["NOT MATERIALIZED with no body", "WITH t AS NOT MATERIALIZED SELECT 1"],
      // The expression shape's own failures, each answering "cannot tell" rather
      // than guessing (#291).
      ["an expression element with no AS at all", "WITH 1 SELECT 2"],
      ["an expression element whose alias is missing", "WITH 1 AS"],
      ["an expression element whose alias is a literal", "WITH 1 AS 2 SELECT 3"],
      ["nothing after an expression element", "WITH now() AS ts"],
      ["an unclosed paren inside an expression", "WITH now( AS ts SELECT ts"],
      ["an unbalanced closing paren inside an expression", "WITH 1) AS x SELECT 2"],
      ["an unterminated string where an expression belongs", "WITH 'unclosed AS x SELECT 1"],
      ["an unterminated bracket where an expression belongs", "WITH [1, 2 AS arr SELECT 1"],
      ["an expression element that reaches a comma with no AS", "WITH 1, 2 AS two SELECT 1"],
      ["a comma with no further element after an expression one", "WITH 1 AS x, SELECT 2"],
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

    // KNOWN LIMITATION, pinned for the same reason: an expression element whose
    // head reads as a NAME and whose alias is one of PostgreSQL's inlining hints
    // (`WITH col AS materialized …`) is committed to the standard shape by that
    // word, so it is expected to carry a body and answers "cannot tell" without
    // one. A read loses its bound; nothing is made unsafe, and the alternative -
    // accepting the hint as an alias - would let `WITH t AS NOT LAZY (…)` read
    // `LAZY` as the keyword that operates the statement.
    test.each<[string, string]>([
      ["MATERIALIZED", "WITH col AS materialized SELECT materialized FROM t"],
      ["NOT", "WITH col AS not SELECT not FROM t"],
    ])("does not read %s used as an expression alias", (_label, sql) => {
      expect(readOperativeKeyword(sql)).toBeNull();
    });
  });

  // ── Recorded gaps in the UNSAFE direction ────────────────────────────────
  //
  // Everything above errs toward "cannot tell", which costs a bound. The inputs
  // below go the other way - they answer SELECT for text that writes - so they are
  // pinned here rather than left to be discovered. None is reachable in ordinary
  // use, and each is paid for on purpose; the reasoning lives in
  // `operative-keyword.ts` and `spans.ts`. A test that starts failing here means
  // someone closed a gap, which is welcome - update the expectation and say so.

  describe("known gaps that answer SELECT for a statement that writes", () => {
    // Oracle's alternate quoting is not a literal under a grammar that does not
    // have the form - which is every dialect but Oracle, and the compatibility
    // default - so the `)` inside this one closes the CTE body early and the
    // `SELECT` written inside the literal answers for the whole statement.
    test("walks an Oracle q-quoted literal as code where the grammar has no such form", () => {
      expect(operativeOf("WITH t AS (SELECT q'{it's ) SELECT x}' FROM dual) DELETE FROM users")).toBe("SELECT");
    });

    // …and that closes under Oracle's own grammar (#292). This is the direction
    // that matters: read as code, the statement types `SELECT` and the limiter
    // appends a bound to a `DELETE`; read as the literal it is, the keyword after
    // the CTE list is the one the statement operates.
    test("an alternate-quoting grammar reads the q-quoted body as the literal it is", () => {
      const oracle = resolveSqlGrammar("oracle");

      expect(operativeOf("WITH t AS (SELECT q'{it's ) SELECT x}' FROM dual) DELETE FROM users", oracle)).toBe("DELETE");
      expect(operativeOf("WITH t AS (SELECT q'{it's}' AS s FROM dual) SELECT * FROM t", oracle)).toBe("SELECT");
    });

    // The national-charset spelling reads the same way, asserted on the direction
    // that costs a partial write rather than a bound: a `SELECT` written inside the
    // literal must not answer for a statement that DELETEs.
    test("the national-charset spelling is read as a literal too", () => {
      const oracle = resolveSqlGrammar("oracle");

      expect(operativeOf("WITH t AS (SELECT nq'{it's ) SELECT x}' FROM dual) DELETE FROM users", oracle)).toBe(
        "DELETE",
      );
      expect(operativeOf("WITH t AS (SELECT NQ'{it's}' AS s FROM dual) SELECT * FROM t", oracle)).toBe("SELECT");
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

    // …and the gap CLOSES for a caller that names its dialect (#292). This is the
    // one shape in this family that costs a partially committed write - MySQL 8
    // accepts both `WITH … DELETE` and a `LIMIT` on a `DELETE` - so it is asserted
    // in both directions: the write is typed as a write under MySQL's grammar, and
    // the jsonb operator that the hybrid reading exists to protect still reads as
    // code under PostgreSQL's.
    test("a comment grammar reads the same statement as the DELETE it operates", () => {
      const sql = "WITH t AS (\n  #- drop the ) SELECT here\n  SELECT id FROM logs\n) DELETE FROM users";

      expect(operativeOf(sql, resolveSqlGrammar("mysql"))).toBe("DELETE");
    });

    test("a code grammar keeps a jsonb-operator CTE readable", () => {
      const postgres = resolveSqlGrammar("postgres");

      expect(operativeOf("WITH t AS (SELECT meta #> '{a}' AS v FROM docs) SELECT * FROM t", postgres)).toBe("SELECT");
      expect(operativeOf("WITH t AS (SELECT meta #- '{a}' AS v FROM docs) DELETE FROM users", postgres)).toBe("DELETE");
    });

    // Reading an expression means knowing where it ends only by its `AS`, so any
    // element the standard read DECLINES - a head that is not a name, or an `AS`
    // with no body after it - is re-read as an expression that ends at the first
    // `AS <name>` at depth 0, however far away. Each of these mentions a write and
    // answers SELECT, which is why it is pinned here - but none is accepted by any
    // dialect supported here (a CTE element is a name or an expression, and neither
    // is a statement), so the cost is a bound appended to text the server rejects
    // anyway, not a partial write (#291).
    test.each<[string, string]>([
      ["a literal head", "WITH 2 INSERT INTO users AS u SELECT 1"],
      ["a string head", "WITH 'a' INSERT INTO users AS u SELECT 1"],
      ["an empty parenthesised head", "WITH () INSERT INTO users AS u SELECT 1"],
      ["a name head whose AS never comes", "WITH 1 AS one, INSERT INTO t AS u SELECT one"],
      ["a statement keyword read as an alias", "WITH x AS DELETE, foo AS (SELECT 1) SELECT 1"],
    ])("reads %s as an expression element and answers for what follows", (_label, sql) => {
      expect(operativeOf(sql)).toBe("SELECT");
    });
  });

  // ── The bracket grammar (#295) ──────────────────────────────────────────
  //
  // `[…]` is a quoted NAME in SQL Server and SQLite and a nestable array or
  // subscript in ClickHouse, and the two readings are mutually exclusive: the
  // name reading ends the run at the first unpaired `]` (so one written inside a
  // string ends it early) while the subscript reading steps over literals and
  // counts depth (so a doubled `]` closes it rather than escaping). Each element
  // the walker cannot cross costs the statement its bound, which on ClickHouse -
  // the engine whose whole point is scanning more rows than a browser can hold -
  // is the entire cost.

  describe("a bracketed run under the dialect that owns it", () => {
    const CLICKHOUSE = resolveSqlGrammar("clickhouse");
    const MSSQL = resolveSqlGrammar("mssql");

    test.each<[string, string]>([
      ["a map subscript whose key text carries a close bracket", "WITH m['a]b'] AS v SELECT v"],
      ["a nested array element", "WITH [[1,2],[3,4]] AS a SELECT arrayJoin(a)"],
      ["an array holding a close bracket in a literal", "WITH ['a]', 'b'] AS a SELECT a"],
      ["a subscript chain", "WITH m['k']['j]'] AS v SELECT v"],
      // Syntax the reader models as neither of its two shapes: a lambda inside an
      // array literal, and a map literal whose key carries a close bracket.
      ["a lambda inside an array", "WITH arrayMap(x -> x, [1,2]) AS a SELECT a"],
      ["a map literal subscripted by a bracketed key", "WITH map('a]b', 1)['a]b'] AS v SELECT v"],
    ])("crosses %s and reports the operative keyword", (_label, sql) => {
      expect(operativeOf(sql, CLICKHOUSE)).toBe("SELECT");
    });

    test("still reads a bracket-quoted name as one name under the SQL Server grammar", () => {
      // The constraint that makes the naive fix wrong: everything between the
      // brackets is the NAME there, apostrophe included, and a doubled `]` is how
      // a bracket inside one is written. A scan that stepped over literals would
      // lose both.
      expect(operativeOf("WITH [it's] AS (SELECT 1) SELECT 1", MSSQL)).toBe("SELECT");
      expect(operativeOf("WITH [my]]cte] AS (SELECT 1) SELECT 1", MSSQL)).toBe("SELECT");
      expect(operativeOf("WITH [my cte] AS (SELECT 1) DELETE FROM users", MSSQL)).toBe("DELETE");
    });

    test("reports null where a subscript never closes", () => {
      // The fail-safe direction is unchanged: a run the reader cannot close is
      // undeterminable, so the statement is not typed as a read.
      expect(operativeOf("WITH [1,2 AS a SELECT 1", CLICKHOUSE)).toBeNull();
      expect(operativeOf("WITH [[1,2] AS a SELECT 1", CLICKHOUSE)).toBeNull();
      expect(operativeOf("WITH m['a] AS v SELECT v", CLICKHOUSE)).toBeNull();
    });

    test("crosses a deeply nested subscript in bounded time", () => {
      // Depth is counted, not matched by a regex: the scan advances one span or
      // one bracket at a time and cannot backtrack.
      const sql = `WITH ${"[".repeat(20000)}1${"]".repeat(20000)} AS a SELECT 1`;

      const started = performance.now();
      const keyword = operativeOf(sql, CLICKHOUSE);
      const elapsed = performance.now() - started;

      expect(keyword).toBe("SELECT");
      expect(elapsed, `took ${elapsed.toFixed(1)}ms`).toBeLessThan(200);
    });
  });

  // ── The block-comment grammar (#300) ────────────────────────────────────
  //
  // A comment that NESTS ends later than a flat reading thinks, and everything in
  // between is handed to this walker as code. A `)` written in that region closes
  // the CTE body early, so the statement is typed by a keyword the operator
  // commented out - and on PostgreSQL, where a `WITH … INSERT` really writes, the
  // bound that follows commits part of it.

  describe("a nested comment inside a CTE list", () => {
    const POSTGRES = resolveSqlGrammar("postgres");
    const MYSQL = resolveSqlGrammar("mysql");

    const HIDDEN_WRITE = (write: string) =>
      `WITH recent AS (\n  /* outer /* inner */ ) SELECT 1 */\n  SELECT id FROM logs\n)\n${write}`;

    test.each<[string, string]>([
      ["an INSERT", "INSERT INTO archive (id) SELECT id FROM recent"],
      ["an UPDATE", "UPDATE archive SET seen = true WHERE id IN (SELECT id FROM recent)"],
      ["a DELETE", "DELETE FROM archive WHERE id IN (SELECT id FROM recent)"],
    ])("reports %s under a nesting grammar, where the whole comment is a comment", (_label, write) => {
      expect(operativeOf(HIDDEN_WRITE(write), POSTGRES)).toBe(write.split(" ")[0]);
    });

    test("reports the keyword written inside the comment under a flat grammar", () => {
      // MySQL closes the comment at the first `*/`, so the `)` after it really does
      // end the CTE body there and `SELECT` really is the next word. The text is a
      // syntax error on MySQL either way; what matters is that the answer is the
      // dialect's own reading rather than a shared guess.
      expect(operativeOf(HIDDEN_WRITE("INSERT INTO archive (id) SELECT id FROM recent"), MYSQL)).toBe("SELECT");
    });

    test("reports null under a nesting grammar when the nested comment never closes", () => {
      const unclosed = "WITH recent AS (\n  /* outer /* inner */\n  SELECT id FROM logs\n) DELETE FROM users";

      expect(operativeOf(unclosed, POSTGRES)).toBeNull();
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
      // The expression shape is scanned from the element's start after the standard
      // read declines it, so every element is walked at most twice - a constant,
      // not a second dimension (#291).
      [
        "5k expression elements",
        `WITH ${Array.from({ length: 5000 }, (_v, i) => `${i} AS a${i}`).join(", ")} SELECT 1`,
        "SELECT",
      ],
      ["20k open parens inside an expression", `WITH now(${"(".repeat(20000)} AS ts SELECT ts`, null],
      ["20k close parens after an expression", `WITH 1 ${")".repeat(20000)} AS x SELECT 2`, null],
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
