/**
 * Input-stage statement-shape guard for the agent path (#328).
 *
 * DEFENSE IN DEPTH, NEVER THE BOUNDARY. The boundary is database-native: a
 * PostgreSQL read-only transaction under a least-privilege role, and a SQLite
 * read-only open with `query_only` re-asserted per statement (see the execution
 * profiles in `providers/sql/postgres.ts` / `sqlite.ts`). This guard exists
 * because those controls are scoped to what they protect and because silent
 * truncation is not a refusal: `prepare()` drops the tail of a multi-statement
 * string rather than rejecting it, and an operation that asked to run two
 * statements should be told no, not partly obeyed.
 *
 * Everything here reads the shared SQL readers in `src/lib/sql` rather than
 * matching text. That matters in both directions:
 *
 * - a keyword a statement merely MENTIONS — inside a string, a quoted
 *   identifier, a comment, a dollar-quoted body — is not the statement doing it
 *   (`words.ts` records four defects of exactly that kind), so a legitimate
 *   read like `SELECT 'insert into t' AS note` must stay allowed;
 * - a keyword hidden BEHIND trivia or a CTE list is still the statement doing
 *   it, so `/* SELECT *\/ INSERT …` and `WITH x AS (…) UPDATE …` must be
 *   refused. `readOperativeKeyword` answers the second one by walking the CTE
 *   grammar instead of searching the text.
 *
 * The reading is dialect-less (`DEFAULT_SQL_GRAMMAR`): the descriptor's input
 * contract is evaluated before a provider is chosen. Where the dialects disagree
 * about a run's meaning, the default reading is not automatically the safe one —
 * two forms disagree about where the STATEMENT ENDS, and reading them the
 * default way would admit a second statement rather than refuse a read:
 *
 * - `$tag$…$tag$` is a literal in PostgreSQL and a bind parameter followed by
 *   ordinary code in SQLite, so a `;` written inside one really terminates the
 *   statement there;
 * - `#` opens a comment in MySQL/ClickHouse, is an operator in PostgreSQL and
 *   prefixes a bind variable in SQLite.
 *
 * Both are therefore refused outright (`DIALECT_AMBIGUOUS_TEXT`) instead of
 * being read under one dialect's rules. A third form was considered and left
 * alone: `[…]` is a quoted identifier under this grammar and an array subscript
 * whose contents are CODE in PostgreSQL, so `SELECT a[1 ; DROP TABLE t]` reads
 * as one statement here and as two there. It stays admitted because it is not
 * exploitable on either engine this milestone serves — PostgreSQL takes one
 * command per Parse message and rejects that text outright, and SQLite really
 * does read the run as an identifier.
 *
 * The one direction this layer accepts being wrong is over-refusal, and it costs
 * real queries:
 *
 * - PostgreSQL's jsonb path operators `#>` and `#>>` are refused with everything
 *   else carrying a `#`. Use `->` / `->>` or `jsonb_extract_path()` instead.
 * - a bare non-reserved keyword used as an identifier (`SELECT copy FROM ads`,
 *   `SELECT set FROM t`) is refused; quoting it (`SELECT "set" FROM t`) is the
 *   escape hatch.
 * - a dollar-quoted literal (`SELECT $$x$$`) is refused; ordinary quotes are not.
 *
 * That trade is deliberate — a refused read is re-runnable, a missed write is not.
 */

import { z } from "zod";
import { DEFAULT_SQL_GRAMMAR } from "@/lib/sql/grammar";
import { readOperativeKeyword } from "@/lib/sql/operative-keyword";
import { hasUnterminatedSpan, readSqlSpan, type SqlSpanKind } from "@/lib/sql/spans";
import { readSqlWord } from "@/lib/sql/words";

export type AgentStatementViolation =
  /** Text carrying a literal or comment that never closes — unreadable, so refused. */
  | "UNDETERMINABLE_TEXT"
  /** A run the engines read differently, and differently about where the statement ends. */
  | "DIALECT_AMBIGUOUS_TEXT"
  /** A second statement follows a terminator; the agent path admits exactly one. */
  | "MULTIPLE_STATEMENTS"
  /** No statement to read (only trivia), or a shape the CTE reader cannot cross. */
  | "NO_STATEMENT"
  /** The keyword that operates the statement is not a bounded read. */
  | "NON_READ_STATEMENT"
  /**
   * A read-shaped statement carrying a word no bounded read may: a side effect (a
   * writing CTE, a setter function), a lock it takes and holds, or a hint whose answer
   * is not a fact about the committed database.
   */
  | "SIDE_EFFECT_KEYWORD";

