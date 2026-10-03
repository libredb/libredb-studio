/**
 * Cypher text, read as tokens (spec 3.2).
 *
 * Pure, and shipped to the browser: the editor's tokens provider, the read policy and the
 * statement generators all read Cypher through this module, so a word the editor draws as a word
 * is the word the policy judges. It imports nothing.
 *
 * `tokenizeCypherLine` reads one physical line from a state, which is what the tokens provider
 * calls, and never throws: a string, a block comment or a backtick identifier still open at the end
 * of the line is carried over in the state it returns. `lexCypher` applies the same reading to every
 * line of a text in turn, so the two cannot disagree, joins the pieces of a construct that spans lines
 * into one token holding the newlines, and throws `CypherLexError` for what the line reading lets
 * through: an escape Cypher does not define, a character no token begins with, and a construct still
 * open at the end of the text.
 *
 * Every token keeps its exact source slice, so the tokens of a text joined give the text back.
 */

// ============================================================================
// Tokens and states
// ============================================================================

export type CypherTokenKind =
  /** A bare identifier or keyword: a letter or `_`, then letters, digits and `_` (Unicode letters count). */
  | "word"
  /** A backtick identifier; its value is the name, a doubled backtick read as one. */
  | "backtick"
  /** A single- or double-quoted string; its value is the unescaped text. */
  | "string"
  /** An integer, a decimal, an exponent, a hex `0x..` or an octal `0o..` number; a sign is punctuation. */
  | "number"
  /** `$name` or `` $`name` ``; its value is the name. */
  | "parameter"
  /** `//` to the end of the line, or a block comment from slash-star to the first star-slash. */
  | "comment"
  /** One punctuation mark, or one character no token begins with. */
  | "punct"
  | "whitespace";

export interface CypherToken {
  readonly kind: CypherTokenKind;
  /** The exact source slice. */
  readonly text: string;
  /** Unquoted or unescaped for a backtick, a string and a parameter; uppercased for a word; else the text. */
  readonly value: string;
  /** Offset in the whole text, in UTF-16 code units. */
  readonly start: number;
  /** Exclusive. */
  readonly end: number;
}

/**
 * What a line starts inside: code, or a construct an earlier line left open.
 *
 * A backticked parameter (`` $`name` ``) left open carries over as `backtick`, so `tokenizeCypherLine`
 * gives its later lines' pieces the kind `backtick`. `lexCypher` still joins them into one `parameter`
 * token, because the kind of the joined token is the kind of its first piece.
 */
export type CypherLineState =
  | { readonly in: "code" }
  | { readonly in: "block-comment" }
  | { readonly in: "string"; readonly quote: "'" | '"' }
  | { readonly in: "backtick" };

export const CYPHER_INITIAL_STATE: CypherLineState = { in: "code" };

export type CypherLexErrorReason =
  | "unterminated-string"
  | "unterminated-comment"
  | "unterminated-backtick"
  | "invalid-escape"
  | "unexpected-character";

/** A text `lexCypher` cannot read; `position` is the offset where the offending construct starts. */
export class CypherLexError extends Error {
  readonly position: number;
  readonly reason: CypherLexErrorReason;

  constructor(reason: CypherLexErrorReason, position: number) {
    super(`${LEX_ERROR_MESSAGES[reason]} at offset ${position}.`);
    this.name = "CypherLexError";
    this.reason = reason;
    this.position = position;
    Object.setPrototypeOf(this, CypherLexError.prototype);
  }
}

const LEX_ERROR_MESSAGES: Record<CypherLexErrorReason, string> = {
  "unterminated-string": "The Cypher text has a string that is never closed, starting",
  "unterminated-comment": "The Cypher text has a block comment that is never closed, starting",
  "unterminated-backtick": "The Cypher text has a backtick name that is never closed, starting",
  "invalid-escape": "The Cypher text has an escape sequence Cypher does not define",
  "unexpected-character": "The Cypher text has a character Cypher does not read",
};

