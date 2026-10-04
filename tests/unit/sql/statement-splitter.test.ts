import { describe, test, expect } from "bun:test";
import {
  splitStatements,
  isMultiStatement,
  splitExecutionUnits,
  splitCursorTargets,
  unitIsModuleBody,
} from "@/lib/sql/statement-splitter";
import type { SplitStatement } from "@/lib/sql/statement-splitter";
import { resolveSqlGrammar } from "@/lib/sql/grammar";

// ─── Helpers ────────────────────────────────────────────────────────────────

function sqlsOf(result: SplitStatement[]): string[] {
  return result.map((s) => s.sql);
}

function linesOf(result: SplitStatement[]): number[] {
  return result.map((s) => s.startLine);
}

// ─── splitStatements ────────────────────────────────────────────────────────

describe("splitStatements", () => {
  // ── Single statement ────────────────────────────────────────────────────

  describe("single statement", () => {
    test("returns a single statement without semicolon", () => {
      const result = splitStatements("SELECT 1");
      expect(result).toHaveLength(1);
      expect(result[0].sql).toBe("SELECT 1");
      expect(result[0].startLine).toBe(0);
    });

    test("returns a single statement with semicolon", () => {
      const result = splitStatements("SELECT 1;");
      expect(result).toHaveLength(1);
      expect(result[0].sql).toBe("SELECT 1");
    });

    test("trims leading and trailing whitespace from statement", () => {
      const result = splitStatements("  SELECT 1  ;");
      expect(result).toHaveLength(1);
      expect(result[0].sql).toBe("SELECT 1");
    });

    test("handles trailing whitespace after semicolon", () => {
      const result = splitStatements("SELECT 1;   ");
      expect(result).toHaveLength(1);
      expect(result[0].sql).toBe("SELECT 1");
    });
  });

  // ── Multiple statements ─────────────────────────────────────────────────

  describe("multiple statements", () => {
    test("splits two statements on one line", () => {
      const result = splitStatements("SELECT 1; SELECT 2");
      expect(sqlsOf(result)).toEqual(["SELECT 1", "SELECT 2"]);
    });

    test("splits three statements", () => {
      const result = splitStatements("SELECT 1; SELECT 2; SELECT 3;");
      expect(result).toHaveLength(3);
      expect(sqlsOf(result)).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
    });

    test("splits statements separated by newlines", () => {
      const result = splitStatements("SELECT 1;\nSELECT 2;\nSELECT 3;");
      expect(result).toHaveLength(3);
    });

    test("handles consecutive semicolons (empty statements ignored)", () => {
      const result = splitStatements("SELECT 1;; ;SELECT 2;");
      expect(sqlsOf(result)).toEqual(["SELECT 1", "SELECT 2"]);
    });
  });

  // ── String literals ─────────────────────────────────────────────────────

  describe("single-quoted string literals", () => {
    test("does not split on semicolon inside single-quoted string", () => {
      const result = splitStatements("SELECT 'hello; world'");
      expect(result).toHaveLength(1);
      expect(result[0].sql).toBe("SELECT 'hello; world'");
    });

    test("handles escaped single quotes (double single-quote)", () => {
      const result = splitStatements("SELECT 'it''s'; SELECT 2");
      expect(result).toHaveLength(2);
      expect(result[0].sql).toBe("SELECT 'it''s'");
    });

    test("handles multiline string literal", () => {
      const result = splitStatements("SELECT 'line1\nline2'; SELECT 2");
      expect(result).toHaveLength(2);
    });

    test("handles unterminated single-quoted string (consumes rest)", () => {
      const result = splitStatements("SELECT 'unterminated; more");
      expect(result).toHaveLength(1);
      expect(result[0].sql).toContain("'unterminated; more");
    });
  });

  // ── Double-quoted identifiers ───────────────────────────────────────────

  describe("double-quoted identifiers", () => {
    test("does not split on semicolon inside double-quoted identifier", () => {
      const result = splitStatements('SELECT "col;name"');
      expect(result).toHaveLength(1);
      expect(result[0].sql).toBe('SELECT "col;name"');
    });

    test("handles escaped double quotes (doubled)", () => {
      const result = splitStatements('SELECT "col""name"; SELECT 2');
      expect(result).toHaveLength(2);
      expect(result[0].sql).toBe('SELECT "col""name"');
    });

    test("handles unterminated double-quoted identifier", () => {
      const result = splitStatements('SELECT "unterminated; stuff');
      expect(result).toHaveLength(1);
    });
  });

  // ── Single-line comments ────────────────────────────────────────────────

  describe("single-line comments (--)", () => {
    test("ignores semicolons in single-line comment", () => {
      const result = splitStatements("SELECT 1 -- comment;\nSELECT 2");
      // The comment is part of the first statement text,
      // the newline ends the comment, and SELECT 2 continues as same or next stmt.
      // Since there's no ; before the newline, both are one statement? No:
      // after --, it consumes to newline INCLUDING the newline, then 'SELECT 2'
      // is the remaining text which is a new block appended to current.
      // But there was no semicolon, so it's ONE statement containing the comment.
      // Actually re-reading: current += comment text including newline,
      // then continues reading SELECT 2 which appends to current.
      // No semicolons anywhere, so it's one big statement.
      expect(result).toHaveLength(1);
    });

    test("comment at end of statement before semicolon", () => {
      const result = splitStatements("SELECT 1; -- comment\nSELECT 2");
      expect(result).toHaveLength(2);
      expect(result[0].sql).toBe("SELECT 1");
    });

    test("handles comment as the only content (line-only)", () => {
      const result = splitStatements("-- just a comment");
      expect(result).toHaveLength(1);
      expect(result[0].sql).toBe("-- just a comment");
    });

    test("comment between statements", () => {
      const result = splitStatements("SELECT 1;\n-- comment\nSELECT 2;");
      expect(result).toHaveLength(2);
    });
  });

  // ── Multi-line comments ─────────────────────────────────────────────────

  describe("multi-line comments (/* */)", () => {
    test("ignores semicolons in multi-line comment", () => {
      const result = splitStatements("SELECT /* ; */ 1");
      expect(result).toHaveLength(1);
      expect(result[0].sql).toBe("SELECT /* ; */ 1");
    });

    test("multi-line comment spanning multiple lines", () => {
      const result = splitStatements("SELECT 1;\n/* this is\na multi\nline comment */\nSELECT 2;");
      expect(result).toHaveLength(2);
    });

    test("unterminated multi-line comment consumes rest", () => {
      const result = splitStatements("SELECT 1; /* unterminated");
      expect(result).toHaveLength(2);
      expect(result[0].sql).toBe("SELECT 1");
      expect(result[1].sql).toBe("/* unterminated");
    });

    test("comment before a statement", () => {
      const result = splitStatements("/* setup */ SELECT 1");
      expect(result).toHaveLength(1);
      expect(result[0].sql).toBe("/* setup */ SELECT 1");
    });
  });

  // ── Dollar-quoted strings ───────────────────────────────────────────────

  describe("dollar-quoted strings", () => {
    test("does not split on semicolon inside $$...$$", () => {
      const result = splitStatements("SELECT $$hello; world$$");
      expect(result).toHaveLength(1);
      expect(result[0].sql).toBe("SELECT $$hello; world$$");
    });

    test("handles $func$...$func$ tag", () => {
      const body = "BEGIN\n  RETURN x + 1;\nEND";
      const sql = `CREATE FUNCTION foo() RETURNS int AS $func$${body}$func$ LANGUAGE plpgsql; SELECT 1`;
      const result = splitStatements(sql);
      expect(result).toHaveLength(2);
      expect(result[0].sql).toContain("$func$");
      expect(result[1].sql).toBe("SELECT 1");
    });

    test("handles $body$...$body$ with semicolons inside", () => {
      const sql = "SELECT $body$INSERT INTO t VALUES (1);$body$; SELECT 2";
      const result = splitStatements(sql);
      expect(result).toHaveLength(2);
      expect(result[0].sql).toContain("$body$");
    });

    test("unterminated dollar-quoted string consumes rest", () => {
      const result = splitStatements("SELECT $$not closed; more text");
      expect(result).toHaveLength(1);
      expect(result[0].sql).toContain("$$not closed");
    });

    test("plain $ without matching tag is treated as regular char", () => {
      const result = splitStatements("SELECT $100; SELECT 2");
      expect(result).toHaveLength(2);
      expect(result[0].sql).toBe("SELECT $100");
    });
  });

  // ── Empty / whitespace ──────────────────────────────────────────────────

  describe("empty and whitespace input", () => {
    test("empty string returns empty array", () => {
      expect(splitStatements("")).toEqual([]);
    });

    test("whitespace only returns empty array", () => {
      expect(splitStatements("   \n\t\n  ")).toEqual([]);
    });

    test("semicolons only returns empty array", () => {
      expect(splitStatements(";;;")).toEqual([]);
    });
  });

  // ── Line number tracking ────────────────────────────────────────────────

  describe("startLine tracking", () => {
    test("first statement starts at line 0", () => {
      const result = splitStatements("SELECT 1;");
      expect(result[0].startLine).toBe(0);
    });

    test("second statement on next line starts at correct line", () => {
      const result = splitStatements("SELECT 1;\nSELECT 2;");
      expect(linesOf(result)).toEqual([0, 1]);
    });

    test("tracks lines with blank lines between statements", () => {
      const result = splitStatements("SELECT 1;\n\n\nSELECT 2;");
      expect(result[0].startLine).toBe(0);
      expect(result[1].startLine).toBe(3);
    });

    test("tracks lines across multiline statement", () => {
      const result = splitStatements("SELECT\n  1\n  FROM t;\nSELECT 2;");
      expect(result[0].startLine).toBe(0);
      expect(result[1].startLine).toBe(3);
    });

    test("tracks lines with comments spanning multiple lines", () => {
      // After "SELECT 1;", whitespace skip crosses the \n (line 1),
      // then the comment block starts — statementStartLine is set to 1.
      const result = splitStatements("SELECT 1;\n/* comment\nspanning\nlines */\nSELECT 2;");
      expect(result[0].startLine).toBe(0);
      expect(result[1].startLine).toBe(1);
    });

    test("tracks lines with single-line comments", () => {
      // After "SELECT 1;", whitespace skip crosses the \n (line 1),
      // then "-- skip" starts — statementStartLine is set to 1.
      const result = splitStatements("SELECT 1;\n-- skip\nSELECT 2;");
      expect(result[0].startLine).toBe(0);
      expect(result[1].startLine).toBe(1);
    });
  });

  // ── Mixed scenarios ─────────────────────────────────────────────────────

  describe("mixed comments, strings, and semicolons", () => {
    test("string with comment-like content", () => {
      const result = splitStatements("SELECT '-- not a comment'; SELECT 2");
      expect(result).toHaveLength(2);
      expect(result[0].sql).toBe("SELECT '-- not a comment'");
    });

    test("string with block comment-like content", () => {
      const result = splitStatements("SELECT '/* not */ a comment'; SELECT 2");
      expect(result).toHaveLength(2);
    });

    test("comment with string-like content", () => {
      const result = splitStatements("SELECT 1; -- 'not a string\nSELECT 2;");
      expect(result).toHaveLength(2);
    });

    test("complex real-world PL/pgSQL function", () => {
      const sql = [
        "CREATE OR REPLACE FUNCTION test() RETURNS void AS $$",
        "BEGIN",
        "  INSERT INTO log VALUES ('test; value');",
        "  -- comment with ;",
        "END;",
        "$$ LANGUAGE plpgsql;",
        "SELECT test();",
      ].join("\n");
      const result = splitStatements(sql);
      expect(result).toHaveLength(2);
      expect(result[1].sql).toBe("SELECT test()");
    });

    test("mix of double and single quotes with semicolons", () => {
      const sql = `SELECT "col;1", 'val;2'; SELECT 3`;
      const result = splitStatements(sql);
      expect(result).toHaveLength(2);
      expect(result[0].sql).toBe(`SELECT "col;1", 'val;2'`);
    });
  });
});