/**
 * Keywords that may operate a statement on the agent path. An allowlist, so an
 * unknown, misspelled or novel command is refused by default rather than
 * needing an entry in a list of forbidden ones.
 *
 * `EXPLAIN` is here because plan inspection is a registered operation; the
 * executing form is caught by `ANALYZE` below rather than by a second allowlist.
 */
const READ_STATEMENTS: ReadonlySet<string> = new Set(["SELECT", "VALUES", "TABLE", "EXPLAIN"]);

/**
 * Words no bounded read may contain in its own code, whatever it leads with.
 *
 * Two families, and both are needed because the allowlist above is about the
 * statement's HEAD:
 *
 * - `INSERT` / `UPDATE` / `DELETE` / `MERGE` can ride inside a CTE body, where
 *   the operative keyword is still the `SELECT` that reads the CTE. Those four
 *   and no others carry a data-modifying CTE — verified on PostgreSQL 18 and
 *   recorded in `lib/explain/select-prefix.ts`.
 * - the statement commands can ride behind an allowed `EXPLAIN`, which prefixes
 *   any statement in both engines this milestone serves.
 *
 * `REPLACE` is deliberately absent: it is a scalar function in both engines
 * (`replace(v, 'a', 'b')`), and SQLite's `REPLACE INTO` leads a statement, so
 * the allowlist already refuses it. `COMMIT`, `ROLLBACK` and `BEGIN` are absent
 * for the same reason — they can only appear as a head or after a terminator,
 * and both are refused above.
 */
const SIDE_EFFECT_WORDS: ReadonlySet<string> = new Set([
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "TRUNCATE",
  "CREATE",
  "DROP",
  "ALTER",
  "GRANT",
  "REVOKE",
  "ATTACH",
  "DETACH",
  "PRAGMA",
  "VACUUM",
  "REINDEX",
  "COPY",
  "CALL",
  "DO",
  "SET",
  "LOCK",
  "LOAD_EXTENSION",
  // A SELECT-headed statement that writes: PostgreSQL's `SELECT … INTO <table>`
  // creates one, MySQL's `INTO OUTFILE` writes a server-side file. Costs no
  // legitimate read on either supported engine, since `INSERT INTO` and
  // `MERGE INTO` are already refused by the rules above.
  "INTO",
  // T-SQL table hints that take or HOLD a restrictive lock, which is the one thing
  // a SELECT can do to a database without writing to it. `LOCK` above already
  // refuses PostgreSQL's spelling of the same act; these are SQL Server's, and they
  // ride INSIDE a SELECT rather than heading a statement of their own, so nothing
  // else sees them.
  //
  // Measured on SQL Server 2022 CU26, as the least-privilege agent principal:
  // `SELECT TOP 1 … FROM Person.Person WITH (TABLOCKX, HOLDLOCK)` compiles to ONE
  // root statement of type `SELECT`, so the provider's own admission step admits it,
  // and executing it inside the agent's transaction took twenty `X` object locks on
  // `Person.Person` and blocked an independent writer for as long as the transaction
  // lived (control: the same UPDATE completed in 30ms with no lock held, 2523ms with
  // it). No isolation level refuses the hint: `SNAPSHOT` and `READ COMMITTED` both
  // accepted it, measured. So this layer is where it has to be refused.
  "TABLOCK",
  "TABLOCKX",
  "XLOCK",
  "UPDLOCK",
  "HOLDLOCK",
  "REPEATABLEREAD",
  "SERIALIZABLE",
  // The OPPOSITE kind of T-SQL hint, refused for the opposite reason. These take FEWER
  // locks, so they harm no other session at all; what they cost is the ANSWER. Under
  // either dirty-read spelling the statement reads rows from transactions that may never
  // commit, and `READPAST` silently omits rows another session has locked.
  //
  // That is refused because of what this path is FOR. Every claim an agent composes
  // cites the result it came from, and the run reports those numbers to a user as facts
  // about their database. A dirty read passes every citation check there is - the
  // artifact is real, the correlation id resolves - while the number in it is not a fact
  // about the committed database, and re-running the read gives a different one with
  // neither looking wrong. It is the same class as the `FOR JSON` refusal in
  // `providers/sql/mssql.ts`: a wrong answer nothing downstream can tell from a right
  // one, arriving by another door.
  //
  // Measured on SQL Server 2022 CU26 as the least-privilege agent principal, against a
  // second session holding an uncommitted UPDATE. `WITH (NOLOCK)` and
  // `WITH (READUNCOMMITTED)` both returned the uncommitted value of a transaction that
  // then ROLLED BACK (`Person.Person` row 1 came back `DIRTYVALUE` where the committed
  // value is `Ken`), and `WITH (READPAST)` answered `count(*) = 2` over three committed
  // rows, short by the locked one and with no error. As with the seven above, the
  // provider's admission step cannot see any of them: a hinted SELECT compiles to ONE
  // root of class `SELECT`, measured.
  //
  // Nothing honest is lost by refusing. The same read without the hint is bounded by the
  // `SET LOCK_TIMEOUT` the profile already issues per statement: measured as error 1222
  // after 1.5s on a database with read-committed snapshot OFF, and where it is ON, as the
  // fixture database is, the read does not wait at all and answered the committed value
  // immediately. An error a model can report and repair is worth more here than a number
  // that is quietly wrong.
  //
  // They share the `SIDE_EFFECT_KEYWORD` code, which under-names them: this set is
  // "words no bounded read may contain", and a code of their own would put a new word in
  // the vocabulary the model and the rail both read for a refusal whose repair is the
  // same one, dropping the hint.
  "NOLOCK",
  "READUNCOMMITTED",
  "READPAST",
]);

