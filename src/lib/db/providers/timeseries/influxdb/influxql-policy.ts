/**
 * The InfluxQL read policy (SPEC 5.3, C1 to C3 and C7, E2, E3, E9, E10).
 *
 * Pure, and shipped to the browser: the editor's confirmation gate and the provider ask the same
 * function. On 1.x and 2.x it is the only boundary between a Studio user and `DROP DATABASE`,
 * because the v1 `/query` route runs whatever statement a credential may run. It is fail-closed: it
 * reads tokens, never text, through the lexer that reads as the influxql v1.4.1 scanner does, and
 * allows exactly one statement that begins with `SELECT`, `SHOW` or `EXPLAIN` and holds no bare
 * `INTO` at any depth (a subquery's, or one after `EXPLAIN`, writes all the same; J1 1.3). An
 * `EXPLAIN` runs only before a `SELECT` or a `SHOW` (R37): that `EXPLAIN DROP DATABASE x` fails
 * in today's parsers is the server's choice, and the policy does not rest on it. A text
 * that does not lex, holds a bound parameter, or is Flux is refused before any request.
 *
 * A `;` count is not a statement count on InfluxDB 3: 3.12.0 runs `SHOW DATABASES SHOW DATABASES`
 * as two statements (R42, measured). So a `SELECT`, `SHOW` or `EXPLAIN` is allowed only where a
 * statement of this one begins (its start, after `EXPLAIN [ANALYZE] [VERBOSE]`, and opening a
 * `SELECT`'s `FROM` subquery), and a write word (`WRITE_KEYWORDS`) is refused anywhere outside
 * quotes, comments and regex literals.
 *
 * The steps run in a fixed order and the first that fails decides the sentence: the byte cap, the
 * newlines, the lexer, the empty check, Flux (before the lexical faults, because Flux text commonly
 * lexes with faults and the Flux sentence is the useful one), the first fault, a bound parameter,
 * the statement count, the first keyword and what an `EXPLAIN` explains, `INTO`, then the first
 * misplaced read keyword or write word by position. No sentence echoes user text beyond one keyword.
 * The verdict is the same whatever generation the server reports (C7): this module imports only the
 * lexer.
 *
 * An allowed statement also says which databases it names (R17, as R31 corrects it), read as
 * `parseSources` and `parseSegmentedIdents` read a source, so the run-database rule can refuse
 * `_internal` on a server that hides it.
 */

import { type InfluxqlLexFault, type InfluxqlToken, lexInfluxql, normaliseInfluxqlNewlines } from "./influxql-lexer";

export type InfluxqlStatementKind = "SELECT" | "SHOW" | "EXPLAIN";

export type InfluxqlRefusalReason =
  | "empty"
  | "flux"
  | "lexical"
  | "bound-parameter"
  | "multiple-statements"
  | "not-a-read"
  | "into"
  | "too-long";

export type InfluxqlVerdict =
  | {
      readonly allowed: true;
      readonly statement: InfluxqlStatementKind;
      /** Every database a source or an `ON` clause names, deduplicated in first-seen order. */
      readonly namedDatabases: readonly string[];
    }
  | { readonly allowed: false; readonly reason: InfluxqlRefusalReason; readonly message: string };

/** The longest statement text sent, in UTF-8 bytes (E10); it travels as a form body, so no URL limit applies. */
export const INFLUXQL_MAX_TEXT_BYTES = 64 * 1024;

/** Digits in groups of three, without a locale call. */
const grouped = (n: number): string => String(n).replace(/\B(?=(\d{3})+$)/g, ",");

/** What a quoted token or a comment is called in a fault sentence. */
const UNTERMINATED_SUBJECT = {
  "unterminated-string": "A string",
  "unterminated-identifier": "A quoted name",
  "unterminated-regex": "A regular expression",
  "unterminated-comment": "A /* comment",
} as const;

