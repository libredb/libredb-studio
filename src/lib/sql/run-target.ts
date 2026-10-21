import type { ProviderCapabilities } from "@/lib/db/types";
import type { EditorLanguage } from "@/lib/editor/tab-language";
import type { SqlGrammar } from "./grammar";
import { type SplitStatement, splitCursorTargets } from "./statement-splitter";

/**
 * What text Run sends: the run target rule, on plain offsets, with no editor in it.
 *
 * Two callers read it.
 * `QueryEditor.tsx` reads its selection, text and caret from Monaco and calls the two parts, `selectionTarget` and
 * `cursorTarget`; the VS Code channel's `query/target` calls `runTarget` with the offsets its editor reports.
 * One rule for both, so the web editor and the extension never disagree about which statement a Run sends.
 */

/** A `[start, end)` offset pair into the text. */
export interface RunTargetRange {
  start: number;
  end: number;
}

/** What the rule reads besides the text: the editor language, the engine's declared terminator and its grammar. */
export interface RunTargetRule {
  editorLanguage: EditorLanguage;
  statementTerminator: ProviderCapabilities["statementTerminator"];
  grammar: SqlGrammar;
}

export interface RunTargetInput extends RunTargetRule {
  text: string;
  /** The selection; `start === end` is no selection. */
  selection: RunTargetRange;
  cursor: number;
}

/** The statement to send and, unless it is the whole text, where it sits. */
export interface RunTarget {
  statement: string;
  range?: RunTargetRange;
}

/** The selection's text to send, or null when it is blank and the cursor rule decides. */
export function selectionTarget(selected: string, rule: RunTargetRule): string | null {
  if (selected.trim().length === 0) return null;
  // An engine whose grammar takes no terminator refuses a trailing `;` (Elasticsearch answers
  // `extraneous input ';'`), and a selection is sent as written while the cursor rule reads its
  // statement through the splitter, which drops it (#1414). So a selection that is ONE statement
  // is read the same way there; a multi-statement one, and every other engine, is still sent
  // exactly as selected.
  if (rule.editorLanguage === "sql" && rule.statementTerminator === "none") {
    const statements = splitCursorTargets(selected, rule.grammar);
    if (statements.length === 1 && statements[0]) return statements[0].sql;
  }
  return selected;
}

/**
 * The cursor's statement under the `sql` editor language, or null (another language, or no statement).
 *
 * Read through the shared splitter, under the connection's grammar. This used to be `lastIndexOf(";")` over the raw
 * text: no spans, no dialect, not even a string-literal check, which made it the THIRD reader of "where does a
 * statement end" and the only one whose answer is what gets SENT. Measured in Chrome on 2026-08-25 against
 * PostgreSQL 18: a buffer PostgreSQL reads as one statement was cut at a `;` inside a nested comment, so what reached
 * the engine was a line comment plus the SELECT, and the grid read 0 rows where psql answers 2. A `;` inside a
 * literal (`SELECT 'a;b'`) cut the same way.
 *
 * A procedural body is one target (#1312): a cursor inside a PL/SQL unit, a SQLite trigger or a T-SQL
 * `CREATE PROCEDURE` batch runs the whole definition, and a `GO` or `/` line is never sent. A T-SQL batch that is a
 * run of statements still offers them one by one, so a cursor on a SELECT never sends the DELETE after it; a script
 * whose statements share a `DECLARE @x` is run by selecting it.
 */
export function cursorTarget(
  text: string,
  cursor: number,
  rule: Pick<RunTargetRule, "editorLanguage" | "grammar">,
): SplitStatement | null {
  if (rule.editorLanguage !== "sql") return null;
  const targets = splitCursorTargets(text, rule.grammar);
  // The statement the cursor is inside or immediately after, which is what "run this one" means
  // with the cursor resting at a statement's end. Whitespace between two statements belongs to
  // neither, so the last one that starts at or before the cursor wins, and with the cursor before
  // the first statement, that first one does.
  return [...targets].reverse().find((target) => target.start <= cursor) ?? targets[0] ?? null;
}

/**
 * The rule whole: a non-blank selection, then the cursor's statement, then the whole text (no `range` key).
 *
 * Throws a `RangeError` on offsets it cannot honour, so it never slices with them.
 */
export function runTarget(input: RunTargetInput): RunTarget {
  const { text, selection, cursor } = input;
  // Only an integer UTF-16 index is an offset: a fraction, a numeric string, an array or null would be coerced by
  // the comparisons and by `slice`, which would send a statement cut where no caller asked and echo the raw input back.
  if (!Number.isInteger(selection.start) || !Number.isInteger(selection.end)) {
    throw new RangeError(
      `run target: selection [${selection.start}, ${selection.end}) is not a pair of integer offsets`,
    );
  }
  if (!Number.isInteger(cursor)) {
    throw new RangeError(`run target: cursor ${cursor} is not an integer offset`);
  }
  if (!(0 <= selection.start && selection.start <= selection.end && selection.end <= text.length)) {
    throw new RangeError(
      `run target: selection [${selection.start}, ${selection.end}) is not within a text of length ${text.length}`,
    );
  }
  if (!(0 <= cursor && cursor <= text.length)) {
    throw new RangeError(`run target: cursor ${cursor} is not within a text of length ${text.length}`);
  }
  const selected = selectionTarget(text.slice(selection.start, selection.end), input);
  if (selected !== null) return { statement: selected, range: { start: selection.start, end: selection.end } };
  const current = cursorTarget(text, cursor, input);
  if (current) return { statement: current.sql, range: { start: current.start, end: current.end } };
  return { statement: text };
}