/** The keyword table the editor highlights and completes: the Cypher 5 clause and operator keywords. */
export const CYPHER_KEYWORDS: ReadonlySet<string> = new Set(
  [
    "MATCH OPTIONAL WHERE RETURN WITH UNWIND ORDER BY SKIP LIMIT OFFSET ASC ASCENDING DESC DESCENDING",
    "DISTINCT AS AND OR XOR NOT IN IS NULL TRUE FALSE CASE WHEN THEN ELSE END CALL YIELD UNION ALL",
    "EXISTS COUNT SHOW CREATE MERGE SET DELETE DETACH REMOVE DROP FOREACH LOAD CSV FROM HEADERS",
    "FIELDTERMINATOR USE ON INDEX INDEXES CONSTRAINT CONSTRAINTS DATABASE DATABASES PROCEDURES",
    "FUNCTIONS TRANSACTIONS TERMINATE EXPLAIN PROFILE CYPHER STARTS ENDS CONTAINS",
  ]
    .join(" ")
    .split(" "),
);

// ============================================================================
// The pieces of a line
// ============================================================================

const TWO_CHARACTER_PUNCTUATION: ReadonlySet<string> = new Set(["<>", "<=", ">=", "=~", "->", "<-", "..", "+="]);
const ONE_CHARACTER_PUNCTUATION: ReadonlySet<string> = new Set("()[]{},.:;=<>+-*/%^|!?");

const WHITESPACE = /\s+/y;
const WORD = /[\p{L}_][\p{L}\p{Nd}_]*/uy;
const PARAMETER_NAME = /\$[\p{L}\p{Nd}_]+/uy;
/**
 * The number forms spec 3.2 names. Cypher 5's digit-group underscores (`1_000`) are not among them:
 * such a literal reads as the number `1` then the word `_000`, which the policy judges the same way
 * and the editor colours as two tokens.
 */