// ─── isMultiStatement ────────────────────────────────────────────────────────

describe("isMultiStatement", () => {
  test("returns false for single statement", () => {
    expect(isMultiStatement("SELECT 1")).toBe(false);
  });

  test("returns false for single statement with semicolon", () => {
    expect(isMultiStatement("SELECT 1;")).toBe(false);
  });

  test("returns true for two statements", () => {
    expect(isMultiStatement("SELECT 1; SELECT 2")).toBe(true);
  });

  test("returns false for empty input", () => {
    expect(isMultiStatement("")).toBe(false);
  });

  test("returns false for semicolons inside quotes", () => {
    expect(isMultiStatement("SELECT 'a;b'")).toBe(false);
  });

  test("returns true for statements separated by newlines", () => {
    expect(isMultiStatement("SELECT 1;\nSELECT 2;")).toBe(true);
  });
});

// ─── Dialect-blind splitting (S1) ────────────────────────────────────────────

/**
 * The splitter used to walk spans itself, and it knew none of the dialect facts
 * `grammar.ts` carries: `#` was code, `q'…'` was a name plus a string, `[…]` and
 * `` `…` `` were nothing at all, and a block comment was always flat. So it
 * disagreed with every other reader in this folder about which `;` is code, and
 * each disagreement cut one statement into fragments that `/api/db/multi-query`
 * then RAN one by one.
 *
 * Every shape below was measured against the engine that owns it rather than
 * argued from a document; the commands and their answers are quoted on the cases.
 */
