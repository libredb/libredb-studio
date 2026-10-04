/**
 * The `influxdb3` read policy (SPEC 5.4, E10, E17): one statement whose first keyword, behind
 * comments and opening parentheses, is one of six, read under the measured DataFusion grammar row,
 * and whose code holds no writing word, no `$` and no character outside ASCII (R35, R36).
 * The engine and the closed route table are the boundary on 3.x; this is the defence in depth before
 * them, so every refusal here is a request that is never sent.
 */
import { describe, expect, test } from "bun:test";
import {
  evaluateInfluxSql,
  INFLUX_SQL_MAX_TEXT_BYTES,
  INFLUX_SQL_POLICY_SENTENCES,
  type InfluxSqlKeyword,
  type InfluxSqlVerdict,
} from "@/lib/db/providers/timeseries/influxdb/sql-policy";

type Refusal = Extract<InfluxSqlVerdict, { allowed: false }>;

function refusalOf(text: string): Refusal {
  const verdict = evaluateInfluxSql(text);
  if (verdict.allowed) throw new Error(`expected ${JSON.stringify(text.slice(0, 80))} to be refused`);
  return verdict;
}

function writeWordRefusal(word: string): Refusal {
  return { allowed: false, reason: "write-word", message: INFLUX_SQL_POLICY_SENTENCES.writeWord(word) };
}

function dollarRefusal(line: number, column: number): Refusal {
  return { allowed: false, reason: "dollar", message: INFLUX_SQL_POLICY_SENTENCES.dollar(line, column) };
}

function nonAsciiRefusal(line: number, column: number): Refusal {
  return { allowed: false, reason: "non-ascii", message: INFLUX_SQL_POLICY_SENTENCES.nonAscii(line, column) };
}

const NOT_A_READ_PREFIX =
  "Only SELECT, WITH, VALUES, SHOW, EXPLAIN and DESCRIBE run on an InfluxDB 3 connection in Studio: this statement begins with ";

describe("INFLUX_SQL_POLICY_SENTENCES", () => {
  test("words every refusal as the spec does", () => {
    expect(INFLUX_SQL_POLICY_SENTENCES.empty).toBe("There is no statement to run.");
    expect(INFLUX_SQL_POLICY_SENTENCES.unterminated).toBe(
      "The statement has a string, a quoted name or a comment that never closes.",
    );
    expect(INFLUX_SQL_POLICY_SENTENCES.multipleStatements).toBe(
      "InfluxDB 3 runs one SQL statement per request; remove the text after the first `;`.",
    );
    expect(INFLUX_SQL_POLICY_SENTENCES.notARead("INSERT")).toBe(`${NOT_A_READ_PREFIX}INSERT.`);
    expect(INFLUX_SQL_POLICY_SENTENCES.writeWord("DELETE")).toBe(
      "This statement holds the word DELETE, which only a writing statement uses, and an InfluxDB 3 connection in Studio is read-only; if DELETE is a column or table name, write it in double quotes.",
    );
    expect(INFLUX_SQL_POLICY_SENTENCES.nonAscii(2, 14)).toBe(
      "This statement holds a character outside ASCII outside quotes (line 2, column 14); write names that need it in double quotes.",
    );
    expect(INFLUX_SQL_POLICY_SENTENCES.dollar(3, 7)).toBe(
      "This statement holds a `$` outside quotes (line 3, column 7): Studio sends no bound parameters and reads no dollar-quoted string on an InfluxDB 3 connection; write the value as a '...' string, and a name holding `$` in double quotes.",
    );
    expect(INFLUX_SQL_POLICY_SENTENCES.tooLong(1_048_577)).toBe(
      "This statement is 1,048,577 bytes; an InfluxDB 3 connection in Studio sends at most 1,048,576.",
    );
    expect(INFLUX_SQL_POLICY_SENTENCES.tooLong(12_345_678)).toContain("is 12,345,678 bytes");
    expect(INFLUX_SQL_POLICY_SENTENCES.tooLong(999)).toContain("is 999 bytes");
  });
});