const NUMBER = /0x[0-9a-fA-F]+|0o[0-7]+|(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const NUMBER_START = /\d|\.\d/y;

const SIMPLE_ESCAPES: Readonly<Record<string, string>> = {
  "\\": "\\",
  "'": "'",
  '"': '"',
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
};
const HEX_DIGITS = /^[0-9a-fA-F]+$/;

/** The sticky `pattern`'s match at `at`, or undefined. */
function matchAt(pattern: RegExp, line: string, at: number): string | undefined {
  pattern.lastIndex = at;
  return pattern.exec(line)?.[0];
}

/** Where a string body ends: just past its closing quote, or the end of the line when it stays open. */
function scanString(line: string, at: number, quote: "'" | '"'): { end: number; closed: boolean } {
  let i = at;
  while (i < line.length) {
    const character = line[i];
    if (character === "\\") i += 2;
    else if (character === quote) return { end: i + 1, closed: true };
    else i += 1;
  }
  return { end: line.length, closed: false };
}

/** Where a backtick body ends: just past its unpaired closing backtick, or the end of the line. */
function scanBacktick(line: string, at: number): { end: number; closed: boolean } {
  let i = at;
  while (i < line.length) {
    if (line[i] !== "`") i += 1;
    else if (line[i + 1] === "`") i += 2;
    else return { end: i + 1, closed: true };
  }
  return { end: line.length, closed: false };
}

/** Where a block comment body ends: just past its first `*` `/`, or the end of the line. */
function scanBlockComment(line: string, at: number): { end: number; closed: boolean } {
  const close = line.indexOf("*/", at);
  return close === -1 ? { end: line.length, closed: false } : { end: close + 2, closed: true };
}

/**
 * A string body decoded. With `strict`, an escape Cypher does not define throws invalid-escape at
 * its backslash, `base` being the body's offset in the text; without it, the escape stays as written.
 */
function decodeString(body: string, strict: boolean, base: number): string {
  let out = "";
  let i = 0;
  while (i < body.length) {
    const character = body[i];
    if (character !== "\\") {
      out += character;
      i += 1;
      continue;
    }
    const next = body[i + 1] as string | undefined;
    const simple = next === undefined ? undefined : SIMPLE_ESCAPES[next];
    if (simple !== undefined) {
      out += simple;
      i += 2;
      continue;
    }
    const width = next === "u" ? 4 : next === "U" ? 8 : 0;
    const digits = body.slice(i + 2, i + 2 + width);
    const codePoint =
      width > 0 && digits.length === width && HEX_DIGITS.test(digits) ? Number.parseInt(digits, 16) : -1;
    if (codePoint >= 0 && codePoint <= 0x10ffff) {
      out += String.fromCodePoint(codePoint);
      i += 2 + width;
      continue;
    }
    if (strict) throw new CypherLexError("invalid-escape", base + i);
    out += character;
    i += 1;
  }
  return out;
}

const decodeBacktick = (body: string): string => body.replaceAll("``", "`");

/** A word's or punctuation's token: the value is the text, uppercased for a word. */
function plain(kind: CypherTokenKind, text: string, start: number): CypherToken {
  return { kind, text, value: kind === "word" ? text.toUpperCase() : text, start, end: start + text.length };
}

/**
 * The value of a construct's piece: `text` is the piece, `opens` the length of what opens the
 * construct when the piece holds it (a quote, a backtick, `$` and a backtick), `closed` whether the
 * piece ends with the closing character.
 */
function pieceValue(kind: CypherTokenKind, text: string, opens: number, closed: boolean): string {
  const body = text.slice(opens, closed ? -1 : text.length);
  if (kind === "string") return decodeString(body, false, 0);
  if (kind === "comment") return text;
  return decodeBacktick(body);
}

// ============================================================================
// One line
// ============================================================================

/**
 * One line, resumable: the editor's tokens provider calls this per line, with `offset` the line's
 * offset in the whole text. Never throws; a construct still open at the end of the line is carried
 * over in the returned state, and a character no token begins with is a one-character `punct`.
 */
export function tokenizeCypherLine(
  line: string,
  state: CypherLineState,
  offset = 0,
): { tokens: CypherToken[]; state: CypherLineState } {
  const tokens: CypherToken[] = [];
  const piece = (kind: CypherTokenKind, start: number, end: number, opens: number, closed: boolean): void => {
    const text = line.slice(start, end);
    tokens.push({ kind, text, value: pieceValue(kind, text, opens, closed), start: offset + start, end: offset + end });
  };

  let i = 0;
  if (state.in !== "code") {
    if (line.length === 0) return { tokens, state };
    const scan =
      state.in === "string"
        ? scanString(line, 0, state.quote)
        : state.in === "backtick"
          ? scanBacktick(line, 0)
          : scanBlockComment(line, 0);
    piece(state.in === "block-comment" ? "comment" : state.in, 0, scan.end, 0, scan.closed);
    if (!scan.closed) return { tokens, state };
    i = scan.end;
  }

  while (i < line.length) {
    const character = line[i];
    const two = line.slice(i, i + 2);

    const space = matchAt(WHITESPACE, line, i);
    if (space !== undefined) {
      tokens.push(plain("whitespace", space, offset + i));
      i += space.length;
      continue;
    }
    if (two === "//") {
      piece("comment", i, line.length, 0, false);
      break;
    }
    if (two === "/*") {
      const scan = scanBlockComment(line, i + 2);
      piece("comment", i, scan.end, 0, scan.closed);
      if (!scan.closed) return { tokens, state: { in: "block-comment" } };
      i = scan.end;
      continue;
    }
    if (character === "'" || character === '"') {
      const scan = scanString(line, i + 1, character);
      piece("string", i, scan.end, 1, scan.closed);
      if (!scan.closed) return { tokens, state: { in: "string", quote: character } };
      i = scan.end;
      continue;
    }
    if (character === "`" || two === "$`") {
      const opens = character === "`" ? 1 : 2;
      const scan = scanBacktick(line, i + opens);
      piece(opens === 1 ? "backtick" : "parameter", i, scan.end, opens, scan.closed);
      if (!scan.closed) return { tokens, state: { in: "backtick" } };
      i = scan.end;
      continue;
    }
    const parameter = matchAt(PARAMETER_NAME, line, i);
    if (parameter !== undefined) {
      tokens.push({
        kind: "parameter",
        text: parameter,
        value: parameter.slice(1),
        start: offset + i,
        end: offset + i + parameter.length,
      });
      i += parameter.length;
      continue;
    }
    const number = matchAt(NUMBER_START, line, i) === undefined ? undefined : matchAt(NUMBER, line, i);
    const word = number ?? matchAt(WORD, line, i);
    if (word !== undefined) {
      tokens.push(plain(number === undefined ? "word" : "number", word, offset + i));
      i += word.length;
      continue;
    }
    const mark = TWO_CHARACTER_PUNCTUATION.has(two) ? two : String.fromCodePoint(line.codePointAt(i) as number);
    tokens.push(plain("punct", mark, offset + i));
    i += mark.length;
  }
  return { tokens, state: CYPHER_INITIAL_STATE };
}

// ============================================================================
// The whole text
// ============================================================================

const UNTERMINATED: Readonly<Record<Exclude<CypherLineState["in"], "code">, CypherLexErrorReason>> = {
  string: "unterminated-string",
  "block-comment": "unterminated-comment",
  backtick: "unterminated-backtick",
};

/**
 * A finished token checked as `lexCypher` checks it: a string's escapes decoded strictly, and a
 * `punct` that is no punctuation refused.
 */
function finish(token: CypherToken): CypherToken {
  if (
    token.kind === "punct" &&
    !ONE_CHARACTER_PUNCTUATION.has(token.text) &&
    !TWO_CHARACTER_PUNCTUATION.has(token.text)
  ) {
    throw new CypherLexError("unexpected-character", token.start);
  }
  if (token.kind !== "string") return token;
  return { ...token, value: decodeString(token.text.slice(1, -1), true, token.start + 1) };
}

/** A construct joined from the pieces of several lines, its value read from the whole slice. */
function joined(kind: CypherTokenKind, text: string, start: number): CypherToken {
  const opens = kind === "comment" ? 0 : text.startsWith("$`") ? 2 : 1;
  return finish({ kind, text, value: pieceValue(kind, text, opens, true), start, end: start + text.length });
}

/**
 * The whole text, read line by line with `tokenizeCypherLine` over `text.split("\n")`: a newline in
 * code is a whitespace token, and a construct that spans lines is one token holding its newlines.
 * Throws `CypherLexError` for an invalid escape, a character no token begins with, and a string,
 * block comment or backtick still open at the end of the text, at the offset where it starts.
 */
export function lexCypher(text: string): CypherToken[] {
  const out: CypherToken[] = [];
  const lines = text.split("\n");
  let state = CYPHER_INITIAL_STATE;
  /** A construct running past the end of a line, joined as later lines continue it. */
  let open: { kind: CypherTokenKind; text: string; start: number } | undefined;

  let offset = 0;
  for (const [index, line] of lines.entries()) {
    const result = tokenizeCypherLine(line, state, offset);
    const tokens = result.tokens;
    if (open !== undefined) {
      const continuation = tokens.shift();
      if (continuation !== undefined) open.text += continuation.text;
      if (tokens.length > 0 || result.state.in === "code") {
        out.push(joined(open.kind, open.text, open.start));
        open = undefined;
      }
    }
    if (result.state.in !== "code" && open === undefined) {
      const last = tokens.pop() as CypherToken;
      open = { kind: last.kind, text: last.text, start: last.start };
    }
    for (const token of tokens) out.push(finish(token));
    if (index < lines.length - 1) {
      if (open === undefined) out.push(plain("whitespace", "\n", offset + line.length));
      else open.text += "\n";
    }
    state = result.state;
    offset += line.length + 1;
  }

  if (open !== undefined) throw new CypherLexError(UNTERMINATED[state.in as keyof typeof UNTERMINATED], open.start);
  return out;
}