describe("reads spans under the caller's dialect", () => {
  test("a ';' inside a MySQL hash comment does not split", () => {
    /*
      Measured on MySQL (container libredb-mysql): `#` runs to end of line, so the
      `;` is comment text. PostgreSQL gives `#` no comment meaning at all, so there
      the same `;` really is a boundary - which is why this is a dialect fact.
    */
    const sql = "SELECT 1 # note; not a statement\nFROM t";

    expect(sqlsOf(splitStatements(sql, resolveSqlGrammar("mysql")))).toEqual([sql]);
    expect(splitStatements(sql, resolveSqlGrammar("postgres"))).toHaveLength(2);
  });

  test("a ';' inside an Oracle q'{}' body does not split", () => {
    /*
      Measured on Oracle Free 23ai (container ldb-oracle-r5):
        SQL> SELECT q'{a'b;c}' AS body FROM dual;
        a'b;c
      One literal, one statement. Cut at that `;` the first fragment is
      `SELECT q'{a'b` - a syntax error - and the second is nonsense.
    */
    const sql = "SELECT q'{a'b;c}' AS body FROM dual";

    expect(sqlsOf(splitStatements(sql, resolveSqlGrammar("oracle")))).toEqual([sql]);
  });

  test("a ';' inside a bracket-quoted name does not split", () => {
    /*
      Measured on SQL Server 2022 (container ldb-mssql-r5):
        sqlcmd -Q "SELECT 1 AS [a;b]"  ->  1, "(1 rows affected)"
      So `[a;b]` is one column NAME and the text is one statement.
    */
    const sql = "SELECT 1 AS [a;b]";

    expect(sqlsOf(splitStatements(sql, resolveSqlGrammar("mssql")))).toEqual([sql]);
    expect(sqlsOf(splitStatements(sql, resolveSqlGrammar("sqlite")))).toEqual([sql]);
  });

  test("a ';' inside a PostgreSQL subscript key does not split", () => {
    // The same characters are a subscript there, and a literal inside one is a
    // literal - so this `;` is part of the key, not a boundary between statements.
    const sql = "SELECT j['a;b'] FROM t";

    expect(sqlsOf(splitStatements(sql, resolveSqlGrammar("postgres")))).toEqual([sql]);
  });

  test("a ';' inside a backtick-quoted name does not split", () => {
    /*
      Measured on MySQL (container libredb-mysql):
        mysql> SELECT 1 AS `a;b`;
        a;b
        1
      The old splitter read `'…'` and `"…"` but not backticks, so this cut in two.
    */
    const sql = "SELECT 1 AS `a;b`";

    expect(sqlsOf(splitStatements(sql, resolveSqlGrammar("mysql")))).toEqual([sql]);
  });

  test("a nesting dialect keeps the whole nested block comment together", () => {
    /*
      Measured, and the two answers are why this is a dialect fact rather than a
      reading the text could settle:
        postgres 18: SELECT /* a /* b *\/ 1 *\/ 2 AS pg_nests;  ->  2
        mysql:       the same text -> ERROR 1064 near '/ 2 AS mysql_flat'
      PostgreSQL closes the run at the SECOND `*\/`, MySQL at the first.
    */
    const sql = "/* a /* b */ ; DROP TABLE users; -- */ SELECT 1";

    expect(sqlsOf(splitStatements(sql, resolveSqlGrammar("postgres")))).toEqual([sql]);
    // MySQL's flat reading really does make that DROP a statement of its own -
    // measured, the table was gone - which is the other half of the fix: the
    // confirmation gate has to see the fragment (QuerySafetyDialog).
    expect(sqlsOf(splitStatements(sql, resolveSqlGrammar("mysql")))).toEqual([
      "/* a /* b */",
      "DROP TABLE users",
      "-- */ SELECT 1",
    ]);
  });

  test("the entry's attack yields no runnable bare DROP on PostgreSQL", () => {
    /*
      The sharp case, and the reason this is a safety fix rather than a tidy-up.
      Measured on postgres 18 (container libredb-postgres) the operator's own text
      is ONE read and the table survives it:
        psql -c "CREATE TABLE IF NOT EXISTS s1_users(id int);"
             -c "/* a /* b *\/ ; DROP TABLE s1_users; -- *\/ SELECT 1 AS ran;"
             -c "SELECT count(*) FROM pg_class WHERE relname='s1_users';"
        ran = 1, count = 1
      The dialect-blind splitter cut it into three and the multi-statement route ran
      fragment two: a bare `DROP TABLE users` the engine would have honoured.
    */
    const attack = "/* a /* b */ ; DROP TABLE users; -- */ SELECT 1";
    const fragments = splitStatements(attack, resolveSqlGrammar("postgres"));

    expect(fragments).toHaveLength(1);
    expect(isMultiStatement(attack, resolveSqlGrammar("postgres"))).toBe(false);
    expect(sqlsOf(fragments)).not.toContain("DROP TABLE users");
  });

  test("a call naming no dialect gets the compatibility grammar", () => {
    // The stated default, the same one every other reader here applies: `#` is a
    // comment unless it opens a PostgreSQL operator, `[…]` is a name, block
    // comments are flat, and there is no alternate quoting. Pinned so that it is a
    // decision rather than an accident.
    expect(splitStatements("SELECT 1 # note; two\nFROM t")).toHaveLength(1);
    expect(splitStatements("SELECT meta #> '{a}'; SELECT 2")).toHaveLength(2);
    expect(splitStatements("SELECT 1 AS [a;b]")).toHaveLength(1);
  });

  test("an undeterminable literal swallows the rest rather than inventing a boundary", () => {
    /*
      `spans.ts` reports any closing quote behind an odd backslash run as
      undeterminable, because MySQL escapes with backslashes and PostgreSQL does
      not and the two readings put the string's end in different places. The
      splitter inherits that: no boundary is invented inside text it cannot read,
      so the buffer stays one statement and takes the single-statement route. The
      confirmation gate already asks about this shape (#297).
    */
    const result = splitStatements("SELECT 'a\\'; DROP TABLE users");

    expect(result).toHaveLength(1);
    expect(result[0].sql).toBe("SELECT 'a\\'; DROP TABLE users");
  });

  test("startLine still counts newlines the dialect hid inside a span", () => {
    // The line counting is what the splitter wound its own scan around, so it is
    // asserted over a span the SHARED reader consumes: a MySQL hash comment.
    const result = splitStatements("SELECT 1 # a;b\n;\nSELECT 2", resolveSqlGrammar("mysql"));

    expect(sqlsOf(result)).toEqual(["SELECT 1 # a;b", "SELECT 2"]);
    expect(linesOf(result)).toEqual([0, 2]);
  });
});

