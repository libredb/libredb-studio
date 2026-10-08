import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { readSqlSpan, type SqlSpan } from "@/lib/sql/spans";
import { readSqlWord } from "@/lib/sql/words";
import { classifySelectPrefix } from "./select-prefix";
import { INDENT, buildTree, cellText, isRecord, withRoot, type PlanLine } from "./text-plan";
import type { ExplainMode, ExplainPlanInput, ExplainStrategy, ExplainTreeNode } from "./types";

/**
 * This strategy's dialect, resolved once. Reached only through
 * `explainFormat: "databend-text"`, which only the Databend provider declares, so the
 * module's identity IS the dialect - the same shape as a provider passing `this.type`.
 */
const DATABEND_GRAMMAR = resolveSqlGrammar("databend");

/**
 * The prefix, and the decision behind it.
 *
 * Databend's `EXPLAIN ANALYZE` drains the pipeline, so it runs the statement and bills a
 * full run, while plain `EXPLAIN` plans it. Both modes therefore emit the plain form: the
 * Explain button always asks for "analyze" and skips the confirmation gate, so honouring
 * the mode would run SELECT-shaped writers unconfirmed. Trino, ClickHouse, SQLite,
 * Couchbase and Druid ignore the mode the same way.
 *
 * Plain `EXPLAIN` is still not free of execution: the binder runs a subquery written in a
 * table-function argument, a PIVOT value subquery and a MATERIALIZED CTE while it plans
 * (measured on v1.2.951: `EXPLAIN SELECT * FROM numbers((SELECT nextval(s)))` moved the
 * sequence, as did the comment-led and `FROM`-first spellings, and a MATERIALIZED CTE
 * moved it once a client session was present, which Studio always sends). Derived tables
 * and `IN` or `EXISTS` subqueries bind without executing. `walk` below is what keeps
 * those executions off the Explain path.
 */
const EXPLAIN_PREFIX = "EXPLAIN ";

/**
 * Names whose presence anywhere in the code declines both modes, compared upper-cased, in two groups because a
 * decline names its reason.
 *
 * `MATERIALIZED` and `PIVOT` are the binder constructs that execute under plain EXPLAIN, each with the words the
 * reason names it by. `NEXTVAL` takes a sequence value, and the other six are the table functions that write
 * from a SELECT shape (`table_function_factory.rs`): `FUSE_VACUUM2` vacuums tables, and
 * `SET_CACHE_CAPACITY` really moved a cache's capacity under
 * plain EXPLAIN when nested in an argument subquery. Four more act when read and are
 * registered in a release build: `SYNC_CRASH_ME` and `ASYNC_CRASH_ME` panic the query on
 * purpose and carry no build condition, `USER_TASK_CANCEL_ONGOING_EXECUTIONS` cancels a
 * task's open runs under the default `task-support` feature when tasks are on, and
 * `TASK_DEPENDENTS_ENABLE` enables a task's dependents when they are off. A name is
 * matched as a word and as a quoted identifier, so a writer nested in an argument
 * subquery never runs on an Explain click.
 */
const BINDER_CONSTRUCTS: ReadonlyMap<string, string> = new Map([
  ["MATERIALIZED", "a MATERIALIZED CTE"],
  ["PIVOT", "a PIVOT"],
]);

const WRITER_NAMES = new Set([
  "NEXTVAL",
  "FUSE_AMEND",
  "SET_CACHE_CAPACITY",
  "FUSE_VACUUM2",
  "FUSE_VACUUM_TEMPORARY_TABLE",
  "FUSE_VACUUM_DROP_AGGREGATING_INDEX",
  "FUSE_VACUUM_DROP_INVERTED_INDEX",
  "SYNC_CRASH_ME",
  "ASYNC_CRASH_ME",
  "USER_TASK_CANCEL_ONGOING_EXECUTIONS",
  "TASK_DEPENDENTS_ENABLE",
]);

/**
 * The words that open a query, and so a subquery after `(`. Databend accepts a
 * parenthesised `FROM`-first query and a parenthesised `VALUES` list besides `SELECT`
 * and `WITH` (`query.rs`), which is why a raw-text "parenthesised SELECT" check misses
 * argument subqueries.
 */
const QUERY_OPENERS = new Set(["SELECT", "WITH", "FROM", "VALUES"]);

/**
 * The parenthesis depth, counting the opener itself, from which a subquery is an
 * argument subquery: a table function's argument always sits inside the function's own
 * parentheses, while a derived table and an `IN` or `EXISTS` subquery open at depth 1.
 * A depth-1 subquery nested inside another parenthesis is declined too, which costs the
 * estimate a plan rather than running anything; the decline rate over the generated
 * queries is recorded in the design's probe results.
 */
const ARGUMENT_SUBQUERY_DEPTH = 2;