/**
 * SQLite exposes pragmas as table-valued functions too, and some accept the
 * value as an argument — `pragma_query_only(0)` is the setter form found while
 * reviewing the SQLite profile. A prefix rule covers the whole family; matching
 * `PRAGMA` alone would not, because the function name is one word.
 */
const PRAGMA_FUNCTION_PREFIX = "PRAGMA_";

/**
 * Permitted only for the plan-EXECUTION descriptor; a bare `ANALYZE` writes
 * statistics in both engines.
 *
 * BOTH spellings, because PostgreSQL accepts `ANALYSE` as a full synonym and it
 * executes the statement just the same. Knowing one spelling would let plan
 * execution be requested through the risk-class-0, approval-free plan-INSPECTION
 * descriptor — a whole risk class and its approval gate bypassed by a vowel.
 */
const PLAN_EXECUTION_WORDS: ReadonlySet<string> = new Set(["ANALYZE", "ANALYSE"]);

export interface AgentStatementOptions {
  /** true only for the approval-gated plan-execution descriptor (`sql.explain.analyze`). */
  readonly allowPlanExecution?: boolean;
}

/**
 * Whether a span is the statement's own text rather than trivia between tokens.
 * The same four kinds `statement-end.ts` treats as statement text — a literal, a
 * quoted name and a bracketed subscript are tokens a statement is made of.
 *
 * Only two of the four are reachable from this file's single caller, measured
 * 2026-08-27 by deleting each disjunct in turn: `scanStatementShape` reads with
 * `DEFAULT_SQL_GRAMMAR`, whose brackets are quoted names rather than subscripts,
 * and a `dollar-string` span has already set `dialectAmbiguous`, which
 * `inspectAgentStatement` answers before it looks at the tail. So no fixture can
 * pin `dollar-string` or `subscript` here; the list is kept whole anyway because
 * it is the shared reading of what a statement is made of, and a caller passing
 * a named grammar would reach both.
 */
function isStatementText(kind: SqlSpanKind): boolean {
  return kind === "string" || kind === "quoted-identifier" || kind === "dollar-string" || kind === "subscript";
}

/**
 * One walk answering both questions about where this statement ends: whether
 * anything but trivia follows a terminator, and whether the text carries a run
 * the engines would terminate the statement at differently.
 *
 * A `;` inside a literal, a quoted name or a comment is not a terminator, which
 * is why this walks spans rather than splitting on the character. Trailing
 * `;`s, whitespace and comments are not a second statement.
 */