// ── `//` hides a boundary on two shipped engines (S1 follow-up) ─────────────
//
// The reviewer's finding on S1: the entry closed the block-comment shape and left
// the same defect class alive on Cassandra and ScyllaDB, because CQL's third
// comment form was not a span. Reproduced 2026-08-25 over the native protocol -
// `SELECT release_version FROM system.local // note; DROP KEYSPACE nope\n` returns
// the ROW on Cassandra 5.0.9 and on ScyllaDB 2026.2.4 (which shares the
// `cassandra` type-id), and the DROP does not run: a bare `DROP KEYSPACE nope`
// answers "Keyspace 'nope' doesn't exist", so the OK proves the `//` hid both the
// `;` and the write. `/api/db/multi-query` loops over every fragment this returns,
// so a second fragment here is a statement the operator's text never contained.

describe("splitStatements: a `//` comment hides the boundary where the dialect has one", () => {
  const CASSANDRA = resolveSqlGrammar("cassandra");
  const CLICKHOUSE = resolveSqlGrammar("clickhouse");
  const POSTGRES = resolveSqlGrammar("postgres");

  test.each<[string, ReturnType<typeof resolveSqlGrammar>]>([
    ["cassandra", CASSANDRA],
    ["clickhouse", CLICKHOUSE],
  ])("no bare DROP is manufactured on %s", (_label, grammar) => {
    const buffer = "SELECT id FROM probe.customers // note; DROP TABLE probe.customers";
    const result = splitStatements(buffer, grammar);

    expect(sqlsOf(result)).toEqual([buffer]);
    expect(isMultiStatement(buffer, grammar)).toBe(false);
  });

  // The other direction, and it is the reason this is a per-dialect fact rather
  // than a widened reading: `//` is an OPERATOR NAME in PostgreSQL (measured on 18,
  // `SELECT 1 // 2` is "operator does not exist: integer // integer", not a syntax
  // error), so the `;` after it really is a boundary there and the second statement
  // really is the operator's own.
  test("a dialect without the form still splits at the same semicolon", () => {
    const result = splitStatements("SELECT id FROM t // note; DROP TABLE t", POSTGRES);

    expect(sqlsOf(result)).toEqual(["SELECT id FROM t // note", "DROP TABLE t"]);
  });

  test("a caller that names no dialect keeps today's reading, as a decision", () => {
    // Same rule as the `#` and `[…]` defaults: no reader here had a `//` branch
    // before this fact existed, so a dialect-less call answers what it answered.
    expect(splitStatements("SELECT id FROM t // note; DROP TABLE t")).toHaveLength(2);
  });

  test("startLine still counts the newlines a `//` comment carried", () => {
    const result = splitStatements("SELECT 1 // a;b\n;\nSELECT 2", CASSANDRA);

    expect(sqlsOf(result)).toEqual(["SELECT 1 // a;b", "SELECT 2"]);
    expect(linesOf(result)).toEqual([0, 2]);
  });
});

