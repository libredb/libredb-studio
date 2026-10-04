/**
 * Where a multi-statement buffer's statements begin and end.
 *
 * The boundary is a `;` that is CODE, so the whole job is knowing which
 * characters are code - and that is `spans.ts`'s job, under the dialect facts
 * `grammar.ts` carries. This module used to inline its own scan of strings,
 * comments and dollar-quoting instead, wound together with the line counting it
 * needs, and it knew none of those facts: `#` was code, `q'…'` was a name
 * followed by a string, `[…]` and `` `…` `` were nothing at all, and a block
 * comment always ended at the first closer. So it disagreed with every other
 * reader in this folder about where a statement ends, and unlike them its
 * disagreement is not a missing bound: `/api/db/multi-query` RUNS each fragment
 * this returns.
 *
 * The sharp shape, and why S1 is a safety fix. Measured on postgres 18, the text
 *
 *     /* a /* b *\/ ; DROP TABLE users; -- *\/ SELECT 1
 *
 * is ONE read: PostgreSQL nests block comments, so everything up to the second
 * closer is comment text and the statement is `SELECT 1`. The flat, dialect-blind
 * reading cut it into three fragments whose SECOND is a bare `DROP TABLE users`,
 * the multi-statement route ran them in order, and the confirmation gate said
 * nothing because it reads the whole editor text - where there is no operative
 * keyword to find. The same family as #300, with the blast radius of an executed
 * statement rather than a missing row bound.
 *
 * S1 fixed the reading and left one fact still missing from the shared module, which
 * kept the same defect alive on three shipped engines: CQL and ClickHouse read `//`
 * to the end of the line, so
 *
 *     SELECT id FROM probe.customers // note; DROP TABLE probe.customers
 *
 * is ONE statement to Cassandra 5.0.9, ScyllaDB 2026.2.4 and ClickHouse 26.7.1
 * (measured 2026-08-25: the SELECT answers and the DROP does not run), and this
 * splitter returned two fragments whose second was a bare DROP. The confirmation gate
 * did prompt - the two readers agreed, which is what S1 bought - but confirming ran a
 * statement the operator's text never contained. `grammar.ts` carries the fact now
 * (`doubleSlashComment`), so this file needed no change of its own: reading through
 * `spans.ts` is what makes a new dialect fact arrive here for free.
 *
 * A caller that names no dialect gets `DEFAULT_SQL_GRAMMAR`, the same stated
 * default every other reader here applies to a dialect-less call, rather than the
 * ad-hoc reading this file used to have. It is a decision, not an absence: pinned
 * by its own tests.
 *
 * WHAT a statement is was the next fact missing (#1312). A PL/SQL unit, a SQLite trigger
 * and a T-SQL batch each carry `;` INSIDE one statement, and the end-to-end pass of
 * 2026-10-03/04 measured the cost on four engines: Oracle 26ai stored a procedure cut at
 * its inner `;` INVALID while the route reported its first fragment `success`, SQLite
 * answered `incomplete input`, and SQL Server lost `@x` between `DECLARE @x` and
 * `SELECT @x` because each fragment was its own request. `grammar.ts` now carries the
 * `script` facts, and this file reads them in three places:
 *
 * - a procedural BODY (`BodyReader` below) holds every `;` until its `END`;
 * - a SEPARATOR LINE (`GO`, `/`) ends the statement in progress and is never sent;
 * - `splitExecutionUnits` groups statements into what one request carries, which for
 *   T-SQL is the whole batch between separator lines.
 */

import { DEFAULT_SQL_GRAMMAR, type ProceduralBlockGrammar, type SqlGrammar } from "./grammar";
import { IDENTIFIER_PART, readSqlSpan } from "./spans";
import { readSqlWord, type SqlWord } from "./words";

export interface SplitStatement {
  sql: string;
  /** 0-based line number where this statement starts in the original text */
  startLine: number;
  /**
   * Where this statement's TRIMMED text sits in the original input, as a
   * `[start, end)` offset pair.
   *
   * Carried because a caller that has a CURSOR needs to know which statement it is
   * in, and a line number cannot answer that for a multi-statement line. The editor's
   * "run the statement I am in" reader used to answer it with `lastIndexOf(";")` -
   * no spans, no dialect, not even a string-literal check - so it is the third reader
   * of this question and the one whose answer is what actually gets SENT.
   */
  start: number;
  end: number;
}

