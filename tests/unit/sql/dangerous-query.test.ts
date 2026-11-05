import { describe, expect, test } from "bun:test";
import { hasUnreadableRun, isDangerousQuery } from "@/lib/sql/dangerous-query";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { findCodeWord } from "@/lib/sql/words";
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
 * Where both cost guards draw their line. Eight times the text costs about 8 times as much when the gate reads it in
 * linear time and about 64 when it reads it in quadratic time, and the gate costs at most about a dozen walks of a
 * text against the more than 40 it used to walk.
 */
const BOUND = 24;

/** How many rounds `costInRuns` times: odd, so the median is one round's ratio. */
const ROUNDS = 9;

/**
 * Each cost guard's own timeout. Its rounds take a few seconds on a loaded runner, close to bun's default of 5 s, so
 * this gives them room to finish; on Windows it stands in for the runner's 60 s, still far above what they take.
 */
const ROUNDS_TIMEOUT_MS = 30_000;

/** The milliseconds `runs` runs of `probe` take, back to back. */
function elapsed(probe: () => unknown, runs: number): number {
  const started = performance.now();
  for (let run = 0; run < runs; run++) probe();
  return performance.now() - started;
}

/**
 * How many runs of `yardstick` one run of `probe` costs: the median of `ROUNDS` rounds, after one run of each outside
 * the measurement, the cold one, with every round's ratio in order of size for a failure message. A round times
 * `probeRuns` runs of `probe` and `bound` times as many runs of `yardstick` back to back, each side first in turn.
 *
 * Against `bound` times as many runs of the yardstick, the two sides of a round last about as long as each other
 * where the cost meets the bound, and both sides of a round sample the same stretch of time, so a load that outlasts a
 * round slows both, and the median of `ROUNDS` rounds keeps a round that one preemption landed on from deciding. The
 * cheapest of five runs of each side, one side after the other, leaned toward the bound instead: a 1 ms walk often
 * escapes preemption whole while a 12 ms gate run cannot, and a macOS runner read a script of short statements at 34.8
 * walks of the text for a gate that costs about 12. Measured on one CPU shared
 * with two other test processes: the cheapest-of-five reading failed this file in every run, this one stayed under 16
 * on every shape below, and the gate before #2249 still read more than 30 on each of them.
 */
function costInRuns(
  probe: () => unknown,
  yardstick: () => unknown,
  bound: number,
  probeRuns: number,
): { cost: number; rounds: string } {
  probe();
  yardstick();
  const ratios: number[] = [];
  for (let round = 0; round < ROUNDS; round++) {
    const probeFirst = round % 2 === 0;
    const first = probeFirst ? elapsed(probe, probeRuns) : elapsed(yardstick, bound * probeRuns);
    const second = probeFirst ? elapsed(yardstick, bound * probeRuns) : elapsed(probe, probeRuns);
    const [probeMs, yardstickMs] = probeFirst ? [first, second] : [second, first];
    ratios.push((bound * probeMs) / yardstickMs);
  }
  ratios.sort((a, b) => a - b);
  return { cost: ratios[ROUNDS >> 1], rounds: ratios.map((ratio) => ratio.toFixed(1)).join(", ") };
}

/**
 * What the gate costs on the texts `POST /api/db/statement/analyze` hands it, of up to 1,000,000 UTF-16 code units,
 * on the event loop. Each guard is a RATIO of two costs measured on one machine in one process, in rounds that time
 * both sides in turn (`costInRuns`), so a slow or loaded machine slows both sides and moves the ratio little, and
 * neither side is a ceiling in milliseconds.
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
    `%s (%s): eight times the text costs less than ${BOUND} times as much`,
    (_label, type, copies, textOf) => {
      const short = textOf(copies);
      const long = textOf(8 * copies);
      // A correct answer AND a bounded one: a fast wrong answer is not a pass.
      expect(isDangerousQuery(short, type)).toBe(false);
      expect(isDangerousQuery(long, type)).toBe(false);
      // Two runs of the long text a round: one lasts a few milliseconds, which a preemption misses whole or doubles.
      const { cost: growth, rounds } = costInRuns(
        () => isDangerousQuery(long, type),
        () => isDangerousQuery(short, type),
        BOUND,
        2,
      );
      expect(
        growth,
        `the text 8 times as long cost ${growth.toFixed(1)} times as much (rounds ${rounds})`,
      ).toBeLessThan(BOUND);
    },
    ROUNDS_TIMEOUT_MS,
  );

  /**
   * Texts the gate read in linear time but walked once for every form and word it asks about: more than 40 walks of
   * each of these, more than 100 of a Snowflake block of `BEGIN` words and more than 200 of a block of `CREATE` words,
   * which made 1,000,000 units of those cost more than a second. The yardstick is one walk of the same text by
   * `findCodeWord`, the reader every one of those walks was. The gate reads the text, cuts it into its statements and
   * reads each of them, which costs a few walks, and about a dozen for a script of short statements or a run of quoted
   * names, whose own walk is cheap.
   */
  const WALKED: readonly [string, DatabaseType, string][] = [
    ["a block of BEGIN words", "snowflake", "BEGIN ".repeat(16_000)],
    ["a block of CREATE words", "snowflake", `BEGIN ${"CREATE ".repeat(14_000)}`],
    ["one-letter words", "spark", "x ".repeat(50_000)],
    ["words that could open a raw string", "spark", "r ".repeat(50_000)],
    ["quoted names", "spark", `SELECT ${'"x" '.repeat(25_000)}`],
    ["a script of short statements", "spark", "SELECT 1;\n".repeat(10_000)],
  ];

  test.each(WALKED.map(([label, type, text]) => [label, type, text] as const))(
    `%s (%s): the gate costs less than ${BOUND} walks of the text`,
    (_label, type, text) => {
      const grammar = resolveSqlGrammar(type);
      expect(isDangerousQuery(text, type)).toBe(false);
      const { cost: walks, rounds } = costInRuns(
        () => isDangerousQuery(text, type),
        () => findCodeWord(text, "ABSENT", 0, grammar),
        BOUND,
        1,
      );
      expect(walks, `the gate cost ${walks.toFixed(1)} walks of the text (rounds ${rounds})`).toBeLessThan(BOUND);
    },
    ROUNDS_TIMEOUT_MS,
  );
});
