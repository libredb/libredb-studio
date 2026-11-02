/**
 * The OpenSearch agent read-only path's statement check: which statements an agent sends, and which indices one may
 * read, decided before it is sent. Agent mode and MCP's `run_read_query` share it, through `queryReadOnly`.
 *
 * Measured on 3.8.0 on 2026-11-02, with the security plugin off and signed in as `admin` with it on, OpenSearch SQL
 * answers the rows of an index the statement names whatever the server marks it: a hidden index by its name, a hidden
 * index through an alias over it, a data stream's backing index by its own name, an index whose name starts with a
 * dot, such as the ML plugin's `.plugins-ml-config`, by its name or through `*`, and a bundled plugin's index with no
 * dot and no hidden mark, such as the query insights plugin's `top_queries-<date>-<n>`, by its name or through `t*`;
 * signed in as `admin`, the security index `.opendistro_security` answers its columns (its documents stay hidden from
 * every REST read), and with security on, a role reading `*` reads the audit log `security-auditlog-<date>`. So, as on
 * Elasticsearch, the check is two layers.
 *
 * The reader. A reference is named with certainty only where the reader and the plugin split the text into the same
 * tokens. The plugin holds two SQL engines, the new one and the older one it falls back to, which read some text their
 * own ways, so the reader refuses, before anything is sent, what either reads in a way a reader cannot be sure of:
 *
 *  - any comment, `--`, `/*` or `#`, outside quotes: each is a comment to 3.8.0;
 *  - a backslash anywhere, which the new engine reads as an escape inside a string (`'a\'b'` answers `a'b`);
 *  - a quote that never closes, and a backtick-quoted name that holds a backtick, which 3.8.0 keeps in the name as
 *    written rather than reading as an escape. A string is `'…'`, closing at a quote that is not doubled;
 *  - outside quotes, any character but ASCII letters, digits, `_`, a space, a tab, a line feed or a carriage return,
 *    and the operators `( ) , . * + - / % = < > !`; so no `"` (a string to the new engine and part of an index name
 *    after a FROM), no `[…]` name, no `;`, no `:` and no `@`, which the plugin reads as the start of a name of its own
 *    even inside a bare word (`pa@b` is the table `pa` aliased `@b` to 3.8.0); and anywhere, a control character or a
 *    surrogate with no partner. The engine upper-cases the keywords it reads, and some letters outside ASCII
 *    upper-case into ASCII ones;
 *  - a number that runs into a letter or `_`, or carries an exponent;
 *  - any statement but one `SELECT` or the agent's own column catalog read of one table, `DESCRIBE TABLES LIKE
 *    '<table>'`; so the every-table read, `DESCRIBE TABLES LIKE %`, which the agent's overlay never composes, is
 *    refused;
 *  - a second `SELECT`, or a `WITH`, anywhere, so no subquery reads an index;
 *  - a `FROM` but the one at the top level of the `SELECT` and one inside `EXTRACT(...)`, which takes a value;
 *  - a top-level `FROM` that is not followed by one table identifier, an optional alias, and then `WHERE`, `GROUP`,
 *    `HAVING`, `ORDER`, `LIMIT` or the end, so no `JOIN`, second relation, comma, `/` type, qualifier or datasource:
 *    3.8.0 joins a qualified name's parts with a dot into one index name, and reads `` `@opensearch`.probe_orders ``
 *    from its default datasource;
 *  - a reference with a name that starts with a dot, as the security index and most bundled plugins' indices are
 *    named, whether or not the index it names is hidden, and a reference with an exclusion, a part that starts with
 *    `-`;
 *  - a reference that is not then a comma list of names and wildcards written in letters, digits, `_`, `-`, `.`, `*` and
 *    `@`, none of them empty and none starting with `_` or `@`.
 *
 * The server's answer, asked as the login in two resolutions, and the statement is refused when either cannot be read:
 *
 *  - the server's own resolution of the reference (`SearchTransport.resolveTargets`), with the wildcard expansion the
 *    SQL endpoint uses, names the indices, aliases and data streams it reaches: the statement is refused when it names
 *    nothing, an index the server marks hidden or system or whose name starts with a dot, or a data stream whose name
 *    starts with a dot. OpenSearch marks no index a system index in the resolution, and a leading dot is not every
 *    plugin's mark: the bundled plugins also write into indices named without one, on indices the server marks
 *    neither hidden nor system, so the dialect's measured row of those families (`pluginIndexFamilies` in
 *    `http-transport.ts`) marks an index in one a system index on the concrete name the server resolves; its data
 *    streams carry no mark of their own;
 *  - the SQL endpoint's own resolution of the reference (`SearchTransport.sqlTableIndices`), a request naming the same
 *    indices as the mappings read the plugin resolves a table with (measured equal over names, wildcards, comma lists,
 *    aliases over hidden and visible indices, a hidden alias and a data stream), names the concrete indices the
 *    statement reads: the statement is refused when that names none, or an index the first resolution does not
 *    account for, as one it names, a backing index of a data stream it names, or an index behind an alias it names;
 *    and an index read only through an alias is resolved by its own name, and refuses the statement when it is
 *    hidden or system or its name starts with a dot.
 *
 * So an alias over a data stream, whose backing indices the server marks hidden, is refused; a data stream is read by
 * its own name. An alias is not asked about for a mark of its own: what it reads is the indices behind it, each
 * checked by name, and asking would need a privilege a reader does not otherwise hold. The check and the statement
 * are separate requests, so a change made to the cluster between them is not seen.
 *
 * Every refusal is a `RefusedBeforeSendError`: nothing reached the SQL endpoint.
 */