/**
 * What ONE request to the engine carries: a statement, or for a dialect whose unit is
 * the batch (`script.unit`), every statement between two separator lines, sent whole.
 */
export interface ExecutionUnit extends SplitStatement {
  /** The statements inside the unit, in order. Exactly one unless the unit is a batch. */
  statements: SplitStatement[];
}

/** Newlines in `text[from, to)`, which is how a span's height reaches the line count. */
function countNewlines(text: string, from: number, to: number): number {
  let newlines = 0;
  for (let i = from; i < to; i++) {
    if (text[i] === "\n") newlines++;
  }
  return newlines;
}

/** Whether only blanks stand between the previous newline (or the input's start) and `index`. */
function startsLine(text: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0 && (text[i] === " " || text[i] === "\t")) i--;
  return i < 0 || text[i] === "\n";
}

/**
 * Where the line after a separator line starts, or `null` when the line at `index` is not
 * one: the token, then only blanks and an optional `--` comment up to the newline.
 */
function separatorLineEnd(text: string, index: number, token: string): number | null {
  if (text.slice(index, index + token.length).toUpperCase() !== token) return null;
  let i = index + token.length;
  while (i < text.length && (text[i] === " " || text[i] === "\t" || text[i] === "\r")) i++;
  if (text.startsWith("--", i)) {
    while (i < text.length && text[i] !== "\n") i++;
  }
  if (i === text.length) return i;
  return text[i] === "\n" ? i + 1 : null;
}

/** The next code word after `from`, skipping only whitespace and comments. */
function nextCodeWord(text: string, from: number, grammar: SqlGrammar): (SqlWord & { start: number }) | null {
  let i = from;
  for (;;) {
    const span = readSqlSpan(text, i, grammar);
    if (
      span === null ||
      (span.kind !== "whitespace" && span.kind !== "line-comment" && span.kind !== "block-comment")
    ) {
      break;
    }
    i = span.end;
  }
  const word = readSqlWord(text, i);
  return word === null ? null : { ...word, start: i };
}

/** Reads the code word after `from`, or after the word being taken when `from` is omitted. */
type Peek = (from?: number) => (SqlWord & { start: number }) | null;

/** Words SQL*Plus allows between `CREATE` and the kind of PL/SQL unit being created. */
const PLSQL_CREATE_MODIFIERS = new Set(["OR", "REPLACE", "EDITIONABLE", "NONEDITIONABLE", "EDITIONING"]);
/** The unit kinds whose header ends at an `AS` or `IS` that opens their declarations. */
const PLSQL_ROUTINES = new Set(["PROCEDURE", "FUNCTION", "PACKAGE"]);
/** The closers that end a construct this reader never counted as opened. */
const UNCOUNTED_CLOSERS = new Set(["IF", "LOOP"]);
/**
 * What may follow a routine header's `AS`/`IS` in place of a body: a call spec
 * (`AS LANGUAGE JAVA NAME '…'`, `AS LANGUAGE C …`, `AS EXTERNAL …`) or an MLE module call
 * (`AS MLE MODULE …`). None of them has an `END`, so none opens a frame; reading one as a
 * declaration section held every `;` after it and swallowed the rest of the script.
 */
const PLSQL_CALL_SPECS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // Keyed by the word after `AS`/`IS`, valued by the words that may follow IT: a call spec is
  // that pair, while a declaration whose NAME is `language` (`AS language VARCHAR2(10);`) is
  // followed by its type and opens a declaration section like any other.
  ["LANGUAGE", new Set(["JAVA", "C", "JAVASCRIPT"])],
  ["EXTERNAL", new Set(["LIBRARY", "NAME", "PARAMETERS", "WITH", "LANGUAGE", "AGENT", "CALLING"])],
  ["MLE", new Set(["MODULE", "LANGUAGE"])],
]);
/** The words that open a compound trigger's timing point (`BEFORE EACH ROW IS …`). */
const PLSQL_TIMING_POINTS = new Set(["BEFORE", "AFTER", "INSTEAD"]);