const NEWLINE_SUBJECT = {
  "newline-in-string": "A string",
  "newline-in-identifier": "A quoted name",
  "newline-in-regex": "A regular expression",
} as const;

const unterminated =
  (fault: keyof typeof UNTERMINATED_SUBJECT) =>
  (at: string): string =>
    `${UNTERMINATED_SUBJECT[fault]} that starts at ${at} never closes.`;

const newline =
  (fault: keyof typeof NEWLINE_SUBJECT) =>
  (at: string): string =>
    `${NEWLINE_SUBJECT[fault]} at ${at} holds a line break, which InfluxQL does not allow there.`;

/** One sentence per lexical fault; `at` is "line L, column C". */
const FAULT_SENTENCES: Readonly<Record<InfluxqlLexFault, (at: string) => string>> = {
  "control-character": (at) => `The statement holds a control character at ${at}, which Studio does not send.`,
  "non-ascii": (at) =>
    `The statement holds a character outside ASCII at ${at}, outside quotes, which InfluxQL does not read.`,
  "illegal-character": (at) => `InfluxQL has no meaning for the character at ${at} outside quotes.`,
  "unterminated-string": unterminated("unterminated-string"),
  "unterminated-identifier": unterminated("unterminated-identifier"),
  "unterminated-regex": unterminated("unterminated-regex"),
  "unterminated-comment": unterminated("unterminated-comment"),
  "newline-in-string": newline("newline-in-string"),
  "newline-in-identifier": newline("newline-in-identifier"),
  "newline-in-regex": newline("newline-in-regex"),
  "bad-escape": (at) =>
    `The backslash at ${at} starts an escape InfluxQL does not have; it reads only \\n, \\\\, \\" and \\'.`,
};

/** Every sentence the policy answers with, so the provider doc's test reads the same text. */
export const INFLUXQL_POLICY_SENTENCES = {
  empty: "There is no statement to run.",
  flux: "This is Flux, which Studio does not run: Flux can make the server open network connections even with a read-only token. Write it in InfluxQL; docs/providers/influxdb.md, section Coming from InfluxDB 2.x and Flux, has a translation table.",
  boundParameter: "Studio does not send bound parameters; write the value in the statement.",
  into: "SELECT ... INTO writes into a measurement, which Studio does not do.",
  tooLong: (bytes: number): string =>
    `This statement is ${grouped(bytes)} bytes; an InfluxDB connection in Studio sends at most ${grouped(INFLUXQL_MAX_TEXT_BYTES)}.`,
  multipleStatements: (line: number, column: number): string =>
    `InfluxQL runs one statement at a time here; remove the text after the first \`;\` (line ${line}, column ${column}).`,
  /** A read keyword where no statement of one begins, which InfluxDB 3 reads as a second statement (R42). */
  secondStatement: (line: number, column: number): string =>
    `InfluxQL runs one statement at a time here; remove the text from line ${line}, column ${column} on, where a second statement begins.`,
  /** `word` is a folded keyword of `WRITE_KEYWORDS`, never user text. */
  writeWord: (word: string): string =>
    `This statement holds the word ${word}, which only a writing statement uses, and an InfluxDB connection in Studio runs reads only; if ${word} is a name, write it in double quotes.`,
  /** `word` is a folded keyword, "a quoted name" or "a symbol", never user text. */
  notARead: (word: string): string =>
    `Only SELECT, SHOW and EXPLAIN statements run on an InfluxDB connection in Studio: this one begins with ${word}.`,
  /** `word` is a folded keyword, "a quoted name", "a symbol" or "nothing", never user text. */
  explainTarget: (word: string): string =>
    `EXPLAIN runs here only before SELECT or SHOW: this one is followed by ${word}.`,
  /** `afterNumber` adds the microsecond hint to a `non-ascii` fault: `10µs` is the common way to meet one. */
  fault: (fault: InfluxqlLexFault, line: number, column: number, afterNumber: boolean): string =>
    `${FAULT_SENTENCES[fault](`line ${line}, column ${column}`)}${
      fault === "non-ascii" && afterNumber ? " Write the microsecond unit as `u`." : ""
    }`,
} as const;