import { RefusedBeforeSendError } from "@/lib/db/errors";
import type { SearchResolvedIndex, SearchTransport } from "./transport";

export const COMMENT_REFUSAL =
  "The agent sends OpenSearch no statement that holds a comment, --, /* or #, outside its quotes: an agent statement needs none, so write it without one";

export const CHARACTER_REFUSAL =
  "The agent writes an OpenSearch statement, outside its quotes, in ASCII letters, digits, _, spaces, tabs and line breaks, and the operators ( ) , . * + - / % = < > !, with names quoted in backticks and strings in single quotes, and no backslash, ; or control character anywhere: this statement holds a character outside that set";

export const NUMBER_REFUSAL =
  "The agent writes each number in an OpenSearch statement in plain digits, with at most a point between them, no exponent, and no letter or _ right after it: this statement holds a number written otherwise";

export const UNREADABLE_REFUSAL =
  "The agent sends OpenSearch no statement whose quote never closes or whose backtick-quoted name holds a backtick, since where its names end cannot be read";

export const STATEMENT_REFUSAL =
  "The agent sends OpenSearch one SELECT, or its own one-table column catalog read, DESCRIBE TABLES LIKE with one quoted table: no other DESCRIBE or SHOW command, and not the every-table read, DESCRIBE TABLES LIKE %";

export const SUBQUERY_REFUSAL =
  "The agent sends OpenSearch no statement with a second SELECT or a WITH in it: every index it reads must be the one written after its FROM";

export const FROM_REFUSAL =
  "The agent's OpenSearch FROM names one index expression, bare or in backticks, with an optional alias, and then WHERE, GROUP BY, HAVING, ORDER BY, LIMIT or the end: no JOIN, comma, second relation, subquery, qualifier or datasource, and no other FROM but one inside EXTRACT";

export const EXCLUSION_REFUSAL =
  "The agent writes no exclusion, a part that starts with -, in an OpenSearch index expression: name the indices to read, or a wildcard that reaches only them";

export const DOT_INDEX_REFUSAL =
  "The agent writes no name that starts with a dot in an OpenSearch index expression: the security index and the other system indices are named that way, and a login that may read one reads it through SQL; read a data stream by its own name rather than its backing index";

/** The refusal of a reference that is not an index expression the reader admits. */
export function expressionRefusal(reference: string): string {
  return `The agent writes an OpenSearch index expression as comma-separated names and wildcards of letters, digits, _, -, ., * and @, none empty and none starting with _ or @, with no space, date math, remote cluster or datasource, and "${reference}" is not one`;
}

/** The refusal of a reference the server resolves to a hidden or system target, or one named with a leading dot. */
export function hiddenTargetRefusal(reference: string): string {
  return `The agent reads no OpenSearch index the server marks hidden or system, no index or data stream whose name starts with a dot, and no index of a family a bundled plugin writes its own records into without either mark, and the server resolves "${reference}" to one`;
}

/** The refusal of a reference the SQL endpoint resolves to an index the server's own resolution does not account for. */
export function disagreementRefusal(reference: string): string {
  return `The agent reads only the OpenSearch indices the server's own resolution of an expression names for its login, and the SQL endpoint resolves "${reference}" to an index that resolution does not name`;
}

