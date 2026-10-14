/**
 * The refusals the Spark provider makes before any call,
 * each read under the Spark grammar row.
 */
import { describe, expect, test } from "bun:test";
import {
  scriptBlockRefusal,
  SPARK_STATEMENT_SENTENCES,
  unicodeSpaceRefusal,
  uriFormRefusal,
} from "@/lib/db/providers/sql/spark/statement-shape";

describe("scriptBlockRefusal", () => {
  test("a statement led by BEGIN under the Spark grammar is refused, in any case and after comments", () => {
    for (const sql of [
      "BEGIN SELECT 1; END",
      "begin\n  DECLARE x INT;\nEND",
      "  -- a note\nBEGIN SELECT 1; END",
      "/* a /* nested */ note */ BEGIN SELECT 1; END",
      "\n\tBegin SELECT 1; END",
    ]) {
      expect(scriptBlockRefusal(sql)).toBe(SPARK_STATEMENT_SENTENCES.scriptBlock);
    }
  });

  test("BEGIN that does not lead the statement is not refused", () => {
    for (const sql of [
      "SELECT 'BEGIN'",
      "SELECT 1 AS `BEGIN`",
      "SELECT r'BEGIN' AS a",
      "-- BEGIN\nSELECT 1",
      "/* BEGIN */ SELECT 1",
      "SELECT begin FROM t",
      "BEGINNING",
      "",
    ]) {
      expect(scriptBlockRefusal(sql)).toBeUndefined();
    }
  });

  test("BEGIN written with a dotless i, which Spark's lexer reads as I, is refused too", () => {
    // Spark's lexer upper-cases each character before it matches a token (`UpperCaseCharStream.LA`, `parsers.scala`
    // v4.2.0), and U+0131 upper-cases to I, so Spark reads beg\u0131n as the keyword BEGIN.
    expect(scriptBlockRefusal("beg\u0131n SELECT 1; END")).toBe(SPARK_STATEMENT_SENTENCES.scriptBlock);
    expect(scriptBlockRefusal("-- a note\nBEG\u0131N SELECT 1; END")).toBe(SPARK_STATEMENT_SENTENCES.scriptBlock);
    expect(scriptBlockRefusal("beg\u0131nning")).toBeUndefined();
    expect(scriptBlockRefusal("SELECT 'beg\u0131n'")).toBeUndefined();
  });
});

describe("unicodeSpaceRefusal", () => {
  const SPACES = [
    "\u00A0",
    "\u1680",
    "\u2000",
    "\u2001",
    "\u2002",
    "\u2003",
    "\u2004",
    "\u2005",
    "\u2006",
    "\u2007",
    "\u2008",
    "\u2009",
    "\u200A",
    "\u2028",
    "\u202F",
    "\u205F",
    "\u3000",
  ];

  test("each space Spark reads as white space and Studio does not is refused between two code words", () => {
    for (const space of SPACES) {
      expect(unicodeSpaceRefusal(`SELECT${space}1`)).toBe(SPARK_STATEMENT_SENTENCES.unicodeSpace);
      expect(unicodeSpaceRefusal(`SELECT 1 FROM t WHERE a =${space}2`)).toBe(SPARK_STATEMENT_SENTENCES.unicodeSpace);
    }
  });

  test("the same character inside a string, a raw string, a quoted name or a comment is not refused", () => {
    for (const space of SPACES) {
      for (const sql of [
        `SELECT '${space}'`,
        `SELECT "${space}"`,
        `SELECT r'${space}'`,
        `SELECT 1 AS \`a${space}b\``,
        `SELECT 1 -- ${space}`,
        `/* ${space} */ SELECT 1`,
      ]) {
        expect(unicodeSpaceRefusal(sql)).toBeUndefined();
      }
    }
  });

  test("the contents of a subscript or a hint are code, so the same character there is refused", () => {
    expect(unicodeSpaceRefusal("SELECT arr[\u00A0i]")).toBe(SPARK_STATEMENT_SENTENCES.unicodeSpace);
    expect(unicodeSpaceRefusal("SELECT /*+\u00A0REPARTITION(2) */ 1")).toBe(SPARK_STATEMENT_SENTENCES.unicodeSpace);
    expect(unicodeSpaceRefusal("SELECT m['\u00A0']")).toBeUndefined();
  });

  test("ordinary white space, a zero-width space and a statement with none are not refused", () => {
    expect(unicodeSpaceRefusal("SELECT\t1\r\nFROM t")).toBeUndefined();
    expect(unicodeSpaceRefusal("SELECT\u200B1")).toBeUndefined();
    expect(unicodeSpaceRefusal("")).toBeUndefined();
  });
});