/** The statements that run, by first keyword. */
const READ_KEYWORDS: ReadonlySet<string> = new Set<InfluxqlStatementKind>(["SELECT", "SHOW", "EXPLAIN"]);

/** What `EXPLAIN` may come before (R37). */
const EXPLAINED_KEYWORDS: ReadonlySet<string> = new Set<InfluxqlStatementKind>(["SELECT", "SHOW"]);

/**
 * The words only a writing or administering statement uses (R42 (b)), refused anywhere outside quotes, comments and
 * regex literals: InfluxDB 3.12.0 runs a second statement that whitespace alone separates from the first, so a write
 * word after a read is a write. `GRANTS` (of `SHOW GRANTS FOR`) is another keyword.
 */
const WRITE_KEYWORDS: ReadonlySet<string> = new Set([
  "DELETE",
  "DROP",
  "CREATE",
  "ALTER",
  "GRANT",
  "REVOKE",
  "KILL",
  "INSERT",
  "SET",
]);

/** The characters a backslash escapes in a string or a quoted identifier (`ScanString`). */
const ESCAPED = "n\\\"'";

const isTrivia = (token: InfluxqlToken): boolean =>
  token.kind === "whitespace" || token.kind === "line-comment" || token.kind === "block-comment";

/** The lexer's control class: a C0 control other than tab and newline, or DEL. */
const isControl = (ch: string): boolean => (ch < " " && ch !== "\t" && ch !== "\n") || ch === "\u007f";

/** A 1-based line and column (UTF-16 units, as the editor counts) of an offset in the normalised text. */
function positionOf(text: string, offset: number): { readonly line: number; readonly column: number } {
  let line = 1;
  let lineStart = 0;
  for (let at = text.indexOf("\n"); at >= 0 && at < offset; at = text.indexOf("\n", at + 1)) {
    line += 1;
    lineStart = at + 1;
  }
  return { line, column: offset - lineStart + 1 };
}

/**
 * Where a fault is, for the sentence. A quoted token holding a control character or a bad escape
 * is one invalid token from its opening quote, so those two are looked up inside the token; every
 * other fault is named by where its token starts.
 */
function faultOffset(text: string, token: InfluxqlToken): number {
  let at = token.start;
  if (token.fault === "control-character") {
    while (at < token.end - 1 && !isControl(text[at] as string)) at += 1;
  } else if (token.fault === "bad-escape") {
    while (at < token.end - 1 && !(text[at] === "\\" && !ESCAPED.includes(text[at + 1] as string))) {
      at += text[at] === "\\" ? 2 : 1;
    }
  }
  return at;
}

/**
 * Flux (I3, E9): a `|>` anywhere, a leading `from(bucket:` or a leading `import "..."`. Studio has
 * no Flux route, and Flux can make a server open network connections with a read-only token.
 */
function isFlux(text: string, tokens: readonly InfluxqlToken[], significant: readonly InfluxqlToken[]): boolean {
  if (tokens.some((token) => token.kind === "operator" && text[token.start] === "|" && text[token.end] === ">")) {
    return true;
  }
  const slice = (token: InfluxqlToken | undefined): string => (token ? text.slice(token.start, token.end) : "");
  const [first, second, third, fourth] = significant;
  const word = slice(first);
  if (word === "from") {
    return slice(second) === "(" && third?.kind === "identifier" && third.value === "bucket" && slice(fourth) === ":";
  }
  return word === "import" && second?.kind === "quoted-identifier";
}

