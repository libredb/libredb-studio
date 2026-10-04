/**
 * The InfluxQL read policy (SPEC 5.3, E2, E3, E9, E10, E13, R17, R31, R32).
 *
 * On 1.x and 2.x this policy is the only boundary between a Studio user and `DROP DATABASE`, so
 * every refusal is held to its exact reason and sentence, the step order is pinned (the text cap,
 * then Flux before a lexical fault, a fault before the statement count), and each measured bypass
 * of a plausible lexer (J1 1.2, B1 to B5, and the R32 comment shape) is refused here. The
 * `namedDatabases` cases mirror `parseSources` and `parseSegmentedIdents` of influxql v1.4.1, one
 * per form: a database the reader misses is one the `_internal` rule never sees.
 */
import { describe, expect, test } from "bun:test";
import {
  evaluateInfluxql,
  INFLUXQL_DESTRUCTIVE_OPERATIONS,
  INFLUXQL_MAX_TEXT_BYTES,
  INFLUXQL_POLICY_SENTENCES,
  type InfluxqlRefusalReason,
  influxqlRefusal,
  readInfluxqlOperations,
} from "@/lib/db/providers/timeseries/influxdb/influxql-policy";

const FLUX_SENTENCE =
  "This is Flux, which Studio does not run: Flux can make the server open network connections even with a read-only token. Write it in InfluxQL; docs/providers/influxdb.md, section Coming from InfluxDB 2.x and Flux, has a translation table.";
const INTO_SENTENCE = "SELECT ... INTO writes into a measurement, which Studio does not do.";
const BOUND_SENTENCE = "Studio does not send bound parameters; write the value in the statement.";
const EMPTY_SENTENCE = "There is no statement to run.";

/** The refusal of a text as `[reason, message]`; fails when the text is allowed. */
function refusal(text: string): [InfluxqlRefusalReason, string] {
  const verdict = evaluateInfluxql(text);
  if (verdict.allowed) throw new Error(`allowed: ${text}`);
  return [verdict.reason, verdict.message];
}

/** The databases an allowed text names; fails when the text is refused. */
function named(text: string): readonly string[] {
  const verdict = evaluateInfluxql(text);
  if (!verdict.allowed) throw new Error(`refused: ${verdict.message}`);
  return verdict.namedDatabases;
}

const multiple = (line: number, column: number): [InfluxqlRefusalReason, string] => [
  "multiple-statements",
  `InfluxQL runs one statement at a time here; remove the text after the first \`;\` (line ${line}, column ${column}).`,
];

const notARead = (word: string): [InfluxqlRefusalReason, string] => [
  "not-a-read",
  `Only SELECT, SHOW and EXPLAIN statements run on an InfluxDB connection in Studio: this one begins with ${word}.`,
];

const explainTarget = (word: string): [InfluxqlRefusalReason, string] => [
  "not-a-read",
  `EXPLAIN runs here only before SELECT or SHOW: this one is followed by ${word}.`,
];