describe("splitStatements offsets", () => {
  // The offsets exist for the editor's cursor reader, so what they have to guarantee is
  // that slicing the original by them returns the statement verbatim - a caller that
  // re-derives the text from a line number cannot.
  test("slicing the input by a statement's offsets returns its own sql", () => {
    const input = "  SELECT 1;\n\n  SELECT 'a;b' AS x;\nDROP TABLE t";
    const statements = splitStatements(input);

    expect(statements).toHaveLength(3);
    for (const statement of statements) {
      expect(input.slice(statement.start, statement.end)).toBe(statement.sql);
    }
  });

  test("the offsets follow the dialect, not the raw semicolons", () => {
    // One statement under PostgreSQL's nesting rule; the `;` inside the comment is not a
    // boundary, so there is one span covering the whole buffer.
    const input = "/* a /* b */ ; DROP TABLE users; -- */ SELECT 1";
    const [only, ...rest] = splitStatements(input, resolveSqlGrammar("postgres"));

    expect(rest).toHaveLength(0);
    expect(input.slice(only!.start, only!.end)).toBe(input);
  });
});

// ── Procedural bodies, separator lines and batches (#1312) ──────────────────
//
// Measured in the end-to-end pass of 2026-10-03/04 before the `script` facts existed:
// Oracle 26ai Free 23.26.3 stored a procedure cut at its inner `;` INVALID (PLS-00103)
// while the route reported fragment 1 `success`; SQLite 3.50.4 answered "incomplete
// input" for a trigger and libSQL sqld 0.24.33 "unexpected end of input"; SQL Server 2025
// answered `Must declare the scalar variable "@x"` and `Incorrect syntax near 'GO'`.

