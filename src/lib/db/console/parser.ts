import { exceedsUtf8Bytes, utf8ByteLength } from "./bounds";
import { type ConsoleDialectSpec, RequestRefusal, type RouteSpec } from "./dialect";
import { type ConsoleToken, INITIAL_CONSOLE_STATE, tokenizeLine } from "./lexer";
import { type TaggedJson, type TaggedObject, taggedNumber } from "./tagged-json";

/**
 * The console grammar's one reader (vector-family spec 3.4): a text is comment lines, one request line and one JSON
 * object, read from the lexer's tokens and refused by name at the first rule it breaks.
 *
 * The order is fixed, because a text can break several rules and the refusal names the first: the text bound,
 * then the body bounds while the lexer reads (depth, nodes, numbers in number lists, strings in string lists),
 * then the request line (method, target, route, path parameters, query string), then the body's grammar, then
 * whether the route takes a body. Every refusal is a phase 0 `ConsoleRefusal`, and nothing here makes a call.
 */

/** A request the grammar accepted. */
export interface ConsoleRequest<Op extends string = string> {
  readonly route: RouteSpec<Op>;
  /**
   * The path parameters, percent-decoded: a point id is checked as unsigned 64-bit digits or a UUID, a name only
   * as non-empty, and each provider applies its own name rule.
   */
  readonly params: Readonly<Record<string, string>>;
  /** Only the query keys the route declares. */
  readonly query: Readonly<Record<string, string>>;
  readonly body: TaggedObject;
}

export type ConsoleRefusalCode =
  | "empty"
  | "too-large"
  | "too-deep"
  | "too-many-nodes"
  | "too-many-numbers"
  | "too-many-scalars"
  | "no-request"
  | "second-request"
  | "comment-position"
  | "body-comment"
  | "unknown-method"
  | "unknown-route"
  | "absolute-url"
  | "header-line"
  | "fragment"
  | "query-key"
  | "query-value"
  | "path-template"
  | "path-param"
  | "body-not-allowed"
  | "body-required"
  | "malformed-json"
  | "unterminated-string"
  | "ellipsis"
  | "trailing-comma"
  | "duplicate-key"
  | "prototype-key";

/**
 * A console text the grammar refuses, with the rule's code and the 1-based line and column it names.
 *
 * The rule's code is `reason`, not `code`: every `DatabaseError` already carries `code`, the API error code the
 * routes map, which a `ConsoleRefusalCode` cannot replace. A reader that branches on the grammar's rule reads
 * `reason`.
 */
export class ConsoleRefusal extends RequestRefusal {
  constructor(
    public readonly reason: ConsoleRefusalCode,
    sentence: string,
    public readonly line: number,
    public readonly column: number,
    key: string | null = null,
  ) {
    super(`${sentence} (line ${line}, column ${column})`, 0, key);
    this.name = "ConsoleRefusal";
    Object.setPrototypeOf(this, ConsoleRefusal.prototype);
  }
}

/** A text the lexer has read within the dialect's bounds, and where its request line is. */
export interface ConsoleText {
  readonly lines: readonly string[];
  /**
   * Each line's tokens, up to the first token the body's grammar cannot take when there is one: the read stops
   * there, and `readConsoleBody` refuses the text at that token. Whitespace is never kept, and a comment only when
   * the caller asks for comments, so a line of either alone costs a request no token.
   */
  readonly tokens: readonly (readonly ConsoleToken[])[];
  readonly request: {
    /** The request line's 0-based index. */
    readonly line: number;
    readonly method: string;
    /** 0-based columns on the request line. */
    readonly methodColumn: number;
    readonly target: string;
    readonly targetColumn: number;
    /** The column the body may start at: the end of the target. */
    readonly bodyColumn: number;
  };
}