describe("evaluateInfluxql: what runs", () => {
  test.each([
    ['SELECT * FROM "home".."home" WHERE time > now() - 1h ORDER BY time DESC LIMIT 50', "SELECT", ["home"]],
    ["SHOW DATABASES", "SHOW", []],
    ['SHOW MEASUREMENTS ON "home"', "SHOW", ["home"]],
    ['SHOW MEASUREMENTS ON "db" WITH MEASUREMENT = /cpu.*/', "SHOW", ["db"]],
    ["EXPLAIN SELECT * FROM x", "EXPLAIN", []],
    ['EXPLAIN SELECT * FROM "db".."m"', "EXPLAIN", ["db"]],
    ['EXPLAIN ANALYZE SELECT * FROM "db".."m"', "EXPLAIN", ["db"]],
    ['EXPLAIN ANALYZE VERBOSE SELECT * FROM "db".."m"', "EXPLAIN", ["db"]],
    ['explain analyze verbose select * from "db".."m"', "EXPLAIN", ["db"]],
    ['EXPLAIN VERBOSE SELECT * FROM "db".."m"', "EXPLAIN", ["db"]],
    ['EXPLAIN /* c */ SELECT * FROM "db".."m"', "EXPLAIN", ["db"]],
    ['EXPLAIN -- c\nANALYZE /* c */ VERBOSE\n SELECT * FROM "db".."m";', "EXPLAIN", ["db"]],
    ['EXPLAIN SHOW MEASUREMENTS ON "db"', "EXPLAIN", ["db"]],
    ["SELECT 1;", "SELECT", []],
    ["SELECT 1;  -- c", "SELECT", []],
    ['SELECT "into" FROM x', "SELECT", []],
    ["SELECT * FROM x WHERE a =~ /a\\/b/", "SELECT", []],
    ["SELECT 1/2 FROM x", "SELECT", []],
    ["/* c */ SELECT 1", "SELECT", []],
    ["select 1 | 2 from x", "SELECT", []],
    ["SELECT /* c */ x FROM /* c */ m", "SELECT", []],
  ] as const)("%s", (text, statement, namedDatabases) => {
    expect(evaluateInfluxql(text)).toEqual({ allowed: true, statement, namedDatabases: [...namedDatabases] });
  });
});