describe("splitStatements: Oracle PL/SQL units", () => {
  const ORACLE = resolveSqlGrammar("oracle");

  test("a procedure is one statement and keeps the `;` after its END", () => {
    const procedure =
      "CREATE OR REPLACE PROCEDURE raise_sal(p_pct IN NUMBER) AS BEGIN UPDATE emp SET salary = salary * (1 + p_pct/100); END;";

    expect(sqlsOf(splitStatements(procedure, ORACLE))).toEqual([procedure]);
    expect(isMultiStatement(procedure, ORACLE)).toBe(false);
  });

  test("a trigger, an anonymous block and a plain statement after them are three statements", () => {
    const script = [
      "CREATE OR REPLACE TRIGGER trg_emp BEFORE INSERT ON emp FOR EACH ROW BEGIN :NEW.name := UPPER(:NEW.name); END;",
      "BEGIN raise_sal(10); END;",
      "SELECT * FROM emp;",
    ].join("\n");

    expect(sqlsOf(splitStatements(script, ORACLE))).toEqual([
      "CREATE OR REPLACE TRIGGER trg_emp BEFORE INSERT ON emp FOR EACH ROW BEGIN :NEW.name := UPPER(:NEW.name); END;",
      "BEGIN raise_sal(10); END;",
      // A plain statement still loses its `;`: oracledb refuses one that carries it.
      "SELECT * FROM emp",
    ]);
  });

  test("a DECLARE section shares its block's END", () => {
    const block = "DECLARE v NUMBER := 1; w NUMBER; BEGIN w := v + 1; END;";

    expect(sqlsOf(splitStatements(`${block}\nSELECT 1 FROM dual`, ORACLE))).toEqual([block, "SELECT 1 FROM dual"]);
  });

  test("IF, LOOP and CASE closers inside a body do not end it", () => {
    const fn = [
      "CREATE FUNCTION grade(p NUMBER) RETURN VARCHAR2 IS",
      "  r VARCHAR2(1);",
      "  CURSOR c IS SELECT id FROM emp;",
      "BEGIN",
      "  IF p IS NULL THEN RETURN NULL; END IF;",
      "  FOR x IN c LOOP NULL; END LOOP;",
      "  CASE WHEN p > 5 THEN r := 'A'; ELSE r := 'B'; END CASE;",
      "  r := CASE p WHEN 1 THEN 'X' ELSE r END;",
      "  BEGIN NULL; EXCEPTION WHEN OTHERS THEN NULL; END;",
      "  RETURN r;",
      "END grade;",
    ].join("\n");

    expect(sqlsOf(splitStatements(`${fn}\nSELECT grade(1) FROM dual;`, ORACLE))).toEqual([
      fn,
      "SELECT grade(1) FROM dual",
    ]);
  });

  test("a package spec and body, with nested routines and forward declarations", () => {
    const spec = "CREATE OR REPLACE PACKAGE pk AS PROCEDURE p(a IN NUMBER); FUNCTION f RETURN NUMBER; END pk;";
    const body = [
      "CREATE OR REPLACE PACKAGE BODY pk AS",
      "  PROCEDURE p(a IN NUMBER) IS BEGIN NULL; END p;",
      "  FUNCTION f RETURN NUMBER IS v NUMBER; BEGIN SELECT 1 INTO v FROM dual; RETURN v; END;",
      "BEGIN",
      "  NULL;",
      "END pk;",
    ].join("\n");

    expect(sqlsOf(splitStatements(`${spec}\n${body}`, ORACLE))).toEqual([spec, body]);
  });

  test("a type body is a unit and a type spec is plain SQL", () => {
    const spec = "CREATE TYPE pt AS OBJECT (x NUMBER, MEMBER FUNCTION len RETURN NUMBER)";
    const body = "CREATE TYPE BODY pt AS MEMBER FUNCTION len RETURN NUMBER IS BEGIN RETURN x; END; END;";

    expect(sqlsOf(splitStatements(`${spec};\n${body}`, ORACLE))).toEqual([spec, body]);
  });

  test("a CREATE of anything but a unit is plain SQL, cut at its `;`", () => {
    expect(sqlsOf(splitStatements("CREATE TABLE t (a NUMBER); BEGIN NULL; END;", ORACLE))).toEqual([
      "CREATE TABLE t (a NUMBER)",
      "BEGIN NULL; END;",
    ]);
  });

  test("an editionable unit is read past its modifiers", () => {
    const unit = "CREATE OR REPLACE EDITIONABLE PROCEDURE p AS BEGIN NULL; END;";

    expect(sqlsOf(splitStatements(unit, ORACLE))).toEqual([unit]);
  });

  test("a trigger whose body is a CALL has no block, so its `;` ends it as usual", () => {
    const script =
      "CREATE TRIGGER t BEFORE INSERT ON emp REFERENCING NEW AS n FOR EACH ROW CALL p(:n.id); SELECT 1 FROM dual";

    expect(sqlsOf(splitStatements(script, ORACLE))).toEqual([
      "CREATE TRIGGER t BEFORE INSERT ON emp REFERENCING NEW AS n FOR EACH ROW CALL p(:n.id)",
      "SELECT 1 FROM dual",
    ]);
  });

  test("words inside literals, comments and quoted names open nothing", () => {
    const block = `BEGIN INSERT INTO "END" VALUES ('END; BEGIN'); -- END;\nNULL; /* END; */ END;`;

    expect(sqlsOf(splitStatements(`${block} SELECT 1 FROM dual`, ORACLE))).toEqual([block, "SELECT 1 FROM dual"]);
  });

  test("a word glued to a number or an identifier is not a keyword", () => {
    expect(splitStatements("BEGIN x := 1END; y_begin := 2; END;", ORACLE)).toHaveLength(1);
  });

  test("a `/` line ends the unit and is never sent", () => {
    const script = "CREATE PROCEDURE p AS BEGIN NULL; END;\n/\nBEGIN p; END;\n  /  \nSELECT 1 FROM dual\n/";
    const result = splitStatements(script, ORACLE);

    expect(sqlsOf(result)).toEqual(["CREATE PROCEDURE p AS BEGIN NULL; END;", "BEGIN p; END;", "SELECT 1 FROM dual"]);
    expect(linesOf(result)).toEqual([0, 2, 4]);
  });

  test.each([
    "CREATE OR REPLACE FUNCTION f RETURN NUMBER AS LANGUAGE JAVA NAME 'x.y() return int'",
    'CREATE FUNCTION f RETURN NUMBER AS LANGUAGE C NAME "f" LIBRARY lib',
    'CREATE PROCEDURE p IS EXTERNAL NAME "p" LIBRARY lib',
    "CREATE FUNCTION f RETURN NUMBER AS MLE MODULE m SIGNATURE 'f()'",
  ])("a call spec has no body, so the script after it still splits: %s", (callSpec) => {
    // Its `;` stays: Oracle 26ai stored a Java call spec sent without it INVALID (PLS-00103).
    expect(sqlsOf(splitStatements(`${callSpec};\nSELECT 1 FROM dual; DELETE FROM t;`, ORACLE))).toEqual([
      `${callSpec};`,
      "SELECT 1 FROM dual",
      "DELETE FROM t",
    ]);
  });

  test.each(["language", "external", "mle"])("a declaration named %s is a declaration, not a call spec", (name) => {
    const unit = `CREATE PROCEDURE p AS ${name} VARCHAR2(10); BEGIN ${name} := 'x'; END;`;

    expect(sqlsOf(splitStatements(`${unit}\nSELECT 1 FROM dual`, ORACLE))).toEqual([unit, "SELECT 1 FROM dual"]);
  });

  test("a call spec word at the end of the input opens a declaration section, the fail-safe reading", () => {
    expect(splitStatements("CREATE PROCEDURE p AS LANGUAGE", ORACLE)).toHaveLength(1);
  });

  test("a compound trigger is one unit, each timing point a block of its own", () => {
    const trigger = [
      "CREATE OR REPLACE TRIGGER t FOR INSERT ON emp COMPOUND TRIGGER",
      "  v NUMBER;",
      "  BEFORE STATEMENT IS BEGIN v := 0; END BEFORE STATEMENT;",
      "  AFTER EACH ROW IS BEGIN v := v + 1; END AFTER EACH ROW;",
      "END t;",
    ].join("\n");

    expect(sqlsOf(splitStatements(`${trigger}\nSELECT 1 FROM dual`, ORACLE))).toEqual([trigger, "SELECT 1 FROM dual"]);
  });

  test("a labelled anonymous block is still a block", () => {
    const block = "<<outer>> BEGIN NULL; <<inner>> BEGIN NULL; END inner; END outer;";

    expect(sqlsOf(splitStatements(`${block}\nSELECT 1 FROM dual`, ORACLE))).toEqual([block, "SELECT 1 FROM dual"]);
  });

  test("a unit whose frames never close runs to the `/` line, SQL*Plus's own rule", () => {
    // An unclosed BEGIN stands in for any construct the reader does not model.
    const unclosed = "BEGIN NULL; IF x THEN NULL;";

    expect(sqlsOf(splitStatements(`${unclosed}\n/\nSELECT 1 FROM dual`, ORACLE))).toEqual([
      unclosed,
      "SELECT 1 FROM dual",
    ]);
  });

  test("one unit followed by `/` still has to be cut, so it takes the multi-statement route", () => {
    expect(isMultiStatement("BEGIN NULL; END;\n/", ORACLE)).toBe(true);
    expect(isMultiStatement("BEGIN NULL; END;", ORACLE)).toBe(false);
  });

  test("a `/` that is not alone on its line is division, and one inside a comment is text", () => {
    expect(sqlsOf(splitStatements("SELECT 10\n/ 2 FROM dual", ORACLE))).toEqual(["SELECT 10\n/ 2 FROM dual"]);
    expect(sqlsOf(splitStatements("SELECT 1 FROM dual /*\n/\n*/", ORACLE))).toEqual(["SELECT 1 FROM dual /*\n/\n*/"]);
  });

  test("an END with nothing after it closes the unit at the end of the input", () => {
    expect(sqlsOf(splitStatements("BEGIN NULL; END", ORACLE))).toEqual(["BEGIN NULL; END"]);
  });

  test("a stray END in a unit with no open frame is ignored", () => {
    expect(sqlsOf(splitStatements("CREATE TRIGGER t AFTER DROP ON SCHEMA END; SELECT 1 FROM dual", ORACLE))).toEqual([
      "CREATE TRIGGER t AFTER DROP ON SCHEMA END",
      "SELECT 1 FROM dual",
    ]);
  });
});

