import { describe, expect, test } from "bun:test";
import { DEFAULT_SQL_GRAMMAR, resolveSqlGrammar } from "@/lib/sql/grammar";
import { ParenthesisedRuns } from "@/lib/sql/parenthesised";

/**
 * `ParenthesisedRuns`: where a parenthesised run closes, remembered for every index a walk stood on. The expected
 * offsets are counted by hand off each text; the remembering is pinned by asking the same reader in different orders
 * and comparing it with a reader that was asked nothing before.
 */
const POSTGRES = resolveSqlGrammar("postgres");

function closeOf(sql: string, open: number, walk: "characters" | "words" = "characters", grammar = POSTGRES): number {
  return new ParenthesisedRuns(sql, grammar, walk).closeOf(open);
}

describe("ParenthesisedRuns", () => {
  test("answers the index past the `)` that closes a run, and a nested run's own close", () => {
    const sql = "f(a, (b), c) x";
    expect(closeOf(sql, 1)).toBe(12);
    expect(closeOf(sql, 5)).toBe(8);
  });

  test("a `)` inside a string, a comment or a quoted name closes nothing", () => {
    expect(closeOf(`(')' /* ) */ ")" )`, 0)).toBe(18);
  });

  test("a run that never closes, or holds a span that never closes, answers -1", () => {
    expect(closeOf("((a)", 0)).toBe(-1);
    expect(closeOf("((a)", 1)).toBe(4);
    expect(closeOf("(a 'b", 0)).toBe(-1);
    expect(closeOf("(a /* b", 0)).toBe(-1);
  });

  test("a run inside one that never closes leaves every run around it unclosed", () => {
    const runs = new ParenthesisedRuns("((( a", POSTGRES, "characters");
    expect(runs.closeOf(2)).toBe(-1);
    expect(runs.closeOf(1)).toBe(-1);
    expect(runs.closeOf(0)).toBe(-1);
    const closedInside = new ParenthesisedRuns("(( a ) b", POSTGRES, "characters");
    expect(closedInside.closeOf(1)).toBe(6);
    expect(closedInside.closeOf(0)).toBe(-1);
  });

  test("answers each run alike whichever run it was asked about first", () => {
    const sql = "(a (b (c) d) (e) 'f)' g) h (i";
    const opens = [...sql].flatMap((ch, index) => (ch === "(" ? [index] : []));
    const fresh = opens.map((open) => closeOf(sql, open));
    expect(fresh).toEqual([24, 12, 9, 16, -1]);

    const outerFirst = new ParenthesisedRuns(sql, POSTGRES, "characters");
    expect(opens.map((open) => outerFirst.closeOf(open))).toEqual(fresh);
    const innerFirst = new ParenthesisedRuns(sql, POSTGRES, "characters");
    expect([...opens].reverse().map((open) => innerFirst.closeOf(open))).toEqual([...fresh].reverse());
    // Asked again, a remembered run answers what it answered.
    expect(opens.map((open) => innerFirst.closeOf(open))).toEqual(fresh);
  });

  test("the characters walk reads a `$$` inside a word as a dollar-quoted run, and the words walk reads the word", () => {
    const sql = "(a$$ ) $$)";
    expect(closeOf(sql, 0, "characters")).toBe(10);
    expect(closeOf(sql, 0, "words")).toBe(6);
  });

  test("reads the text under the dialect it is given", () => {
    const sql = "(# )\n)";
    expect(closeOf(sql, 0, "characters", resolveSqlGrammar("mysql"))).toBe(6);
    expect(closeOf(sql, 0, "characters", POSTGRES)).toBe(4);
    expect(closeOf(sql, 0, "words", DEFAULT_SQL_GRAMMAR)).toBe(6);
  });
});