describe("evaluateInfluxSql: the six read keywords", () => {
  test.each<[string, InfluxSqlKeyword]>([
    ["SELECT 1", "SELECT"],
    ["WITH a AS (SELECT 1) SELECT * FROM a", "WITH"],
    ["VALUES (1)", "VALUES"],
    ["SHOW TABLES", "SHOW"],
    ["EXPLAIN SELECT 1", "EXPLAIN"],
    ["DESCRIBE home", "DESCRIBE"],
    ["select 1", "SELECT"],
    ["with a as (select 1) select * from a", "WITH"],
    ["values (1)", "VALUES"],
    ["show tables", "SHOW"],
    ["explain select 1", "EXPLAIN"],
    ["describe home", "DESCRIBE"],
    ["  \n\tSeLeCt 1", "SELECT"],
  ])("%j is allowed as %s", (text, keyword) => {
    expect(evaluateInfluxSql(text)).toEqual({ allowed: true, keyword });
  });

  test("a keyword behind comments is read, and the block comment nests", () => {
    expect(evaluateInfluxSql("-- c\n/* a /* b */ c */ SELECT 1")).toEqual({ allowed: true, keyword: "SELECT" });
  });

  test("a keyword a nested comment hides is not the statement's", () => {
    // Read flat, the run would end at the first `*/` and the statement would lead with SELECT.
    expect(refusalOf("/* a /* b */ SELECT 1 */ SET x = 1")).toEqual({
      allowed: false,
      reason: "not-a-read",
      message: `${NOT_A_READ_PREFIX}SET.`,
    });
    expect(refusalOf("/* a /* b */ SELECT 1 */ DROP TABLE home")).toEqual(writeWordRefusal("DROP"));
  });

  test("a keyword behind opening parentheses is read", () => {
    expect(evaluateInfluxSql("((SELECT 1))")).toEqual({ allowed: true, keyword: "SELECT" });
    expect(evaluateInfluxSql("( /* a */ (\n-- c\n  select 1))")).toEqual({ allowed: true, keyword: "SELECT" });
    expect(evaluateInfluxSql("-- c\n(VALUES (1))")).toEqual({ allowed: true, keyword: "VALUES" });
  });

  test("a statement behind opening parentheses that is no read is refused with its word", () => {
    expect(refusalOf("((SET x = 1))").message).toBe(`${NOT_A_READ_PREFIX}SET.`);
    expect(refusalOf("((DELETE FROM home))")).toEqual(writeWordRefusal("DELETE"));
  });

  test("a whole word is read, so a longer word is not one of the six", () => {
    expect(refusalOf("SELECTED 1").message).toBe(`${NOT_A_READ_PREFIX}SELECTED.`);
  });
});

describe("evaluateInfluxSql: one statement", () => {
  test("a trailing `;` and a comment after it are one statement", () => {
    // Measured on 3.12.0: `SELECT 1 AS x; -- c` answers `{"x":1}`.
    expect(evaluateInfluxSql("SELECT 1 AS x; -- c")).toEqual({ allowed: true, keyword: "SELECT" });
    expect(evaluateInfluxSql("SELECT 1;")).toEqual({ allowed: true, keyword: "SELECT" });
    expect(evaluateInfluxSql("/* a */ ; SELECT 1 ; /* b /* c */ d */\n-- e\n")).toEqual({
      allowed: true,
      keyword: "SELECT",
    });
  });

  test("two statements are refused", () => {
    expect(refusalOf("SELECT 1; SELECT 2")).toEqual({
      allowed: false,
      reason: "multiple-statements",
      message: INFLUX_SQL_POLICY_SENTENCES.multipleStatements,
    });
    expect(refusalOf("SELECT 1; DROP TABLE home").reason).toBe("multiple-statements");
  });

  test("a `;` inside a string, a quoted name, a comment or an array is not a boundary", () => {
    expect(evaluateInfluxSql("SELECT 'a;b' AS \"x;y\" /* ; */ -- ;\n, ['c;d'][1]").allowed).toBe(true);
  });

  test("`#` is code, so it hides nothing: the `;` after it is a boundary", () => {
    expect(refusalOf("SELECT 1 # c ; DROP TABLE home").reason).toBe("multiple-statements");
    // On one line with no `;` the text is one statement, which the server refuses with a ParserError.
    expect(evaluateInfluxSql("SELECT 1 # c")).toEqual({ allowed: true, keyword: "SELECT" });
  });

  test("`//` is code, so the `;` after it is a boundary", () => {
    expect(refusalOf("SELECT 1 // c ; DROP TABLE home").reason).toBe("multiple-statements");
  });

  test("nothing to run", () => {
    const empty = { allowed: false, reason: "empty", message: "There is no statement to run." } as const;
    expect(refusalOf("")).toEqual(empty);
    expect(refusalOf("  \n\t ")).toEqual(empty);
    expect(refusalOf("-- only a comment")).toEqual(empty);
    expect(refusalOf("/* a */ ; ; -- b\n")).toEqual(empty);
  });
});