describe("evaluateInfluxql: the ten steps, in order", () => {
  test("step 0: the text cap counts bytes, before anything else", () => {
    // 11 + 3 * 21841 + 2 = 65,536 bytes; the three-byte characters sit inside a comment.
    const atCap = `SELECT 1 /*${"€".repeat(21841)}*/`;
    expect(new TextEncoder().encode(atCap).length).toBe(INFLUXQL_MAX_TEXT_BYTES);
    expect(evaluateInfluxql(atCap)).toEqual({ allowed: true, statement: "SELECT", namedDatabases: [] });
    expect(refusal(`${atCap} `)).toEqual([
      "too-long",
      "This statement is 65,537 bytes; an InfluxDB connection in Studio sends at most 65,536.",
    ]);
    // Flux, a fault and a second statement in a text over the cap: the cap still decides.
    const [reason] = refusal(`x |> y { ; DROP DATABASE d ${"a".repeat(INFLUXQL_MAX_TEXT_BYTES)}`);
    expect(reason).toBe("too-long");
    expect(INFLUXQL_POLICY_SENTENCES.tooLong(1234567)).toBe(
      "This statement is 1,234,567 bytes; an InfluxDB connection in Studio sends at most 65,536.",
    );
  });

  test.each(["", "  \n\t ", "-- only a comment", "/* c */ -- d", "\r\n"])("step 3: %j holds no statement", (text) => {
    expect(refusal(text)).toEqual(["empty", EMPTY_SENTENCE]);
  });

  test.each([
    'from(bucket: "b") |> range(start: -1h)',
    'from (bucket: "b")',
    'import "sql"',
    "x |> y",
    "SELECT 1 |> 2",
    // Flux before a lexical fault: the record braces are illegal characters in InfluxQL.
    'from(bucket: "b") |> filter(fn: (r) => r._value > {a: 1})',
    'x |> map(fn: (r) => ({ r with v: "open',
    // Flux before the statement count and the bound parameter.
    "a |> b; $c",
  ])("step 4: %s is Flux", (text) => {
    expect(refusal(text)).toEqual(["flux", FLUX_SENTENCE]);
  });

  test("step 4: a leading FROM or import that is not Flux falls through to the first-keyword rule", () => {
    expect(refusal("from x")).toEqual(notARead("FROM"));
    expect(refusal("from(x)")).toEqual(notARead("FROM"));
    expect(refusal("from(bucket)")).toEqual(notARead("FROM"));
    expect(refusal("import x")).toEqual(notARead("a symbol"));
    expect(refusal("import")).toEqual(notARead("a symbol"));
  });

  test.each([
    ["SELECT 1\u0000", "The statement holds a control character at line 1, column 9, which Studio does not send."],
    ["SELECT 'a\u0001b'", "The statement holds a control character at line 1, column 10, which Studio does not send."],
    [
      "SELECT 1 -- c\u007f",
      "The statement holds a control character at line 1, column 14, which Studio does not send.",
    ],
    [
      "SELECT é FROM x",
      "The statement holds a character outside ASCII at line 1, column 8, outside quotes, which InfluxQL does not read.",
    ],
    [
      "SELECT * FROM x WHERE time > now() - 10µs",
      "The statement holds a character outside ASCII at line 1, column 40, outside quotes, which InfluxQL does not read. Write the microsecond unit as `u`.",
    ],
    [
      "SELECT * FROM x WHERE time > now() - 10 µs",
      "The statement holds a character outside ASCII at line 1, column 41, outside quotes, which InfluxQL does not read.",
    ],
    ["SELECT { FROM x", "InfluxQL has no meaning for the character at line 1, column 8 outside quotes."],
    ["SELECT 'abc", "A string that starts at line 1, column 8 never closes."],
    ['SELECT "abc', "A quoted name that starts at line 1, column 8 never closes."],
    ["SELECT * FROM /abc", "A regular expression that starts at line 1, column 15 never closes."],
    ["SELECT 1 /* x", "A /* comment that starts at line 1, column 10 never closes."],
    ["SELECT 'a\nb'", "A string at line 1, column 8 holds a line break, which InfluxQL does not allow there."],
    ['SELECT "a\nb"', "A quoted name at line 1, column 8 holds a line break, which InfluxQL does not allow there."],
    [
      "SELECT * FROM /a\nb/",
      "A regular expression at line 1, column 15 holds a line break, which InfluxQL does not allow there.",
    ],
    [
      "SELECT 'a\\qb'",
      "The backslash at line 1, column 10 starts an escape InfluxQL does not have; it reads only \\n, \\\\, \\\" and \\'.",
    ],
    [
      "SELECT 1,\n  'a\\nb\\\\c\\q'",
      "The backslash at line 2, column 11 starts an escape InfluxQL does not have; it reads only \\n, \\\\, \\\" and \\'.",
    ],
    // Positions are in the normalised text: `\r\n` is one line break, a lone `\r` another.
    [
      "SELECT 1\r\nFROM x\rWHERE a = {",
      "InfluxQL has no meaning for the character at line 3, column 11 outside quotes.",
    ],
  ])("step 5: %j is a lexical fault", (text, message) => {
    expect(refusal(text)).toEqual(["lexical", message]);
  });

  test("step 5 comes before the bound parameter, the statement count and the first keyword", () => {
    expect(refusal("DROP $x; DROP y {")[0]).toBe("lexical");
  });

  test.each(["SELECT $x FROM y", "SELECT * FROM x WHERE a = $a", 'SELECT $"x" FROM y', "DROP $x; DROP y"])(
    "step 6: %s holds a bound parameter",
    (text) => {
      expect(refusal(text)).toEqual(["bound-parameter", BOUND_SENTENCE]);
    },
  );

  test("step 7: one statement, with at most one closing semicolon", () => {
    expect(refusal("SELECT 1; DROP DATABASE x")).toEqual(multiple(1, 9));
    expect(refusal("SELECT 1;;")).toEqual(multiple(1, 9));
    expect(refusal("SELECT 1\n  ; SELECT 2;")).toEqual(multiple(2, 3));
    // Before the first-keyword rule.
    expect(refusal("DROP DATABASE x; DROP DATABASE y")).toEqual(multiple(1, 16));
  });

  test.each([
    ["DROP DATABASE x", "DROP"],
    ["CREATE USER x WITH PASSWORD 'y'", "CREATE"],
    ["KILL QUERY 1", "KILL"],
    ["DELETE FROM x", "DELETE"],
    ["GRANT ALL TO x", "GRANT"],
    ["drop database x", "DROP"],
    ["insert into x values (1)", "INSERT"],
    ['"select" 1', "a quoted name"],
    ["selekt 1", "a symbol"],
    ["(SELECT 1)", "a symbol"],
    ["'SELECT' 1", "a symbol"],
    ["1 + 1", "a symbol"],
    [";", "a symbol"],
    ["/ 2", "a symbol"],
  ])("step 8: %s is not a read", (text, word) => {
    expect(refusal(text)).toEqual(notARead(word));
  });

  // R37: the policy, not the server's parser, says what EXPLAIN may come before.
  test.each([
    ["EXPLAIN DROP DATABASE x", "DROP"],
    ["EXPLAIN DELETE FROM x", "DELETE"],
    ["explain delete from x", "DELETE"],
    ["EXPLAIN ANALYZE DROP MEASUREMENT m", "DROP"],
    ["EXPLAIN ANALYZE VERBOSE DROP MEASUREMENT m", "DROP"],
    ["EXPLAIN /* c */ DROP DATABASE x", "DROP"],
    ["EXPLAIN KILL QUERY 1", "KILL"],
    ["EXPLAIN", "nothing"],
    ["EXPLAIN;", "nothing"],
    ["EXPLAIN ANALYZE VERBOSE -- c", "nothing"],
    ["EXPLAIN ANALYZE ANALYZE SELECT 1", "ANALYZE"],
    ["EXPLAIN VERBOSE ANALYZE SELECT 1", "ANALYZE"],
    ["EXPLAIN VERBOSE VERBOSE SELECT 1", "VERBOSE"],
    ["EXPLAIN EXPLAIN SELECT 1", "EXPLAIN"],
    ["EXPLAIN EXPLAIN SHOW RETENTION POLICIES ON _internal", "EXPLAIN"],
    ['EXPLAIN "select" 1', "a quoted name"],
    ["EXPLAIN selekt 1", "a symbol"],
    ["EXPLAIN (SELECT 1)", "a symbol"],
    ["EXPLAIN 'SELECT' 1", "a symbol"],
    // The first-keyword rule decides before INTO does.
    ["EXPLAIN DROP MEASUREMENT into", "DROP"],
  ])("step 8: %s explains something other than SELECT or SHOW", (text, word) => {
    expect(refusal(text)).toEqual(explainTarget(word));
  });

  test.each([
    "SELECT * INTO x FROM y",
    "select * into x from y",
    'SELECT * FROM (SELECT * INTO "other".."x" FROM home)',
    "EXPLAIN SELECT * INTO x FROM y",
    "EXPLAIN ANALYZE SELECT * INTO x FROM y",
    "SELECT temp INTO other..x FROM home;",
    "SHOW into",
  ])("step 9: %s holds INTO", (text) => {
    expect(refusal(text)).toEqual(["into", INTO_SENTENCE]);
  });
});