/** Every HTTP method, so a second request line is named as one whatever the dialect's own method set. */
const HTTP_METHODS: ReadonlySet<string> = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const HEADER_LINE = /^\s*[A-Za-z][A-Za-z0-9-]*:\s/;
/** A UUID in the two forms a server reads in a path and a body alike: hyphenated, or its 32 hex digits alone. */
const UUID = /^(?:[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
const UINT64_MAX = "18446744073709551615";
const POSITIVE_INT = /^[1-9][0-9]*$/;
const SHOWN = 40;
/** A line of nothing but whitespace, which the lexer need not read: it holds no token that is kept. */
const BLANK_LINE = /^[ \t\r]*$/;
const NO_TOKENS: readonly ConsoleToken[] = Object.freeze([]);

/** A character that draws nothing or draws as a plain space: a control, a no-break or wide space, a mark, a BOM. */
const drawsNothing = (code: number): boolean =>
  code < 0x20 ||
  (code >= 0x7f && code <= 0xa0) ||
  code === 0xad ||
  code === 0x1680 ||
  (code >= 0x2000 && code <= 0x200f) ||
  (code >= 0x2028 && code <= 0x202f) ||
  (code >= 0x205f && code <= 0x2064) ||
  code === 0x3000 ||
  code === 0xfeff;

/**
 * A piece of the text as a refusal quotes it: cut at a bound, and each character that draws nothing written as its
 * code point, `<U+00A0>`, so a text pasted with a BOM or no-break spaces is told what was found.
 */
function shown(text: string): string {
  const cut = text.length > SHOWN ? `${text.slice(0, SHOWN)}...` : text;
  let out = "";
  for (let at = 0; at < cut.length; at++) {
    const code = cut.charCodeAt(at);
    out += drawsNothing(code) ? `<U+${code.toString(16).toUpperCase().padStart(4, "0")}>` : cut[at];
  }
  return out;
}

/** What an open object or array may hold next: its first member or its close, a key, a colon, a value, or a separator. */
type Expected = "first" | "key" | "colon" | "value" | "separator";

interface Frame {
  readonly array: boolean;
  numbers: number;
  strings: number;
  mixed: boolean;
  expected: Expected;
}

const SCALAR_KINDS: ReadonlySet<ConsoleToken["kind"]> = new Set(["string", "number", "keyword"]);

/**
 * The four body bounds, charged token by token while the lexer reads, before a line's tokens are kept: depth, and
 * three counts. A structural node is an object, an array that is neither all numbers nor all strings, and any
 * value outside such an array; a number inside an array of numbers is a numeric leaf, and a string inside an array
 * of strings a scalar leaf. An array is counted as a list until its first element of another kind, when its
 * elements and the array itself move to the node count, and an array that closes empty is a node.
 *
 * It also follows the body's grammar far enough to say where a token cannot stand, and `charge` answers false
 * there, so the read stops at that token: a text of separators, keys or stray words is not tokenised to its end
 * before the reader refuses it at the same token.
 */
class BodyBounds {
  private readonly frames: Frame[] = [];
  private nodes = 0;
  private numbers = 0;
  private scalars = 0;
  /** The request line's 1-based number and the column its body may start at, known from its first token. */
  private requestLine = 0;
  private bodyColumn = 0;
  private closed = false;

  constructor(private readonly spec: ConsoleDialectSpec) {}

  /** Charges one token against the bounds; false when the body's grammar cannot take the token where it stands. */
  charge(token: ConsoleToken, line: string): boolean {
    if (token.kind === "whitespace" || token.kind === "comment") return true;
    if (this.requestLine === 0) {
      this.requestLine = token.line;
      this.bodyColumn = wordEnd(line, skipWhitespace(line, wordEnd(line, token.start)));
    }
    if (token.line === this.requestLine && token.start < this.bodyColumn) return true;
    const character = token.kind === "punctuation" ? line[token.start] : "";
    if (!this.fits(token, character)) return false;
    if (character === "{" || character === "[") {
      this.element(token);
      if (character === "{") this.node(token);
      this.frames.push({
        array: character === "[",
        numbers: 0,
        strings: 0,
        mixed: character === "{",
        expected: "first",
      });
      if (this.frames.length > this.spec.maxDepth) {
        throw new ConsoleRefusal(
          "too-deep",
          `The body nests objects and arrays deeper than the console's bound of ${this.spec.maxDepth}.`,
          token.line,
          token.start + 1,
        );
      }
    } else if (character === "}" || character === "]") {
      const frame = this.frames.pop() as Frame;
      if (frame.array && !frame.mixed && frame.numbers === 0 && frame.strings === 0) this.node(token);
      this.closed = this.frames.length === 0;
    } else if (token.kind === "number") this.leaf("number", token);
    else if (token.kind === "string" && this.frames[this.frames.length - 1].expected !== "colon") {
      this.leaf("string", token);
    } else if (token.kind === "keyword") this.leaf("other", token);
    return true;
  }

  /** Whether the grammar takes the token where it stands, moving the open container on to what it expects next. */
  private fits(token: ConsoleToken, character: string): boolean {
    const frame = this.frames[this.frames.length - 1];
    if (frame === undefined) return !this.closed && character === "{";
    const value = SCALAR_KINDS.has(token.kind) || character === "{" || character === "[";
    const { expected } = frame;
    if (frame.array) {
      if (expected === "separator") {
        if (character === ",") frame.expected = "value";
        return character === "," || character === "]";
      }
      if (value) frame.expected = "separator";
      return value || (expected === "first" && character === "]");
    }
    if (expected === "separator") {
      if (character === ",") frame.expected = "key";
      return character === "," || character === "}";
    }
    if (expected === "colon") {
      frame.expected = "value";
      return character === ":";
    }
    if (expected === "value") {
      frame.expected = "separator";
      return value;
    }
    if (token.kind === "key" || token.kind === "string") {
      frame.expected = "colon";
      return true;
    }
    return expected === "first" && character === "}";
  }

  private leaf(kind: "number" | "string" | "other", token: ConsoleToken): void {
    const parent = this.frames[this.frames.length - 1];
    if (parent !== undefined && parent.array && !parent.mixed) {
      if (kind === "number" && parent.strings === 0) {
        parent.numbers++;
        if (++this.numbers > this.spec.maxNumericLeaves) {
          throw new ConsoleRefusal(
            "too-many-numbers",
            `The body holds more than ${this.spec.maxNumericLeaves} numbers in its lists of numbers, the console's bound.`,
            token.line,
            token.start + 1,
          );
        }
        return;
      }
      if (kind === "string" && parent.numbers === 0) {
        parent.strings++;
        if (++this.scalars > this.spec.maxScalarLeaves) {
          throw new ConsoleRefusal(
            "too-many-scalars",
            `The body holds more than ${this.spec.maxScalarLeaves} strings in its lists of strings, the console's bound.`,
            token.line,
            token.start + 1,
          );
        }
        return;
      }
      this.mix(parent, token);
    }
    this.node(token);
  }

  /** A container opening: a list that holds it is no list. */
  private element(token: ConsoleToken): void {
    const parent = this.frames[this.frames.length - 1];
    if (parent !== undefined && parent.array && !parent.mixed) this.mix(parent, token);
  }

  private mix(frame: { numbers: number; strings: number; mixed: boolean }, token: ConsoleToken): void {
    this.numbers -= frame.numbers;
    this.scalars -= frame.strings;
    this.nodes += frame.numbers + frame.strings;
    frame.numbers = 0;
    frame.strings = 0;
    frame.mixed = true;
    this.node(token);
  }

  private node(token: ConsoleToken): void {
    if (++this.nodes > this.spec.maxNodes) {
      throw new ConsoleRefusal(
        "too-many-nodes",
        `The body holds more than ${this.spec.maxNodes} objects, arrays and values, the console's bound.`,
        token.line,
        token.start + 1,
      );
    }
  }
}

const isWhitespace = (character: string | undefined): boolean =>
  character === " " || character === "\t" || character === "\r";

function wordEnd(line: string, from: number): number {
  let at = from;
  while (at < line.length && !isWhitespace(line[at])) at++;
  return at;
}

function skipWhitespace(line: string, from: number): number {
  let at = from;
  while (at < line.length && isWhitespace(line[at])) at++;
  return at;
}

/**
 * The text read within the dialect's bounds: the text bound in UTF-8 bytes before anything else, then every line
 * through the lexer with the body bounds charged as it reads, then the request line found. Refuses an empty text,
 * an oversize one, a body past a bound, and a text that holds no request line. `comments` keeps the comment tokens,
 * which only a reader that writes the text back needs.
 */
export function consoleTokens(spec: ConsoleDialectSpec, text: string, comments = false): ConsoleText {
  if (text.trim() === "") {
    throw new ConsoleRefusal(
      "empty",
      "The console text is empty: write a request line, a method and a route, and its JSON body.",
      1,
      1,
    );
  }
  if (exceedsUtf8Bytes(text, spec.maxTextBytes)) {
    throw new ConsoleRefusal(
      "too-large",
      `The text is ${utf8ByteLength(text)} bytes, above the console's bound of ${spec.maxTextBytes} bytes.`,
      1,
      1,
    );
  }
  const lines = text.split("\n");
  const bounds = new BodyBounds(spec);
  const tokens: (readonly ConsoleToken[])[] = [];
  let state = INITIAL_CONSOLE_STATE;
  let requestLine = -1;
  let reading = true;
  const charge = (token: ConsoleToken, line: string) => {
    reading = bounds.charge(token, line);
    return reading;
  };
  const dropped = (token: ConsoleToken) => token.kind === "whitespace" || (!comments && token.kind === "comment");
  for (let index = 0; index < lines.length; index++) {
    if (!state.inString && BLANK_LINE.test(lines[index])) {
      tokens.push(NO_TOKENS);
      continue;
    }
    const read = tokenizeLine(spec, lines[index], state, index + 1, charge);
    if (requestLine === -1 && read.state.section !== "before-request") requestLine = index;
    const kept = read.tokens.some(dropped) ? read.tokens.filter((token) => !dropped(token)) : read.tokens;
    tokens.push(kept.length === 0 ? NO_TOKENS : kept);
    state = read.state;
    if (!reading) break;
  }
  if (requestLine === -1) {
    throw new ConsoleRefusal(
      "no-request",
      "The text holds only comments: write a request line after them.",
      lines.length,
      1,
    );
  }
  const line = lines[requestLine];
  const methodColumn = skipWhitespace(line, 0);
  const methodEnd = wordEnd(line, methodColumn);
  const targetColumn = skipWhitespace(line, methodEnd);
  const bodyColumn = wordEnd(line, targetColumn);
  return {
    lines,
    tokens,
    request: {
      line: requestLine,
      method: line.slice(methodColumn, methodEnd),
      methodColumn,
      target: line.slice(targetColumn, bodyColumn),
      targetColumn,
      bodyColumn,
    },
  };
}

/** Reads the body's tokens in order, skipping comments, from the end of the request line's target. */
class BodyCursor {
  private lineIndex: number;
  private tokenIndex = 0;

  constructor(
    private readonly spec: ConsoleDialectSpec,
    private readonly text: ConsoleText,
  ) {
    this.lineIndex = text.request.line;
    const first = text.tokens[this.lineIndex];
    while (this.tokenIndex < first.length && first[this.tokenIndex].start < text.request.bodyColumn) this.tokenIndex++;
  }

  next(): ConsoleToken | undefined {
    for (;;) {
      const line = this.text.tokens[this.lineIndex];
      if (line === undefined) return undefined;
      const token = line[this.tokenIndex];
      if (token === undefined) {
        this.lineIndex++;
        this.tokenIndex = 0;
        continue;
      }
      this.tokenIndex++;
      if (token.kind !== "comment") return token;
    }
  }

  textOf(token: ConsoleToken): string {
    return this.text.lines[token.line - 1].slice(token.start, token.end);
  }

  /** The refusal for a token the grammar did not expect at this place. */
  unexpected(token: ConsoleToken | undefined, expected: string): ConsoleRefusal {
    if (token === undefined) {
      const last = this.text.lines.length;
      return new ConsoleRefusal(
        "malformed-json",
        "The body ends before its closing bracket.",
        last,
        this.text.lines[last - 1].length + 1,
      );
    }
    const text = this.textOf(token);
    const at = (code: ConsoleRefusalCode, sentence: string) =>
      new ConsoleRefusal(code, sentence, token.line, token.start + 1);
    if (text.startsWith("#")) return at("comment-position", "A # comment is accepted only before the request line.");
    if (text.startsWith("//"))
      return at("body-comment", "A // comment is not accepted after this console's request line.");
    if (token.kind === "invalid" && text.startsWith('"')) {
      return at("unterminated-string", "A string is not closed before the end of its line.");
    }
    if (/^(?:\.{2,}|…)/.test(text)) {
      return at("ellipsis", "Replace ... with the values it stands for: the console runs the text as written.");
    }
    return at("malformed-json", `Expected ${expected}, found ${shown(text)}.`);
  }

  /** The refusal for a token where only the body, or nothing, may stand: a second request, a header or a stray. */
  stray(token: ConsoleToken, where: "before" | "after"): ConsoleRefusal {
    const lineText = this.text.lines[token.line - 1];
    const firstOnLine = skipWhitespace(lineText, 0) === token.start;
    const firstWord = lineText.slice(token.start, wordEnd(lineText, token.start));
    if (firstOnLine && (HTTP_METHODS.has(firstWord) || this.spec.methods.includes(firstWord))) {
      return new ConsoleRefusal(
        "second-request",
        "The text holds a second request line: run one request at a time.",
        token.line,
        token.start + 1,
      );
    }
    if (where === "before" && firstOnLine && token.line - 1 !== this.text.request.line && HEADER_LINE.test(lineText)) {
      return new ConsoleRefusal(
        "header-line",
        "A header line is not accepted: the connection supplies every header.",
        token.line,
        token.start + 1,
      );
    }
    return this.unexpected(
      token,
      where === "before" ? "the body, one JSON object starting with {" : "nothing after the body",
    );
  }
}

const isPunctuation = (cursor: BodyCursor, token: ConsoleToken | undefined, character: string): boolean =>
  token !== undefined && token.kind === "punctuation" && cursor.textOf(token) === character;

function readString(cursor: BodyCursor, token: ConsoleToken): string {
  try {
    return JSON.parse(cursor.textOf(token)) as string;
  } catch {
    throw new ConsoleRefusal(
      "malformed-json",
      `The string ${shown(cursor.textOf(token))} holds an escape or a character JSON does not allow.`,
      token.line,
      token.start + 1,
    );
  }
}

function readValue(cursor: BodyCursor, token: ConsoleToken | undefined): TaggedJson {
  if (token === undefined) throw cursor.unexpected(token, "a value");
  const text = cursor.textOf(token);
  if (token.kind === "punctuation" && text === "{") return readObject(cursor);
  if (token.kind === "punctuation" && text === "[") return readArray(cursor);
  if (token.kind === "string") return readString(cursor, token);
  if (token.kind === "number") return taggedNumber(text);
  if (token.kind === "keyword") return text === "null" ? null : text === "true";
  throw cursor.unexpected(token, "a value");
}

function readArray(cursor: BodyCursor): readonly TaggedJson[] {
  const values: TaggedJson[] = [];
  let token = cursor.next();
  if (isPunctuation(cursor, token, "]")) return Object.freeze(values);
  for (;;) {
    values.push(readValue(cursor, token));
    const after = cursor.next();
    if (isPunctuation(cursor, after, "]")) return Object.freeze(values);
    if (!isPunctuation(cursor, after, ",")) throw cursor.unexpected(after, ", or ]");
    token = cursor.next();
    if (isPunctuation(cursor, token, "]")) throw trailingComma(after as ConsoleToken);
  }
}

function readObject(cursor: BodyCursor): TaggedObject {
  const object: Record<string, TaggedJson> = Object.create(null);
  let token = cursor.next();
  if (isPunctuation(cursor, token, "}")) return Object.freeze(object);
  for (;;) {
    if (token === undefined || (token.kind !== "key" && token.kind !== "string")) {
      throw cursor.unexpected(token, "a key in double quotes");
    }
    const key = readString(cursor, token);
    if (key === "__proto__") {
      throw new ConsoleRefusal("prototype-key", "The key __proto__ is not accepted.", token.line, token.start + 1, key);
    }
    if (Object.hasOwn(object, key)) {
      throw new ConsoleRefusal(
        "duplicate-key",
        `The key ${JSON.stringify(key)} is given twice in one object.`,
        token.line,
        token.start + 1,
        key,
      );
    }
    const colon = cursor.next();
    if (!isPunctuation(cursor, colon, ":")) throw cursor.unexpected(colon, ":");
    object[key] = readValue(cursor, cursor.next());
    const after = cursor.next();
    if (isPunctuation(cursor, after, "}")) return Object.freeze(object);
    if (!isPunctuation(cursor, after, ",")) throw cursor.unexpected(after, ", or }");
    token = cursor.next();
    if (isPunctuation(cursor, token, "}")) throw trailingComma(after as ConsoleToken);
  }
}

function trailingComma(comma: ConsoleToken): ConsoleRefusal {
  return new ConsoleRefusal(
    "trailing-comma",
    "Remove the comma before the closing bracket: JSON allows no trailing comma.",
    comma.line,
    comma.start + 1,
  );
}

/**
 * The body of a text the lexer read: one JSON object after the request line's target, or null when there is none.
 * Refuses a header line, a second request, a comment where the dialect takes none, and every JSON error by name.
 */
export function readConsoleBody(spec: ConsoleDialectSpec, text: ConsoleText): TaggedObject | null {
  const cursor = new BodyCursor(spec, text);
  const first = cursor.next();
  if (first === undefined) return null;
  if (!isPunctuation(cursor, first, "{")) throw cursor.stray(first, "before");
  const body = readObject(cursor);
  const rest = cursor.next();
  if (rest !== undefined) throw cursor.stray(rest, "after");
  return body;
}

function humanised(name: string): string {
  const words = name.replace(/_/g, " ").trim();
  return `${/^[aeiou]/i.test(words) ? "an" : "a"} ${words}`;
}

function decoded(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** The route a relative path names under a method, the one with the most literal segments where several match. */
function matchRoute<Op extends string>(
  routes: readonly RouteSpec<Op>[],
  method: string,
  relative: string,
): { readonly route: RouteSpec<Op>; readonly values: Readonly<Record<string, string>> } | undefined {
  const segments = relative.split("/");
  let best: { route: RouteSpec<Op>; values: Record<string, string>; literals: number } | undefined;
  for (const route of routes) {
    if (route.method !== method) continue;
    const template = route.template.split("/");
    if (template.length !== segments.length) continue;
    const values: Record<string, string> = {};
    let literals = 0;
    let matches = true;
    for (let index = 0; index < template.length && matches; index++) {
      const param = /^\{([A-Za-z0-9_]+)\}$/.exec(template[index]);
      if (param !== null) values[param[1]] = segments[index];
      else if (template[index] === segments[index]) literals++;
      else matches = false;
    }
    if (matches && (best === undefined || literals > best.literals)) best = { route, values, literals };
  }
  return best === undefined ? undefined : { route: best.route, values: best.values };
}

function queryValueText(spec: { readonly kind: string; readonly words?: readonly string[] }): string {
  const words = (spec.words ?? []).join(", ");
  if (spec.kind === "positive-int") return "a positive integer";
  if (spec.kind === "positive-int-or-words") return `a positive integer or one of ${words}`;
  return `a comma-separated list of ${words}`;
}

function queryValueAccepted(
  spec: { readonly kind: string; readonly words?: readonly string[] },
  value: string,
): boolean {
  const positive = POSITIVE_INT.test(value) && Number.isSafeInteger(Number(value));
  const words = spec.words ?? [];
  if (spec.kind === "positive-int") return positive;
  if (spec.kind === "positive-int-or-words") return positive || words.includes(value);
  return value !== "" && value.split(",").every((word) => words.includes(word));
}

/**
 * One console text read as one request against the route table, or a `ConsoleRefusal` naming the first rule it
 * breaks. Nothing here sends anything; a provider composes this with its own phase 0 rules (`guard.ts`).
 */
export function parseConsole<Op extends string>(
  spec: ConsoleDialectSpec,
  routes: readonly RouteSpec<Op>[],
  text: string,
): ConsoleRequest<Op> {
  const read = consoleTokens(spec, text);
  const { request } = read;
  const lineNumber = request.line + 1;
  const at = (code: ConsoleRefusalCode, sentence: string, column: number) =>
    new ConsoleRefusal(code, sentence, lineNumber, column + 1);

  if (!spec.methods.includes(request.method)) {
    throw at(
      "unknown-method",
      `${shown(request.method)} is not a method this console takes: it takes ${spec.methods.join(" and ")}.`,
      request.methodColumn,
    );
  }
  const target = request.target;
  const targetAt = request.targetColumn;
  if (target === "") throw at("unknown-route", `${request.method} needs a route after it.`, targetAt);
  if (target.includes("://") || target.startsWith("//")) {
    throw at(
      "absolute-url",
      "A request names a route only, never a scheme or a host: the connection supplies both.",
      targetAt,
    );
  }
  const hash = target.indexOf("#");
  if (hash !== -1) throw at("fragment", "A route takes no # fragment.", targetAt + hash);
  const question = target.indexOf("?");
  const path = question === -1 ? target : target.slice(0, question);
  const queryText = question === -1 ? undefined : target.slice(question + 1);

  let relative: string | undefined;
  if (path.startsWith(spec.pathPrefix)) relative = path.slice(spec.pathPrefix.length);
  else if (spec.shortForm && !path.startsWith("/")) relative = path;
  if (relative === undefined) {
    throw at("unknown-route", `${request.method} ${shown(path)} is not a route this console runs.`, targetAt);
  }
  const template = /\{([^}]*)\}?/.exec(relative);
  if (template !== null) {
    const name = template[1];
    throw at("path-template", `Replace {${name}} with ${humanised(name || "value")}.`, targetAt);
  }
  if (relative.includes("}")) {
    throw at("path-template", "The route holds a } with no { before it: write the value alone.", targetAt);
  }
  const matched = matchRoute(routes, request.method, relative);
  if (matched === undefined) {
    throw at("unknown-route", `${request.method} ${shown(path)} is not a route this console runs.`, targetAt);
  }
  const { route } = matched;

  const params: Record<string, string> = {};
  for (const [name, raw] of Object.entries(matched.values)) {
    const value = decoded(raw);
    if (value === undefined) {
      throw at("path-param", `The path segment ${shown(raw)} is not valid percent-encoding.`, targetAt);
    }
    if (value === "") throw at("path-param", `The path parameter ${name} is empty.`, targetAt);
    if (
      route.params[name] === "point-id" &&
      !UUID.test(value) &&
      !(/^(?:0|[1-9][0-9]*)$/.test(value) && BigInt(value) <= BigInt(UINT64_MAX))
    ) {
      throw at(
        "path-param",
        `The point id ${shown(value)} is neither an unsigned 64-bit integer nor a UUID.`,
        targetAt,
      );
    }
    params[name] = value;
  }

  const query: Record<string, string> = {};
  if (queryText !== undefined) {
    const queryAt = targetAt + question + 1;
    if (Object.keys(route.query).length === 0) {
      throw at("query-key", `${route.method} ${route.template} takes no query string.`, queryAt);
    }
    for (const pair of queryText.split("&")) {
      const equals = pair.indexOf("=");
      const key = decoded(equals === -1 ? pair : pair.slice(0, equals));
      const value = equals === -1 ? undefined : decoded(pair.slice(equals + 1));
      if (key === "") {
        throw at("query-key", "The query string holds an empty key: write key=value pairs joined by &.", queryAt);
      }
      if (key === undefined || !Object.hasOwn(route.query, key)) {
        throw at("query-key", `${route.method} ${route.template} takes no query key ${shown(key ?? pair)}.`, queryAt);
      }
      if (Object.hasOwn(query, key)) throw at("query-key", `The query key ${key} is given twice.`, queryAt);
      const keySpec = route.query[key];
      if (value === undefined || !queryValueAccepted(keySpec, value)) {
        throw at(
          "query-value",
          `The query key ${key} takes ${queryValueText(keySpec)}, not ${shown(value ?? "nothing")}.`,
          queryAt,
        );
      }
      query[key] = value;
    }
  }

  const body = readConsoleBody(spec, read);
  if (body !== null && route.body === "none") {
    throw at("body-not-allowed", `${route.method} ${route.template} takes no body.`, request.bodyColumn);
  }
  if (body === null && route.body === "required") {
    throw at("body-required", `${route.method} ${route.template} needs a JSON body.`, request.bodyColumn);
  }
  return {
    route,
    params: Object.freeze(params),
    query: Object.freeze(query),
    body: body ?? Object.freeze(Object.create(null) as TaggedObject),
  };
}