/** The refusal of a reference the server resolves to nothing. */
export function unresolvedRefusal(reference: string): string {
  return `The agent reads only an OpenSearch index, alias or data stream the server resolves for its login, and the server resolves "${reference}" to none`;
}

/** The refusal of a reference whose resolution failed or could not be read. */
export function resolveFailedRefusal(reference: string, error: unknown): string {
  return `The agent reads only an OpenSearch index, alias or data stream the server resolves for its login, and the server's answer about "${reference}" could not be read: ${error instanceof Error ? error.message : String(error)}`;
}

/** One token of a statement's code, as the reader splits it. */
type Token =
  | { readonly kind: "word"; readonly text: string; readonly upper: string }
  | { readonly kind: "quoted" | "string"; readonly text: string }
  | { readonly kind: "number" }
  | { readonly kind: "operator"; readonly text: string };

/** The engine's white space, and the only characters a token boundary may hold. */
const WHITE_SPACE = new Set([" ", "\t", "\n", "\r"]);
/** The operators an agent statement may write outside quotes. */
const OPERATORS = new Set(["(", ")", ",", ".", "*", "+", "-", "/", "%", "=", "<", ">", "!"]);
/** A word: a letter or `_`, then letters, digits and `_`; the plugin ends a bare word at an `@`, so none is in one. */
const WORD_AT = /[A-Za-z_][A-Za-z0-9_]*/y;
const DIGITS_AT = /[0-9]+/y;
/** What may not stand right after a number's digits: the engine would read it into the number, or a word from it. */
const WORD_CHARACTER = /[A-Za-z_]/;
// oxlint-disable-next-line no-control-regex -- control characters are exactly what an agent statement may not hold
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
/** The words that may follow a top-level FROM's table identifier and its alias. */
const AFTER_FROM = new Set(["WHERE", "GROUP", "HAVING", "ORDER", "LIMIT"]);
/** One name of an index expression: a name or wildcard that starts with none of `.`, `_`, `-` and `@`. */
const EXPRESSION_PART = /^[A-Za-z0-9*][A-Za-z0-9_.*@-]*$/;

const refuse = (sentence: string, sql: string) => new RefusedBeforeSendError(sentence, "opensearch", sql);

const isWord = (token: Token | undefined, word: string): boolean => token?.kind === "word" && token.upper === word;

const isOperator = (token: Token | undefined, operator: string): boolean =>
  token?.kind === "operator" && token.text === operator;

/** Where the quote opened at `start` closes, its closing character included, or -1 where it never closes. */
function quoteEnd(sql: string, start: number, quote: string): number {
  let at = start + 1;
  while (at < sql.length) {
    if (sql[at] !== quote) {
      at++;
      continue;
    }
    // A doubled quote inside a string is the string's own quote; inside a backtick name 3.8.0 keeps it as written.
    if (sql[at + 1] !== quote) return at + 1;
    if (quote === "`") return -1;
    at += 2;
  }
  return -1;
}

/** The statement's code as tokens; refuses a comment, an unclosed quote, a character outside the set, or a number run on. */
function tokens(sql: string): Token[] {
  if (CONTROL_CHARACTER.test(sql) || !sql.isWellFormed() || sql.includes("\\")) throw refuse(CHARACTER_REFUSAL, sql);
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
    if (ch === "'" || ch === "`") {
      const end = quoteEnd(sql, index, ch);
      if (end === -1) throw refuse(UNREADABLE_REFUSAL, sql);
      const text = sql.slice(index + 1, end - 1);
      read.push(ch === "'" ? { kind: "string", text: text.replaceAll("''", "'") } : { kind: "quoted", text });
      index = end;
      continue;
    }
    if ((ch === "-" && next === "-") || (ch === "/" && next === "*") || ch === "#") {
      throw refuse(COMMENT_REFUSAL, sql);
    }
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
    if (!OPERATORS.has(ch)) throw refuse(CHARACTER_REFUSAL, sql);
    read.push({ kind: "operator", text: ch });
    index++;
  }
  return read;
}

