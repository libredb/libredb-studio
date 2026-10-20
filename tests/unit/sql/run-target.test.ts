import { describe, expect, test } from "bun:test";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { cursorTarget, runTarget, selectionTarget, type RunTargetInput } from "@/lib/sql/run-target";

const PG = resolveSqlGrammar("postgres");
const TSQL = resolveSqlGrammar("mssql");
const ES = resolveSqlGrammar("elasticsearch");
const TWO = "SELECT 1;\n\nSELECT 2;"; // targets [0, 8) and [11, 19); length 20
const sqlAt = (text: string, cursor: number, over: Partial<RunTargetInput> = {}): RunTargetInput => ({
  text,
  selection: { start: cursor, end: cursor },
  cursor,
  editorLanguage: "sql",
  statementTerminator: undefined,
  grammar: PG,
  ...over,
});

describe("a selection", () => {
  test("is sent as selected, its `;` kept", () => {
    expect(runTarget(sqlAt(TWO, 20, { selection: { start: 11, end: 20 } }))).toEqual({
      statement: "SELECT 2;",
      range: { start: 11, end: 20 },
    });
  });

  test("a blank selection falls through to the cursor", () => {
    expect(runTarget(sqlAt(TWO, 11, { selection: { start: 9, end: 11 } }))).toEqual({
      statement: "SELECT 2",
      range: { start: 11, end: 19 },
    });
    expect(
      selectionTarget("   \n  ", { editorLanguage: "sql", statementTerminator: undefined, grammar: PG }),
    ).toBeNull();
  });

  test("one statement under a terminator-less engine is read through the splitter (#1414)", () => {
    expect(
      runTarget(
        sqlAt("SELECT a FROM t LIMIT 2;", 24, {
          selection: { start: 0, end: 24 },
          statementTerminator: "none",
          grammar: ES,
        }),
      ),
    ).toEqual({ statement: "SELECT a FROM t LIMIT 2", range: { start: 0, end: 24 } });
  });

  test("several statements under a terminator-less engine are sent as selected", () => {
    expect(
      runTarget(
        sqlAt("SELECT 1; SELECT 2;", 19, {
          selection: { start: 0, end: 19 },
          statementTerminator: "none",
          grammar: ES,
        }),
      ),
    ).toEqual({ statement: "SELECT 1; SELECT 2;", range: { start: 0, end: 19 } });
  });

  test("one statement on an engine with a terminator keeps its `;`", () => {
    expect(runTarget(sqlAt("SELECT a FROM t LIMIT 2;", 24, { selection: { start: 0, end: 24 }, grammar: ES }))).toEqual(
      { statement: "SELECT a FROM t LIMIT 2;", range: { start: 0, end: 24 } },
    );
  });

  test("the terminator exception applies to the sql editor language only", () => {
    expect(selectionTarget("SELECT 1;", { editorLanguage: "json", statementTerminator: "none", grammar: ES })).toBe(
      "SELECT 1;",
    );
  });
});