describe("evaluateInfluxSql: everything else is refused with its word", () => {
  test.each([
    ["INSERT INTO home VALUES (1)", "INSERT"],
    ["DELETE FROM home", "DELETE"],
    ["DROP TABLE home", "DROP"],
    ["CREATE TABLE t (a INT)", "CREATE"],
    ["COPY (SELECT 1) TO '/tmp/x.parquet'", "COPY"],
    ["update home set temp = 1", "UPDATE"],
    ["-- SELECT\ninsert into home values (1)", "INSERT"],
  ])("%j is refused for its writing word %s", (text, word) => {
    // The walk over the code runs before the leading keyword is read (R36), so a statement that leads
    // with a writing word is named by that rule.
    expect(refusalOf(text)).toEqual(writeWordRefusal(word));
  });

  test.each([
    ["SET x = 1", "SET"],
    ["ANALYZE home", "ANALYZE"],
    ["-- SELECT\nuse home", "USE"],
  ])("%j begins with %s", (text, word) => {
    expect(refusalOf(text)).toEqual({ allowed: false, reason: "not-a-read", message: `${NOT_A_READ_PREFIX}${word}.` });
  });

  test("a refusal echoes at most the first 32 characters of the leading word", () => {
    // The word is the user's own text, so a megabyte of it must not become a megabyte of message.
    expect(refusalOf(`${"X".repeat(32)} 1`).message).toBe(`${NOT_A_READ_PREFIX}${"X".repeat(32)}.`);
    expect(refusalOf(`${"X".repeat(33)} 1`).message).toBe(`${NOT_A_READ_PREFIX}${"X".repeat(32)}.`);
    expect(refusalOf("x".repeat(INFLUX_SQL_MAX_TEXT_BYTES)).message).toBe(`${NOT_A_READ_PREFIX}${"X".repeat(32)}.`);
  });

  test.each([["1 + 1"], ["'x'"], ['"home"'], ["()"], ["(("], ["[1,2]"], ["# c\n(SELECT 1)"]])(
    "%j begins with no keyword",
    (text) => {
      expect(refusalOf(text)).toEqual({
        allowed: false,
        reason: "not-a-read",
        message: `${NOT_A_READ_PREFIX}no keyword.`,
      });
    },
  );
});

/**
 * R35: the leading keyword says how a statement begins, not what it does. `WITH x AS (SELECT 1) DELETE
 * FROM t` begins with WITH and `EXPLAIN ANALYZE INSERT INTO t VALUES (1)` with EXPLAIN, and 3.12.0's
 * planner is what refuses them today. The policy does not rest on that: a writing word in the
 * statement's code, at any depth, is refused before any request.
 */