describe("evaluateInfluxql: the measured bypasses of a plausible lexer", () => {
  test("B1: a lone carriage return ends a -- comment", () => {
    expect(refusal("SELECT count(temp) FROM home -- c\r; SHOW DATABASES")).toEqual(multiple(2, 1));
  });

  test("B2: a double backslash in a regex escapes nothing", () => {
    const text = "SELECT count(temp) FROM /a\\\\/ 'x/; SHOW DATABASES -- '";
    expect(refusal(text)).toEqual(multiple(1, text.indexOf(";") + 1));
  });

  test("B3: a slash after ::field is division", () => {
    const text = "SELECT temp::field / 2 FROM home LIMIT 1; SHOW DATABASES; SELECT temp::field / 2 FROM home LIMIT 1";
    expect(refusal(text)).toEqual(multiple(1, text.indexOf(";") + 1));
  });

  test("B4: a double backslash in a string is one backslash", () => {
    const text = "SELECT count(temp) FROM home WHERE room = 'a\\\\'; SHOW DATABASES -- '";
    expect(refusal(text)).toEqual(multiple(1, text.indexOf(";") + 1));
  });

  test("B5: a NUL does not end the text", () => {
    expect(refusal("SELECT count(temp) FROM home\u0000; SHOW DATABASES")).toEqual([
      "lexical",
      "The statement holds a control character at line 1, column 29, which Studio does not send.",
    ]);
  });

  test.each([
    "SELECT x FROM m WHERE x > 1 AND /* a/ ' */ x > 0; DROP DATABASE d -- '",
    "SELECT x FROM m WHERE x > 1 OR /* a/ ' */ x > 0; DROP DATABASE d -- '",
    "SELECT x FROM m WHERE /* a/ ' */ x > 0; DROP DATABASE d -- '",
    "SELECT x FROM m WHERE x = /* a/ ' */ 1; DROP DATABASE d -- '",
    "SELECT x, /* a/ ' */ y FROM m; DROP DATABASE d -- '",
    "SELECT mean( /* a/ ' */ x) FROM m; DROP DATABASE d -- '",
  ])("R32: %s is two statements", (text) => {
    expect(refusal(text)).toEqual(multiple(1, text.indexOf(";") + 1));
  });

  test("a regex source after a dot ends where the server ends it", () => {
    // MEASURED on 1.13.1 with SHOW DATABASES as the second statement: both ran.
    const text = 'SELECT * FROM "home"."autogen"./\'/; DROP DATABASE d --\'';
    expect(refusal(text)).toEqual(multiple(1, text.indexOf(";") + 1));
  });
});