describe("uriFormRefusal (the URI form of IDENTIFIER, SqlBaseLexer.g4 v4.2.0:655)", () => {
  /** An address in each shape: a `--` inside it, a final `/` before `*`, a final `r` or `R` before a quote. */
  const SHAPES = ["hdfs://nn/logs--old/a.jar", "hdfs://nn/data/*", 'hdfs://nn/R"x"', "hdfs://nn/r'x'"];

  test("each of the three shapes is refused, also after a comment and inside a SELECT list", () => {
    for (const address of SHAPES) {
      for (const sql of [
        `ADD JAR ${address}`,
        `SET spark.hadoop.fs.defaultFS=${address}`,
        `/* a note */ ADD JAR ${address}`,
        `-- a note\nADD JAR ${address}`,
        `SELECT 1, ${address} FROM t`,
      ]) {
        expect(uriFormRefusal(sql)).toBe(SPARK_STATEMENT_SENTENCES.uriForm);
      }
    }
    // A letter outside the Basic Multilingual Plane, two UTF-16 units, starts the run as the one letter it is.
    expect(uriFormRefusal("ADD JAR \u{1D465}://nn/a--b")).toBe(SPARK_STATEMENT_SENTENCES.uriForm);
  });

  test("an address is also tried at a non-ASCII letter after an ASCII letter or digit, where Spark ends a decimal", () => {
    // Spark's lexer ends 1.5 before the é, since isValidDecimal refuses a decimal only when A-Z, 0-9 or _ follows it
    // (SqlBaseLexer-v4.2.0.g4:42-50, :627-646), so Spark reads é://x--y as an address.
    expect(uriFormRefusal("SET k=1.5é://x--y")).toBe(SPARK_STATEMENT_SENTENCES.uriForm);
    // The same after a decimal that ends in a letter: 1.5D is a double, and Spark's lexer ends it before the é.
    expect(uriFormRefusal("SET k=1.5Dé://x--y")).toBe(SPARK_STATEMENT_SENTENCES.uriForm);
    // The accepted cost: Spark reads x1é as one name, and the same rule refuses this text too.
    expect(uriFormRefusal("SELECT x1é://y--z")).toBe(SPARK_STATEMENT_SENTENCES.uriForm);
  });

  test("the same text inside a string, a raw string, a quoted name or a comment is not refused", () => {
    // The first three hold no `'`, so each sits whole inside every container here.
    for (const address of SHAPES.slice(0, 3)) {
      for (const sql of [
        `SELECT '${address}'`,
        `SELECT r'${address}'`,
        `SELECT 1 AS \`${address}\``,
        `SELECT 1 -- ${address}`,
      ]) {
        expect(uriFormRefusal(sql)).toBeUndefined();
      }
    }
  });

  test("the contents of a subscript or a hint are code, so an address there is refused", () => {
    expect(uriFormRefusal("SELECT m[hdfs://nn/a--b]")).toBe(SPARK_STATEMENT_SENTENCES.uriForm);
    expect(uriFormRefusal("SELECT /*+ hdfs://nn/a--b */ 1")).toBe(SPARK_STATEMENT_SENTENCES.uriForm);
    expect(uriFormRefusal("SELECT m['hdfs://nn/a--b']")).toBeUndefined();
  });

  test("an address Studio and Spark read alike is not refused", () => {
    for (const sql of [
      "SET spark.hadoop.fs.defaultFS=hdfs://nn:8020/x",
      "ADD JAR hdfs://x/y.jar",
      "SELECT a://b/c 'x'",
      "SELECT a://b/r 'x'",
      "SELECT a://b/ * 2",
      // One `-`, a `*` after a final letter and a quote after a final letter other than r: none opens a span.
      "ADD JAR hdfs://x/y-z.jar",
      "SELECT a://b/c*2",
      "SELECT a://b/c'x'",
      // Spark reads the address hdfs://x/y, then `:`, `/`, `/`, `z` and the comment `--w`, which Studio reads as a
      // comment too. The walk steps over the whole address, so it tries none that starts inside it, such as y://z--w.
      "SELECT hdfs://x/y://z--w",
    ]) {
      expect(uriFormRefusal(sql)).toBeUndefined();
    }
  });

  test("a letter run without :// is no address, nor is a run that does not start a token", () => {
    for (const sql of ["SELECT a--b", "SELECT hdfs:/x--y", "SELECT x1a://b--c", "SELECT _a://b--c", ""]) {
      expect(uriFormRefusal(sql)).toBeUndefined();
    }
  });

  test("U+0345, which Spark's lexer reads as a letter, is a letter of an address", () => {
    // Spark's lexer upper-cases each character before it matches a token (`UpperCaseCharStream.LA`, `parsers.scala`
    // v4.2.0), and U+0345, a combining mark, upper-cases to U+0399, a letter.
    for (const address of ["\u0345://nn/a--b", "a\u0345://nn/a--b", "a://nn/x\u0345--b"]) {
      expect(uriFormRefusal(`ADD JAR ${address}`)).toBe(SPARK_STATEMENT_SENTENCES.uriForm);
    }
    // Spark ends the decimal 1.5 before U+0345 too, since it upper-cases to no character of A-Z, 0-9 or _.
    expect(uriFormRefusal("SET k=1.5\u0345://x--y")).toBe(SPARK_STATEMENT_SENTENCES.uriForm);
  });

  /**
   * A bounded-time guard, on the shape of the one in `leading-keyword.test.ts`: a walk that read the rest of a word
   * again at each LATE_START was quadratic in the number of them, about 2.7 s on the first input here and 1.1 s on the
   * second (bun 1.4.2, measured while writing this guard), where a walk that reads each character a bounded number of
   * times answers both in a few milliseconds. The bound is loose so it cannot flake on a slow runner.
   */
  test("a long word holding a LATE_START every two characters is read in bounded time", () => {
    const BOUND_MS = 200;
    const long: [string, string][] = [
      ["50k ASCII and non-ASCII letter pairs", `SELECT ${"a\u00E9".repeat(50_000)}`],
      ["50k digit and non-ASCII letter pairs", `SELECT ${"1\u00E9".repeat(50_000)}`],
    ];
    for (const [label, sql] of long) {
      const started = performance.now();
      const refusal = uriFormRefusal(sql);
      const elapsed = performance.now() - started;
      expect(refusal).toBeUndefined();
      expect(elapsed, `${label} took ${elapsed.toFixed(1)}ms`).toBeLessThan(BOUND_MS);
    }
  });

  /**
   * The same guard for U+0345, which an address's letters hold and a word's letters did not: a try that found no `://`
   * after a run of it stepped one character on, so the next try read the rest of the run again, quadratic in its length.
   */
  test("a long run of U+0345 is read in bounded time", () => {
    const BOUND_MS = 200;
    const long: [string, string][] = [
      ["50k U+0345", `SELECT ${"ͅ".repeat(50_000)}`],
      ["a letter then 50k U+0345", `SELECT a${"ͅ".repeat(50_000)}`],
    ];
    for (const [label, sql] of long) {
      const started = performance.now();
      const refusal = uriFormRefusal(sql);
      const elapsed = performance.now() - started;
      expect(refusal).toBeUndefined();
      expect(elapsed, `${label} took ${elapsed.toFixed(1)}ms`).toBeLessThan(BOUND_MS);
    }
  });
});