/**
 * The databases a statement names (R17, R31), read over the tokens as influxql v1.4.1 reads a
 * source (`parseSources`, `parseSource`, `parseSegmentedIdents`, `parser.go:2211-2311`, `:508-550`):
 *
 * - the name directly after `ON`, in any allowed statement. v1.4.1 has an `ON` clause in `SHOW`
 *   only and explains a `SELECT` only (`parser.go:2030`), but the 3.12.0 parser explains any
 *   statement (measured: `EXPLAIN SHOW MEASUREMENTS ON "_internal"` answers a plan, and with an
 *   unknown name "database not found"). A `SELECT` has no `ON` clause on either parser, so a name
 *   read after one belongs to a statement the server fails;
 * - every source after `FROM` and after each `,` of that list, and the one source after
 *   `WITH MEASUREMENT =` or `=~` (`parser.go:1132-1145`);
 * - a `(` where a `SELECT`'s `FROM` list expects a source, straight before the keyword `SELECT`,
 *   opens a subquery, read at any depth, and its `)` returns to the outer list. Any other `(` where
 *   a source is expected (in a `SHOW` source, after `WITH MEASUREMENT`, or a second `(`) is one the
 *   server fails, and the reader reads past it as a source all the same (R42 (c)): a refused
 *   statement costs nothing, and a name it hides could be a second statement's on InfluxDB 3;
 * - a source is a run of segments joined by dots. Whitespace or a comment BEFORE a dot ends the
 *   run, because the parser looks for the dot with `Scan`; AFTER a dot they are skipped, because
 *   the next segment is read with `ScanIgnoreWhitespace`. The last segment may be a regex;
 * - three segments name a database, the first; two name a retention policy and a measurement.
 *
 * Where the server refuses a source the reader still names its first segment when it can (an
 * empty segment or a regex after a space, a fourth segment): a database named for a statement the
 * server fails costs nothing, and one missed is one the `_internal` rule never sees. For the same
 * reason a keyword is read as a segment: `FUTURE` and `PAST` are identifiers on the v1.3.0 pin of
 * 2.9.1, and the 3.12.0 parser takes a keyword as a later segment (measured: `"home".database.home`
 * looks up the database `home`). The loop holds its own stack, so a subquery nested to the text
 * cap cannot overflow it.
 *
 * The same walk says where a subquery opens: the index of each `SELECT` that begins one, which is
 * where R42 (a) lets a read keyword stand after the statement's start. `select` says whether the
 * statement is a `SELECT` (explained or not), the only statement with a subquery source.
 */