/**
 * What a frame on the body stack is.
 *
 * - `declare` - a declaration section (`DECLARE`, or a routine header's `AS`/`IS`)
 *   whose `BEGIN` has not been seen. That `BEGIN` does not open a second frame: the
 *   section and its body share ONE `END`, which is the whole reason this is a stack of
 *   frames and not a counter of `BEGIN`s.
 * - `body` - a `BEGIN` block, or a declaration section past its `BEGIN`.
 * - `case` - a `CASE`, statement or expression, both of which close with `END`.
 * - `section` - a compound trigger's own declaration section (`COMPOUND TRIGGER` up to
 *   its last `END`). Unlike `declare` it is never merged into by a `BEGIN`: each timing
 *   point inside it (`BEFORE STATEMENT IS BEGIN … END BEFORE STATEMENT;`) is a block of
 *   its own.
 *
 * `IF … END IF` and `LOOP … END LOOP` are not frames at all: their closer is `END`
 * followed by the opener's own word, so the reader skips that pair rather than counting
 * the opener, which also covers `WHILE … LOOP` and `FOR … LOOP`.
 */
type Frame = "declare" | "body" | "case" | "section";

/**
 * Whether the statement being read has a procedural body, and where that body ends.
 *
 * Reads the statement's code words one at a time. Until the leading words decide the
 * statement's kind it only collects them; a statement that is not a body unit is then
 * left alone entirely, so every other statement reads exactly as it did before the
 * `script` fact existed. A unit holds every `;` while a frame is open, and the first
 * `;` after its last frame closes ends it as usual.
 *
 * A unit whose frames never close - a construct this reader does not model - holds its
 * `;` to the end of the input or to the next separator line, which is SQL*Plus's own rule for a PL/SQL unit:
 * it ends at `/`. That is the fail-safe direction, one statement too long rather than a
 * fragment the engine stores INVALID.
 */
class BodyReader {
  private state: "lead" | "unit" | "plain";
  private readonly lead: string[] = [];
  private readonly frames: Frame[] = [];
  private opened = false;
  /** The unit creates a procedure, function, package or type body. */
  private routine = false;
  /** A routine header has been read and its `AS`/`IS` would open its declarations. */
  private header = false;
  private parens = 0;

  constructor(private readonly rule: ProceduralBlockGrammar) {
    // A dialect with no bodies never reads a word, which is what keeps its statements
    // exactly as they were before the fact existed.
    this.state = rule === "none" ? "plain" : "lead";
  }

  /** Whether words still matter to this statement. */
  get reading(): boolean {
    return this.state !== "plain";
  }

  /** Whether a `;` at this point belongs to an open body rather than ending the statement. */
  get holdsSemicolon(): boolean {
    return this.frames.length > 0;
  }

  /**
   * Whether the `;` that ends the statement is part of it: PL/SQL's `END;`, and the `;` a
   * routine's call spec ends with, which Oracle refuses the unit without as well (measured
   * on 26ai Free 23.26.3: a Java call spec sent without it is stored INVALID, PLS-00103).
   */
  get keepsTerminator(): boolean {
    return this.rule === "pl-sql" && (this.opened || this.routine);
  }

  semicolon(): void {
    // A forward declaration in a package spec (`PROCEDURE q;`) has no `AS`/`IS`.
    this.header = false;
  }

  paren(character: string): void {
    this.parens += character === "(" ? 1 : -1;
  }

  /**
   * Take one code word. `peek` reads the word after it, which `END`, `AS`/`IS` and
   * `COMPOUND` ask for; the answer is how far the reader consumed, the word's end or the
   * peeked word's. `label` says the word is a `<<label>>`, which names a block rather than
   * starting a statement, so it decides nothing about the statement's kind.
   */
  word(word: SqlWord, peek: Peek, label = false): number {
    if (this.state === "lead") {
      if (label) return word.end;
      this.classify(word.text);
    }
    if (this.state !== "unit") return word.end;

    switch (word.text) {
      case "BEGIN":
        if (this.frames.at(-1) === "declare") this.frames[this.frames.length - 1] = "body";
        else this.open("body");
        return word.end;
      case "CASE":
        this.open("case");
        return word.end;
      case "END": {
        const next = peek();
        if (next !== null && UNCOUNTED_CLOSERS.has(next.text)) return next.end;
        this.frames.pop();
        return next !== null && next.text === "CASE" ? next.end : word.end;
      }
    }

    if (this.rule === "pl-sql" && this.parens === 0) return this.plsqlWord(word, peek);
    return word.end;
  }