describe("evaluateInfluxSql: a writing word anywhere in the code (R35)", () => {
  const WRITE_WORDS = [
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
    "COPY",
    "CREATE",
    "DROP",
    "ALTER",
    "TRUNCATE",
    "GRANT",
    "REVOKE",
    "INTO",
  ];

  test("the two statements the leading keyword alone lets through are refused", () => {
    expect(refusalOf("WITH x AS (SELECT 1) DELETE FROM t")).toEqual(writeWordRefusal("DELETE"));
    // The first writing word is the one named.
    expect(refusalOf("EXPLAIN ANALYZE INSERT INTO t VALUES (1)")).toEqual(writeWordRefusal("INSERT"));
  });

  describe.each(WRITE_WORDS)("%s", (word: string) => {
    const lower = word.toLowerCase();
    const mixed = `${word[0]}${lower.slice(1)}`;

    test.each([
      ["bare at depth 0", `SELECT 1 FROM home ${word} t`],
      ["bare at depth 0, lower case", `SELECT 1 FROM home ${lower} t`],
      ["bare at depth 0, mixed case", `SELECT 1 FROM home ${mixed} t`],
      ["as the statement's last word", `SELECT 1 FROM home ${word}`],
      ["inside a CTE body", `WITH x AS (${word} t) SELECT * FROM x`],
      ["after a CTE list", `WITH x AS (SELECT 1) ${word} t`],
      ["after EXPLAIN ANALYZE", `EXPLAIN ANALYZE ${word} t`],
      ["inside a subquery", `SELECT * FROM (SELECT 1 FROM (${lower} t)) AS s`],
      ["inside an array literal", `SELECT [1, (${word} t)] AS a`],
      ["against punctuation", `SELECT 1,${word}(1)`],
      ["behind a dot", `SELECT home.${lower} FROM home`],
      ["behind a comment", `SELECT 1 /* c */${word}/* c */ t`],
    ])("is refused %s", (_where, text) => {
      expect(refusalOf(text)).toEqual(writeWordRefusal(word));
    });

    test.each([
      ["a string", `SELECT '${word} t' AS x, 'it''s ${lower}' AS y`],
      ["a double-quoted name", `SELECT "${word}", "a ""${lower}"" b" FROM home`],
      ["a backtick name", `SELECT \`${word}\` FROM home`],
      ["a line comment", `SELECT 1 -- ${word} t\n AS x`],
      ["a nested block comment", `SELECT 1 /* ${word} /* ${lower} */ ${word} */ AS x`],
      ["a string inside an array literal", `SELECT ['${word}', "${lower}"][1] AS x`],
    ])("is allowed inside %s", (_where, text) => {
      expect(evaluateInfluxSql(text)).toEqual({ allowed: true, keyword: "SELECT" });
    });

    test("is allowed as part of a longer name", () => {
      expect(
        evaluateInfluxSql(`SELECT ${lower}_at, x_${lower}, ${lower}d, ${lower}2, _${lower}, a.x_${lower} FROM home`),
      ).toEqual({
        allowed: true,
        keyword: "SELECT",
      });
    });
  });

  test.each([
    ["created_at"],
    ["updated"],
    ["insert_time"],
    ["date_trunc"],
    ["deleted_rows"],
    ["dropped"],
    ["copy_of"],
    ["merged"],
    ["into_x"],
    ["x_into"],
  ])("the name %s is no writing word", (name) => {
    expect(evaluateInfluxSql(`SELECT ${name} FROM home WHERE ${name} > 1`)).toEqual({
      allowed: true,
      keyword: "SELECT",
    });
    expect(evaluateInfluxSql(`SELECT date_trunc('hour', time) AS ${name} FROM home`)).toEqual({
      allowed: true,
      keyword: "SELECT",
    });
  });

  test("a writing word glued to a number is refused: the server reads the number and then the word", () => {
    // 3.12.0 reads `1e5into` as `1e5 INTO`. A digit before a word is a boundary, a digit after it is not.
    expect(refusalOf("SELECT 1e5into t")).toEqual(writeWordRefusal("INTO"));
    expect(refusalOf("SELECT 1insert")).toEqual(writeWordRefusal("INSERT"));
    expect(refusalOf("SELECT 1drop")).toEqual(writeWordRefusal("DROP"));
    expect(refusalOf("SELECT a1into")).toEqual(writeWordRefusal("INTO"));
    expect(evaluateInfluxSql("SELECT into1, drop_2 FROM home")).toEqual({ allowed: true, keyword: "SELECT" });
  });

  test.each([
    // R38, measured on 3.12.0: `0x` is a hex prefix that takes only hex digits, so `SELECT 0xinto t` is
    // `SELECT 0x INTO t` there and the `x` ends a token instead of joining a word.
    ["SELECT 0xinto t", "INTO"],
    ["EXPLAIN ANALYZE SELECT 0xinto t", "INTO"],
    ["WITH x AS (SELECT 1) SELECT 0xinsert", "INSERT"],
    ["SELECT 0xupdate", "UPDATE"],
    ["SELECT 0xdeinto t", "INTO"],
    ["SELECT 0XINTO t", "INTO"],
    ["SELECT 12drop", "DROP"],
    ["SELECT (0xdelete)", "DELETE"],
  ])("a run that starts with a digit and holds a writing word is refused: %s (R38)", (text, word) => {
    expect(refusalOf(text)).toEqual(writeWordRefusal(word));
  });

  test.each([
    ["SELECT 0x41 AS v"],
    ["SELECT 0xdeadbeef AS v"],
    ["SELECT 0x FROM home LIMIT 1"],
    ["SELECT a1b, x_into FROM home"],
    ["SELECT a0xinto FROM home"],
    ["SELECT 1e5 AS v, 12 AS twelve"],
  ])("a run that holds no writing word, or starts with a letter, is no writing word: %s (R38)", (text) => {
    expect(evaluateInfluxSql(text)).toEqual({ allowed: true, keyword: "SELECT" });
  });

  test("a megabyte run that starts with a digit is read in bounded time (R38)", () => {
    const started = performance.now();
    expect(evaluateInfluxSql(`SELECT 1${"a".repeat(INFLUX_SQL_MAX_TEXT_BYTES - 8)}`).allowed).toBe(true);
    expect(refusalOf(`SELECT 1${"a".repeat(INFLUX_SQL_MAX_TEXT_BYTES - 16)}into`).reason).toBe("write-word");
    expect(performance.now() - started).toBeLessThan(5000);
  });

  test("the fold is ASCII: the pattern takes no letter outside ASCII for one of its own", () => {
    // U+212A KELVIN SIGN folds to `k` and U+017F to `s` under a Unicode fold; neither reaches the word scan.
    expect(refusalOf("SELECT 1 AS \u017Felect").reason).toBe("non-ascii");
    expect(refusalOf("SELECT revo\u212Ae").reason).toBe("non-ascii");
  });

  test("SHOW CREATE TABLE is refused: the cost of the rule", () => {
    // Measured on 3.12.0: `SHOW CREATE TABLE home` answers one row. CREATE is on the list with no exception.
    expect(refusalOf("SHOW CREATE TABLE home")).toEqual(writeWordRefusal("CREATE"));
  });

  test("deeply nested array brackets and a megabyte of one word are read in bounded time", () => {
    const depth = 400_000;
    const started = performance.now();
    expect(evaluateInfluxSql(`SELECT ${"[".repeat(depth)}1${"]".repeat(depth)} AS a`).allowed).toBe(true);
    expect(refusalOf(`SELECT ${"[".repeat(depth)}drop${"]".repeat(depth)} AS a`).reason).toBe("write-word");
    expect(evaluateInfluxSql(`SELECT ${"a".repeat(INFLUX_SQL_MAX_TEXT_BYTES - 7)}`).allowed).toBe(true);
    expect(performance.now() - started).toBeLessThan(5000);
  });
});

