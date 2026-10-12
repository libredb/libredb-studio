/**
 * The Firestore console text, read as tokens (spec 5.4): ASCII identifiers, strings in single, double or backtick
 * quotes with JavaScript escapes, decimal numbers, and every ASCII symbol as punctuation, with whitespace and
 * comments skipped. Pure and browser-safe. Every bound of spec S11 is checked here, so the parser's recursion is
 * bounded by the bracket depth this module allows, and every refusal is a QueryError naming line, column and an
 * excerpt, because the UI shows the sentence and nothing else.
 */
import { exceedsUtf8Bytes } from "@/lib/db/console/bounds";
import { QueryError } from "@/lib/db/errors";
import { FIRESTORE_TYPE, LIMITS } from "../constants";

export type TokenKind = "identifier" | "string" | "number" | "punctuation" | "eof";

export interface Token {
  readonly kind: TokenKind;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** A string token's value with its escapes read. */
  readonly value?: string;
}

export const LEXER_SENTENCES = {
  tooLong: "The statement is longer than 64 KiB of UTF-8 text, the most Studio reads",
  tooManyTokens: "The statement has more than 10,000 tokens, the most Studio reads",
  tooDeep: "The statement nests brackets more than 32 levels deep, the most Studio reads",
  unterminatedString: "This string has no closing quote",
  unterminatedComment: "This comment has no closing */",
  newlineInString: "A quoted string cannot run onto the next line; write \\n, or use backticks",
  badEscape: "This escape is not one JavaScript reads",
  placeholder:
    "Studio does not run JavaScript, so a ${...} placeholder cannot be filled; write the value into the string",
  badNumber: "This number is not one Studio reads; write decimal digits, an optional fraction and an optional exponent",
  leadingZero: "A number cannot start with 0 followed by another digit",
  nonAscii: "Names are ASCII; this character can only appear inside a quoted string",
  badCharacter: "Studio does not read this character here",
} as const;

const EXCERPT_UNITS = 20;
const WHITESPACE: ReadonlySet<string> = new Set([
  " ",
  "\t",
  "\n",
  "\r",
  "\v",
  "\f",
  "\u00a0",
  "\ufeff",
  "\u2028",
  "\u2029",
]);
const PUNCTUATION: ReadonlySet<string> = new Set([..."!#%&()*+,-./:;<=>?@[\\]^{|}~"]);
const OPENERS: ReadonlySet<string> = new Set(["(", "[", "{"]);
const CLOSERS: ReadonlySet<string> = new Set([")", "]", "}"]);
const SIMPLE_ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v" };
const HEX = /^[0-9a-fA-F]+$/;

const isDigit = (char: string | undefined): boolean => char !== undefined && char >= "0" && char <= "9";
const isIdentifierStart = (char: string | undefined): boolean =>
  char !== undefined && ((char >= "a" && char <= "z") || (char >= "A" && char <= "Z") || char === "_" || char === "$");
const isIdentifierPart = (char: string | undefined): boolean => isIdentifierStart(char) || isDigit(char);
const isLineEnd = (char: string | undefined): boolean => char === "\n" || char === "\r";

/** "line L, column C: <excerpt>", 1-based, columns in UTF-16 code units as the editor counts them. */
export function describePosition(text: string, offset: number): string {
  const at = Math.max(0, Math.min(offset, text.length));
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < at; index++) {
    const char = text[index];
    if (char === "\n" || (char === "\r" && text[index + 1] !== "\n")) {
      line++;
      lineStart = index + 1;
    }
  }
  let end = at;
  while (end < text.length && !isLineEnd(text[end]) && end - at < EXCERPT_UNITS) end++;
  const lastUnit = text.charCodeAt(end - 1);
  if (end > at && lastUnit >= 0xd800 && lastUnit <= 0xdbff) end--;
  const excerpt = text.slice(at, end);
  const more = end < text.length && !isLineEnd(text[end]);
  const shown =
    excerpt === ""
      ? at >= text.length
        ? "end of text"
        : "end of line"
      : `"${JSON.stringify(excerpt).slice(1, -1)}${more ? "..." : ""}"`;
  return `line ${line}, column ${at - lineStart + 1}: ${shown}`;
}

/** The QueryError every console refusal is raised as: the sentence, then where it applies. */
export function firestoreQueryError(text: string, offset: number, sentence: string): QueryError {
  const position = Math.max(0, Math.min(offset, text.length));
  return new QueryError(`${sentence} (${describePosition(text, position)})`, FIRESTORE_TYPE, text, position);
}