/**
 * The table identifier after the top-level FROM at `from`, checked to stand alone: a bare or backtick-quoted name, an
 * optional `AS` and alias, then a clause that ends the FROM or the end of the statement.
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
  if (body.some((token) => isWord(token, "JOIN"))) throw refuse(FROM_REFUSAL, sql);
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

/** Refuses a reference that is not an index expression the reader admits: a dot-led name first, then an exclusion. */
function assertExpression(sql: string, reference: string): void {
  const parts = reference.split(",");
  if (parts.some((part) => (part.startsWith("-") ? part.slice(1) : part).startsWith("."))) {
    throw refuse(DOT_INDEX_REFUSAL, sql);
  }
  if (parts.some((part) => part.startsWith("-"))) throw refuse(EXCLUSION_REFUSAL, sql);
  if (!parts.every((part) => EXPRESSION_PART.test(part))) throw refuse(expressionRefusal(reference), sql);
}

/**
 * The index expression an agent statement reads, read from its text alone: the table identifier after the top-level
 * FROM of a `SELECT`, or the table of the agent's one-table `DESCRIBE TABLES LIKE '<table>'`; null for a `SELECT` with
 * no FROM. Refuses a statement the reader cannot read with certainty, the every-table `DESCRIBE TABLES LIKE %`, and a
 * reference with an empty, malformed or dot-led name, before anything is sent.
 */
export function agentIndexReference(sql: string): string | null {
  const read = tokens(sql);
  let reference: string | null;
  if (isWord(read[0], "DESCRIBE")) {
    const [, tables, like, table, ...rest] = read;
    if (!isWord(tables, "TABLES") || !isWord(like, "LIKE") || rest.length > 0 || table?.kind !== "string") {
      throw refuse(STATEMENT_REFUSAL, sql);
    }
    reference = table.text;
  } else {
    if (!isWord(read[0], "SELECT")) throw refuse(STATEMENT_REFUSAL, sql);
    reference = selectReference(sql, read.slice(1));
  }
  if (reference !== null) assertExpression(sql, reference);
  return reference;
}

/**
 * An index the server marks hidden or system, the second including an index of a bundled plugin's family the dialect
 * declares, or whose name starts with a dot, as most of the bundled plugins' indices are named.
 */
const isMarked = (index: SearchResolvedIndex): boolean => index.hidden || index.system || index.name.startsWith(".");

/**
 * Asks the server what `reference` resolves to for the login, in its own index resolution and in the SQL endpoint's,
 * and refuses the statement when either answer cannot be read or names nothing, when the first names an index that is
 * hidden or system, or an index or data stream whose name starts with a dot, or when the second names an index the
 * first does not account for or one behind an alias that is so marked or named. Each request goes out on `signal`.
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
  if (targets.indices.some(isMarked) || targets.dataStreams.some((stream) => stream.name.startsWith("."))) {
    throw refuse(hiddenTargetRefusal(reference), sql);
  }
  const read = await ask(() => transport.sqlTableIndices(reference, signal));
  if (read.length === 0) throw refuse(unresolvedRefusal(reference), sql);
  // An index the first resolution names was checked above, and a backing index of a data stream it names is read
  // through that stream, whose name was; an index behind an alias it names was not, so it is asked about by its own
  // name; and an index it does not account for at all is one the two resolutions disagree about.
  const answered = new Set([
    ...targets.indices.map((index) => index.name),
    ...targets.dataStreams.flatMap((stream) => stream.backingIndices),
  ]);
  const behindAliases = new Set(targets.aliases.flatMap((alias) => alias.indices));
  const throughAliases = read.filter((name) => !answered.has(name));
  if (!throughAliases.every((name) => behindAliases.has(name))) throw refuse(disagreementRefusal(reference), sql);
  if (throughAliases.length === 0) return;
  const behind = (await ask(() => transport.resolveTargets(throughAliases, signal))).indices;
  if (!throughAliases.every((name) => behind.some((index) => index.name === name))) {
    throw refuse(resolveFailedRefusal(reference, "the indices behind an alias were not each answered"), sql);
  }
  if (behind.some(isMarked)) throw refuse(hiddenTargetRefusal(reference), sql);
}

/** The statement check `queryReadOnly` runs on OpenSearch before a statement is sent. */
export async function checkOpenSearchAgentStatement(
  sql: string,
  transport: SearchTransport,
  signal?: AbortSignal,
): Promise<void> {
  const reference = agentIndexReference(sql);
  if (reference !== null) await assertReferenceVisible(sql, reference, transport, signal);
}