/**
 * R36: two places where the server's tokenizer and any reader here can part ways are refused instead
 * of mirrored. A `$` directly after a name character is part of the name on 3.12.0 (`SELECT 1 AS a$$ ,
 * 2 AS b --$$` answers `{"a$$":1,"b":2}`) while the shared span reader opens a dollar string there, and
 * the server folds keywords with Unicode upper-casing (`ınsert ınto` with a dotless i is INSERT INTO).
 */
describe("evaluateInfluxSql: a `$` in the code (R36)", () => {
  test.each([
    ["WITH x AS (SELECT 1 AS a$$) DELETE FROM t --$$", 25],
    ["SELECT 1 AS a$$ INTO t --$$", 14],
    ["EXPLAIN ANALYZE SELECT 1 AS a$$; INSERT INTO t VALUES (1) --$$", 30],
    ["SELECT 1 AS a$b$ ; DROP TABLE t --$b$", 14],
    ["WITH x AS (SELECT 1 AS a@$$) DELETE FROM t --$$", 26],
    ["SELECT a$$ DELETE $$", 9],
    ["SELECT a$$ x $$ DELETE", 9],
    ["SELECT $$ DELETE $$ AS x", 8],
    ["SELECT 1, $tag$ drop $tag$", 11],
    ["SELECT $$x$$ AS s", 8],
    ["SELECT * FROM home WHERE room = $1", 33],
    ["SELECT a$x FROM home", 9],
    ["SELECT 1 $", 10],
  ])("%j is refused at column %d", (text, column) => {
    expect(refusalOf(text)).toEqual(dollarRefusal(1, column));
  });

  test("a `$` after a letter outside ASCII is behind that letter, which is refused first", () => {
    expect(refusalOf("WITH x AS (SELECT 1 AS \u00FC$$) DELETE FROM t --$$")).toEqual(nonAsciiRefusal(1, 24));
  });

  test("a `$` inside a string, a quoted name or a comment is text", () => {
    expect(
      evaluateInfluxSql("SELECT '$1 $$' AS \"a$$\", `b$` /* $$ */ FROM home -- $tag$\n WHERE ['$'][1] = 'x'"),
    ).toEqual({ allowed: true, keyword: "SELECT" });
  });

  test("the position is the one the editor shows: a 1-based line and column of the whole text", () => {
    expect(refusalOf("SELECT 1,\n  2,\r\n  $1")).toEqual(dollarRefusal(3, 3));
    expect(refusalOf("-- c\n\n  ;\n SELECT\n$1")).toEqual(dollarRefusal(5, 1));
    expect(refusalOf("SELECT 1\n$")).toEqual(dollarRefusal(2, 1));
  });

  test("the first of a writing word, a `$` and a character outside ASCII in text order decides", () => {
    expect(refusalOf("SELECT 1 INTO t WHERE a = $1")).toEqual(writeWordRefusal("INTO"));
    expect(refusalOf("SELECT $1 INTO t")).toEqual(dollarRefusal(1, 8));
    expect(refusalOf("SELECT \u00FC, $1 INTO t")).toEqual(nonAsciiRefusal(1, 8));
    expect(refusalOf("DROP TABLE \u00FC$")).toEqual(writeWordRefusal("DROP"));
    // All three run before the leading keyword is read.
    expect(refusalOf("SET x = $1")).toEqual(dollarRefusal(1, 9));
    expect(refusalOf("SET \u00FC = 1")).toEqual(nonAsciiRefusal(1, 5));
  });

  test("the statement count is read before the walk", () => {
    expect(refusalOf("SELECT 1; SELECT $1").reason).toBe("multiple-statements");
    expect(refusalOf("SELECT $$ never closes").reason).toBe("unterminated");
  });
});