describe("evaluateInfluxql: namedDatabases", () => {
  test.each([
    // The name directly after ON.
    ['SHOW MEASUREMENTS ON "home"', ["home"]],
    ["SHOW TAG KEYS ON home FROM m", ["home"]],
    ["SHOW RETENTION POLICIES ON /* c */ home", ["home"]],
    ["SHOW MEASUREMENTS ON *", []],
    ["SHOW MEASUREMENTS ON", []],
    // A FROM source, and a later source of the list.
    ['SELECT * FROM "db".."m"', ["db"]],
    ["SELECT * FROM db.rp.m", ["db"]],
    ['SELECT * FROM a, "db2".."m"', ["db2"]],
    ['SHOW TAG KEYS FROM "db"."rp"."m"', ["db"]],
    ['EXPLAIN SELECT * FROM "db".."m"', ["db"]],
    // A source after a subquery's `)`, and a source at depth two.
    ['SELECT * FROM (SELECT * FROM "in".."m"), "out".."m"', ["in", "out"]],
    ['SELECT * FROM (SELECT mean(x) FROM "a".."m" GROUP BY time(1m)), "b".."m"', ["a", "b"]],
    ['SELECT * FROM (SELECT * FROM (SELECT x FROM "deep"."rp"."m")) WHERE x > (1)', ["deep"]],
    ['SELECT * FROM (SELECT * FROM (SELECT x FROM "a".."m"), "b".."m"), "c".."m"', ["a", "b", "c"]],
    // WITH MEASUREMENT = and =~.
    ['SHOW MEASUREMENTS WITH MEASUREMENT = "db"."rp"."m"', ["db"]],
    ['SHOW MEASUREMENTS WITH MEASUREMENT =~ "db"../cpu.*/', ["db"]],
    ["SHOW MEASUREMENTS WITH MEASUREMENT =~ /cpu.*/", []],
    ['SHOW TAG VALUES FROM "db".."m" WITH KEY = "host"', ["db"]],
    ['SHOW MEASUREMENTS WITH MEASUREMENT <> "db".."m"', []],
    ["SHOW MEASUREMENTS WITH", []],
    // A regex last segment.
    ['SELECT * FROM "db"../re/', ["db"]],
    ['SELECT * FROM "db"."rp"./re/', ["db"]],
    ['SELECT * FROM "rp"./re/', []],
    ["SELECT * FROM /re/", []],
    // Two segments name a retention policy and a measurement; one names a measurement.
    ['SELECT * FROM "rp"."m"', []],
    ['SELECT * FROM "m"', []],
    ["SELECT * FROM", []],
    ['SELECT * FROM "db".', []],
    // Whitespace or a comment BEFORE a dot ends the run (R31): the server refuses these.
    ['SELECT * FROM "db" . . "m"', []],
    ['SELECT * FROM "db" .."m"', []],
    ['SELECT * FROM "db"/*c*/.."m"', []],
    // Whitespace or a comment AFTER a dot is skipped (R31).
    ['SELECT * FROM "db". "rp". "m"', ["db"]],
    ['SELECT * FROM "db".--c\n"rp"."m"', ["db"]],
    ['SELECT * FROM "db"./*c*/"rp"."m"', ["db"]],
    ['SELECT * FROM "_internal". rp. m', ["_internal"]],
    // Fail closed where the server refuses the source anyway: an empty segment after a space, and a fourth segment.
    ['SELECT * FROM "db". ."m"', ["db"]],
    ['SELECT * FROM "db".. /re/', ["db"]],
    ['SELECT * FROM "db"."rp"."m"."x"', ["db"]],
    // A word the v1.4.1 list holds as a keyword is an identifier on the v1.3.0 pin of 2.9.1.
    ["SELECT * FROM future..m", ["future"]],
    ["SHOW MEASUREMENTS ON past", ["past"]],
    // MEASURED on 3.12.0: its parser takes a keyword as a later segment and reads the first as the database.
    ['SELECT * FROM "_internal".database.m', ["_internal"]],
    // R42 (c): a source behind a parenthesis is read whatever the statement, a SHOW's included.
    ['SHOW TAG KEYS FROM ("_internal".."m")', ["_internal"]],
    ['SHOW MEASUREMENTS WITH MEASUREMENT = ("_internal".."m")', ["_internal"]],
    ['SHOW FIELD KEYS FROM "a".."m", ("_internal".."m")', ["a", "_internal"]],
    ['SELECT * FROM (("_internal".."m"))', ["_internal"]],
    ['SELECT * FROM (), "db".."m"', ["db"]],
    // Deduplicated, in first-seen order.
    ['SELECT * FROM "b".."m", "a".."m", "b".."n"', ["b", "a"]],
    // A stray `)` closes nothing.
    ['SELECT (1)) FROM "db".."m"', ["db"]],
    // MEASURED on 3.12.0: its parser explains any statement, and an explained SHOW runs on its ON database.
    ['EXPLAIN SHOW MEASUREMENTS ON "_internal"', ["_internal"]],
    ["EXPLAIN ANALYZE SHOW TAG KEYS ON _internal", ["_internal"]],
    ['EXPLAIN VERBOSE SHOW FIELD KEYS ON "_internal"', ["_internal"]],
    ['EXPLAIN SHOW TAG VALUES ON "_internal" WITH KEY = "host"', ["_internal"]],
    ["EXPLAIN ANALYZE VERBOSE SHOW RETENTION POLICIES ON _internal", ["_internal"]],
    // A bare ON that no name follows names nothing.
    ['SELECT * FROM "db".."m" WHERE on = 1', ["db"]],
  ] as const)("%s", (text, databases) => {
    expect(named(text)).toEqual([...databases]);
  });

  test("a subquery nested thousands deep is read without recursion", () => {
    const depth = 3000;
    const text = `SELECT * FROM ${"(SELECT * FROM ".repeat(depth)}"db".."m"${")".repeat(depth)}`;
    expect(named(text)).toEqual(["db"]);
  });
});