function readSources(
  text: string,
  tokens: readonly InfluxqlToken[],
  select: boolean,
): { readonly names: readonly string[]; readonly subqueries: ReadonlySet<number> } {
  const names: string[] = [];
  const subqueries = new Set<number>();
  const name = (database: string): void => {
    if (!names.includes(database)) names.push(database);
  };

  /** The first significant token at or after `at`. */
  const skip = (at: number): number => {
    let i = at;
    while (i < tokens.length && isTrivia(tokens[i] as InfluxqlToken)) i += 1;
    return i;
  };
  const isPunctuation = (at: number, ch: string): boolean =>
    tokens[at]?.kind === "punctuation" && text[tokens[at].start] === ch;
  /** A segment's name: an identifier's value, or a keyword as written. */
  const segment = (at: number): string | undefined => {
    const token = tokens[at];
    if (token?.kind === "keyword") return text.slice(token.start, token.end);
    return token?.kind === "identifier" || token?.kind === "quoted-identifier" ? token.value : undefined;
  };

  /** Reads one source that is not a subquery; returns the next significant token after it. */
  const readSource = (at: number): number => {
    if (tokens[at]?.kind === "regex") return skip(at + 1);
    const first = segment(at);
    if (first === undefined) return at;
    let count = 1;
    let i = at + 1;
    // No `skip` here: the token right after a segment is a dot, or the run is over.
    while (isPunctuation(i, ".")) {
      i = skip(i + 1);
      if (isPunctuation(i, ".")) {
        count += 1; // An empty segment, `db..m`; the loop reads this dot next.
        continue;
      }
      const regex = tokens[i]?.kind === "regex";
      if (!regex && segment(i) === undefined) break;
      count += 1;
      i += 1;
      if (regex) break; // A regex is always the last segment.
    }
    if (count >= 3) name(first);
    return skip(i);
  };

  /** One entry per open statement (the outer one, then each subquery): its open parentheses that are not subqueries. */
  const open: number[] = [0];
  /** What the next token is read as: a source of a `FROM` list, the one `WITH MEASUREMENT` source, or neither. */
  let expects: "list" | "single" | "none" = "none";
  /** Whether the expected source follows a `(` that opened no subquery, where no subquery can open. */
  let inParenthesis = false;
  let i = skip(0);

  while (i < tokens.length) {
    const token = tokens[i] as InfluxqlToken;

    if (expects !== "none") {
      const list = expects === "list";
      if (isPunctuation(i, "(")) {
        open.push(0);
        const after = skip(i + 1);
        const opens = tokens[after]?.kind === "keyword" && tokens[after].value === "SELECT";
        if (opens && select && list && !inParenthesis) subqueries.add(after);
        // A subquery's own text is read as a statement; any other parenthesis holds a source.
        if (opens) expects = "none";
        inParenthesis = !opens;
        i = after;
        continue;
      }
      expects = "none";
      inParenthesis = false;
      i = readSource(i);
      if (list && isPunctuation(i, ",")) {
        expects = "list";
        i = skip(i + 1);
      }
      continue;
    }

    const next = skip(i + 1);
    if (token.kind === "keyword" && token.value === "FROM") {
      expects = "list";
    } else if (token.kind === "keyword" && token.value === "ON") {
      const database = segment(next);
      if (database !== undefined) name(database);
    } else if (token.kind === "keyword" && token.value === "WITH") {
      const operator = tokens[skip(next + 1)];
      const sign = operator?.kind === "operator" ? text.slice(operator.start, operator.end) : "";
      if (tokens[next]?.kind === "keyword" && tokens[next].value === "MEASUREMENT" && (sign === "=" || sign === "=~")) {
        expects = "single";
        i = skip(skip(next + 1) + 1);
        continue;
      }
    } else if (isPunctuation(i, "(")) {
      open[open.length - 1] = (open[open.length - 1] as number) + 1;
    } else if (isPunctuation(i, ")")) {
      if ((open[open.length - 1] as number) > 0) {
        open[open.length - 1] = (open[open.length - 1] as number) - 1;
      } else if (open.length > 1) {
        // A subquery closes; a `,` after it continues the outer `FROM` list.
        open.pop();
        if (isPunctuation(next, ",")) {
          expects = "list";
          i = skip(next + 1);
          continue;
        }
      }
    }
    i = next;
  }

  return { names, subqueries };
}

/** What a sentence calls a token: its folded keyword, or a class of token, never its text. */
const wordOf = (token: InfluxqlToken): string =>
  token.kind === "keyword"
    ? (token.value as string)
    : token.kind === "quoted-identifier"
      ? "a quoted name"
      : "a symbol";

/**
 * The token an `EXPLAIN` explains (R37): the one after an optional `ANALYZE` and then an optional
 * `VERBOSE`, each at most once and in that order; undefined when the statement ends there.
 */
function explainedToken(significant: readonly InfluxqlToken[]): InfluxqlToken | undefined {
  const isKeyword = (at: number, word: string): boolean =>
    significant[at]?.kind === "keyword" && significant[at].value === word;
  let at = 1;
  if (isKeyword(at, "ANALYZE")) at += 1;
  if (isKeyword(at, "VERBOSE")) at += 1;
  const token = significant[at];
  return token?.kind === "semicolon" ? undefined : token;
}

const refuse = (reason: InfluxqlRefusalReason, message: string): InfluxqlVerdict => ({
  allowed: false,
  reason,
  message,
});

