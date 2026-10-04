import type { ConsoleDialectSpec } from "./dialect";

/**
 * The console's tokeniser, one physical line at a time (vector-family spec 3.4).
 *
 * The editor's tokens provider calls it line by line, and the parser and the formatter read a whole text through
 * the same function, so the words the editor draws are the words the request is built from. It is a tokeniser,
 * not a pre-pass: a string is scanned first, to its closing unescaped quote, so a `//` or a `#` inside a string is
 * string text; `//` opens a comment only at a token boundary outside any string, only after the request line and
 * only where the dialect declares body comments, and runs to the end of the line, a CR before the LF included.
 * A comment never opens or closes a string. Nothing here refuses a text: a token the grammar does not allow is
 * `invalid`, and the parser names it.
 */

export type ConsoleTokenKind =
  | "comment"
  | "method"
  | "path"
  | "path-param"
  | "query"
  | "key"
  | "string"
  | "number"
  | "keyword"
  | "punctuation"
  | "whitespace"
  | "invalid";

/** One token: its kind, its 1-based line and its 0-based start and end columns on that line. */
export interface ConsoleToken {
  readonly kind: ConsoleTokenKind;
  readonly line: number;
  readonly start: number;
  readonly end: number;
}

/** What one line hands the next. Bounded whatever the text holds. */
export interface ConsoleLineState {
  readonly section: "before-request" | "body" | "after-body";
  /** True when the line ended inside a string, which the next line continues as invalid text up to its quote. */
  readonly inString: boolean;
  /** Open objects and arrays, capped at the dialect's `maxDepth + 1`. */
  readonly depth: number;
}

export const INITIAL_CONSOLE_STATE: ConsoleLineState = Object.freeze({
  section: "before-request",
  inString: false,
  depth: 0,
});

const NUMBER_LITERAL = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const KEYWORDS: ReadonlySet<string> = new Set(["true", "false", "null"]);

const isWhitespace = (character: string | undefined): boolean =>
  character === " " || character === "\t" || character === "\r";
const isDelimiter = (character: string): boolean => '{}[]:,"'.includes(character) || isWhitespace(character);

function skipWhitespace(line: string, from: number): number {
  let at = from;
  while (at < line.length && isWhitespace(line[at])) at++;
  return at;
}

/** The end of a request-line word: the next whitespace or the end of the line. */
function requestWordEnd(line: string, from: number): number {
  let at = from;
  while (at < line.length && !isWhitespace(line[at])) at++;
  return at;
}

/** The end of a body word: the next whitespace, the next structural character or quote, or the end of the line. */
function bodyWordEnd(line: string, from: number): number {
  let at = from + 1;
  while (at < line.length && !isDelimiter(line[at])) at++;
  return at;
}

/** The column after the quote that closes a string whose text starts at `from`, or -1 when the line ends first. */
function stringEnd(line: string, from: number): number {
  for (let at = from; at < line.length; at++) {
    if (line[at] === "\\") at++;
    else if (line[at] === '"') return at + 1;
  }
  return -1;
}

/**
 * The tokens of one line, read in the state the line before left, and the state this line leaves.
 *
 * `lineNumber` is the token's `line`; `charge`, when given, sees every token before it joins the line's list, which
 * is where the parser charges its bounds, so an oversize text is refused before its tokens are kept. A charge that
 * returns false stops the line after that token: the rest of the line is not read, and the state returned is the
 * state at the stop.
 */