/**
 * Databend's only dollar literal. A tagged run (`$a$ ... $a$`) is a dollar string to the
 * span reader, but Databend lexes `$a$` as a variable and reads what lies between two of
 * them as code (measured on v1.2.951: an argument subquery between two tags ran under
 * plain EXPLAIN), so a tagged run declines.
 */
const DOLLAR_LITERAL_OPENER = "$$";

/**
 * Three readings where Databend sees code that the span reader takes for trivia or a
 * literal, all of which the provider's statement guard refuses on Run; an explain
 * strategy does not import a provider, so the screen declines them itself. A form feed
 * ends a `--` comment in Databend, a `/*+` block is an optimizer hint whose body
 * Databend tokenizes, and a stage token (`@name`) takes a backslash and the quote after
 * it, `--`, `/*`, `$$` and `[` into the name, up to the first of these ending
 * characters, where the span reader opens a comment, a literal or an array that can end
 * past the token. The token's `\s` is Unicode White_Space, which JavaScript's `\s` is
 * not: measured on v1.2.951, U+0085 ends a stage name and U+FEFF does not. An `@` that
 * ends a `<@` operator opens no stage token.
 */
const FORM_FEED = "\f";
const HINT_OPENER = "/*+";
const STAGE_END = /[\p{White_Space},`;'"()]/u;

/**
 * Where the stage token whose `@` is at `index` ends, or `undefined` when the span
 * reader reads part of it as other than plain code: a backslash, or any run it opens
 * there, a `[` included.
 */
function plainStageEnd(sql: string, index: number): number | undefined {
  let i = index + 1;
  while (i < sql.length && !STAGE_END.test(sql[i])) {
    if (sql[i] === "\\" || readSqlSpan(sql, i, DATABEND_GRAMMAR) !== null) return undefined;
    i++;
  }
  return i;
}

/**
 * Whether the `@` at `index` ends a `<@` operator (`ArrowAt`), the one operator that
 * starts with another character and takes an `@` in: the lexer takes the longest token,
 * so a run of `<` is read in pairs from its start, `<<` before `<@`, and only after an
 * even run does the `@` open a stage token.
 */
function endsArrowAt(sql: string, index: number): boolean {
  let start = index;
  while (start > 0 && sql[start - 1] === "<") start--;
  return (index - start) % 2 === 1;
}

/**
 * The span at `index`, a `[` read as the code character it is: an array subscript's
 * contents are code, and reading one to its closing bracket at every level of a nest, or
 * after every `(`, is quadratic.
 */
function codeSpan(sql: string, index: number): SqlSpan | null {
  return sql[index] === "[" ? null : readSqlSpan(sql, index, DATABEND_GRAMMAR);
}

/** The spans the walk skips without reading: they are not the statement's own code. */
const TRIVIA = new Set(["whitespace", "line-comment", "block-comment"]);

/** The first code word at or after `index`, comments and whitespace skipped, or `null`. */
function nextCodeWord(sql: string, index: number): string | null {
  let i = index;
  let span = codeSpan(sql, i);
  while (span !== null && TRIVIA.has(span.kind)) {
    i = span.end;
    span = codeSpan(sql, i);
  }
  return readSqlWord(sql, i)?.text ?? null;
}

/** What every decline costs the person, the same whatever declined. */
const NO_PLAN = "does not ask Databend for this statement's plan";

/** Why text Databend reads differently from Studio declines: the screen cannot read it as Databend does. */
const UNREADABLE = `so Studio cannot check what Databend would run while planning it and ${NO_PLAN}`;

/** Where the depth rule of the estimate declines: a table function's argument, or a subquery as deep. */
const NESTED_SUBQUERY = "a subquery two or more parentheses deep, where a table function's argument sits";

/**
 * The estimate's reason for its depth rule, which the Explain button never meets, since it plans such a subquery. The
 * automatic estimate declines without a word, so no toast shows it, and it stands outside the record below, which the
 * doc quotes.
 */
export const DATABEND_NESTED_DECLINE = `Databend can run part of a statement with ${NESTED_SUBQUERY} while it plans it, so Studio ${NO_PLAN}.`;

/**
 * Why the strategy declines a SELECT-shaped statement, one sentence per reason, which `declineReason` hands the
 * Explain button in place of the sentence that the statement is not a SELECT (CL-CORE-1). The doc quotes each one
 * (`docs/providers/databend.md` section 5.6).
 *
 * A name is matched as a word, wherever it stands, so the first two say only that the statement names it: a column
 * called `materialized` declines as a MATERIALIZED CTE does. Each advice sentence ends its reason only where the text
 * with that one hint or form feed taken out, or that run quoted with `$$`, is planned (`screen`), since it promises a
 * plan.
 */
export const DATABEND_EXPLAIN_DECLINES = Object.freeze({
  binding: (word: string, construct: string) =>
    `This statement names ${word}, and Databend can run part of a statement with ${construct} while it plans it, so Studio ${NO_PLAN}.`,
  writer: (name: string) =>
    `This statement names ${name}, which writes or acts when Databend runs it, and Databend can run part of a statement while it plans it, so Studio ${NO_PLAN}.`,
  hint: `This statement has an optimizer hint (/*+ ... */), which Databend reads as code and Studio as a comment, ${UNREADABLE}.`,
  stage: `A stage name (@...) in this statement holds a backslash or runs into a comment, a dollar quote or a bracket, which Databend reads as part of the name, ${UNREADABLE}.`,
  formFeed: `This statement holds a form feed, which ends a -- comment in Databend but not in Studio's reading, ${UNREADABLE}.`,
  taggedDollar: `A dollar-quoted run in this statement is tagged ($name$), which Databend reads as a variable and not a quote, ${UNREADABLE}.`,
  unterminated: `A quote or comment in this statement never closes, ${UNREADABLE}.`,
  hintAdvice: "Remove the hint to see the plan.",
  formFeedAdvice: "Remove the form feed to see the plan.",
  taggedDollarAdvice: "Use $$ quoting to see the plan.",
});

/**
 * A decline the walk met. `fix` is set for an obstacle a person can take out, a hint, a form feed or a tagged run: the
 * text with that one taken out, or that run quoted with `$$`, and the advice to do so.
 */
interface Decline {
  readonly reason: string;
  readonly fix?: { readonly text: string; readonly advice: string };
}

/** The decline a declined name gives, or null for a name that declines nothing. */
function nameDecline(name: string): Decline | null {
  const construct = BINDER_CONSTRUCTS.get(name);
  if (construct !== undefined) return { reason: DATABEND_EXPLAIN_DECLINES.binding(name, construct) };
  return WRITER_NAMES.has(name) ? { reason: DATABEND_EXPLAIN_DECLINES.writer(name.toLowerCase()) } : null;
}

/**
 * The first decline met walking this statement in this mode, or null when Explain may send it, walking code only:
 * strings and comments are skipped, a quoted identifier is read as the name it is, and an array subscript is code.
 * Text with a run that never closes declines, because what follows the run cannot be read.
 */
function walk(sql: string, mode: ExplainMode): Decline | null {
  const feed = sql.indexOf(FORM_FEED);
  if (feed >= 0) {
    const text = sql.slice(0, feed) + sql.slice(feed + FORM_FEED.length);
    return {
      reason: DATABEND_EXPLAIN_DECLINES.formFeed,
      fix: { text, advice: DATABEND_EXPLAIN_DECLINES.formFeedAdvice },
    };
  }
  let depth = 0;
  // Where the last plain stage token ends: an `@` before it is inside that token, read with it.
  let stageReadTo = 0;
  let i = 0;

  while (i < sql.length) {
    const span = codeSpan(sql, i);
    if (span !== null) {
      if (!span.terminated) return { reason: DATABEND_EXPLAIN_DECLINES.unterminated };
      if (span.kind === "dollar-string" && !sql.startsWith(DOLLAR_LITERAL_OPENER, i)) {
        // The tag is `$name$`, its name an identifier, so the second `$` closes it.
        const tag = sql.slice(i, sql.indexOf("$", i + 1) + 1);
        const body = sql.slice(i + tag.length, span.end - tag.length);
        const text = sql.slice(0, i) + DOLLAR_LITERAL_OPENER + body + DOLLAR_LITERAL_OPENER + sql.slice(span.end);
        return {
          reason: DATABEND_EXPLAIN_DECLINES.taggedDollar,
          fix: { text, advice: DATABEND_EXPLAIN_DECLINES.taggedDollarAdvice },
        };
      }
      if (span.kind === "block-comment" && sql.startsWith(HINT_OPENER, i)) {
        const text = sql.slice(0, i) + sql.slice(span.end);
        return { reason: DATABEND_EXPLAIN_DECLINES.hint, fix: { text, advice: DATABEND_EXPLAIN_DECLINES.hintAdvice } };
      }
      const quoted =
        span.kind === "quoted-identifier" ? nameDecline(sql.slice(i + 1, span.end - 1).toUpperCase()) : null;
      if (quoted !== null) return quoted;
      i = span.end;
      continue;
    }

    const word = readSqlWord(sql, i);
    if (word !== null) {
      const named = nameDecline(word.text);
      if (named !== null) return named;
      i = word.end;
      continue;
    }

    if (sql[i] === "@" && i >= stageReadTo && !endsArrowAt(sql, i)) {
      const end = plainStageEnd(sql, i);
      if (end === undefined) return { reason: DATABEND_EXPLAIN_DECLINES.stage };
      stageReadTo = end;
    }
    if (sql[i] === "(") {
      depth++;
      const opener = nextCodeWord(sql, i + 1);
      if (mode === "estimate" && depth >= ARGUMENT_SUBQUERY_DEPTH && opener !== null && QUERY_OPENERS.has(opener)) {
        return { reason: DATABEND_NESTED_DECLINE };
      }
    } else if (sql[i] === ")") {
      depth--;
    }
    i++;
  }

  return null;
}

/** Whether Explain sends this statement in this mode: SELECT-shaped, and nothing in it declines. */
function plans(sql: string, mode: ExplainMode): boolean {
  return classifySelectPrefix(sql, DATABEND_GRAMMAR) !== null && walk(sql, mode) === null;
}

/**
 * Why Explain may not send this statement in this mode, or null when it may: the first decline the walk meets. An
 * obstacle a person can take out is advised out only where the text without it is planned, since the advice promises
 * a plan; with anything else in the way the reason stands alone.
 */
function screen(sql: string, mode: ExplainMode): string | null {
  const decline = walk(sql, mode);
  if (decline === null) return null;
  const { reason, fix } = decline;
  return fix !== undefined && plans(fix.text, mode) ? `${reason} ${fix.advice}` : reason;
}

/** The property Databend prints its row estimate under; it becomes the node's metric. */
const EST_ROWS_KEY = "estimated rows";

/**
 * A plan node's line: an operator name, optionally with a parenthesised role
 * (`TableScan(Build)`). Every other line is a property of the node above it
 * (`output columns: [...]`, `build join filters:` and the lines under it).
 */
const NODE_LABEL = /^[A-Z]\w*(?:\(.*\))?$/;

/** A `key: value` property, split once at the first colon. */
const PROPERTY = /^([^:]+):\s*(.*)$/;

interface PendingNode {
  line: PlanLine;
  details: string[];
}

/**
 * The row estimate, or nothing. An empty or non-numeric value is an absent reading,
 * not a zero: `Number("")` is 0, and a badge nobody measured is the fabrication the
 * absence rule (#477) exists to prevent.
 */
function readEstRows(label: string): number | undefined {
  const match = PROPERTY.exec(label);
  if (match === null || match[1].trim().toLowerCase() !== EST_ROWS_KEY || match[2] === "") return undefined;
  const parsed = Number(match[2]);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Databend prints a plan as one row per line in its one `explain` column, a node's
 * properties drawn as children of the node with the same glyphs as its child nodes. So
 * a node line opens a tree node, and a property line becomes detail on the nearest node
 * above it that is less indented, its estimate a metric. A property with no node above
 * it becomes a node itself, so nothing printed is lost.
 */
function toPlanLines(texts: readonly string[]): PlanLine[] {
  const pending: PendingNode[] = [];
  const open: PendingNode[] = [];

  for (const text of texts) {
    const unindented = text.replace(INDENT, "");
    const label = unindented.trim();
    const indent = text.length - unindented.length;

    while (open.length > 0 && open[open.length - 1].line.indent >= indent) open.pop();
    const owner = open[open.length - 1];
    if (owner !== undefined && !NODE_LABEL.test(label)) {
      const estRows = readEstRows(label);
      if (estRows === undefined) owner.details.push(label);
      else owner.line.node.metrics = { estRows };
      continue;
    }

    const node: ExplainTreeNode = { label, children: [] };
    const entry: PendingNode = { line: { indent, text, node }, details: [] };
    pending.push(entry);
    open.push(entry);
  }

  return pending.map(({ line, details }) => {
    if (details.length > 0) line.node.detail = details.join("; ");
    return line;
  });
}

export const databendTextStrategy: ExplainStrategy = {
  format: "databend-text",
  buildSql(sql, mode) {
    return plans(sql, mode) ? `${EXPLAIN_PREFIX}${sql}` : null;
  },
  // The same walk as buildSql, so a SELECT-shaped statement gets a plan or a reason, never neither. A statement that
  // is not a SELECT gets none: the caller's own sentence says that.
  declineReason(sql, mode) {
    return classifySelectPrefix(sql, DATABEND_GRAMMAR) === null ? null : screen(sql, mode);
  },
  // No parsing here: the rows ARE the plan, one line per row.
  extractPlan(result) {
    return result.rows ?? [];
  },
  toRenderModel(raw): ExplainPlanInput | null {
    if (!Array.isArray(raw) || raw.length === 0 || !raw.every(isRecord)) return null;
    // Shape-driven, as mysql-text: the first column is the plan text whatever it is
    // called, and a blank line would be an empty box in the tree.
    const texts = raw.map((row) => cellText(Object.values(row)[0])).filter((text) => text.trim() !== "");
    if (texts.length === 0) return null;
    // The raw tab shows the plan as Databend printed it, every line verbatim.
    return { kind: "tree", root: withRoot(buildTree(toPlanLines(texts))), raw: texts.join("\n") };
  },
};
