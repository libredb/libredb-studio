/**
 * The Elasticsearch agent read-only path's statement check: which statements an agent sends, and which indices one may
 * read, decided before it is sent. Agent mode and MCP's `run_read_query` share it, through `queryReadOnly`.
 *
 * Two layers, and neither is a list of index names to keep away. The reader admits only statements whose index
 * reference it can name with certainty, refusing what an agent statement does not need; the server then says what that
 * reference resolves to, and a hidden or system target refuses the statement.
 *
 * The reader. A reference is named with certainty only where the reader and the engine split the text into the same
 * tokens, so the reader refuses, before anything is sent:
 *
 *  - any comment, `--` or `/*`, outside quotes: 9.1.4 ends a block comment where neither a flat nor a nesting reading
 *    ends it (the grammar row records the measurements), so no reading of a comment is trusted, and none is needed;
 *  - a quote that never closes. A quote is read with the grammar row, `'…'` and `"…"` closing at a quote that is not
 *    doubled, a backslash an ordinary character, as the engine reads both;
 *  - outside quotes, any character but ASCII letters, digits, `_`, `@`, a space, a tab, a line feed or a carriage
 *    return, and the operators `( ) , . * + - / % = < > !` and `::`; and anywhere, a control character or a surrogate
 *    with no partner. The engine upper-cases the text it reads, and some letters outside ASCII upper-case into ASCII
 *    ones, so a word outside ASCII can be a keyword to the engine and not to a reader;
 *  - a number that runs into a letter, `_` or `@`, or carries an exponent: the engine ends a number where its own rules
 *    end it, which can put a keyword right after the number where a reader of words sees none;
 *  - any statement but one `SELECT`, an `EXPLAIN` of one with its options in parentheses, or the agent's own column
 *    catalog read, `SYS COLUMNS` for every table or for one quoted table;
 *  - a second `SELECT`, or a `WITH`, anywhere, so no subquery and no named query reads an index;
 *  - a `FROM` but the one at the top level of the `SELECT` and one inside `EXTRACT(...)`, which takes a value;
 *  - a top-level `FROM` that is not followed by one table identifier, an optional alias, and then `WHERE`, `GROUP`,
 *    `HAVING`, `ORDER`, `LIMIT` or the end, so no `JOIN`, second relation, `FROZEN`, `PIVOT`, catalog, `::` selector or
 *    subquery;
 *  - a reference that is not a comma list of names, wildcards and exclusions written in letters, digits, `_`, `-`, `.`,
 *    `*` and `@`, none of them empty, and a reference with a name that starts with a dot, a hidden or system name, which
 *    is refused here without a request.
 *
 * What the reference rests on: in the 9.1.4 grammar an index is named only by a table identifier, which a query writes
 * after a `FROM` or a `JOIN` and a catalog command after its keywords; the grammar holds no script, no function the
 * engine lists takes an index name (measured 2026-11-01 with its function listing), and a remote cluster's index is
 * written with a catalog or a `:`, which the reader refuses. So once the reader admits a statement, the one reference
 * it returns names every index the statement reads.
 *
 * The server's answer. The reference is resolved as the login, with the wildcard expansion the SQL endpoint resolves a
 * table with (`SearchTransport.resolveTargets`), and the statement is refused when the answer cannot be read or names
 * nothing, or holds an index the server marks hidden or system, an alias it marks hidden or whose indices it marks so,
 * or a data stream it marks hidden or system. An alias over a data stream points at the stream's backing indices,
 * which the server marks hidden, so it is refused; a data stream is read by its own name. The check and the statement
 * are two requests, so a change made to the cluster between them is not seen.
 *
 * Every refusal is a `RefusedBeforeSendError`: nothing reached the SQL endpoint.
 */
import { RefusedBeforeSendError } from "@/lib/db/errors";
import { resolveSqlGrammar } from "@/lib/sql/grammar";
import { readSqlSpan } from "@/lib/sql/spans";
import type { SearchTransport } from "./transport";

export const COMMENT_REFUSAL =
  "The agent sends Elasticsearch no statement that holds a comment, -- or /*, outside its quotes: an agent statement needs none, so write it without one";

export const CHARACTER_REFUSAL =
  "The agent writes an Elasticsearch statement, outside its quotes, in ASCII letters, digits, _, @, spaces, tabs and line breaks, and the operators ( ) , . * + - / % = < > ! and ::, with no ; and no control character anywhere: this statement holds a character outside that set";

export const NUMBER_REFUSAL =
  "The agent writes each number in an Elasticsearch statement in plain digits, with at most a point between them, no exponent, and no letter, _ or @ right after it: this statement holds a number written otherwise";