describe("the cursor", () => {
  const FIRST = { statement: "SELECT 1", range: { start: 0, end: 8 } };
  const SECOND = { statement: "SELECT 2", range: { start: 11, end: 19 } };

  test("inside the first statement", () => {
    expect(runTarget(sqlAt(TWO, 4))).toEqual(FIRST);
  });

  test("at the first statement's end, before and after its `;`", () => {
    expect(runTarget(sqlAt(TWO, 8))).toEqual(FIRST);
    expect(runTarget(sqlAt(TWO, 9))).toEqual(FIRST);
  });

  test("between statements, the last one starting at or before the cursor", () => {
    expect(runTarget(sqlAt(TWO, 10))).toEqual(FIRST);
  });

  test("at the second statement's start and at the end of the text", () => {
    expect(runTarget(sqlAt(TWO, 11))).toEqual(SECOND);
    expect(runTarget(sqlAt(TWO, 20))).toEqual(SECOND);
  });

  test("before the first statement, the first one", () => {
    expect(runTarget(sqlAt("\n\nSELECT 1;", 0))).toEqual({ statement: "SELECT 1", range: { start: 2, end: 10 } });
  });

  test("a procedural body is one target", () => {
    const FN = "CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$;\nSELECT 2;";
    expect(runTarget(sqlAt(FN, 60))).toEqual({
      statement: "CREATE FUNCTION f() RETURNS int LANGUAGE plpgsql AS $$ BEGIN RETURN 1; END $$",
      range: { start: 0, end: 77 },
    });
  });

  test("a T-SQL batch offers its statements one by one (#1312)", () => {
    const BATCH = "SELECT 1; DELETE FROM t\nGO\nSELECT 2";
    expect(runTarget(sqlAt(BATCH, 3, { grammar: TSQL }))).toEqual({
      statement: "SELECT 1",
      range: { start: 0, end: 8 },
    });
    expect(runTarget(sqlAt(BATCH, 15, { grammar: TSQL }))).toEqual({
      statement: "DELETE FROM t",
      range: { start: 10, end: 23 },
    });
  });

  test("a T-SQL procedure batch is one target (#1312)", () => {
    const PROC = "CREATE PROCEDURE p AS BEGIN SET NOCOUNT ON; SELECT 1; END\nGO\nSELECT 2";
    expect(runTarget(sqlAt(PROC, 50, { grammar: TSQL }))).toEqual({
      statement: "CREATE PROCEDURE p AS BEGIN SET NOCOUNT ON; SELECT 1; END",
      range: { start: 0, end: 57 },
    });
  });

  test("cursorTarget answers the split statement, or null outside the sql language", () => {
    const current = cursorTarget(TWO, 4, { editorLanguage: "sql", grammar: PG });
    expect(current?.sql).toBe("SELECT 1");
    expect(current?.start).toBe(0);
    expect(current?.end).toBe(8);
    expect(cursorTarget(TWO, 4, { editorLanguage: "json", grammar: PG })).toBeNull();
  });
});

describe("the whole text", () => {
  test("another editor language sends the whole text, with no range", () => {
    const answer = runTarget(sqlAt('{"find":"users"}', 3, { editorLanguage: "json" }));
    expect(answer).toEqual({ statement: '{"find":"users"}' });
    expect("range" in answer).toBe(false);
  });

  test("a text with no statement is sent whole, with no range", () => {
    const empty = runTarget(sqlAt("", 0));
    const blank = runTarget(sqlAt("   \n", 2));
    expect(empty).toEqual({ statement: "" });
    expect(blank).toEqual({ statement: "   \n" });
    expect("range" in empty).toBe(false);
    expect("range" in blank).toBe(false);
  });

  test("a text of only comments is one target", () => {
    expect(runTarget(sqlAt("-- only a comment\n", 0))).toEqual({
      statement: "-- only a comment",
      range: { start: 0, end: 17 },
    });
  });
});

describe("offsets it cannot honour", () => {
  test("a selection out of order or out of the text, or a cursor past the text, throws RangeError", () => {
    expect(() => runTarget(sqlAt(TWO, 5, { selection: { start: 5, end: 2 } }))).toThrow(RangeError);
    expect(() => runTarget(sqlAt(TWO, 5, { selection: { start: -1, end: 0 } }))).toThrow(RangeError);
    expect(() => runTarget(sqlAt(TWO, 5, { selection: { start: 0, end: 21 } }))).toThrow(RangeError);
    expect(() => runTarget(sqlAt(TWO, 21))).toThrow(RangeError);
    expect(() => runTarget(sqlAt(TWO, 21, { selection: { start: 0, end: 0 } }))).toThrow(RangeError);
    expect(() => runTarget(sqlAt(TWO, -1, { selection: { start: 0, end: 0 } }))).toThrow(RangeError);
  });
});
