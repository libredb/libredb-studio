/**
 * A YANG module's text as a statement tree, read lexically (RFC 7950 section 6), for the agent's withheld-node check.
 *
 * `yangkeys.ts` scans for list keys and nothing more. The agent's check needs every statement with its argument and
 * its substatements: which nodes carry an extension, what type a leaf has, what a typedef derives from, and which
 * prefix names which imported module. So this reads the grammar of section 6.1 to 6.3 whole: a keyword (an identifier,
 * or a prefixed one for an extension), an optional argument that is an unquoted string or one or more quoted strings
 * joined by `+`, and either `;` or a block of substatements. Comments are skipped, quoted text keeps its braces and
 * semicolons as text, and a double-quoted string's escapes are decoded.
 *
 * Nothing is compiled: no `uses` is expanded and no path is resolved. The text arrives from a device, so it is bounded
 * by the byte and depth caps `yangkeys.ts` measured, plus a statement count, and a text that breaks the grammar or a
 * bound is refused with a `YangTextError`, which the agent path reads as "the modules could not be read".
 */
import { YANG_LIMITS, type YangLimits } from "./yangkeys";

export interface YangStatement {
  /** The keyword as written, prefix included for an extension (`nacm:default-deny-all`). */
  readonly keyword: string;
  /** The argument, quoted strings joined and decoded, or undefined when the statement has none. */
  readonly argument?: string;
  readonly children: readonly YangStatement[];
}

/** Statements accepted in one module text. The largest fixture module holds about 3,000. */
export const MAX_YANG_STATEMENTS = 200_000;

/** A module text this reader refused; the message never quotes the text. */
export class YangTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YangTextError";
    Object.setPrototypeOf(this, YangTextError.prototype);
  }
}

type Token =
  | { readonly kind: "word"; readonly text: string }
  | { readonly kind: "string"; readonly text: string }
  | { readonly kind: "{" | "}" | ";" | "+" };

const isSpace = (ch: string): boolean => ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
const DOUBLE_ESCAPES: Readonly<Record<string, string>> = { n: "\n", t: "\t", '"': '"', "\\": "\\" };

/** The tokens of one module text, comments skipped. */
function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (isSpace(ch)) {
      i += 1;
    } else if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new YangTextError("a module text holds an unterminated comment");
      i = end + 2;
    } else if (ch === "{" || ch === "}" || ch === ";" || ch === "+") {
      tokens.push({ kind: ch });
      i += 1;
    } else if (ch === '"') {
      let out = "";
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\") {
          const decoded = DOUBLE_ESCAPES[text[i + 1] ?? ""];
          if (decoded === undefined) throw new YangTextError("a module text holds an escape YANG does not define");
          out += decoded;
          i += 2;
        } else {
          out += text[i];
          i += 1;
        }
      }
      if (i >= text.length) throw new YangTextError("a module text holds an unterminated string");
      tokens.push({ kind: "string", text: out });
      i += 1;
    } else if (ch === "'") {
      const end = text.indexOf("'", i + 1);
      if (end === -1) throw new YangTextError("a module text holds an unterminated string");
      tokens.push({ kind: "string", text: text.slice(i + 1, end) });
      i = end + 1;
    } else {
      const start = i;
      while (i < text.length) {
        const at = text[i] as string;
        if (isSpace(at) || at === "{" || at === "}" || at === ";" || at === '"' || at === "'") break;
        if (at === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) break;
        i += 1;
      }
      tokens.push({ kind: "word", text: text.slice(start, i) });
    }
  }
  return tokens;
}

/** The statements of one module text, its `module` or `submodule` statement first. */
export function parseYangText(text: string, limits: YangLimits = YANG_LIMITS): readonly YangStatement[] {
  if (text.length > limits.maxBytes) throw new YangTextError(`a module text is larger than ${limits.maxBytes} bytes`);
  const tokens = tokenize(text);
  let at = 0;
  let count = 0;

  const statement = (depth: number): YangStatement => {
    const keyword = tokens[at];
    if (keyword?.kind !== "word") throw new YangTextError("a module text holds a statement with no keyword");
    at += 1;
    count += 1;
    if (count > MAX_YANG_STATEMENTS)
      throw new YangTextError(`a module text holds more than ${MAX_YANG_STATEMENTS} statements`);
    let argument: string | undefined;
    const first = tokens[at];
    if (first?.kind === "word") {
      argument = first.text;
      at += 1;
    } else if (first?.kind === "string") {
      argument = first.text;
      at += 1;
      while (tokens[at]?.kind === "+") {
        const part = tokens[at + 1];
        if (part?.kind !== "string") throw new YangTextError("a module text joins a string to something else");
        argument += part.text;
        at += 2;
      }
    }
    const end = tokens[at];
    at += 1;
    if (end?.kind === ";")
      return argument === undefined
        ? { keyword: keyword.text, children: [] }
        : { keyword: keyword.text, argument, children: [] };
    if (end?.kind !== "{")
      throw new YangTextError("a module text holds a statement that neither ends nor opens a block");
    if (depth + 1 > limits.maxDepth) throw new YangTextError("a module text nests deeper than the depth cap");
    const children: YangStatement[] = [];
    while (tokens[at]?.kind !== "}") {
      if (at >= tokens.length) throw new YangTextError("a module text holds an unclosed block");
      children.push(statement(depth + 1));
    }
    at += 1;
    return argument === undefined ? { keyword: keyword.text, children } : { keyword: keyword.text, argument, children };
  };

  const statements: YangStatement[] = [];
  while (at < tokens.length) statements.push(statement(0));
  return statements;
}