export const UNREADABLE_REFUSAL =
  "The agent sends Elasticsearch no statement whose quote never closes, since where its names end cannot be read";

export const STATEMENT_REFUSAL =
  "The agent sends Elasticsearch one SELECT, an EXPLAIN of one (its options in parentheses allowed), or its own column catalog read, SYS COLUMNS for every table or for one quoted table: no other EXPLAIN, no WITH, and no DESCRIBE, SHOW, SYS or DEBUG command";

export const SUBQUERY_REFUSAL =
  "The agent sends Elasticsearch no statement with a second SELECT or a WITH in it: every index it reads must be the one written after its FROM";

export const FROM_REFUSAL =
  "The agent's Elasticsearch FROM names one index expression, quoted or bare, with an optional alias, and then WHERE, GROUP BY, HAVING, ORDER BY, LIMIT or the end: no JOIN, second relation, subquery, FROZEN, PIVOT, catalog or :: selector, and no other FROM but one inside EXTRACT";

export const DOT_INDEX_REFUSAL =
  "The agent names no Elasticsearch index that starts with a dot: those are the hidden and system indices, the security index among them, which a login that may read them reads through SQL; read a data stream by its own name rather than its backing index";

/** The refusal of a reference that is not an index expression the reader admits. */
export function expressionRefusal(reference: string): string {
  return `The agent writes an Elasticsearch index expression as comma-separated names, wildcards and exclusions of letters, digits, _, -, ., * and @, with no empty name, space, date math, catalog or :: selector, and "${reference}" is not one`;
}

/** The refusal of a reference the server resolves to a hidden or system target. */
export function hiddenTargetRefusal(reference: string): string {
  return `The agent reads no Elasticsearch index, alias or data stream the server marks hidden or system, and the server resolves "${reference}" to one`;
}

/** The refusal of a reference the server resolves to nothing. */
export function unresolvedRefusal(reference: string): string {
  return `The agent reads only an Elasticsearch index, alias or data stream the server resolves for its login, and the server resolves "${reference}" to none`;
}

/** The refusal of a reference whose resolution failed or could not be read. */
export function resolveFailedRefusal(reference: string, error: unknown): string {
  return `The agent reads only an Elasticsearch index, alias or data stream the server resolves for its login, and the server's answer about "${reference}" could not be read: ${error instanceof Error ? error.message : String(error)}`;
}

/** One token of a statement's code, as the reader splits it. */
type Token =
  | { readonly kind: "word"; readonly text: string; readonly upper: string }
  | { readonly kind: "quoted"; readonly text: string }
  | { readonly kind: "string" | "number" }
  | { readonly kind: "operator"; readonly text: string };

/** The engine's white space, and the only characters a token boundary may hold. */
const WHITE_SPACE = new Set([" ", "\t", "\n", "\r"]);
/** The operators an agent statement may write outside quotes; `::` is read on its own. */
const OPERATORS = new Set(["(", ")", ",", ".", "*", "+", "-", "/", "%", "=", "<", ">", "!"]);
/** A word: a letter or `_`, then letters, digits, `_` and `@`, the engine's identifier and keyword alphabet. */
const WORD_AT = /[A-Za-z_][A-Za-z0-9_@]*/y;
const DIGITS_AT = /[0-9]+/y;
/** What may not stand right after a number's digits: the engine would read it into the number, or a word from it. */
const WORD_CHARACTER = /[A-Za-z_@]/;
// oxlint-disable-next-line no-control-regex -- control characters are exactly what an agent statement may not hold
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
/** The words an `EXPLAIN`'s parenthesised options are written in, in the 9.1.4 grammar. */
const EXPLAIN_OPTIONS = new Set([
  "PLAN",
  "PARSED",
  "ANALYZED",
  "OPTIMIZED",
  "MAPPED",
  "EXECUTABLE",
  "ALL",
  "FORMAT",
  "TEXT",
  "GRAPHVIZ",
  "VERIFY",
  "TRUE",
  "FALSE",
]);
/** The words that may follow a top-level FROM's table identifier and its alias. */
const AFTER_FROM = new Set(["WHERE", "GROUP", "HAVING", "ORDER", "LIMIT"]);
/** One name of an index expression: an optional exclusion, then a name or wildcard that starts with neither `.` nor `_`. */
const EXPRESSION_PART = /^-?[A-Za-z0-9*@][A-Za-z0-9_.*@-]*$/;

const refuse = (sentence: string, sql: string) => new RefusedBeforeSendError(sentence, "elasticsearch", sql);