const second = (line: number, column: number): [InfluxqlRefusalReason, string] => [
  "multiple-statements",
  `InfluxQL runs one statement at a time here; remove the text from line ${line}, column ${column} on, where a second statement begins.`,
];

const writeWord = (word: string): [InfluxqlRefusalReason, string] => [
  "not-a-read",
  `This statement holds the word ${word}, which only a writing statement uses, and an InfluxDB connection in Studio runs reads only; if ${word} is a name, write it in double quotes.`,
];

/**
 * R42: InfluxDB 3.12.0 reads statements separated by whitespace alone as separate statements (measured:
 * `SHOW DATABASES SHOW DATABASES` answers statement_id 0 and 1), so a `;` count is not a statement count there.
 */
describe("evaluateInfluxql: a second statement with no semicolon (R42)", () => {
  test.each([
    // (a) a read keyword anywhere but the statement's start, after EXPLAIN, or opening a FROM subquery.
    ["SHOW DATABASES SHOW DATABASES", second(1, 16)],
    ["SHOW MEASUREMENTS SHOW DATABASES", second(1, 19)],
    ["SHOW DATABASES\tSHOW DATABASES", second(1, 16)],
    ["SHOW DATABASES\nSHOW DATABASES", second(2, 1)],
    ["SHOW DATABASES\r\nSHOW DATABASES", second(2, 1)],
    ["SHOW DATABASES/* c */SHOW DATABASES", second(1, 22)],
    ["SHOW DATABASES -- c\nSHOW DATABASES", second(2, 1)],
    ["SHOW TAG KEYS FROM e\tSHOW DATABASES", second(1, 22)],
    ["SELECT * FROM m SELECT * FROM n", second(1, 17)],
    ["SELECT * FROM m EXPLAIN SELECT * FROM n", second(1, 17)],
    ['SHOW DATABASES SELECT * FROM (SELECT * FROM "_internal".."x")', second(1, 16)],
    ["EXPLAIN SELECT * FROM m SHOW DATABASES", second(1, 25)],
    ["EXPLAIN EXPLAIN SELECT * FROM m", explainTarget("EXPLAIN")],
    ["EXPLAIN ANALYZE SELECT * FROM m SELECT * FROM n", second(1, 33)],
    // A subquery opens only in a SELECT's FROM list, and only straight after its `(`.
    ['SHOW TAG KEYS FROM (SELECT * FROM "x".."m")', second(1, 21)],
    ['SHOW MEASUREMENTS WITH MEASUREMENT = (SELECT * FROM "x".."m")', second(1, 39)],
    ['EXPLAIN SHOW TAG KEYS FROM (SELECT * FROM "x".."m")', second(1, 29)],
    ["SELECT * FROM ((SELECT * FROM m))", second(1, 17)],
    ["SELECT (SELECT 1) FROM m", second(1, 9)],
    ["SELECT * FROM m WHERE x = (SELECT 1)", second(1, 28)],
    ["SELECT * FROM m GROUP BY time(1m), (SELECT 1)", second(1, 37)],
    ["SELECT * FROM a.select.b", second(1, 17)],
    // (b) a write word anywhere outside quotes, comments and regex literals, whatever its case.
    ['SHOW DATABASES DROP MEASUREMENT "x"', writeWord("DROP")],
    ["SELECT * FROM m DELETE FROM m", writeWord("DELETE")],
    ["SHOW DATABASES\nDELETE WHERE time < 0", writeWord("DELETE")],
    ["SHOW DATABASES\tdelete from m", writeWord("DELETE")],
    ["SHOW DATABASES/**/CREATE DATABASE x", writeWord("CREATE")],
    ["SHOW DATABASES ALTER RETENTION POLICY r ON d DEFAULT", writeWord("ALTER")],
    ["SHOW DATABASES GRANT ALL TO u", writeWord("GRANT")],
    ["SHOW DATABASES REVOKE ALL FROM u", writeWord("REVOKE")],
    ["SHOW DATABASES KILL QUERY 1", writeWord("KILL")],
    ["SHOW DATABASES INSERT m v=1", writeWord("INSERT")],
    ["SHOW DATABASES SET PASSWORD FOR u = 'p'", writeWord("SET")],
    ["SELECT * FROM (SELECT * FROM m DROP SERIES FROM m)", writeWord("DROP")],
    ["EXPLAIN ANALYZE SELECT * FROM m DELETE FROM m", writeWord("DELETE")],
    // The first offending token by position decides.
    ["SHOW DATABASES SELECT * FROM m DROP SERIES FROM m", second(1, 16)],
    ["SHOW DATABASES DROP SERIES FROM m SELECT * FROM m", writeWord("DROP")],
  ] as const)("%s", (text, expected) => {
    expect(refusal(text)).toEqual([...expected]);
  });

  test.each([
    ["EXPLAIN ANALYZE VERBOSE SELECT * FROM m", "EXPLAIN"],
    ["EXPLAIN VERBOSE SHOW DATABASES", "EXPLAIN"],
    ['SELECT * FROM (SELECT * FROM (SELECT * FROM "db".."m"))', "SELECT"],
    ['SELECT * FROM "a".."m", (SELECT * FROM "b".."m")', "SELECT"],
    ['SELECT * FROM ( /* c */ SELECT * FROM "a".."m" ) , ( SELECT * FROM "b".."m" )', "SELECT"],
    ['EXPLAIN SELECT * FROM (SELECT mean(v) FROM "db".."m" GROUP BY time(1m))', "EXPLAIN"],
    ['SHOW GRANTS FOR "u"', "SHOW"],
    ['SELECT "select", "drop" FROM "show".."delete" WHERE t = \'SHOW DATABASES DROP x\'', "SELECT"],
    ["SELECT * FROM /SELECT|DROP|delete/ WHERE t =~ /show databases/", "SELECT"],
    ["SELECT * FROM m -- SHOW DATABASES DROP DATABASE x", "SELECT"],
    ["SELECT * FROM m /* SELECT * FROM n; DELETE FROM m */", "SELECT"],
    ["SELECT dropped, created_at, settings, inserts FROM m", "SELECT"],
  ] as const)("still allows %s", (text, statement) => {
    const verdict = evaluateInfluxql(text);
    expect(verdict.allowed && verdict.statement).toBe(statement);
  });
});