describe("evaluateInfluxSql: a character outside ASCII in the code (R36)", () => {
  test.each([
    ["\u017Felect 1", 1],
    ["SELECT 1 l\u0131m\u0131t 1", 11],
    ["WITH x AS (SELECT 1) \u0131nsert \u0131nto t VALUES (1)", 22],
    ["select\u0131 1", 7],
    ["SELECT 1 AS \u00FCinto", 13],
    ["SELECT 1 AS \u00F6l\u00E7\u00FCm", 13],
    ["SELECT\u00A01", 7],
    ["SELECT 1 AS \uD83D\uDE00", 13],
    ["SELECT [\u00FC] FROM home", 9],
  ])("%j is refused at column %d", (text, column) => {
    expect(refusalOf(text)).toEqual(nonAsciiRefusal(1, column));
  });

  test("a character outside ASCII inside a string, a quoted name or a comment is text", () => {
    expect(
      evaluateInfluxSql(
        "SELECT '\u00F6l\u00E7\u00FCm', \"\u00F6l\u00E7\u00FCm\", `\u00F6l\u00E7\u00FCm` -- \u00F6l\u00E7\u00FCm",
      ),
    ).toEqual({
      allowed: true,
      keyword: "SELECT",
    });
    expect(evaluateInfluxSql('SELECT 1 AS "\u00FCinto" /* \u0131nsert */')).toEqual({
      allowed: true,
      keyword: "SELECT",
    });
  });

  test("the column counts UTF-16 units, as the editor does", () => {
    expect(refusalOf("SELECT '\uD83D\uDE00',\n '\uD83D\uDE00' AS \u00FC")).toEqual(nonAsciiRefusal(2, 10));
  });
});