describe("unicodeSpaceRefusal and uriFormRefusal at a bracket", () => {
  /**
   * A bounded-time guard for both walks, on the shape of the one above: a walk that asked the span reader about each
   * `[` had it scan to the matching `]`, or to the end of the text when none closes it, then stepped one character into
   * the subscript, so each nested or unclosed `[` read the rest of the text again. That was quadratic in the number of
   * them, about 1.2 s on the first input here, 1.8 s on the second and 0.65 s on the third in each walk (bun 1.4.2,
   * measured while writing this guard), where a walk that reads `[` as code answers each in a few milliseconds. The
   * bound is the one above, loose so it cannot flake on a slow runner.
   */
  test("nested or unclosed brackets are read in bounded time by both walks", () => {
    const BOUND_MS = 200;
    const walks: [string, (sql: string) => string | undefined][] = [
      ["unicodeSpaceRefusal", unicodeSpaceRefusal],
      ["uriFormRefusal", uriFormRefusal],
    ];
    const long: [string, string][] = [
      ["50k unclosed brackets", `SELECT ${"[".repeat(50_000)}`],
      ["20k letter and unclosed bracket pairs", `SELECT ${"a[".repeat(20_000)}`],
      ["a 25k-deep nested pair", `SELECT ${"[".repeat(25_000)}${"]".repeat(25_000)}`],
    ];
    for (const [name, walk] of walks) {
      for (const [label, sql] of long) {
        const started = performance.now();
        const refusal = walk(sql);
        const elapsed = performance.now() - started;
        expect(refusal).toBeUndefined();
        expect(elapsed, `${name} on ${label} took ${elapsed.toFixed(1)}ms`).toBeLessThan(BOUND_MS);
      }
    }
  });
});

describe("SPARK_STATEMENT_SENTENCES", () => {
  test("the bound-parameter sentence is Snowflake's, worded for Spark", () => {
    expect(SPARK_STATEMENT_SENTENCES.boundParameters).toBe(
      "Studio sends no bound parameters to Spark; write the value in the statement.",
    );
  });

  test("the record holds the four pre-call sentences and is frozen", () => {
    expect(SPARK_STATEMENT_SENTENCES).toStrictEqual({
      scriptBlock:
        "Spark SQL scripting blocks (BEGIN ... END) do not run in this version of Studio. Run the statements one at a time; temp views and SET values carry from one to the next within one run.",
      boundParameters: "Studio sends no bound parameters to Spark; write the value in the statement.",
      unicodeSpace:
        "This statement holds a non-breaking or other Unicode space outside a string. Spark reads it as a space and Studio's editor does not, so the confirmation prompt and the row limit could read the statement differently; replace it with an ordinary space.",
      uriForm:
        "This statement holds an address written without quotes, such as a://b, in which Studio's editor starts a comment or a raw string where Spark reads part of the address, so the confirmation prompt and the row limit could read the statement differently; put the address in backticks or quotes.",
    });
    expect(Object.isFrozen(SPARK_STATEMENT_SENTENCES)).toBe(true);
  });
});