/** The verdict on a statement text: allowed with what it names, or refused with the sentence the user reads. */
export function evaluateInfluxql(text: string): InfluxqlVerdict {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > INFLUXQL_MAX_TEXT_BYTES) return refuse("too-long", INFLUXQL_POLICY_SENTENCES.tooLong(bytes));

  const normalised = normaliseInfluxqlNewlines(text);
  const tokens = lexInfluxql(normalised);
  const significant = tokens.filter((token) => !isTrivia(token));
  const first = significant[0];
  if (first === undefined) return refuse("empty", INFLUXQL_POLICY_SENTENCES.empty);

  if (isFlux(normalised, tokens, significant)) return refuse("flux", INFLUXQL_POLICY_SENTENCES.flux);

  const invalidAt = tokens.findIndex((token) => token.kind === "invalid");
  if (invalidAt >= 0) {
    const invalid = tokens[invalidAt] as InfluxqlToken;
    const before = tokens[invalidAt - 1];
    const { line, column } = positionOf(normalised, faultOffset(normalised, invalid));
    return refuse(
      "lexical",
      INFLUXQL_POLICY_SENTENCES.fault(invalid.fault as InfluxqlLexFault, line, column, before?.kind === "number"),
    );
  }

  if (significant.some((token) => token.kind === "bound-parameter")) {
    return refuse("bound-parameter", INFLUXQL_POLICY_SENTENCES.boundParameter);
  }

  const semicolon = significant.findIndex((token) => token.kind === "semicolon");
  if (semicolon >= 0 && semicolon !== significant.length - 1) {
    const { line, column } = positionOf(normalised, (significant[semicolon] as InfluxqlToken).start);
    return refuse("multiple-statements", INFLUXQL_POLICY_SENTENCES.multipleStatements(line, column));
  }

  if (first.kind !== "keyword" || !READ_KEYWORDS.has(first.value as string)) {
    return refuse("not-a-read", INFLUXQL_POLICY_SENTENCES.notARead(wordOf(first)));
  }

  if (first.value === "EXPLAIN") {
    const target = explainedToken(significant);
    if (target?.kind !== "keyword" || !EXPLAINED_KEYWORDS.has(target.value as string)) {
      const word = target === undefined ? "nothing" : wordOf(target);
      return refuse("not-a-read", INFLUXQL_POLICY_SENTENCES.explainTarget(word));
    }
  }

  if (significant.some((token) => token.kind === "keyword" && token.value === "INTO")) {
    return refuse("into", INFLUXQL_POLICY_SENTENCES.into);
  }

  const explained = first.value === "EXPLAIN" ? explainedToken(significant) : first;
  const sources = readSources(normalised, tokens, explained?.value === "SELECT");
  // R42: InfluxDB 3.12.0 runs a second statement that only whitespace or a comment separates from the first.
  for (const [index, token] of tokens.entries()) {
    if (token.kind !== "keyword") continue;
    const word = token.value as string;
    if (READ_KEYWORDS.has(word) && token !== first && token !== explained && !sources.subqueries.has(index)) {
      const { line, column } = positionOf(normalised, token.start);
      return refuse("multiple-statements", INFLUXQL_POLICY_SENTENCES.secondStatement(line, column));
    }
    if (WRITE_KEYWORDS.has(word)) return refuse("not-a-read", INFLUXQL_POLICY_SENTENCES.writeWord(word));
  }

  return { allowed: true, statement: first.value as InfluxqlStatementKind, namedDatabases: sources.names };
}

/** The confirmation gate row's `refuse`: the refusal sentence, or undefined to send. */
export function influxqlRefusal(text: string): string | undefined {
  const verdict = evaluateInfluxql(text);
  return verdict.allowed ? undefined : verdict.message;
}

/** None: no allowed statement writes. */
export const INFLUXQL_DESTRUCTIVE_OPERATIONS: ReadonlySet<string> = new Set<string>();

/** The operations of a text for the confirmation gate: none when it is a read, undefined when it is refused. */
export function readInfluxqlOperations(text: string): readonly string[] | undefined {
  return evaluateInfluxql(text).allowed ? [] : undefined;
}