const isWord = (token: Token | undefined, word: string): boolean => token?.kind === "word" && token.upper === word;

const isOperator = (token: Token | undefined, operator: string): boolean =>
  token?.kind === "operator" && token.text === operator;

const isExplainOption = (token: Token | undefined): boolean =>
  token?.kind === "word" && EXPLAIN_OPTIONS.has(token.upper);

const isMarked = (targets: readonly { readonly hidden: boolean; readonly system: boolean }[]): boolean =>
  targets.some((target) => target.hidden || target.system);

/** The statement's code as tokens; refuses a comment, an unclosed quote, a character outside the set, or a number run on. */
function tokens(sql: string): Token[] {
  if (CONTROL_CHARACTER.test(sql) || !sql.isWellFormed()) throw refuse(CHARACTER_REFUSAL, sql);
  const grammar = resolveSqlGrammar("elasticsearch");
  const read: Token[] = [];
  let index = 0;
  // Where the last number's digits ended: a point right there belongs to the number, not to a qualified name.
  let numberEnd = -1;
  while (index < sql.length) {
    const ch = sql[index];
    const next = sql[index + 1];
    if (WHITE_SPACE.has(ch)) {
      index++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      const span = readSqlSpan(sql, index, grammar);
      if (span?.terminated !== true) throw refuse(UNREADABLE_REFUSAL, sql);
      read.push(
        ch === "'"
          ? { kind: "string" }
          : { kind: "quoted", text: sql.slice(index + 1, span.end - 1).replaceAll('""', '"') },
      );
      index = span.end;
      continue;
    }
    if ((ch === "-" && next === "-") || (ch === "/" && next === "*")) throw refuse(COMMENT_REFUSAL, sql);
    WORD_AT.lastIndex = index;
    const word = WORD_AT.exec(sql)?.[0];
    if (word !== undefined) {
      read.push({ kind: "word", text: word, upper: word.toUpperCase() });
      index += word.length;
      continue;
    }
    DIGITS_AT.lastIndex = index;
    const digits = DIGITS_AT.exec(sql)?.[0];
    if (digits !== undefined) {
      if (WORD_CHARACTER.test(sql[index + digits.length] ?? "")) throw refuse(NUMBER_REFUSAL, sql);
      read.push({ kind: "number" });
      index += digits.length;
      numberEnd = index;
      continue;
    }
    // A point right after a number's digits is the engine's decimal point, and a letter after it an exponent or a word.
    if (ch === "." && numberEnd === index && WORD_CHARACTER.test(next ?? "")) throw refuse(NUMBER_REFUSAL, sql);
    if (ch === ":" && next === ":" && sql[index + 2] !== ":") {
      read.push({ kind: "operator", text: "::" });
      index += 2;
      continue;
    }
    if (!OPERATORS.has(ch)) throw refuse(CHARACTER_REFUSAL, sql);
    read.push({ kind: "operator", text: ch });
    index++;
  }
  return read;
}

/**
 * The table identifier after the top-level FROM at `from`, checked to stand alone: a quoted or bare name, an optional
 * `AS` and alias, then a clause that ends the FROM or the end of the statement.
 */
function tableAfter(sql: string, body: readonly Token[], from: number): string {
  const table = body[from + 1];
  if (table?.kind !== "quoted" && table?.kind !== "word") throw refuse(FROM_REFUSAL, sql);
  const isAlias = (token: Token | undefined) =>
    token?.kind === "quoted" || (token?.kind === "word" && !AFTER_FROM.has(token.upper));
  let at = from + 2;
  if (isWord(body[at], "AS")) {
    at++;
    if (!isAlias(body[at])) throw refuse(FROM_REFUSAL, sql);
    at++;
  } else if (isAlias(body[at])) {
    at++;
  }
  const after = body[at];
  if (after !== undefined && !(after.kind === "word" && AFTER_FROM.has(after.upper))) throw refuse(FROM_REFUSAL, sql);
  return table.text;
}