describe("splitStatements: SQLite and libSQL trigger bodies", () => {
  const SQLITE = resolveSqlGrammar("sqlite");

  test("a trigger is one statement, its END closing it", () => {
    const trigger =
      "CREATE TRIGGER trg_emp AFTER INSERT ON emp BEGIN UPDATE emp SET name = upper(NEW.name) WHERE id = NEW.id; END";

    expect(sqlsOf(splitStatements(`${trigger};`, SQLITE))).toEqual([trigger]);
    expect(splitStatements(`${trigger};`, resolveSqlGrammar("libsql"))).toHaveLength(1);
  });

  test("a CASE inside the body is not the body's END, and the rest of the script still splits", () => {
    const trigger = [
      "CREATE TEMP TRIGGER IF NOT EXISTS guard BEFORE DELETE ON emp",
      "BEGIN",
      "  SELECT CASE WHEN OLD.id = 1 THEN RAISE(ABORT, 'protected') END;",
      "  INSERT INTO log VALUES (OLD.id);",
      "END",
    ].join("\n");
    const script = `CREATE TABLE log (id INTEGER);\n${trigger};\nINSERT INTO emp VALUES (2, 'b');`;

    expect(sqlsOf(splitStatements(script, SQLITE))).toEqual([
      "CREATE TABLE log (id INTEGER)",
      trigger,
      "INSERT INTO emp VALUES (2, 'b')",
    ]);
  });

  test("a qualified `end` is a column, not the body's END", () => {
    const trigger = "CREATE TRIGGER tr AFTER INSERT ON t BEGIN UPDATE t SET a = NEW.end; DELETE FROM u; END";

    expect(sqlsOf(splitStatements(`${trigger}; SELECT 1`, SQLITE))).toEqual([trigger, "SELECT 1"]);
  });

  test("BEGIN is a transaction there, not a block", () => {
    expect(sqlsOf(splitStatements("BEGIN; INSERT INTO t VALUES (1); COMMIT;", SQLITE))).toEqual([
      "BEGIN",
      "INSERT INTO t VALUES (1)",
      "COMMIT",
    ]);
  });

  test("a CREATE that is not a trigger is plain", () => {
    expect(splitStatements("CREATE TEMPORARY TABLE t (a); CREATE VIEW v AS SELECT 1;", SQLITE)).toHaveLength(2);
  });
});