  private plsqlWord(word: SqlWord, peek: Peek): number {
    const text = word.text;
    if (text === "DECLARE") this.open("declare");
    else if (text === "PROCEDURE" || text === "FUNCTION") this.header = true;
    else if (PLSQL_TIMING_POINTS.has(text) && this.frames.at(-1) === "section") this.header = true;
    else if ((text === "AS" || text === "IS") && this.header) {
      this.header = false;
      const next = peek();
      const follows = next === null ? undefined : PLSQL_CALL_SPECS.get(next.text);
      const after = next === null || follows === undefined ? null : peek(next.end);
      if (after === null || follows === undefined || !follows.has(after.text)) this.open("declare");
    } else if (text === "COMPOUND") {
      const next = peek();
      if (next !== null && next.text === "TRIGGER") {
        this.open("section");
        return next.end;
      }
    }
    return word.end;
  }

  private open(frame: Frame): void {
    this.frames.push(frame);
    this.opened = true;
  }

  /** Decide from the leading words whether this statement is a unit with a body. */
  private classify(text: string): void {
    const first = this.lead.length === 0;
    if (first && text !== "CREATE") {
      // `BEGIN` opens a transaction in SQLite, so only PL/SQL reads it as a block.
      const anonymous = this.rule === "pl-sql" && (text === "DECLARE" || text === "BEGIN");
      this.state = anonymous ? "unit" : "plain";
      return;
    }
    this.lead.push(text);
    if (first) return;

    if (this.rule === "trigger-body") {
      if (text === "TRIGGER") this.state = "unit";
      else if (text !== "TEMP" && text !== "TEMPORARY") this.state = "plain";
      return;
    }

    if (this.lead.at(-2) === "TYPE") {
      // `CREATE TYPE … AS OBJECT (…)` is plain SQL; only its BODY is PL/SQL.
      this.state = text === "BODY" ? "unit" : "plain";
      this.header = text === "BODY";
      this.routine = text === "BODY";
    } else if (PLSQL_ROUTINES.has(text)) {
      this.state = "unit";
      this.header = true;
      this.routine = true;
    } else if (text === "TRIGGER") {
      // A trigger's body is a block that starts with `DECLARE` or `BEGIN`; its header has
      // no `AS`/`IS` of its own (`REFERENCING NEW AS n` is an alias), so none is read.
      this.state = "unit";
    } else if (text !== "TYPE" && !PLSQL_CREATE_MODIFIERS.has(text)) {
      this.state = "plain";
    }
  }
}

/** A statement and the batch it belongs to: the count of separator lines before it. */
interface ScannedStatement extends SplitStatement {
  batch: number;
}

interface Scan {
  statements: ScannedStatement[];
  /** Whether a separator line was read, which is text the engine must not receive. */
  separated: boolean;
}