/** The index reference a `SELECT`'s tokens hold after the keyword, or null when it reads no index. */
function selectReference(sql: string, body: readonly Token[]): string | null {
  if (body.some((token) => isWord(token, "SELECT") || isWord(token, "WITH"))) throw refuse(SUBQUERY_REFUSAL, sql);
  if (body.some((token) => isWord(token, "JOIN") || isWord(token, "FROZEN"))) throw refuse(FROM_REFUSAL, sql);
  let reference: string | null = null;
  // The word before each open parenthesis, innermost last: a FROM inside one is EXTRACT's, which takes a value.
  const opened: (string | null)[] = [];
  for (const [at, token] of body.entries()) {
    if (isOperator(token, "(")) {
      const before = body[at - 1];
      opened.push(before?.kind === "word" ? before.upper : null);
    } else if (isOperator(token, ")")) {
      opened.pop();
    } else if (isWord(token, "FROM")) {
      if (opened.length > 0 ? opened.at(-1) !== "EXTRACT" : reference !== null) throw refuse(FROM_REFUSAL, sql);
      if (opened.length === 0) reference = tableAfter(sql, body, at);
    }
  }
  return reference;
}

/** Refuses a reference that is not an index expression the reader admits, a dot-led name first. */
function assertExpression(sql: string, reference: string): void {
  const parts = reference.split(",");
  if (parts.some((part) => (part.startsWith("-") ? part.slice(1) : part).startsWith("."))) {
    throw refuse(DOT_INDEX_REFUSAL, sql);
  }
  if (!parts.every((part) => EXPRESSION_PART.test(part))) throw refuse(expressionRefusal(reference), sql);
}

/**
 * The index expression an agent statement reads, read from its text alone: the table identifier after the top-level
 * FROM of a `SELECT` or of an `EXPLAIN` of one, the table of the agent's `SYS COLUMNS`, or `*` for `SYS COLUMNS` with
 * none, which reads every table; null for a `SELECT` with no FROM. Refuses a statement the reader cannot read with
 * certainty, and a reference with an empty, malformed or dot-led name, before anything is sent.
 */
export function agentIndexReference(sql: string): string | null {
  const read = tokens(sql);
  let reference: string | null;
  if (isWord(read[0], "SYS")) {
    const [, columns, table, ...rest] = read;
    if (!isWord(columns, "COLUMNS") || rest.length > 0 || (table !== undefined && table.kind !== "quoted")) {
      throw refuse(STATEMENT_REFUSAL, sql);
    }
    reference = table?.text ?? "*";
  } else {
    let at = 0;
    if (isWord(read[0], "EXPLAIN")) {
      at = 1;
      if (isOperator(read[1], "(")) {
        at = 2;
        while (isExplainOption(read[at])) at++;
        if (!isOperator(read[at], ")")) throw refuse(STATEMENT_REFUSAL, sql);
        at++;
      }
    }
    if (!isWord(read[at], "SELECT")) throw refuse(STATEMENT_REFUSAL, sql);
    reference = selectReference(sql, read.slice(at + 1));
  }
  if (reference !== null) assertExpression(sql, reference);
  return reference;
}

/**
 * Asks the server what `reference` resolves to for the login, and refuses the statement when the answer cannot be read
 * or names nothing, or names an index, alias or data stream the server marks hidden or system, or an alias whose
 * indices it marks so. Each request goes out on `signal`.
 */
export async function assertReferenceVisible(
  sql: string,
  reference: string,
  transport: SearchTransport,
  signal?: AbortSignal,
): Promise<void> {
  const ask = async <T>(question: () => Promise<T>): Promise<T> => {
    try {
      return await question();
    } catch (error) {
      throw refuse(resolveFailedRefusal(reference, error), sql);
    }
  };
  const targets = await ask(() => transport.resolveTargets([reference], signal));
  if (targets.indices.length + targets.aliases.length + targets.dataStreams.length === 0) {
    throw refuse(unresolvedRefusal(reference), sql);
  }
  if (isMarked(targets.indices)) throw refuse(hiddenTargetRefusal(reference), sql);
  if (targets.aliases.length > 0) {
    // An alias reads the indices behind it, so each is asked about by its own name, and the alias for its own mark.
    const members = [...new Set(targets.aliases.flatMap((alias) => alias.indices))];
    const behind = (await ask(() => transport.resolveTargets(members, signal))).indices;
    if (!members.every((member) => behind.some((index) => index.name === member))) {
      throw refuse(resolveFailedRefusal(reference, "the indices behind an alias were not each answered"), sql);
    }
    if (isMarked(behind)) throw refuse(hiddenTargetRefusal(reference), sql);
    const hidden = await ask(() =>
      transport.hiddenAliases(
        targets.aliases.map((alias) => alias.name),
        signal,
      ),
    );
    if (hidden.length > 0) throw refuse(hiddenTargetRefusal(reference), sql);
  }
  if (targets.dataStreams.length > 0) {
    const streams = await ask(() => transport.dataStreamMarks(targets.dataStreams, signal));
    if (isMarked(streams)) throw refuse(hiddenTargetRefusal(reference), sql);
  }
}