function scanStatementShape(sql: string): { dialectAmbiguous: boolean; statementTail: boolean } {
  let terminated = false;
  let statementTail = false;
  let dialectAmbiguous = false;
  let i = 0;

  while (i < sql.length) {
    const span = readSqlSpan(sql, i, DEFAULT_SQL_GRAMMAR);
    if (span !== null) {
      // A `$…$` run read as a literal here is code in SQLite; a `#` run read as
      // a comment here is an operator in PostgreSQL. Either way this reader
      // cannot say where the statement ends, so it says so.
      if (span.kind === "dollar-string" || sql[i] === "#") dialectAmbiguous = true;
      if (terminated && isStatementText(span.kind)) statementTail = true;
      i = span.end;
      continue;
    }

    if (sql[i] === ";") terminated = true;
    else if (sql[i] === "#") dialectAmbiguous = true;
    else if (terminated && !/\s/.test(sql[i])) statementTail = true;
    i++;
  }

  return { dialectAmbiguous, statementTail };
}

/** The first forbidden word in this statement's own code, or null. */
function findSideEffectWord(sql: string, allowPlanExecution: boolean): string | null {
  let i = 0;

  while (i < sql.length) {
    const span = readSqlSpan(sql, i, DEFAULT_SQL_GRAMMAR);
    if (span !== null) {
      i = span.end;
      continue;
    }

    const word = readSqlWord(sql, i);
    if (word === null) {
      i++;
      continue;
    }
    if (SIDE_EFFECT_WORDS.has(word.text) || word.text.startsWith(PRAGMA_FUNCTION_PREFIX)) return word.text;
    if (PLAN_EXECUTION_WORDS.has(word.text) && !allowPlanExecution) return word.text;
    i = word.end;
  }

  return null;
}

/**
 * The statement-shape violations every execution path shares, checked cheapest and most certain
 * first: unreadable text, text no single reading settles, a second statement after a terminator,
 * then no statement at all. The agent path layers its read-only rules on top; the MCP write path
 * (#1774) calls this alone, because a write is allowed but a second statement is not.
 */
export function inspectStatementShape(
  sql: string,
): Extract<
  AgentStatementViolation,
  "UNDETERMINABLE_TEXT" | "DIALECT_AMBIGUOUS_TEXT" | "MULTIPLE_STATEMENTS" | "NO_STATEMENT"
> | null {
  if (hasUnterminatedSpan(sql, DEFAULT_SQL_GRAMMAR)) return "UNDETERMINABLE_TEXT";

  const shape = scanStatementShape(sql);
  if (shape.dialectAmbiguous) return "DIALECT_AMBIGUOUS_TEXT";
  if (shape.statementTail) return "MULTIPLE_STATEMENTS";

  if (readOperativeKeyword(sql, DEFAULT_SQL_GRAMMAR) === null) return "NO_STATEMENT";
  return null;
}

/**
 * Why this statement may not run on the agent path, or `null` when the guard
 * has no objection. `null` is NOT a safety claim — it means this layer found
 * nothing; the database-native profile still has to refuse whatever it missed.
 *
 * Checks run cheapest-and-most-certain first, and the first one that fires is
 * the reported violation: unreadable text, then text no single reading settles,
 * then a second statement, then the statement's own shape, then what its code
 * carries.
 */
export function inspectAgentStatement(
  sql: string,
  options: AgentStatementOptions = {},
): AgentStatementViolation | null {
  const shapeViolation = inspectStatementShape(sql);
  if (shapeViolation !== null) return shapeViolation;

  const operative = readOperativeKeyword(sql, DEFAULT_SQL_GRAMMAR)!;
  if (!READ_STATEMENTS.has(operative.keyword)) return "NON_READ_STATEMENT";

  return findSideEffectWord(sql, options.allowPlanExecution === true) === null ? null : "SIDE_EFFECT_KEYWORD";
}

/**
 * Exactly one SQL statement string, shaped like a bounded read. Unknown keys
 * are rejected (fail closed), and the violation travels as the issue message so
 * a denial can be diagnosed without re-running the guard.
 */
function agentSqlInput(options: AgentStatementOptions) {
  return z.strictObject({ sql: z.string().min(1) }).superRefine((value, ctx) => {
    const violation = inspectAgentStatement(value.sql, options);
    if (violation !== null) {
      ctx.addIssue({ code: "custom", message: `agent statement refused: ${violation}`, path: ["sql"] });
    }
  });
}

export const agentReadSqlInput = agentSqlInput({});
export const agentPlanExecutionSqlInput = agentSqlInput({ allowPlanExecution: true });