describe("evaluateInfluxSql: text no reader can resolve", () => {
  test.each([
    ["SELECT 'unterminated"],
    ['SELECT "unterminated'],
    ["/* a /* b */ SELECT 1"],
    ["SELECT [1, 2"],
    ["SELECT 1; DROP TABLE home /* "],
  ])("%j never closes", (text) => {
    expect(refusalOf(text)).toEqual({
      allowed: false,
      reason: "unterminated",
      message: "The statement has a string, a quoted name or a comment that never closes.",
    });
  });

  test("a quote behind a backslash is refused rather than guessed at", () => {
    // Measured on 3.12.0: `SELECT E'a\'b' AS x` answers `{"x":"a'b"}`. The shared span reader cannot tell
    // that escape from the end of a plain string, so the policy fails closed on a read the server takes.
    expect(refusalOf("SELECT E'a\\'b' AS x").reason).toBe("unterminated");
    expect(refusalOf("SELECT E'\\'' AS x; SELECT 2 AS y; --'").reason).toBe("unterminated");
  });
});

describe("evaluateInfluxSql: the text cap (E10)", () => {
  const head = "SELECT '";

  test("the cap is 1 MiB", () => {
    expect(INFLUX_SQL_MAX_TEXT_BYTES).toBe(1_048_576);
  });

  test("1,048,576 bytes are allowed and 1,048,577 are refused", () => {
    const atCap = `${head}${"a".repeat(INFLUX_SQL_MAX_TEXT_BYTES - head.length - 1)}'`;
    expect(new TextEncoder().encode(atCap).length).toBe(1_048_576);
    expect(evaluateInfluxSql(atCap)).toEqual({ allowed: true, keyword: "SELECT" });

    expect(refusalOf(`${atCap} `)).toEqual({
      allowed: false,
      reason: "too-long",
      message: "This statement is 1,048,577 bytes; an InfluxDB 3 connection in Studio sends at most 1,048,576.",
    });
  });

  test("the cap counts bytes, not characters", () => {
    // 349,523 three-byte characters and nine ASCII ones: 1,048,578 bytes in 349,532 UTF-16 units.
    const text = `${head}${"€".repeat(349_523)}'`;
    expect(text.length).toBeLessThan(INFLUX_SQL_MAX_TEXT_BYTES);
    expect(refusalOf(text).reason).toBe("too-long");
  });

  test("the cap is read before anything else", () => {
    expect(refusalOf(`DROP TABLE '${"a".repeat(INFLUX_SQL_MAX_TEXT_BYTES)}`).reason).toBe("too-long");
  });

  test("a megabyte of opening parentheses is read in bounded time", () => {
    const started = performance.now();
    expect(refusalOf("(".repeat(INFLUX_SQL_MAX_TEXT_BYTES)).reason).toBe("not-a-read");
    expect(performance.now() - started).toBeLessThan(5000);
  });
});
