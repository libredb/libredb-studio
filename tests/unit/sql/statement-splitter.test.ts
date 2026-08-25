import { describe, test, expect } from "bun:test";
import { splitStatements, isMultiStatement } from "@/lib/sql/statement-splitter";
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