export function tokenizeLine(
  spec: ConsoleDialectSpec,
  line: string,
  state: ConsoleLineState,
  lineNumber = 1,
  charge?: (token: ConsoleToken, line: string) => unknown,
): { readonly tokens: readonly ConsoleToken[]; readonly state: ConsoleLineState } {
  const tokens: ConsoleToken[] = [];
  const read = { stopped: false };
  const push = (kind: ConsoleTokenKind, start: number, end: number) => {
    if (end <= start) return;
    const token: ConsoleToken = { kind, line: lineNumber, start, end };
    if (charge?.(token, line) === false) read.stopped = true;
    tokens.push(token);
  };
  let { section, inString, depth } = state;
  let at = 0;

  if (inString) {
    const close = stringEnd(line, 0);
    if (close === -1) {
      push("invalid", 0, line.length);
      return { tokens, state: { section, inString, depth } };
    }
    push("invalid", 0, close);
    at = close;
    inString = false;
  }

  if (section === "before-request") {
    const lead = skipWhitespace(line, at);
    push("whitespace", at, lead);
    at = lead;
    if (at === line.length) return { tokens, state: { section, inString, depth } };
    if (spec.commentMarkers.some((marker) => line.startsWith(marker, at))) {
      push("comment", at, line.length);
      return { tokens, state: { section, inString, depth } };
    }
    const methodEnd = requestWordEnd(line, at);
    push(spec.methods.includes(line.slice(at, methodEnd)) ? "method" : "invalid", at, methodEnd);
    const targetStart = skipWhitespace(line, methodEnd);
    push("whitespace", methodEnd, targetStart);
    const targetEnd = requestWordEnd(line, targetStart);
    pushTarget(line, targetStart, targetEnd, push);
    at = targetEnd;
    section = "body";
    depth = 0;
  }

  while (at < line.length && !read.stopped) {
    const character = line[at];
    if (isWhitespace(character)) {
      const end = skipWhitespace(line, at);
      push("whitespace", at, end);
      at = end;
    } else if (character === "/" && line[at + 1] === "/") {
      push(spec.bodyComments ? "comment" : "invalid", at, line.length);
      at = line.length;
    } else if (character === "#" || section === "after-body") {
      push("invalid", at, line.length);
      at = line.length;
    } else if (character === '"') {
      const close = stringEnd(line, at + 1);
      if (close === -1) {
        push("invalid", at, line.length);
        inString = true;
        at = line.length;
      } else {
        push(line[skipWhitespace(line, close)] === ":" ? "key" : "string", at, close);
        at = close;
      }
    } else if (character === "{" || character === "[") {
      push("punctuation", at, at + 1);
      depth = Math.min(depth + 1, spec.maxDepth + 1);
      at++;
    } else if (character === "}" || character === "]") {
      push("punctuation", at, at + 1);
      if (depth > 0) {
        depth--;
        if (depth === 0) section = "after-body";
      }
      at++;
    } else if (character === ":" || character === ",") {
      push("punctuation", at, at + 1);
      at++;
    } else {
      const end = bodyWordEnd(line, at);
      const word = line.slice(at, end);
      push(NUMBER_LITERAL.test(word) ? "number" : KEYWORDS.has(word) ? "keyword" : "invalid", at, end);
      at = end;
    }
  }
  return { tokens, state: { section, inString, depth } };
}

/** The request line's target: path text, `{name}` segments, a query string, and anything from a `#` on, invalid. */
function pushTarget(
  line: string,
  start: number,
  end: number,
  push: (kind: ConsoleTokenKind, start: number, end: number) => void,
): void {
  const hash = line.indexOf("#", start);
  const fragment = hash !== -1 && hash < end ? hash : end;
  const question = line.indexOf("?", start);
  const pathEnd = question !== -1 && question < fragment ? question : fragment;
  let at = start;
  while (at < pathEnd) {
    const open = line.indexOf("{", at);
    if (open === -1 || open >= pathEnd) {
      push("path", at, pathEnd);
      break;
    }
    const close = line.indexOf("}", open);
    const paramEnd = close === -1 || close >= pathEnd ? pathEnd : close + 1;
    push("path", at, open);
    push("path-param", open, paramEnd);
    at = paramEnd;
  }
  push("query", pathEnd, fragment);
  push("invalid", fragment, end);
}

/** Whether two line states are the same, which tells the editor that the lines below need no new reading. */
export function consoleLineStatesEqual(a: ConsoleLineState, b: ConsoleLineState): boolean {
  return a.section === b.section && a.inString === b.inString && a.depth === b.depth;
}