describe("splitStatements and splitExecutionUnits: T-SQL batches", () => {
  const MSSQL = resolveSqlGrammar("mssql");

  test("GO lines separate batches and are never sent", () => {
    const result = splitStatements("SELECT 1 AS a\nGO\nSELECT 2 AS b\ngo -- next\n", MSSQL);

    expect(sqlsOf(result)).toEqual(["SELECT 1 AS a", "SELECT 2 AS b"]);
    expect(linesOf(result)).toEqual([0, 2]);
    expect(isMultiStatement("SELECT 1\r\nGO\r\n", MSSQL)).toBe(true);
  });

  test("GO inside a literal, a comment or a longer word is not a separator, and neither is GO with a count", () => {
    for (const text of ["SELECT 'a\nGO\nb'", "SELECT 1 /*\nGO\n*/", "GOTO done", "SELECT 1\nGO 5"]) {
      expect(isMultiStatement(text, MSSQL)).toBe(false);
    }
  });

  test("a batch is ONE unit with its inner statements, so a variable survives to the SELECT", () => {
    const units = splitExecutionUnits("DECLARE @x INT = 5; SELECT @x * 2 AS doubled;", MSSQL);

    expect(units).toHaveLength(1);
    expect(units[0].sql).toBe("DECLARE @x INT = 5; SELECT @x * 2 AS doubled");
    expect(sqlsOf(units[0].statements)).toEqual(["DECLARE @x INT = 5", "SELECT @x * 2 AS doubled"]);
    // The statements are still two for the readers that ask about statements.
    expect(isMultiStatement("DECLARE @x INT = 5; SELECT @x * 2 AS doubled;", MSSQL)).toBe(true);
  });

  test("each GO-separated batch is its own unit, offsets and lines intact", () => {
    const input = "CREATE PROCEDURE p AS BEGIN SET NOCOUNT ON; SELECT 1; END;\nGO\n\nEXEC p;\nSELECT 2;\nGO";
    const units = splitExecutionUnits(input, MSSQL);

    expect(sqlsOf(units)).toEqual(["CREATE PROCEDURE p AS BEGIN SET NOCOUNT ON; SELECT 1; END", "EXEC p;\nSELECT 2"]);
    expect(linesOf(units)).toEqual([0, 3]);
    for (const unit of units) expect(input.slice(unit.start, unit.end)).toBe(unit.sql);
  });

  test.each([
    ["CREATE PROCEDURE p AS SELECT 1; SELECT 2", true],
    ["CREATE OR ALTER PROC p AS SELECT 1; SELECT 2", true],
    ["ALTER TRIGGER t ON a AFTER INSERT AS SELECT 1; SELECT 2", true],
    ["/* note */ CREATE VIEW v AS SELECT 1; SELECT 2", true],
    ["CREATE TABLE #t (a INT); SELECT * FROM #t", false],
    ["CREATE OR", false],
    ["(SELECT 1); SELECT 2", false],
  ])("%s is a module body: %s", (text, expected) => {
    expect(unitIsModuleBody(splitExecutionUnits(text, MSSQL)[0], MSSQL)).toBe(expected);
  });

  test("the cursor targets a run of statements one by one and a module body whole", () => {
    const input = "SELECT 1; DELETE FROM t\nGO\nCREATE PROCEDURE p AS SELECT 1; SELECT 2";

    expect(sqlsOf(splitCursorTargets(input, MSSQL))).toEqual([
      "SELECT 1",
      "DELETE FROM t",
      "CREATE PROCEDURE p AS SELECT 1; SELECT 2",
    ]);
    expect(sqlsOf(splitCursorTargets("SELECT 1; SELECT 2"))).toEqual(["SELECT 1", "SELECT 2"]);
  });

  test("an empty batch between two GO lines is no unit", () => {
    expect(splitExecutionUnits("GO\nGO\nSELECT 1\nGO\n\nGO", MSSQL)).toHaveLength(1);
  });
});

describe("splitExecutionUnits: one unit per statement where the unit is the statement", () => {
  test("PostgreSQL dollar-quoted bodies are untouched and every statement is its own unit", () => {
    const fn = "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql";
    const units = splitExecutionUnits(`${fn}; SELECT f();`, resolveSqlGrammar("postgres"));

    expect(sqlsOf(units)).toEqual([fn, "SELECT f()"]);
    expect(units.map((unit) => unit.statements.length)).toEqual([1, 1]);
  });

  test("the default grammar has no body, separator or batch", () => {
    expect(sqlsOf(splitExecutionUnits("BEGIN; SELECT 1;\nGO\n/"))).toEqual(["BEGIN", "SELECT 1", "GO\n/"]);
  });

  test("MySQL compound statements are not read yet, as recorded in BACKLOG S7", () => {
    expect(splitStatements("CREATE PROCEDURE p() BEGIN SELECT 1; END", resolveSqlGrammar("mysql"))).toHaveLength(2);
  });
});