function scan(input: string, grammar: SqlGrammar): Scan {
  const statements: ScannedStatement[] = [];
  const { blocks, separatorLine } = grammar.script;
  let segmentStart = 0;
  let statementStartLine = 0;
  let currentLine = 0;
  let batch = 0;
  let separated = false;
  let body = new BodyReader(blocks);
  let i = 0;

  const push = (end: number) => {
    const raw = input.slice(segmentStart, end);
    const sql = raw.trim();
    if (sql.length === 0) return;
    // The offsets describe the TRIMMED text, so a caller can slice the original and get
    // back exactly `sql`: the leading whitespace this trim drops is not part of the
    // statement, and a cursor sitting in it belongs to no statement in particular.
    const leading = raw.length - raw.trimStart().length;
    statements.push({
      sql,
      startLine: statementStartLine,
      start: segmentStart + leading,
      end: segmentStart + leading + sql.length,
      batch,
    });
  };

  // The next statement starts at `from`. A statement's reported line is where its TEXT
  // starts, so the run of whitespace after the terminator belongs to neither statement.
  // Comments are deliberately not skipped: a note above a statement is part of it, which
  // is what keeps an annotated final SELECT recognisable to the route's limiter (#281).
  const startNext = (from: number) => {
    i = from;
    const trivia = readSqlSpan(input, i, grammar);
    if (trivia !== null && trivia.kind === "whitespace") {
      currentLine += countNewlines(input, i, trivia.end);
      i = trivia.end;
    }
    segmentStart = i;
    statementStartLine = currentLine;
    body = new BodyReader(blocks);
  };

  while (i < input.length) {
    const span = readSqlSpan(input, i, grammar);
    if (span !== null) {
      // An UNTERMINATED span reaches the end of the input, so this branch also
      // carries the fail-safe direction the rest of this folder keeps: text no
      // reader can resolve yields no boundary at all rather than a guessed one.
      // The buffer then takes the single-statement route, and the confirmation
      // gate already asks about an unresolvable run (#297).
      currentLine += countNewlines(input, i, span.end);
      i = span.end;
      continue;
    }

    if (separatorLine !== null && startsLine(input, i)) {
      const after = separatorLineEnd(input, i, separatorLine);
      if (after !== null) {
        push(i);
        separated = true;
        batch++;
        currentLine += countNewlines(input, i, after);
        startNext(after);
        continue;
      }
    }

    if (input[i] === ";") {
      if (body.holdsSemicolon) {
        body.semicolon();
        i++;
        continue;
      }
      push(body.keepsTerminator ? i + 1 : i);
      startNext(i + 1);
      continue;
    }

    if (body.reading) {
      const word = i > 0 && (IDENTIFIER_PART.test(input[i - 1]) || input[i - 1] === "$") ? null : readSqlWord(input, i);
      // A word after a `.` is a qualified name's part (`NEW.end`, `t.begin`), never a keyword.
      if (word !== null && input[i - 1] === ".") {
        i = word.end;
        continue;
      }
      if (word !== null) {
        const peek: Peek = (from = word.end) => nextCodeWord(input, from, grammar);
        const end = body.word(word, peek, input.startsWith("<<", i - 2));
        currentLine += countNewlines(input, i, end);
        i = end;
        continue;
      }
      if (input[i] === "(" || input[i] === ")") body.paren(input[i]);
    }
    i++;
  }

  push(input.length);

  return { statements, separated };
}

/** A scanned statement without the bookkeeping the scan needed. */
function asStatement({ sql, startLine, start, end }: ScannedStatement): SplitStatement {
  return { sql, startLine, start, end };
}

/**
 * The statements of `input`, read under `grammar`.
 *
 * A procedural body is one statement with its `;` inside it, and a separator line ends
 * the statement in progress without being part of any. This is the reading every caller
 * that asks about STATEMENTS wants; a caller that SENDS text wants
 * `splitExecutionUnits`, which differs only where the dialect's unit is the batch.
 */
export function splitStatements(input: string, grammar: SqlGrammar = DEFAULT_SQL_GRAMMAR): SplitStatement[] {
  return scan(input, grammar).statements.map(asStatement);
}

/**
 * What the engine receives, one request per unit.
 *
 * The statements themselves, except where `grammar.script.unit` is `batch`: there every
 * statement between two separator lines travels as ONE request, the original text from
 * the first statement's start to the last one's end, inner `;` and all. That is what
 * keeps a T-SQL variable and a `#temp` table alive from one statement to the next
 * within a batch; across a `GO` they are not, which sqlcmd and SSMS agree with for the
 * variable and D92 records for the temp table.
 */
export function splitExecutionUnits(input: string, grammar: SqlGrammar = DEFAULT_SQL_GRAMMAR): ExecutionUnit[] {
  const { statements } = scan(input, grammar);
  if (grammar.script.unit === "statement") {
    return statements.map((statement) => ({ ...asStatement(statement), statements: [asStatement(statement)] }));
  }

  const units: ExecutionUnit[] = [];
  let unitBatch = -1;
  for (const statement of statements) {
    const unit = units.at(-1);
    if (unit !== undefined && statement.batch === unitBatch) {
      unit.end = statement.end;
      unit.sql = input.slice(unit.start, unit.end);
      unit.statements.push(asStatement(statement));
    } else {
      units.push({ ...asStatement(statement), statements: [asStatement(statement)] });
      unitBatch = statement.batch;
    }
  }
  return units;
}