function readEscape(text: string, at: number): { readonly end: number; readonly value: string } {
  const fail = (): QueryError => firestoreQueryError(text, at, LEXER_SENTENCES.badEscape);
  const char = text[at + 1];
  if (char === undefined) throw fail();
  if (char in SIMPLE_ESCAPES) return { end: at + 2, value: SIMPLE_ESCAPES[char] };
  if (char === "\r") return { end: text[at + 2] === "\n" ? at + 3 : at + 2, value: "" };
  if (char === "\n" || char === "\u2028" || char === "\u2029") return { end: at + 2, value: "" };
  if (char === "0" && !isDigit(text[at + 2])) return { end: at + 2, value: "\0" };
  if (isDigit(char)) throw fail();
  if (char === "x") {
    const hex = text.slice(at + 2, at + 4);
    if (hex.length !== 2 || !HEX.test(hex)) throw fail();
    return { end: at + 4, value: String.fromCharCode(Number.parseInt(hex, 16)) };
  }
  if (char === "u" && text[at + 2] === "{") {
    const close = text.indexOf("}", at + 3);
    const hex = close === -1 ? "" : text.slice(at + 3, close);
    if (!HEX.test(hex) || Number.parseInt(hex, 16) > 0x10ffff) throw fail();
    return { end: close + 1, value: String.fromCodePoint(Number.parseInt(hex, 16)) };
  }
  if (char === "u") {
    const hex = text.slice(at + 2, at + 6);
    if (hex.length !== 4 || !HEX.test(hex)) throw fail();
    return { end: at + 6, value: String.fromCharCode(Number.parseInt(hex, 16)) };
  }
  const code = text.charCodeAt(at + 1);
  const pair = code >= 0xd800 && code <= 0xdbff && (text.charCodeAt(at + 2) & 0xfc00) === 0xdc00;
  return { end: at + (pair ? 3 : 2), value: text.slice(at + 1, at + (pair ? 3 : 2)) };
}

function readString(text: string, start: number): { readonly end: number; readonly value: string } {
  const quote = text[start];
  let at = start + 1;
  let value = "";
  for (;;) {
    if (at >= text.length) throw firestoreQueryError(text, start, LEXER_SENTENCES.unterminatedString);
    const char = text[at];
    if (char === quote) return { end: at + 1, value };
    if (quote === "`" && char === "$" && text[at + 1] === "{") {
      throw firestoreQueryError(text, at, LEXER_SENTENCES.placeholder);
    }
    if (char === "\\") {
      const escape = readEscape(text, at);
      value += escape.value;
      at = escape.end;
      continue;
    }
    if (isLineEnd(char)) {
      if (quote !== "`") throw firestoreQueryError(text, at, LEXER_SENTENCES.newlineInString);
      value += "\n";
      at += char === "\r" && text[at + 1] === "\n" ? 2 : 1;
      continue;
    }
    value += char;
    at++;
  }
}

function readNumber(text: string, start: number): number {
  if (text[start] === "0" && isDigit(text[start + 1]))
    throw firestoreQueryError(text, start, LEXER_SENTENCES.leadingZero);
  let at = start;
  while (isDigit(text[at])) at++;
  if (text[at] === "." && isDigit(text[at + 1])) {
    at += 2;
    while (isDigit(text[at])) at++;
  }
  if (text[at] === "e" || text[at] === "E") {
    let next = at + 1;
    if (text[next] === "+" || text[next] === "-") next++;
    if (!isDigit(text[next])) throw firestoreQueryError(text, start, LEXER_SENTENCES.badNumber);
    at = next;
    while (isDigit(text[at])) at++;
  }
  if (isIdentifierPart(text[at])) throw firestoreQueryError(text, start, LEXER_SENTENCES.badNumber);
  return at;
}

/** The text's tokens, ending in one `eof` token; whitespace and comments are skipped. */
export function lex(text: string): Token[] {
  if (exceedsUtf8Bytes(text, LIMITS.maxConsoleBytes)) throw firestoreQueryError(text, 0, LEXER_SENTENCES.tooLong);
  const tokens: Token[] = [];
  const push = (token: Token): void => {
    if (tokens.length === LIMITS.maxConsoleTokens)
      throw firestoreQueryError(text, token.start, LEXER_SENTENCES.tooManyTokens);
    tokens.push(token);
  };
  let depth = 0;
  let at = 0;
  while (at < text.length) {
    const char = text[at];
    if (WHITESPACE.has(char)) {
      at++;
    } else if (char === "/" && text[at + 1] === "/") {
      while (at < text.length && !isLineEnd(text[at])) at++;
    } else if (char === "/" && text[at + 1] === "*") {
      const close = text.indexOf("*/", at + 2);
      if (close === -1) throw firestoreQueryError(text, at, LEXER_SENTENCES.unterminatedComment);
      at = close + 2;
    } else if (isIdentifierStart(char)) {
      let end = at + 1;
      while (isIdentifierPart(text[end])) end++;
      push({ kind: "identifier", text: text.slice(at, end), start: at, end });
      at = end;
    } else if (isDigit(char)) {
      const end = readNumber(text, at);
      push({ kind: "number", text: text.slice(at, end), start: at, end });
      at = end;
    } else if (char === '"' || char === "'" || char === "`") {
      const { end, value } = readString(text, at);
      push({ kind: "string", text: text.slice(at, end), start: at, end, value });
      at = end;
    } else if (PUNCTUATION.has(char)) {
      if (OPENERS.has(char) && ++depth > LIMITS.maxConsoleDepth)
        throw firestoreQueryError(text, at, LEXER_SENTENCES.tooDeep);
      if (CLOSERS.has(char)) depth = Math.max(0, depth - 1);
      push({ kind: "punctuation", text: char, start: at, end: at + 1 });
      at++;
    } else {
      throw firestoreQueryError(
        text,
        at,
        char.charCodeAt(0) < 0x80 ? LEXER_SENTENCES.badCharacter : LEXER_SENTENCES.nonAscii,
      );
    }
  }
  tokens.push({ kind: "eof", text: "", start: text.length, end: text.length });
  return tokens;
}