describe("the gate exports", () => {
  test("influxqlRefusal is the sentence, or undefined to send", () => {
    expect(influxqlRefusal("SELECT * FROM x")).toBeUndefined();
    expect(influxqlRefusal("DROP DATABASE x")).toBe(notARead("DROP")[1]);
    expect(influxqlRefusal("")).toBe(EMPTY_SENTENCE);
  });

  test("readInfluxqlOperations is empty for a read and undefined for a refusal", () => {
    expect(readInfluxqlOperations("SHOW DATABASES")).toEqual([]);
    expect(readInfluxqlOperations("DROP DATABASE x")).toBeUndefined();
  });

  test("no allowed statement writes, so no operation is destructive", () => {
    expect(INFLUXQL_DESTRUCTIVE_OPERATIONS.size).toBe(0);
  });

  test("the fixed sentences are the ones the policy answers with", () => {
    expect(INFLUXQL_POLICY_SENTENCES.empty).toBe(EMPTY_SENTENCE);
    expect(INFLUXQL_POLICY_SENTENCES.flux).toBe(FLUX_SENTENCE);
    expect(INFLUXQL_POLICY_SENTENCES.boundParameter).toBe(BOUND_SENTENCE);
    expect(INFLUXQL_POLICY_SENTENCES.into).toBe(INTO_SENTENCE);
    expect(INFLUXQL_POLICY_SENTENCES.multipleStatements(2, 3)).toBe(multiple(2, 3)[1]);
    expect(INFLUXQL_POLICY_SENTENCES.notARead("DROP")).toBe(notARead("DROP")[1]);
    expect(INFLUXQL_POLICY_SENTENCES.explainTarget("DROP")).toBe(explainTarget("DROP")[1]);
    expect(INFLUXQL_POLICY_SENTENCES.secondStatement(2, 3)).toBe(second(2, 3)[1]);
    expect(INFLUXQL_POLICY_SENTENCES.writeWord("DROP")).toBe(writeWord("DROP")[1]);
    expect(INFLUXQL_POLICY_SENTENCES.fault("unterminated-string", 4, 2, false)).toBe(
      "A string that starts at line 4, column 2 never closes.",
    );
  });
});
