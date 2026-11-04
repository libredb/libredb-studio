import { describe, expect, test } from "bun:test";
import { hasUnreadableRun, isDangerousQuery } from "@/lib/sql/dangerous-query";
import type { DatabaseType } from "@/lib/types";

/**
 * The confirmation gate's own module, `src/lib/sql/dangerous-query.ts`.
 *
 * `hasUnreadableRun` is the one question the gate asks before it reads a keyword, and the safety dialog asks it again
 * to say why it is asking, so both read it here rather than each spelling it out.
 */
describe("hasUnreadableRun", () => {
  test("a literal that never closes is unreadable", () => {
    expect(hasUnreadableRun("SELECT 'abc", "postgres")).toBe(true);
  });

  test("a lone carriage return in a line comment is unreadable", () => {
    expect(hasUnreadableRun("SELECT 1 -- note\rDELETE FROM t", "postgres")).toBe(true);
  });

  test("a statement whose runs all close is readable", () => {
    expect(hasUnreadableRun("SELECT 1", "postgres")).toBe(false);
    expect(hasUnreadableRun("SELECT 1 -- note\r\nFROM t", "postgres")).toBe(false);
  });

  test("text that is not SQL is never read as SQL, so its escaped quote is no unreadable run", () => {
    const document = '{"collection":"users","operation":"find","filter":{"msg":"say \\"hi\\""}}';
    expect(hasUnreadableRun(document, "mongodb")).toBe(false);
    // The control: read as SQL, the same document's escaped quote is a literal that never closes.
    expect(hasUnreadableRun(document, "postgres")).toBe(true);
  });

  test("no type at all reads the text as SQL", () => {
    expect(hasUnreadableRun("SELECT 'abc")).toBe(true);
    expect(hasUnreadableRun("SELECT 1 -- note\rDELETE FROM t")).toBe(true);
    expect(hasUnreadableRun("SELECT 1")).toBe(false);
  });

  test("the gate asks about an unreadable run before it reads a keyword", () => {
    // Neither text names a write the gate could read, so only the unreadable run makes it ask.
    expect(isDangerousQuery("SELECT 'abc", "postgres")).toBe(true);
    expect(isDangerousQuery("SELECT 1 -- note\rFROM t", "postgres")).toBe(true);
    expect(isDangerousQuery("SELECT 1", "postgres")).toBe(false);
  });
});

describe("isDangerousQuery at the analyze route's bound of 1,000,000 units", () => {
  test("follows an EXPLAIN chain to the statement it executes", () => {
    // Read one call deeper per EXPLAIN, V8 ran out of stack a few thousand in. Bun's engine does not show that, so the
    // VS Code extension's query/target suite, which runs under Node, pins it too.
    expect(isDangerousQuery(`${"EXPLAIN ANALYZE ".repeat(62_500)}DELETE FROM t`, "postgres")).toBe(true);
    expect(isDangerousQuery(`${"EXPLAIN ANALYZE ".repeat(62_500)}SELECT 1`, "postgres")).toBe(false);
  });
});

/**
 * The cheapest of `runs` runs of `probe`, in milliseconds, after one run outside the measurement, the cold one. Being
 * preempted only ever adds time, so the cheapest run is the one that measured the reader rather than the machine.
 */
function cheapest(probe: () => unknown, runs: number): number {
  probe();
  let elapsed = Infinity;
  for (let attempt = 0; attempt < runs; attempt++) {
    const started = performance.now();
    probe();
    elapsed = Math.min(elapsed, performance.now() - started);
  }
  return elapsed;
}

/**
 * What the gate costs on the texts `POST /api/db/statement/analyze` hands it, of up to 1,000,000 UTF-16 code units,
 * on the event loop. Each guard is a RATIO of two costs measured on one machine in one
 * process, so a slow or loaded machine slows both sides and moves the ratio little, and neither side is a ceiling in
 * milliseconds.
 */
describe("isDangerousQuery's cost grows with its text and no faster", () => {
  /**
   * Shapes whose cost grew with the square of the text, each with the verdict it has to keep. Each copy nests in the
   * one before it, or repeats a word whose check read the whole rest of the text: a CTE body that opens with `WITH` had
   * its list read again from that `WITH`, crossing every body nested inside it once per level; a `CREATE STAGE` looked
   * for `URL` to the end of the text, a computed call for the end of its run and a `FOR UPDATE` lock clause matched a
   * pattern against the whole text before it, once per copy. Quadratic, eight times the text costs about 64 times as
   * much; linear, about 8.
   */
  const NESTED: readonly [string, DatabaseType, number, (copies: number) => string][] = [
    [
      "CTE bodies nested in CTE bodies",
      "postgres",
      180,
      (k) => `SELECT 1 FROM t ${"AS (WITH a ".repeat(k)}SELECT 1${")".repeat(k)}`,
    ],
    ["CTE bodies nested and never closed", "mysql", 180, (k) => `SELECT 1 FROM t ${"AS (WITH a ".repeat(k)}`],
    ["expression elements nested in CTE bodies", "postgres", 180, (k) => `SELECT 1 FROM t ${"AS (WITH (".repeat(k)}`],
    ["column lists nested in CTE bodies", "oracle", 180, (k) => `SELECT 1 FROM t ${"AS (WITH a (".repeat(k)}`],
    [
      "WITH statements nested in CTE bodies",
      "sqlite",
      180,
      (k) => `${"WITH a AS (".repeat(k)}SELECT 1${") SELECT 1".repeat(k)}`,
    ],
    ["computed calls nested in computed calls", "spark", 180, (k) => `SELECT ${"IDENTIFIER(".repeat(k)}`],
    ["stages created in a block, none at a URL", "snowflake", 180, (k) => `BEGIN ${"CREATE STAGE ".repeat(k)}`],
    // The pattern scanned the text before each copy fast, so the square shows only on a longer text.
    ["cursor lock clauses in a block", "oracle", 1_000, (k) => `BEGIN ${"FOR UPDATE ".repeat(k)}`],
  ];

  test.each(NESTED.map(([label, type, copies, textOf]) => [label, type, copies, textOf] as const))(
    "%s (%s): eight times the text costs less than 24 times as much",
    (_label, type, copies, textOf) => {
      const short = textOf(copies);
      const long = textOf(8 * copies);
      // A correct answer AND a bounded one: a fast wrong answer is not a pass.
      expect(isDangerousQuery(short, type)).toBe(false);
      expect(isDangerousQuery(long, type)).toBe(false);
      const growth = cheapest(() => isDangerousQuery(long, type), 5) / cheapest(() => isDangerousQuery(short, type), 5);
      expect(growth, `the text 8 times as long cost ${growth.toFixed(1)} times as much`).toBeLessThan(24);
    },
  );
});