/** The objects whose `CREATE` or `ALTER` must open a T-SQL batch and whose body runs to its end. */
const BATCH_MODULES = new Set(["PROC", "PROCEDURE", "FUNCTION", "TRIGGER", "VIEW"]);

/**
 * Whether this unit is ONE module definition rather than a run of statements: its first
 * statement is `CREATE`, `ALTER` or `CREATE OR ALTER` of a procedure, function, trigger or
 * view. T-SQL requires such a statement to be the first in its batch (Msg 111) and reads
 * everything after it, to the end of the batch, as the module's body, so the `;`-statements
 * inside it are not statements the server runs.
 *
 * Every other multi-statement unit IS a run of statements sent together, and the callers
 * that ask treat it as one: the cursor runs only the statement it is in, and the route
 * bounds the last statement when it is a read.
 */
export function unitIsModuleBody(unit: ExecutionUnit, grammar: SqlGrammar = DEFAULT_SQL_GRAMMAR): boolean {
  const first = unit.statements[0].sql;
  const verb = nextCodeWord(first, 0, grammar);
  if (verb === null || (verb.text !== "CREATE" && verb.text !== "ALTER")) return false;
  let kind = nextCodeWord(first, verb.end, grammar);
  if (kind?.text === "OR") {
    const alter = nextCodeWord(first, kind.end, grammar);
    kind = alter === null ? null : nextCodeWord(first, alter.end, grammar);
  }
  return kind !== null && BATCH_MODULES.has(kind.text);
}

/**
 * What "run the statement the cursor is in" may send: each unit, except that a batch which
 * is a run of statements offers its statements one by one. A caret on a `SELECT` must never
 * send the `DELETE` written after it in the same batch; a caret anywhere in a procedure body
 * sends the whole `CREATE PROCEDURE`, which is the only statement that body belongs to.
 */
export function splitCursorTargets(input: string, grammar: SqlGrammar = DEFAULT_SQL_GRAMMAR): SplitStatement[] {
  return splitExecutionUnits(input, grammar).flatMap((unit) => {
    const { statements, ...whole } = unit;
    return statements.length > 1 && !unitIsModuleBody(unit, grammar) ? statements : [whole];
  });
}

/**
 * Whether the text has to be cut before the engine sees it, which is the question the
 * editor asks to choose between the single-statement route and the multi-statement one.
 *
 * More than one statement, or ONE statement with a separator line around it: `GO` and
 * `/` are refused by the engine (`Incorrect syntax near 'GO'`), so even a single
 * statement written with one has to reach the route that strips it.
 */
export function isMultiStatement(input: string, grammar: SqlGrammar = DEFAULT_SQL_GRAMMAR): boolean {
  const { statements, separated } = scan(input, grammar);
  return statements.length > 1 || separated;
}

/** Does this fragment hold anything but whitespace and comments? */
function carriesCode(fragment: string, grammar: SqlGrammar): boolean {
  let i = 0;
  while (i < fragment.length) {
    const span = readSqlSpan(fragment, i, grammar);
    if (span === null) return true;
    if (span.kind !== "whitespace" && span.kind !== "line-comment" && span.kind !== "block-comment") return true;
    i = span.end;
  }
  return false;
}

/**
 * How many statements the text holds, not counting a fragment of comments only.
 *
 * `splitStatements` keeps such a fragment, so `SELECT 1; -- note` splits in two. That
 * is the right answer for the multi-statement ROUTE, whose behaviour for it is settled
 * and left alone here, but the wrong one for a caller asking whether a text is one
 * statement: the explain path refuses more than one (#1311), and counting the note
 * refused a single SELECT the run itself accepts.
 */
export function countCodeStatements(input: string, grammar: SqlGrammar = DEFAULT_SQL_GRAMMAR): number {
  return splitStatements(input, grammar).filter((statement) => carriesCode(statement.sql, grammar)).length;
}
